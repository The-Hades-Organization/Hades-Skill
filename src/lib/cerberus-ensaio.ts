// Ensaio isolado do código executável de um plugin (guarda plugin-ensaio-isolado, reference/cerberus/limiar.md): cada script
// roda num bubblewrap com a raiz somente leitura, HOME em tmpfs somente leitura, uma cópia descartável do $D gravável no
// caminho do $D e sem rede (salvo declaração no plugin.json). O $D real nunca é tocado e o docker.sock nunca é montado:
// connect() num socket Unix não é barrado por montagem somente leitura nem por --unshare-net, então /run, /tmp, /var/tmp e o
// XDG_RUNTIME_DIR viram tmpfs vazios e cada socket achado em outros pontos do host é coberto com /dev/null. Escrita no
// worktree só por declaração (ensaio.escrita[] no plugin.json), e sobre uma cópia descartável do caminho declarado.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { ev, type CheckEnv, type Evid } from "./cerberus-check.ts";

const SCRIPT_TIMEOUT_S = 20;
const BUDGET_S = 240; // o teto da guarda (loop/cerberus/limiar/plugin-ensaio-isolado.json) é maior que isto
const OUTPUT_MAX = 1 << 20;
const PATHS_NAMED = 3;
const TAIL = 160;
const SOCKET_SCAN_ROOTS = ["/etc", "/var", "/opt", "/srv", "/mnt", "/media"]; // /run, /tmp e o HOME já somem inteiros
const SOCKET_SCAN_DEPTH = "6";
const SOCKET_SCAN_TIMEOUT_MS = 10_000;
const COPY_SKIP = new Set(["logs", "plugins-staging", "_maquina", ".git"]); // volumosos e sem uso para um script de instalação
const INSTALL_HINT = "instale o pacote bubblewrap da sua distribuição (ex.: pacman -S bubblewrap · apt install bubblewrap · dnf install bubblewrap)";
const WRITE_DENIED = /read-only file system/i;
const NET_MARKERS = new RegExp(
  "network is unreachable|network is down|could not resolve|name or service not known|temporary failure in name resolution"
  + "|failed to connect|connection refused|no route to host|unable to resolve|couldn't connect",
  "i",
);
// docker: chamada como comando; `command -v docker`, `have docker` e afins só sondam a presença
const DOCKER_CALL = /(?:^|[\s;&|(`$])(?:sudo\s+)?docker(?:-compose)?(?=\s|$)/;
const DOCKER_PROBE = /(?:command\s+-v|which|type\s+-p|type|have|hash)\s+docker/;
const DOCTOR_WRAPPER =
  'ok(){ :; }; warn(){ :; }; err(){ :; }; have(){ command -v "$1" >/dev/null 2>&1; }; G=Projeto; QUICK=1; D=$HADES_DATA; W=${HADES_WT:-}; source "$1"';

export interface Escrita { caminho: string; motivo: string }
export type Estado = "ensaiado" | "barrado" | "nao-ensaiado";
export interface Resultado { rel: string; estado: Estado; motivo: string; nota?: string }
export interface EnsaioIn {
  /** scripts a ensaiar, caminho relativo ao env/ → conteúdo */
  scripts: Map<string, string>;
  /** todo o env/ do plugin a extrair ao lado dos scripts: caminho relativo → {conteúdo, modo} */
  files: Map<string, { body: Buffer; mode: number }>;
  /** item → motivo, do campo ensaio.rede do plugin.json */
  rede: Map<string, string>;
  /** item → caminhos do worktree que ele pode gravar (cópia descartável), do campo ensaio.escrita do plugin.json */
  escrita: Map<string, Escrita[]>;
}

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** O campo opcional `ensaio.rede[]` do plugin.json: {item, motivo}; entrada sem item ou sem motivo não vale. */
export function redeDeclarada(pluginJson: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const ens = (pluginJson as { ensaio?: unknown } | null)?.ensaio;
  const list = (ens as { rede?: unknown } | null | undefined)?.rede;
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    const { item, motivo } = (entry ?? {}) as { item?: unknown; motivo?: unknown };
    if (typeof item === "string" && item && typeof motivo === "string" && motivo.trim()) out.set(item, motivo.trim());
  }
  return out;
}

/** O campo opcional `ensaio.escrita[]`: {item, caminho, motivo}; caminho relativo ao worktree e contido nele, sem `..`. */
export function escritaDeclarada(pluginJson: unknown): Map<string, Escrita[]> {
  const out = new Map<string, Escrita[]>();
  const ens = (pluginJson as { ensaio?: unknown } | null)?.ensaio;
  const list = (ens as { escrita?: unknown } | null | undefined)?.escrita;
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    const { item, caminho, motivo } = (entry ?? {}) as { item?: unknown; caminho?: unknown; motivo?: unknown };
    if (typeof item !== "string" || !item || typeof caminho !== "string" || typeof motivo !== "string" || !motivo.trim()) continue;
    const rel = normalize(caminho).replace(/\/+$/, "");
    if (!rel || rel === "." || isAbsolute(rel) || rel === ".." || rel.startsWith("../")) continue;
    out.set(item, [...(out.get(item) ?? []), { caminho: rel, motivo: motivo.trim() }]);
  }
  return out;
}

export function findBwrap(path: string | undefined): string | undefined {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, "bwrap");
    try { if (statSync(cand).isFile()) return cand; } catch { /* próximo da lista */ }
  }
  return undefined;
}

function callsDocker(text: string): boolean {
  return text.split("\n").some((ln) => {
    const code = ln.trim();
    return code !== "" && !code.startsWith("#") && DOCKER_CALL.test(code) && !DOCKER_PROBE.test(code);
  });
}

/** Cópia descartável de uma pasta (sem o que é volumoso no topo); só arquivos, pastas e links: socket e fifo ficam de fora. */
function copyTree(from: string, dest: string, skipTop: ReadonlySet<string> = new Set()): void {
  if (!isDir(from)) return;
  cpSync(from, dest, {
    recursive: true, verbatimSymlinks: true,
    filter: (src) => {
      if (src === from) return true;
      if (skipTop.has(src.slice(from.length + 1).split("/")[0] as string)) return false;
      const st = lstatSync(src);
      return st.isFile() || st.isDirectory() || st.isSymbolicLink();
    },
  });
}

interface WriteBind { copy: string; target: string }

/** Caminho declarado resolvido dentro do worktree (links não escapam); sem worktree, sem caminho ou fora dele, nada. */
function declaredTarget(worktree: string, caminho: string): string | undefined {
  try {
    const base = realpathSync(worktree), target = realpathSync(join(worktree, caminho));
    return isDir(target) && target.startsWith(`${base}/`) ? target : undefined;
  } catch { return undefined; }
}

/** Caminhos que o script tentou gravar: o que vem ao lado de "Read-only file system" na saída de erro. */
function writtenPaths(output: string): string[] {
  const found: string[] = [];
  for (const ln of output.split("\n")) {
    if (!WRITE_DENIED.test(ln)) continue;
    const quoted = ln.match(/'(\/[^']+)'/) ?? ln.match(/(\/[^\s:'"]+)\s*:\s*read-only/i);
    if (quoted?.[1] && !found.includes(quoted[1])) found.push(quoted[1]);
  }
  return found;
}

const tail = (text: string): string => text.trim().split("\n").slice(-2).join(" ⏎ ").slice(-TAIL);

interface Sandbox {
  bwrap: string; copy: string; target: string; env: Record<string, string>; home: string; worktree: string; skill: string;
  /** pastas que viram tmpfs vazio (e somente leitura): onde o host guarda sockets de daemons */
  volatile: string[];
  /** sockets fora dessas pastas, cobertos com /dev/null */
  sockets: string[];
}

/** Pastas do host que somem no sandbox: /run (docker.sock, systemd, dbus), /tmp, /var/tmp e o XDG_RUNTIME_DIR (barramento da sessão). */
function volatileDirs(env: Record<string, string | undefined>): string[] {
  const dirs = new Set<string>(["/run", "/tmp", "/var/tmp"]);
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg && xdg.startsWith("/") && isDir(xdg)) dirs.add(realpathSync(xdg));
  for (const d of [...dirs]) if (d.startsWith("/run/") || d.startsWith("/tmp/")) dirs.delete(d); // já cobertos pelo pai
  return [...dirs].filter(isDir);
}

/** Sockets Unix fora das pastas que somem (ex.: /etc/pacman.d/gnupg, sob /var, /opt): um a um, pois não dá para escondê-los por montagem de pasta. */
function findSockets(extraRoots: string[]): string[] {
  const roots = [...SOCKET_SCAN_ROOTS, ...extraRoots].filter(isDir);
  if (!roots.length) return [];
  const r = spawnSync("find", [...roots, "-xdev", "-maxdepth", SOCKET_SCAN_DEPTH, "-type", "s", "-print0"], {
    encoding: "utf8", timeout: SOCKET_SCAN_TIMEOUT_MS, maxBuffer: OUTPUT_MAX, stdio: ["ignore", "pipe", "ignore"],
  });
  return (r.stdout ?? "").split("\0").filter((p) => p.startsWith("/") && !p.includes("\n")); // find sai com 1 quando perde permissão numa pasta: o que listou vale
}

function bwrapArgs(sb: Sandbox, withNet: boolean, writes: WriteBind[], cwd: string, argv: string[]): string[] {
  const args = ["--die-with-parent", "--unshare-pid", ...(withNet ? [] : ["--unshare-net"]), "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const dir of sb.volatile) args.push("--tmpfs", dir);
  // com rede liberada o resolvedor precisa do resolv.conf, que costuma ser link para /run/systemd/resolve
  if (withNet) for (const f of resolvConfTargets()) args.push("--ro-bind", f, f);
  if (sb.home) args.push("--tmpfs", sb.home);
  args.push("--bind", sb.copy, sb.target);
  // o que mora sob o HOME (ou sob as pastas que somem) volta somente leitura: o worktree e a skill, para o script poder lê-los
  const vanished = [...sb.volatile, sb.home].filter(Boolean);
  for (const keep of [sb.worktree, sb.skill]) {
    if (keep && vanished.some((v) => keep.startsWith(`${v}/`)) && existsSync(keep)) args.push("--ro-bind", keep, keep);
  }
  for (const w of writes) args.push("--bind", w.copy, w.target);
  for (const sock of sb.sockets) args.push("--ro-bind", "/dev/null", sock); // depois dos binds acima: um bind de pasta cobriria a máscara
  for (const dir of [...sb.volatile, sb.home]) if (dir) args.push("--remount-ro", dir);
  args.push("--chdir", cwd, "--", ...argv);
  return args;
}

function runOne(sb: Sandbox, rel: string, withNet: boolean, writes: WriteBind[], timeoutS: number): Resultado {
  const path = join(sb.target, ".ensaio-env", rel);
  const argv = rel === "doctor.sh" ? ["bash", "-c", DOCTOR_WRAPPER, "_", path] : ["bash", path];
  const r = spawnSync(sb.bwrap, bwrapArgs(sb, withNet, writes, dirname(path), argv), {
    env: sb.env, encoding: "utf8", timeout: timeoutS * 1000, killSignal: "SIGKILL", maxBuffer: OUTPUT_MAX, stdio: ["ignore", "pipe", "pipe"],
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return { rel, estado: "barrado", motivo: `passou de ${timeoutS} s no ensaio` };
  if (r.status === 0) return { rel, estado: "ensaiado", motivo: "saiu com 0" };
  const output = `${r.stderr ?? ""}\n${r.stdout ?? ""}`;
  const paths = writtenPaths(output);
  if (paths.length) return { rel, estado: "barrado", motivo: `escreve fora do $D (para gravar no worktree, declare em plugin.json → ensaio.escrita): ${paths.slice(0, PATHS_NAMED).join(", ")}` };
  if (NET_MARKERS.test(output)) return { rel, estado: "barrado", motivo: `usa rede sem declarar (declare em plugin.json → ensaio.rede): ${tail(output)}` };
  return { rel, estado: "barrado", motivo: `falhou no ensaio: saiu com ${r.status ?? r.signal}${tail(output) ? ` — ${tail(output)}` : ""}` };
}

function resolvConfTargets(): string[] {
  try {
    const real = realpathSync("/etc/resolv.conf");
    return real.startsWith("/run/") ? [real] : [];
  } catch { return []; }
}

/** O bubblewrap sobe aqui (kernel sem user namespace, por exemplo, não sobe)? */
function bwrapWorks(bwrap: string): string | undefined {
  const r = spawnSync(bwrap, ["--unshare-pid", "--ro-bind", "/", "/", "--", "true"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? undefined : tail(`${r.stderr ?? ""}`) || "não subiu";
}

const line = (r: Resultado, extra = ""): Evid =>
  ev(`${r.rel}: ${r.estado === "nao-ensaiado" ? "não ensaiado" : r.estado} (${r.motivo})${r.nota ? ` — ${r.nota}` : ""}${extra}`, `bwrap --ro-bind / / … ${r.rel}`);

export interface EnsaioOut { resultado: "ok" | "aviso" | "barra"; evidencia: Evid[]; detalhe: string }

export function ensaiar(inp: EnsaioIn, ce: CheckEnv): EnsaioOut {
  const names = [...inp.scripts.keys()].sort();
  if (!names.length) {
    return { resultado: "ok", evidencia: [ev("nada a ensaiar: o plugin não tem post-install.sh, doctor.sh nem checks/", "env/ do commit")], detalhe: "sem código ensaiável" };
  }
  const bwrap = findBwrap(ce.env.PATH);
  const broken = bwrap ? bwrapWorks(bwrap) : undefined;
  if (!bwrap || broken !== undefined) {
    const why = bwrap ? `o bubblewrap não subiu aqui (${broken})` : `bwrap fora do PATH: ${INSTALL_HINT}`;
    return {
      resultado: "aviso", detalhe: "ensaio não feito: sem bubblewrap utilizável",
      evidencia: [ev(`${names.length} script(s) não ensaiado(s): ${why}`, "PATH"), ...names.map((n) => ev(`${n}: não ensaiado (sem bubblewrap)`, "env/ do commit"))],
    };
  }

  const work = mkdtempSync(join(tmpdir(), "hades-ensaio-"));
  try {
    const realData = ce.env.HADES_DATA ?? "";
    const copy = join(work, "D");
    mkdirSync(copy, { recursive: true });
    copyTree(realData, copy, COPY_SKIP);
    for (const [rel, { body, mode }] of inp.files) {
      const dest = join(copy, ".ensaio-env", rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, body);
      chmodSync(dest, mode);
    }
    mkdirSync(join(copy, ".ensaio-tmp"), { recursive: true });
    const target = realData && isDir(realData) ? realData : copy;
    const home = ce.env.HOME ?? "";
    const env: Record<string, string> = {
      PATH: ce.env.PATH ?? "", HOME: home, LANG: ce.env.LANG ?? "C.UTF-8", TMPDIR: join(target, ".ensaio-tmp"), HADES_DATA: target,
      ...(ce.env.HADES_WT ? { HADES_WT: ce.env.HADES_WT } : {}), ...(ce.env.HADES_SKILL_DIR ? { HADES_SKILL_DIR: ce.env.HADES_SKILL_DIR } : {}),
    };
    const worktree = ce.env.HADES_WT ?? "", skill = ce.env.HADES_SKILL_DIR ?? "";
    const sb: Sandbox = { bwrap, copy, target, env, home, worktree, skill, volatile: volatileDirs({ XDG_RUNTIME_DIR: ce.env.XDG_RUNTIME_DIR ?? process.env.XDG_RUNTIME_DIR }), sockets: findSockets([worktree, skill]) };
    const started = Date.now();
    const results: Array<{ r: Resultado; rede?: string; liberadas?: Escrita[] }> = [];
    for (const rel of names) {
      if (callsDocker(inp.scripts.get(rel) as string)) {
        results.push({ r: { rel, estado: "nao-ensaiado", motivo: "docker", nota: "o docker.sock nunca entra no sandbox" } });
        continue;
      }
      if ((Date.now() - started) / 1000 > BUDGET_S) {
        results.push({ r: { rel, estado: "nao-ensaiado", motivo: `passou do orçamento de ${BUDGET_S} s do ensaio` } });
        continue;
      }
      const rede = inp.rede.get(rel);
      const liberadas: Escrita[] = [], writes: WriteBind[] = [];
      for (const [i, e] of (inp.escrita.get(rel) ?? []).entries()) {
        const target = declaredTarget(worktree, e.caminho);
        if (!target) continue; // caminho que não existe ou escapa do worktree não libera nada: a escrita barra
        const copy = join(work, `W${results.length}-${i}`);
        copyTree(target, copy);
        writes.push({ copy, target });
        liberadas.push(e);
      }
      results.push({ r: runOne(sb, rel, rede !== undefined, writes, SCRIPT_TIMEOUT_S), rede, liberadas });
    }
    const evidencia = results.map(({ r, rede, liberadas }) => line(r,
      (rede !== undefined ? `; rede liberada por declaração: ${rede}` : "")
      + (liberadas?.length ? `; escrita liberada por declaração (cópia descartável): ${liberadas.map((e) => `${e.caminho} (${e.motivo})`).join(", ")}` : "")));
    const barrados = results.filter(({ r }) => r.estado === "barrado").length;
    const feitos = results.filter(({ r }) => r.estado === "ensaiado").length;
    if (barrados) return { resultado: "barra", evidencia, detalhe: `${barrados} script(s) barrado(s) no ensaio` };
    const liberadas = results.filter(({ rede }) => rede !== undefined).length;
    return {
      resultado: "ok", evidencia,
      detalhe: `${feitos} script(s) ensaiado(s)${liberadas ? `, ${liberadas} com rede liberada por declaração` : ""}${feitos < results.length ? `, ${results.length - feitos} não ensaiado(s)` : ""}`,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
