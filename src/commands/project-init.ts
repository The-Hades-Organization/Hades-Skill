// `hades project-init`: apoio do `/hades project init` (reference/project-init.md). Lê um repositório sem perfil, monta o
// RASCUNHO do perfil (`hades.profile/1`) com a evidência de cada campo (arquivo:linha) e o que ficou incerto, e só grava com
// o ok do dono (a pergunta é do agente; aqui o `--confirmed`). Nunca escreve no repo lido.
//
// As expressões regulares seguem o `re` do Python do original: `\b` e `\w` são Unicode (por isso `UB` e `WORD`), e os
// padrões do catálogo (QMAP) são os mesmos, sem caixa.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { unifiedDiff } from "../lib/difflib.ts";
import { isDir, isFile, readText, realpathMissingOk } from "../lib/fs.ts";
import { HadesError, out } from "../lib/output.ts";
import { hadesHome, home, selfCli, skillRoot } from "../lib/paths.ts";
import { packsRoot, resolveSlug, slugOf, type Resolution } from "../lib/project.ts";
import { comparePaths, pyGlob } from "../lib/pyglob.ts";
import { pyDumps, splitLines } from "../lib/pyjson.ts";
import { detectStacks, installedStacks, isObject, loadProfile, readJsonObject, type Json, type JsonObject } from "../lib/profile.ts";
import { run } from "../lib/proc.ts";
import { effective } from "../lib/quality.ts";
import { validateFile } from "../lib/validate.ts";

const USAGE = `Apoio do \`/hades project init\` (reference/project-init.md): lê um repositório sem perfil, monta o RASCUNHO do perfil
(\`hades.profile/1\`) com a evidência de cada campo (arquivo:linha) e o que ficou incerto, e só grava com o ok do dono
(a pergunta é do agente, AskUserQuestion; aqui o \`--confirmed\`).

  hades project-init draft <repo> [--name N] [--slug dono/repo] [--gh-user U] [--stage DIR] [--dry-run]
                                         escreve DIR/<n>/profile.json (rascunho) e imprime JSON: profile, evidence,
                                         uncertain, stacks, quality, diff (se já há perfil), valid, errors
  hades project-init save <rascunho-dir> <repo> --confirmed [--force]
                                         valida, grava em <packs>/<n>/profile.json (git local do pacote) e confere que o
                                         resolvedor devolve 0 no repo; perfil que já existe e difere exige --force

Rascunhos ficam em --stage (padrão ~/.claude/hades/packs-draft, no layout de um pacote: serve de HADES_PACKS_ROOT para
o \`hades quality conflicts\`); --dry-run usa uma pasta descartável e não deixa nada. O destino é a raiz dos pacotes
do resolvedor. Nada aqui escreve no repo lido.
`;

const EXIT_USAGE = 2;
const EXIT_NO_REMOTE = 3;
const SPEC_ID_WIDTH = 4;
const MIN_SEVERITY_DIGITS = 2;
const MIN_SEVERITY_NUMBERS = 3;
const MIN_ALIAS_LENGTH = 3;
const MAX_NEAR_BRANCH_LINES = 15;
const GIT_TIMEOUT_MS = 10_000;
const COMMIT_WARNING_CHARS = 120;
const CONVENTIONAL = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "target", ".nx", ".angular", "vendor", ".venv", "__pycache__", "tmp"]);
const LEVELS = ["baixa", "media", "alta", "bloqueante"];
const NOT_SPEC_PREFIXES = ["RFC", "ADR", "UTF", "ISO", "SHA"];
const NOT_CARD_PREFIXES = ["UTF", "ISO", "RFC", "SHA", "ADR"];

class InitError extends HadesError {}

function fail(message: string, code = EXIT_USAGE): never {
  throw new InitError(`project-init: ${message}`, code);
}

// ------------------------------------------------------------------ expressões regulares no estilo do `re` do Python

