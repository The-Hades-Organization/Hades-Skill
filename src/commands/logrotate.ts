// Rotação dos logs do Hades ($D/logs/*.log), por copiar + truncar (hades logrotate).
//
// As units abrem o arquivo com StandardOutput=append: (O_APPEND), então o arquivo não pode ser renomeado (o fd
// seguiria escrevendo no .1) e sim copiado e truncado: o fd continua no mesmo inode e a próxima escrita cai no início.
// A janela de perda é o intervalo entre a última conferência de tamanho e o ftruncate (microssegundos, no mesmo
// processo). Arquivo aberto por alguém SEM O_APPEND (um `> arquivo` de shell) não se trunca: a próxima escrita
// deixaria um buraco de bytes nulos; fica na lista de pulados.
//
// Política (chaves HADES_CLEAN_* do config.tsv, já exportadas pelo env.sh):
//   - arquivo acima do teto (o do grupo de prioridade é menor) vira <nome>.1.gz; as gerações antigas descem
//     (.1 → .2 …) e passam de HADES_CLEAN_LOG_KEEP somem;
//   - passou do teto total de logs/ (vivos + gerações): apaga as gerações mais antigas; se ainda passar, rotaciona
//     o maior arquivo vivo, mesmo abaixo do teto dele.
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { EXIT, die, out } from "../lib/output.ts";
import { kitDir, pyJsonDumps } from "../lib/kit.ts";

const O_APPEND = 0o2000;
const O_ACCMODE = 0o3;
const MIB = 1048576;
const CHUNK_BYTES = 8 << 20;
const GZIP_LEVEL = 6;
const MIN_ROTATE_BYTES = MIB;
const UNITS: Record<string, number> = { G: 1024 ** 3, M: MIB, K: 1024 };

interface Policy {
  cap: number;
  prioCap: number;
  total: number;
  keep: number;
  prio: string[];
}

interface Action {
  file: string;
  action: "rotaciona" | "apaga";
  bytes: number;
  why: string;
}

interface Skipped {
  file: string;
  why: string;
}

interface Live {
  path: string;
  name: string;
  cap: number;
  size: number;
}

function sizeOf(value: string): number {
  const unit = UNITS[value.slice(-1)];
  const count = Number(value.slice(0, -1));
  if (unit === undefined || value.length < 2 || !Number.isInteger(count)) return die(`logrotate: tamanho inválido '${value}' (use <n>K|M|G)`, EXIT.fail);
  return count * unit;
}

function intOf(name: string, fallback: string): number {
  const raw = process.env[name] ?? fallback;
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) return die(`logrotate: ${name} inválido '${raw}' (inteiro)`, EXIT.fail);
  return Number(raw);
}

function policy(): Policy {
  const env = (name: string, fallback: string): string => process.env[name] ?? fallback;
  return {
    cap: sizeOf(env("HADES_CLEAN_LOG_MAX", "50M")),
    prioCap: sizeOf(env("HADES_CLEAN_PRIO_LOG_MAX", "20M")),
    total: sizeOf(env("HADES_CLEAN_LOG_TOTAL", "500M")),
    keep: intOf("HADES_CLEAN_LOG_KEEP", "3"),
    prio: env("HADES_CLEAN_PRIO_LOGS", "").split(",").filter(Boolean),
  };
}

