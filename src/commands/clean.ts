// Rotação de logs e limpeza de disco do Hades (kit/clean.sh). Política nas Configurações → Limpeza (HADES_CLEAN_*).
// Categoria nova: uma entrada em CATEGORIES (size, list, clean) e o modo (safe|confirm|info); o painel e o status leem a
// lista daqui. Nunca docker system prune nem nada fora do projeto docker da instância ($HPROJ).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { effectiveConfig, instanceId, readEnvSh } from "../lib/config.ts";
import { detect, loadRegistry, need } from "../lib/deps.ts";
import { tryFlockForProcess } from "../lib/flock.ts";
import { isDir, listDir, readText } from "../lib/fs.ts";
import { git, stateDir } from "../lib/kit.ts";
import { EXIT, out } from "../lib/output.ts";
import { journalFiles, journalWorkRoot, pruneJournals } from "../lib/journal.ts";
import { parseEverySeconds } from "../lib/launchd-plist.ts";
import { home } from "../lib/paths.ts";
import { serviceManager } from "../lib/service-manager.ts";
import { ListFailedError } from "../lib/service-manager-ctl.ts";
import { run } from "../lib/proc.ts";

export const USAGE = `Rotação de logs e limpeza de disco do Hades. Política nas Configurações → Limpeza (HADES_CLEAN_*).
Uso: clean.sh status [--tsv]                  tamanho e o que dá para liberar, por categoria
     clean.sh list <categoria>                o que a categoria apagaria (item, bytes, nota)
     clean.sh run [--dry-run] [--quiet] [--yes <categoria>]...
                                              seguro (logs, panel-jobs, panel-cache, journal) pela política; o que apaga
                                              artefato (images, releases, worktrees) só lista até receber --yes
     clean.sh yes <categoria>                 limpa só uma categoria que apaga artefato (o botão do painel)
     clean.sh rotate [--dry-run]              só a rotação dos logs (hades logrotate)
     clean.sh apply                           instala/ajusta o timer do usuário $HU-logrotate (HADES_CLEAN_TIMER/EVERY)
Categoria nova: as funções size_<cat>, list_<cat>, clean_<cat> e uma linha em SAFE ou CONFIRM; o painel e o`;

const DEFAULT_JOURNAL_DAYS = 14;
const SAFE = ["logs", "panel-jobs", "panel-cache", "journal"];
const CONFIRM = ["images", "releases", "worktrees"];
const INFO = ["dist"];
const ALL = [...SAFE, ...CONFIRM, ...INFO];
const LABELS: Record<string, string> = {
  logs: "Logs",
  "panel-jobs": "Execuções do painel",
  "panel-cache": "Cache do painel",
  journal: "Diário de eventos dos agentes",
  dist: "Build dos serviços (dist)",
  images: "Imagens docker sem uso",
  releases: "Pacotes de release",
  worktrees: "Worktrees de agente (PR fechada)",
};
const SECONDS_PER_DAY = 86400;
const MS_PER_DAY = SECONDS_PER_DAY * 1000;
const MEMO_HASH_CHARS = 12;
const UNIT_LAST_RUN_FALLBACK = "-";
const HS_UNITS = ["B", "KB", "MB", "GB"];
const KIB = 1024;

interface Size {
  bytes: number;
  reclaim: number;
  items: number;
  detail: string;
}

interface Item {
  name: string;
  bytes: number;
  note: string;
}

interface Ctx {
  d: string;
  w: string;
  locks: string;
  hu: string;
  hproj: string;
  hadesId: string;
  jobs: string;
  cache: string;
  cfg: (name: string) => string;
  num: (name: string) => number;
}

