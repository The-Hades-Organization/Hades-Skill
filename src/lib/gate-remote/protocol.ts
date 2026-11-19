// Protocolo entre o `gate-lock` local e o `hades worker exec` (a chave SSH do worker força esse comando; o que o
// cliente pediu chega em SSH_ORIGINAL_COMMAND). Tudo aqui é puro: valida na fronteira, não toca disco nem processo.
//
// Regras que este módulo garante: a lista de subcomandos é fechada; o job é JSON validado campo a campo; o caminho do
// job fica contido em $HOME; nenhum argumento vira shell (o worker roda `argv` direto, nunca por `sh -c`).
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { specFor } from "../gate.ts";

export const PROTOCOL_VERSION = 1;
export const WORKER_COMMANDS = ["exec", "status", "warm", "out", "gc", "git-receive-pack"] as const;
export type WorkerCommandName = (typeof WORKER_COMMANDS)[number];

/** Rc que o gate-lock já usa para "não rodou" (EX_TEMPFAIL, sysexits.h). */
export const RC_NOT_RUN = 75;
export const REASON_LOST = "remoto perdido";
export const REASON_OUT = "retorno de --out falhou";
export const REASON_TOOL = "worker sem ferramenta no PATH do ssh não interativo";
export const REASON_DISK = "worker sem disco";
export const REASON_MEM = "memória livre do worker abaixo do mínimo da etapa";
const JOB_MAX_BYTES = 256 * 1024;
const ARGV_MAX = 256;
const ARG_MAX_BYTES = 32 * 1024;
const OUT_MAX = 64;
const ENV_MAX = 32;
const ENV_VALUE_MAX_BYTES = 4096;
const COST_MAX_GB = 128;
const TIMEOUT_MAX_S = 86_400;
const PRIORITY_MAX = 9;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Nome de host aceito: alias do ~/.ssh/config ou `usuario@host`. Nunca começa por `-` (viraria opção do ssh). */
export const HOST_PATTERN = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SLUG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const STACK_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const STEP_PATTERN = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Nome de variável que atravessa para o build remoto: forma de variável de ambiente e nunca cara de segredo. */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_NAME = /token|secret|passw(?:or)?d|passwd|senha|api_?key|apikey|credential|private_?key/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function isHost(value: string): boolean {
  return HOST_PATTERN.test(value);
}

// --- trabalhadores declarados (HADES_GATE_WORKERS: `host[:rótulo+rótulo],…`) ---

export interface WorkerSpec {
  host: string;
  labels: string[];
}

/** Lista de workers da configuração; entrada malformada vira erro (config errada não pode despachar para lugar nenhum). */
export function parseWorkers(raw: string): WorkerSpec[] {
  const workers: WorkerSpec[] = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const colon = part.indexOf(":");
    const host = colon < 0 ? part : part.slice(0, colon);
    const labels = colon < 0 ? [] : part.slice(colon + 1).split("+").filter(Boolean);
    if (!isHost(host)) throw new ProtocolError(`HADES_GATE_WORKERS: host inválido '${host}'`);
    for (const label of labels) if (!LABEL_PATTERN.test(label)) throw new ProtocolError(`HADES_GATE_WORKERS: rótulo inválido '${label}'`);
    workers.push({ host, labels });
  }
  return workers;
}

// --- caminhos ---

