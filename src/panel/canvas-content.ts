// Conteúdo de agente e de plano no canvas (reference/argos.md §Conteúdo de agente e de plano): só leitura.
//   GET /api/canvas-content/tree?agent=<nome>[&registry=<slug>][&path=<relativo>][&depth=<1..4>]
//   GET /api/canvas-content/plans
//   GET /api/canvas-content/plan/<nome>
// O nome do agente só vale se está no registro do orquestrador; o caminho pedido é conferido dentro da worktree desse
// agente (sem `..`, sem seguir symlink, sem `.git`); o plano é um `.md` de dentro da pasta de planos. Quem chega aqui já
// passou pela chave e pelo host do painel (o mesmo regime de /api/argos): a rota só lista nomes e lê o plano, nunca devolve
// conteúdo de arquivo da worktree.
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { PlanError, type AgentRef, linkUnitsToAgents, parsePlan, PLAN_LIMITS } from "../lib/canvas-plan.ts";
import { readText } from "../lib/fs.ts";
import { type Registry } from "./argos-graph.ts";
import { PLAN_NAME } from "./caronte.ts";
import { type Exec, exec } from "./exec.ts";
import { send } from "./http.ts";
import { log } from "./log.ts";

export const CONTENT_ERRORS = {
  invalidAgent: "invalid_agent",
  unknownAgent: "unknown_agent",
  worktreeMissing: "worktree_missing",
  invalidPath: "invalid_path",
  pathNotFound: "path_not_found",
  notDirectory: "not_a_directory",
  invalidDepth: "invalid_depth",
  invalidPlan: "invalid_plan",
  unknownPlan: "unknown_plan",
  planTooLarge: "plan_too_large",
} as const;
export type ContentErrorCode = (typeof CONTENT_ERRORS)[keyof typeof CONTENT_ERRORS];

/** Motivos de `changes.available: false`: a árvore sai igual, só sem a marca do que mudou. */
export const CHANGES_UNAVAILABLE = { noBase: "no_base", gitFailed: "git_failed", gitTimeout: "git_timeout" } as const;

export const CONTENT_LIMITS = {
  /** entradas devolvidas por pedido (a árvore cortada leva `truncated: true`) */
  entries: 2000,
  /** níveis abaixo do caminho pedido */
  depth: 4,
  depthDefault: 1,
  /** segmentos do caminho pedido */
  pathSegments: 32,
  pathChars: 1024,
  /** arquivos mudados listados */
  changed: 2000,
  plans: 100,
  agentsPerRegistry: 500,
  gitTimeoutMs: 8000,
} as const;

type Dict = Record<string, unknown>;
const AGENT_NAME = /^[\w.-]{1,80}$/;
const REGISTRY_SLUG = /^[\w.-]{1,120}$/;
const BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@-]{0,199}$/;
const GIT_DIR = ".git";
const PLAN_EXT = ".md";
const LOG_EXT = ".log.md";
const NOT_FOUND = 404;
const INVALID = 400;
const TOO_LARGE = 413;

const STATUS: Record<ContentErrorCode, number> = {
  [CONTENT_ERRORS.invalidAgent]: INVALID,
  [CONTENT_ERRORS.unknownAgent]: NOT_FOUND,
  [CONTENT_ERRORS.worktreeMissing]: NOT_FOUND,
  [CONTENT_ERRORS.invalidPath]: INVALID,
  [CONTENT_ERRORS.pathNotFound]: NOT_FOUND,
  [CONTENT_ERRORS.notDirectory]: INVALID,
  [CONTENT_ERRORS.invalidDepth]: INVALID,
  [CONTENT_ERRORS.invalidPlan]: INVALID,
  [CONTENT_ERRORS.unknownPlan]: NOT_FOUND,
  [CONTENT_ERRORS.planTooLarge]: TOO_LARGE,
};