/** fnmatch do Python: `*`, `?`, `[seq]` e `[!seq]`, sensível a maiúsculas (como no Linux). */
function fnmatch(name: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") re += "[\\s\\S]*";
    else if (c === "?") re += "[\\s\\S]";
    else if (c === "[") {
      const close = pattern.indexOf("]", i + (pattern[i + 1] === "!" || pattern[i + 1] === "]" ? 2 : 1));
      if (close < 0) re += "\\[";
      else {
        const body = pattern.slice(i + 1, close);
        const negate = body.startsWith("!");
        re += `[${negate ? "^" : ""}${(negate ? body.slice(1) : body).replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(name);
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** PIDs com o arquivo aberto para escrita sem O_APPEND (o /proc só mostra os do próprio usuário). */
function writersWithoutAppend(path: string): number[] {
  const bad: number[] = [];
  let target;
  try {
    target = statSync(path, { bigint: true });
  } catch {
    return bad;
  }
  // Sem /proc (macOS) não há como ver as flags de quem tem o arquivo aberto: segue como o copytruncate do logrotate, sem a checagem.
  if (!existsSync("/proc")) return bad;
  for (const pid of readdirSync("/proc").filter((n) => /^\d/.test(n))) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const st = statSync(`/proc/${pid}/fd/${fd}`, { bigint: true });
        if (st.dev !== target.dev || st.ino !== target.ino) continue;
        const info = /flags:\s*(\d+)/.exec(readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8"));
        if (!info) continue;
        const flags = parseInt(info[1] as string, 8);
        if (flags & O_ACCMODE && !(flags & O_APPEND)) bad.push(Number(pid)); // O_WRONLY/O_RDWR sem append
      } catch {
        continue; // o fd sumiu ou não é nosso: não é escritor que se possa conferir
      }
    }
  }
  return bad;
}

const generation = (path: string, n: number): string => `${path}.${n}.gz`;

/** <nome>.N.gz sobe uma geração; a que passa de keep é apagada. */
function shift(path: string, keep: number): void {
  if (existsSync(generation(path, keep))) unlinkSync(generation(path, keep));
  for (let n = keep - 1; n > 0; n--) {
    if (existsSync(generation(path, n))) renameSync(generation(path, n), generation(path, n + 1));
  }
}

/** Copia o conteúdo para <nome>.1.gz e zera o arquivo sem perder o que foi escrito no meio. Devolve os bytes. */
function copyTruncate(path: string, keep: number): number {
  shift(path, keep);
  const tmp = `${path}.rot`;
  // um membro gzip por bloco (RFC 1952 admite vários em sequência; zcat e gzip -d leem como um só)
  const members: Buffer[] = [];
  const fd = openSync(path, "r+");
  let copied = 0;
  try {
    for (;;) {
      const size = fstatSync(fd).size;
      if (copied >= size) {
        // nada novo desde a última cópia: trunca agora, com o menor intervalo possível
        ftruncateSync(fd, 0);
        break;
      }
      const chunk = Buffer.alloc(Math.min(size - copied, CHUNK_BYTES));
      const read = readSync(fd, chunk, 0, chunk.length, copied);
      members.push(gzipSync(chunk.subarray(0, read), { level: GZIP_LEVEL }));
      copied += read;
    }
  } finally {
    closeSync(fd);
  }
  writeFileSync(tmp, members.length ? Buffer.concat(members) : gzipSync(Buffer.alloc(0), { level: GZIP_LEVEL }));
  renameSync(tmp, generation(path, 1));
  return copied;
}

const listLogs = (logs: string): string[] => {
  try {
    return readdirSync(logs);
  } catch {
    return [];
  }
};

function plan(logs: string, p: Policy): Live[] {
  const live: Live[] = [];
  for (const name of listLogs(logs).filter((n) => n.endsWith(".log")).sort(byName)) {
    const path = join(logs, name);
    if (!isFile(path)) continue;
    const stem = name.slice(0, -".log".length);
    const prio = p.prio.some((g) => fnmatch(stem, g));
    live.push({ path, name, cap: prio ? p.prioCap : p.cap, size: statSync(path).size });
  }
  return live;
}

/** Tamanho em MB com uma casa, arredondado como o `{:.1f}` do Python (meio exato vai para o par). */
function mb1(bytes: number): string {
  const tenths = bytes * 10;
  let q = Math.floor(tenths / MIB);
  const twice = (tenths % MIB) * 2;
  if (twice > MIB || (twice === MIB && q % 2 === 1)) q += 1;
  return `${Math.floor(q / 10)}.${q % 10}`;
}

const genNumber = (name: string): number => {
  const n = Number(name.split(".").slice(-2)[0]);
  return Number.isInteger(n) ? n : die(`logrotate: geração com nome inesperado: ${name}`, EXIT.fail);
};

export function logrotateCommand(args: string[]): number {
  const dry = args.includes("--dry-run");
  const p = policy();
  const logs = join(process.env.HADES_DATA || kitDir(), "logs");
  const acts: Action[] = [];
  const skipped: Skipped[] = [];
  let freed = 0;

  const rotate = (path: string, name: string, why: string): void => {
    const size = statSync(path).size;
    const bad = writersWithoutAppend(path);
    if (bad.length) {
      skipped.push({ file: name, why: `aberto sem O_APPEND (pid ${bad[0]})` });
      return;
    }
    acts.push({ file: name, action: "rotaciona", bytes: size, why });
    if (!dry) copyTruncate(path, p.keep);
    freed += size;
  };

  for (const live of plan(logs, p)) {
    if (live.size > live.cap) rotate(live.path, live.name, `${Math.floor(live.size / MIB)} MB > teto ${Math.floor(live.cap / MIB)} MB`);
  }

  // gerações a mais (keep reduzido nas Configurações) e teto total
  const total = (): number =>
    listLogs(logs)
      .filter((n) => n.includes(".log") && !n.endsWith(".rot") && isFile(join(logs, n)))
      .reduce((sum, n) => sum + statSync(join(logs, n)).size, 0);
  const generations = (): string[] => listLogs(logs).filter((n) => /^.*\.log\..*\.gz$/.test(n)).sort(byName);

  for (const name of generations()) {
    const m = /^(.+\.log)\.(\d+)\.gz$/.exec(name);
    if (m && Number(m[2]) > p.keep) {
      const bytes = statSync(join(logs, name)).size;
      acts.push({ file: name, action: "apaga", bytes, why: "geração além do limite" });
      freed += bytes;
      if (!dry) unlinkSync(join(logs, name));
    }
  }
  const rotated = new Map(acts.filter((a) => a.action === "rotaciona").map((a) => [a.file, a.bytes]));
  // no --dry-run nada mudou em disco: projeta o total subtraindo o que sairia
  let projected = total() - (dry ? acts.reduce((sum, a) => sum + a.bytes, 0) : 0);
  if (projected > p.total) {
    const old = generations()
      .filter((n) => isFile(join(logs, n)))
      .map((n) => ({ n, gen: genNumber(n), mtime: statSync(join(logs, n)).mtimeMs }))
      .sort((a, b) => b.gen - a.gen || a.mtime - b.mtime);
    for (const { n } of old) {
      if (projected <= p.total) break;
      if (acts.some((a) => a.file === n)) continue;
      const bytes = statSync(join(logs, n)).size;
      projected -= bytes;
      acts.push({ file: n, action: "apaga", bytes, why: `teto total ${Math.floor(p.total / MIB)} MB` });
      freed += bytes;
      if (!dry) unlinkSync(join(logs, n));
    }
    for (const live of plan(logs, p).sort((a, b) => b.size - a.size)) {
      if (projected <= p.total) break;
      if (rotated.has(live.name) || live.size < MIN_ROTATE_BYTES) continue;
      rotate(live.path, live.name, `teto total ${Math.floor(p.total / MIB)} MB`);
      projected -= live.size;
    }
  }

  if (args.includes("--json")) {
    out(pyJsonDumps({ actions: acts, skipped, freed, dry }));
    return EXIT.ok;
  }
  for (const a of acts) out(`${dry ? "[dry-run] " : ""}${a.action.padEnd(9)} ${a.file.padEnd(40)} ${mb1(a.bytes).padStart(8)} MB  ${a.why}`);
  for (const s of skipped) out(`pulado    ${s.file.padEnd(40)} ${s.why}`);
  out(`${dry ? "liberaria" : "liberou"} ~${mb1(freed)} MB em ${acts.length} ação(ões)`);
  return EXIT.ok;
}