function context(): Ctx {
  const d = stateDir();
  const envSh = readEnvSh(d);
  const hadesId = process.env.HADES_ID ?? instanceId(d);
  const catalog = effectiveConfig(d);
  const cfg = (name: string): string => process.env[name] ?? catalog.get(name) ?? "";
  return {
    d,
    w: process.env.HADES_WT || envSh.get("W") || "",
    locks: envSh.get("LOCKS") ?? process.env.LOCKS ?? "",
    hu: process.env.HU || `hds${hadesId ? `_${hadesId}` : ""}`,
    hproj: process.env.HPROJ || `hades${hadesId ? `_${hadesId}` : ""}`,
    hadesId,
    jobs: join(d, "logs", "panel-jobs"),
    cache: join(d, "logs", "panel-cache"),
    cfg,
    num: (name) => Number(cfg(name)),
  };
}

/** Tamanho legível como o awk do original: B inteiro, o resto com uma casa (meio exato vai para o par, como o printf em C). */
export function humanSize(bytes: number): string {
  let value = bytes;
  let i = 0;
  while (value >= KIB && i < HS_UNITS.length - 1) {
    value /= KIB;
    i++;
  }
  if (i === 0) return `${Math.trunc(value)} B`;
  const tenths = Math.floor(value * 10);
  const tie = Number.isInteger(value * 20) && (value * 20) % 2 === 1;
  const rounded = tie ? (tenths % 2 === 0 ? tenths : tenths + 1) : Math.round(value * 10);
  return `${Math.floor(rounded / 10)}.${rounded % 10} ${HS_UNITS[i]}`;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sizeOfFile(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

const sumFiles = (paths: string[]): number => paths.reduce((sum, p) => sum + sizeOfFile(p), 0);

/** `find <dir> -type f` (recursivo, sem seguir link): os arquivos regulares. */
function findFiles(dir: string, maxDepth = Infinity): string[] {
  const found: string[] = [];
  const walk = (current: string, depth: number): void => {
    for (const name of listDir(current)) {
      const path = join(current, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isFile()) found.push(path);
      else if (st.isDirectory() && depth < maxDepth) walk(path, depth + 1);
    }
  };
  walk(dir, 1);
  return found;
}

/** `du -sb` do sistema (o que o original chamava: o tamanho aparente muda com a versão do coreutils); undefined se falha. */
function duBytes(root: string): number | undefined {
  const bytes = Number(run("du", ["-sb", root]).stdout.split("\t", 1)[0]);
  return Number.isFinite(bytes) && existsSync(root) ? bytes : undefined;
}

function systemctlUser(args: string[], stdout: "pipe" | "inherit" = "pipe"): { ok: boolean; stdout: string } {
  const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", stdout, "ignore"] });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").replace(/\n+$/, "") };
}

function hadesCli(args: string[], capture: boolean, d: string): { status: number; stdout: string } {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HADES_DATA: d },
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  });
  return { status: r.status ?? EXIT.fail, stdout: r.stdout ?? "" };
}

// ---- logs: copiar + truncar (`hades logrotate`) ----
interface RotateJson {
  actions: { file: string; bytes: number; action: string; why: string }[];
  skipped: { file: string; why: string }[];
  freed: number;
}

function rotateDryRun(c: Ctx): RotateJson | undefined {
  const r = hadesCli(["logrotate", "--dry-run", "--json"], true, c.d);
  if (r.status !== 0) return undefined;
  try {
    return JSON.parse(r.stdout) as RotateJson;
  } catch {
    return undefined;
  }
}

function sizeLogs(c: Ctx): Size {
  const logs = join(c.d, "logs");
  const rotate = rotateDryRun(c);
  const actions = rotate?.actions.length ?? 0;
  return {
    bytes: sumFiles(findFiles(logs, 1)),
    reclaim: rotate?.freed ?? 0,
    items: findFiles(logs, 1).filter((p) => p.endsWith(".log")).length,
    detail: `${actions} ação(ões) pela política`,
  };
}

function listLogs(c: Ctx): Item[] {
  const rotate = rotateDryRun(c);
  if (!rotate) return [];
  return [
    ...rotate.actions.map((a) => ({ name: a.file, bytes: a.bytes, note: `${a.action}: ${a.why}` })),
    ...rotate.skipped.map((s) => ({ name: s.file, bytes: 0, note: `pulado: ${s.why}` })),
  ];
}

