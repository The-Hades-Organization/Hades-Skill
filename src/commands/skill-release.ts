// `hades skill-release`: evolução da própria skill. drift, check, guard e release.
// O check roda a regressão do núcleo (`bun test loop/test/ts`) e a de cada pacote pela fila de gates (gate-lock, tipo
// test); a regressão verde do HEAD com a árvore limpa fica registrada em <raiz de trabalho>/_skill/ e o check seguinte
// no mesmo HEAD a pula. O registro nunca fica no repo.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { cerberusCommand } from "./cerberus.ts";
import { record, workRoot } from "../lib/cerberus.ts";
import { firstLine, isDir, isFile, listDir, readText } from "../lib/fs.ts";
import { NOT_INSTALLED, PLUGIN_FILES } from "../lib/install-copy.ts";
import { kitDir } from "../lib/kit.ts";
import { EXIT, out } from "../lib/output.ts";
import { reminderLine as uxAuditReminder } from "./ux-audit.ts";
import { hadesHome, home, skillRoot } from "../lib/paths.ts";
import { getField, isObject, loadProfile, readJson } from "../lib/profile.ts";
import { REPO } from "../lib/version-check.ts";
import { globRegex, guardTerms, identityPattern, skillRepoSlug } from "../lib/release-guard.ts";
import { packOf, packsRoot, resolveProject } from "../lib/project.ts";
import { run } from "../lib/proc.ts";
import { installedFiles, validateFile } from "../lib/validate.ts";

const USAGE_LINES = [
  "Evolução da própria skill (não é instalado em $D; rode daqui: ~/.claude/skills/hades/kit/skill-release.sh).",
  "",
  "  skill-release.sh drift                 o que foi editado à mão no kit INSTALADO ($HADES_DATA) e não voltou para",
  "                                         o kit da skill — todo ajuste feito no ambiente vivo tem de ser portado antes",
  "  skill-release.sh check                 valida o kit: bash -n, node --check, py_compile, varredura de segredos e de",
  "                                         caminhos/identidades da máquina, perfis válidos, regressão (loop/test e a",
  "                                         de cada pacote), guarda de nome de projeto (HADES_NAME_GUARD=report|strict),",
  "                                         guarda de domínio (HADES_DOMAIN_GUARD=report|strict; padrão strict)",
  "                                         e instalação numa pasta descartável",
  "  skill-release.sh check --regressao     roda a regressão mesmo que o HEAD já tenha uma verde registrada (reference/evolving.md §5)",
  "  skill-release.sh release <major|minor|patch> \"<resumo>\" [--out <dir>] [--plano <plan.json>]",
  "                                         check → sobe VERSION → garante a entrada no CHANGELOG.md → empacota",
  "                                         hades-skill-v<versão>.tar.gz em <dir> (padrão: ~/.claude/hades/releases) → sha256",
  "  skill-release.sh release same [--out <dir>]",
  "                                         sem bump: empacota a VERSION atual (já subida na consolidação), exigindo a",
  "                                         entrada dela no CHANGELOG.md. Também é o jeito de reempacotar depois de",
  "                                         detalhar o CHANGELOG: o release <nível> só empacota uma vez",
  "  --plano <plan.json>                    o plano aprovado da consolidação da skill, passado ao Cerberus (o repo da skill",
  "                                         não tem origin para achá-lo). Sem ele: o plano da skill (_skill/orchestration/plan.json na raiz de trabalho, do plan-approve rodado no repo da skill)",
];

/** Linhas de regressão que o check mostra quando ela falha. */
const FAILURE_EXCERPT = /✗|^ {4}|\(fail\)|error:/;
const EXCERPT_LINES = 40;
const PACKAGE_EXCLUDES = ["assets", "node_modules"] as const;
/** Ponto de extensão do plugin: o install o põe em $D/plugin/ (não na raiz); a lista é a do install. */
const isPluginFile = (rel: string): boolean => (PLUGIN_FILES as readonly string[]).includes(rel.split("/")[0] as string);
const GREP_EXCLUDES = ["--exclude-dir=.git", "--exclude-dir=assets", "--exclude-dir=.design-sync-reports", "--exclude-dir=vendor", "--exclude-dir=node_modules", "--exclude=.git"];
/** A guarda de domínio ignora loop/test (fixture fala de domínio); a de nome não: nome de projeto em teste também vaza. */
const DOMAIN_GREP_EXCLUDES = [...GREP_EXCLUDES, "--exclude-dir=test"];
const GREP_MAX_BUFFER = 256 * 1024 * 1024;
const REGISTRY_FILE = "regressao-verde.json";
const GATE_LABEL = "skill-release";
// medido: 7 min em série, 3 min com 4 processos e 2,4 min com 8 (os arquivos de teste isolam o próprio HOME, portas e filas)
const REGRESSION_WORKERS = 8;
// prazo de cada teste: muitos casos rodam processos do kit e, com 8 em paralelo numa máquina carregada (load 20), passam dos
// 5 s padrão do bun sem defeito (#10). O bun 1.4 ignora `[test] timeout` do bunfig.toml: vai pela linha de comando.
const REGRESSION_TEST_TIMEOUT_MS = 30_000;
const CLI = join(skillRoot, "src", "cli.ts");
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Context {
  kit: string;
  skill: string;
  /** o ambiente instalado ($HADES_DATA ou a instância registrada) */
  data: string;
  /** o worktree do ambiente */
  wt: string;
  /** pasta do ambiente do projeto (env.pack) se o plugin está ligado */
  packEnv: string;
  /** a mesma pasta, ligada ou não (o que o plugin gerou segue reconhecido) */
  packAll: string;
}

function walkFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const name of listDir(dir)) {
      const path = join(dir, name);
      if (isDir(path)) visit(path);
      else if (isFile(path)) found.push(relative(root, path));
    }
  };
  visit(root);
  return found.sort(byCodepoint);
}

const sameBytes = (a: string, b: string): boolean => {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

/** `*.ext` direto na pasta, em ordem (o glob do bash); pasta ou arquivo ausente dá lista vazia */
function globIn(dir: string, ext: string): string[] {
  return listDir(dir).filter((n) => n.endsWith(ext)).sort(byCodepoint).map((n) => join(dir, n)).filter(isFile);
}

// um nível abaixo da pasta (o glob dir/*/arquivo do bash)
function globDeep(dir: string, ext: string): string[] {
  return listDir(dir).sort(byCodepoint).flatMap((n) => (isDir(join(dir, n)) ? globIn(join(dir, n), ext) : []));
}

/** campo-lista do manifesto do plugin (plugin.json), um item por linha; sem plugin ou sem o campo, nada */
function pluginList(field: string, packEnv: string): string[] {
  if (!packEnv) return [];
  const doc = readJson(join(packEnv, "plugin.json"));
  const value = isObject(doc) ? doc[field] : undefined;
  return Array.isArray(value) ? value.map((x) => String(x)) : [];
}

function context(): Context | undefined {
  const kit = kitDir();
  const skill = resolve(kit, "..");
  const data = process.env.HADES_DATA || firstLine(join(hadesHome(), "instance"));
  if (!data || !isFile(join(data, "env.sh"))) return undefined;
  const wt = process.env.HADES_WT || /^W="([^"]*)"/m.exec(readText(join(data, "env.sh")) ?? "")?.[1] || "";
  let packEnv = "";
  let packAll = "";
  const resolution = resolveProject(wt);
  const pack = packOf(resolution);
  if (pack) {
    const rel = getField(loadProfile(resolution), "env.pack", "") ?? "";
    if (rel && isDir(join(pack, rel))) {
      packAll = join(pack, rel);
      const disabled = (readText(join(data, "plugins.disabled")) ?? "").split("\n");
      if (!disabled.includes(basename(pack))) packEnv = packAll;
    }
  }
  return { kit, skill, data, wt, packEnv, packAll };
}

// ------------------------------------------------------------------ drift

/** Arquivos que o manifesto do install (kit.manifest: `sha256  caminho`) lista, o kit atual não tem e o $D ainda guarda. */
function leftFromKit(c: Context): string[] {
  const rels = (readText(join(c.data, "kit.manifest")) ?? "").split("\n").filter((l) => l.includes("  ")).map((l) => l.slice(l.indexOf("  ") + 2));
  return rels.filter((rel) => rel !== "" && !isFile(join(c.kit, rel)) && isFile(join(c.data, rel)));
}

/** sha256 por caminho do manifesto do install: o que o install pôs no $D, para separar edição à mão de kit mais velho. */
function manifestShas(c: Context): Map<string, string> {
  const shas = new Map<string, string>();
  for (const line of (readText(join(c.data, "kit.manifest")) ?? "").split("\n")) {
    const at = line.indexOf("  ");
    if (at > 0) shas.set(line.slice(at + 2), line.slice(0, at));
  }
  return shas;
}

const sha256Of = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** O comando que reinstala o kit no $D desta instalação (o mesmo que o doctor sugere). */
const installCommand = (c: Context, shown: (p: string) => string): string =>
  `${c.wt ? `HADES_WT=${shown(c.wt)} ` : ""}HADES_DATA=${shown(c.data)} ${shown(c.kit)}/install.sh`;

