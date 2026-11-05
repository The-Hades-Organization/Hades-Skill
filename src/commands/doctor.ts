// Diagnóstico do Hades (kit/doctor.sh): pré-requisitos, máquina, instalação e painel, uma linha por item (ok / aviso / erro +
// o comando que corrige). Só diagnostica: nunca altera nada. O doctor.sh do plugin do projeto é contrato público em bash
// (usa ok/warn/err/have, $G, $QUICK e o lib-checks.sh): roda num shim que grava os registros dele, juntados na ordem.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { herdrServerResponds } from "../lib/herdr.ts";
import { devtunnelLoggedIn, ghToken, lingering, unitIs } from "../lib/checks.ts";
import { claudeSettingsPath } from "../lib/autonomy.ts";
import { loadRegistry } from "../lib/deps.ts";
import { firstLine, isDir, isFile, listDir, readText, realpathMissingOk } from "../lib/fs.ts";
import { coletaLigada } from "../lib/limites-aviso.ts";
import { chaves, medidas } from "../lib/limites-io.ts";
import { stateDir } from "../lib/kit.ts";
import { EXIT, out, warn as warnErr } from "../lib/output.ts";
import { home, selfCli } from "../lib/paths.ts";
import { pyDumps } from "../lib/pyjson.ts";
import { LISTENERS_TOOL, listenersToolPresent, memTotalMb, run, tcpListeners, which, type Listener } from "../lib/proc.ts";
import { readEnvSh, unitPrefix } from "../lib/config.ts";
import { judgeSlice, showSlice } from "../lib/doctor-slice.ts";
import { belongsTo, otherInstances, type InstanceIdentity } from "../lib/doctor-instancias.ts";
import { serviceManager } from "../lib/service-manager.ts";
import { FILTERS_REL, planWorktree, policyAdvice, rtkBinary, rtkConfig, settingsFor, trustState } from "../lib/rtk-filters.ts";

export const HELP = `Diagnóstico do Hades: pré-requisitos, máquina, instalação e painel, uma linha por item (ok / aviso / erro + o comando
que corrige). Só diagnostica: nunca altera nada.
Uso: doctor.sh [--quick] [--json]
  --quick   só o que custa menos de ~2 s (sem consulta de rede nem de login); é o que o run-hades chama
  --json    saída para máquina em vez da tabela (contrato estável, ver reference/doctor.md)
Saída: 0 = tudo ok · 1 = há erro · 2 = só avisos.`;

const USAGE = "uso: doctor.sh [--quick] [--json]";
const SEP = "\x1f";
const QUICK_TIMEOUT_MS = 5000;
const GH_API_TIMEOUT_MS = 8000;
const VERSION_CHECK_TIMEOUT_MS = 30000;
const DEFAULT_PANEL_PORT = "21220";
const DEFAULT_WIDGET_PORT = "21221";
const MEMORY_WARN_PERCENT = 75;
const KIB_PER_GIB = 1048576;
const MIB_PER_UNIT: Record<string, number> = { "": 1 / 1048576, K: 1 / 1024, M: 1, G: 1024, T: 1048576 };
const HEALTH_EXIT = { ok: 0, error: 1, warn: 2 } as const;

type Level = "ok" | "warn" | "error";

interface Item {
  level: Level;
  group: string;
  id: string;
  msg: string;
  fix: string;
}

interface Ctx {
  quick: boolean;
  d: string;
  w: string;
  hu: string;
  hslice: string;
  hproj: string;
  here: string;
  sk: string;
}

const env = (key: string, fallback = ""): string => process.env[key] || fallback;
const chomp = (text: string): string => text.replace(/\n+$/, "");
const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
const has = (command: string): boolean => which(command) !== undefined;

/** `$(timeout 5 cmd 2>/dev/null || true)`: a saída sem o \n final, mesmo quando o comando sai com erro (is-enabled). */
function capture(command: string, args: string[]): string {
  return chomp(run(command, args, { timeoutMs: QUICK_TIMEOUT_MS }).stdout);
}

class Report {
  readonly items: Item[] = [];
  add(level: Level, group: string, id: string, msg: string, fix = ""): void {
    this.items.push({ level, group, id, msg, fix });
  }
  ok(group: string, id: string, msg: string): void {
    this.add("ok", group, id, msg);
  }
  warn(group: string, id: string, msg: string, fix: string): void {
    this.add("warn", group, id, msg, fix);
  }
  err(group: string, id: string, msg: string, fix: string): void {
    this.add("error", group, id, msg, fix);
  }
}

/** Docker só é exigência onde há ambiente de pacote ($D/plugin); sem ele, a CLI e o painel funcionam e a falta é aviso. */
function checkDocker(r: Report, needed: boolean): void {
  const g = "Ferramentas";
  const fail = needed ? r.err.bind(r) : r.warn.bind(r);
  if (!has("docker")) return fail(g, "docker", "docker não encontrado", "instale o Docker Engine e o plugin compose (pacote docker + docker-compose)");
  const info = run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: QUICK_TIMEOUT_MS });
  const dv = chomp(info.stdout);
  if (info.status !== 0 || !dv) {
    return fail(g, "docker", "o daemon do docker não responde (ou sem permissão)", "sudo systemctl enable --now docker && sudo usermod -aG docker $USER (depois re-logue)");
  }
  const cv = capture("docker", ["compose", "version", "--short"]);
  const bare = cv.replace(/^v/, "");
  if (/^[2-9]\./.test(bare)) r.ok(g, "docker", `docker ${dv}, compose v${bare}`);
  else fail(g, "docker", `docker ${dv}, mas sem compose v2 (${cv || "ausente"})`, "instale o plugin docker-compose v2");
}

