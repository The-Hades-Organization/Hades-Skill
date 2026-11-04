// Limites de uso do plano (janela de 5 h e semanal): amostras do % medido, calibração tokens → % e conversão.
// Só regra, sem disco nem relógio próprio (a borda está em limites-io.ts). Fonte e formato: reference/limites.md.
import type { Req, Tok } from "./usage.ts";

export type Janela = "five" | "seven";
export const JANELAS: readonly Janela[] = ["five", "seven"];
export const ROTULO: Record<Janela, string> = { five: "5 h", seven: "semana" };

/** % usado (0–100) de uma janela e quando ela renova (epoch s). */
export interface Leitura {
  pct: number;
  resetsAt: number;
}

export interface Amostra {
  /** Instante da leitura, UTC (ISO 8601 com Z). */
  at: string;
  five?: Leitura;
  seven?: Leitura;
  version?: string;
}

export interface Opcoes {
  /** Menor variação de % que vale como intervalo (a leitura pode ser inteira). */
  minDeltaPct: number;
  /** Intervalos mínimos para calibrar (por modelo e no total). */
  minIntervals: number;
  /** Peso de um token de leitura de cache frente a um token novo (0–1). */
  cacheReadWeight: number;
}

const SEGUNDOS_DE_FOLGA_DA_RENOVACAO = 120;
const PASSADAS_DO_AJUSTE = 400;
const TOKENS_POR_MILHAO = 1e6;

const isDict = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function leitura(value: unknown): Leitura | undefined {
  if (!isDict(value)) return undefined;
  const { used_percentage: pct, resets_at: resetsAt } = value;
  if (typeof pct !== "number" || typeof resetsAt !== "number" || !Number.isFinite(pct) || !Number.isFinite(resetsAt) || pct < 0) return undefined;
  return { pct, resetsAt };
}

/** Amostra do JSON que o Claude Code entrega ao status line; sem `rate_limits` (plano sem limites, sessão nova) não há amostra. */
export function amostraDoStatusLine(text: string, now: Date): Amostra | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isDict(doc) || !isDict(doc.rate_limits)) return undefined;
  const five = leitura(doc.rate_limits.five_hour);
  const seven = leitura(doc.rate_limits.seven_day);
  if (!five && !seven) return undefined;
  const version = typeof doc.version === "string" ? doc.version : undefined;
  return { at: now.toISOString(), ...(five ? { five } : {}), ...(seven ? { seven } : {}), ...(version ? { version } : {}) };
}

/** Linhas do samples.jsonl: a linha que não é uma amostra válida é ignorada, o resto segue. */
export function amostrasDe(text: string): Amostra[] {
  const found: Amostra[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") continue;
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isDict(doc) || typeof doc.at !== "string" || Number.isNaN(Date.parse(doc.at))) continue;
    const five = leitura(isDict(doc.five) ? { used_percentage: doc.five.pct, resets_at: doc.five.resetsAt } : undefined);
    const seven = leitura(isDict(doc.seven) ? { used_percentage: doc.seven.pct, resets_at: doc.seven.resetsAt } : undefined);
    if (!five && !seven) continue;
    found.push({ at: doc.at, ...(five ? { five } : {}), ...(seven ? { seven } : {}), ...(typeof doc.version === "string" ? { version: doc.version } : {}) });
  }
  return found.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const mesmaLeitura = (a: Leitura | undefined, b: Leitura | undefined): boolean => a?.pct === b?.pct && a?.resetsAt === b?.resetsAt;

/** Grava só o que mudou: a mesma leitura das duas janelas, ou uma leitura antes de `gapS` da anterior, não vira linha. */
export function vale(nova: Amostra, ultima: Amostra | undefined, gapS: number): boolean {
  if (!ultima) return true;
  if (mesmaLeitura(nova.five, ultima.five) && mesmaLeitura(nova.seven, ultima.seven)) return false;
  return (Date.parse(nova.at) - Date.parse(ultima.at)) / 1000 >= gapS;
}

export function dentroDaRetencao(amostras: readonly Amostra[], now: Date, dias: number): Amostra[] {
  const corte = now.getTime() - dias * 86_400_000;
  return amostras.filter((a) => Date.parse(a.at) >= corte);
}

export interface Atual extends Leitura {
  /** Quando foi medido (ISO, UTC). */
  at: string;
}

