// Papéis dos terminais criados no canvas (reference/argos.md §Terminais criados no canvas): cada papel é um `role.json`
// portátil em `$D/argos/roles/<slug>.json` (o slug é o nome do arquivo, nunca vai dentro dele). Também daqui: a
// validação dos campos que papel, predefinição e terminal compartilham (agente, modelo, esforço, cor) e a descoberta de
// `role.json` num diretório de trabalho. O texto das instruções nunca vai a log.
import { type Dirent, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ArgosRole = { name: string; color: string; instructions: string; agent?: string; model?: string; effort?: string };
export type ArgosRoleEntry = ArgosRole & { slug: string };

/** Códigos estáveis do contrato com a UI; só ganham valores. */
export const ARGOS_ERROR_CODES = {
  invalid: "invalid",
  notFound: "not-found",
  confirmRequired: "confirm-required",
  herdrFailed: "herdr-failed",
  rateLimited: "rate-limited",
  /** Argumento do agente com quebra de linha ou byte nulo: o herdr o recusaria (`invalid_agent_argument`). */
  unsafeArgument: "unsafe-argument",
} as const;
export type ArgosErrorCode = (typeof ARGOS_ERROR_CODES)[keyof typeof ARGOS_ERROR_CODES];

export class ArgosError extends Error {
  readonly code: ArgosErrorCode;
  /** Só em `rate-limited`: segundos até a próxima tentativa valer (o Retry-After). */
  readonly retryAfterS: number | undefined;
  constructor(code: ArgosErrorCode, message: string, retryAfterS?: number) {
    super(message);
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
}

const invalid = (message: string): ArgosError => new ArgosError(ARGOS_ERROR_CODES.invalid, message);

/**
 * Agentes que o `herdr agent start --kind` sobe, com as flags que cada CLI aceita. Só o que está aqui é aceito; agente
 * sem `systemPromptFile` nem `systemPrompt` não recebe papel. O herdr recusa quebra de linha em qualquer argumento depois
 * do `--`: o papel de várias linhas só entra por `systemPromptFile` (o caminho de um arquivo); `systemPrompt` (o texto
 * no argumento) serve a papel de uma linha só.
 */
export const AGENT_KINDS: Readonly<Record<string, { model?: string; effort?: string; systemPrompt?: string; systemPromptFile?: string }>> = {
  claude: { model: "--model", effort: "--effort", systemPromptFile: "--append-system-prompt-file" },
  codex: { model: "--model" },
  gemini: { model: "--model" },
};
export const DEFAULT_AGENT = "claude";
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const ROLE_LIMITS = { name: 60, instructions: 20_000, slug: 48, roles: 200, fileBytes: 64 * 1024 } as const;
const MODEL_PATTERN = /^[A-Za-z0-9][\w.:/[\]-]{0,63}$/;
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,47})$/;
// controle C0/C1 (inclui quebra de linha): texto curto é uma linha só
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const ROLE_FILE = "role.json";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Texto curto de uma linha, sem controle, aparado; 1..max caracteres. */
export function shortText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw invalid(`${field} tem de ser texto`);
  const text = value.trim();
  if (!text || text.length > max || CONTROL.test(text)) throw invalid(`${field} inválido (1 a ${max} caracteres, sem quebra de linha)`);
  return text;
}

export function colorOf(value: unknown, field = "color"): string {
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) throw invalid(`${field} tem de ser #rgb ou #rrggbb`);
  return value.toLowerCase();
}

export function agentOf(value: unknown): string {
  if (typeof value !== "string" || !Object.hasOwn(AGENT_KINDS, value)) throw invalid(`agente desconhecido (aceitos: ${Object.keys(AGENT_KINDS).join(", ")})`);
  return value;
}

export function modelOf(value: unknown): string {
  if (typeof value !== "string" || !MODEL_PATTERN.test(value)) throw invalid("modelo inválido");
  return value;
}

export function effortOf(value: unknown): string {
  if (typeof value !== "string" || !(EFFORTS as readonly string[]).includes(value)) throw invalid(`esforço inválido (aceitos: ${EFFORTS.join(", ")})`);
  return value;
}

export function slugFormatOf(value: unknown): string {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) throw invalid("slug inválido");
  return value;
}

/** Campo opcional: ausente (ou null) fica ausente; presente passa pelo validador. */
export function optional<T>(value: unknown, check: (raw: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : check(value);
}

/** Slug a partir do nome: minúsculas sem acento, `a-z0-9-`, até 48; nome sem letra nem número vira `papel`. */
export function slugify(name: string, fallback = "papel"): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ROLE_LIMITS.slug)
    .replace(/-+$/g, "");
  return base || fallback;
}