function checkGh(r: Report, quick: boolean): void {
  const g = "Ferramentas";
  if (!has("gh")) return r.err(g, "gh", "gh não encontrado", "instale o GitHub CLI e rode: gh auth login");
  const user = env("HADES_GH_USER");
  const tok = ghToken();
  const who = user ? `conta ${user}` : "conta ativa";
  if (!tok) {
    if (user) r.err(g, "gh", `${who} não está logada no gh`, `gh auth login (com a conta ${user}) ou ajuste HADES_GH_USER em Configurações`);
    else r.err(g, "gh", "gh sem login", "gh auth login");
    return;
  }
  const api = quick ? undefined : spawnSync("gh", ["api", "user", "-q", ".login"], { env: { ...process.env, GH_TOKEN: tok }, timeout: GH_API_TIMEOUT_MS, stdio: "ignore" });
  if (api && api.status !== 0) r.warn(g, "gh", `${who} tem token, mas a API do GitHub não respondeu (rede ou token vencido)`, "gh auth refresh (ou gh auth login)");
  else r.ok(g, "gh", `gh logado (${who})`);
}

function checkDevtunnel(r: Report, quick: boolean): void {
  const g = "Ferramentas";
  if (!has("devtunnel")) return r.warn(g, "devtunnel", "devtunnel não encontrado (só o túnel público depende dele)", "instale o devtunnel e rode: devtunnel user login -g -d");
  if (!quick && !devtunnelLoggedIn()) {
    return r.warn(g, "devtunnel", "devtunnel instalado, sem login (só o túnel público depende dele)", "devtunnel user login -g -d");
  }
  r.ok(g, "devtunnel", "devtunnel disponível");
}

function checkNode(r: Report, w: string): void {
  const g = "Ferramentas";
  const want = (readText(join(w, ".nvmrc")) ?? "").replace(/[v \n\r]/g, "");
  if (!has("node")) return r.err(g, "node", "node não encontrado no PATH", `nvm install ${want || "<versão do .nvmrc>"} (e atualize NODE_BIN no env.sh)`);
  const nv = capture("node", ["--version"]).replace(/^v/, "");
  if (want && /^[0-9]/.test(want) && want.split(".")[0] !== nv.split(".")[0]) {
    return r.err(g, "node", `node ${nv}, mas o worktree pede ${want} (.nvmrc)`, `nvm install ${want} && nvm use ${want} (e atualize NODE_BIN no env.sh)`);
  }
  r.ok(g, "node", `node ${nv}${want ? ` (.nvmrc ${want})` : ""}`);
}

function checkTools(r: Report, ctx: Ctx): void {
  const g = "Ferramentas";
  checkDocker(r, isDir(join(ctx.d, "plugin")));
  checkGh(r, ctx.quick);
  checkDevtunnel(r, ctx.quick);
  checkNode(r, ctx.w);
  for (const tool of ["jq", "unzip"]) {
    if (has(tool)) r.ok(g, tool, `${tool} disponível`);
    else r.err(g, tool, `${tool} não encontrado`, `instale o pacote ${tool}`);
  }
  checkServiceManager(r);
  checkRegistry(r, ctx);
}

/** Domínio do launchd que o Hades usa: gui/<uid> com sessão gráfica, senão user/<uid> (ssh, sem login). */
function checkLaunchdSession(r: Report): void {
  const g = "Ferramentas";
  const uid = process.getuid?.() ?? 0;
  for (const domain of [`gui/${uid}`, `user/${uid}`]) {
    if (run("launchctl", ["print", domain], { timeoutMs: QUICK_TIMEOUT_MS }).status === 0) return r.ok(g, "launchd", `launchd do usuário (${domain})`);
  }
  r.warn(g, "launchd", "launchd do usuário indisponível (sem domínio gui/ nem user/)", "abra uma sessão de usuário no macOS (login gráfico) e rode de novo");
}

function checkServiceManager(r: Report): void {
  if (serviceManager().kind === "launchd") return checkLaunchdSession(r);
  const g = "Ferramentas";
  const state = capture("systemctl", ["--user", "is-system-running"]);
  if (["running", "degraded", "starting"].includes(state)) r.ok(g, "systemd", `systemd do usuário (${state})`);
  else r.warn(g, "systemd", `systemd do usuário indisponível (${state || "sem resposta"})`, "precisa de sessão de usuário com systemd (loginctl enable-linger $USER e re-login)");
}

/** As dependências do registro que o doctor não checa acima (doctor=registry): a mesma fonte do `hades deps` e do painel. */
function checkRegistry(r: Report, ctx: Ctx): void {
  const g = "Ferramentas";
  const root = isFile(`${ctx.here}/../src/deps/registry.tsv`) ? `${ctx.here}/..` : env("HADES_SKILL_DIR", join(home(), ".claude", "skills", "hades"));
  const file = `${root}/src/deps/registry.tsv`;
  if (!isFile(file)) return r.warn(g, "dependencias", `registro de dependências não encontrado em ${file}`, `HADES_WT=${ctx.w} <skill>/kit/install.sh`);
  for (const dep of loadRegistry(file)) {
    if (dep.doctor !== "registry") continue;
    let bin = which(dep.command);
    const bunHome = join(home(), ".bun", "bin", "bun");
    if (!bin && dep.id === "bun" && existsSync(bunHome)) bin = bunHome;
    if (bin) {
      const first = capture(bin, dep.versionArgs).split("\n")[0] ?? "";
      r.ok(g, dep.id, `${dep.id} ${first}`);
    } else if (dep.level === "error") r.err(g, dep.id, `${dep.id} não encontrado`, dep.install);
    else r.warn(g, dep.id, `${dep.id} não encontrado`, dep.install);
  }
}

/** Portas publicadas por containers do projeto: o docker-proxy é do root e não aparece no ss. */
function dockerPorts(hproj: string): Set<number> {
  const mine = new Set<number>();
  if (!has("docker")) return mine;
  const ports = capture("docker", ["ps", "--filter", `label=com.docker.compose.project=${hproj}`, "--format", "{{.Ports}}"]);
  for (const m of ports.matchAll(/:([0-9]+)->/g)) mine.add(Number(m[1]));
  return mine;
}

