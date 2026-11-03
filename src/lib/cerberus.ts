// Cerberus (reference/cerberus.md): o corpo comum das três cabeças. Registro de guardas, avaliação conjunta nos momentos
// de fronteira, veredito com evidência, modo por cabeça, exceção do dono e histórico fora do repositório. A lógica é a do
// hades cerberus original (removido na 5.0.0; as saídas ficam em loop/test/golden/legado/); arquivos de estado e chaves de configuração
// são os mesmos.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import { isAbsolute, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { withFlock } from "./flock.ts";
import { isDir, listDir, readText, realpathMissingOk } from "./fs.ts";
import { emitJournal } from "./journal.ts";
import { hadesHome, skillRoot } from "./paths.ts";
import { pyDumps, pyRepr, splitLines } from "./pyjson.ts";

export const CABECAS = ["porta", "limiar", "vigilia"] as const;
export type Cabeca = (typeof CABECAS)[number];
export const NOMES: Record<Cabeca, string> = { porta: "Porta", limiar: "Limiar", vigilia: "Vigília" };
export const MOMENTOS = [
  "done", "push", "release", "plugin", "consolidacao", "continuo", "publicacao", "comentario", "artefato", "tunel",
] as const;
export const RESULTADOS = ["ok", "aviso", "barra"] as const;
export const EFEITOS = ["ok", "aviso", "barra", "liberado"] as const;
export const MODOS = ["off", "avisa", "barra"] as const;
export const TIPOS = ["exec", "emitida", "regra"] as const;
export type Modo = (typeof MODOS)[number];
export type Efeito = (typeof EFEITOS)[number];

const GUARD_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const CTX_KEY = /^[a-z][a-z0-9_]{0,31}$/;
export const CTX_VAL_MAX = 300;
export const CTX_MAX = 32;
export const EVID_MAX = 20;
export const TEXT_MAX = 500;
export const DETAIL_MAX = 1000;
const OUT_MAX = 65536; // caracteres da saída de uma guarda lidos pelo corpo; o resto não é veredito
const OUT_BUFFER = 64 * 1024 * 1024; // teto do que o subprocesso pode escrever antes de ser cortado
export const TIMEOUT_MAX = 600;
export const PAGE_MAX = 500; // vereditos que o estado do painel devolve (os mais novos)
const EXC_LIST_MAX = 100;
const EXC_VALIDITY_MIN_CHARS = 10;

export type Dict = Record<string, unknown>;
export type Env = Record<string, string | undefined>;
export type Cfg = Record<string, string>;

export interface Evidencia {
  conferido: string;
  onde: string;
}

/** Veredito de uma guarda (o que a guarda imprime ou o corpo monta) e, depois do efeito, o registro do histórico. */
export interface Veredito extends Dict {
  cabeca: string;
  guarda: string;
  momento: string;
  resultado: string;
}

export interface Excecao extends Dict {
  id: string;
  cabeca: string;
  guarda: string;
  momento: string;
  alvo: Record<string, string>;
  usada: string | null;
}

export interface Guarda extends Dict {
  cabeca: Cabeca;
  id: string;
  tipo: string;
  momentos: string[];
  titulo: string;
  dono: string;
}

/** Entrada inválida (uso, registro, veredito emitido): a CLI sai 2 com a mensagem. */
export class Recusa extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Recusa";
  }
}

const isObject = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const blank = (value: string): boolean => value.trim() === "";
const charLength = (value: string): number => [...value].length;

// ---------------------------------------------------------------- configuração e lugares

/** Chaves do catálogo: variável exportada > config.env da instalação > padrão do config.tsv (a do config.sh).
 *  env ausente lê só os arquivos (o painel, cujo ambiente é o da subida e pode estar velho). */
