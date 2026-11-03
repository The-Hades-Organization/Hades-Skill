// Guardas da Vigília em TypeScript (porte de loop/cerberus/vigilia/checks/{comum,auditoria,coerencia}.py;
// reference/cerberus/vigilia.md). Cada guarda junta achados (nível, conferido, onde); o veredito é o pior nível. Falha ao
// conferir vira `aviso` com o que faltou, nunca `ok` calado.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, globSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DETAIL_MAX, EVID_MAX, TEXT_MAX, config, workRoot } from "./cerberus.ts";
import { fnmatchCase, type CheckEnv, type CheckVerdict, type Evid, type Resultado } from "./cerberus-check.ts";
import { splitLines } from "./pyjson.ts";

const NIVEIS: Resultado[] = ["ok", "aviso", "barra"];
const IO_PADRAO_S = 8;
const IO_MIN_S = 1;
const IO_MAX_S = 60;
const LEITURA_MAX = 1 << 20; // bytes lidos de report, brief, perguntas e plano: o resto não é conferido
const JOURNAL_CAUDA = 4 << 20; // bytes do fim de cada gate-journal.tsv
const ESTADOS_FINAIS = ["done", "archived"];

// \w e \b do Python são Unicode; o JS é só ASCII: estes limites reproduzem o do Python.
const W = String.raw`\p{L}\p{N}_`;
const BEFORE = `(?<![${W}])`;
const AFTER = `(?![${W}])`;
const rx = (source: string, flags = ""): RegExp => new RegExp(source, `u${flags}`);

type Dict = Record<string, unknown>;

/** Não deu para conferir (sem comando, tempo esgotado, saída ilegível): vira aviso com a evidência do que faltou. */
export class Indisponivel extends Error {
  readonly conferido: string;
  readonly onde: string;
  constructor(conferido: string, onde: string) {
    super(conferido);
    this.name = "Indisponivel";
    this.conferido = conferido;
    this.onde = onde;
  }
}

interface Achado { nivel: Resultado; conferido: string; onde: string }

export class Achados {
  readonly itens: Achado[] = [];
  add(nivel: Resultado, conferido: string, onde: string): void {
    this.itens.push({ nivel, conferido, onde });
  }
  falta(e: Indisponivel): void {
    this.add("aviso", `não conferido: ${e.conferido}`, e.onde);
  }
  resultado(): Resultado {
    return this.itens.reduce<Resultado>((pior, i) => (NIVEIS.indexOf(i.nivel) > NIVEIS.indexOf(pior) ? i.nivel : pior), "ok");
  }
}

export function curto(s: unknown, n: number = TEXT_MAX): string {
  const text = String(s).split(/\s+/).filter(Boolean).join(" ");
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}

/** O veredito: os itens piores primeiro, até o limite de evidência do corpo. */
export function emitir(achados: Achados, detalheOk: string, detalheFalha?: string): CheckVerdict {
  const res = achados.resultado();
  const itens = [...achados.itens].sort((a, b) => NIVEIS.indexOf(b.nivel) - NIVEIS.indexOf(a.nivel));
  let evidencia: Evid[] = itens.map((i) => ({ conferido: curto(i.nivel !== "ok" ? `[${i.nivel}] ${i.conferido}` : i.conferido), onde: curto(i.onde) }));
  if (evidencia.length > EVID_MAX) {
    const resto = evidencia.length - EVID_MAX + 1;
    evidencia = [...evidencia.slice(0, EVID_MAX - 1), { conferido: `mais ${resto} itens conferidos, omitidos`, onde: "limite de evidência do corpo" }];
  }
  if (!evidencia.length) evidencia = [{ conferido: "nada a conferir", onde: "contexto da guarda" }];
  const problemas = itens.filter((i) => i.nivel !== "ok").map((i) => i.conferido);
  const detalhe = res === "ok" ? detalheOk : (detalheFalha ?? problemas[0] ?? "");
  return { resultado: res, evidencia, detalhe: curto(detalhe, DETAIL_MAX) };
}

// ---------------------------------------------------------------- contexto e borda: comandos e arquivos

/** O que as guardas leem do ambiente: contexto injetado, mais a configuração do Cerberus lida uma vez. */
export class Vigilia {
  private cached: Record<string, string> | undefined;
  readonly ce: CheckEnv;
  constructor(ce: CheckEnv) {
    this.ce = ce;
  }

  get cfg(): Record<string, string> {
    if (this.cached === undefined) {
      try {
        this.cached = config(this.ce.env);
      } catch {
        this.cached = {};
      }
    }
    return this.cached;
  }

  get ioS(): number {
    const value = Number(this.cfg.HADES_CERBERUS_VIGILIA_IO_S ?? IO_PADRAO_S);
    return Number.isInteger(value) && value >= IO_MIN_S && value <= IO_MAX_S ? value : IO_PADRAO_S;
  }

  get reportsDir(): string {
    return this.cfg.HADES_ORCH_REPORTS_DIR || ".design-sync-reports";
  }

  get work(): string {
    return workRoot();
  }

  /** [exit, stdout]. Comando ausente ou tempo esgotado levanta Indisponivel. */
  rodar(argv: string[], cwd?: string, timeoutS?: number): [number, string] {
    const limite = timeoutS ?? this.ioS;
    const onde = argv.join(" ").slice(0, 200) + (cwd ? ` em ${cwd}` : "");
    const r = spawnSync(argv[0] as string, argv.slice(1), { cwd, env: this.ce.env, encoding: "utf8", timeout: limite * 1000, stdio: ["ignore", "pipe", "pipe"] });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") throw new Indisponivel(`${argv[0]} não encontrado no PATH`, onde);
    if (code === "ETIMEDOUT") throw new Indisponivel(`${argv[0]} passou de ${limite} s`, onde);
    if (r.error) throw new Indisponivel(`${argv[0]} não executou (${r.error.message})`, onde);
    return [r.status ?? -1, r.stdout ?? ""];
  }

  git(wt: string, ...args: string[]): [number, string] {
    return this.rodar(["git", "-C", wt, ...args]);
  }
}

const ERRNO_TEXT: Record<string, string> = { EISDIR: "Is a directory", EACCES: "Permission denied", ENOTDIR: "Not a directory" };

/** Texto do arquivo (até o limite), ou undefined se não existe. Erro de leitura levanta Indisponivel. */
export function ler(path: string, limite: number = LEITURA_MAX): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOENT") return undefined;
    throw new Indisponivel(`leitura falhou (${ERRNO_TEXT[code] ?? code})`, path);
  }
  try {
    const buffer = Buffer.alloc(limite);
    const n = readSync(fd, buffer, 0, limite, 0);
    return buffer.subarray(0, n).toString("utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    throw new Indisponivel(`leitura falhou (${ERRNO_TEXT[code] ?? code})`, path);
  } finally {
    closeSync(fd);
  }
}