/** Mensagem fixa por código: nunca caminho, nome de arquivo nem texto de erro do sistema. */
const MESSAGES: Record<ContentErrorCode, string> = {
  [CONTENT_ERRORS.invalidAgent]: "nome de agente inválido",
  [CONTENT_ERRORS.unknownAgent]: "agente desconhecido",
  [CONTENT_ERRORS.worktreeMissing]: "worktree do agente não encontrada",
  [CONTENT_ERRORS.invalidPath]: "caminho inválido",
  [CONTENT_ERRORS.pathNotFound]: "caminho não encontrado",
  [CONTENT_ERRORS.notDirectory]: "o caminho não é uma pasta",
  [CONTENT_ERRORS.invalidDepth]: "profundidade inválida",
  [CONTENT_ERRORS.invalidPlan]: "nome de plano inválido",
  [CONTENT_ERRORS.unknownPlan]: "plano desconhecido",
  [CONTENT_ERRORS.planTooLarge]: "plano grande demais",
};

const refuse = (code: ContentErrorCode): Response => send(STATUS[code], { error: MESSAGES[code], code });

export interface ContentDeps {
  /** os registros lidos, o do projeto primeiro (`registriesOf` de argos-graph) */
  registries(): Registry[];
  /** `~/.claude/hades/plans` */
  plansDir: string;
  /** o git da worktree; o padrão sobe o subprocesso com o teto de tempo */
  git?(cwd: string, args: string[], timeoutMs: number): Promise<Exec>;
  limits?: Partial<{ [K in keyof typeof CONTENT_LIMITS]: number }>;
}

export interface ContentRoutes {
  /** `undefined` se o caminho não é daqui; `query` já decodificada (`queryOf`). */
  get(path: string, query: Record<string, string>): Promise<Response | undefined>;
}

export type TreeEntryType = "dir" | "file" | "symlink" | "other";

export interface TreeEntry {
  /** relativo à raiz da worktree, com `/` */
  path: string;
  name: string;
  type: TreeEntryType;
  size: number | null;
  /** `A`, `M`, `D`, `T`...; `null` sem mudança (ou sem como saber, ver `changes.available`) */
  change: string | null;
  /** só em pasta: quantos arquivos mudados há abaixo dela */
  changedBelow: number;
}

export interface ChangedFile {
  path: string;
  status: string;
}