/** Portas que o ambiente precisa: painel, widget, HADES_PORTS_REQUIRED e as do services.tsv. */
function neededPorts(d: string): Set<number> {
  const need = new Set<number>([Number(env("HADES_PANEL_PORT", DEFAULT_PANEL_PORT)), Number(env("HADES_WIDGET_PORT", DEFAULT_WIDGET_PORT))]);
  for (const p of words(env("HADES_PORTS_REQUIRED").replaceAll(",", " "))) if (/^[0-9]{1,5}$/.test(p)) need.add(Number(p));
  for (const line of (readText(join(d, "services.tsv")) ?? "").split("\n")) {
    if (line.startsWith("#")) continue;
    const port = line.split("\t")[1];
    if (port !== undefined && /^[0-9]+$/.test(port)) need.add(Number(port));
  }
  return need;
}

/** Porta ocupada por quem é do Hades desta máquina: desta instância ou de outra registrada (belongsTo). */
function isHadesProcess(pid: string, ctx: Ctx, others: InstanceIdentity[]): boolean {
  return belongsTo(pid, { d: ctx.d, hu: ctx.hu, hslice: ctx.hslice }) || others.some((other) => belongsTo(pid, other));
}

interface ForeignPorts {
  foreign: string[];
  neededHit: number[];
}

function scanPorts(ctx: Ctx, listeners: Listener[], mine: Set<number>, need: Set<number>, lo: number, hi: number): ForeignPorts {
  const seen = new Set<number>();
  const others = otherInstances(ctx.d);
  const found: ForeignPorts = { foreign: [], neededHit: [] };
  for (const { port, pid, name } of listeners) {
    if (!((port >= lo && port <= hi) || need.has(port))) continue;
    if (mine.has(port) || seen.has(port)) continue;
    seen.add(port);
    if (isHadesProcess(pid, ctx, others)) continue;
    found.foreign.push(`${port}(${name || "outro usuário"})`);
    if (need.has(port)) found.neededHit.push(port);
  }
  return found;
}

/** Outra rede docker ocupando a sub-rede fixa do projeto (HADES_DOCTOR_SUBNET) impede a infra de subir. */
function checkSubnet(r: Report, hproj: string): void {
  const g = "Máquina";
  const subnet = env("HADES_DOCTOR_SUBNET");
  if (!subnet) return;
  const ids = words(run("docker", ["network", "ls", "-q"]).stdout);
  const lines = ids.length ? run("docker", ["network", "inspect", "-f", "{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}", ...ids]).stdout.split("\n") : [];
  const own = `${hproj}_default`;
  const net = lines.map(words).find(([name, sub]) => sub === subnet && name !== own)?.[0];
  if (net) r.err(g, "rede", `a rede docker '${net}' ocupa ${subnet}, a sub-rede do Hades`, `veja se está em uso (docker network inspect ${net}) e, vazia, remova: docker network rm ${net}`);
  else r.ok(g, "rede", `sub-rede ${subnet} livre para o Hades`);
}

