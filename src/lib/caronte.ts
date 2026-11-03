// Caronte (reference/caronte.md): empacota uma orquestração (plano, registros, relatórios, worktrees) num arquivo
// cifrado para outra sessão ou máquina. O formato do pacote e do manifest.json é contrato do unpack: só cresce.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { isFile, listDir, readText } from "./fs.ts";
import { die } from "./output.ts";
import { secretPattern } from "./release-guard.ts";
import { planSha } from "../commands/agent.ts";
import { readJson, type Json, type WorkEnv } from "./work.ts";

export const FORMAT_VERSION = 1;
const MAGIC = Buffer.from("CARONTE\u0001", "latin1");
const IV_BYTES = 12;
const SALT_BYTES = 16;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const LEN_BYTES = 4;
const SIZE_BYTES = 8;
export const DEFAULT_LOG2N = 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** Teto dos parâmetros lidos do cabeçalho: um arquivo adulterado não pode pedir memória sem limite. */
const MAX_LOG2N = 22;
const MAX_HEADER_BYTES = 4096;
const MAX_PART_BYTES = 1 << 30;
const GIT_MAX_BUFFER = 1 << 30;
export const REPORT_FILES = ["brief.md", "handoff.md", "report.md", "questions.md", "quality.md"];
export const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SECRET_NAMES = [/^credenciais\.md$/i, /^\.env(\..+)?$/, /\.(pem|key|p12|pfx)$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/];
const ENV_EXAMPLE = /^\.env\.(example|sample)$/;

export type CaronteErrorCode = "wrong-password" | "tampered" | "not-a-package" | "unsupported";

export class CaronteError extends Error {
  readonly code: CaronteErrorCode;
  constructor(code: CaronteErrorCode, message: string) {
    super(message);
    this.name = "CaronteError";
    this.code = code;
  }
}

export interface Part {
  /** caminho lógico dentro do pacote */
  path: string;
  data: Buffer;
}

export interface WorktreeInfo {
  agent: string;
  /** caminho de origem */
  path: string;
  branch: string;
  head: string;
  baseRef: string;
  baseSha: string;
  /** caminhos lógicos das partes, ou null quando não há o que levar */
  bundle: string | null;
  patch: string | null;
}

export interface Finding {
  path: string;
  rule: "nome" | "conteudo";
}

export interface Plan {
  /** partes de `manifest.parts`, na ordem do pacote (sem o manifest.json) */
  parts: Part[];
  worktrees: WorktreeInfo[];
  findings: Finding[];
}

export interface Manifest {
  format: number;
  skillVersion: string;
  createdAt: string;
  workRoot: string;
  scope: "skill" | "project";
  repo: { remote: string; clone: string };
  plan: { path: string; name: string; approvedSha: string | null; sha: string };
  agents: string[];
  worktrees: WorktreeInfo[];
  parts: { path: string; size: number; sha256: string }[];
  withJournal: boolean;
  allowed: string[];
}

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/* ---------- cifra e contêiner ---------- */

interface Header {
  v: number;
  kdf: "scrypt";
  log2n: number;
  r: number;
  p: number;
  salt: string;
  cipher: "aes-256-gcm";
  iv: string;
}

function deriveKey(password: string, header: Pick<Header, "log2n" | "r" | "p">, salt: Buffer): Buffer {
  const cost = 2 ** header.log2n;
  return scryptSync(password.normalize("NFKC"), salt, KEY_BYTES, { N: cost, r: header.r, p: header.p, maxmem: 256 * cost * header.r });
}

/** Contêiner: [u32 tamanho do nome][nome][u64 tamanho][bytes] por parte, o manifest.json sempre a primeira. */
export function frame(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const name = Buffer.from(part.path, "utf8");
    const nameLen = Buffer.alloc(LEN_BYTES);
    nameLen.writeUInt32BE(name.length);
    const size = Buffer.alloc(SIZE_BYTES);
    size.writeBigUInt64BE(BigInt(part.data.length));
    chunks.push(nameLen, name, size, part.data);
  }
  return Buffer.concat(chunks);
}