function lerCauda(path: string, limite: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - limite);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const byParts = (a: string, b: string): number => {
  const pa = a.split(sep);
  const pb = b.split(sep);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return (pa[i] as string) < (pb[i] as string) ? -1 : 1;
  return pa.length - pb.length;
};
const expandUser = (p: string): string => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** *.json direto na pasta, em ordem; pasta ausente dá lista vazia. */
function jsonsIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json")).sort().map((n) => join(dir, n)).filter(isFile);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- agente no registro do orquestrador

/** <work>/<owner__repo>/orchestration de todos os repositórios: a guarda não depende do repo do diretório. */
function orchDirs(v: Vigilia): string[] {
  const root = v.work;
  if (!isDir(root)) return [];
  return globSync("*/orchestration", { cwd: root }).map((p) => join(root, p)).filter(isDir).sort(byParts);
}

function slugDoDir(v: Vigilia, d: string): string | undefined {
  let url: string;
  try {
    const [rc, out] = v.git(d, "config", "--get", "remote.origin.url");
    if (rc || !out.trim()) return undefined;
    url = out.trim();
  } catch (error) {
    if (error instanceof Indisponivel) return undefined;
    throw error;
  }
  const parts = url.replace(/\.git$/, "").split(/[/:]/);
  return parts.length >= 2 ? parts.slice(-2).join("__") : undefined;
}

export class Agente {
  readonly nome: string;
  readonly reg: Dict;
  readonly arquivo: string;
  constructor(nome: string, reg: Dict, arquivo: string) {
    this.nome = nome;
    this.reg = reg;
    this.arquivo = arquivo;
  }
  get orch(): string {
    return dirname(dirname(this.arquivo));
  }
  get worktree(): string {
    return String(this.reg.worktree || "");
  }
  get modo(): string {
    return String(this.reg.mode || "");
  }
  get ativo(): boolean {
    return !ESTADOS_FINAIS.includes(String(this.reg.state));
  }
}

const text = (value: unknown): string => (value === undefined || value === null || value === "" || value === false || value === 0 ? "" : String(value));

function carregar(file: string): Agente {
  let reg: unknown;
  try {
    reg = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Indisponivel(`registro ilegível (${(error as Error).message})`, file);
  }
  if (reg === null || typeof reg !== "object" || Array.isArray(reg)) throw new Indisponivel("registro não é um objeto JSON", file);
  const dict = reg as Dict;
  return new Agente(text(dict.name) || basename(file, ".json"), dict, file);
}

function agentePorNome(v: Vigilia, nome: string, d: string): Agente {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nome || "")) throw new Indisponivel(`agente fora do padrão no contexto: ${pyQuote(nome)}`, "CERBERUS_CTX.agente");
  let achados = orchDirs(v).map((o) => join(o, "agents", `${nome}.json`)).filter(isFile);
  if (achados.length > 1) {
    const slug = slugDoDir(v, d);
    const doRepo = achados.filter((f) => basename(dirname(dirname(dirname(f)))) === slug);
    achados = doRepo.length ? doRepo : achados;
  }
  if (!achados.length) throw new Indisponivel(`agente ${nome} sem registro em <work>/*/orchestration/agents`, v.work);
  if (achados.length > 1) throw new Indisponivel(`agente ${nome} registrado em mais de um repositório`, achados.join(", "));
  return carregar(achados[0] as string);
}

function pyQuote(value: string): string {
  return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function orchDoDir(v: Vigilia, d: string): string {
  const slug = slugDoDir(v, d);
  const o = slug ? join(v.work, slug, "orchestration") : undefined;
  if (!o || !isDir(o)) throw new Indisponivel(`sem registro do orquestrador para o repositório de ${d}`, o ?? d);
  return o;
}

/** Agentes que a guarda confere no momento: o do DONE, ou os membros da consolidação. Levanta Indisponivel. */
export function alvos(v: Vigilia): { lista: Agente[]; como: string } {
  const { ctx, momento } = v.ce;
  const d = v.ce.dir;
  if (momento === "done" || ctx.agente) {
    if (!ctx.agente) throw new Indisponivel("contexto sem agente", "CERBERUS_CTX");
    return { lista: [agentePorNome(v, ctx.agente, d)], como: `agente ${ctx.agente} (contexto do DONE)` };
  }
  const o = orchDoDir(v, d);
  const todos = jsonsIn(join(o, "agents")).map(carregar);
  const br = ctx.branch || "";
  const cons = join(o, "consolidations", `${br.replaceAll("/", "_")}.json`);
  let membros: Set<string> | undefined;
  if (br && isFile(cons)) {
    try {
      const doc = JSON.parse(readFileSync(cons, "utf8")) as { members?: unknown[] };
      membros = new Set((doc.members || []).map(String));
    } catch (error) {
      throw new Indisponivel(`registro da consolidação ilegível (${(error as Error).message})`, cons);
    }
  }
  if (membros?.size) {
    const sel = todos.filter((a) => membros.has(text(a.reg.pr)));
    return { lista: sel, como: `membros da consolidação ${br} (PRs ${[...membros].sort().join(", ")}): ${sel.length} agentes no registro` };
  }
  const sel = todos.filter((a) => a.reg.state !== "archived");
  return { lista: sel, como: `sem membros registrados para ${br || "a consolidação"}: todos os ${sel.length} agentes não arquivados de ${o}` };
}

export const reportPath = (v: Vigilia, a: Agente): string => join(a.worktree, v.reportsDir, "report.md");

export function reportDone(texto: string | undefined): boolean {
  return Boolean(texto) && (splitLines(texto as string)[0] ?? "").trim().startsWith("STATUS: DONE");
}

/** Blocos do markdown: parágrafo, ou item de lista de primeiro nível com continuação e subitens; cercas de código saem
 * (o que está em ``` é saída citada, não afirmação). Cada bloco: (linha inicial, linhas). */
export function blocos(texto: string): [number, string[]][] {
  const out: [number, string[]][] = [];
  let cur: string[] = [];
  let ini = 0;
  let cerca = false;
  splitLines(texto).forEach((ln, idx) => {
    const i = idx + 1;
    if (ln.trimStart().startsWith("```")) {
      cerca = !cerca;
      return;
    }
    if (cerca) return;
    const novo = !ln.trim() || ln.startsWith("#") || /^([-*+]|\d+[.)])\s/.test(ln) || ln.startsWith("|");
    if (novo && cur.length) {
      out.push([ini, cur]);
      cur = [];
    }
    if (ln.trim()) {
      if (!cur.length) ini = i;
      cur.push(ln);
      if (ln.startsWith("#") || ln.startsWith("|")) {
        out.push([ini, cur]);
        cur = [];
      }
    }
  });
  if (cur.length) out.push([ini, cur]);
  return out;
}