/** A última leitura de cada janela ainda aberta (a renovação vem depois de `now`); janela vencida não conta como medida. */
export function atuais(amostras: readonly Amostra[], now: Date): Partial<Record<Janela, Atual>> {
  const agora = now.getTime() / 1000;
  const out: Partial<Record<Janela, Atual>> = {};
  for (const amostra of amostras) {
    for (const janela of JANELAS) {
      const l = amostra[janela];
      if (l && l.resetsAt > agora) out[janela] = { ...l, at: amostra.at };
    }
  }
  return out;
}

// ---------------------------------------------------------------- tokens → unidade de consumo

/** Milhões de tokens ponderados: leitura de cache pesa `cacheReadWeight` de um token novo. */
export const mtok = (tok: Tok, cacheReadWeight: number): number => (tok[0] + tok[1] + tok[2] + tok[3] * cacheReadWeight) / TOKENS_POR_MILHAO;

// ---------------------------------------------------------------- intervalos e calibração

interface Intervalo {
  dPct: number;
  usd: number;
  /** Milhões de tokens ponderados por modelo. */
  mtok: Record<string, number>;
}

/** Intervalos de uma janela: da âncora até a primeira amostra em que o % subiu `minDeltaPct`; janela que renovou reinicia a âncora. */
export function intervalos(amostras: readonly Amostra[], janela: Janela, reqs: readonly Req[], opcoes: Opcoes): Intervalo[] {
  const lidas = amostras.flatMap((a) => (a[janela] ? [{ t: Date.parse(a.at) / 1000, l: a[janela] as Leitura }] : []));
  const ordenadas = [...reqs].sort((a, b) => a[0] - b[0]);
  const out: Intervalo[] = [];
  let ancora = lidas[0];
  for (const atual of lidas.slice(1)) {
    if (!ancora) break;
    const renovou = Math.abs(atual.l.resetsAt - ancora.l.resetsAt) > SEGUNDOS_DE_FOLGA_DA_RENOVACAO;
    const delta = atual.l.pct - ancora.l.pct;
    if (renovou || delta < 0) {
      ancora = atual;
      continue;
    }
    if (delta < opcoes.minDeltaPct) continue;
    const doIntervalo = ordenadas.filter((r) => r[0] > (ancora as { t: number }).t && r[0] <= atual.t);
    const porModelo: Record<string, number> = {};
    let usd = 0;
    for (const r of doIntervalo) {
      porModelo[r[1]] = (porModelo[r[1]] ?? 0) + mtok([r[2], r[3], r[4], r[5]], opcoes.cacheReadWeight);
      usd += r[6];
    }
    if (usd > 0) out.push({ dPct: delta, usd, mtok: porModelo });
    ancora = atual;
  }
  return out;
}

/** Mínimos quadrados com taxa ≥ 0 por modelo (descida por coordenada: poucos modelos, poucos intervalos, resultado determinístico). */
function ajusta(itens: readonly Intervalo[], modelos: readonly string[]): Record<string, number> {
  const taxa: Record<string, number> = Object.fromEntries(modelos.map((m) => [m, 0]));
  for (let passada = 0; passada < PASSADAS_DO_AJUSTE; passada += 1) {
    for (const m of modelos) {
      let num = 0;
      let den = 0;
      for (const item of itens) {
        const x = item.mtok[m] ?? 0;
        if (x === 0) continue;
        const resto = modelos.reduce((acc, k) => (k === m ? acc : acc + (taxa[k] as number) * (item.mtok[k] ?? 0)), 0);
        num += x * (item.dPct - resto);
        den += x * x;
      }
      if (den > 0) taxa[m] = Math.max(0, num / den);
    }
  }
  return taxa;
}

export interface Taxas {
  /** % da janela por milhão de tokens ponderados, por modelo calibrado. */
  porModelo: Record<string, number>;
  /** % da janela por US$ equivalente de API (para o plano, que só tem US$). */
  porUsd: number | null;
  intervalos: number;
}

export type Calibracao = Record<Janela, Taxas>;

export function calibra(amostras: readonly Amostra[], reqs: readonly Req[], opcoes: Opcoes): Calibracao {
  const fazer = (janela: Janela): Taxas => {
    const itens = intervalos(amostras, janela, reqs, opcoes);
    if (itens.length < opcoes.minIntervals) return { porModelo: {}, porUsd: null, intervalos: itens.length };
    const candidatos = [...new Set(itens.flatMap((i) => Object.keys(i.mtok)))].filter(
      (m) => itens.filter((i) => (i.mtok[m] ?? 0) > 0).length >= opcoes.minIntervals,
    );
    const taxa = ajusta(itens, candidatos);
    const porModelo = Object.fromEntries(Object.entries(taxa).filter(([, v]) => v > 0));
    const usd = itens.reduce((acc, i) => acc + i.usd, 0);
    const porUsd = usd > 0 ? itens.reduce((acc, i) => acc + i.dPct, 0) / usd : null;
    return { porModelo, porUsd, intervalos: itens.length };
  };
  return { five: fazer("five"), seven: fazer("seven") };
}