const WORD = String.raw`[\p{L}\p{N}_]`;
const UB = String.raw`(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
const ci = (source: string): RegExp => new RegExp(source.replaceAll("\\b", UB), "iu");
const cs = (source: string): RegExp => new RegExp(source.replaceAll("\\b", UB), "u");

/** re.escape do Python 3.7+. */
const reEscape = (text: string): string => text.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, (c) => `\\${c}`);

const stripChars = (text: string, chars: string): string => {
  let [start, end] = [0, text.length];
  while (start < end && chars.includes(text[start] as string)) start++;
  while (end > start && chars.includes(text[end - 1] as string)) end--;
  return text.slice(start, end);
};

// regra do catálogo (id) -> ERE sem caixa que a descreve num documento de regras do projeto
const QMAP: [string, string][] = [
  ["pratica.erro-explicito", String.raw`catch vazio|engol(ir|e|indo) (o )?erro|n[aã]o engolir|swallow|empty catch`],
  ["pratica.fronteira-valida-entrada", String.raw`valida(r|[cç][aã]o) (de )?(entrada|input|dados externos)|validate (user )?input|class-validator`],
  ["pratica.sem-codigo-morto", String.raw`c[oó]digo morto|dead code|c[oó]digo comentado`],
  ["pratica.sem-numero-magico", String.raw`magic number|n[uú]mero m[aá]gico`],
  ["pratica.escopo-minimo", String.raw`escopo m[ií]nimo|refatora[cç][aã]o oportunista|minimal diff`],
  ["pratica.dependencia-injetada", String.raw`inje[cç][aã]o de depend|dependency injection`],
  ["pratica.nome-revela-intencao", String.raw`nomes? (descritivos?|que revela)|naming convention`],
  ["solid.responsabilidade-unica", String.raw`single responsibility|responsabilidade [uú]nica|\bSRP\b`],
  ["ts.sem-any", String.raw`\bsem any\b|zero \x60?any\x60?|proibido \x60?any|no[- ]explicit[- ]any|\x60?any\x60? impl[ií]cito`],
  ["ts.sem-assercao-cega", String.raw`as unknown as|asser[cç][aã]o de tipo|non-null assertion|\bas any\b`],
  ["ts.async-sem-esquecer", String.raw`floating promise|no-floating-promises|promise sem await`],
  ["js.igualdade-estrita", String.raw`igualdade estrita|strict equality|eqeqeq`],
  ["py.sem-except-nu", String.raw`bare except|except nu|\x60except:\x60`],
  ["sh.modo-estrito", String.raw`set -euo pipefail`],
  ["seg.sem-segredo-no-codigo", String.raw`secrets? hardcoded|hardcoded secrets?|segredos? no c[oó]digo|zero (tokens|secrets|senhas)`],
  ["seg.sem-concatenar-consulta", String.raw`sql injection|\binjection\b|concatena[cç][aã]o (de )?(consulta|query|sql)`],
  ["seg.autorizacao-no-servidor", String.raw`autoriza[cç][aã]o (no|do) servidor|server-side authorization|permission guard`],
  ["seg.log-sem-dado-sensivel", String.raw`\bPII\b.*\blogs?\b|\blogs?\b.*(credencial|dado sens[ií]vel|sensitive)`],
  ["seg.dependencia-minima", String.raw`depend[eê]ncias? novas?|new dependenc`],
  ["fw.contrato-versionado", String.raw`nunca se renomeia|breaking change|contratos? .*(compat|vers[aã]o)`],
  ["fw.idempotencia-de-consumidor", String.raw`idempot`],
  ["fw.configuracao-por-ambiente", String.raw`vari[aá]veis? de ambiente|config(ura[cç][aã]o)? por ambiente`],
  ["fw.controlador-fino", String.raw`controll?er fino|controlador fino|thin controller`],
  ["fw.ui-sem-regra-de-negocio", String.raw`regra de neg[oó]cio (no|em|na) (component|template|ui|front)`],
  ["fw.acessibilidade-basica", String.raw`acessibilidade|\ba11y\b|aria-`],
  ["teste.deterministico", String.raw`flaky|determin[ií]stic|fake timers`],
  ["teste.bug-ganha-teste", String.raw`teste de regress[aã]o|regression test|bug.*teste que falha`],
  ["teste.comportamento-nao-implementacao", String.raw`testar comportamento|implementation detail|detalhe de implementa`],
  ["teste.sem-mock-do-que-e-seu", String.raw`n[aã]o mock|sem mock|mockar (o )?(banco|prisma)|do not mock`],
  ["teste.limites-e-vazios", String.raw`edge cases?|casos? de borda`],
  ["banco.migracao-reversivel", String.raw`migra[cç][aãõ]\w*.*(revers|rollback|down)`],
  ["banco.indice-para-consulta", String.raw`[ií]ndices? .*(consulta|query)|(query|consulta).*[ií]ndice`],
  ["banco.sem-n-mais-um", String.raw`n\+1|n \+ 1`],
  ["banco.transacao-curta", String.raw`transa[cç][aã]o (curta|longa)|long transaction`],
  ["banco.dinheiro-sem-float", String.raw`float.*(dinheiro|monet|money)|(dinheiro|money|monet).*float`],
  ["banco.restricao-no-banco", String.raw`unique constraint|chave estrangeira|foreign key`],
  ["comentario.explica-porque", String.raw`coment[aá]rios?.*porqu[eê]|comments? .*\bwhy\b`],
  ["comentario.sem-historia", String.raw`todo sem dono|sem di[aá]rio`],
  ["estilo.formatacao-automatica", String.raw`prettier|formatador autom`],
  ["estilo.consistencia-local", String.raw`siga a conven|consist[eê]ncia local`],
  ["estilo.commit-pequeno", String.raw`commits? pequenos?|commits? at[oô]micos?`],
];
const QMAP_COMPILED: [string, RegExp][] = QMAP.map(([id, source]) => [id, ci(source.replaceAll("\\w", String.raw`[\p{L}\p{N}_]`))]);
const LEVEL_WORDS: [string, RegExp][] = [
  ["bloqueante", ci(String.raw`bloqueant|blocker|blocking`)],
  ["alta", ci(String.raw`importante|important|\balta\b|\bhigh\b|\bmajor\b`)],
  ["media", ci(String.raw`m[eé]dia|medium|warning|aviso`)],
  ["baixa", ci(String.raw`\bbaixa\b|\blow\b|\bnit\b|\bminor\b|sugest`)],
];
const EMOJI: [string, string][] = [["🔴", "alta"], ["🟡", "media"], ["🟢", "baixa"], ["🔵", "baixa"]];
const PERMIT = ci(String.raw`permitid[oa]|pode(m)? (usar|ser)|allowed|toler[ae]|liberad[oa]|\bok (to|usar)\b`);
const NEGATE = ci(String.raw`\b(n[aã]o|nunca|proibid[oa]|sem|zero|never|no)\b`);

// ------------------------------------------------------------------ leitura do repo

interface Hit {
  file: string;
  n: number;
  ln: string;
  m: RegExpExecArray;
}

class Repo {
  private readonly cache = new Map<string, string[]>();

  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  files(pattern: string): string[] {
    return pyGlob(this.root, pattern)
      .filter((p) => isFile(p) && !this.rel(p).split("/").some((part) => SKIP_DIRS.has(part)))
      .sort(comparePaths);
  }

  rel(path: string): string {
    return path.slice(this.root.length + 1);
  }

  lines(path: string): string[] {
    let lines = this.cache.get(path);
    if (!lines) {
      lines = splitLines(readText(path) ?? "");
      this.cache.set(path, lines);
    }
    return lines;
  }

  grep(files: string[], rx: RegExp): Hit[] {
    const hits: Hit[] = [];
    for (const file of files) {
      this.lines(file).forEach((ln, index) => {
        const m = rx.exec(ln);
        if (m) hits.push({ file, n: index + 1, ln, m });
      });
    }
    return hits;
  }

  ev(file: string, n: number): string {
    return `${this.rel(file)}:${n}`;
  }
}

const stem = (path: string): string => {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

type Evidence = Record<string, string>;
type Uncertain = JsonObject[];

function gitText(repo: string, args: string[]): string | undefined {
  const r = run("git", ["-C", repo, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function docFiles(r: Repo): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const patterns = ["CLAUDE.md", "*/CLAUDE.md", "*/*/CLAUDE.md", "[Rr][Ee][Aa][Dd][Mm][Ee]*", "CONTRIBUTING*", ".github/CONTRIBUTING*", ".github/*.md",
    "docs/architecture/*.md", "docs/*.md", "ARCHITECTURE*", "docs/specs/README.md", "docs/specs/*GUIDE*.md"];
  for (const pattern of patterns) {
    for (const file of r.files(pattern)) {
      if (!seen.has(file)) {
        seen.add(file);
        found.push(file);
      }
    }
  }
  return found;
}

/** fnmatch.fnmatch em POSIX: o padrão contra o caminho inteiro, `*` atravessa `/`. */
function fnmatch(path: string, pattern: string): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") source += ".*";
    else if (c === "?") source += ".";
    else if (c === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close < 0) source += "\\[";
      else {
        const body = pattern.slice(i + 1, close).replace(/\\/g, "\\\\");
        source += body.startsWith("!") ? `[^${body.slice(1)}]` : `[${body}]`;
        i = close;
      }
    } else source += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "su").test(path);
}

function ruleDocs(r: Repo): { entries: string[]; files: string[] } {
  const named = (files: string[]): string[] => files.filter((f) => basename(f).toLowerCase().includes("rules"));
  const rules = named([...r.files(".github/*.md"), ...r.files("docs/**/*rules*.md"), ...r.files("docs/*rules*.md")]);
  const claude = r.files("CLAUDE.md");
  const nested = [...r.files("*/*/CLAUDE.md"), ...r.files("*/CLAUDE.md")];
  const arch = r.files("docs/architecture/*.md");
  const guides = [...r.files("docs/**/*GUIDE*.md"), ...r.files("CONTRIBUTING*")].filter((f) => !rules.includes(f));
  const entries: string[] = [];
  const files: string[] = [];
  const add = (path: string, group: string[]): void => {
    if (entries.some((e) => fnmatch(path, e))) return;
    if (!entries.includes(path) && group.length > 0) {
      entries.push(path);
      for (const f of group) if (!files.includes(f)) files.push(f);
    }
  };
  const githubRules = rules.filter((f) => basename(dirname(f)) === ".github");
  for (const f of githubRules) add(r.rel(f), [f]);
  add("CLAUDE.md", claude);
  if (nested.length > 0) {
    const byParent = new Map<string, string[]>();
    for (const f of nested) {
      const parent = dirname(dirname(f));
      byParent.set(parent, [...(byParent.get(parent) ?? []), f]);
    }
    for (const parent of [...byParent.keys()].sort(comparePaths)) {
      const group = byParent.get(parent) as string[];
      add(group.length > 1 ? `${r.rel(parent)}/*/CLAUDE.md` : r.rel(group[0] as string), group);
    }
  }
  add("docs/architecture/*.md", arch);
  for (const f of guides) add(r.rel(f), [f]);
  for (const f of rules) if (!githubRules.includes(f)) add(r.rel(f), [f]);
  return { entries, files };
}

// ------------------------------------------------------------------ fluxo

interface PrTrigger {
  line: number;
  bases: string[];
  draft: boolean;
}

const RX_PR_TRIGGER = cs(String.raw`^\s*(on:\s*)?(\[?[\p{L}\p{N}_, -]*)?pull_request(\]|:|\s*$)`);
const RX_PR_TRIGGER_LIST = cs(String.raw`^\s*on:\s*\[.*pull_request.*\]`);
const RX_BRANCHES_INLINE = cs(String.raw`^\s*branches:\s*\[(.*)\]`);
const RX_BRANCHES_BLOCK = cs(String.raw`^\s*branches:\s*$`);
const RX_LIST_ITEM = cs(String.raw`^\s*-\s*\S`);
const RX_DRAFT = cs(String.raw`draft\s*(==\s*false|!=\s*true)|!github\.event\.pull_request\.draft`);
const indentOf = (line: string): number => line.length - line.trimStart().length;

function prTrigger(r: Repo, workflow: string): PrTrigger | undefined {
  const ls = r.lines(workflow);
  for (let i = 0; i < ls.length; i++) {
    const ln = ls[i] as string;
    if (!(RX_PR_TRIGGER.test(ln) || RX_PR_TRIGGER_LIST.test(ln))) continue;
    let bases: string[] = [];
    const indent = indentOf(ln);
    for (let j = i + 1; j < Math.min(i + MAX_NEAR_BRANCH_LINES, ls.length); j++) {
      const l2 = ls[j] as string;
      if (l2.trim() && indentOf(l2) <= indent) break;
      const inline = RX_BRANCHES_INLINE.exec(l2);
      if (inline) {
        bases = (inline[1] as string).split(",").filter((b) => b.trim()).map((b) => stripChars(b.trim(), "'\""));
      } else if (RX_BRANCHES_BLOCK.test(l2)) {
        let k = j + 1;
        while (k < ls.length && RX_LIST_ITEM.test(ls[k] as string)) {
          bases.push(stripChars(((ls[k] as string).split("-").slice(1).join("-")).trim(), "'\""));
          k++;
        }
      }
    }
    return { line: i + 1, bases, draft: RX_DRAFT.test(ls.join("\n")) };
  }
  return undefined;
}

function defaultBranch(repo: string): [string | undefined, string | undefined] {
  const ref = gitText(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (ref) return [ref.split("/").slice(1).join("/") || ref, "origin/HEAD"];
  const current = gitText(repo, ["branch", "--show-current"]);
  return current ? [current, "branch atual"] : [undefined, undefined];
}

const RX_BOT_MENTION = ci(String.raw`(startsWith|contains)\(github\.event\.comment\.body,\s*'(@[\p{L}\p{N}_-]+)'`);
const RX_MENTION = cs(String.raw`'(@[\p{L}\p{N}_-]+)'`);
const RX_PROCESSED = cs(String.raw`\b([A-Z][A-Z_]*_PROCESSED):`);
const RX_WAITING = ci(String.raw`^\s*(⏳[^.\n]*)`);

function inferFlow(r: Repo, repo: string, ev: Evidence, unc: Uncertain): JsonObject {
  const workflows = r.files(".github/workflows/*.y*ml");
  let best: { score: number; wf: string; trigger: PrTrigger } | undefined;
  for (const wf of workflows) {
    const trigger = prTrigger(r, wf);
    if (!trigger) continue;
    const n = basename(wf).toLowerCase();
    const has = (s: string): number => (n.includes(s) ? 1 : 0);
    const score = (has("ci") + has("pr")) * 2 + has("ci");
    if (!best || score > best.score) best = { score, wf, trigger };
  }
  let flow: JsonObject;
  if (best) {
    const { wf, trigger } = best;
    const base = trigger.bases[0] ?? defaultBranch(repo)[0] ?? "main";
    flow = { kind: "pr", base, ci: { workflow: basename(wf), bases: trigger.bases.length > 0 ? trigger.bases : [base], draft: !trigger.draft } };
    const where = r.ev(wf, trigger.line);
    // a ordem das chaves é a da saída JSON (no Python, a atribuição encadeada vai da esquerda para a direita)
    for (const key of ["flow.kind", "flow.base", "flow.ci"]) ev[key] = where;
    if (trigger.bases.length === 0) unc.push({ field: "flow.base", why: "o workflow de PR não lista branches; usei a branch padrão do repo" });
  } else {
    const [base, source] = defaultBranch(repo);
    flow = { kind: "trunk", base: base || "main" };
    ev["flow.kind"] = `nenhum workflow com pull_request${source ? `; base = ${source}` : ""}`;
    unc.push({
      field: "flow.kind",
      why: "sem workflow de CI em PR não dá para saber se o fluxo é PR ou trunk",
      suggestion: "pr se o time abre PR; trunk se commita direto na base",
    });
  }
  // bot de review por menção: workflow que reage a comentário com @nome
  for (const wf of workflows) {
    for (const hit of r.grep([wf], RX_BOT_MENTION)) {
      const mention = (RX_MENTION.exec(hit.ln) as RegExpExecArray)[1] as string;
      const markers: JsonObject[] = [{ pattern: `^${reEscape(mention)}\\b` }];
      const processed = r.grep([wf], RX_PROCESSED)[0];
      if (processed) markers.unshift({ pattern: `^${processed.m[1]}:`, multiline: true });
      const waiting = r.grep([wf], RX_WAITING)[0];
      if (waiting) markers.splice(1, 0, { pattern: `^${reEscape((waiting.m[1] as string).trim()).replaceAll("\\ ", " ")}`, multiline: true });
      const ci = isObject(flow.ci as Json) ? (flow.ci as JsonObject) : undefined;
      const bases = (ci?.bases as string[] | undefined) ?? [];
      flow.bot = { mention, bases: bases.length > 0 ? bases : [flow.base as string], selfMarkers: markers };
      ev["flow.bot"] = r.ev(hit.file, hit.n);
      unc.push({ field: "flow.bot.selfMarkers", why: "marcadores lidos do texto que o workflow posta; confira se cobrem os comentários que o fluxo e o bot geram" });
      return flow;
    }
  }
  return flow;
}

// ------------------------------------------------------------------ trabalho (specs, planos, fila)

const RX_SPEC_NAME = cs(String.raw`^([A-Z]{2,6})-\d+`);
const RX_SPEC_MENTION = cs(String.raw`\b([A-Z]{2,6})-(NNN|N+|\d{1,4})\b`);

function inferWork(r: Repo, ev: Evidence, unc: Uncertain, hasCard: boolean, notSpec: string[]): JsonObject {
  const candidates = new Map<string, number>();
  for (const d of ["docs/specs", "specs", "docs/spec", "spec", "docs/rfcs", "docs/adr"]) {
    const n = r.files(`${d}/**/*.md`).length + r.files(`${d}/*.md`).length;
    if (n) candidates.set(d, n);
  }
  const work: JsonObject = {};
  const sources: string[] = [];
  if (candidates.size > 0) {
    let [dir, count] = ["", -1];
    for (const [d, n] of candidates) if (n > count) [dir, count] = [d, n];
    work.specsDir = dir;
    sources.push("spec");
    ev["work.specsDir"] = `${dir}/ (${count} arquivos .md)`;
    const prefixes = new Map<string, number>();
    for (const f of new Set([...r.files(`${dir}/**/*.md`), ...r.files(`${dir}/*.md`)])) {
      const m = RX_SPEC_NAME.exec(basename(f));
      if (m) prefixes.set(m[1] as string, (prefixes.get(m[1] as string) ?? 0) + 1);
    }
    for (const f of r.files(`${dir}/*.md`)) {
      for (const hit of r.grep([f], RX_SPEC_MENTION)) if (!prefixes.has(hit.m[1] as string)) prefixes.set(hit.m[1] as string, 0);
    }
    const skip = new Set([...NOT_SPEC_PREFIXES, ...notSpec]);
    const kept = [...prefixes.keys()].filter((k) => !skip.has(k)).sort();
    if (kept.length > 0) {
      work.specIdPattern = `\\b((${kept.join("|")})-[0-9]{1,${SPEC_ID_WIDTH}}[a-z]?)\\b`;
      ev["work.specIdPattern"] = `nomes de arquivo e guia em ${dir}/ (prefixos ${kept.join(", ")})`;
      unc.push({ field: "work.specIdPattern", why: "prefixos achados nos nomes de arquivo e no guia das specs; falta algum?" });
    }
  }
  if (r.files("docs/plan*/*").length > 0 || r.files("plans/*").length > 0 || r.files("PLAN*.md").length > 0) {
    sources.push("plan");
    ev["work.sources"] = "pasta de planos (docs/plan*, plans, PLAN*.md)";
  }
  if (r.files("QUEUE*.md").length > 0 || r.files("BACKLOG*.md").length > 0 || r.files("ROADMAP*.md").length > 0) sources.push("queue");
  if (hasCard) sources.push("card");
  if (sources.length > 0) {
    work.sources = sources;
    ev["work.sources"] ??= "o que o repo tem (specs, planos, fila) e o card inferido";
  }
  return work;
}

// ------------------------------------------------------------------ convenções (commit, branch, card)

const RX_TYPE_LIST = ci(String.raw`types?\s+v[aá]lidos?\s*:`);
const RX_BACKTICKED = /`([a-z]+)`/gu;

function typeList(r: Repo, docs: string[]): { types: string[]; evidence: string } | undefined {
  for (const hit of r.grep(docs, RX_TYPE_LIST)) {
    const types = [...hit.ln.matchAll(RX_BACKTICKED)].map((m) => m[1] as string);
    if (types.length > 0) return { types, evidence: r.ev(hit.file, hit.n) };
  }
  return undefined;
}

/** Converte o formato de branch lido em texto (<modulo>/<tipo>/<id>[-<slug>]) em ERE. */
function fmtToRegex(fmt: string, types: string[], cardRe: string): string {
  let result = "";
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i] as string;
    if (c === "[") {
      const j = fmt.slice(i).includes("]") ? fmt.indexOf("]", i) : fmt.length;
      result += `(${fmtToRegex(fmt.slice(i + 1, j), types, cardRe)})?`;
      i = j + 1;
    } else if (c === "<") {
      const j = fmt.slice(i).includes(">") ? fmt.indexOf(">", i) : fmt.length;
      const name = fmt.slice(i + 1, j).toLowerCase();
      if (/prefix|type|tipo/.test(name)) result += `(${types.join("|")})`;
      else if (/task|card|ticket|issue|id/.test(name)) result += cardRe;
      else result += "[a-z0-9-]+";
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9]+-N+/.exec(fmt.slice(i));
      if (m) {
        result += m[0].replace(/N+$/, "[0-9]+");
        i += m[0].length;
      } else {
        result += ".+*?()|{}^$\\".includes(c) ? `\\${c}` : c;
        i++;
      }
    }
  }
  return result;
}

