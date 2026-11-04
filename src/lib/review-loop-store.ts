// Borda de disco do loop de revisão: estado por PR, lock do loop, pedido de parada, status e o registro das rodadas.
// Tudo na raiz de trabalho da Hades (`~/.claude/hades/work/<owner>__<repo>/review-loop/`), nunca no repositório.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { LOCK_EX, LOCK_NB, LOCK_UN, sysFlock, tryFlockForProcess } from "./flock.ts";
import { asFindings, type PrState, type RoundRecord } from "./review-loop.ts";

export interface LoopStatus {
  state: "rodando" | "pausada" | "parada";
  pid: number;
  since: string;
  round: number;
  /** Próxima rodada (UTC), quando o loop está dormindo entre rodadas. */
  nextAt: string | undefined;
  reason: string | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined; // arquivo cortado por uma queda: a PR volta a valer como nunca revisada, e o review é refeito
  }
}

export const loopDir = (work: string): string => {
  const dir = join(work, "review-loop");
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Valida na fronteira o arquivo da PR; o miolo só vê PrState. */
export function readPrState(dir: string, pr: number): PrState | undefined {
  const data = readJson(join(dir, `pr-${pr}.json`));
  if (!isRecord(data) || typeof data.headOid !== "string" || typeof data.reviewedAt !== "string") return undefined;
  const open = Array.isArray(data.open) ? asFindings(data.open) : [];
  return {
    pr,
    headOid: data.headOid,
    reviewedAt: data.reviewedAt,
    reviewUrl: typeof data.reviewUrl === "string" ? data.reviewUrl : undefined,
    verdict: typeof data.verdict === "string" ? data.verdict : undefined,
    open,
  };
}

export function writePrState(dir: string, state: PrState): void {
  writeJson(join(dir, `pr-${state.pr}.json`), state);
}

/** O loop do repositório: um processo por vez. O kernel solta o lock se ele morrer; segurado até o processo sair. */
export const takeLoopLock = (dir: string): boolean => tryFlockForProcess(join(dir, "loop.flock"));

/** Há um loop vivo? Tenta o lock e solta em seguida (a resposta é de agora, não de um pid gravado). */
export function loopRunning(dir: string): boolean {
  const fd = openSync(join(dir, "loop.flock"), "a");
  try {
    const flock = sysFlock();
    if (flock(fd, LOCK_EX | LOCK_NB) !== 0) return true;
    flock(fd, LOCK_UN);
    return false;
  } finally {
    closeSync(fd);
  }
}

const stopFile = (dir: string): string => join(dir, "stop");
export const requestStop = (dir: string): void => writeFileSync(stopFile(dir), `${new Date().toISOString()}\n`);
export const stopRequested = (dir: string): boolean => existsSync(stopFile(dir));
export const clearStop = (dir: string): void => rmSync(stopFile(dir), { force: true });

export const writeStatus = (dir: string, status: LoopStatus): void => writeJson(join(dir, "status.json"), status);

export function readStatus(dir: string): LoopStatus | undefined {
  const d = readJson(join(dir, "status.json"));
  if (!isRecord(d) || typeof d.pid !== "number" || typeof d.round !== "number") return undefined;
  const state = d.state === "rodando" || d.state === "pausada" || d.state === "parada" ? d.state : "parada";
  return {
    state, pid: d.pid, since: typeof d.since === "string" ? d.since : "", round: d.round,
    nextAt: typeof d.nextAt === "string" ? d.nextAt : undefined, reason: typeof d.reason === "string" ? d.reason : undefined,
  };
}

export const appendRound = (dir: string, record: RoundRecord): void => appendFileSync(join(dir, "rounds.jsonl"), `${JSON.stringify(record)}\n`);

/** Arquivo com o contexto de achados abertos que o `hades review --loop-context` lê. */
export function writeContext(dir: string, pr: number, text: string): string {
  const file = join(dir, `context-pr-${pr}.md`);
  writeFileSync(file, text);
  return file;
}

export type PrLock = { held: true; release(): void } | { held: false; owner: string };

/** Lock por PR, o mesmo protocolo do gates.md §3.1 (`mkdir` + `owner`): lock de outra sessão não se rouba. */
export function takePrLock(locks: string, pr: number, clone: string): PrLock {
  mkdirSync(locks, { recursive: true });
  const dir = join(locks, `pr-${pr}.lock`);
  try {
    mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner = "";
    try {
      owner = readFileSync(join(dir, "owner"), "utf8").trim().replace(/\n/g, " ");
    } catch {
      owner = "dono ilegível";
    }
    return { held: false, owner };
  }
  writeFileSync(join(dir, "owner"), `clone=${clone}\nhost=${hostname()}\npid=${process.pid}\nsince=${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}\nmode=review-loop\n`);
  return { held: true, release: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Dono do lock da PR sem tomá-lo (planejar a rodada); undefined = livre. */
export function peekPrLock(locks: string, pr: number): string | undefined {
  const dir = join(locks, `pr-${pr}.lock`);
  if (!existsSync(dir)) return undefined;
  try {
    return readFileSync(join(dir, "owner"), "utf8").trim().replace(/\n/g, " ");
  } catch {
    return "dono ilegível";
  }
}