/** Caminho absoluto, normalizado, sem `..` e dentro de `home`. `home` em si não vale (o job mora numa árvore, não na raiz). */
export function containedInHome(path: string, home: string): boolean {
  if (!isAbsolute(path) || CONTROL.test(path) || path.endsWith(sep) || normalize(path) !== path) return false;
  const rel = relative(home, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Caminho relativo seguro (`subdir` do job, arquivos de `--out` relativos): sem `..`, sem raiz, sem controle. */
export function safeRelative(path: string): boolean {
  if (path === "") return true;
  return !isAbsolute(path) && !CONTROL.test(path) && !path.split("/").some((part) => part === ".." || part === "");
}

// --- job ---

export interface Job {
  v: number;
  /** token de uma execução; vai no trailer para o cliente reconhecer o fim do próprio job */
  nonce: string;
  id: string;
  /** owner__repo (ou _maquina): nome do espelho no worker */
  repo: string;
  sha: string;
  /** raiz do worktree, caminho absoluto igual ao do cliente */
  cwd: string;
  /** subdiretório (relativo à raiz) onde o comando roda */
  subdir: string;
  kind: string;
  label: string;
  cost: number;
  /** folga de memória sobre o custo; -1 = a do próprio worker */
  headroom: number;
  timeout: number;
  priority: number;
  step: string;
  /** stack do pacote do worker que declara o aquecimento ("" = sem aquecimento) */
  stack: string;
  argv: string[];
  /** arquivos a devolver: absolutos dentro de $HOME */
  out: string[];
  /** `--where <host>` explícito: o worker aquece na hora se estiver frio; no `auto` o frio nunca chega aqui */
  warmInline: boolean;
  /** `--fresh`: arquivo (relativo a cada diretório de `--out`) que o build tem de ter regravado ("" = sem conferência) */
  fresh: string;
  /** entradas de build declaradas na stack (`remote.passEnv`): o worker só aceita nome que a stack dele permite */
  env: Record<string, string>;
}

function str(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new ProtocolError(`job: campo '${field}' inválido`);
  return value;
}

/** Folga pedida pelo job, limitada à memória do worker (custo + folga + 1 GB para o sistema cabem no total); undefined = a do worker. */
export function workerHeadroomGb(requested: number, costGb: number, totalGb: number): number | undefined {
  if (requested < 0) return undefined;
  return Math.max(0, Math.min(requested, Math.floor(totalGb) - costGb - 1));
}

function int(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ProtocolError(`job: campo '${field}' fora de ${min}..${max}`);
  return value;
}

function stringList(value: unknown, field: string, max: number, accept: (item: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length > max) throw new ProtocolError(`job: campo '${field}' inválido`);
  return value.map((item) => {
    if (typeof item !== "string" || item.includes("\0") || Buffer.byteLength(item) > ARG_MAX_BYTES || !accept(item)) throw new ProtocolError(`job: item de '${field}' inválido`);
    return item;
  });
}

/** Valida o objeto do job; qualquer campo fora do esperado derruba o job (nada passa "porque parece certo"). */
export function validateJob(raw: unknown, home: string): Job {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ProtocolError("job: esperado objeto");
  const j = raw as Record<string, unknown>;
  if (j.v !== PROTOCOL_VERSION) throw new ProtocolError(`job: protocolo ${String(j.v)} (esperado ${PROTOCOL_VERSION})`);
  const cwd = typeof j.cwd === "string" ? j.cwd : "";
  if (!containedInHome(cwd, home)) throw new ProtocolError("job: cwd fora de $HOME");
  const subdir = typeof j.subdir === "string" ? j.subdir : "";
  if (!safeRelative(subdir)) throw new ProtocolError("job: subdir inválido");
  const kind = typeof j.kind === "string" ? j.kind : "";
  if (specFor(kind) === undefined) throw new ProtocolError("job: kind inválido");
  const step = typeof j.step === "string" ? j.step : "";
  if (step !== "" && !STEP_PATTERN.test(step)) throw new ProtocolError("job: etapa inválida");
  const stack = typeof j.stack === "string" ? j.stack : "";
  if (stack !== "" && !STACK_PATTERN.test(stack)) throw new ProtocolError("job: stack inválida");
  const argv = stringList(j.argv, "argv", ARGV_MAX, () => true);
  if (argv.length === 0 || argv[0] === "") throw new ProtocolError("job: argv vazio");
  return {
    v: PROTOCOL_VERSION,
    nonce: str(j.nonce, "nonce", NONCE_PATTERN),
    id: str(j.id, "id", ID_PATTERN),
    repo: str(j.repo, "repo", SLUG_PATTERN),
    sha: str(j.sha, "sha", SHA_PATTERN),
    cwd,
    subdir,
    kind,
    label: str(j.label, "label", /^[^\u0000-\u001f\u007f]{1,200}$/),
    cost: int(j.cost, "cost", 0, COST_MAX_GB),
    headroom: j.headroom === undefined ? -1 : int(j.headroom, "headroom", -1, COST_MAX_GB),
    timeout: int(j.timeout, "timeout", 0, TIMEOUT_MAX_S),
    priority: int(j.priority, "priority", -PRIORITY_MAX, PRIORITY_MAX),
    step,
    stack,
    argv,
    out: stringList(j.out, "out", OUT_MAX, (item) => containedInHome(item, home)),
    warmInline: j.warmInline === true,
    fresh: j.fresh === undefined ? "" : typeof j.fresh === "string" && safeRelative(j.fresh) ? j.fresh : fail("job: campo 'fresh' inválido"),
    env: envMap(j.env),
  };
}

function fail(message: string): never {
  throw new ProtocolError(message);
}

/** `env` do job: objeto nome→valor, nomes em forma de variável e sem cara de segredo, tamanho limitado. */
function envMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("job: campo 'env' inválido");
  const entries = Object.entries(value);
  if (entries.length > ENV_MAX) return fail("job: variáveis demais em 'env'");
  const out: Record<string, string> = {};
  for (const [name, v] of entries) {
    if (!ENV_NAME_PATTERN.test(name) || isSecretName(name)) return fail(`job: variável '${name.slice(0, 40)}' não pode atravessar`);
    if (typeof v !== "string" || v.includes("\0") || Buffer.byteLength(v) > ENV_VALUE_MAX_BYTES) return fail(`job: valor de '${name}' inválido`);
    out[name] = v;
  }
  return out;
}

export function encodePayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodePayload(encoded: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > JOB_MAX_BYTES * 2) throw new ProtocolError("payload: base64url inválido");
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new ProtocolError("payload: JSON inválido");
  }
}