function alvosOuFalha(v: Vigilia, achados: Achados): Agente[] {
  try {
    const { lista, como } = alvos(v);
    achados.add("ok", como, "contexto do Cerberus");
    return lista;
  } catch (error) {
    if (error instanceof Indisponivel) {
      achados.falta(error);
      return [];
    }
    throw error;
  }
}

/** Roda `fn` e converte Indisponivel em achado `aviso`; devolve false quando faltou. */
function tentar(achados: Achados, fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    if (error instanceof Indisponivel) {
      achados.falta(error);
      return false;
    }
    throw error;
  }
}

function reportDe(v: Vigilia, a: Agente, achados: Achados): string | undefined {
  const p = reportPath(v, a);
  let t: string | undefined;
  if (!tentar(achados, () => { t = ler(p); })) return undefined;
  if (t === undefined) achados.add("barra", `${a.nome}: report.md ausente`, p);
  return t;
}

// ---------------------------------------------------------------- auditoria: status

type Guard = (v: Vigilia, achados: Achados) => void;

const gStatus: Guard = (v, achados) => {
  for (const a of alvosOuFalha(v, achados)) {
    const t = reportDe(v, a, achados);
    if (t === undefined) continue;
    const primeira = t.trim() ? (splitLines(t)[0] ?? "") : "(vazio)";
    if (reportDone(t)) achados.add("ok", `${a.nome}: primeira linha "${curto(primeira, 80)}"`, reportPath(v, a));
    else achados.add("barra", `${a.nome}: primeira linha "${curto(primeira, 80)}" não é STATUS: DONE`, reportPath(v, a));
  }
};

// ---------------------------------------------------------------- auditoria: gates

const FILA = rx(`gate-lock|pela fila|\\(fila${AFTER}|${BEFORE}queue${AFTER}|${BEFORE}kind\\s*\`?(?:lint|build|test|gate)`, "i");
const POSITIVO = rx(`${BEFORE}(?:ok|pass(?:a|ou|ed|es)?|verde|green|rc=0|exit 0|sa[ií]da 0)${AFTER}|✓|✅`, "i");
const NEGATIVO = rx(`${BEFORE}(?:falhou|failed|fail(?:s|ed)?|vermelho|red|rc=[1-9]\\d*)${AFTER}|(?<!0 )✗|❌`, "i");
const KIND = rx(`${BEFORE}run\\s+(test:integration|lint|build|test|gate)${AFTER}|${BEFORE}kind\\s*\`?(test:integration|lint|build|test|gate)${AFTER}`, "i");
const LABEL = /--label[\s=]+`?([A-Za-z0-9._:/-]+)/;

interface Alegacao { linha: number; kind?: string; label?: string; trecho: string }

function alegacoesDeGate(texto: string): Alegacao[] {
  const bs = blocos(texto);
  const out: Alegacao[] = [];
  bs.forEach(([ini, linhas], i) => {
    let txt = linhas.join(" ");
    if (!FILA.test(txt)) return;
    const proximo = bs[i + 1];
    if ((linhas[0] as string).startsWith("#") && proximo) txt += ` ${proximo[1].join(" ")}`; // título "## Gate (fila…)": o corpo vem no bloco seguinte
    if (!POSITIVO.test(txt) || NEGATIVO.test(txt)) return;
    const k = KIND.exec(txt);
    const lb = LABEL.exec(txt);
    out.push({ linha: ini, kind: k ? ((k[1] ?? k[2]) as string).toLowerCase() : undefined, label: lb?.[1], trecho: txt });
  });
  return out;
}

interface RegistroGate { ts: string; kind: string; label: string; rc: number; arquivo: string }

/** Linhas `done` do gate-journal de todo repositório cujo clone é a worktree. */
function journalDaWorktree(v: Vigilia, wt: string): RegistroGate[] {
  const root = v.work;
  const alvo = real(wt);
  const out: RegistroGate[] = [];
  const journals = isDir(root) ? globSync("*/locks/gate-journal.tsv", { cwd: root }).map((p) => join(root, p)).sort(byParts) : [];
  for (const j of journals) {
    let t: string;
    try {
      t = lerCauda(j, JOURNAL_CAUDA);
    } catch (error) {
      throw new Indisponivel(`gate-journal ilegível (${ERRNO_TEXT[(error as NodeJS.ErrnoException).code ?? ""] ?? (error as Error).message})`, j);
    }
    for (const ln of splitLines(t)) {
      const c = ln.split("\t");
      if (c.length < 7 || c[1] !== "done" || !(c[6] as string).startsWith("rc=")) continue;
      if (real(c[5] as string) !== alvo) continue;
      const rc = Number((c[6] as string).slice(3));
      if (!/^\s*[-+]?\d+\s*$/.test((c[6] as string).slice(3))) continue;
      out.push({ ts: c[0] as string, kind: c[2] as string, label: c[3] as string, rc, arquivo: j });
    }
  }
  return out;
}

const casaKind = (pedido: string | undefined, kind: string): boolean => pedido === undefined || kind === pedido || (pedido === "test" && kind.startsWith("test"));

const gGates: Guard = (v, achados) => {
  for (const a of alvosOuFalha(v, achados)) {
    const t = reportDe(v, a, achados);
    if (t === undefined) continue;
    const alegs = alegacoesDeGate(t);
    if (!alegs.length) {
      achados.add("ok", `${a.nome}: report não cita gate verde pela fila`, reportPath(v, a));
      continue;
    }
    let regs: RegistroGate[] = [];
    if (!tentar(achados, () => { regs = journalDaWorktree(v, a.worktree); })) continue;
    const desde = text(a.reg.createdAt);
    regs = regs.filter((r) => r.ts >= desde);
    for (const { linha, kind, label, trecho } of alegs) {
      const onde = `${reportPath(v, a)}:${linha}`;
      const cand = regs.filter((r) => casaKind(kind, r.kind) && (label === undefined || r.label === label));
      const filtro = [kind ? `kind ${kind}` : "", label ? `label ${label}` : ""].filter(Boolean).join(", ") || "qualquer kind";
      const ult = cand[cand.length - 1];
      if (!ult) {
        achados.add("barra", `${a.nome}: "${curto(trecho, 120)}" sem registro done (${filtro}) da worktree ${a.worktree} desde ${desde || "o início"} no gate-journal`, onde);
      } else if (ult.rc === 0) {
        achados.add("ok", `${a.nome}: gate (${filtro}) com rc=0 em ${ult.ts} (label ${ult.label})`, `${ult.arquivo} · ${onde}`);
      } else {
        achados.add("barra", `${a.nome}: citado verde, mas o último registro (${filtro}) saiu rc=${ult.rc} em ${ult.ts} (label ${ult.label})`, `${ult.arquivo} · ${onde}`);
      }
    }
  }
};

// ---------------------------------------------------------------- auditoria: capturas

const EXT_IMAGEM = "(?:png|jpe?g|webp|gif)";
const MOLDE = /[<>{}*…|]|\.\.\./; // nome com molde (`<pagina>-{antes,depois}.png`) não é arquivo concreto
const BUSCA_MAX = 20000; // arquivos visitados na busca de captura pelo nome
const CAPTURA = /captur|screenshot|print de tela|\bshots?\b/i;
const IMAGEM = rx(`(?<![${W}./~-])((?:~|\\.{0,2}/)?[${W}./~@+-]*[${W}@+-]\\.${EXT_IMAGEM})(?![${W}])`, "ig");
const IMAGEM_MOLDE = rx(`\`([^\`\\s]*\\.${EXT_IMAGEM})\``, "ig");