function cleanLogs(c: Ctx): string {
  return hadesCli(["logrotate"], true, c.d).stdout;
}

// ---- panel-jobs: execuções do painel (.json/.log/.rc) por idade e quantidade ----
const jobUnit = (c: Ctx): string => process.env.HADES_JOB_UNIT || `${c.hu}-pjob`;

function jobCandidates(c: Ctx): string[] {
  if (!isDir(c.jobs)) return [];
  const unit = jobUnit(c);
  const keep = c.num("HADES_CLEAN_JOBS_KEEP");
  const maxDays = c.num("HADES_CLEAN_JOBS_DAYS");
  const now = Math.floor(Date.now() / 1000);
  const ids = listDir(c.jobs)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .sort(byCodePoint)
    .reverse();
  const picked: string[] = [];
  ids.forEach((id, index) => {
    // execução sem .rc ainda rodando (unit ativa): fica, qualquer que seja a idade
    if (!existsSync(join(c.jobs, `${id}.rc`)) && serviceManager().isActive(`${unit}-${id}`)) return;
    const age = Math.trunc((now - Math.floor(statSync(join(c.jobs, `${id}.json`)).mtimeMs / 1000)) / SECONDS_PER_DAY);
    if (index + 1 > keep || age > maxDays) picked.push(id);
  });
  return picked;
}

const jobFiles = (c: Ctx, id: string): string[] => findFiles(c.jobs).filter((p) => basename(p).startsWith(`${id}.`));

function sizePanelJobs(c: Ctx): Size {
  const ids = jobCandidates(c);
  return {
    bytes: sumFiles(findFiles(c.jobs)),
    reclaim: ids.reduce((sum, id) => sum + sumFiles(jobFiles(c, id)), 0),
    items: listDir(c.jobs).filter((n) => n.endsWith(".json")).length,
    detail: `${ids.length} execução(ões) fora da política (mais de ${c.cfg("HADES_CLEAN_JOBS_KEEP")} ou ${c.cfg("HADES_CLEAN_JOBS_DAYS")} dias)`,
  };
}

const listPanelJobs = (c: Ctx): Item[] => jobCandidates(c).map((id) => ({ name: id, bytes: sumFiles(jobFiles(c, id)), note: "execução" }));

/** No launchd o job que terminou deixa o plist (e o serviço carregado) para trás; o systemd recolhe sozinho. */
function collectFinishedJobUnits(c: Ctx): void {
  const manager = serviceManager();
  if (manager.kind !== "launchd") return;
  const prefix = `${jobUnit(c)}-`;
  try {
    manager.collectFinished(prefix, new Set(manager.listActive(prefix)));
  } catch (error) {
    // listagem que falhou não é conjunto vazio: nada é recolhido nesta limpeza
    if (!(error instanceof ListFailedError)) throw error;
  }
}

function cleanPanelJobs(c: Ctx): string {
  collectFinishedJobUnits(c);
  const ids = jobCandidates(c);
  for (const id of ids) for (const ext of ["json", "log", "rc"]) rmSync(join(c.jobs, `${id}.${ext}`), { force: true });
  return `panel-jobs: ${ids.length} execução(ões) removida(s)\n`;
}

// ---- panel-cache: o painel refaz ----
function cacheOld(c: Ctx): string[] {
  const days = c.num("HADES_CLEAN_CACHE_DAYS");
  const now = Date.now();
  return findFiles(c.cache).filter((p) => Math.floor((now - statSync(p).mtimeMs) / MS_PER_DAY) > days);
}

const sizePanelCache = (c: Ctx): Size => ({
  bytes: sumFiles(findFiles(c.cache)),
  reclaim: sumFiles(cacheOld(c)),
  items: findFiles(c.cache).length,
  detail: `arquivos com mais de ${c.cfg("HADES_CLEAN_CACHE_DAYS")} dia(s)`,
});

const listPanelCache = (c: Ctx): Item[] => cacheOld(c).map((p) => ({ name: p, bytes: sizeOfFile(p), note: "cache" }));