// --- comando recebido (SSH_ORIGINAL_COMMAND) ---

export interface WarmRequest {
  v: number;
  id: string;
  repo: string;
  sha: string;
  cwd: string;
  stack: string;
}

export interface OutRequest {
  v: number;
  cwd: string;
  files: string[];
  /** id do job: o worker lê o início dele para o manifesto (relógio do worker) */
  id: string;
  /** false = só os arquivos (o job falhou: diretório de build não se promove, então nem viaja) */
  dirs: boolean;
}

/** Pedido de limpeza do worker: libera `freeGb` ou todas as worktrees ociosas (`allIdle`); exatamente um dos dois. */
export interface GcRequest {
  freeGb: number | undefined;
  allIdle: boolean;
  keepWarm: boolean;
  dryRun: boolean;
}

const GC_FREE_GB_MAX = 100_000;

/** Linha do comando `gc` como o cliente a envia (a inversa de `gcRequest`). */
export function gcCommandLine(request: GcRequest): string {
  const parts = ["gc", request.allIdle ? "--all-idle" : `--free-gb ${request.freeGb ?? 0}`];
  if (request.keepWarm) parts.push("--keep-warm");
  if (request.dryRun) parts.push("--dry-run");
  return parts.join(" ");
}

/** Argumentos do `gc` (depois do nome): lista fechada de opções, sem payload; o `gc` roda sem escrever, então a validação é só esta. */
export function gcRequest(args: readonly string[]): GcRequest {
  let freeGb: number | undefined;
  let allIdle = false;
  let keepWarm = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--all-idle") allIdle = true;
    else if (arg === "--keep-warm") keepWarm = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--free-gb") {
      const raw = args[i + 1] ?? "";
      if (!/^[0-9]{1,6}$/.test(raw) || Number(raw) < 1 || Number(raw) > GC_FREE_GB_MAX) throw new ProtocolError(`gc: --free-gb exige inteiro de 1 a ${GC_FREE_GB_MAX}`);
      freeGb = Number(raw);
      i += 1;
    } else throw new ProtocolError(`gc: opção fora da lista: ${String(arg).slice(0, 40)}`);
  }
  if (allIdle === (freeGb !== undefined)) throw new ProtocolError("gc: use --free-gb N ou --all-idle (um dos dois)");
  return { freeGb, allIdle, keepWarm, dryRun };
}