const RX_FOOTER = ci("footer");
const RX_FOOTER_TOKEN = cs("`([A-Za-z-]+):\\s*[^`]+`");
const RX_CO_AUTHOR = ci("co-authored-by");
const RX_CLICKUP = ci("clickup");
const RX_CARD_LINE = ci(String.raw`\b(card|task-id|ticket|clickup)`);
const RX_CARD_ID = /\b([A-Z][A-Z0-9]{1,9})-(?:\d+|N+)\b/gu;
const RX_CARD_NOT_ID = /^(UC|UF|MOD|ATOM|PROJ|INT|CROSS|SPEC)$/u;
const RX_BRANCH_LINE = ci("branch");
const RX_CODE_SPAN = /`([^`]+)`/gu;
const RX_CONVENTIONAL = ci(String.raw`conventional commits?`);
const RX_COMMIT_CONFIG = ci(String.raw`config-conventional`);
const RX_BRANCH_CARD = ci(String.raw`task|card|ticket|-N+`);
const CONVENTIONAL_REGEX = `^(${CONVENTIONAL.join("|")})(\\([^)]+\\))?!?: .+`;
const DEFAULT_CARD_RE = "[A-Z][A-Z0-9]{1,9}-[0-9]+";

function inferConventions(r: Repo, docs: string[], ev: Evidence, unc: Uncertain): JsonObject {
  const commit: JsonObject = {};
  const branch: JsonObject = {};
  const card: JsonObject = {};
  const commitlint = [...r.files("commitlint.config.*"), ...r.files(".commitlintrc*")];
  const pkg = join(r.root, "package.json");
  const types = typeList(r, docs);
  if (commitlint.length > 0 || (isFile(pkg) && (readText(pkg) ?? "").includes('"commitlint"')) || r.files(".husky/commit-msg").length > 0) {
    const file = commitlint[0];
    const conventional = file !== undefined && r.grep([file], RX_COMMIT_CONFIG).length > 0;
    commit.format = conventional ? "conventional (commitlint config-conventional)" : "conventional (commitlint)";
    commit.regex = CONVENTIONAL_REGEX;
    ev["commit.format"] = file ? r.ev(file, 1) : ".husky/commit-msg ou package.json (commitlint)";
    if (!conventional) unc.push({ field: "commit.regex", why: "commitlint sem config-conventional: usei os tipos convencionais, confira" });
  } else {
    const hit = r.grep(docs, RX_CONVENTIONAL)[0];
    if (hit) {
      commit.format = "conventional commits";
      commit.regex = CONVENTIONAL_REGEX;
      ev["commit.format"] = r.ev(hit.file, hit.n);
    }
  }
  for (const hit of r.grep(docs, RX_FOOTER)) {
    const token = RX_FOOTER_TOKEN.exec(hit.ln);
    if (token) {
      commit.footer = `${token[1]}: <IDs>`;
      ev["commit.footer"] = r.ev(hit.file, hit.n);
      break;
    }
  }
  const coAuthor = r.grep(docs, RX_CO_AUTHOR)[0];
  if (coAuthor) {
    commit.coAuthor = !NEGATE.test(coAuthor.ln);
    ev["commit.coAuthor"] = r.ev(coAuthor.file, coAuthor.n);
  }
  // card: tracker citado no texto e prefixos de ID nas linhas que falam de card/branch
  const clickup = r.grep(docs, RX_CLICKUP);
  const ids = new Map<string, string>();
  for (const hit of r.grep(docs, RX_CARD_LINE)) {
    for (const m of hit.ln.matchAll(RX_CARD_ID)) {
      const t = m[1] as string;
      if (!NOT_CARD_PREFIXES.includes(t) && !RX_CARD_NOT_ID.test(t) && !ids.has(t)) ids.set(t, r.ev(hit.file, hit.n));
    }
  }
  let cardRe = DEFAULT_CARD_RE;
  const first = clickup[0];
  if (first) {
    card.provider = "clickup";
    ev["card.provider"] = r.ev(first.file, first.n);
    if (ids.size > 0) {
      cardRe = `(${[...ids.keys()].map((t) => `${t}-[0-9]+`).join("|")})`;
      card.idPattern = `\\b${cardRe}\\b`;
      const firstId = [...ids.keys()][0] as string;
      card.newIdPattern = `${firstId}-[0-9]+`;
      card.example = `${firstId}-N`;
      ev["card.idPattern"] = [...ids].map(([t, e]) => `${t} (${e})`).join(", ");
      unc.push(
        ids.size > 1
          ? { field: "card.newIdPattern", why: `vários prefixos de card citados (${[...ids.keys()].join(", ")}): o que nasce na branch é ${firstId}?` }
          : { field: "card.create", why: "o perfil só descreve o card; criar card por script exige um bin/ no pacote" },
      );
    }
  } else if (ids.size > 0) {
    unc.push({ field: "card", why: `IDs de card (${[...ids.keys()].join(", ")}) sem tracker suportado (clickup/github): card desligado` });
  }
  // branch
  for (const hit of r.grep(docs, RX_BRANCH_LINE)) {
    const spans = [...hit.ln.matchAll(RX_CODE_SPAN)].map((m) => m[1] as string).filter((s) => s.includes("/") && s.includes("<"));
    const spec = spans[0];
    if (spec !== undefined) {
      branch.format = spec;
      branch.regex = `^${fmtToRegex(spec, types?.types ?? CONVENTIONAL, cardRe)}$`;
      ev["branch.format"] = r.ev(hit.file, hit.n);
      unc.push({ field: "branch.regex", why: `regex gerada do formato ${pyReprText(spec)}; confira com branches reais` });
      break;
    }
  }
  if (card.provider) card.required = Object.keys(branch).length > 0 && RX_BRANCH_CARD.test(String(branch.format ?? ""));
  const result: JsonObject = {};
  for (const [key, value] of [["commit", commit], ["branch", branch], ["card", card]] as [string, JsonObject][]) {
    if (Object.keys(value).length > 0) result[key] = value;
  }
  return result;
}

/** repr() de uma string do Python. */
function pyReprText(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  return `${quote}${text.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`)}${quote}`;
}