const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function jsonOf(path: string): Dict {
  try {
    const parsed: unknown = JSON.parse(readText(path) ?? "");
    return isDict(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const defaultGit = (cwd: string, args: string[], timeoutMs: number): Promise<Exec> =>
  exec(["git", "-c", "core.fsmonitor=false", ...args], { timeoutMs, cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });

/** `status\0caminho\0...` do `git diff --name-status -z`; o par incompleto do fim é descartado. */
export function parseNameStatus(raw: string, max: number): { files: ChangedFile[]; truncated: boolean } {
  const parts = raw.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = (parts[i] as string).slice(0, 1);
    const path = parts[i + 1] as string;
    if (status === "" || path === "") continue;
    if (files.length >= max) return { files, truncated: true };
    files.push({ path, status });
  }
  return { files, truncated: false };
}

/** Caminho pedido em segmentos; `undefined` se tem `..`, NUL, barra invertida, é absoluto demais ou passa dos tetos. */
export function parseRelPath(raw: string, maxSegments: number, maxChars: number): string[] | undefined {
  if (raw.length > maxChars || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) return undefined;
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length > maxSegments || segments.includes("..")) return undefined;
  return segments;
}

const codeCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function createCanvasContentRoutes(deps: ContentDeps): ContentRoutes {
  const limit = { ...CONTENT_LIMITS, ...deps.limits };
  const runGit = deps.git ?? defaultGit;

  function findAgent(name: string, registrySlug: string | undefined): { registry: Registry; data: Dict } | ContentErrorCode {
    if (!AGENT_NAME.test(name) || (registrySlug !== undefined && !REGISTRY_SLUG.test(registrySlug))) return CONTENT_ERRORS.invalidAgent;
    for (const registry of deps.registries()) {
      if (registrySlug !== undefined && registry.slug !== registrySlug) continue;
      const data = jsonOf(join(registry.orch, "agents", `${name}.json`));
      if (text(data.name) === name) return { registry, data };
    }
    return CONTENT_ERRORS.unknownAgent;
  }

  /** Chega ao diretório pedido descendo um segmento por vez, sem passar por symlink; fora disso é "não encontrado". */
  function resolveDir(root: string, segments: string[]): { dir: string } | { code: ContentErrorCode } {
    let current = root;
    for (const segment of segments) {
      if (segment === GIT_DIR) return { code: CONTENT_ERRORS.pathNotFound };
      current = join(current, segment);
      const info = lstatSync(current, { throwIfNoEntry: false });
      if (!info || info.isSymbolicLink()) return { code: CONTENT_ERRORS.pathNotFound };
      if (!info.isDirectory()) return { code: segment === segments.at(-1) ? CONTENT_ERRORS.notDirectory : CONTENT_ERRORS.pathNotFound };
    }
    const real = realpathSync(current);
    return real === root || real.startsWith(root + sep) ? { dir: real } : { code: CONTENT_ERRORS.pathNotFound };
  }

  /** Arquivos mudados da branch contra a base do registro (`base...HEAD`, só o que está commitado). */
  async function changesOf(worktree: string, base: string): Promise<Dict & { files: ChangedFile[] }> {
    const unavailable = (reason: string): Dict & { files: ChangedFile[] } => ({ base: base || null, available: false, reason, files: [], truncated: false });
    if (!BASE_REF.test(base) || base.includes("..")) return unavailable(CHANGES_UNAVAILABLE.noBase);
    const result = await runGit(worktree, ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", `${base}...HEAD`, "--"], limit.gitTimeoutMs);
    if (result.timedOut) return unavailable(CHANGES_UNAVAILABLE.gitTimeout);
    if (result.status !== 0) return unavailable(CHANGES_UNAVAILABLE.gitFailed);
    return { base, available: true, ...parseNameStatus(result.stdout, limit.changed) };
  }

  function list(dir: string, prefix: string, depth: number): { entries: TreeEntry[]; truncated: boolean } {
    const entries: TreeEntry[] = [];
    let truncated = false;
    const walk = (abs: string, rel: string, levels: number): void => {
      const names = readdirSync(abs, { withFileTypes: true }).filter((d) => d.name !== GIT_DIR).sort((a, b) => (a.isDirectory() === b.isDirectory() ? codeCompare(a.name, b.name) : a.isDirectory() ? -1 : 1));
      for (const dirent of names) {
        if (entries.length >= limit.entries) {
          truncated = true;
          return;
        }
        const path = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
        const type: TreeEntryType = dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other";
        const size = type === "file" ? (lstatSync(join(abs, dirent.name), { throwIfNoEntry: false })?.size ?? null) : null;
        entries.push({ path, name: dirent.name, type, size, change: null, changedBelow: 0 });
        if (type === "dir" && levels > 1) {
          walk(join(abs, dirent.name), path, levels - 1);
          if (truncated) return;
        }
      }
    };
    walk(dir, prefix, depth);
    return { entries, truncated };
  }

  function mark(entries: TreeEntry[], files: ChangedFile[]): void {
    const status = new Map(files.map((f) => [f.path, f.status]));
    const below = new Map<string, number>();
    for (const file of files) {
      const parts = file.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        below.set(dir, (below.get(dir) ?? 0) + 1);
      }
    }
    for (const entry of entries) {
      entry.change = status.get(entry.path) ?? null;
      entry.changedBelow = entry.type === "dir" ? (below.get(entry.path) ?? 0) : 0;
    }
  }

  async function tree(query: Record<string, string>): Promise<Response> {
    const found = findAgent(query.agent ?? "", query.registry);
    if (typeof found === "string") return refuse(found);
    const depth = query.depth === undefined ? limit.depthDefault : Number(query.depth);
    if (!/^\d{1,2}$/.test(query.depth ?? "1") || depth < 1 || depth > limit.depth) return refuse(CONTENT_ERRORS.invalidDepth);
    const segments = parseRelPath(query.path ?? "", limit.pathSegments, limit.pathChars);
    if (!segments) return refuse(CONTENT_ERRORS.invalidPath);
    const worktree = text(found.data.worktree);
    let root: string;
    try {
      root = worktree === "" ? "" : realpathSync(worktree);
    } catch {
      root = "";
    }
    if (root === "" || !statSync(root, { throwIfNoEntry: false })?.isDirectory()) return refuse(CONTENT_ERRORS.worktreeMissing);
    const resolved = resolveDir(root, segments);
    if ("code" in resolved) return refuse(resolved.code);
    const listed = list(resolved.dir, segments.join("/"), depth);
    const changes = await changesOf(root, text(found.data.base));
    if (changes.available === true) mark(listed.entries, changes.files);
    return send(200, {
      agent: text(found.data.name), registry: found.registry.slug, path: segments.join("/"), depth,
      entries: listed.entries, truncated: listed.truncated, changes,
    });
  }

  function agentRefs(): AgentRef[] {
    const refs: AgentRef[] = [];
    for (const registry of deps.registries()) {
      let files: string[];
      try {
        files = readdirSync(join(registry.orch, "agents")).filter((f) => f.endsWith(".json")).sort().slice(0, limit.agentsPerRegistry);
      } catch {
        continue;
      }
      for (const file of files) {
        const data = jsonOf(join(registry.orch, "agents", file));
        const name = text(data.name);
        if (AGENT_NAME.test(name)) refs.push({ name, registry: registry.slug, state: text(data.state) || "unknown" });
      }
    }
    return refs;
  }

  function planNames(): { name: string; at: number }[] {
    let files: string[];
    try {
      files = readdirSync(deps.plansDir);
    } catch {
      return [];
    }
    return files
      .filter((file) => file.endsWith(PLAN_EXT) && !file.endsWith(LOG_EXT))
      .map((file) => file.slice(0, -PLAN_EXT.length))
      .filter((name) => PLAN_NAME.test(name))
      .map((name) => ({ name, at: statSync(join(deps.plansDir, `${name}${PLAN_EXT}`), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
      .sort((a, b) => b.at - a.at || codeCompare(a.name, b.name))
      .slice(0, limit.plans);
  }

  function plans(): Response {
    return send(200, { plans: planNames().map(({ name, at }) => ({ name, modifiedAt: new Date(at).toISOString() })) });
  }

  function plan(rawName: string): Response {
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return refuse(CONTENT_ERRORS.invalidPlan);
    }
    if (!PLAN_NAME.test(name)) return refuse(CONTENT_ERRORS.invalidPlan);
    if (!planNames().some((p) => p.name === name)) return refuse(CONTENT_ERRORS.unknownPlan);
    // o nome já é de lista fechada; o arquivo real (depois de symlink) ainda tem de ficar dentro da pasta de planos
    let real: string;
    let base: string;
    try {
      real = realpathSync(join(deps.plansDir, `${name}${PLAN_EXT}`));
      base = realpathSync(deps.plansDir);
    } catch {
      return refuse(CONTENT_ERRORS.unknownPlan);
    }
    const info = real.startsWith(base + sep) ? statSync(real, { throwIfNoEntry: false }) : undefined;
    if (!info?.isFile()) return refuse(CONTENT_ERRORS.unknownPlan);
    if (info.size > PLAN_LIMITS.textBytes) return refuse(CONTENT_ERRORS.planTooLarge);
    try {
      const parsed = parsePlan(readFileSync(real, "utf8"));
      return send(200, {
        name, title: parsed.title, state: parsed.state, sections: parsed.sections, skippedRows: parsed.skippedRows,
        truncated: parsed.truncated, units: linkUnitsToAgents(parsed.units, agentRefs()),
      });
    } catch (error) {
      if (error instanceof PlanError) {
        log("warn", "plano recusado pelo parser", { plan: name, code: error.code });
        return refuse(CONTENT_ERRORS.planTooLarge);
      }
      throw error;
    }
  }

  const PLAN_PREFIX = "/api/canvas-content/plan/";
  return {
    async get(path, query) {
      if (path === "/api/canvas-content/tree") return tree(query);
      if (path === "/api/canvas-content/plans") return plans();
      if (path.startsWith(PLAN_PREFIX)) return plan(path.slice(PLAN_PREFIX.length));
      return undefined;
    },
  };
}