/** Comando que mostra quem escuta na porta: o `ss` no Linux; no macOS o `lsof` com sudo, que sem root não vê o processo de outro usuário. */
function ownerCommand(port: string): string {
  return LISTENERS_TOOL === "ss" ? `ss -ltnp 'sport = :${port}'` : `sudo lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

function checkPorts(r: Report, ctx: Ctx): void {
  const g = "Máquina";
  if (!listenersToolPresent()) {
    return r.warn(g, "portas", `${LISTENERS_TOOL} não encontrado, portas não verificadas`, LISTENERS_TOOL === "ss" ? "instale o pacote iproute2" : "o netstat vem com o sistema, em /usr/sbin/netstat");
  }
  const listeners = tcpListeners();
  if (listeners === undefined) {
    r.warn(g, "portas", `o ${LISTENERS_TOOL} falhou ou não respondeu, portas não verificadas`, "rode o doctor de novo");
    return checkSubnet(r, ctx.hproj);
  }
  const range = /^([0-9]{1,5})-([0-9]{1,5})$/.exec(env("HADES_PORT_RANGE"));
  const [lo, hi] = range ? [Number(range[1]), Number(range[2])] : [0, -1];
  const scope = hi >= lo ? `faixa ${lo}–${hi}` : "portas do Hades";
  const { foreign, neededHit } = scanPorts(ctx, listeners, dockerPorts(ctx.hproj), neededPorts(ctx.d), lo, hi);
  if (neededHit.length) {
    r.err(g, "portas", `porta(s) do Hades ocupada(s) por outro processo: ${foreign.join(" ")}`, `descubra o dono com: ${ownerCommand(String(neededHit[0]))} e pare esse processo`);
  } else if (foreign.length) {
    r.warn(g, "portas", `${scope} com portas de fora do Hades: ${foreign.join(" ")}`, `se algum serviço do Hades não subir, veja o dono com: ${ownerCommand("<porta>")}`);
  } else r.ok(g, "portas", `${scope} sem conflito`);
  checkSubnet(r, ctx.hproj);
}

/** HADES_SLICE_MAX em MiB (`\d+[KMGT]?`); 0 quando não casa. */
export function sliceMaxMib(text: string): number {
  const m = /^([0-9]+)([KMGT]?)$/.exec(text.toUpperCase());
  return m ? Math.trunc(Number(m[1]) * (MIB_PER_UNIT[m[2] as string] as number)) : 0;
}

function checkMemory(r: Report, d: string): void {
  const g = "Máquina";
  const max = env("HADES_SLICE_MAX");
  const totMb = memTotalMb();
  const capMb = sliceMaxMib(max || "0");
  const fix = `reduza o teto: ${d}/config.sh set HADES_SLICE_MAX=<valor> && ${d}/config.sh apply-slice`;
  if (totMb === 0 || capMb === 0) r.warn(g, "memoria", `não consegui comparar a memória com HADES_SLICE_MAX (${max || "vazio"})`, "confira HADES_SLICE_MAX em Configurações");
  else if (capMb > totMb) r.err(g, "memoria", `HADES_SLICE_MAX (${max}) passa da RAM da máquina (${totMb}M)`, fix);
  else if (capMb * 100 > totMb * MEMORY_WARN_PERCENT) r.warn(g, "memoria", `HADES_SLICE_MAX (${max}) é mais de ${MEMORY_WARN_PERCENT}% da RAM (${totMb}M); sobra pouco para o sistema`, fix);
  else r.ok(g, "memoria", `RAM ${totMb}M, teto do Hades ${max}`);
}

function checkDisk(r: Report, id: string, path: string, label: string): void {
  const g = "Máquina";
  if (!isDir(path)) return r.warn(g, id, `${label}: ${path} não existe, disco não verificado`, "");
  const row = run("df", ["-Pk", path]).stdout.split("\n")[1];
  const free = row ? Math.trunc(Number(words(row)[3]) / KIB_PER_GIB) : Number.NaN;
  const min = Number(env("HADES_DOCTOR_DISK_MIN_GB"));
  const low = Number(env("HADES_DOCTOR_DISK_WARN_GB"));
  const fix = "libere espaço: docker system prune, node_modules e dist antigos";
  if (Number.isNaN(free)) r.warn(g, id, `${label}: não consegui ler o disco de ${path}`, "");
  else if (free < min) r.err(g, id, `${label}: só ${free} GB livres (mínimo ${min} GB)`, fix);
  else if (free < low) r.warn(g, id, `${label}: ${free} GB livres (aviso abaixo de ${low} GB)`, fix);
  else r.ok(g, id, `${label}: ${free} GB livres`);
}

function checkMachine(r: Report, ctx: Ctx): void {
  checkPorts(r, ctx);
  checkMemory(r, ctx.d);
  checkDisk(r, "disco-dados", ctx.d, "disco de dados");
  checkDisk(r, "disco-worktree", ctx.w, "disco do worktree");
}

function checkInstance(r: Report, ctx: Ctx): void {
  const g = "Instalação";
  const instance = firstLine(join(home(), ".claude", "hades", "instance"));
  const real = (path: string): string => realpathMissingOk(path);
  const regDir = join(home(), ".claude", "hades", "instances");
  const mineReg = listDir(regDir).find((name) => isFile(join(regDir, name)) && real(firstLine(join(regDir, name))) === real(ctx.d));
  if (!instance) r.err(g, "instance", "~/.claude/hades/instance ausente", "HADES_WT=<worktree> <skill>/kit/install.sh (o /hades env up e o skill-release acham o ambiente por ele)");
  else if (!isFile(join(instance, "env.sh"))) r.err(g, "instance", `instance aponta para ${instance}, que não tem env.sh`, "rode o kit/install.sh de novo ou corrija ~/.claude/hades/instance");
  else if (real(instance) === real(ctx.d)) r.ok(g, "instance", `instance → ${ctx.d}${mineReg ? ` (projeto ${mineReg})` : ""}`);
  else if (mineReg) r.ok(g, "instance", `instances/${mineReg} → ${ctx.d} (a padrão da máquina é ${instance})`);
  else r.warn(g, "instance", `instance aponta para ${instance} e nenhum instances/<projeto> aponta para ${ctx.d}; este diagnóstico é de ${ctx.d}`, `reinstale: HADES_WT=${ctx.w} <skill>/kit/install.sh (grava instances/<projeto>)`);
}

function checkWorktree(r: Report, ctx: Ctx): void {
  const g = "Instalação";
  const w = ctx.w;
  if (!isDir(w)) return r.err(g, "worktree", `o worktree do env.sh não existe: ${w}`, `ajuste W= no ${ctx.d}/env.sh ou recrie o worktree (git worktree add)`);
  if (run("git", ["-C", w, "rev-parse", "--git-dir"]).status !== 0) return r.err(g, "worktree", `${w} não é um repositório git`, `ajuste W= no ${ctx.d}/env.sh`);
  const list = run("git", ["-C", w, "worktree", "list", "--porcelain"]).stdout.split("\n").find((line) => line.startsWith("worktree "));
  if (w === (words(list ?? "")[1] ?? "")) {
    return r.err(g, "worktree", `o Hades está instalado no clone principal (${w}): o run-hades resetaria a sua branch`, `rode <skill>/kit/install.sh de dentro do clone, sem HADES_WT: ele cria o worktree ${w}-hades`);
  }
  r.ok(g, "worktree", `worktree ${w} (${chomp(run("git", ["-C", w, "rev-parse", "--abbrev-ref", "HEAD"]).stdout)})`);
}

function checkWorkRoot(r: Report): void {
  const g = "Instalação";
  const root = firstLine(join(home(), ".claude", "hades", "work-root"));
  if (!root) r.warn(g, "work-root", "~/.claude/hades/work-root ausente (o loop usa ~/.claude/hades/work)", "echo <pasta dos tickets> > ~/.claude/hades/work-root");
  else if (!isDir(root)) r.warn(g, "work-root", `work-root aponta para ${root}, que não existe`, `mkdir -p ${root} ou corrija ~/.claude/hades/work-root`);
  else r.ok(g, "work-root", `work-root → ${root}`);
}

function checkSlice(r: Report, ctx: Ctx): void {
  const g = "Instalação";
  if (serviceManager().kind === "launchd") return r.ok(g, "slice", "macOS: sem slice, o teto de memória é por processo (reference/adr/0003-teto-de-memoria.md)");
  const file = join(home(), ".config", "systemd", "user", `${ctx.hslice}.slice`);
  const max = env("HADES_SLICE_MAX");
  const text = readText(file);
  if (text === undefined) r.err(g, "slice", `${ctx.hslice}.slice não instalado (os serviços ficariam sem teto de memória)`, `${ctx.d}/config.sh apply-slice`);
  else if (!text.split("\n").includes(`MemoryMax=${max}`)) r.warn(g, "slice", `${ctx.hslice}.slice com MemoryMax diferente de HADES_SLICE_MAX (${max})`, `${ctx.d}/config.sh apply-slice`);
  else checkLoadedSlice(r, ctx, max);
}

/** O arquivo está certo; falta o gerenciador tê-lo carregado (daemon-reload) com o mesmo teto. */
function checkLoadedSlice(r: Report, ctx: Ctx, max: string): void {
  const g = "Instalação";
  const loaded = showSlice(ctx.hslice);
  const fix = `${ctx.d}/config.sh apply-slice (ou: systemctl --user daemon-reload)`;
  if (loaded === undefined) return r.ok(g, "slice", `${ctx.hslice}.slice instalado (MemoryMax=${max}); o systemd do usuário não respondeu, carga não conferida`);
  const verdict = judgeSlice(loaded, sliceMaxMib(max));
  if (verdict === "nao-carregado") r.err(g, "slice", `${ctx.hslice}.slice está em ~/.config/systemd/user mas não carregado (${loaded.loadState || "sem estado"}): os serviços subiriam sem teto de memória`, fix);
  else if (verdict === "teto-diferente") r.warn(g, "slice", `${ctx.hslice}.slice carregado com MemoryMax diferente de HADES_SLICE_MAX (${max})`, fix);
  else r.ok(g, "slice", `${ctx.hslice}.slice carregado (MemoryMax=${max})`);
}

const versionLine = (path: string): string => firstLine(path).replace(/[ \n]/g, "");

function checkKitVersion(r: Report, ctx: Ctx): void {
  const g = "Instalação";
  const sv = versionLine(join(ctx.sk, "VERSION"));
  const kv = versionLine(join(ctx.d, "kit.version"));
  if (!kv) r.warn(g, "kit-versao", "kit instalado sem registro de versão (instalação anterior à 3.6)", `HADES_WT=${ctx.w} ${sv ? "<skill>/" : ""}kit/install.sh`);
  else if (!sv) r.ok(g, "kit-versao", `kit ${kv} (VERSION da skill não encontrado em ${ctx.sk})`);
  else if (kv !== sv) r.warn(g, "kit-versao", `kit instalado é ${kv} e a skill está na ${sv}`, `HADES_WT=${ctx.w} ${ctx.sk}/kit/install.sh`);
  else r.ok(g, "kit-versao", `kit ${kv}, igual ao da skill`);
}

/** Versão nova publicada no GitHub (`hades version-check`): só avisa; o --quick lê só o cache. Sem acesso, nenhuma linha. */
function checkNewVersion(r: Report, ctx: Ctx): void {
  const cli = selfCli("version-check", "doctor", ...(ctx.quick ? [] : ["--refresh"]));
  const result = spawnSync(cli.command, cli.args, { env: { ...process.env, W: ctx.w }, encoding: "utf8", timeout: VERSION_CHECK_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  const [local, remote, cmd] = tabFields(result.stdout?.split("\n")[0] ?? "", 3);
  if (remote) r.warn("Instalação", "versao-nova", `versão ${remote} da skill disponível (instalada: ${local})`, cmd ?? "");
}

/** `IFS=$'\t' read -r a b c`: TAB junta delimitadores seguidos e ignora os do começo; o último campo leva o resto. */
export function tabFields(line: string, count: number): string[] {
  const fields: string[] = [];
  let rest = line.replace(/^\t+/, "");
  while (fields.length < count - 1) {
    const tab = rest.indexOf("\t");
    if (tab < 0) break;
    fields.push(rest.slice(0, tab));
    rest = rest.slice(tab).replace(/^\t+/, "");
  }
  fields.push(rest.replace(/\t+$/, ""));
  return fields;
}

function checkNodeModules(r: Report, ctx: Ctx): void {
  const w = ctx.w;
  const bins = words(env("HADES_DOCTOR_NODE_BINS").replaceAll(",", " "));
  if (!bins.length) return;
  const missing = bins.filter((bin) => !isExecutable(join(w, "node_modules", ".bin", bin)));
  if (!missing.length) r.ok("Instalação", "node_modules", "node_modules do worktree completo");
  else r.warn("Instalação", "node_modules", "node_modules do worktree ausente ou incompleto", `o run-hades monta sozinho; à mão: ${ctx.d}/node-modules.sh repair (ou a instalação de dependências do projeto em ${w})`);
}

function isExecutable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function checkInstallation(r: Report, ctx: Ctx): void {
  checkInstance(r, ctx);
  checkWorktree(r, ctx);
  checkWorkRoot(r);
  checkSlice(r, ctx);
  checkKitVersion(r, ctx);
  checkNewVersion(r, ctx);
  checkNodeModules(r, ctx);
}

/** Resumidores do rtk (reference/rtk.md): presença, filtros que valem para o worktree, confiança, onde a saída inteira vai e a política recomendada (só lê). */
function checkRtk(r: Report, ctx: Ctx): void {
  const g = "Resumidores (rtk)";
  const rtk = rtkBinary();
  if (!rtk) return r.warn(g, "rtk", "rtk não encontrado: sem resumidores por stack (nada muda)", "instale o rtk (https://github.com/rtk-ai/rtk) e rode: rtk init -g");
  const settings = settingsFor(ctx.d);
  const plan = planWorktree(ctx.w, settings, rtk);
  const file = join(ctx.w, FILTERS_REL);
  if (settings.mode === "off") {
    if (isFile(file)) r.warn(g, "rtk-filtros", `rtk ${rtk.version}; HADES_RTK_FILTERS=off, mas ${file} ainda existe`, `hades rtk apply ${ctx.w}`);
    else r.ok(g, "rtk-filtros", `rtk ${rtk.version}; filtros desligados (HADES_RTK_FILTERS=off), worktree sem ${FILTERS_REL}`);
  } else if (plan.action === "write") {
    const state = isFile(file) ? trustState(ctx.w, rtk) : "";
    const stacks = `${plan.stacks.join(",")}: ${plan.filters.join(",")}`;
    if (!isFile(file)) r.warn(g, "rtk-filtros", `rtk ${rtk.version}; filtros previstos (${stacks}), mas ${file} não existe`, `hades rtk apply ${ctx.w} --trust (no terminal, com \`!\`)`);
    else if (state === "confiado") r.ok(g, "rtk-filtros", `rtk ${rtk.version}; filtros ativos (${stacks})`);
    else r.warn(g, "rtk-filtros", `rtk ${rtk.version}; ${file} ${state === "alterado" ? "mudou depois de confiado" : "ainda não confiado"}: o rtk o ignora em silêncio (${stacks})`, `cd ${ctx.w} && rtk trust`);
  } else r.ok(g, "rtk-filtros", `rtk ${rtk.version}; sem filtro para este worktree (${plan.why})`);
  if (settings.offStacks.length || settings.offFilters.length) r.ok(g, "rtk-ajuste", `ajuste do dono: stacks fora ${settings.offStacks.join(",") || "—"} · filtros fora ${settings.offFilters.join(",") || "—"}`);
  const db = process.env.RTK_RECALL_DB ?? "";
  const tee = process.env.RTK_TEE_DIR ?? "";
  if (db.startsWith(`${ctx.d}/`) && tee.startsWith(`${ctx.d}/`)) r.ok(g, "rtk-recall", `saída inteira em ${db} (rtk recall) e ${tee}`);
  else r.warn(g, "rtk-recall", "RTK_RECALL_DB/RTK_TEE_DIR não apontam para os dados da instância: a saída inteira que um filtro corta vai para o padrão do rtk", `reinstale o kit (o env.sh passa a exportar) e abra um shell novo; no agente, exporte RTK_RECALL_DB=${ctx.d}/rtk/recall.db RTK_TEE_DIR=${ctx.d}/rtk/tee`);
  const advice = policyAdvice(rtkConfig(home()), rtk.version);
  if (advice.length) r.warn(g, "rtk-politica", `política do rtk com ajuste recomendado: ${advice.join(" · ")}`, "edite o config.toml do rtk (rtk config); a Hades só recomenda, não grava");
  else r.ok(g, "rtk-politica", "política do rtk coerente com o recomendado");
}

