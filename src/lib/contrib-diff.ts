// Diff de uma evolução da skill e o filtro do que pode voltar ao repositório dela: só o núcleo (`hades contrib`).
import { run } from "./proc.ts";

const CORE_DIRS = ["kit/", "src/", "reference/", "loop/"];
const CORE_FILES = ["SKILL.md"];
const PACK_DIRS = ["packs/", "env/"];
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface FileDiff {
  /** caminho depois da mudança */
  path: string;
  /** caminho antes (igual ao `path` fora de renomeação) */
  from: string;
  text: string;
  binary: boolean;
  /** linhas postas, com o número no arquivo novo */
  added: { line: number; text: string }[];
  plus: number;
  minus: number;
}

export interface LeftOut {
  path: string;
  reason: string;
}

export interface Split {
  core: FileDiff[];
  left: LeftOut[];
}

const HEADER = /^diff --git /m;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** `a/P b/Q`: fora de renomeação os dois lados são iguais, e é o ponto em que a metade casa que separa o caminho. */
function headerPaths(header: string): [string, string] {
  const rest = header.slice("diff --git ".length);
  for (let i = rest.indexOf(" b/"); i >= 0; i = rest.indexOf(" b/", i + 1)) {
    const from = rest.slice(2, i);
    const to = rest.slice(i + 3);
    if (from === to) return [from, to];
  }
  const cut = rest.indexOf(" b/");
  return [rest.slice(2, cut), rest.slice(cut + 3)];
}

function parseBlock(text: string): FileDiff {
  const lines = text.split("\n");
  let [from, path] = headerPaths(lines[0] ?? "");
  const renameFrom = /^rename from (.+)$/m.exec(text)?.[1];
  const renameTo = /^rename to (.+)$/m.exec(text)?.[1];
  if (renameFrom !== undefined && renameTo !== undefined) [from, path] = [renameFrom, renameTo];
  const added: FileDiff["added"] = [];
  let minus = 0;
  let next = 0;
  let inHunk = false;
  for (const line of lines.slice(1)) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      inHunk = true;
    } else if (!inHunk || line.startsWith("\\")) {
      continue;
    } else if (line.startsWith("+")) {
      added.push({ line: next++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      minus++;
    } else {
      next++;
    }
  }
  return { path, from, text, binary: /^(Binary files |GIT binary patch)/m.test(text), added, plus: added.length, minus };
}

export function parseDiff(diff: string): FileDiff[] {
  const starts = [...diff.matchAll(new RegExp(HEADER.source, "gm"))].map((m) => m.index ?? 0);
  return starts.map((start, i) => parseBlock(diff.slice(start, starts[i + 1] ?? diff.length).replace(/\n*$/, "\n")));
}

const inside = (path: string, dirs: string[]): boolean => dirs.some((d) => path.startsWith(d));
const isCore = (path: string): boolean => inside(path, CORE_DIRS) || CORE_FILES.includes(path);

function leftReason(file: FileDiff): string {
  if (inside(file.path, PACK_DIRS) || inside(file.from, PACK_DIRS)) return "pacote de projeto (packs/, env/, perfil) nunca entra";
  if (file.binary) return "binário: não dá para varrer";
  return "fora do núcleo (kit/, src/, reference/, loop/, SKILL.md)";
}

/** Núcleo = os dois lados da mudança no núcleo e arquivo de texto; o resto sai com o motivo. */
export function splitCore(files: FileDiff[]): Split {
  const core: FileDiff[] = [];
  const left: LeftOut[] = [];
  for (const file of files) {
    if (isCore(file.path) && isCore(file.from) && !file.binary) core.push(file);
    else left.push({ path: file.path, reason: leftReason(file) });
  }
  return { core, left };
}

export function diffText(files: FileDiff[]): string {
  return files.map((f) => f.text).join("");
}

/** O que a skill mudou desde `base` (commits e árvore de trabalho), arquivos novos ainda fora do git incluídos. */
export function collectDiff(skill: string, base: string): string {
  const git = (args: string[]) => run("git", ["-C", skill, "-c", "core.quotepath=off", ...args], { maxBuffer: GIT_MAX_BUFFER });
  const tracked = git(["diff", "-M", "--no-color", "--no-ext-diff", base]);
  if (tracked.status !== 0) throw new Error(`git diff ${base} falhou: ${tracked.stderr.trim()}`);
  // `--no-index` sai 1 quando há diferença: é o normal aqui
  const fresh = git(["ls-files", "--others", "--exclude-standard"]).stdout.split("\n").filter(Boolean)
    .map((file) => git(["diff", "--no-index", "--no-color", "--", "/dev/null", file]).stdout);
  return tracked.stdout + fresh.join("");
}

/** O commit que subiu a VERSION instalada: o ponto de partida da evolução (a skill não usa tags). */
export function baseOfVersion(skill: string, version: string): string | undefined {
  if (!version) return undefined;
  const r = run("git", ["-C", skill, "log", "-1", "--format=%H", `-S${version}`, "--", "VERSION"]);
  return r.stdout.trim() || undefined;
}

/** Assuntos dos commits do núcleo desde `base`, do mais antigo ao mais novo. */
export function subjectsSince(skill: string, base: string): string[] {
  const r = run("git", ["-C", skill, "log", "--reverse", "--format=%s", `${base}..HEAD`, "--", ...CORE_DIRS, ...CORE_FILES]);
  return r.stdout.split("\n").filter(Boolean);
}

/** Primeiro segmento do caminho (o "lugar" do núcleo em que o arquivo mora). */
export function areaOf(path: string): string {
  return path.includes("/") ? (path.split("/", 1)[0] as string) : path;
}