function cleanPanelCache(c: Ctx): string {
  const old = cacheOld(c);
  for (const p of old) rmSync(p, { force: true });
  return `panel-cache: ${old.length} arquivo(s) removido(s)\n`;
}

// ---- dist: só informa (apagar derruba os serviços até o próximo build) ----
const sizeDist = (c: Ctx): Size => ({
  bytes: duBytes(join(c.w, "dist")) ?? 0,
  reclaim: 0,
  items: listDir(join(c.w, "dist", "apps")).length,
  detail: "build dos serviços (recompila no update; não é limpo aqui)",
});

// ---- images: do projeto docker da instância ($HPROJ), sem container nenhum usando ----
const docker = (args: string[]): { status: number; stdout: string } => {
  const r = run("docker", args);
  return { status: r.status, stdout: r.stdout };
};

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** `docker inspect -f <fmt>` de cada argumento, um por chamada (o xargs -n1 do original): o que falha some. */
const inspectEach = (kind: "image" | "container", format: string, ids: string[]): string[] =>
  ids.flatMap((id) => {
    const r = docker([kind, "inspect", "-f", format, id]);
    return r.status === 0 ? [r.stdout.replace(/\n+$/, "")] : [];
  });

/** Imagens do projeto (rótulo compose ou do compose.yml) que nenhum container (nem parado) usa: ref e bytes. */
function imagesUnused(c: Ctx): { ref: string; bytes: number }[] {
  const dockerDep = loadRegistry().find((dep) => dep.id === "docker");
  if (!dockerDep || !detect(dockerDep).found || docker(["info"]).status !== 0) return [];
  const containers = words(docker(["container", "ls", "-aq"]).stdout);
  const used = new Set(
    containers.length ? docker(["inspect", "-f", "{{.Image}}", ...containers]).stdout.split("\n").filter(Boolean) : [],
  );
  const labelled = words(docker(["images", "--filter", `label=com.docker.compose.project=${c.hproj}`, "--format", "{{.ID}}"]).stdout);
  const composed = words(
    docker(["compose", "-p", c.hproj, "-f", join(c.d, "infra", "compose.yml"), "--env-file", join(c.d, "root.env"), "config", "--images"]).stdout,
  );
  const candidates = [...new Set([...labelled, ...inspectEach("image", "{{.Id}}", composed)])].sort(byCodePoint);
  const unused: { ref: string; bytes: number }[] = [];
  for (const id of candidates) {
    const full = docker(["image", "inspect", "-f", "{{.Id}}", id]);
    if (full.status !== 0 || used.has(full.stdout.replace(/\n+$/, ""))) continue;
    const ref = docker(["image", "inspect", "-f", "{{if .RepoTags}}{{index .RepoTags 0}}{{else}}{{.Id}}{{end}}", id]).stdout.replace(/\n+$/, "");
    const bytes = Number(docker(["image", "inspect", "-f", "{{.Size}}", id]).stdout.trim());
    unused.push({ ref, bytes: Number.isFinite(bytes) ? bytes : 0 });
  }
  return unused;
}

function sizeImages(c: Ctx): Size {
  const unused = imagesUnused(c);
  const bytes = unused.reduce((sum, i) => sum + i.bytes, 0);
  return { bytes, reclaim: bytes, items: unused.length, detail: `imagens do projeto ${c.hproj} sem container (camadas compartilhadas liberam menos)` };
}

const listImages = (c: Ctx): Item[] => imagesUnused(c).map((i) => ({ name: i.ref, bytes: i.bytes, note: "imagem sem container" }));

function cleanImages(c: Ctx): string {
  let removed = 0;
  let text = "";
  for (const { ref } of imagesUnused(c)) {
    if (ref && docker(["rmi", ref]).status === 0) removed++;
    else text += `não removida: ${ref}\n`;
  }
  return `${text}images: ${removed} removida(s)\n`;
}