export function unframe(raw: Buffer): Part[] {
  const parts: Part[] = [];
  let at = 0;
  const need = (bytes: number): void => {
    if (bytes < 0 || at + bytes > raw.length) throw new CaronteError("tampered", "contêiner truncado ou adulterado");
  };
  while (at < raw.length) {
    need(LEN_BYTES);
    const nameLen = raw.readUInt32BE(at);
    at += LEN_BYTES;
    need(nameLen);
    const path = raw.subarray(at, at + nameLen).toString("utf8");
    at += nameLen;
    need(SIZE_BYTES);
    const size = raw.readBigUInt64BE(at);
    at += SIZE_BYTES;
    if (size > BigInt(MAX_PART_BYTES)) throw new CaronteError("tampered", `parte ${path} acima do teto`);
    need(Number(size));
    parts.push({ path, data: Buffer.from(raw.subarray(at, at + Number(size))) });
    at += Number(size);
  }
  return parts;
}

/** Arquivo: MAGIC | u32 tamanho do cabeçalho | cabeçalho JSON | texto cifrado (gzip do contêiner) | tag GCM. */
export function encryptPackage(parts: Part[], password: string, log2n: number = DEFAULT_LOG2N): Buffer {
  if (!password) die("senha vazia: sem senha, sem pacote");
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header: Header = { v: FORMAT_VERSION, kdf: "scrypt", log2n, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString("base64"), cipher: "aes-256-gcm", iv: iv.toString("base64") };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const headerLen = Buffer.alloc(LEN_BYTES);
  headerLen.writeUInt32BE(headerBytes.length);
  const aad = Buffer.concat([MAGIC, headerLen, headerBytes]);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(password, header, salt), iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(gzipSync(frame(parts))), cipher.final()]);
  return Buffer.concat([aad, body, cipher.getAuthTag()]);
}

function readHeader(file: Buffer): { header: Header; aad: Buffer; body: Buffer; tag: Buffer } {
  if (file.length < MAGIC.length + LEN_BYTES + TAG_BYTES || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new CaronteError("not-a-package", "não é um pacote do Caronte");
  }
  const headerLen = file.readUInt32BE(MAGIC.length);
  const end = MAGIC.length + LEN_BYTES + headerLen;
  if (headerLen > MAX_HEADER_BYTES || end + TAG_BYTES > file.length) throw new CaronteError("tampered", "cabeçalho do pacote inválido");
  let header: Header;
  try {
    header = JSON.parse(file.subarray(MAGIC.length + LEN_BYTES, end).toString("utf8")) as Header;
  } catch {
    throw new CaronteError("tampered", "cabeçalho do pacote ilegível");
  }
  if (header.v > FORMAT_VERSION) throw new CaronteError("unsupported", `formato ${header.v} é mais novo que o desta skill (${FORMAT_VERSION}): atualize a Hades`);
  const sane = header.kdf === "scrypt" && header.cipher === "aes-256-gcm" && Number.isInteger(header.log2n) && header.log2n >= 1 && header.log2n <= MAX_LOG2N
    && header.r === SCRYPT_R && header.p === SCRYPT_P && typeof header.salt === "string" && typeof header.iv === "string";
  if (!sane) throw new CaronteError("unsupported", "parâmetros de cifra do pacote não suportados");
  return { header, aad: file.subarray(0, end), body: file.subarray(end, file.length - TAG_BYTES), tag: file.subarray(file.length - TAG_BYTES) };
}

/** Decifra e desfaz o contêiner. GCM não distingue senha errada de arquivo adulterado: a mensagem diz as duas. */
export function decryptPackage(file: Buffer, password: string): Part[] {
  const { header, aad, body, tag } = readHeader(file);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(password, header, Buffer.from(header.salt, "base64")), Buffer.from(header.iv, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new CaronteError("wrong-password", "senha errada ou pacote adulterado (a autenticação GCM falhou)");
  }
  return unframe(gunzipSync(plain));
}

/** Confere cada parte contra o manifest.json; devolve o manifesto lido. */
export function verifyParts(parts: Part[]): Manifest {
  const first = parts[0];
  if (!first || first.path !== "manifest.json") throw new CaronteError("tampered", "manifest.json ausente do pacote");
  const manifest = JSON.parse(first.data.toString("utf8")) as Manifest;
  if (!Array.isArray(manifest.parts)) throw new CaronteError("tampered", "manifest.json sem a lista de partes");
  const byPath = new Map(parts.map((p) => [p.path, p]));
  for (const entry of manifest.parts) {
    const part = byPath.get(entry.path);
    if (!part) throw new CaronteError("tampered", `parte ausente: ${entry.path}`);
    if (sha256(part.data) !== entry.sha256) throw new CaronteError("tampered", `sha256 não confere: ${entry.path}`);
  }
  return manifest;
}