function checkPanel(r: Report, ctx: Ctx): void {
  const g = "Painel";
  const mode = env("HADES_PANEL_AUTOSTART", "off");
  const unit = `${ctx.hu}-panel`;
  const manager = serviceManager();
  const enabled = manager.enabledState(unit);
  const linger = lingering() ? "yes" : "";
  if (mode === "off") {
    if (enabled === "enabled") r.warn(g, "painel", `início automático desligado nas Configurações, mas a unit ${unit} está enabled`, `${ctx.d}/panel.sh autostart`);
    else r.ok(g, "painel", `início automático desligado, unit ${enabled || "ausente"}`);
  } else if (mode === "login" || mode === "boot") {
    if (enabled !== "enabled") r.warn(g, "painel", `início automático (${mode}) pedido, mas a unit ${unit} não está enabled (${enabled || "ausente"})`, `${ctx.d}/panel.sh autostart`);
    else if (manager.kind === "launchd" && mode === "boot") r.warn(g, "painel", "macOS: o painel sobe no login do usuário, não no boot da máquina", `${ctx.d}/config.sh set HADES_PANEL_AUTOSTART=login`);
    else if (mode === "boot" && linger !== "yes") r.warn(g, "painel", "modo boot pede linger do systemd e ele está desligado", `${ctx.d}/panel.sh autostart (ou: loginctl enable-linger $USER)`);
    else if (mode === "login" && linger === "yes" && !isFile(join(ctx.d, "linger.mine"))) r.ok(g, "painel", "início automático no login (linger ligado por fora do Hades)");
    else r.ok(g, "painel", `início automático (${mode}) coerente com a unit`);
  } else r.warn(g, "painel", `HADES_PANEL_AUTOSTART com valor inesperado: ${mode}`, `${ctx.d}/config.sh set HADES_PANEL_AUTOSTART=off|login|boot`);
  checkHerdrServer(r, unit);
}

