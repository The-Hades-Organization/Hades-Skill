// Aquecimento do ambiente remoto por chave: o que a stack declara (`remote.key`, `remote.prepare`, `remote.env`), a
// chave em si (pura) e o estado em disco do worker. A preparação vem do pacote de stack do próprio worker, nunca do job:
// quem pede só nomeia a stack.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../proc.ts";
import { isObject, type JsonObject } from "../profile.ts";
import type { Affinity, WarmState } from "./dispatch.ts";

export interface RemoteSpec {
  /** arquivos cujo conteúdo define "o mesmo ambiente" (lockfile, versão do toolchain) */
  key: string[];
  /** comandos de preparação, em ordem, rodados no worktree */
  prepare: string[];
  /** variáveis do worker; `{cache}`, `{repo}` e `{slot}` são expandidos (ex.: CARGO_TARGET_DIR por repo e por slot) */
  env: Record<string, string>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : [];
}

/** `remote` da stack; undefined = a stack não declara aquecimento. */
export function remoteSpecOf(stack: JsonObject | undefined): RemoteSpec | undefined {
  const remote = stack?.remote;
  if (!isObject(remote)) return undefined;
  const env: Record<string, string> = {};
  if (isObject(remote.env)) for (const [name, value] of Object.entries(remote.env)) if (typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(name)) env[name] = value;
  return { key: strings(remote.key), prepare: strings(remote.prepare), env };
}

/** Afinidade da etapa (`steps.<etapa>.remote.labels` e `minMemGb`); sem declaração, nenhuma exigência. */
export function affinityOf(stack: JsonObject | undefined, stepName: string): Affinity {
  const steps = isObject(stack?.steps) ? stack.steps : {};
  const step = steps[stepName];
  const remote = isObject(step) && isObject(step.remote) ? step.remote : {};
  const min = typeof remote.minMemGb === "number" && remote.minMemGb > 0 ? remote.minMemGb : 0;
  return { labels: strings(remote.labels), minMemGb: min };
}

const KEY_HEX = 16;

const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex");

/**
 * Chave do ambiente: stack + hash do conteúdo de cada arquivo declarado (ausente conta como ausente) + escopo (o caminho do
 * worktree: o aquecimento mora no worktree, então outro caminho é outro ambiente). Mesmo conteúdo, mesma chave.
 */
export function warmKey(input: { stack: string; scope: string; files: ReadonlyMap<string, string | undefined> }): string {
  const lines = [...input.files.keys()].sort().map((name) => {
    const content = input.files.get(name);
    return `${name}\t${content === undefined ? "-" : sha256(content)}`;
  });
  return `${input.stack}-${sha256([input.scope, ...lines].join("\n")).slice(0, KEY_HEX)}`;
}

export function readKeyFiles(root: string, names: readonly string[]): Map<string, string | undefined> {
  const files = new Map<string, string | undefined>();
  for (const name of names) {
    try {
      files.set(name, readFileSync(join(root, name), "utf8"));
    } catch {
      files.set(name, undefined);
    }
  }
  return files;
}

export interface Placeholders {
  cache: string;
  repo: string;
  slot: string;
}

export function expandEnv(env: Readonly<Record<string, string>>, vars: Placeholders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    out[name] = value.replaceAll("{cache}", vars.cache).replaceAll("{repo}", vars.repo).replaceAll("{slot}", vars.slot);
  }
  return out;
}

// --- estado em disco do worker: <base>/warm/<chave>.json ---

export interface WarmRecord {
  key: string;
  cwd: string;
  state: WarmState;
  since: string;
  /** pid do preparo; `warming` com pid morto é falha (o worker caiu no meio) */
  pid?: number;
}

export function warmFile(base: string, key: string): string {
  return join(base, "warm", `${key}.json`);
}

export function writeWarm(base: string, record: WarmRecord): void {
  const path = warmFile(base, record.key);
  mkdirSync(join(base, "warm"), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`);
  renameSync(tmp, path);
}

export function readWarm(base: string, key: string): WarmRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(warmFile(base, key), "utf8")) as WarmRecord;
    if (record.state === "warming" && record.pid !== undefined && !pidAlive(record.pid)) return { ...record, state: "failed" };
    return record;
  } catch {
    return undefined;
  }
}

/** Mapa chave → estado para o `worker status`. */
export function warmStates(base: string): Record<string, WarmState> {
  const states: Record<string, WarmState> = {};
  let names: string[] = [];
  try {
    names = readdirSync(join(base, "warm"));
  } catch {
    return states;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readWarm(base, name.slice(0, -".json".length));
    if (record) states[record.key] = record.state;
  }
  return states;
}

export function clearWarm(base: string, key: string): void {
  rmSync(warmFile(base, key), { force: true });
}

// --- slots: o cargo trava o diretório de build, então dois jobs no mesmo target se serializam ---

export const SLOT_COUNT = 4;
const SLOT_PID_GRACE_MS = 5000;

/** Toma o primeiro slot livre (mkdir atômico + pid do dono); devolve o número e como soltar. */
export function claimSlot(base: string, repo: string): { slot: number; release: () => void } {
  const root = join(base, "slots", repo);
  mkdirSync(root, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      const dir = join(root, String(slot));
      try {
        mkdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = Number.parseInt(readOwner(join(dir, "pid")), 10);
        // dono ainda gravando o pid (mkdir e escrita não são atômicos juntos): só é velho quem passa de alguns segundos
        if (Number.isInteger(owner) ? pidAlive(owner) : Date.now() - statSync(dir).mtimeMs < SLOT_PID_GRACE_MS) continue;
        rmSync(dir, { recursive: true, force: true });
        slot -= 1;
        continue;
      }
      writeFileSync(join(dir, "pid"), `${process.pid}\n`);
      return { slot, release: () => rmSync(dir, { recursive: true, force: true }) };
    }
  }
  // todos os slots em uso: o último é compartilhado (o cargo serializa; o resultado continua correto)
  return { slot: SLOT_COUNT - 1, release: () => undefined };
}

function readOwner(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