/* ---------- guarda de segredo ---------- */

/** Nome que nunca entra (credencial, .env fora do exemplo, chave); a decisão é só pelo nome, o valor nem é lido. */
export function secretName(path: string): boolean {
  const name = basename(path);
  return !ENV_EXAMPLE.test(name) && SECRET_NAMES.some((re) => re.test(name));
}

let compiledSecret: RegExp | undefined;
const secretContent = (text: string): boolean => (compiledSecret ??= new RegExp(secretPattern())).test(text);

/** Achados de uma parte de texto; `path` é o caminho lógico e nunca o valor achado. */
export function scanText(path: string, text: string): Finding[] {
  const found: Finding[] = [];
  if (secretName(path)) found.push({ path, rule: "nome" });
  if (secretContent(text)) found.push({ path, rule: "conteudo" });
  return found;
}

/** Quebra um `git diff` em arquivos (`diff --git a/x b/x`): o achado nomeia o arquivo do repositório, não o patch inteiro. */
function scanDiff(prefix: string, diff: string): Finding[] {
  const found: Finding[] = [];
  for (const block of diff.split(/^diff --git /m)) {
    if (!block) continue;
    const file = /^a\/(.+?) b\//.exec(block)?.[1] ?? "?";
    found.push(...scanText(`${prefix}/${file}`, block));
  }
  return found;
}

/** `--allow` libera um caminho lógico (o do pacote ou worktrees/<agente>/<arquivo do repo>), por igualdade. */
export function applyAllow(findings: Finding[], allow: string[]): { blocked: Finding[]; allowed: string[] } {
  const blocked = findings.filter((f) => !allow.includes(f.path));
  const allowed = [...new Set(findings.filter((f) => allow.includes(f.path)).map((f) => f.path))];
  return { blocked, allowed };
}

/* ---------- git ---------- */