// ---- releases: hades-skill-v*.tar.gz além dos mais novos ----
const RELEASE = /^hades-skill-v.*\.tar\.gz$/;

/** `sort -V`: trechos numéricos comparados como número, o resto como texto. */
export function versionCompare(a: string, b: string): number {
  const parts = (s: string): string[] => s.match(/\d+|\D+/g) ?? [];
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i] as string;
    const y = pb[i] as string;
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) return Number(x) - Number(y) || byCodePoint(x, y);
    return byCodePoint(x, y);
  }
  return pa.length - pb.length;
}

const releasesDir = (c: Ctx): string => c.cfg("HADES_CLEAN_RELEASES_DIR").replace(/^~/, home());
const releasesAll = (c: Ctx): string[] => listDir(releasesDir(c)).filter((n) => RELEASE.test(n) && existsSync(join(releasesDir(c), n)));

function releasesOld(c: Ctx): string[] {
  const sorted = releasesAll(c).sort(versionCompare);
  return sorted.slice(0, Math.max(0, sorted.length - c.num("HADES_CLEAN_RELEASES_KEEP"))).map((n) => join(releasesDir(c), n));
}

function sizeReleases(c: Ctx): Size {
  const old = releasesOld(c);
  return {
    bytes: sumFiles(releasesAll(c).map((n) => join(releasesDir(c), n))),
    reclaim: sumFiles(old),
    items: releasesAll(c).length,
    detail: `${old.length} pacote(s) além dos ${c.cfg("HADES_CLEAN_RELEASES_KEEP")} mais novos (só com pedido do dono)`,
  };
}

const listReleases = (c: Ctx): Item[] => releasesOld(c).map((p) => ({ name: basename(p), bytes: sizeOfFile(p), note: "pacote antigo" }));

function cleanReleases(c: Ctx): string {
  const old = releasesOld(c);
  for (const p of old) rmSync(p, { force: true });
  return `releases: ${old.length} pacote(s) removido(s)\n`;
}

// ---- worktrees de agente com PR fechada ou mergeada (registro do hades agent) ----
interface ClosedWorktree {
  worktree: string;
  pr: string;
  state: string;
  dirty: number;
}

function jsonField(value: unknown): string {
  return value === undefined || value === null || value === false ? "" : String(value);
}

function closedWorktrees(c: Ctx): ClosedWorktree[] {
  const agents = join(dirname(c.locks), "orchestration", "agents");
  mkdirSync(c.cache, { recursive: true });
  const closed: ClosedWorktree[] = [];
  for (const name of listDir(agents).filter((n) => n.endsWith(".json"))) {
    let record: { worktree?: unknown; pr?: unknown };
    try {
      record = JSON.parse(readFileSync(join(agents, name), "utf8")) as typeof record;
    } catch {
      continue;
    }
    const worktree = jsonField(record.worktree);
    const pr = jsonField(record.pr);
    if (!worktree || !pr || !isDir(worktree)) continue;
    const memo = join(c.cache, `pr-state-${createHash("md5").update(worktree).digest("hex").slice(0, MEMO_HASH_CHARS)}-${pr}`);
    let state = (readText(memo) ?? "").replace(/\n+$/, "");
    if (!state) {
      // só estado terminal fica em cache: PR aberta é reconferida
      state = run("gh", ["pr", "view", pr, "--json", "state", "-q", ".state"], { cwd: worktree }).stdout.replace(/\n+$/, "");
      if (state === "CLOSED" || state === "MERGED") writeFileSync(memo, state);
    }
    if (state !== "CLOSED" && state !== "MERGED") continue;
    const status = git(["-C", worktree, "status", "--porcelain"]).stdout;
    closed.push({ worktree, pr, state, dirty: status.split("\n").filter(Boolean).length });
  }
  return closed;
}

function sizeWorktrees(c: Ctx): Size {
  // com alterações locais não sai: não entra no que libera
  const clean = closedWorktrees(c).filter((w) => w.dirty === 0);
  const bytes = clean.reduce((sum, w) => sum + (duBytes(w.worktree) ?? 0), 0);
  return { bytes, reclaim: bytes, items: clean.length, detail: "worktree(s) de agente com PR fechada (as com alterações locais não saem)" };
}