export function config(env?: Env | null): Cfg {
  const instFile = join(hadesHome(), "instance");
  const first = (readText(instFile) ?? "").split("\n", 1)[0]?.trim() ?? "";
  const data = first === "" ? undefined : first;
  // o catálogo da skill vem primeiro: um $D instalado de versão anterior ainda não tem as chaves do Cerberus
  const cfg: Cfg = {};
  for (const tsv of [join(skillRoot, "kit", "config.tsv"), data ? join(data, "config.tsv") : undefined]) {
    const text = tsv === undefined ? undefined : readText(tsv);
    if (text === undefined) continue;
    for (const line of splitLines(text)) {
      if (line === "" || line.startsWith("#")) continue;
      const [key = "", value = ""] = line.split("\t");
      if (!(key in cfg)) cfg[key] = value;
    }
  }
  const envFile = data ? readText(join(data, "config.env")) : undefined;
  if (envFile !== undefined) {
    for (const line of splitLines(envFile)) {
      const eq = line.indexOf("=");
      const key = eq < 0 ? line : line.slice(0, eq);
      if (eq >= 0 && key in cfg) cfg[key] = line.slice(eq + 1);
    }
  }
  if (env) {
    for (const key of Object.keys(cfg)) {
      const value = env[key];
      if (value !== undefined) cfg[key] = value;
    }
  }
  return cfg;
}

export function cfgInt(cfg: Cfg, key: string, lo: number, hi: number): number {
  const raw = cfg[key];
  if (raw === undefined || !/^\s*[+-]?\d+\s*$/.test(raw)) throw new Recusa(`${key} ausente ou inválida no catálogo de configurações`);
  const value = Number.parseInt(raw, 10);
  if (value < lo || value > hi) throw new Recusa(`${key}=${value} fora de ${lo}–${hi}`);
  return value;
}

export function modes(cfg: Cfg): Record<Cabeca, Modo> {
  const out = {} as Record<Cabeca, Modo>;
  for (const cab of CABECAS) {
    const raw = cfg[`HADES_CERBERUS_${cab.toUpperCase()}`] ?? "";
    const mode = MODOS.find((m) => m === raw);
    if (!mode) throw new Recusa(`HADES_CERBERUS_${cab.toUpperCase()}=${pyRepr(raw)}: modo inválido (off, avisa ou barra)`);
    out[cab] = mode;
  }
  return out;
}

export function workRoot(): string {
  const fromEnv = process.env.HADES_WORK_ROOT;
  if (fromEnv) return fromEnv;
  const fromFile = (readText(join(hadesHome(), "work-root")) ?? "").split("\n", 1)[0]?.trim() ?? "";
  return fromFile || join(hadesHome(), "work");
}