export type WorkerRequest =
  | { kind: "status" }
  | { kind: "gc"; request: GcRequest }
  | { kind: "exec"; job: Job }
  | { kind: "warm"; request: WarmRequest }
  | { kind: "out"; request: OutRequest }
  | { kind: "receive-pack"; path: string };

/** Espelho do worker: onde o `git push` aterrissa. Fica sob $HOME, nunca num caminho que o cliente escolha. */
export const MIRROR_SUBPATH = join(".cache", "hades-worker", "mirror");

export function mirrorPath(home: string, repo: string): string {
  return join(home, MIRROR_SUBPATH, `${repo}.git`);
}

function warmRequest(raw: unknown, home: string): WarmRequest {
  const j = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (j.v !== PROTOCOL_VERSION) throw new ProtocolError("warm: protocolo inválido");
  const cwd = typeof j.cwd === "string" ? j.cwd : "";
  if (!containedInHome(cwd, home)) throw new ProtocolError("warm: cwd fora de $HOME");
  return { v: PROTOCOL_VERSION, id: str(j.id, "id", ID_PATTERN), repo: str(j.repo, "repo", SLUG_PATTERN), sha: str(j.sha, "sha", SHA_PATTERN), cwd, stack: str(j.stack, "stack", STACK_PATTERN) };
}

function outRequest(raw: unknown, home: string): OutRequest {
  const j = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (j.v !== PROTOCOL_VERSION) throw new ProtocolError("out: protocolo inválido");
  const cwd = typeof j.cwd === "string" ? j.cwd : "";
  if (!containedInHome(cwd, home)) throw new ProtocolError("out: cwd fora de $HOME");
  const id = typeof j.id === "string" && j.id !== "" ? str(j.id, "id", ID_PATTERN) : "";
  return { v: PROTOCOL_VERSION, cwd, id, dirs: j.dirs !== false, files: stringList(j.files, "files", OUT_MAX, (item) => containedInHome(item, home)) };
}

const RECEIVE_PACK = /^git-receive-pack '([^'\\!\u0000-\u001f]+)'$/;

/** Interpreta o que o cliente pediu. Qualquer coisa fora da lista fechada é erro: o worker não executa texto livre. */
export function parseWorkerCommand(original: string, home: string): WorkerRequest {
  if (original.length === 0 || original.length > JOB_MAX_BYTES * 2 || CONTROL.test(original)) throw new ProtocolError("comando vazio ou inválido");
  const pack = RECEIVE_PACK.exec(original);
  if (pack) {
    const path = pack[1] as string;
    const root = join(home, MIRROR_SUBPATH);
    if (!containedInHome(path, root) || !path.endsWith(".git") || path.slice(root.length + 1).includes("/")) throw new ProtocolError("receive-pack: fora do espelho");
    return { kind: "receive-pack", path };
  }
  const parts = original.split(" ");
  if (parts[0] === "gc") return { kind: "gc", request: gcRequest(parts.slice(1)) };
  const [name, arg, ...extra] = parts;
  if (!(WORKER_COMMANDS as readonly string[]).includes(name ?? "") || extra.length > 0) throw new ProtocolError(`subcomando fora da lista: ${(name ?? "").slice(0, 40)}`);
  if (name === "status") {
    if (arg !== undefined && arg !== "--json") throw new ProtocolError("status: só aceita --json");
    return { kind: "status" };
  }
  if (arg === undefined) throw new ProtocolError(`${name}: falta o payload`);
  const payload = decodePayload(arg);
  if (name === "exec") return { kind: "exec", job: validateJob(payload, home) };
  if (name === "warm") return { kind: "warm", request: warmRequest(payload, home) };
  if (name === "out") return { kind: "out", request: outRequest(payload, home) };
  throw new ProtocolError(`subcomando fora da lista: ${name}`);
}

