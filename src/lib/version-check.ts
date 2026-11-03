// Checagem periódica de versão do Hades: a VERSION do kit instalado ($D/kit.version) contra a VERSION do branch padrão do
// repo da skill. O repo é público: o caminho principal é um GET sem login em raw.githubusercontent.com (funciona sem `gh`);
// o `gh api` fica de reserva, para fork privado ou espelho (e é o único caminho quando há conta do gh configurada).
// Só avisa: não baixa nem atualiza nada. Um cache só ($D/version-check.json), lido pelo painel e pelo doctor.sh; sem
// acesso, sem rede ou com timeout, a feature fica oculta e calada (o motivo vai no campo `reason` do cache, para
// depuração, nunca para a tela).
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readText } from "./fs.ts";
import { home } from "./paths.ts";
import { pyDumps } from "./pyjson.ts";

const SEMVER = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;
/** dono/nome de um repositório no GitHub. */
export const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const GH_USER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const DEFAULT_REPO = "The-Hades-Organization/Hades-Skill";
const DEFAULT_RAW_BASE = "https://raw.githubusercontent.com";
const HOUR_SECONDS = 3600;
const HTTP_NOT_FOUND = 404;
/** Uma VERSION tem poucos bytes: resposta maior que isso não é a VERSION. */
const MAX_VERSION_BYTES = 256;

export type CacheState = Record<string, unknown>;

export interface Settings {
  repo: string;
  hours: number;
  timeout: number;
  ghUser: string;
  rawBase: string;
}

export interface FetchResult {
  version: string | null;
  reason: string | null;
}

export type Fetcher = (repo: string, timeoutSeconds: number, ghUser: string, rawBase?: string) => Promise<FetchResult>;

export interface Status {
  enabled: boolean;
  access: boolean;
  local: string;
  remote: string;
  checkedAt: string | null;
  due: boolean;
  update: boolean;
  command?: string;
  reason?: string;
}

/** [maior, menor, correção] de 'X.Y.Z', ou null. Numérico: 4.10.0 > 4.9.0. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = SEMVER.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(remote: string, local: string): boolean {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) if (r[i] !== l[i]) return (r[i] as number) > (l[i] as number);
  return false;
}

export const stamp = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, "Z");

export function readCache(path: string): CacheState {
  const text = readText(path);
  if (text === undefined) return {};
  try {
    const data: unknown = JSON.parse(text);
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as CacheState) : {};
  } catch {
    return {};
  }
}

export function writeCache(path: string, state: CacheState): void {
  const tmp = `${path.replace(/\.json$/, "")}.tmp`;
  writeFileSync(tmp, pyDumps(state));
  renameSync(tmp, path);
}

const parseStamp = (text: unknown): Date | null => {
  const m = typeof text === "string" ? STAMP.exec(text) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // data impossível (31/02, hora 25) não vira outra data: o strptime do original a recusava
  return at.getUTCMonth() === mo - 1 && at.getUTCDate() === d && h < 24 && mi < 60 && s < 60 ? at : null;
};

/** Vencido quando não há checagem, a checagem é de outro repo ou de outra conta ou o intervalo passou. Relógio para trás também vence. */
export function isDue(state: CacheState, repo: string, hours: number, now: Date, ghUser = ""): boolean {
  if (state.repo !== repo || (state.ghUser ?? "") !== ghUser) return true;
  const at = parseStamp(state.checkedAt);
  if (!at) return true;
  const age = (now.getTime() - at.getTime()) / 1000;
  return age < 0 || age >= hours * HOUR_SECONDS;
}

/** Saída do processo, com o timeout do tempo inteiro: Bun.spawn não tem timeout por padrão. */
async function runGh(args: string[], timeoutSeconds: number, env: Record<string, string | undefined>): Promise<{ code: number; stdout: string } | "timeout"> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill();
  }, timeoutSeconds * 1000);
  try {
    const stdout = await new Response(child.stdout).text();
    const code = await child.exited;
    return expired ? "timeout" : { code, stdout };
  } finally {
    clearTimeout(timer);
  }
}

const accepted = (text: string): FetchResult =>
  parseVersion(text) === null ? { version: null, reason: "VERSION remota fora do formato X.Y.Z" } : { version: text.trim(), reason: null };

/** VERSION do branch padrão por GET anônimo (repo público). `definitive` = o servidor respondeu e o repo não está lá: vale tentar o gh. */
async function fetchRaw(repo: string, rawBase: string, timeoutSeconds: number): Promise<FetchResult & { fallback: boolean }> {
  try {
    const res = await fetch(`${rawBase.replace(/\/+$/, "")}/${repo}/HEAD/VERSION`, { signal: AbortSignal.timeout(timeoutSeconds * 1000) });
    if (!res.ok) {
      const reason = res.status === HTTP_NOT_FOUND ? "repositório não encontrado ou privado (HTTP 404)" : `GitHub respondeu HTTP ${res.status}`;
      return { version: null, reason, fallback: true };
    }
    const text = await res.text();
    if (text.length > MAX_VERSION_BYTES) return { version: null, reason: "VERSION remota fora do formato X.Y.Z", fallback: false };
    return { ...accepted(text), fallback: false };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return { version: null, reason: "timeout", fallback: false };
    return { version: null, reason: "sem rede para o GitHub", fallback: true };
  }
}

