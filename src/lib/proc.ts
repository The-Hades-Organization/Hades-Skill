import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {}): RunResult {
  const r = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut };
}

/** Caminho do executável no PATH (o primeiro que casa, como `command -v`), ou undefined. */
export function which(command: string, pathVar: string = process.env.PATH ?? ""): string | undefined {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ processo e memória (Linux: /proc; macOS: ps, vm_stat, sysctl)

const IS_LINUX = process.platform === "linux";
const PROBE_TIMEOUT_MS = 2000;
const MIB = 1024 * 1024;
// No macOS o sysctl e o netstat moram em /usr/sbin, que nem todo PATH tem (o de um serviço, o fechado dos testes)
const SYSCTL = "/usr/sbin/sysctl";
const NETSTAT = "/usr/sbin/netstat";

/** O pid existe (zumbi incluso, como o /proc/<pid> do Linux). EPERM: existe, só é de outro usuário. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (IS_LINUX) {
    try {
      return statSync(`/proc/${pid}`).isDirectory();
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Marca de início do processo, para distinguir o vivo de um pid reciclado: o campo starttime do /proc/<pid>/stat no
 * Linux (ticks desde o boot) e o epoch em segundos do `ps -o lstart=` no macOS. Só se compara com outra da mesma máquina.
 * undefined: não deu para ler (processo sumiu, ou o `ps` falhou), o que não prova que o pid é de outro processo.
 */
export function procStartTime(pid: number): string | undefined {
  if (IS_LINUX) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return undefined;
    }
    // O campo 2 (comm) pode ter ") " dentro: o resto conta a partir do último.
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]?.trim();
  }
  // TZ=UTC: o lstart sai na hora local, que se repete no fim do horário de verão e muda com o TZ de quem pergunta
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  return r.status === 0 ? parseLstartUtc(r.stdout ?? "") : undefined;
}

/** `ps -o lstart=` rodado com TZ=UTC ("Thu Oct 29 19:53:09 2026") em epoch de segundos; undefined se não casa. */
export function parseLstartUtc(text: string): string | undefined {
  const t = text.trim();
  if (!/^\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(t)) return undefined;
  const ms = Date.parse(`${t} GMT`);
  return Number.isNaN(ms) ? undefined : String(Math.floor(ms / 1000));
}

/**
 * O processo gravado com a marca `start` ainda é o dono do pid: pid vivo e marca igual. Sem marca gravada, ou sem como
 * ler a atual, vale o pid vivo: tratar como reciclado apagaria o ticket de um processo vivo.
 */
export function sameProcess(pid: string, start: string): boolean {
  if (pid === "" || !pidAlive(Number(pid))) return false;
  return startConfirms(start, procStartTime(Number(pid)));
}

/** A regra do sameProcess sobre as marcas: só uma marca gravada e uma lida, diferentes, provam pid reciclado. */
export function startConfirms(recorded: string, current: string | undefined): boolean {
  return recorded === "" || current === undefined || current === recorded;
}

function meminfoKb(key: string): number | undefined {
  let text: string;
  try {
    text = readFileSync("/proc/meminfo", "utf8");
  } catch {
    return undefined;
  }
  const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * Memória que dá para usar sem pressão, em MB; 0 se não deu para ler. No macOS: o percentual livre do kernel
 * (kern.memorystatus_level, o mesmo do `memory_pressure`) sobre a RAM total, que conta o cache reaproveitável como o
 * MemAvailable do Linux; sem ele, páginas livres + inativas + especulativas do vm_stat.
 */
export function memAvailableMb(): number {
  if (IS_LINUX) return Math.floor((meminfoKb("MemAvailable") ?? 0) / 1024);
  const level = Number(spawnSync(SYSCTL, ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }).stdout?.trim() || Number.NaN);
  if (level > 0 && level <= 100) return Math.floor((memTotalMb() * level) / 100);
  return vmStatAvailableMb(spawnSync("vm_stat", [], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }).stdout ?? "");
}

/** Páginas livres + inativas + especulativas da saída do `vm_stat`, em MB; 0 sem o tamanho de página. */
export function vmStatAvailableMb(text: string): number {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 0);
  const pages = (label: string) => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  return Math.floor(((pages("free") + pages("inactive") + pages("speculative")) * pageSize) / MIB);
}