export function store(): string {
  const dir = join(workRoot(), "_maquina", "cerberus");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function nowIso(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
}

const nowSeconds = (): number => Date.now() / 1000;

// ---------------------------------------------------------------- registro

const REGISTRY = join(skillRoot, "loop", "cerberus");
/** `cmd[0]` de uma guarda exec que roda a CLI da skill (`hades <subcomando>`) em vez de um arquivo da cabeça. */
const CLI_CMD = "hades";

function guardErrors(cab: Cabeca, id: string, g: unknown): string[] {
  const errs: string[] = [];
  if (!GUARD_ID.test(id)) errs.push("id inválido (nome do arquivo)");
  if (!isObject(g)) return [...errs, "não é um objeto JSON"];
  if (!isText(g.titulo) || blank(g.titulo)) errs.push("titulo ausente");
  if (!isText(g.origem) || blank(g.origem)) errs.push("origem ausente");
  const ms = g.momentos;
  if (!Array.isArray(ms) || ms.length === 0 || ms.some((m) => !(MOMENTOS as readonly unknown[]).includes(m))) {
    errs.push(`momentos: lista não vazia de ${MOMENTOS.join(", ")}`);
  }
  const tipo = g.tipo;
  if (!(TIPOS as readonly unknown[]).includes(tipo)) errs.push(`tipo: ${TIPOS.join(", ")}`);
  if (tipo === "exec") {
    const cmd = g.cmd;
    if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((a) => isText(a) && a !== "")) {
      errs.push("cmd: lista de texto não vazia");
    } else {
      const first = cmd[0] as string;
      const base = realpathMissingOk(join(REGISTRY, cab));
      const target = realpathMissingOk(join(base, first));
      if (first === CLI_CMD) {
        if (cmd.length < 2) errs.push(`cmd: ${CLI_CMD} leva o subcomando (ex.: ${CLI_CMD} cerberus-check porta/<guarda>)`);
      } else if (isAbsolute(first) || !target.startsWith(`${base}/`)) errs.push("cmd[0] tem de ser relativo à pasta da cabeça, sem sair dela");
      else if (!isRegularFile(target)) errs.push(`cmd[0] não existe: ${first}`);
    }
  }
  if ("timeoutS" in g && !(typeof g.timeoutS === "number" && Number.isInteger(g.timeoutS) && g.timeoutS >= 1 && g.timeoutS <= TIMEOUT_MAX)) {
    errs.push(`timeoutS: inteiro de 1 a ${TIMEOUT_MAX}`);
  }
  if (tipo === "regra" && !(CABECAS as readonly unknown[]).includes(g.dono ?? cab)) errs.push("dono: porta, limiar ou vigilia");
  return errs;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** (guardas, erros). Guarda = objeto do arquivo + cabeca e id. Arquivo inválido entra em erros, nunca some calado. */
export function registry(): { guardas: Guarda[]; erros: string[] } {
  const guardas: Guarda[] = [];
  const erros: string[] = [];
  for (const cab of CABECAS) {
    const dir = join(REGISTRY, cab);
    for (const name of isDir(dir) ? listDir(dir) : []) {
      if (!name.endsWith(".json")) continue;
      const stem = name.slice(0, -".json".length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch (error) {
        erros.push(`${cab}/${name}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const errs = guardErrors(cab, stem, parsed);
      if (errs.length > 0) {
        erros.push(`${cab}/${name}: ${errs.join("; ")}`);
        continue;
      }
      const g = parsed as Dict;
      guardas.push({ ...g, cabeca: cab, id: stem, dono: g.tipo === "regra" ? ((g.dono as string | undefined) ?? cab) : cab } as Guarda);
    }
  }
  return { guardas, erros };
}

export function findGuard(guardas: Guarda[], cab: string, id: string): Guarda | undefined {
  return guardas.find((g) => g.cabeca === cab && g.id === id);
}

// ---------------------------------------------------------------- veredito (puro)

export function parseCtx(pairs: string[]): Record<string, string> {
  const ctx: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    if (eq < 0 || !CTX_KEY.test(key) || charLength(value) > CTX_VAL_MAX) {
      throw new Recusa(`--ctx ${pyRepr(pair)}: chave [a-z][a-z0-9_]{0,31}=valor de até ${CTX_VAL_MAX} caracteres`);
    }
    ctx[key] = value;
  }
  if (Object.keys(ctx).length > CTX_MAX) throw new Recusa(`no máximo ${CTX_MAX} chaves de contexto`);
  return ctx;
}

/** Motivo da recusa do veredito, ou undefined. Veredito sem evidência não vale. */
export function verdictError(v: unknown, cab: string, id: string, momento: string): string | undefined {
  if (!isObject(v)) return "o veredito não é um objeto JSON";
  for (const [key, want] of [["cabeca", cab], ["guarda", id], ["momento", momento]] as const) {
    if (key in v && v[key] !== want) return `${key}=${pyRepr(v[key])} não bate com ${pyRepr(want)}`;
  }
  if (!(RESULTADOS as readonly unknown[]).includes(v.resultado)) return "resultado tem de ser ok, aviso ou barra";
  const ev = v.evidencia;
  if (!Array.isArray(ev) || ev.length === 0) return "veredito sem evidência";
  if (ev.length > EVID_MAX) return `evidência com mais de ${EVID_MAX} itens`;
  for (const item of ev) {
    const bad = !isObject(item) || (["conferido", "onde"] as const).some((k) => {
      const text = item[k];
      return !isText(text) || blank(text) || charLength(text) > TEXT_MAX;
    });
    if (bad) return `cada evidência precisa de conferido e onde (texto não vazio, até ${TEXT_MAX} caracteres)`;
  }
  if ("detalhe" in v && (!isText(v.detalhe) || charLength(v.detalhe) > DETAIL_MAX)) {
    return `detalhe: texto de até ${DETAIL_MAX} caracteres`;
  }
  return undefined;
}

const clip = (text: string, max: number): string => [...text].slice(0, max).join("");

/** O barra que substitui um veredito inválido: a evidência é a do corpo. */
function refused(cab: string, id: string, momento: string, why: string, where: string): Veredito {
  return {
    cabeca: cab, guarda: id, momento, resultado: "barra", invalido: true,
    evidencia: [{ conferido: clip(`veredito recusado: ${why}`, TEXT_MAX), onde: clip(where, TEXT_MAX) }],
    detalhe: clip(`veredito da guarda recusado (${why})`, DETAIL_MAX),
  };
}

function exceptionMatches(exc: Excecao, v: Veredito, ctx: Record<string, string>, now: number): boolean {
  const expira = typeof exc.expira === "number" ? exc.expira : 0;
  const alvo = isObject(exc.alvo) ? exc.alvo : {};
  return !exc.usada && expira > now && exc.cabeca === v.cabeca && exc.guarda === v.guarda && exc.momento === v.momento
    && Object.entries(alvo).every(([key, value]) => (ctx[key] ?? null) === (value ?? null));
}

/** (efeito, exceção usada) de um veredito sob o modo da cabeça e as exceções abertas. */
export function effect(v: Veredito, mode: Modo, excs: Excecao[], ctx: Record<string, string>, now: number): { efeito: Efeito; excecao?: Excecao } {
  if (v.resultado !== "barra") return { efeito: v.resultado as Efeito };
  if (mode === "avisa") return { efeito: "aviso" };
  const excecao = excs.find((e) => exceptionMatches(e, v, ctx, now));
  return excecao ? { efeito: "liberado", excecao } : { efeito: "barra" };
}

export function overall(records: { efeito: string }[]): "ok" | "aviso" | "barra" {
  const efs = records.map((r) => r.efeito);
  if (efs.includes("barra")) return "barra";
  return efs.some((e) => e === "aviso" || e === "liberado") ? "aviso" : "ok";
}

// ---------------------------------------------------------------- borda: guardas, histórico, exceções

const ERRNO_TEXT: Record<string, string> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  ENOEXEC: "Exec format error",
  ENOTDIR: "Not a directory",
  E2BIG: "Argument list too long",
};

function exitCodeOf(status: number | null, signal: NodeJS.Signals | null): number {
  if (status !== null) return status;
  const signo = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
  return signo === undefined ? -1 : -signo;
}

/** Última linha da saída da guarda como JSON; undefined se não há linha ou ela não é JSON (ou é null). */
function lastJsonLine(out: string): unknown {
  const last = splitLines(out).at(-1);
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Roda a guarda exec e devolve o veredito dela (ou o barra de recusa, se não vale). */
function runGuard(g: Guarda, momento: string, ctx: Record<string, string>, cwd: string, defaultTimeoutS: number): Veredito {
  const { cabeca: cab, id } = g;
  const cmd = g.cmd as string[];
  const viaCli = cmd[0] === CLI_CMD;
  const argv = viaCli ? [process.execPath, join(skillRoot, "src", "cli.ts"), ...cmd.slice(1)] : [realpathMissingOk(join(REGISTRY, cab, cmd[0] as string)), ...cmd.slice(1)];
  const where = viaCli ? cmd.join(" ") : `loop/cerberus/${cab}/${cmd[0]}`;
  const timeoutS = typeof g.timeoutS === "number" ? g.timeoutS : defaultTimeoutS;
  const payload = JSON.stringify(ctx);
  const env: Env = {
    ...process.env,
    CERBERUS_CABECA: cab, CERBERUS_GUARDA: id, CERBERUS_MOMENTO: momento, CERBERUS_DIR: cwd,
    CERBERUS_SKILL: skillRoot, CERBERUS_CTX: payload,
  };
  for (const [key, value] of Object.entries(ctx)) env[`CERBERUS_CTX_${key.toUpperCase()}`] = value;
  const r = spawnSync(argv[0] as string, argv.slice(1), {
    input: payload, cwd, env, encoding: "utf8", timeout: timeoutS * 1000, killSignal: "SIGKILL", maxBuffer: OUT_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return refused(cab, id, momento, `passou de ${timeoutS} s`, where);
  if (r.error) return refused(cab, id, momento, `não executou: ${ERRNO_TEXT[code ?? ""] ?? r.error.message}`, where);
  const out = (r.stdout ?? "").slice(0, OUT_MAX).trim();
  const returncode = exitCodeOf(r.status, r.signal);
  const v = out === "" ? undefined : lastJsonLine(out);
  const why = v !== undefined
    ? verdictError(v, cab, id, momento)
    : returncode !== 0 ? `saiu ${returncode} sem veredito` : "saída sem veredito JSON";
  if (why !== undefined) return refused(cab, id, momento, why, where);
  const verdict = v as Dict;
  const picked: Dict = {};
  for (const key of ["resultado", "evidencia", "detalhe"]) if (key in verdict) picked[key] = verdict[key];
  return { ...picked, cabeca: cab, guarda: id, momento } as Veredito;
}

/** Histórico e exceções gravados por um processo de cada vez (o mesmo flock do módulo Python). */
function locked<T>(fn: () => T): T {
  return withFlock(join(store(), ".lock"), fn);
}

/** Diário do agente (reference/journal.md): só o que barra ou avisa; o ok é a maioria e não diz nada ao Argos. */
function journalVerdicts(records: Dict[], cfg: Cfg): void {
  for (const r of records) {
    if (r.efeito !== "barra" && r.efeito !== "aviso") continue;
    const proof = Array.isArray(r.evidencia) && isObject(r.evidencia[0]) ? String(r.evidencia[0].conferido ?? "") : "";
    emitJournal("cerberus", `cerberus.${String(r.efeito)}`, `${String(r.cabeca)}/${String(r.guarda)} ${String(r.momento)}${proof ? `: ${proof}` : ""}`, {
      cwd: typeof r.dir === "string" ? r.dir : undefined, get: (key) => cfg[key],
    });
  }
}

function appendHistory(records: Dict[], cfg: Cfg): void {
  if (records.length === 0) return;
  journalVerdicts(records, cfg);
  const limit = cfgInt(cfg, "HADES_CERBERUS_HIST_KB", 16, 1048576) * 1024;
  const file = join(store(), "vereditos.jsonl");
  locked(() => {
    if (isRegularFile(file) && statSync(file).size >= limit) renameSync(file, join(store(), "vereditos.1.jsonl"));
    appendFileSync(file, records.map((r) => `${pyDumps(r)}\n`).join(""));
  });
}

export function readHistory(): Dict[] {
  const out: Dict[] = [];
  for (const name of ["vereditos.1.jsonl", "vereditos.jsonl"]) {
    const text = readText(join(store(), name));
    if (text === undefined) continue;
    for (const line of splitLines(text)) {
      try {
        const row: unknown = JSON.parse(line);
        if (isObject(row)) out.push(row);
      } catch {
        continue; // linha cortada por disco cheio: o resto do histórico segue legível
      }
    }
  }
  return out;
}

const exceptionsPath = (): string => join(store(), "excecoes.json");

export function loadExceptions(): Excecao[] {
  const text = readText(exceptionsPath());
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Recusa(`${exceptionsPath()} ilegível: conserte ou apague (as exceções abertas se perdem)`);
  }
  return Array.isArray(parsed) ? (parsed as Excecao[]) : [];
}

function saveExceptions(list: Excecao[]): void {
  const tmp = join(store(), "excecoes.tmp");
  writeFileSync(tmp, pyDumps(list, 1));
  renameSync(tmp, exceptionsPath());
}

export interface OpenException {
  alvo?: Record<string, string>;
  por?: string;
  origem: string;
  ttlS: number;
  now?: number;
}

/** Grava uma exceção de uso único. O ponto de entrada que chama isto é só do dono (reference/cerberus.md §Exceção). */
export function openException(cab: string, id: string, momento: string, motivo: string, opts: OpenException): Excecao {
  const now = opts.now ?? nowSeconds();
  if (!findGuard(registry().guardas, cab, id)) throw new Recusa(`guarda ${cab}/${id} não registrada`);
  if (!(MOMENTOS as readonly string[]).includes(momento)) throw new Recusa(`momento inválido: ${momento}`);
  if (!isText(motivo) || charLength(motivo.trim()) < EXC_VALIDITY_MIN_CHARS || charLength(motivo) > TEXT_MAX) {
    throw new Recusa(`motivo obrigatório (${EXC_VALIDITY_MIN_CHARS} a ${TEXT_MAX} caracteres)`);
  }
  const alvo = parseCtx(Object.entries(opts.alvo ?? {}).map(([k, v]) => `${k}=${v}`));
  const exc: Excecao = {
    id: randomBytes(6).toString("hex"), cabeca: cab, guarda: id, momento, alvo, motivo: motivo.trim(),
    por: opts.por ?? "dono", origem: opts.origem, aberta: nowIso(now), abertaTs: now, expira: now + opts.ttlS, usada: null,
  };
  locked(() => {
    const list = loadExceptions();
    list.push(exc);
    saveExceptions(list);
  });
  return exc;
}

// ---------------------------------------------------------------- operações

export interface Avaliacao {
  avaliacao: string;
  momento: string;
  resultado: "ok" | "aviso" | "barra";
  vereditos: Dict[];
  barras: number;
  avisos: number;
  ignoradas: string[];
}

export function evaluate(momento: string, ctx: Record<string, string>, cwd: string, opts: { only?: string; cfg?: Cfg; now?: number } = {}): Avaliacao {
  const cfg = opts.cfg ?? config(process.env);
  const now = opts.now ?? nowSeconds();
  if (!(MOMENTOS as readonly string[]).includes(momento)) throw new Recusa(`momento inválido: ${momento} (${MOMENTOS.join(", ")})`);
  if (opts.only && !(CABECAS as readonly string[]).includes(opts.only)) throw new Recusa(`cabeça inválida: ${opts.only}`);
  const { guardas, erros } = registry();
  if (erros.length > 0) throw new Recusa(`registro do Cerberus inválido: ${erros.join(" | ")}`);
  const mode = modes(cfg);
  const timeoutS = cfgInt(cfg, "HADES_CERBERUS_TIMEOUT_S", 1, TIMEOUT_MAX);
  const heads = CABECAS.filter((c) => !opts.only || c === opts.only);
  const todo = guardas.filter((g) => g.tipo === "exec" && g.momentos.includes(momento) && heads.includes(g.cabeca) && mode[g.cabeca] !== "off");
  const aid = randomBytes(6).toString("hex");
  const verdicts = todo.map((g) => runGuard(g, momento, ctx, cwd, timeoutS));
  const records: Dict[] = [];
  locked(() => {
    const excs = loadExceptions();
    for (const v of verdicts) {
      const cab = v.cabeca as Cabeca;
      const { efeito, excecao } = effect(v, mode[cab], excs, ctx, now);
      const rec: Dict = { ts: nowIso(now), avaliacao: aid, ...v, modo: mode[cab], efeito, origem: "avaliar", ctx, dir: cwd };
      if (excecao) {
        excecao.usada = aid;
        excecao.usadaEm = nowIso(now);
        rec.excecao = Object.fromEntries((["id", "motivo", "por", "aberta"] as const).map((k) => [k, excecao[k]]));
      }
      records.push(rec);
    }
    if (records.some((r) => "excecao" in r)) saveExceptions(excs);
  });
  appendHistory(records, cfg);
  const efeitos = records.map((r) => r.efeito);
  return {
    avaliacao: aid, momento, resultado: overall(records as { efeito: string }[]), vereditos: records,
    barras: efeitos.filter((e) => e === "barra").length,
    avisos: efeitos.filter((e) => e === "aviso" || e === "liberado").length,
    ignoradas: heads.filter((c) => mode[c] === "off"),
  };
}

export interface RecordInput {
  detalhe?: string;
  efeito?: string;
  ctx?: Record<string, string>;
  cwd?: string;
  cfg?: Cfg;
  now?: number;
}

/** Veredito de guarda `emitida`: o script decidiu; o corpo valida e grava. Recusa se não vale. */
export function record(cab: string, id: string, momento: string, resultado: string, evidencia: unknown, opts: RecordInput = {}): Dict {
  const cfg = opts.cfg ?? config(process.env);
  const now = opts.now ?? nowSeconds();
  const g = findGuard(registry().guardas, cab, id);
  if (!g || g.tipo !== "emitida") throw new Recusa(`${cab}/${id} não está registrada como guarda emitida`);
  if (!g.momentos.includes(momento)) throw new Recusa(`${cab}/${id} não é registrada no momento ${momento}`);
  const v: Dict = { resultado, evidencia };
  if (opts.detalhe) v.detalhe = opts.detalhe;
  const why = verdictError(v, cab, id, momento);
  if (why !== undefined) throw new Recusa(`veredito recusado: ${why}`);
  const efeito = opts.efeito || resultado;
  if (!(RESULTADOS as readonly string[]).includes(efeito)) throw new Recusa("efeito tem de ser ok, aviso ou barra");
  const rec: Dict = {
    ts: nowIso(now), avaliacao: randomBytes(6).toString("hex"), cabeca: cab, guarda: id, momento, ...v,
    modo: modes(cfg)[cab as Cabeca], efeito, origem: "emitida", ctx: opts.ctx ?? {}, dir: opts.cwd || process.cwd(),
  };
  appendHistory([rec], cfg);
  return rec;
}

export function history(cab?: string, efeito?: string, limit?: number): Dict[] {
  const rows = readHistory().filter((r) => (!cab || r.cabeca === cab) && (!efeito || r.efeito === efeito));
  return limit ? rows.slice(-limit) : rows;
}

/** O que a página Cerberus mostra (reference/panel.md §Cerberus). */
export function state(cfg: Cfg = config()): Dict {
  const { guardas, erros } = registry();
  const mode = modes(cfg);
  const hist = readHistory();
  const barred = new Map<string, { cabeca: unknown; guarda: unknown; vezes: number; ultimo: Dict }>();
  for (const r of hist) {
    if (r.efeito !== "barra") continue;
    const key = `${r.cabeca}/${r.guarda}`;
    const entry = barred.get(key) ?? { cabeca: r.cabeca, guarda: r.guarda, vezes: 0, ultimo: r };
    entry.vezes += 1;
    entry.ultimo = r;
    barred.set(key, entry);
  }
  const fields = ["id", "cabeca", "guarda", "momento", "alvo", "motivo", "por", "origem", "aberta", "expira", "usada", "usadaEm"];
  return {
    cabecas: CABECAS.map((c) => ({ id: c, nome: NOMES[c], modo: mode[c], guardas: guardas.filter((g) => g.cabeca === c).length })),
    guardas, erros, momentos: [...MOMENTOS], historico: hist.slice(-PAGE_MAX), total: hist.length,
    barrados: [...barred.values()].sort((a, b) => b.vezes - a.vezes),
    excecoes: loadExceptions().slice(-EXC_LIST_MAX).map((e) => Object.fromEntries(fields.map((k) => [k, e[k] ?? null]))),
    store: store(),
  };
}