// ------------------------------------------------------------------ severidade e catálogo

const RX_HEADING = /^(#{1,6})\s+(.*)/u;
const RX_RULE_HEADING = cs(String.raw`^#{2,4}\s+([A-Z]{1,4}-?)(\d{1,3})([a-z]?)\b`);
const RX_TOP_HEADING = /^#{1,2}\s+(.*)/u;

interface Group {
  nums: Set<number>;
  levels: (string | undefined)[];
  line: number;
  letter: boolean;
  prefix: string;
  file: string;
}

function levelOf(text: string): string | undefined {
  return LEVEL_WORDS.find(([, rx]) => rx.test(text))?.[0];
}

function inferSeverity(r: Repo, files: string[], ev: Evidence, unc: Uncertain): JsonObject {
  const groups = new Map<string, Group>();
  for (const file of files) {
    let section: string | undefined;
    r.lines(file).forEach((ln, index) => {
      const h = RX_HEADING.exec(ln);
      if (h && (h[1] as string).length <= 2) section = h[2];
      const m = h ? RX_RULE_HEADING.exec(ln) : null;
      if (!m) return;
      const [prefix, num] = [m[1] as string, Number(m[2])];
      let lvl = section ? levelOf(section) : undefined;
      for (const [emoji, name] of EMOJI) if (ln.includes(emoji)) lvl ??= name;
      const key = `${prefix}\0${file}`;
      let g = groups.get(key);
      if (!g) {
        g = { nums: new Set(), levels: [], line: index + 1, letter: false, prefix, file };
        groups.set(key, g);
      }
      g.nums.add(num);
      g.levels.push(lvl);
      g.letter ||= Boolean(m[3]);
    });
  }
  const vocabulary: JsonObject[] = [];
  const patterns: string[] = [];
  const undecided: string[] = [];
  for (const g of groups.values()) {
    if (g.nums.size < MIN_SEVERITY_NUMBERS || g.prefix === "ADR-" || g.prefix === "RFC-") continue;
    const known = g.levels.filter((x): x is string => Boolean(x));
    let level = "media";
    if (known.length > 0) {
      level = known[0] as string;
      for (const k of known) if (LEVELS.indexOf(k) > LEVELS.indexOf(level)) level = k;
    } else undecided.push(g.prefix);
    const nums = [...g.nums];
    const [low, high] = [Math.min(...nums), Math.max(...nums)];
    const digits = Math.max(String(high).length, 1);
    vocabulary.push({ prefix: g.prefix, level, meaning: `regras ${g.prefix}${low}–${g.prefix}${high}`, doc: r.rel(g.file) });
    patterns.push(`${reEscape(g.prefix).replaceAll("\\-", "-")}[0-9]{1,${Math.max(digits, MIN_SEVERITY_DIGITS)}}${g.letter ? "[a-z]?" : ""}`);
    ev[`rules.severity.${g.prefix}`] = r.ev(g.file, g.line);
  }
  if (vocabulary.length === 0) return {};
  if (undecided.length > 0) {
    unc.push({ field: "rules.severity.vocabulary", why: `nível de ${undecided.join(", ")} não aparece no documento: assumi "media"; qual é a severidade deles?` });
  }
  return { codePattern: `^(${patterns.join("|")})\\b`, vocabulary };
}

interface Found {
  where: string;
  level: string | undefined;
  contradicts: boolean;
}

function inferQuality(r: Repo, files: string[], catalogRules: JsonObject[], ev: Evidence): JsonObject[] {
  const severity = new Map(catalogRules.map((c) => [String(c.id), String(c.severity)]));
  const found = new Map<string, Found>();
  for (const file of files) {
    let sectionLevel: string | undefined;
    r.lines(file).forEach((ln, index) => {
      const heading = RX_TOP_HEADING.exec(ln);
      if (heading) sectionLevel = levelOf(heading[1] as string);
      for (const [id, rx] of QMAP_COMPILED) {
        if (!severity.has(id) || !rx.test(ln)) continue;
        let lvl = levelOf(ln) ?? sectionLevel;
        for (const [emoji, name] of EMOJI) if (ln.includes(emoji) && !lvl) lvl = name;
        let entry = found.get(id);
        if (!entry) {
          entry = { where: r.ev(file, index + 1), level: undefined, contradicts: false };
          found.set(id, entry);
        }
        if (lvl && (!entry.level || LEVELS.indexOf(lvl) > LEVELS.indexOf(entry.level))) entry.level = lvl;
        if (PERMIT.test(ln) && !NEGATE.test(ln) && !entry.contradicts) {
          entry.contradicts = true;
          entry.where = r.ev(file, index + 1);
        }
      }
    });
  }
  const result: JsonObject[] = [];
  for (const [id, entry] of found) {
    const item: JsonObject = { id };
    if (entry.level && LEVELS.indexOf(entry.level) > LEVELS.indexOf(severity.get(id) as string)) item.severity = entry.level;
    if (entry.contradicts) item.contradicts = true;
    item.note = entry.where;
    result.push(item);
    ev[`rules.quality.${id}`] = entry.where;
  }
  return result;
}

function inferAgents(r: Repo, ev: Evidence): JsonObject {
  const result: JsonObject = {};
  const agents = r.files(".claude/agents/*.md");
  if (agents.length > 0) {
    result.dir = ".claude/agents";
    ev["reviewAgents.dir"] = `.claude/agents (${agents.length} agentes)`;
  }
  for (const f of r.files(".claude/commands/*review*.md")) {
    if (stem(f).includes("agents")) {
      result.command = `/${stem(f)}`;
      ev["reviewAgents.command"] = r.rel(f);
    }
  }
  return result;
}

// ------------------------------------------------------------------ rascunho

interface Inferred {
  profile: JsonObject;
  ev: Evidence;
  unc: Uncertain;
  det: string[];
  entries: string[];
}

function infer(repoPath: string, nameArg: string | undefined, slugArg: string | undefined, ghUser: string | undefined): Inferred {
  const r = new Repo(repoPath);
  const ev: Evidence = {};
  const unc: Uncertain = [];
  const url = gitText(repoPath, ["config", "--get", "remote.origin.url"]);
  const slug = slugArg || (url ? slugOf(url) : "");
  if (!slug) fail("o repo não tem remote.origin.url: passe --slug dono/repo", EXIT_NO_REMOTE);
  const parts = slug.split("/");
  if (parts.length !== 2) fail(`--slug precisa ser dono/repo (recebi ${pyReprText(slug)})`, 1);
  const [owner, repoName] = parts as [string, string];
  ev["identity.repo"] = url ? `remote.origin.url = ${url}` : "--slug";
  const name = stripChars((nameArg || repoName).toLowerCase().replace(/[^a-z0-9._-]+/g, "-"), "-");
  const identity: JsonObject = { repo: slug };
  const aliases: string[] = [];
  const short = (repoName.split(/[-_.]/)[0] as string).toLowerCase();
  for (const alias of [short, owner.toLowerCase()]) {
    if ([...alias].length >= MIN_ALIAS_LENGTH && alias !== name && !aliases.includes(alias)) aliases.push(alias);
  }
  if (aliases.length > 0) {
    identity.aliases = aliases;
    ev["identity.aliases"] = "dono e primeiro termo do nome do repo (só para a guarda de nome do núcleo)";
  }
  if (ghUser) identity.gh = { user: ghUser };
  else unc.push({ field: "identity.gh", why: "conta do gh do projeto não é inferível do repo", suggestion: "informe o usuário ou o nome da variável com o token" });
  unc.push({ field: "identity.vocabulary", why: "nomes de serviços e scripts que só existem neste projeto (guarda de nome): só o dono sabe" });
  const docs = docFiles(r);
  const flow = inferFlow(r, repoPath, ev, unc);
  const conv = inferConventions(r, docs, ev, unc);
  const { entries, files: ruleFiles } = ruleDocs(r);
  const rules: JsonObject = {};
  if (entries.length > 0) {
    rules.docs = entries;
    ev["rules.docs"] = entries.join(", ");
  }
  const severity = inferSeverity(r, ruleFiles.length > 0 ? ruleFiles : docs, ev, unc);
  if (Object.keys(severity).length > 0) rules.severity = severity;
  const cardInfo = conv.card;
  const hasCard = isObject(cardInfo as Json) && Boolean((cardInfo as JsonObject).provider);
  const vocabulary = (severity.vocabulary as JsonObject[] | undefined) ?? [];
  const work = inferWork(r, ev, unc, hasCard, vocabulary.map((v) => String(v.prefix).replace(/-+$/, "")));
  const quality = inferQuality(r, ruleFiles, effective(), ev);
  if (quality.length > 0) {
    rules.quality = quality;
    unc.push({ field: "rules.quality", why: "mapeado por palavra-chave nos documentos de regra (nota = arquivo:linha); confira cada id e as contradições antes de gravar" });
  }
  const profile: JsonObject = { schema: "hades.profile/1", name, identity, flow };
  for (const [key, value] of [["work", work], ["rules", rules], ["commit", conv.commit], ["branch", conv.branch], ["card", conv.card]] as [string, Json | undefined][]) {
    if (isObject(value as Json) && Object.keys(value as JsonObject).length > 0) profile[key] = value as JsonObject;
  }
  const det = detectStacks(repoPath);
  if (det.length > 0) {
    profile.stacks = det;
    ev.stacks = `detect de cada pacote de stack: ${det.join(", ")}`;
  }
  const agents = inferAgents(r, ev);
  if (Object.keys(agents).length > 0) profile.reviewAgents = agents;
  unc.push({ field: "env", why: "ambiente local fica fora por padrão (ver /hades env); pr.labels e refs também" });
  return { profile, ev, unc, det, entries };
}

/** Re-run: o que o init não infere (refs, env, pr, aliases/vocabulary/gh, card.create…) continua do perfil que existe. */
function mergeExisting(draft: JsonObject, existing: JsonObject): JsonObject {
  const merged = JSON.parse(JSON.stringify(existing)) as JsonObject;
  const deep = (a: JsonObject, b: JsonObject): void => {
    for (const [key, value] of Object.entries(b)) {
      const current = a[key];
      if (isObject(value) && isObject(current as Json)) deep(current as JsonObject, value);
      else a[key] = value;
    }
  };
  deep(merged, draft);
  return merged;
}

const jsonLines = (doc: JsonObject): string[] => splitLinesKeepEnds(pyDumps(doc, 2));

/** str.splitlines(keepends=True) de um texto sem quebras exóticas: o JSON do pyDumps só quebra em \n. */
function splitLinesKeepEnds(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

function conflictsOf(stageRoot: string, repo: string): string {
  const cli = selfCli("quality", "conflicts", "--dir", repo);
  const p = spawnSync(cli.command, cli.args, { encoding: "utf8", env: { ...process.env, HADES_PACKS_ROOT: stageRoot } });
  return (p.stdout ?? "").trim();
}

function expandUser(path: string): string {
  return path === "~" ? home() : path.startsWith("~/") ? join(home(), path.slice(2)) : path;
}

function copyKeepingTimes(from: string, to: string): void {
  copyFileSync(from, to);
  const { atime, mtime } = statSync(from);
  utimesSync(to, atime, mtime);
}

interface DraftArgs {
  repo?: string;
  name?: string;
  slug?: string;
  ghUser?: string;
  stage: string;
  dryRun: boolean;
}

function parseDraft(argv: string[]): DraftArgs {
  const args: DraftArgs = { stage: join(hadesHome(), "packs-draft"), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--name") args.name = argv[++i];
    else if (a === "--slug") args.slug = argv[++i];
    else if (a === "--gh-user") args.ghUser = argv[++i];
    else if (a === "--stage") args.stage = expandUser(argv[++i] ?? "") || ".";
    else if (a === "--dry-run") args.dryRun = true;
    else args.repo = realpathMissingOk(a);
  }
  return args;
}

function draft(argv: string[]): number {
  const args = parseDraft(argv);
  if (!args.repo || !isDir(args.repo)) fail("draft exige <repo>");
  const repo = args.repo;
  const tmp = args.dryRun ? mkdtempSync(join(tmpdir(), "hades-init-")) : undefined;
  const stage = tmp ?? args.stage;
  try {
    const inferred = infer(repo, args.name, args.slug, args.ghUser);
    let { profile } = inferred;
    const { ev, unc, det, entries } = inferred;
    const resolution = resolveSlug((profile.identity as JsonObject).repo as string);
    const existing = resolution.code === 0 ? loadProfile(resolution) : undefined;
    const hasExisting = existing !== undefined && Object.keys(existing).length > 0;
    let preserved: string[] = [];
    if (hasExisting) {
      preserved = Object.keys(existing).filter((k) => !(k in profile)).sort();
      const merged = mergeExisting(profile, existing);
      profile = merged;
      profile.name = (existing.name as string | undefined) ?? (profile.name as string);
    }
    const target = join(stage, profile.name as string, "profile.json");
    mkdirSync(dirname(target), { recursive: true });
    if (hasExisting) {
      const old = dirname(resolution.profile as string);
      const refs = isObject(profile.refs as Json) ? Object.values(profile.refs as JsonObject) : [];
      const create = isObject(profile.card as Json) ? (profile.card as JsonObject).create : undefined;
      for (const rel of [...refs, create]) {
        if (typeof rel === "string" && rel && isFile(join(old, rel))) {
          mkdirSync(dirname(join(dirname(target), rel)), { recursive: true });
          copyKeepingTimes(join(old, rel), join(dirname(target), rel));
        }
      }
    }
    writeFileSync(target, `${pyDumps(profile, 2)}\n`);
    const errors = validateFile(target);
    const res: JsonObject = {
      draft: args.dryRun ? null : target,
      profile,
      valid: errors.length === 0,
      errors,
      evidence: ev,
      uncertain: unc,
      dryRun: args.dryRun,
    };
    const stacks: JsonObject = { detected: det, installed: [...installedStacks().keys()].sort() };
    if (det.length === 0) {
      const manifests = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt"];
      const has = manifests.some((m) => isFile(join(repo, m)) || isDir(join(repo, m)));
      stacks.offer = has
        ? "nenhuma stack instalada casa com o repo: rode /hades stack add (hades stack-add propose) e liste a nova em stacks"
        : "nenhum manifest conhecido: escreva o pacote de stack à mão";
    }
    res.stacks = stacks;
    const mapped = ((profile.rules as JsonObject | undefined)?.quality as JsonObject[] | undefined) ?? [];
    res.quality = { mapped: mapped.map((e) => e.id as string), conflicts: conflictsOf(stage, repo), ruleDocs: entries };
    if (hasExisting) {
      res.existing = resolution.profile;
      res.preserved = preserved;
      res.diff = unifiedDiff(jsonLines(existing), jsonLines(profile), "perfil atual", "rascunho").join("");
    }
    out(pyDumps(res, 2));
    return errors.length > 0 ? 1 : 0;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

function save(argv: string[]): number {
  if (!argv.includes("--confirmed")) fail("save só com o ok do dono (AskUserQuestion): passe --confirmed depois dele");
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length !== 2) fail("save <rascunho-dir> <repo> --confirmed");
  const dir = realpathMissingOk(positional[0] as string);
  const file = join(dir, "profile.json");
  const errors = validateFile(file);
  if (errors.length > 0) fail(`rascunho inválido: ${errors.join("; ")}`, 1);
  const created = readJsonObject(file) as JsonObject;
  const slug = (created.identity as JsonObject).repo as string;
  const dest = join(packsRoot(), basename(dir), "profile.json");
  const before = resolveSlug(slug);
  if (before.code === 0 && before.profile !== dest) fail(`o repo já tem perfil em ${before.profile} (outro nome de pacote que ${pyReprText(basename(dir))})`, 1);
  if (isFile(dest)) {
    const old = readJsonObject(dest) as JsonObject;
    const diff = unifiedDiff(jsonLines(old), jsonLines(created), "perfil atual", "rascunho").join("");
    if (!diff) {
      out(`${dest}: igual ao rascunho, nada a gravar`);
      return 0;
    }
    process.stderr.write(diff);
    if (!argv.includes("--force")) fail(`${dest} já existe e difere (diff acima): --force grava depois do ok do dono sobre o diff`, 1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyKeepingTimes(file, dest);
  const pack = dirname(dest);
  const git = (args: string[]): ReturnType<typeof run> => run("git", ["-C", pack, ...args]);
  if (!isDir(join(pack, ".git")) && !isFile(join(pack, ".git"))) git(["init", "-q"]);
  git(["add", "profile.json"]);
  const commit = git(["commit", "-q", "-m", `feat: perfil ${basename(dir)} (project init)`]);
  if (commit.status !== 0) {
    process.stderr.write(`aviso: o pacote ficou sem commit (configure user.name/user.email do git): ${commit.stderr.trim().slice(0, COMMIT_WARNING_CHARS)}\n`);
  }
  const after: Resolution = resolveSlug(slug);
  out(`${dest}\nresolvedor: código ${after.code}${after.code === 0 ? ` (${after.project})` : ` — ${after.message}`}`);
  return after.code === 0 ? 0 : 1;
}

export function projectInitCommand(args: string[]): number {
  const [op, ...rest] = args;
  const handler = op === "draft" ? draft : op === "save" ? save : undefined;
  if (!handler) {
    process.stderr.write(USAGE);
    return EXIT_USAGE;
  }
  try {
    return handler(rest);
  } catch (error) {
    if (error instanceof InitError) {
      process.stderr.write(`${error.message}\n`);
      return error.code;
    }
    throw error;
  }
}