export function git(dir: string, args: string[], env: NodeJS.ProcessEnv = process.env, input?: Buffer): { status: number; stdout: Buffer; stderr: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { env, input, maxBuffer: GIT_MAX_BUFFER, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
  return { status: r.status ?? 1, stdout: r.stdout ?? Buffer.alloc(0), stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8") };
}

export const gitText = (dir: string, args: string[]): string => git(dir, args).stdout.toString("utf8").trim();

/** Não commitado: tracked + não rastreados, sem ignorados e sem a pasta de relatórios (que vai como parte própria), num índice temporário (o índice da worktree não é tocado). */
export function uncommittedPatch(worktree: string, reports: string): Buffer {
  const scratch = mkdtempSync(join(tmpdir(), "caronte-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    if (git(worktree, ["read-tree", "HEAD"], env).status !== 0) die(`git read-tree falhou em ${worktree}`, 1);
    // pasta ignorada já fica de fora do add -A; excluí-la por pathspec faz o git sair com 1 ("caminhos ignorados")
    const ignored = git(worktree, ["check-ignore", "-q", "--", `${reports}/`]).status === 0;
    const pathspec = ignored ? ["."] : [".", `:(exclude)${reports}`];
    if (git(worktree, ["add", "-A", "--", ...pathspec], env).status !== 0) die(`git add -A falhou em ${worktree}`, 1);
    const diff = git(worktree, ["diff", "--cached", "--binary", "--no-color", "HEAD"], env);
    if (diff.status !== 0) die(`git diff falhou em ${worktree}: ${diff.stderr.trim()}`, 1);
    return diff.stdout;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface Captured {
  info: WorktreeInfo;
  parts: Part[];
  findings: Finding[];
}

/** Uma worktree: bundle de base..HEAD (o não publicado) e o patch do não commitado; limpa e sem commit leva só a base. */
export function captureWorktree(agent: string, record: Json, reports: string): Captured {
  const path = String(record.worktree ?? "");
  if (!path || git(path, ["rev-parse", "--git-dir"]).status !== 0) die(`worktree de ${agent} não existe: ${path}`, 1);
  const baseRef = String(record.base ?? "") || "main";
  const head = gitText(path, ["rev-parse", "HEAD"]);
  const baseSha = gitText(path, ["merge-base", baseRef, "HEAD"]);
  if (!head || !baseSha) die(`${agent}: não achei a base ${baseRef} na worktree ${path}`, 1);
  const branch = gitText(path, ["branch", "--show-current"]);
  const parts: Part[] = [];
  const findings: Finding[] = [];
  const prefix = `worktrees/${agent}`;
  let bundle: string | null = null;
  if (head !== baseSha) {
    const scratch = mkdtempSync(join(tmpdir(), "caronte-bundle-"));
    try {
      const file = join(scratch, "commits.bundle");
      const made = git(path, ["bundle", "create", file, `${baseSha}..HEAD`]);
      if (made.status !== 0) die(`git bundle falhou em ${path}: ${made.stderr.trim()}`, 1);
      bundle = `${prefix}/commits.bundle`;
      parts.push({ path: bundle, data: readFileSync(file) });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    findings.push(...scanDiff(prefix, git(path, ["diff", "--binary", "--no-color", `${baseSha}..HEAD`]).stdout.toString("utf8")));
  }
  const diff = uncommittedPatch(path, reports);
  let patch: string | null = null;
  if (diff.length > 0) {
    patch = `${prefix}/uncommitted.patch`;
    parts.push({ path: patch, data: diff });
    findings.push(...scanDiff(prefix, diff.toString("utf8")));
  }
  return { info: { agent, path, branch, head, baseRef, baseSha, bundle, patch }, parts, findings };
}

/* ---------- o plano e seus agentes ---------- */

export interface AgentRecord {
  name: string;
  record: Json;
}

/** Agentes do registro da raiz ligados ao plano: os cujo nome aparece como palavra no texto do plano. */
export function linkedAgents(work: WorkEnv, planText: string): AgentRecord[] {
  const words = new Set(planText.match(/[A-Za-z0-9_-]+/g) ?? []);
  const agents: AgentRecord[] = [];
  for (const file of listDir(join(work.orch, "agents")).filter((n) => n.endsWith(".json"))) {
    const record = readJson(join(work.orch, "agents", file));
    const name = typeof record?.name === "string" ? record.name : "";
    if (record && AGENT_NAME.test(name) && words.has(name)) agents.push({ name, record });
  }
  return agents;
}

/** Estacionado como o watch reconhece (handoff PARKED depois do último prompt) ou como `agent park` registra; encerrado = done/archived. */
export function settled(record: Json, reports: string): "parked" | "ended" | null {
  if (record.state === "done" || record.state === "archived") return "ended";
  if (record.state === "parked") return "parked";
  const handoff = join(String(record.worktree ?? ""), reports, "handoff.md");
  const head = (readText(handoff) ?? "").split("\n")[0] ?? "";
  const prompted = typeof record.promptedAt === "string" ? Date.parse(record.promptedAt) : 0;
  const stamp = statSync(handoff, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  return head.startsWith("STATUS: PARKED") && stamp > (Number.isFinite(prompted) ? prompted : 0) ? "parked" : null;
}

export type Readiness = "parked" | "ended" | "working";

export interface PlanAgent {
  name: string;
  /** `state` do registro ("?" se ausente) */
  state: string;
  readiness: Readiness;
  worktree: string;
}

/** Agentes do plano com a prontidão para o pack, pela mesma regra do `gather` (linkedAgents + settled). */
export function planAgents(work: WorkEnv, planText: string): PlanAgent[] {
  return linkedAgents(work, planText).map(({ name, record }) => ({
    name,
    state: typeof record.state === "string" ? record.state : "?",
    readiness: settled(record, work.reports) ?? "working",
    worktree: String(record.worktree ?? ""),
  }));
}

function addFile(parts: Part[], findings: Finding[], logical: string, file: string): void {
  if (!isFile(file)) return;
  const data = readFileSync(file);
  parts.push({ path: logical, data });
  findings.push(...scanText(logical, data.toString("utf8")));
}

export interface GatherOptions {
  work: WorkEnv;
  planFile: string;
  withJournal: boolean;
}

/** Junta tudo que entra no pacote (sem o manifest). Recusa, nomeando o agente, se algum não está estacionado ou encerrado. */
export function gather(options: GatherOptions): { plan: Plan; agents: string[]; approvedSha: string | null; planSha: string } {
  const { work, planFile } = options;
  const planText = readText(planFile) ?? die(`plano não encontrado: ${planFile}`);
  const linked = linkedAgents(work, planText);
  for (const { name, record } of linked) {
    if (!settled(record, work.reports)) {
      die(`${name} ainda não está estacionado (estado ${String(record.state ?? "?")}): rode hades agent park ${name} e espere o handoff; o pack nunca estaciona sozinho`, 1);
    }
  }
  const parts: Part[] = [];
  const findings: Finding[] = [];
  const worktrees: WorktreeInfo[] = [];
  const stem = basename(planFile).replace(/\.md$/, "");
  addFile(parts, findings, `plan/${basename(planFile)}`, planFile);
  addFile(parts, findings, `plan/${stem}.log.md`, join(planFile.replace(/[^/]+$/, ""), `${stem}.log.md`));
  const approval = readJson(join(work.orch, "plan.json"));
  addFile(parts, findings, "orchestration/plan.json", join(work.orch, "plan.json"));
  const names = linked.map((a) => a.name);
  for (const name of names) {
    addFile(parts, findings, `orchestration/agents/${name}.json`, join(work.orch, "agents", `${name}.json`));
  }
  for (const dir of ["watch", "consolidations"]) {
    for (const file of listDir(join(work.orch, dir))) {
      if (names.some((name) => file.startsWith(`${name}.`))) addFile(parts, findings, `orchestration/${dir}/${file}`, join(work.orch, dir, file));
    }
  }
  for (const { name, record } of linked) {
    const worktree = String(record.worktree ?? "");
    for (const file of REPORT_FILES) addFile(parts, findings, `reports/${name}/${file}`, join(worktree, work.reports, file));
    if (options.withJournal) addFile(parts, findings, `journal/${name}.jsonl`, join(work.work, "journal", `${name}.jsonl`));
    if (record.mode === "review" || !worktree) continue;
    const captured = captureWorktree(name, record, work.reports);
    parts.push(...captured.parts);
    findings.push(...captured.findings);
    worktrees.push(captured.info);
  }
  const current = planSha(planText);
  const approvedSha = approval?.path === planFile && typeof approval.sha === "string" ? approval.sha : null;
  return { plan: { parts, worktrees, findings }, agents: names, approvedSha, planSha: current };
}

/** manifest.json: o contrato com o unpack. Campo novo só é acrescentado, e FORMAT_VERSION sobe só em quebra. */
export function buildManifest(input: Omit<Manifest, "format" | "parts" | "createdAt"> & { parts: Part[]; now: Date }): Manifest {
  const { parts, now, ...rest } = input;
  return {
    format: FORMAT_VERSION,
    ...rest,
    createdAt: `${now.toISOString().slice(0, 19)}Z`,
    parts: parts.map((p) => ({ path: p.path, size: p.data.length, sha256: sha256(p.data) })),
  };
}

export function manifestPart(manifest: Manifest): Part {
  return { path: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") };
}

/** Prompt de retomada do orquestrador em outra sessão da mesma máquina. */
export function resumePrompt(planFile: string, parked: string[]): string {
  const resumes = parked.length > 0
    ? parked.map((name) => `   hades agent resume ${name}`).join("\n")
    : "   (nenhum agente estacionado: confira com hades agent list)";
  return [
    `Você é o orquestrador da Hades retomando a orquestração do plano ${planFile}.`,
    `1. Leia só a seção "Estado atual" do plano (não o plano inteiro) e a mantenha em dia.`,
    "2. Rearme o plantão em segundo plano: hades watch --next (com run_in_background).",
    "3. Reabra cada agente estacionado, um por vez, na ordem do plano:",
    resumes,
    "4. Siga o plano: trate cada evento do watch como de costume.",
  ].join("\n");
}

export interface PackPreview {
  parts: { path: string; size: number }[];
  /** soma dos tamanhos das partes, antes do gzip e da cifra */
  rawBytes: number;
  agents: string[];
  worktrees: WorktreeInfo[];
  /** o que a guarda de segredo barraria: caminho lógico e regra, nunca o valor */
  blocked: Finding[];
  allowed: string[];
}

/** O que `hades caronte pack --dry-run` mostra, como dados. Recusa como o pack (`die`) se algum agente não está estacionado. */
export function previewPack(options: GatherOptions & { allow?: string[] }): PackPreview {
  const gathered = gather(options);
  const { blocked, allowed } = applyAllow(gathered.plan.findings, options.allow ?? []);
  const parts = gathered.plan.parts.map((part) => ({ path: part.path, size: part.data.length }));
  return {
    parts,
    rawBytes: parts.reduce((sum, part) => sum + part.size, 0),
    agents: gathered.agents,
    worktrees: gathered.plan.worktrees,
    blocked,
    allowed,
  };
}