/** [(linha, nome)] dos arquivos de imagem citados em bloco que fala de captura; moldes vêm com nome undefined. */
function citacoesDeCaptura(texto: string): [number, string | undefined][] {
  const out: [number, string | undefined][] = [];
  for (const [ini, linhas] of blocos(texto)) {
    if (!CAPTURA.test(linhas.join(" "))) continue;
    linhas.forEach((ln, k) => {
      const vistos: [number, number][] = [];
      for (const m of ln.matchAll(IMAGEM_MOLDE)) {
        if (MOLDE.test(m[1] as string)) {
          const start = (m.index as number) + 1;
          vistos.push([start, start + (m[1] as string).length]);
          out.push([ini + k, undefined]);
        }
      }
      for (const m of ln.matchAll(IMAGEM)) {
        const start = (m.index as number) + ((m[0] as string).indexOf(m[1] as string));
        if (vistos.some(([s, e]) => s <= start && start < e)) continue;
        out.push([ini + k, m[1] as string]);
      }
    });
  }
  return out;
}

function procurarPorNome(nome: string, raizes: string[]): string | undefined {
  let vistos = 0;
  for (const raiz of raizes) {
    const pilha = [raiz];
    while (pilha.length) {
      const dir = pilha.shift() as string;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name);
      vistos += files.length;
      if (files.includes(nome)) return join(dir, nome);
      if (vistos > BUSCA_MAX) return undefined;
      for (const e of entries) if (e.isDirectory() && e.name !== ".git" && e.name !== "node_modules") pilha.push(join(dir, e.name));
    }
  }
  return undefined;
}

const SEM_PASTA = Symbol("sem-pasta");

function resolverCaptura(v: Vigilia, nome: string, a: Agente, dirsVistos: string[]): string | undefined | typeof SEM_PASTA {
  const p = expandUser(nome);
  const cands = isAbsolute(p) ? [p] : [join(a.worktree, p), join(a.worktree, v.reportsDir, p), ...dirsVistos.map((d) => join(d, p))];
  for (const c of cands) if (isFile(c)) return c;
  if (nome.replace(/^[./]+|[./]+$/g, "").includes("/")) return isAbsolute(p) || cands.some((c) => isDir(dirname(c))) ? undefined : SEM_PASTA;
  const dados = join(dirname(a.worktree), "_data", a.nome); // instalação descartável das unidades da skill (skill-dev-contract.md)
  return procurarPorNome(basename(p), [...dirsVistos, join(a.worktree, v.reportsDir), dados, a.worktree]);
}

const gCapturas: Guard = (v, achados) => {
  for (const a of alvosOuFalha(v, achados)) {
    const t = reportDe(v, a, achados);
    if (t === undefined) continue;
    const cits = citacoesDeCaptura(t);
    const moldes = cits.filter(([, n]) => n === undefined).length;
    const concretas = cits.filter((c): c is [number, string] => Boolean(c[1]));
    if (!concretas.length) {
      achados.add("ok", `${a.nome}: report não cita captura por nome${moldes ? ` (${moldes} citações em molde, não conferidas)` : ""}`, reportPath(v, a));
      continue;
    }
    const dirsVistos: string[] = [];
    // caminhos primeiro: o diretório ajuda os nomes soltos (sort estável, como o do Python)
    for (const [ln, nome] of [...concretas].sort((x, y) => Number(!x[1].includes("/")) - Number(!y[1].includes("/")))) {
      const onde = `${reportPath(v, a)}:${ln}`;
      const p = resolverCaptura(v, nome, a, dirsVistos);
      if (p === undefined) achados.add("barra", `${a.nome}: captura citada não existe: ${nome}`, onde);
      else if (p === SEM_PASTA) achados.add("aviso", `${a.nome}: captura ${nome} não resolvida (a pasta dela não existe em nenhum lugar conferido)`, onde);
      else if (statSync(p).size === 0) achados.add("barra", `${a.nome}: captura citada está vazia: ${p}`, onde);
      else {
        if (!dirsVistos.includes(dirname(p))) dirsVistos.push(dirname(p));
        achados.add("ok", `${a.nome}: captura ${nome} existe (${statSync(p).size} bytes)`, `${p} · ${onde}`);
      }
    }
    if (moldes) achados.add("ok", `${a.nome}: ${moldes} citações em molde (<…>, {…}) não conferidas`, reportPath(v, a));
  }
};

// ---------------------------------------------------------------- auditoria: commits

const SHA = "[0-9a-f]{7,40}";
const SHA_CRASE = new RegExp(`\`(${SHA})\``, "g");
const SHA_SOLTO = rx(`(?<![${W}/#-])(${SHA})(?![${W}-])`, "g");
const FALA_COMMIT = rx(`${BEFORE}commits?${AFTER}|${BEFORE}heads?${AFTER}|${BEFORE}base${AFTER}|${BEFORE}sha${AFTER}|${BEFORE}branch${AFTER}|${BEFORE}sobre${AFTER}`, "i");
const REF = rx(`(?<![${W}./~-])((?:skill|feat|fix|chore|docs|hades|origin)/[${W}./-]+)`, "g");
const CAMINHO = rx(`(?<![${W}.~/-])(~?/[${W}.@-]+/[${W}./@-]+)`, "g");