/** Painel ativo e o socket do herdr sem resposta (típico depois do reboot): o painel o sobe ao criar terminal, mas avisa. */
function checkHerdrServer(r: Report, unit: string): void {
  if (!has("herdr") || !unitIs(unit, "active")) return;
  if (herdrServerResponds()) r.ok("Painel", "herdr-servidor", "painel no ar e servidor do herdr respondendo");
  else r.warn("Painel", "herdr-servidor", "painel no ar sem servidor herdr (o terminal do canvas sobe o servidor ao ser criado)", "abra o `herdr` (ou crie um terminal no canvas: o painel sobe o servidor)");
}

function checkBoot(r: Report, ctx: Ctx): void {
  if (serviceManager().kind === "launchd") return;
  const unit = env("HADES_BOOT_UNIT", `${ctx.hu}-boot`);
  if (capture("systemctl", ["--user", "is-enabled", `${unit}.timer`]) !== "enabled") return;
  r.warn("Subida", "boot", `o timer ${unit} ainda está enabled: a subida completa automática saiu, só o painel inicia sozinho`, `systemctl --user disable --now ${unit}.timer (a reinstalação do kit também remove a unit)`);
}

function checkCleaning(r: Report, ctx: Ctx): void {
  const g = "Limpeza";
  const unit = env("CLEAN_UNIT", `${ctx.hu}-logrotate`);
  const enabled = serviceManager().timerEnabledState(unit);
  if (env("HADES_CLEAN_TIMER", "on") === "on") {
    if (enabled === "enabled") r.ok(g, "logrotate", `timer ${unit} ativo (a cada ${env("HADES_CLEAN_EVERY", "6h")})`);
    else r.warn(g, "logrotate", `limpeza automática ligada, mas o timer ${unit} não está enabled (${enabled || "ausente"})`, `${ctx.d}/clean.sh apply`);
  } else if (enabled === "enabled") r.warn(g, "logrotate", `limpeza automática desligada nas Configurações, mas o timer ${unit} está enabled`, `${ctx.d}/clean.sh apply`);
  else r.ok(g, "logrotate", `limpeza automática desligada, timer ${enabled || "ausente"}`);
}