// --- trailer: como o cliente sabe que o job terminou e com qual rc ---

const TRAILER_START = "\u0001hades-worker-end ";
const TRAILER_END = "\u0002";

export interface Trailer {
  rc: number;
  peakMb: number | undefined;
  host: string;
  durS: number;
}

export function formatTrailer(nonce: string, trailer: Trailer): string {
  return `${TRAILER_START}${nonce} rc=${trailer.rc} peak=${trailer.peakMb ?? "-"} dur=${trailer.durS} host=${trailer.host}${TRAILER_END}`;
}

const TRAILER_BODY = /^([0-9a-f]{32}) rc=(\d{1,3}) peak=(\d+|-) dur=(\d+) host=(\S{1,255})$/;

/**
 * Filtra o stderr vindo do worker: repassa tudo ao terminal, menos o trailer do próprio job (o nonce só o cliente e o
 * worker conhecem, então a saída do job não o forja). Só segura o trecho a partir de um `\x01` ainda sem fim.
 */
export class TrailerFilter {
  private pending = "";
  trailer: Trailer | undefined;

  private readonly nonce: string;

  constructor(nonce: string) {
    this.nonce = nonce;
  }

  /** Texto a repassar para este pedaço. */
  push(chunk: string): string {
    this.pending += chunk;
    let out = "";
    for (;;) {
      const start = this.pending.indexOf("\u0001");
      if (start < 0) {
        out += this.pending;
        this.pending = "";
        return out;
      }
      const end = this.pending.indexOf(TRAILER_END, start);
      if (end < 0) {
        out += this.pending.slice(0, start);
        this.pending = this.pending.slice(start);
        return out;
      }
      const candidate = this.pending.slice(start, end + 1);
      const parsed = this.parse(candidate);
      out += this.pending.slice(0, start) + (parsed ? "" : candidate);
      this.pending = this.pending.slice(end + 1);
    }
  }

  /** O que sobrou quando o fluxo acabou (trecho aberto sem fim não é trailer: vai ao terminal). */
  flush(): string {
    const rest = this.pending;
    this.pending = "";
    return rest;
  }

  private parse(candidate: string): boolean {
    if (!candidate.startsWith(TRAILER_START) || !candidate.endsWith(TRAILER_END)) return false;
    const match = TRAILER_BODY.exec(candidate.slice(TRAILER_START.length, -TRAILER_END.length));
    if (!match || match[1] !== this.nonce) return false;
    this.trailer = { rc: Number(match[2]), peakMb: match[3] === "-" ? undefined : Number(match[3]), durS: Number(match[4]), host: match[5] as string };
    return true;
  }
}

// --- tradução de rc ---

export interface Outcome {
  rc: number;
  /** motivo humano quando o job não rodou até o fim; vai ao journal e ao stderr */
  reason: string | undefined;
  peakMb: number | undefined;
  host: string | undefined;
}

/**
 * Do que o cliente observou para o rc do `gate-lock`. Sem trailer o job não terminou do ponto de vista de quem
 * espera (conexão caiu, worker morreu): 75 "não rodou", nunca 0, e nada vira verde por engano. Rc 0 só vale se os
 * arquivos de `--out` também voltaram.
 */
export function translateRc(trailer: Trailer | undefined, outFailed: boolean): Outcome {
  if (trailer === undefined) return { rc: RC_NOT_RUN, reason: REASON_LOST, peakMb: undefined, host: undefined };
  if (trailer.rc === 0 && outFailed) return { rc: RC_NOT_RUN, reason: REASON_OUT, peakMb: trailer.peakMb, host: trailer.host };
  return { rc: trailer.rc, reason: undefined, peakMb: trailer.peakMb, host: trailer.host };
}