const pareceSha = (s: string): boolean => /\d/.test(s) && /[a-f]/.test(s);

interface CitacaoDeCommit {
  linha: number;
  sha: string;
  bloco: string;
  /** a própria linha do hash fala de commit (senão só o bloco fala, e a citação é só avisada) */
  naLinha: boolean;
}

/** Hex de 7–40 (entre crases ou solto) em bloco que fala de commit, branch ou base, fora de cercas. Só a linha que
 * também fala de commit é conferida; hash de outra linha do mesmo bloco volta com `naLinha` falso. */
function citacoesDeCommit(texto: string): CitacaoDeCommit[] {
  const out: CitacaoDeCommit[] = [];
  const vistos = new Set<string>();
  for (const [ini, linhas] of blocos(texto)) {
    const bloco = linhas.join(" ");
    if (!FALA_COMMIT.test(bloco)) continue;
    linhas.forEach((ln, k) => {
      const shas = [...ln.matchAll(SHA_CRASE)].map((m) => m[1] as string).concat([...ln.matchAll(SHA_SOLTO)].map((m) => m[1] as string));
      for (const sha of shas) {
        if (pareceSha(sha) && !vistos.has(sha)) {
          vistos.add(sha);
          out.push({ linha: ini + k, sha, bloco, naLinha: FALA_COMMIT.test(ln) });
        }
      }
    });
  }
  return out;
}

/** barra quando o bloco fala da branch da unidade (ou de nenhuma outra); aviso quando cita outra ref ou outro repositório. */
function nivelDoBloco(bloco: string, branch: string, worktree: string): { nivel: Resultado; por: string } {
  const refs = new Set([...bloco.matchAll(REF)].map((m) => m[1] as string));
  if (branch && bloco.includes(branch)) return { nivel: "barra", por: "" };
  const outras = [...refs].filter((r) => r !== branch);
  if (outras.length) return { nivel: "aviso", por: ` (o trecho cita ${outras.sort().join(", ")})` };
  const fora = [...bloco.matchAll(CAMINHO)].map((m) => m[1] as string).filter((c) => !real(expandUser(c)).startsWith(worktree));
  if (fora.length) return { nivel: "aviso", por: ` (o trecho cita ${fora[0]}, fora da worktree)` };
  return { nivel: "barra", por: "" };
}

/** Commits que o report afirma ter feito (hash em linha que fala de commit), para quem precisa conferir só isso. */
export function commitsCitados(report: string): string[] {
  return citacoesDeCommit(report).filter((c) => c.naLinha).map((c) => c.sha);
}

const PROVA_DE_EXECUCAO = rx(`${BEFORE}(?:test|teste|testes|gate|tsc|check|bun|build|lint|exit|rc)${AFTER}`, "i");

/**
 * O report traz prova de execução: uma linha com marca positiva (`passou`, `ok`, `rc=0`, `✓`…) e termo de teste ou gate,
 * sem marca negativa. Vale também dentro de cerca de código, onde a saída colada costuma estar.
 */
export function reportTemProva(report: string): boolean {
  return splitLines(report).some((ln) => {
    const semZeroFalhas = ln.replace(/(?<![\d.])0\s+(?:fail\w*|falh\w*)/gi, "");
    return POSITIVO.test(semZeroFalhas) && PROVA_DE_EXECUCAO.test(semZeroFalhas) && !NEGATIVO.test(semZeroFalhas);
  });
}

const gCommits: Guard = (v, achados) => {
  for (const a of alvosOuFalha(v, achados)) {
    const t = reportDe(v, a, achados);
    if (t === undefined) continue;
    const cits = citacoesDeCommit(t);
    if (!cits.length) {
      achados.add("ok", `${a.nome}: report não cita commit`, reportPath(v, a));
      continue;
    }
    const br = text(a.reg.branch);
    tentar(achados, () => {
      for (const { linha: ln, sha, bloco, naLinha } of cits) {
        const onde = `${reportPath(v, a)}:${ln} · git -C ${a.worktree}`;
        if (!naLinha) {
          achados.add("aviso", `${a.nome}: ${sha} em linha que não fala de commit (não conferido)`, onde);
          continue;
        }
        const [rc, tipoRaw] = v.git(a.worktree, "cat-file", "-t", sha);
        const tipo = tipoRaw.trim();
        if (rc !== 0) {
          const { nivel, por } = nivelDoBloco(bloco, br, real(a.worktree));
          achados.add(nivel, `${a.nome}: commit citado ${sha} não existe no repositório${por}`, onde);
          continue;
        }
        if (tipo !== "commit") {
          achados.add("ok", `${a.nome}: ${sha} é ${tipo}, não commit (ignorado)`, onde);
          continue;
        }
        if (v.git(a.worktree, "merge-base", "--is-ancestor", sha, "HEAD")[0] === 0) {
          achados.add("ok", `${a.nome}: commit ${sha} está na branch (ancestral de HEAD)`, onde);
          continue;
        }
        const { nivel, por } = nivelDoBloco(bloco, br, real(a.worktree));
        achados.add(nivel, `${a.nome}: commit ${sha} existe mas não está na branch ${br || "da unidade"}${por}`, onde);
      }
    });
  }
};

// ---------------------------------------------------------------- auditoria: escopo

const EXT = /\.[A-Za-z0-9]{1,6}$/;

/** O parágrafo cujo rótulo em negrito casa com `rotulo` (até a linha em branco). */
function paragrafo(texto: string, rotulo: RegExp): string | undefined {
  const linhas = splitLines(texto);
  for (let i = 0; i < linhas.length; i++) {
    const m = /^\s*(?:[-*]\s+)?\*\*([^*]+)\*\*/.exec(linhas[i] as string);
    if (m && rotulo.test(m[1] as string)) {
      let fim = linhas.findIndex((l, j) => j > i && !l.trim());
      if (fim < 0) fim = linhas.length;
      return linhas.slice(i, fim).join(" ");
    }
  }
  return undefined;
}

/** Caminhos citados entre crases: `<x>` vira curinga, `dir/` vira prefixo. Sem barra só entra nome com extensão (casado
 * pelo nome do arquivo), e só se `soCaminho` for falso. */