/** O primeiro de `base`, `base-2`, `base-3`… que não está em `taken`; o sufixo cabe no teto do slug. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, ROLE_LIMITS.slug - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Valida um papel vindo de fora (corpo da requisição ou `role.json`); devolve só os campos do contrato. */
export function validateRole(raw: unknown): ArgosRole {
  if (!isRecord(raw)) throw invalid("papel tem de ser um objeto");
  if (typeof raw.instructions !== "string" || !raw.instructions.trim() || raw.instructions.length > ROLE_LIMITS.instructions) {
    throw invalid(`instruções do papel obrigatórias (até ${ROLE_LIMITS.instructions} caracteres)`);
  }
  const role: ArgosRole = { name: shortText(raw.name, "nome do papel", ROLE_LIMITS.name), color: colorOf(raw.color), instructions: raw.instructions };
  const agent = optional(raw.agent, agentOf);
  const model = optional(raw.model, modelOf);
  const effort = optional(raw.effort, effortOf);
  if (agent !== undefined) role.agent = agent;
  if (model !== undefined) role.model = model;
  if (effort !== undefined) role.effort = effort;
  return role;
}

/** Os papéis gravados em `dir` (`$D/argos/roles`), um arquivo por papel. */
export interface RoleStore {
  list(): ArgosRoleEntry[];
  get(slug: string): ArgosRoleEntry | undefined;
  /** Cria (sem slug) ou atualiza (com slug existente; senão `not-found`). */
  save(role: unknown, slug?: string): ArgosRoleEntry;
  remove(slug: string): void;
  /** O slug que o nome daria, sem sufixo de colisão: é o que a importação compara. */
  baseSlugOf(name: string): string;
}

export function createRoleStore(dir: string, warn: (event: string, fields: Record<string, string>) => void): RoleStore {
  const fileOf = (slug: string): string => join(dir, `${slug}.json`);

  function slugs(): string[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names.filter((n) => n.endsWith(".json") && SLUG_PATTERN.test(n.slice(0, -5))).map((n) => n.slice(0, -5)).sort();
  }

  function read(slug: string): ArgosRoleEntry | undefined {
    let text: string;
    try {
      if (lstatSync(fileOf(slug)).size > ROLE_LIMITS.fileBytes) throw invalid("arquivo grande demais");
      text = readFileSync(fileOf(slug), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      warn("papel ilegível", { slug, reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
    try {
      return { ...validateRole(JSON.parse(text)), slug };
    } catch (error) {
      warn("papel ilegível", { slug, reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  function write(slug: string, role: ArgosRole): void {
    mkdirSync(dir, { recursive: true });
    const tmp = `${fileOf(slug)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(role, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, fileOf(slug));
  }

  return {
    list: () => slugs().flatMap((slug) => read(slug) ?? []),
    get: (slug) => (SLUG_PATTERN.test(slug) ? read(slug) : undefined),
    baseSlugOf: (name) => slugify(name),
    save(raw, slug) {
      const role = validateRole(raw);
      const existing = slugs();
      if (slug !== undefined) {
        if (!existing.includes(slugFormatOf(slug))) throw new ArgosError(ARGOS_ERROR_CODES.notFound, "papel inexistente");
        write(slug, role);
        return { ...role, slug };
      }
      if (existing.length >= ROLE_LIMITS.roles) throw invalid(`limite de ${ROLE_LIMITS.roles} papéis`);
      const fresh = uniqueSlug(slugify(role.name), new Set(existing));
      write(fresh, role);
      return { ...role, slug: fresh };
    },
    remove(slug) {
      if (!slugs().includes(slugFormatOf(slug))) throw new ArgosError(ARGOS_ERROR_CODES.notFound, "papel inexistente");
      rmSync(fileOf(slug));
    },
  };
}

// ---- descoberta de role.json ----

/** Até 3 níveis abaixo do diretório de trabalho (o próprio é o nível 0). */
export const DISCOVER_MAX_DEPTH = 3;
/** Tetos da varredura: pastas visitadas e arquivos achados (o diretório pode ser enorme). */
export const DISCOVER_LIMITS = { dirs: 2000, found: 100 } as const;
const SKIP_DIRS = new Set(["node_modules", "vendor", "target", "dist", "build"]);

export interface DiscoveredRole {
  path: string;
  role: ArgosRole;
}

/**
 * `role.json` válidos sob `root` (já resolvido e contido pelo chamador), até `DISCOVER_MAX_DEPTH` níveis. Não segue link
 * simbólico (nem pasta, nem arquivo), pula pastas ocultas e de dependências; arquivo inválido é registrado e pulado.
 */
export function discoverRoles(root: string, warn: (event: string, fields: Record<string, string>) => void): DiscoveredRole[] {
  const found: DiscoveredRole[] = [];
  let visited = 0;
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && visited < DISCOVER_LIMITS.dirs && found.length < DISCOVER_LIMITS.found) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    visited++;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      warn("pasta ilegível na descoberta de papéis", { path: dir, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isFile() && entry.name === ROLE_FILE) {
        const role = readRoleFile(join(dir, entry.name), warn);
        if (role) found.push({ path: join(dir, entry.name), role });
      } else if (entry.isDirectory() && depth < DISCOVER_MAX_DEPTH && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
        queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return found.slice(0, DISCOVER_LIMITS.found);
}

/** Lê e valida um `role.json` (arquivo comum, não link, até 64 KiB); inválido vira undefined com o motivo no log. */
export function readRoleFile(path: string, warn: (event: string, fields: Record<string, string>) => void): ArgosRole | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw invalid("não é arquivo comum");
    if (stat.size > ROLE_LIMITS.fileBytes) throw invalid("arquivo grande demais");
    return validateRole(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    warn("role.json ignorado", { path, reason: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}