const listWorktrees = (c: Ctx): Item[] =>
  closedWorktrees(c).map((w) => ({
    name: w.worktree,
    bytes: duBytes(w.worktree) ?? 0,
    note: `PR #${w.pr} ${w.state}${w.dirty !== 0 ? " · com alterações locais: fica" : ""}`,
  }));

function cleanWorktrees(c: Ctx): string {
  let removed = 0;
  let text = "";
  for (const w of closedWorktrees(c)) {
    if (w.dirty !== 0) {
      text += `fica (alterações locais): ${w.worktree}\n`;
      continue;
    }
    const common = git(["-C", w.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.replace(/\n+$/, "");
    const main = common.replace(/\/\.git$/, "");
    if (git(["-C", main, "worktree", "remove", w.worktree]).status === 0) removed++;
    else text += `não removida: ${w.worktree}\n`;
  }
  return `${text}worktrees: ${removed} removida(s) (as branches ficam)\n`;
}

// ---- timer do usuário ----
const unitName = (c: Ctx): string => process.env.CLEAN_UNIT || `${c.hu}-logrotate`;
const LAST_RUN_MARK = "logrotate.last";

const lastRunMark = (c: Ctx): string => join(c.d, "logs", LAST_RUN_MARK);

/** O launchd não guarda a última execução do timer: `clean.sh run` grava a marca (instante em UTC) e o status a lê. */
function writeLastRunMark(c: Ctx): void {
  mkdirSync(join(c.d, "logs"), { recursive: true });
  writeFileSync(lastRunMark(c), `${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}\n`);
}

/** Estado do timer e a última execução, como a linha "ativo|desligado<TAB>última" do original. */
function timerState(c: Ctx): { enabled: string; last: string } {
  const manager = serviceManager();
  const unit = unitName(c);
  const enabled = manager.timerEnabled(unit) ? "ativo" : "desligado";
  const last = manager.timerLastTrigger(unit) || (manager.kind === "launchd" ? (readText(lastRunMark(c)) ?? "").replace(/\n+$/, "") : "");
  return { enabled, last: last || UNIT_LAST_RUN_FALLBACK };
}

// ---- journal: diário de eventos por agente; a política é HADES_JOURNAL_DAYS (a rotação por tamanho é de quem grava) ----
const journalDays = (c: Ctx): number => c.num("HADES_JOURNAL_DAYS") || DEFAULT_JOURNAL_DAYS;

function sizeJournal(c: Ctx): Size {
  const root = journalWorkRoot();
  const plan = pruneJournals(journalDays(c), new Date(), root, true);
  const files = journalFiles(root, true).map((f) => f.file);
  return {
    bytes: sumFiles(files),
    reclaim: plan.bytes,
    items: files.length,
    detail: `${plan.removed} arquivo(s) parados e ${plan.rewritten} com linhas acima de ${journalDays(c)} dia(s)`,
  };
}

const listJournal = (c: Ctx): Item[] =>
  pruneJournals(journalDays(c), new Date(), journalWorkRoot(), true).items.map((i) => ({ name: i.file, bytes: i.bytes, note: i.action }));

function cleanJournal(c: Ctx): string {
  const done = pruneJournals(journalDays(c), new Date(), journalWorkRoot());
  return `journal: ${done.removed} arquivo(s) apagado(s), ${done.rewritten} reescrito(s)\n`;
}

function apply(c: Ctx): number {
  const manager = serviceManager();
  need(manager.requires);
  const unit = unitName(c);
  const suffix = c.hadesId ? ` ${c.hadesId}` : "";
  const every = c.cfg("HADES_CLEAN_EVERY");
  const everySec = parseEverySeconds(every);
  if (c.cfg("HADES_CLEAN_TIMER") !== "on" && everySec === undefined && manager.kind === "launchd") {
    // desarmar não depende do intervalo: um valor ilegível não pode impedir de desligar o timer
    manager.disarmTimer(unit);
    out(`timer ${unit} (a cada ${every}): ${timerState(c).enabled}`);
    return EXIT.ok;
  }
  const changed = manager.writeTimer({
    unit,
    description: `Hades${suffix}: rotação de logs e limpeza segura`,
    timerDescription: `Hades${suffix}: timer da rotação de logs`,
    env: [["PATH", process.env.PATH ?? ""], ["HADES_WT", c.w], ["HADES_DATA", c.d], ["HADES_ID", c.hadesId]],
    argv: ["/bin/bash", join(c.d, "clean.sh"), "run", "--quiet"],
    logFile: join(c.d, "logs", "logrotate.log"),
    every,
    everySec,
    background: true,
  });
  if (c.cfg("HADES_CLEAN_TIMER") === "on") manager.armTimer(unit, changed);
  else manager.disarmTimer(unit);
  out(`timer ${unit} (a cada ${every}): ${timerState(c).enabled}`);
  return EXIT.ok;
}

// ---- despacho ----
const modeOf = (cat: string): string => (SAFE.includes(cat) ? "seguro" : CONFIRM.includes(cat) ? "confirma" : "info");

const sizers: Record<string, (c: Ctx) => Size> = {
  logs: sizeLogs,
  "panel-jobs": sizePanelJobs,
  "panel-cache": sizePanelCache,
  journal: sizeJournal,
  dist: sizeDist,
  images: sizeImages,
  releases: sizeReleases,
  worktrees: sizeWorktrees,
};
const listers: Record<string, (c: Ctx) => Item[]> = {
  logs: listLogs,
  "panel-jobs": listPanelJobs,
  "panel-cache": listPanelCache,
  journal: listJournal,
  dist: () => [],
  images: listImages,
  releases: listReleases,
  worktrees: listWorktrees,
};
const cleaners: Record<string, (c: Ctx) => string> = {
  logs: cleanLogs,
  "panel-jobs": cleanPanelJobs,
  "panel-cache": cleanPanelCache,
  journal: cleanJournal,
  images: cleanImages,
  releases: cleanReleases,
  worktrees: cleanWorktrees,
};

/** Fim da execução do original: sai com o código e a mensagem que o `exit` do bash daria. */
class Exit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function needCategory(cat: string | undefined, argName = "categoria"): string {
  if (cat === undefined) {
    process.stderr.write(`clean.sh: ${argName}\n`);
    throw new Exit(EXIT.fail);
  }
  if (!ALL.includes(cat)) {
    out(`categoria desconhecida: ${cat} (${ALL.map((x) => `${x} `).join("")})`);
    throw new Exit(EXIT.usage);
  }
  return cat;
}

const confirmOnly = (cat: string, prefix: string): void => {
  if (CONFIRM.includes(cat)) return;
  out(`${prefix} vale só para: ${CONFIRM.join(" ")}`);
  throw new Exit(EXIT.usage);
};

function takeLock(c: Ctx): boolean {
  if (tryFlockForProcess(join(c.d, "clean.lock"))) return true;
  out("outra limpeza em andamento");
  return false;
}

// o printf do bash conta bytes na largura; o awk das linhas da simulação conta caracteres
const bytePad = (text: string, width: number): number => Math.max(0, width - Buffer.byteLength(text));
const padRight = (text: string, width: number): string => text.padEnd(width);
const padRightBytes = (text: string, width: number): string => `${text}${" ".repeat(bytePad(text, width))}`;
const padLeftBytes = (text: string, width: number): string => `${" ".repeat(bytePad(text, width))}${text}`;
const padLeft = (text: string, width: number): string => text.padStart(width);

function tsvItems(items: Item[]): string[] {
  return items.map((i) => `${i.name}\t${i.bytes}\t${i.note}`);
}

function simulate(c: Ctx, cat: string): void {
  out(`== ${cat} (simulação) ==`);
  for (const i of (listers[cat] as (c: Ctx) => Item[])(c)) out(`  ${padRight(i.name, 44)} ${padLeft(String(i.bytes), 10)}  ${i.note}`);
}

function status(c: Ctx, tsv: boolean): number {
  const timer = timerState(c);
  if (tsv) out(`@timer\t${timer.enabled}\t${timer.last}`);
  else {
    out(`timer ${unitName(c)}: ${timer.enabled} ${timer.last}`);
    out(`${padRightBytes("CATEGORIA", 34)} ${padLeftBytes("USO", 10)} ${padLeftBytes("LIBERA", 10)}  OBS`);
  }
  for (const cat of ALL) {
    const s = (sizers[cat] as (c: Ctx) => Size)(c);
    if (tsv) out(`${cat}\t${modeOf(cat)}\t${s.bytes}\t${s.reclaim}\t${s.items}\t${LABELS[cat]}\t${s.detail}`);
    else out(`${padRightBytes(LABELS[cat] as string, 34)} ${padLeftBytes(humanSize(s.bytes), 10)} ${padLeftBytes(humanSize(s.reclaim), 10)}  [${modeOf(cat)}] ${s.detail}`);
  }
  return EXIT.ok;
}

interface RunOptions {
  dry: boolean;
  quiet: boolean;
  yes: string[];
}

function parseRun(args: string[]): RunOptions {
  const options: RunOptions = { dry: false, quiet: false, yes: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--dry-run") options.dry = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--yes") {
      const cat = needCategory(args[++i], "--yes pede a categoria");
      confirmOnly(cat, "--yes");
      options.yes.push(cat);
    } else {
      out("uso: clean.sh run [--dry-run] [--quiet] [--yes images|releases|worktrees]");
      throw new Exit(EXIT.usage);
    }
  }
  return options;
}

/** `tail -1` da saída do clean_<cat> (o que o --quiet mostra); sem --quiet, ela inteira. */
function emitCleanOutput(text: string, quiet: boolean): void {
  if (!quiet) {
    process.stdout.write(text);
    return;
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const last = lines[lines.length - 1];
  if (last !== undefined) out(last);
}

function runClean(c: Ctx, args: string[]): number {
  const options = parseRun(args);
  if (!takeLock(c)) return EXIT.ok;
  for (const cat of SAFE) {
    if (options.dry) simulate(c, cat);
    else emitCleanOutput((cleaners[cat] as (c: Ctx) => string)(c), options.quiet);
  }
  for (const cat of CONFIRM) {
    if (options.yes.includes(cat)) {
      if (options.dry) simulate(c, cat);
      else process.stdout.write((cleaners[cat] as (c: Ctx) => string)(c));
      continue;
    }
    const s = (sizers[cat] as (c: Ctx) => Size)(c);
    if (s.reclaim > 0 && !options.quiet) out(`${cat}: ${humanSize(s.reclaim)} a liberar (${s.detail}). Para limpar: clean.sh run --yes ${cat}`);
  }
  if (!options.dry && serviceManager().kind === "launchd") writeLastRunMark(c);
  return EXIT.ok;
}

export function cleanCommand(args: string[]): number {
  const c = context();
  const [sub, ...rest] = args;
  try {
    switch (sub || "status") {
      case "status":
        return status(c, rest[0] === "--tsv");
      case "list": {
        const cat = needCategory(rest[0]);
        for (const line of tsvItems((listers[cat] as (c: Ctx) => Item[])(c))) out(line);
        return EXIT.ok;
      }
      case "yes": {
        const cat = needCategory(rest[0]);
        confirmOnly(cat, "yes");
        if (!takeLock(c)) return EXIT.ok;
        process.stdout.write((cleaners[cat] as (c: Ctx) => string)(c));
        return EXIT.ok;
      }
      case "rotate":
        return hadesCli(["logrotate", ...rest], false, c.d).status;
      case "apply":
        return apply(c);
      case "run":
        return runClean(c, rest);
      default:
        out(USAGE);
        return EXIT.usage;
    }
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  }
}