/** VERSION pelo `gh api` (conta ativa ou a de `ghUser`). Toda saída do processo leva timeout. */
async function fetchGh(repo: string, timeoutSeconds: number, ghUser: string): Promise<FetchResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  try {
    if (ghUser) {
      const token = await runGh(["auth", "token", "--user", ghUser], timeoutSeconds, env);
      if (token === "timeout") return { version: null, reason: "timeout" };
      if (!token.stdout.trim()) return { version: null, reason: "conta do gh sem login" };
      env.GH_TOKEN = token.stdout.trim();
    }
    const r = await runGh(["api", `repos/${repo}/contents/VERSION`, "-H", "Accept: application/vnd.github.raw+json"], timeoutSeconds, env);
    if (r === "timeout") return { version: null, reason: "timeout" };
    if (r.code !== 0) return { version: null, reason: `gh saiu ${r.code}` };
    return accepted(r.stdout);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { version: null, reason: code === "ENOENT" ? "gh ausente" : `gh não executou (${error instanceof Error ? error.name : "erro"})` };
  }
}

/**
 * VERSION do branch padrão de `repo`. Sem conta do gh: GET anônimo e, se o repo não respondeu como público (404, rede,
 * erro do servidor), o gh com o que sobrou do tempo. Com conta do gh: só o gh (pedido explícito de usar aquele login).
 */
export const fetchRemote: Fetcher = async (repo, timeoutSeconds, ghUser, rawBase = DEFAULT_RAW_BASE) => {
  if (!REPO.test(repo)) return { version: null, reason: "repo inválido" };
  if (ghUser && !GH_USER.test(ghUser)) return { version: null, reason: "conta do gh inválida" };
  if (ghUser) return fetchGh(repo, timeoutSeconds, ghUser);
  const started = Date.now();
  const raw = await fetchRaw(repo, rawBase, timeoutSeconds);
  if (!raw.fallback) return { version: raw.version, reason: raw.reason };
  const left = Math.ceil(timeoutSeconds - (Date.now() - started) / 1000);
  if (left < 1) return { version: null, reason: "timeout" };
  const viaGh = await fetchGh(repo, left, ghUser);
  // sem o gh para confirmar, o motivo útil é o do GET anônimo (repo privado, sem rede), não "gh ausente"
  return viaGh.version === null && viaGh.reason === "gh ausente" ? { version: null, reason: raw.reason } : viaGh;
};

export function localVersion(dir: string): string {
  const text = readText(join(dir, "kit.version"));
  return text === undefined ? "" : (text.split(/\r?\n/)[0] ?? "").trim();
}

export function updateCommand(env: NodeJS.ProcessEnv = process.env): string {
  const skill = env.HADES_SKILL_DIR || join(home(), ".claude", "skills", "hades");
  const wt = env.W || env.HADES_WT || "<worktree>";
  return `git -C ${skill} pull && HADES_WT=${wt} ${skill}/kit/install.sh`;
}

export function settings(env: NodeJS.ProcessEnv = process.env): Settings {
  const num = (key: string, fallback: number): number => (/^[0-9]+$/.test(env[key] ?? "") ? Number(env[key]) : fallback);
  return {
    repo: env.HADES_VERSION_CHECK_REPO || DEFAULT_REPO,
    hours: num("HADES_VERSION_CHECK_HOURS", 1),
    timeout: num("HADES_VERSION_CHECK_TIMEOUT", 8),
    ghUser: (env.HADES_VERSION_CHECK_GH_USER || "").trim(),
    rawBase: env.HADES_VERSION_CHECK_RAW_BASE || DEFAULT_RAW_BASE,
  };
}

/** Consulta a rede se o intervalo venceu e grava o cache. Intervalo 0: nada. Devolve o cache atual. */
export async function refresh(cfg: Settings, path: string, now: Date = new Date(), fetcher: Fetcher = fetchRemote): Promise<CacheState> {
  const state = readCache(path);
  if (cfg.hours <= 0 || !isDue(state, cfg.repo, cfg.hours, now, cfg.ghUser)) return state;
  const { version, reason } = await fetcher(cfg.repo, cfg.timeout, cfg.ghUser, cfg.rawBase);
  const next: CacheState = { repo: cfg.repo, ghUser: cfg.ghUser, checkedAt: stamp(now), access: version !== null, remote: version ?? "" };
  if (reason) next.reason = reason;
  try {
    writeCache(path, next);
  } catch (error) {
    return { ...next, reason: `cache não gravado (${error instanceof Error ? error.name : "erro"})` };
  }
  return next;
}

/** O que os leitores exibem. `update` só é verdadeiro com acesso, checagem ligada e versão remota maior. */
export function status(cfg: Settings, path: string, local: string, now: Date = new Date()): Status {
  const state = readCache(path);
  const enabled = cfg.hours > 0;
  const fresh = state.repo === cfg.repo;
  const access = enabled && fresh && Boolean(state.access);
  const remote = access ? String(state.remote ?? "") : "";
  const result: Status = {
    enabled,
    access,
    local,
    remote,
    checkedAt: fresh ? ((state.checkedAt as string | undefined) ?? null) : null,
    due: enabled && isDue(state, cfg.repo, cfg.hours, now, cfg.ghUser),
    update: access && isNewer(remote, local),
  };
  if (result.update) result.command = updateCommand();
  if (state.reason && fresh) result.reason = String(state.reason);
  return result;
}