function drift(c: Context): boolean {
  let n = 0;
  let stale = 0;
  let onlyInKit = 0;
  let pristine = 0;
  const manifest = manifestShas(c);
  // o vivo numa versão anterior do kit difere do kit sem ter sido editado: compara com a versão instalada (kit.version)
  const installed = firstLine(join(c.data, "kit.version"));
  const current = firstLine(join(c.skill, "VERSION"));
  const outdated = installed !== "" && current !== "" && installed !== current;
  const shown = (p: string): string => (p.startsWith(`${home()}/`) ? `~${p.slice(home().length)}` : p);
  for (const root of [c.kit, ...(c.packEnv ? [c.packEnv] : [])]) {
    for (const rel of walkFiles(root)) {
      if (rel.endsWith(".pyc") || rel.includes("__pycache__/")) continue;
      if (NOT_INSTALLED.test(basename(rel)) || rel.startsWith("assets/") || rel.startsWith("reference/")) continue;
      const dst = root === c.packEnv && isPluginFile(rel) ? `plugin/${rel}` : rel;
      if (!isFile(join(c.data, dst))) {
        out(`  só em ${shown(root)}:        ${rel}`);
        n++;
        onlyInKit++;
      } else if (!sameBytes(join(root, rel), join(c.data, dst))) {
        // o conteúdo do $D bate com o que o install pôs: ninguém editou, o kit é que andou; só falta reinstalar
        if (manifest.get(dst) === sha256Of(join(c.data, dst))) {
          out(`  falta reinstalar: ${dst}   (igual ao manifesto do install, não é edição)`);
          pristine++;
          continue;
        }
        out(`  ${outdated ? "desatualizado em $D: " : "editado em $D:    "}${dst}   (diff -u ${join(root, rel)} ${join(c.data, dst)})`);
        if (outdated) stale++;
        n++;
      }
    }
  }
  // código novo criado direto em $D (scripts e módulos), fora de estado/logs e do que o plugin declara gerado
  const generated = pluginList("generated", c.packAll);
  const CODE = /\.(sh|mjs|py|html|yml|conf|sql)$/;
  const fresh: string[] = [];
  for (const name of listDir(c.data)) {
    const path = join(c.data, name);
    if (isFile(path)) {
      if (CODE.test(name) && name !== "env.sh") fresh.push(name);
    } else if (isDir(path) && name !== "logs" && name !== "pkgs") {
      for (const inner of listDir(path)) if (isFile(join(path, inner)) && CODE.test(inner)) fresh.push(`${name}/${inner}`);
    }
  }
  const left = leftFromKit(c);
  for (const rel of fresh.sort(byCodepoint)) {
    if (left.includes(rel)) continue;
    if (isFile(join(c.kit, rel)) || (c.packAll && (isFile(join(c.packAll, rel)) || isFile(join(c.packAll, rel.replace(/^plugin\//, "")))))) continue;
    if (generated.includes(basename(rel))) continue;
    out(`  só em $D (novo?): ${rel}`);
    n++;
  }
  // saiu do kit: o manifesto do install lista o que ele pôs no $D; a reinstalação remove o que o kit não tem mais (ou avisa, se
  // foi editado); até lá o drift o aponta
  for (const rel of left) {
    out(`  saiu do kit:      ${rel}   (reinstale: o install.sh remove se não foi editado)`);
    n++;
  }
  if (outdated && stale > 0) out(`instalação desatualizada (instalada ${installed}, skill ${current}): reinstale (install.sh) antes de tratar como edição à mão`);
  // só arquivo novo do kit (nada editado em $D): não há o que portar, falta instalar
  if (n > 0 && n === onlyInKit) out(`só há arquivo novo do kit ainda não instalado: reinstale, sem portar nada: ${installCommand(c, shown)}`);
  if (pristine > 0) out(`${pristine} arquivo(s) iguais ao manifesto do install ficaram de fora do drift: reinstale: ${installCommand(c, shown)}`);
  out(n ? `drift: ${n} arquivo(s) — portar para o kit (generalizando) ou descartar antes do release` : "drift: nenhum");
  return n === 0;
}

/** O que o release leva: do commit que subiu a VERSION da release anterior até o HEAD (a skill não usa tags). */
export function releaseRange(skill: string, bumped: boolean): string {
  const bumps = run("git", ["-C", skill, "log", "-2", "--format=%H", "--", "VERSION"]).stdout.split("\n").filter(Boolean);
  const base = bumps[bumped ? 1 : 0];
  return base ? `${base}..HEAD` : "";
}

// ------------------------------------------------------------------ regressão

interface Registry {
  head: string;
  at: string;
  nucleo: string;
  pacotes: string[];
}

const registryFile = (): string => join(workRoot(), "_skill", REGISTRY_FILE);

function gitHead(skill: string): { head: string; clean: boolean } | undefined {
  const head = run("git", ["-C", skill, "rev-parse", "HEAD"]).stdout.trim();
  if (!head) return undefined;
  const status = run("git", ["-C", skill, "status", "--porcelain"]);
  return { head, clean: status.status === 0 && status.stdout.trim() === "" };
}

function readRegistry(): Registry | undefined {
  const doc = readJson(registryFile());
  if (!isObject(doc) || typeof doc.head !== "string" || typeof doc.at !== "string") return undefined;
  return { head: doc.head, at: doc.at, nucleo: String(doc.nucleo ?? ""), pacotes: Array.isArray(doc.pacotes) ? doc.pacotes.map(String) : [] };
}

function writeRegistry(entry: Registry): void {
  const file = registryFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
  renameSync(tmp, file);
}

/** O comando da regressão pela fila de gates; já dentro de um gate (GATE_LOCK_TICKET), direto: a fila não admite gate dentro de gate. */
function gated(command: string[]): string[] {
  if (process.env.GATE_LOCK_TICKET) return command;
  // a regressão da skill é da máquina: a fila não segue o remote do HADES_WT nem do cwd (reference/loop/gates.md)
  return ["env", "HADES_GATE_SCOPE=maquina", process.execPath, CLI, "gate-lock", "run", "test", "--label", GATE_LABEL, "--", ...command];
}

function hasBunTests(testDir: string): boolean {
  return listDir(testDir).some((n) => {
    const path = join(testDir, n);
    return isDir(path) ? !PACKAGE_EXCLUDES.includes(n as "node_modules") && hasBunTests(path) : n.endsWith(".test.ts");
  });
}

/** roda um comando com a saída num arquivo; em falha mostra o trecho que importa */
function runLogged(failure: string, command: string[], cwd: string, env: NodeJS.ProcessEnv): boolean {
  const dir = mkdtempSync(join(tmpdir(), "skill-release-"));
  const log = join(dir, "regressao.log");
  const fd = openSync(log, "w");
  const r = spawnSync(command[0] as string, command.slice(1), { cwd, env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const status = r.status ?? EXIT.fail;
  if (status !== 0) {
    out(`${failure}${status === 75 ? " (a fila de gates não admitiu a tempo: saída 75)" : ""}:`);
    const lines = (readText(log) ?? "").split("\n").filter((l) => FAILURE_EXCERPT.test(l));
    for (const l of lines.slice(0, EXCERPT_LINES)) out(l);
  }
  rmSync(dir, { recursive: true, force: true });
  return status === 0;
}

/** Regressão do núcleo (`bun test`) e a de cada pacote (`bun test` no test/ dele quando há *.test.ts, senão o test/run.sh). */
function regression(c: Context, force: boolean): boolean {
  const state = gitHead(c.skill);
  if (state && !force && state.clean) {
    const known = readRegistry();
    if (known && known.head === state.head) {
      out(`regressão: pulada — o HEAD ${state.head.slice(0, 12)} já tem regressão verde (registro ${registryFile()}, ${known.at}); --regressao força`);
      return true;
    }
  }
  const dirty = state ? !state.clean : false;
  if (dirty) out("regressão: árvore suja, roda sempre e não grava registro");
  const env: NodeJS.ProcessEnv = { ...process.env, HADES_SKILL: c.skill };
  out("regressão do núcleo: bun test loop/test/ts, pela fila de gates (gate-lock test)");
  let ok = runLogged("regressão do núcleo falhou", gated([process.execPath, "test", "loop/test/ts", `--parallel=${REGRESSION_WORKERS}`, `--timeout=${REGRESSION_TEST_TIMEOUT_MS}`]), c.skill, env);
  const ran: string[] = [];
  const packs = packsRoot();
  for (const name of listDir(packs).sort(byCodepoint)) {
    const testDir = join(packs, name, "test");
    if (!hasBunTests(testDir)) {
      if (isFile(join(testDir, "run.sh"))) {
        out(`regressão do pacote ${name}: test/run.sh não roda mais (core >=5 é só bun test): porte a regressão para *.test.ts`);
        ok = false;
      }
      continue;
    }
    out(`regressão do pacote ${name}: bun test, pela fila de gates`);
    if (!runLogged(`regressão do pacote falhou: ${testDir}`, gated([process.execPath, "test"]), testDir, env)) ok = false;
    ran.push(name);
  }
  // só a regressão completa e verde, de um HEAD que seguiu limpo, vira registro
  const after = gitHead(c.skill);
  if (ok && state && state.clean && after && after.clean && after.head === state.head) {
    writeRegistry({ head: state.head, at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), nucleo: "bun test loop/test/ts", pacotes: ran });
  }
  return ok;
}

// ------------------------------------------------------------------ guardas

function cerberusEmit(guard: string, result: string, checked: string, where: string): void {
  try {
    record("porta", guard, "release", result, [{ conferido: checked, onde: where }], { ctx: { comando: process.env.CERBERUS_CMD || "guard" } });
  } catch {
    // o registro nunca muda o que a guarda decidiu
  }
}

function grep(args: string[]): string[] {
  const r = spawnSync("grep", args, { encoding: "utf8", maxBuffer: GREP_MAX_BUFFER });
  return (r.stdout ?? "").split("\n").filter((l) => l !== "");
}

/** `file:count` por arquivo, em ordem decrescente de contagem (a ordem do sort do script em bash) */
function rank(counts: Map<string, number>): string[] {
  return [...counts.entries()].map(([f, n]) => `${f}:${n}`)
    .sort((a, b) => Number(b.slice(b.lastIndexOf(":") + 1)) - Number(a.slice(a.lastIndexOf(":") + 1)) || byCodepoint(a, b));
}

function showHits(label: string, mode: string, what: string, hits: string[]): void {
  const lines = hits.reduce((sum, h) => sum + Number(h.slice(h.lastIndexOf(":") + 1)), 0);
  // uma escrita só: o `| head -1` do consumidor fecha o pipe depois da primeira linha e o relatório inteiro já saiu (como no bash)
  out([`${label} (${mode}): ${hits.length} arquivo(s), ${lines} linha(s) citam ${what}`,
    ...hits.map((h) => `  ${h.replace(/:([0-9]*)$/, "  $1")}`)].join("\n"));
}

/** O núcleo não cita projeto: os termos vêm dos perfis instalados e o vocabulário (identity.vocabulary), nunca de lista no código. */
function nameGuard(c: Context, root: string): boolean {
  const mode = process.env.HADES_NAME_GUARD || "strict";
  const { names: terms, vocab: pats } = guardTerms([]);
  if (!terms.length && !pats.length) {
    out("guarda de nome: nenhum perfil instalado");
    cerberusEmit("nome-de-projeto", "ok", "nenhum perfil instalado: nada a procurar", root);
    return true;
  }
  // a slug do repo da própria skill (padrão de HADES_VERSION_CHECK_REPO no config.tsv) é isenta: a linha que a cita não conta
  const slug = skillRepoSlug([root, c.skill]);
  const tmp = mkdtempSync(join(tmpdir(), "skill-release-"));
  const lines: string[] = [];
  for (const [flag, list] of [["-F", terms], ["-E", pats]] as const) {
    if (!list.length) continue;
    const file = join(tmp, `pats${flag}`);
    writeFileSync(file, `${list.join("\n")}\n`);
    lines.push(...grep(["-rniI" + flag.slice(1), "-f", file, root, ...GREP_EXCLUDES]));
  }
  rmSync(tmp, { recursive: true, force: true });
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (slug && line.toLowerCase().includes(slug.toLowerCase())) continue;
    const file = line.split(":", 1)[0] as string;
    const rel = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
    counts.set(rel, (counts.get(rel) ?? 0) + 1);
  }
  if (!counts.size) {
    out("guarda de nome: núcleo sem nome de projeto");
    cerberusEmit("nome-de-projeto", "ok", "termos dos perfis instalados: nenhuma citação", root);
    return true;
  }
  const hits = rank(counts);
  showHits("guarda de nome", mode, "projeto", hits);
  cerberusEmit("nome-de-projeto", mode === "strict" ? "barra" : "aviso", `${hits.length} arquivo(s) citam projeto (HADES_NAME_GUARD=${mode})`,
    `${root}: ${hits.slice(0, 3).map((h) => h.slice(0, h.lastIndexOf(":"))).join(",")}`);
  return mode !== "strict";
}

/** O núcleo não cita o domínio de um projeto: os termos vêm do `domainTerms` do perfil de cada pacote. */
function domainGuard(c: Context, root: string): boolean {
  const mode = process.env.HADES_DOMAIN_GUARD || "strict";
  const { domain: terms, allow } = guardTerms([]);
  if (!terms.length) {
    cerberusEmit("dominio", "ok", "nenhum perfil declara domainTerms: nada a procurar", root);
    return true;
  }
  const tmp = mkdtempSync(join(tmpdir(), "skill-release-"));
  const file = join(tmp, "pats");
  writeFileSync(file, `${terms.join("\n")}\n`);
  const lines = grep(["-rniIcE", "-f", file, root, ...DOMAIN_GREP_EXCLUDES]);
  rmSync(tmp, { recursive: true, force: true });
  const counts = new Map<string, number>();
  for (const line of lines) {
    const cut = line.lastIndexOf(":");
    const n = Number(line.slice(cut + 1));
    if (!n) continue;
    const path = line.slice(0, cut);
    const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    counts.set(rel, (counts.get(rel) ?? 0) + n);
  }
  // @allow <glob>: arquivos do núcleo que ainda dependem do ambiente do projeto (dívida declarada no pacote, não silêncio)
  for (const glob of allow.filter(Boolean)) {
    const re = globRegex(glob);
    for (const f of [...counts.keys()]) if (re.test(f)) counts.delete(f);
  }
  if (!counts.size) {
    out("guarda de domínio: núcleo sem vocabulário de domínio");
    cerberusEmit("dominio", "ok", "domainTerms dos perfis: nenhuma citação fora dos @allow", root);
    return true;
  }
  const hits = rank(counts);
  showHits("guarda de domínio", mode, "o domínio", hits);
  cerberusEmit("dominio", mode === "strict" ? "barra" : "aviso", `${hits.length} arquivo(s) citam o domínio (HADES_DOMAIN_GUARD=${mode})`,
    `${root}: ${hits.slice(0, 3).map((h) => h.slice(0, h.lastIndexOf(":"))).join(",")}`);
  return mode !== "strict";
}

/** Lista de repositórios que o pacote público não pode citar (HADES_FORBIDDEN_REPOS: dono/nome separados por vírgula ou espaço). */
function forbiddenRepos(): { valid: string[]; invalid: string[] } {
  const items = (process.env.HADES_FORBIDDEN_REPOS ?? "").split(/[\s,]+/).filter(Boolean);
  return { valid: items.filter((i) => REPO.test(i)), invalid: items.filter((i) => !REPO.test(i)) };
}

/**
 * Link ou referência a repositório que não pode ficar público (plugin privado, repo anterior). A lista vem do ambiente
 * (no CI, uma variável do repositório): o nome proibido nunca é gravado no que a guarda protege. Cobre github.com/<repo>,
 * git@github.com:<repo> e repos/<repo> (gh api), sem diferenciar caixa; só acusa o nome inteiro (a/b não pega a/b-outro).
 */
function forbiddenRepoGuard(root: string): boolean {
  const { valid, invalid } = forbiddenRepos();
  if (invalid.length) {
    out(`guarda de repositório proibido: HADES_FORBIDDEN_REPOS fora do formato dono/nome: ${invalid.length} item(ns)`);
    cerberusEmit("repo-proibido", "barra", "lista de repositórios proibidos inválida", root);
    return false;
  }
  if (!valid.length) return true; // sem lista não há o que procurar, e a saída da guarda não muda para quem não a usa
  const escaped = valid.map((r) => r.replace(/[.]/g, "\\."));
  const pattern = `(github\\.com[/:]|repos/)(${escaped.join("|")})([^A-Za-z0-9_-]|$)`;
  const counts = new Map<string, number>();
  for (const line of grep(["-rniIE", pattern, root, ...GREP_EXCLUDES])) {
    const file = line.split(":", 1)[0] as string;
    const rel = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
    counts.set(rel, (counts.get(rel) ?? 0) + 1);
  }
  if (!counts.size) {
    out(`guarda de repositório proibido: nenhuma citação (${valid.length} repositório(s) na lista)`);
    cerberusEmit("repo-proibido", "ok", `${valid.length} repositório(s) proibido(s): nenhuma citação`, root);
    return true;
  }
  const hits = rank(counts);
  showHits("guarda de repositório proibido", "strict", "repositório proibido", hits);
  cerberusEmit("repo-proibido", "barra", `${hits.length} arquivo(s) citam repositório proibido`, `${root}: ${hits.slice(0, 3).map((h) => h.slice(0, h.lastIndexOf(":"))).join(",")}`);
  return false;
}

/** Segredos e identidade da máquina: nada disso pode ir no pacote. */
function secretScan(c: Context): boolean {
  const pattern = identityPattern();
  const hits = grep(["-rnIE", pattern, c.skill, "--exclude-dir=node_modules", "--exclude-dir=assets", "--exclude-dir=.git",
    "--exclude-dir=.design-sync-reports", "--exclude=.git"]).filter((l) => !l.includes("skill-release.sh"));
  for (const h of hits) out(h);
  if (hits.length) out("SEGREDO/IDENTIDADE no pacote (acima)");
  return hits.length === 0;
}

// ------------------------------------------------------------------ check

function check(c: Context, forceRegression: boolean): boolean {
  let bad = false;
  const fail = (label: string, file: string): void => {
    out(`${label}: ${file}`);
    bad = true;
  };
  const bashN = (file: string): void => {
    if (run("bash", ["-n", file]).status !== 0) fail("SH", file);
  };
  const nodeCheck = (file: string): void => {
    if (run("node", ["--check", file]).status !== 0) fail("JS", file);
  };
  const packSh = c.packEnv ? [...globIn(c.packEnv, ".sh"), ...globIn(join(c.packEnv, "infra"), ".sh")] : [];
  for (const f of [...globIn(c.kit, ".sh"), ...globIn(join(c.kit, "gate"), ".sh"), ...packSh]) bashN(f);
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  for (const f of [join(c.kit, "panel", "ui", "app.tsx"), ...globDeep(join(c.kit, "panel", "ui"), ".tsx")]) {
    if (!isFile(f)) continue;
    try {
      transpiler.transformSync(readFileSync(f, "utf8"));
    } catch (error) {
      out(String(error instanceof Error ? error.message : error));
      fail("TSX", f);
    }
  }
  for (const f of globIn(join(c.skill, "loop", "bin"), ".sh")) bashN(f);
  for (const f of [...globIn(join(c.skill, "loop", "bin"), ".py"), ...globIn(join(c.skill, "loop", "hooks"), ".py")]) fail("PY", `${f} (o contrato 5.0 não tem Python na skill)`);
  if (c.packEnv) {
    const services = join(c.packEnv, "services.tsv");
    if (isFile(services)) {
      (readText(services) ?? "").split("\n").forEach((line, i) => {
        const cols = line.split("\t").length;
        if (line && !line.startsWith("#") && cols !== 7) {
          out(`services.tsv linha ${i + 1}: ${cols} colunas`);
          bad = true;
        }
      });
    }
    const scripts = (dir: string): string[] => listDir(dir).sort(byCodepoint).flatMap((n) => {
      const path = join(dir, n);
      if (isDir(path)) return PACKAGE_EXCLUDES.includes(n as "assets") ? [] : scripts(path);
      return /\.(mjs|js)$/.test(n) && isFile(path) ? [path] : [];
    });
    for (const f of scripts(c.packEnv)) nodeCheck(f);
    const manifest = join(c.packEnv, "plugin.json");
    if (isFile(manifest) && readJson(manifest) === undefined) fail("JSON", manifest);
  }
  const pyFiles = [...globIn(c.kit, ".py"), ...globIn(join(c.kit, "panel"), ".py"),
    ...(c.packEnv ? [...globIn(c.packEnv, ".py"), ...globIn(join(c.packEnv, "panel"), ".py")] : [])];
  for (const f of pyFiles) fail("PY", `${f} (contrato core >=5: o painel do plugin é panel/api.ts)`);
  // projetos (reference/projects.md): testes compilam, perfis/stacks válidos, regressão do núcleo e a de cada pacote
  const testDir = join(c.skill, "loop", "test");
  for (const f of [...globIn(testDir, ".sh"), ...listDir(join(testDir, "stubs")).sort(byCodepoint).map((n) => join(testDir, "stubs", n))]) {
    // stub em bun (shebang bun) não é bash: só os de bash passam por bash -n
    if (isFile(f) && !firstLine(f).includes("bun")) bashN(f);
  }
  const fixtures = join(testDir, "fixtures");
  const validate = (files: string[]): void => {
    for (const f of files) {
      const errors = validateFile(f);
      if (errors.length) {
        out(`✗  ${f}`);
        for (const e of errors) out(`     ${e}`);
        bad = true;
      }
    }
  };
  validate([...globDeep(join(fixtures, "packs"), "profile.json"), ...globDeep(join(fixtures, "packs-alt"), "profile.json"), ...globDeep(join(fixtures, "stacks"), "stack.json")]);
  validate(installedFiles());
  if (!nameGuard(c, c.skill)) bad = true;
  if (!domainGuard(c, c.skill)) bad = true;
  if (!forbiddenRepoGuard(c.skill)) bad = true;
  if (!secretScan(c)) bad = true;
  for (const f of ["SKILL.md", "VERSION", "CHANGELOG.md", "reference/evolving.md", "kit/install.sh", "kit/env.template.sh"]) {
    if (!isFile(join(c.skill, f))) {
      out(`falta ${f}`);
      bad = true;
    }
  }
  // instalação numa pasta descartável: o install.sh tem de rodar do zero sem tocar o Hades vivo
  const tmp = mkdtempSync(join(tmpdir(), "skill-release-"));
  const install = spawnSync("bash", [join(c.kit, "install.sh")], {
    encoding: "utf8", env: { ...process.env, HADES_WT: c.wt, HADES_DATA: join(tmp, "data"), SKIP_SYSTEMD: "1", SKIP_WORKTREE: "1" },
  });
  if (install.status === 0) {
    for (const s of ["prs.sh", "tunnel.sh", "env.sh", ...pluginList("installed", c.packEnv)]) {
      if (!existsSync(join(tmp, "data", s))) {
        out(`install descartável sem ${s}`);
        bad = true;
      }
    }
  } else {
    out("install descartável falhou:");
    for (const l of `${install.stdout ?? ""}${install.stderr ?? ""}`.split("\n").filter(Boolean).slice(-5)) out(l);
    bad = true;
  }
  rmSync(tmp, { recursive: true, force: true });
  // a regressão é o passo caro (minutos): só depois das guardas e da varredura de segredos, e nem roda se uma delas já reprovou
  if (bad) out("regressão: não rodou — as checagens acima já reprovaram");
  else if (!regression(c, forceRegression)) bad = true;
  out(bad ? "check: FALHOU" : "check: ok");
  const uxReminder = bad ? undefined : uxAuditReminder();
  if (uxReminder) out(uxReminder);
  return !bad;
}

// ------------------------------------------------------------------ release

function addChangelogEntry(file: string, version: string, summary: string): void {
  const text = readFileSync(file, "utf8");
  const cut = text.indexOf("\n## ");
  const head = cut < 0 ? text : text.slice(0, cut);
  const rest = cut < 0 ? "" : text.slice(cut + 4);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const entry = `\n## ${version} — ${today}\n\n- ${summary}\n`;
  writeFileSync(file, head.replace(/\n+$/, "") + "\n" + entry + (cut >= 0 ? `\n## ${rest}` : ""));
}

async function release(c: Context, argv: string[]): Promise<number> {
  const args = [...argv];
  const level = args.shift() ?? "";
  let summary = "";
  if (args.length && !args[0]?.startsWith("--")) summary = args.shift() as string;
  let outDir = join(hadesHome(), "releases");
  let plan = "";
  while (args.length) {
    const flag = args.shift() as string;
    if (flag === "--out" || flag === "--plano") {
      const value = args.shift();
      if (value === undefined) {
        out(`${flag === "--out" ? "--out <dir>" : "--plano <plan.json>"}`);
        return EXIT.usage;
      }
      if (flag === "--out") outDir = value;
      else plan = value;
    } else {
      out(`release: opção desconhecida: ${flag}`);
      return EXIT.usage;
    }
  }
  if (!plan) {
    // o plano da skill tem raiz própria (hades agent plan-approve rodado do repo da skill); o plan.json mais novo de
    // outro projeto não vale: seria o plano errado barrando (ou liberando) a release
    const wr = process.env.HADES_WORK_ROOT || firstLine(join(hadesHome(), "work-root"));
    const candidate = join(wr || join(hadesHome(), "work"), "_skill", "orchestration", "plan.json");
    if (isFile(candidate)) plan = candidate;
    out(`plano para o Cerberus: ${plan || "nenhum plano da skill aprovado (plan-approve no repo da skill)"} (--plano escolhe outro)`);
  }
  const current = (readText(join(c.skill, "VERSION")) ?? "").split("\n", 1)[0] ?? "";
  const changelog = join(c.skill, "CHANGELOG.md");
  if (level === "same") {
    // a versão já foi subida (consolidação): nada de bump, e a entrada dela no CHANGELOG é pré-requisito (antes do check, que é caro)
    if (!new RegExp(`^## ${current.replace(/[.]/g, "\\.")}\\b`, "m").test(readText(changelog) ?? "")) {
      out(`release same: falta a entrada '## ${current}' no CHANGELOG.md — escreva-a e rode de novo`);
      return EXIT.fail;
    }
  } else if (!/^(major|minor|patch)$/.test(level) || !summary) {
    out('uso: skill-release.sh release <major|minor|patch> "<resumo>" | same [--out <dir>]');
    return EXIT.usage;
  }
  mkdirSync(outDir, { recursive: true });
  if (!drift(c)) {
    out("release abortado: há drift entre $D e o kit");
    return EXIT.fail;
  }
  if (!check(c, false)) {
    out("release abortado: check falhou");
    return EXIT.fail;
  }
  // Cerberus: o release é momento de fronteira (Porta); barra aborta antes do bump
  const range = releaseRange(c.skill, level === "same");
  const verdict = await cerberusCommand(["avaliar", "release", "--dir", c.skill, "--ctx", `versao=${current}`, "--ctx", `nivel=${level}`,
    ...(plan ? ["--ctx", `plano=${plan}`] : []), ...(range ? ["--ctx", `range=${range}`] : [])]);
  if (verdict !== 0) {
    out("release abortado: o Cerberus barrou (acima)");
    return EXIT.fail;
  }
  const [ma = 0, mi = 0, pa = 0] = current.split(".").map(Number);
  const next = level === "major" ? `${ma + 1}.0.0` : level === "minor" ? `${ma}.${mi + 1}.0` : level === "patch" ? `${ma}.${mi}.${pa + 1}` : current;
  if (!new RegExp(`^## ${next.replace(/[.]/g, "\\.")}`, "m").test(readText(changelog) ?? "")) {
    addChangelogEntry(changelog, next, summary);
    out(`CHANGELOG: entrada ${next} criada só com o resumo — detalhe o que mudou, por quê e as armadilhas medidas, depois rode release same para reempacotar`);
  }
  writeFileSync(join(c.skill, "VERSION"), `${next}\n`);
  const tgz = join(outDir, `hades-skill-v${next}.tar.gz`);
  spawnSync("tar", ["-czf", tgz, "--exclude=.git", "--exclude=.design-sync-reports", "--exclude=__pycache__", "-C", dirname(c.skill), basename(c.skill)], { stdio: "inherit" });
  const size = run("du", ["-h", tgz]).stdout.split("\t", 1)[0];
  const entries = run("tar", ["-tzf", tgz]).stdout.split("\n").filter((l) => l !== "").length;
  out(`versão ${current} → ${next}`);
  out(`pacote: ${tgz} (${size}, ${entries} entradas)`);
  out(`sha256: ${createHash("sha256").update(readFileSync(tgz)).digest("hex")}`);
  out(`lembrete: reinstalar no Hades vivo (HADES_WT=${c.wt} ${join(c.kit, "install.sh")}) e apagar pacotes de versões anteriores se o dono pedir`);
  return EXIT.ok;
}

export async function skillReleaseCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? "";
  const kit = kitDir();
  const skill = resolve(kit, "..");
  // sem ambiente instalado só o `guard` roda: ele não lê nada de $D
  const c = sub === "guard" ? { kit, skill, data: "", wt: "", packEnv: "", packAll: "" } : context();
  if (!c) {
    out("ambiente da Hades não encontrado: defina HADES_DATA ou rode o kit/install.sh");
    return EXIT.usage;
  }
  switch (sub) {
    case "drift":
      return drift(c) ? EXIT.ok : EXIT.fail;
    case "check": {
      process.env.CERBERUS_CMD = "check";
      const force = args.slice(1).includes("--regressao");
      return check(c, force) ? EXIT.ok : EXIT.fail;
    }
    case "guard": {
      const root = args[1] || skill;
      const name = nameGuard(c, root);
      const domain = domainGuard(c, root);
      const repos = forbiddenRepoGuard(root);
      return name && domain && repos ? EXIT.ok : EXIT.fail;
    }
    case "release":
      process.env.CERBERUS_CMD = "release";
      return release(c, args.slice(1));
    default:
      out(USAGE_LINES.join("\n"));
      return EXIT.usage;
  }
}