export interface Estimativa {
  /** null = sem calibração para nenhum modelo dos tokens. */
  pct: number | null;
  /** Havia tokens de modelo sem taxa: o valor é só o que a calibração cobre. */
  parcial: boolean;
}

/** % da janela dos tokens por modelo, pelas taxas calibradas. */
export function pctDeTokens(taxas: Taxas, tokPorModelo: Readonly<Record<string, Tok>> | undefined, cacheReadWeight: number): Estimativa {
  let pct = 0;
  let coberto = false;
  let parcial = false;
  for (const [modelo, tok] of Object.entries(tokPorModelo ?? {})) {
    const taxa = taxas.porModelo[modelo];
    if (taxa === undefined) {
      parcial = true;
      continue;
    }
    coberto = true;
    pct += taxa * mtok(tok, cacheReadWeight);
  }
  return { pct: coberto ? pct : null, parcial };
}

export interface Faixa {
  p25: number;
  median: number;
  p75: number;
}

/** US$ → % da janela pela taxa média de US$ (o plano não sabe o modelo de cada token); sem taxa, sem faixa. */
export function pctDeUsd(taxas: Taxas, usd: Faixa | null): Faixa | null {
  if (!usd || taxas.porUsd === null) return null;
  return { p25: usd.p25 * taxas.porUsd, median: usd.median * taxas.porUsd, p75: usd.p75 * taxas.porUsd };
}

export interface Cabe {
  /** % que resta da janela atual; null = janela sem medida atual. */
  resta: number | null;
  /** null = não dá para dizer (sem medida ou sem calibração). */
  cabe: boolean | null;
}

/** O plano cabe quando o p75 dele não passa do que resta (100 − % usado) da janela atual. */
export function cabeNaJanela(atual: Atual | undefined, p75: number | null): Cabe {
  if (!atual) return { resta: null, cabe: null };
  const resta = Math.max(0, 100 - atual.pct);
  return { resta, cabe: p75 === null ? null : p75 <= resta };
}

export const somaFaixas = (faixas: readonly Faixa[]): Faixa | null =>
  faixas.length === 0
    ? null
    : faixas.reduce((acc, f) => ({ p25: acc.p25 + f.p25, median: acc.median + f.median, p75: acc.p75 + f.p75 }), { p25: 0, median: 0, p75: 0 });

export interface LimiteDoPlano {
  /** Faixa em % da janela por unidade (null = unidade sem custo estimado, ou janela sem calibração). */
  porUnidade: Record<string, Faixa | null>;
  /** Soma das unidades com faixa; null sem nenhuma. */
  plano: Faixa | null;
  /** Todas as unidades entraram na soma. */
  completo: boolean;
  atual: Atual | null;
  resta: number | null;
  cabe: boolean | null;
}

/** Faixa p25–p75 do plano em % de cada janela e se cabe no que resta da janela atual. */
export function limitesDoPlano(
  unidades: readonly { unit: string; costUsd: Faixa | null }[],
  calibracao: Calibracao,
  atual: Partial<Record<Janela, Atual>>,
): Record<Janela, LimiteDoPlano> {
  const fazer = (janela: Janela): LimiteDoPlano => {
    const porUnidade = Object.fromEntries(unidades.map((u) => [u.unit, pctDeUsd(calibracao[janela], u.costUsd)]));
    const faixas = Object.values(porUnidade).filter((f): f is Faixa => f !== null);
    const plano = somaFaixas(faixas);
    const completo = faixas.length === unidades.length;
    const { resta, cabe } = cabeNaJanela(atual[janela], plano?.p75 ?? null);
    // com unidade sem custo estimado a soma é piso: só dá para dizer que não cabe
    return { porUnidade, plano, completo, atual: atual[janela] ?? null, resta, cabe: cabe === true && !completo ? null : cabe };
  };
  return { five: fazer("five"), seven: fazer("seven") };
}

// ---------------------------------------------------------------- texto

/** `~12.3%` (estimado), `~12.3%+` (parcial: falta modelo sem taxa), `sem calib.` */
export function textoPct(e: Estimativa): string {
  return e.pct === null ? "sem calib." : `~${e.pct.toFixed(1)}%${e.parcial ? "+" : ""}`;
}