function checkNotifications(r: Report, ctx: Ctx): void {
  const g = "Notificações";
  const unit = env("HADES_NOTIFY_UNIT", `${ctx.hu}-notify`);
  const manager = serviceManager();
  const enabled = manager.enabledState(unit);
  const active = manager.activeState(unit);
  if (env("HADES_NOTIFY", "0") === "1") {
    if (enabled !== "enabled") r.warn(g, "notify", `notificações ligadas, mas a unit ${unit} não está enabled (${enabled || "ausente"})`, `${ctx.d}/notify.sh apply`);
    else if (active !== "active") r.warn(g, "notify", `unit ${unit} enabled, mas parada (${active || "sem resposta"})`, `${ctx.d}/notify.sh apply (log: ${manager.kind === "launchd" ? `${ctx.d}/logs/notify.log` : `journalctl --user -u ${unit}`})`);
    else r.ok(g, "notify", `vigia ${unit} ativo`);
    if (env("HADES_NOTIFY_DESKTOP", "1") !== "1" && env("HADES_NOTIFY_NTFY", "0") !== "1") r.warn(g, "notify-canal", "notificações ligadas sem nenhum canal", `${ctx.d}/config.sh set HADES_NOTIFY_DESKTOP=1`);
  } else if (enabled === "enabled") r.warn(g, "notify", `notificações desligadas nas Configurações, mas a unit ${unit} está enabled`, `${ctx.d}/notify.sh apply`);
  else r.ok(g, "notify", `notificações desligadas, unit ${enabled || "ausente"}`);
}

/** Plugin do projeto: a faixa `core` do perfil contra a VERSION do núcleo; só leitura. */
function checkPlugin(r: Report, ctx: Ctx): void {
  const g = "Plugin";
  if (!isDir(ctx.w)) return;
  // o campo `core` vazio (sem-core) não pode colapsar com o TAB: split exato, como o mapfile -d
  const cli = selfCli("project", "core-check", "--dir", ctx.w);
  const fields = run(cli.command, cli.args).stdout.split("\t");
  const [status = "", plugin = "", range = "", core = ""] = fields;
  const message = (fields[4] ?? "").replace(/\n$/, "");
  const disabled = plugin !== "" && (readText(join(ctx.d, "plugins.disabled")) ?? "").split("\n").includes(plugin);
  switch (disabled ? "desligado" : status) {
    case "ok": return r.ok(g, "plugin", `plugin ${plugin}: núcleo ${core} dentro da faixa ${range}`);
    case "sem-core": return r.warn(g, "plugin", `plugin ${plugin} sem faixa \`core\` (núcleo ${core})`, 'acrescente "core": ">=<versão>" ao profile.json do plugin');
    case "fora": return r.err(g, "plugin", `plugin ${plugin} pede o núcleo ${range} e o instalado é o ${core}`, `atualize o núcleo (skill Hades) ou o plugin: git -C ${chomp(run(cli.command, selfCli("project", "pack", ctx.w).args).stdout)} pull`);
    case "invalido": return r.err(g, "plugin", message, "corrija o `core` do profile.json (ex.: >=4.3 <5)");
    case "sem-perfil": return r.ok(g, "plugin", `${basename(ctx.w)}: sem plugin do Hades (nada a conferir)`);
    case "desligado": return r.ok(g, "plugin", `plugin ${plugin} desligado nesta instalação (página Plugins ou ${ctx.d}/plugins.sh enable ${plugin})`);
    default:
  }
}

const PLUGIN_SHIM = join(import.meta.dirname, "..", "lib", "doctor-plugin-shim.sh");