function padroes(par: string | undefined, soCaminho: boolean): string[] {
  const out: string[] = [];
  for (const m of (par ?? "").matchAll(/`([^`]+)`/g)) {
    const tok = (m[1] as string).trim();
    if (!tok || tok.includes(" ")) continue;
    if (!tok.includes("/") && (soCaminho || !EXT.test(tok))) continue;
    out.push(tok.replace(/<[^>]+>/g, "*"));
  }
  return out;
}

function casa(arquivo: string, pad: string): boolean {
  if (pad.endsWith("/")) return arquivo.startsWith(pad);
  if (!pad.includes("/")) return fnmatchCase(basename(arquivo), pad);
  return fnmatchCase(arquivo, pad);
}

const gEscopo: Guard = (v, achados) => {
  for (const a of alvosOuFalha(v, achados)) {
    const briefP = join(a.worktree, v.reportsDir, "brief.md");
    let brief: string | undefined;
    let report = "";
    if (!tentar(achados, () => { brief = ler(briefP); report = ler(reportPath(v, a)) ?? ""; })) continue;
    if (brief === undefined) {
      achados.add("aviso", `${a.nome}: brief.md ausente, escopo não conferido`, briefP);
      continue;
    }
    const seus = padroes(paragrafo(brief, /arquivos seus/i), true);
    const proibidos = padroes(paragrafo(brief, /não toque|nao toque/i), false);
    if (!seus.length && !proibidos.length) {
      achados.add("ok", `${a.nome}: brief sem "Arquivos seus" nem "não toque" entre crases: escopo não declarado`, briefP);
      continue;
    }
    const base = text(a.reg.base);
    let arquivos: string[] = [];
    let seguir = true;
    if (!tentar(achados, () => {
      const [rc, mb] = base ? v.git(a.worktree, "merge-base", base, "HEAD") : [1, ""];
      if (rc !== 0) {
        achados.add("aviso", `${a.nome}: base ${base || "(vazia no registro)"} não resolve na worktree; escopo não conferido`, `git -C ${a.worktree} merge-base ${base} HEAD`);
        seguir = false;
        return;
      }
      const [rcDiff, saida] = v.git(a.worktree, "diff", "--name-only", mb.trim(), "HEAD");
      if (rcDiff !== 0) {
        achados.add("aviso", `${a.nome}: git diff falhou (exit ${rcDiff})`, `git -C ${a.worktree} diff --name-only`);
        seguir = false;
        return;
      }
      arquivos = splitLines(saida).filter(Boolean);
    }) || !seguir) continue;
    const onde = `git -C ${a.worktree} diff --name-only ${base}...HEAD · ${briefP}`;
    let fora = 0;
    for (const f of arquivos) {
      if (seus.length && seus.some((p) => casa(f, p))) continue;
      const hit = proibidos.find((p) => casa(f, p));
      if (hit) {
        achados.add("barra", `${a.nome}: tocou ${f}, que o brief põe em "não toque" (${hit})`, onde);
      } else if (seus.length) {
        const citado = report.includes(f) || report.includes(basename(f));
        fora += 1;
        achados.add(citado ? "aviso" : "barra", `${a.nome}: ${f} fora de "Arquivos seus"${citado ? ", registrado no report" : ", sem registro no report"}`, onde);
      }
    }
    achados.add("ok", `${a.nome}: ${arquivos.length} arquivos tocados desde ${base}; ${arquivos.length - fora} dentro do escopo (${seus.length} padrões seus, ${proibidos.length} "não toque")`, onde);
  }
};

// ---------------------------------------------------------------- auditoria: perguntas

/** Títulos `## Qn` sem "(respondida)" nem "## Resposta do dono" depois (a mesma regra do open_questions do lib.sh). */
function perguntasAbertas(texto: string): string[] {
  const abertas: string[] = [];
  let atual: string | undefined;
  for (const ln of splitLines(texto)) {
    if (/^## Q\d+/.test(ln)) {
      atual = ln.slice(3).trim();
      if (!ln.includes("(respondida)")) abertas.push(atual);
    } else if (ln.startsWith("## Resposta do dono") && atual !== undefined && abertas.includes(atual)) {
      abertas.splice(abertas.indexOf(atual), 1);
    }
  }
  return abertas;
}

const gPerguntas: Guard = (v, achados) => {
  for (const a of alvosOuFalha(v, achados)) {
    const t = reportDe(v, a, achados);
    if (t === undefined) continue;
    const qp = join(a.worktree, v.reportsDir, "questions.md");
    let q: string | undefined;
    if (!tentar(achados, () => { q = ler(qp); })) continue;
    const abertas = perguntasAbertas(q ?? "");
    if (!reportDone(t)) achados.add("ok", `${a.nome}: report não está em DONE; ${abertas.length} perguntas abertas`, qp);
    else if (abertas.length) achados.add("barra", `${a.nome}: report em DONE com ${abertas.length} pergunta(s) sem resposta: ${abertas.slice(0, 5).map((x) => curto(x, 80)).join("; ")}`, qp);
    else achados.add("ok", `${a.nome}: report em DONE e nenhuma pergunta aberta${q !== undefined ? "" : " (sem questions.md)"}`, qp);
  }
};

// ---------------------------------------------------------------- coerência: registro × git, herdr e GitHub

const SEM_PR = ["skill", "review"];

function conferirBase(v: Vigilia, a: Agente, wt: string, base: string, achados: Achados): void {
  const fixa = new RegExp(`^${SHA}$`).test(base);
  if (v.git(wt, "rev-parse", "--verify", "-q", `${base}^{commit}`)[0] !== 0) {
    achados.add(fixa ? "barra" : "aviso", `${a.nome}: base ${base} do registro não existe no repositório da worktree`, `git -C ${wt} rev-parse --verify ${base}`);
    return;
  }
  if (fixa) {
    const onde = `git -C ${wt} merge-base --is-ancestor ${base} HEAD`;
    if (v.git(wt, "merge-base", "--is-ancestor", base, "HEAD")[0] === 0) achados.add("ok", `${a.nome}: base ${base} é ancestral de HEAD`, onde);
    else achados.add("barra", `${a.nome}: base ${base} do registro não é ancestral de HEAD (rebase ou base trocada)`, onde);
    return;
  }
  const [rc, mb] = v.git(wt, "merge-base", base, "HEAD");
  const onde = `git -C ${wt} merge-base ${base} HEAD`;
  if (rc === 0) achados.add("ok", `${a.nome}: base ${base} (ref móvel) tem ancestral comum ${mb.trim().slice(0, 12)} com HEAD`, onde);
  else achados.add("barra", `${a.nome}: a branch não tem ancestral comum com a base ${base}`, onde);
}

function conferirGit(v: Vigilia, a: Agente, achados: Achados): void {
  const wt = a.worktree;
  if (!wt || !isDir(wt)) {
    achados.add("barra", `${a.nome}: worktree do registro não existe: ${wt}`, a.arquivo);
    return;
  }
  tentar(achados, () => {
    const [rc, brRaw] = v.git(wt, "branch", "--show-current");
    const br = brRaw.trim();
    if (a.modo !== "review") {
      const want = text(a.reg.branch);
      if (rc !== 0 || br !== want) {
        achados.add("barra", `${a.nome}: registro diz branch ${want || "(vazia)"}, a worktree está em ${br || "HEAD destacado"}`, `git -C ${wt} branch --show-current · ${a.arquivo}`);
      } else {
        achados.add("ok", `${a.nome}: branch ${br} confere com o registro`, `git -C ${wt} branch --show-current`);
      }
    }
    const base = text(a.reg.base);
    if (base && a.modo !== "review") conferirBase(v, a, wt, base, achados);
  });
}

function sessoesHerdr(v: Vigilia): Dict[] {
  const [rc, out] = v.rodar(["herdr", "agent", "list"]);
  if (rc !== 0) throw new Indisponivel(`herdr agent list saiu ${rc}`, "herdr agent list");
  let agents: unknown;
  try {
    agents = ((JSON.parse(out) as Dict).result as Dict).agents;
  } catch {
    throw new Indisponivel("herdr agent list sem result.agents legível", "herdr agent list");
  }
  if (!Array.isArray(agents)) throw new Indisponivel("herdr agent list sem result.agents legível", "herdr agent list");
  return agents.filter((x): x is Dict => x !== null && typeof x === "object" && !Array.isArray(x));
}

function conferirHerdr(a: Agente, sessoes: Dict[], achados: Achados): void {
  if (!a.ativo) {
    achados.add("ok", `${a.nome}: registro em ${text(a.reg.state)}, sessão no herdr não exigida`, a.arquivo);
    return;
  }
  const pane = text(a.reg.pane);
  const wt = a.worktree;
  const porNome = sessoes.find((s) => s.name === a.nome);
  if (porNome) {
    if (pane && porNome.pane_id && porNome.pane_id !== pane) {
      achados.add("aviso", `${a.nome}: no herdr no painel ${text(porNome.pane_id)}, o registro diz ${pane}`, "herdr agent list");
    } else {
      achados.add("ok", `${a.nome}: sessão viva no herdr (${text(porNome.agent_status) || "?"}, ${text(porNome.pane_id) || "?"})`, "herdr agent list");
    }
    return;
  }
  const orfa = sessoes.find((s) => (pane && s.pane_id === pane) || s.cwd === wt || s.foreground_cwd === wt);
  const estado = text(a.reg.state) || "ativo";
  if (orfa) {
    achados.add("barra", `${a.nome}: registrado como ${estado}, mas a sessão do painel ${text(orfa.pane_id) || "?"} está no herdr sem o nome (nome perdido; herdr agent rename + adopt)`, "herdr agent list");
  } else {
    achados.add("aviso", `${a.nome}: registrado como ${estado} sem sessão no herdr (nem nome, nem painel ${pane || "—"}, nem cwd na worktree)`, "herdr agent list");
  }
}

function conferirPr(v: Vigilia, a: Agente, achados: Achados): void {
  if (SEM_PR.includes(a.modo)) {
    achados.add("ok", `${a.nome}: modo ${a.modo}, sem PR a conferir`, a.arquivo);
    return;
  }
  const br = text(a.reg.branch);
  if (!br) {
    achados.add("barra", `${a.nome}: registro sem branch`, a.arquivo);
    return;
  }
  const onde = `gh pr list --head ${br} --state all`;
  const [rc, out] = v.rodar(["gh", "pr", "list", "--head", br, "--state", "all", "--json", "number,state,headRefName", "--limit", "10"], isDir(a.worktree) ? a.worktree : undefined);
  if (rc !== 0) throw new Indisponivel(`gh pr list saiu ${rc}`, onde);
  let prs: Dict[];
  try {
    prs = (JSON.parse(out) as Dict[]).filter((p) => p.headRefName === br);
  } catch {
    throw new Indisponivel("gh pr list sem JSON legível", onde);
  }
  const regPr = text(a.reg.pr);
  if (!prs.length) {
    // sem PR o DONE já barra pela auditoria-done do corpo; aqui só a divergência entre registro e GitHub barra
    achados.add(regPr ? "barra" : "aviso", `${a.nome}: nenhuma PR para a branch ${br}${regPr ? ` (o registro diz #${regPr})` : ""}`, onde);
    return;
  }
  const pr = regPr ? prs.find((p) => String(p.number) === regPr) : prs[0];
  if (!pr) {
    achados.add("barra", `${a.nome}: registro aponta a PR #${regPr}, a branch ${br} tem ${prs.map((p) => `#${String(p.number)}`).join(", ")}`, onde);
    return;
  }
  const st = pr.state;
  if (st === "CLOSED") achados.add("barra", `${a.nome}: PR #${String(pr.number)} fechada sem merge`, onde);
  else if (st === "MERGED" && a.ativo) achados.add("aviso", `${a.nome}: PR #${String(pr.number)} já mergeada e o registro segue em ${text(a.reg.state) || "ativo"}`, onde);
  else achados.add("ok", `${a.nome}: PR #${String(pr.number)} ${String(st)} na branch ${br}`, onde);
}

const gRegistro: Guard = (v, achados) => {
  const lista = alvosOuFalha(v, achados);
  let sessoes: Dict[] | undefined;
  try {
    sessoes = lista.length ? sessoesHerdr(v) : [];
  } catch (error) {
    if (!(error instanceof Indisponivel)) throw error;
    achados.falta(error);
  }
  for (const a of lista) {
    conferirGit(v, a, achados);
    if (sessoes !== undefined) conferirHerdr(a, sessoes, achados);
    tentar(achados, () => conferirPr(v, a, achados));
  }
};

// ---------------------------------------------------------------- coerência: plano × registro

const PAINEL = rx(`${BEFORE}w[0-9A-Za-z]+:p\\d+${AFTER}`, "g");
const PORTA = rx(`${BEFORE}porta\\s+(\\d{2,5})${AFTER}`, "gi");
const PR_NUM = rx(`(?<![${W}&])#(\\d{1,7})${AFTER}`, "g");
const SHA_PLANO = rx(`(?<![${W}/#-])(${SHA})(?![${W}-])`, "g");

/** Linhas da seção "## Estado atual" (sem os comentários HTML do modelo). */
function estadoAtual(texto: string): string[] | undefined {
  const sec: string[] = [];
  let dentro = false;
  for (const ln of splitLines(texto)) {
    if (ln.startsWith("## ")) {
      dentro = /^## Estado atual\s*$/.test(ln);
      continue;
    }
    if (dentro) sec.push(ln);
  }
  return sec.length ? splitLines(sec.join("\n").replace(/<!--.*?-->/gs, "")) : undefined;
}

function planoAtivo(orch: string): { plano?: string; pj: string } {
  const pj = join(orch, "plan.json");
  if (!isFile(pj)) return { pj };
  try {
    const path = (JSON.parse(readFileSync(pj, "utf8")) as Dict).path;
    if (typeof path !== "string") throw new Error("'path'");
    return { plano: path, pj };
  } catch (error) {
    throw new Indisponivel(`plan.json ilegível (${(error as Error).message})`, pj);
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Itens do Estado atual que citam o agente: a linha e as continuações dela (mesmo item). */
function linhasDoAgente(sec: string[], nome: string): string[] {
  const pat = rx(`(?<![${W}-])${escapeRe(nome)}(?![${W}-])`);
  const itens: string[] = [];
  let cur: string[] = [];
  for (const ln of sec) {
    if (/^\s*[-*]\s/.test(ln) || !ln.trim()) {
      if (cur.length) itens.push(cur.join(" "));
      cur = ln.trim() ? [ln] : [];
    } else {
      cur.push(ln);
    }
  }
  if (cur.length) itens.push(cur.join(" "));
  return itens.filter((i) => pat.test(i));
}

/** O trecho do item que fala do agente: do nome até o próximo agente citado (um item pode listar várias unidades). */
function recorte(item: string, nome: string, outros: string[], raio = 200): string {
  const i = item.indexOf(nome);
  if (i < 0) return item;
  const fim = Math.min(i + raio, ...outros.map((o) => item.indexOf(o, i + nome.length)).filter((j) => j > i));
  return item.slice(i, fim);
}

const unicos = (re: RegExp, s: string): string[] => [...new Set([...s.matchAll(re)].map((m) => (m[1] ?? m[0]) as string))];

function conferirPlano(v: Vigilia, a: Agente, sec: string[], plano: string, outros: string[], achados: Achados): void {
  const itens = linhasDoAgente(sec, a.nome);
  const onde = `${plano} §Estado atual`;
  if (!itens.length) {
    achados.add(a.ativo ? "aviso" : "ok", `${a.nome}: registro em ${text(a.reg.state) || "ativo"} e o agente não aparece no Estado atual`, onde);
    return;
  }
  const trecho = itens.map((i) => recorte(i, a.nome, outros)).join(" ");
  let problemas = 0;
  const pane = text(a.reg.pane);
  const paineis = unicos(PAINEL, trecho);
  if (pane && paineis.length && !paineis.includes(pane)) {
    problemas += 1;
    achados.add("aviso", `${a.nome}: o plano cita o painel ${paineis.sort().join(", ")}, o registro diz ${pane}`, onde);
  }
  const porta = text(a.reg.port);
  const portas = unicos(PORTA, trecho);
  if (porta && portas.length && !portas.includes(porta)) {
    problemas += 1;
    achados.add("aviso", `${a.nome}: o plano cita a porta ${portas.sort().join(", ")}, o registro diz ${porta}`, onde);
  }
  const regPr = text(a.reg.pr);
  const prs = unicos(PR_NUM, trecho);
  if (regPr && prs.length && !prs.includes(regPr)) {
    problemas += 1;
    achados.add("aviso", `${a.nome}: o plano cita a PR #${prs.sort().join(", #")}, o registro diz #${regPr}`, onde);
  }
  if (isDir(a.worktree)) {
    for (const sha of unicos(SHA_PLANO, trecho).filter(pareceSha)) {
      try {
        if (v.git(a.worktree, "cat-file", "-e", `${sha}^{commit}`)[0] !== 0) {
          problemas += 1;
          achados.add("aviso", `${a.nome}: o plano cita o commit ${sha}, que não existe no repositório da worktree`, onde);
        }
      } catch (error) {
        if (!(error instanceof Indisponivel)) throw error;
        achados.falta(error);
        break;
      }
    }
  }
  if (!problemas) achados.add("ok", `${a.nome}: citado no Estado atual; painel, porta, PR e commits citados conferem: "${curto(trecho, 140)}"`, onde);
}

const gPlano: Guard = (v, achados) => {
  const porOrch = new Map<string, Agente[]>();
  for (const a of alvosOuFalha(v, achados)) porOrch.set(a.orch, [...(porOrch.get(a.orch) ?? []), a]);
  for (const [orch, ags] of porOrch) {
    let plano: string | undefined;
    let pj = "";
    let texto: string | undefined;
    if (!tentar(achados, () => {
      ({ plano, pj } = planoAtivo(orch));
      if (plano !== undefined) texto = ler(plano);
    })) continue;
    if (plano === undefined) {
      achados.add("ok", "sem plano aprovado registrado: nada a confrontar", pj);
      continue;
    }
    if (texto === undefined) {
      achados.add("aviso", `plan.json aponta ${plano}, que não existe`, pj);
      continue;
    }
    const sec = estadoAtual(texto);
    if (!sec) {
      achados.add("aviso", 'plano sem a seção "## Estado atual"', plano);
      continue;
    }
    const nomes = jsonsIn(join(orch, "agents")).map((f) => basename(f, ".json"));
    for (const a of ags) {
      if (a.modo === "skill") {
        // unidade de evolução da skill: o plano do projeto não a lista
        achados.add("ok", `${a.nome}: modo skill, fora do Estado atual do plano do projeto`, plano);
        continue;
      }
      conferirPlano(v, a, sec, plano, nomes.filter((n) => n !== a.nome), achados);
    }
  }
};

// ---------------------------------------------------------------- tabela de guardas

interface Entrada { guard: Guard; ok: string }

export const AUDITORIA: Record<string, Entrada> = {
  status: { guard: gStatus, ok: "report em STATUS: DONE" },
  gates: { guard: gGates, ok: "gates citados têm registro rc=0" },
  capturas: { guard: gCapturas, ok: "capturas citadas existem" },
  commits: { guard: gCommits, ok: "commits citados estão na branch" },
  escopo: { guard: gEscopo, ok: "arquivos tocados cabem no escopo do brief" },
  perguntas: { guard: gPerguntas, ok: "nenhuma pergunta aberta com o report em DONE" },
};

export const COERENCIA: Record<string, Entrada> = {
  registro: { guard: gRegistro, ok: "registro confere com git, herdr e GitHub" },
  plano: { guard: gPlano, ok: "Estado atual do plano confere com o registro" },
};

export function rodarVigilia(tabela: Record<string, Entrada>, nome: string, ce: CheckEnv): CheckVerdict | undefined {
  const entrada = tabela[nome];
  if (!entrada) return undefined;
  const achados = new Achados();
  entrada.guard(new Vigilia(ce), achados);
  return emitir(achados, entrada.ok);
}