/** RAM total da máquina, em MB; 0 se não deu para ler. */
export function memTotalMb(): number {
  if (IS_LINUX) return Math.floor((meminfoKb("MemTotal") ?? 0) / 1024);
  const r = spawnSync(SYSCTL, ["-n", "hw.memsize"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  return Math.floor(Number((r.stdout ?? "").trim() || 0) / MIB);
}

/** Linha de comando do processo (argumentos separados por espaço), ou "" se ele sumiu. */
export function procCmdline(pid: number): string {
  if (IS_LINUX) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    } catch {
      return "";
    }
  }
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}

export interface Listener {
  port: number;
  pid: string;
  name: string;
}

const LISTEN_TIMEOUT_MS = 10_000;

/** A ferramenta que lista as portas em LISTEN nesta plataforma: `ss` no Linux, `netstat` no macOS. */
export const LISTENERS_TOOL = IS_LINUX ? "ss" : "netstat";

/** A ferramenta do tcpListeners existe: o `ss` no PATH, ou o netstat em /usr/sbin. */
export function listenersToolPresent(): boolean {
  return IS_LINUX ? which("ss") !== undefined : existsSync(NETSTAT);
}

/**
 * Sockets TCP em LISTEN, ou undefined se não deu para listar (ferramenta falhou ou estourou o tempo). Linux: `ss -Hltnp`
 * (pid e nome só dos processos que o usuário enxerga). macOS: `netstat -anv`, que lista os sockets de todos os usuários
 * com o pid (o `lsof` sem root nem mostra os sockets dos processos de outro usuário).
 */
export function tcpListeners(): Listener[] | undefined {
  const r = IS_LINUX ? run("ss", ["-Hltnp"], { timeoutMs: LISTEN_TIMEOUT_MS }) : run(NETSTAT, ["-anv", "-p", "tcp"], { timeoutMs: LISTEN_TIMEOUT_MS });
  if (r.timedOut || r.status !== 0) return undefined;
  return IS_LINUX ? parseSsListeners(r.stdout) : parseNetstatListeners(r.stdout);
}

/** Saída do `ss -Hltnp`: endereço local na 4ª coluna, `users:(("nome",pid=N,…))` quando o processo é visível. */
export function parseSsListeners(text: string): Listener[] {
  const found: Listener[] = [];
  for (const line of text.split("\n")) {
    const addr = line.split(/\s+/).filter(Boolean)[3] ?? "";
    const port = addr.slice(addr.lastIndexOf(":") + 1);
    if (!/^[0-9]+$/.test(port)) continue;
    found.push({ port: Number(port), pid: /pid=([0-9]+)/.exec(line)?.[1] ?? "", name: /\(\("([^"]+)"/.exec(line)?.[1] ?? "" });
  }
  return found;
}

/**
 * Saída do `netstat -anv -p tcp` do macOS. O cabeçalho dá a coluna `process:pid`; ela é contada a partir do fim, porque
 * o nome do processo (até 16 caracteres) pode ter espaço. Endereço local na 4ª coluna, porta depois do último ponto.
 */
export function parseNetstatListeners(text: string): Listener[] {
  const lines = text.split("\n");
  const header = lines.find((l) => l.startsWith("Proto"))?.split(/\s+/).filter(Boolean) ?? [];
  const col = header.indexOf("process:pid");
  const after = col < 0 ? -1 : header.length - 1 - col;
  const found: Listener[] = [];
  for (const line of lines) {
    const f = line.split(/\s+/).filter(Boolean);
    if (!f[0]?.startsWith("tcp") || f[5] !== "LISTEN") continue;
    const addr = f[3] ?? "";
    const port = addr.slice(addr.lastIndexOf(".") + 1);
    if (!/^[0-9]+$/.test(port)) continue;
    const owner = after < 0 ? "" : f.slice(10, f.length - after).join(" ");
    const m = /^(.*):([0-9]+)$/.exec(owner);
    found.push({ port: Number(port), pid: m?.[2] ?? "", name: m?.[1] ?? "" });
  }
  return found;
}