/** Checagens do plugin do projeto ($D/plugin/doctor.sh): rodam num shim de bash e os registros voltam na ordem. */
function checkProject(r: Report, ctx: Ctx): void {
  if (!isFile(join(ctx.d, "plugin", "doctor.sh"))) return;
  const dir = mkdtempSync(join(tmpdir(), "hades-doctor-"));
  const recFile = join(dir, "records");
  try {
    spawnSync("bash", [PLUGIN_SHIM, ctx.here, ctx.sk, ctx.quick ? "1" : "0"], { env: { ...process.env, REC_FILE: recFile }, stdio: "inherit" });
    const text = existsSync(recFile) ? readFileSync(recFile, "utf8") : "";
    for (const record of text.split("\0").filter(Boolean)) {
      const [level = "", group = "", id = "", msg = "", fix = ""] = record.split(SEP);
      r.add(level as Level, group, id, msg, fix);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Coleta do % das janelas (reference/limites.md): só avisa; ligar o statusLine é passo do dono, o settings.json não é alterado. */
export function limitesItem(settingsText: string | undefined, janelasMedidas: number): { level: Level; msg: string; fix: string } {
  if (coletaLigada(settingsText, janelasMedidas)) return { level: "ok", msg: "limites: coleta do % das janelas ligada", fix: "" };
  return {
    level: "warn",
    msg: "limites: coleta do % das janelas de 5 h e semanal desligada (o painel e o aviso do watch ficam sem medida)",
    fix: 'no statusLine do ~/.claude/settings.json ponha {"type":"command","command":"hades usage sample"} (reference/limites.md)',
  };
}

function checkLimites(r: Report): void {
  const item = limitesItem(readText(claudeSettingsPath()), Object.keys(medidas(new Date(), chaves()).atual).length);
  r.add(item.level, "Limites", "limites", item.msg, item.fix);
}

/** Passos pendentes das features escolhidas e onboarding incompleto (definição única do onboard.ts): só aviso, nunca erro. */
function checkOnboarding(r: Report, ctx: Ctx): void {
  const g = "Onboarding";
  const script = join(ctx.d, "onboard.sh");
  if (ctx.quick || !isFile(script)) return;
  const status = spawnSync("bash", [script, "status", "--doctor"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const lines = status.stdout?.split("\n") ?? [];
  const [pending = "", list = "", chosen = ""] = tabFields(lines[0] ?? "", 3);
  const incomplete = lines[1] ?? "";
  if (/^[0-9]+$/.test(pending) && Number(pending) > 0) {
    r.warn(g, "onboard", `Onboarding: ${pending} pendente(s) em ${list}`, `${ctx.d}/onboard.sh show <feature> (ou /hades env onboard, ou a página Onboarding do painel)`);
  } else if (incomplete !== "") {
    r.warn(g, "onboard", incomplete, "/hades env onboard, ou a página Onboarding do painel");
  } else if (Number(chosen || "0") > 0) r.ok(g, "onboard", "Onboarding: features escolhidas em dia");
  else r.ok(g, "onboard", "Onboarding: completo");
}

function exitCode(items: Item[]): number {
  if (items.some((i) => i.level === "error")) return HEALTH_EXIT.error;
  return items.some((i) => i.level === "warn") ? HEALTH_EXIT.warn : HEALTH_EXIT.ok;
}

const count = (items: Item[], level: Level): number => items.filter((i) => i.level === level).length;

function renderJson(items: Item[], quick: boolean, code: number): string {
  const summary = { ok: count(items, "ok"), warn: count(items, "warn"), error: count(items, "error") };
  const time = Math.floor(Date.now() / 1000);
  return pyDumps({ version: 1, quick, time, exit: code, summary, items });
}

function renderTable(items: Item[], quick: boolean): string {
  const tty = process.stdout.isTTY;
  const [green, yellow, red, bold, reset] = tty ? ["\x1b[32m", "\x1b[33m", "\x1b[31m", "\x1b[1m", "\x1b[0m"] : ["", "", "", "", ""];
  const lines: string[] = [];
  let last = "";
  for (const item of items) {
    if (item.group !== last) {
      lines.push(`${bold}${item.group}${reset}`);
      last = item.group;
    }
    if (item.level === "ok") lines.push(`  ${green}✓${reset} ${item.msg}`);
    else {
      lines.push(`  ${item.level === "warn" ? yellow : red}${item.level === "warn" ? "!" : "✗"}${reset} ${item.msg}`);
      if (item.fix) lines.push(`      → ${item.fix}`);
    }
  }
  lines.push(`${count(items, "ok")} ok · ${count(items, "warn")} aviso(s) · ${count(items, "error")} erro(s)${quick ? " (rápido)" : ""}`);
  return lines.join("\n");
}

const REEXEC_GUARD = "HADES_DOCTOR_NA_INSTANCIA";

/**
 * Fora do env.sh (`hades doctor` num shell comum) o ambiente da instância (HADES_WT, HADES_SLICE_MAX, as chaves do plugin) não
 * está exportado. O `$D/doctor.sh` o carrega e volta aqui; a guarda evita o laço quando o env.sh não exporta o worktree.
 */
function rerunInInstance(d: string, args: string[]): number | undefined {
  const script = join(d, "doctor.sh");
  if (process.env.HADES_WT !== undefined || process.env[REEXEC_GUARD] || !isFile(script)) return undefined;
  const ran = spawnSync("bash", [script, ...args], { stdio: "inherit", env: { ...process.env, [REEXEC_GUARD]: "1" } });
  return ran.status ?? EXIT.fail;
}

export function doctorCommand(args: string[]): number {
  let quick = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--quick") quick = true;
    else if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") {
      out(HELP);
      return EXIT.ok;
    } else {
      warnErr(USAGE);
      return EXIT.usage;
    }
  }
  const d = stateDir();
  const viaInstance = rerunInInstance(d, args);
  if (viaInstance !== undefined) return viaInstance;
  const hu = env("HU", unitPrefix(d));
  const ctx: Ctx = {
    quick,
    d,
    w: env("HADES_WT", readEnvSh(d).get("W") ?? ""),
    hu,
    hslice: env("HSLICE", `hades${hu.slice("hds".length)}`),
    hproj: env("HPROJ", `hades${hu.slice("hds".length)}`),
    here: d,
    sk: isFile(`${d}/../VERSION`) ? `${d}/..` : env("HADES_SKILL_DIR", join(home(), ".claude", "skills", "hades")),
  };
  const report = new Report();
  checkTools(report, ctx);
  checkMachine(report, ctx);
  checkInstallation(report, ctx);
  checkRtk(report, ctx);
  checkPanel(report, ctx);
  checkBoot(report, ctx);
  checkCleaning(report, ctx);
  checkNotifications(report, ctx);
  checkLimites(report);
  checkPlugin(report, ctx);
  checkProject(report, ctx);
  checkOnboarding(report, ctx);
  const code = exitCode(report.items);
  out(json ? renderJson(report.items, quick, code) : renderTable(report.items, quick));
  return code;
}
