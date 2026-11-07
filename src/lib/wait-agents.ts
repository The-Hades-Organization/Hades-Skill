// Núcleo do `hades wait agents --any`: junta os eventos que o `hades watch` emite em um despertar só.
// O relógio e a fonte de linhas são injetáveis, para o agrupamento e o intervalo mínimo serem testados sem esperar.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readText } from "./fs.ts";

/** Folga depois do primeiro evento para pegar os que chegam juntos (o watch emite vários numa varredura). */
export const SETTLE_MS = 2000;
/** Padrão de `HADES_ORCH_WAKE_MIN_S`: o orquestrador relê o contexto inteiro a cada despertar, então despertar em rajada custa caro. */
export const DEFAULT_WAKE_MIN_S = 30;

export type NextResult = { kind: "line"; line: string } | { kind: "timeout" } | { kind: "end" };

export interface WakeSource {
  /** Próxima linha de evento, ou o que aconteceu antes de `timeoutMs` acabar (`end`: a fonte fechou). */
  next(timeoutMs: number): Promise<NextResult>;
}

export interface WakeClock {
  now(): number;
}

export interface GatherOptions {
  source: WakeSource;
  clock: WakeClock;
  /** instante (ms) do despertar anterior; undefined = nenhum */
  lastWakeAt: number | undefined;
  minIntervalS: number;
  settleMs: number;
  maxMs: number;
}

export type Gathered = { kind: "events"; lines: string[]; wokeAt: number } | { kind: "timeout" } | { kind: "end" };

/**
 * Espera o primeiro evento (até `maxMs`) e segura o despertar até `max(primeiro + settleMs, anterior + minIntervalS)`,
 * juntando as linhas que chegam até lá, sem repetidas. Antes de soltar, drena o que já estava na fila: o watch marca o
 * evento como visto ao emitir, então uma linha perdida aqui não volta.
 */
export async function gatherWake(o: GatherOptions): Promise<Gathered> {
  const startedAt = o.clock.now();
  const lines: string[] = [];
  const add = (line: string): void => {
    if (!lines.includes(line)) lines.push(line);
  };
  let first = await o.source.next(o.maxMs);
  while (first.kind === "line" && first.line.trim() === "") first = await o.source.next(Math.max(0, o.maxMs - (o.clock.now() - startedAt)));
  if (first.kind !== "line") return first;
  add(first.line);
  const firstAt = o.clock.now();
  const wakeAt = Math.max(firstAt + o.settleMs, o.lastWakeAt === undefined ? 0 : o.lastWakeAt + o.minIntervalS * 1000);
  let open = true;
  while (open && o.clock.now() < wakeAt) {
    const r = await o.source.next(wakeAt - o.clock.now());
    if (r.kind === "line") {
      if (r.line.trim() !== "") add(r.line);
    } else open = false;
  }
  for (let drained = await o.source.next(0); drained.kind === "line"; drained = await o.source.next(0)) add(drained.line);
  return { kind: "events", lines, wokeAt: o.clock.now() };
}

/** `AGENTS <n>` e uma linha por evento (a mesma do watch: `DONE <agente>`, `QUESTION <agente> <n>`, …). */
export function formatWake(lines: readonly string[]): string[] {
  return [`AGENTS ${lines.length}`, ...lines];
}

/** Fila de linhas com espera por timeout, alimentada por quem lê a saída do watch. */
export class LineQueue implements WakeSource {
  private readonly buffered: string[] = [];
  private waiter: ((r: NextResult) => void) | undefined;
  private closed = false;
  private tail = "";

  /** Recebe um pedaço de saída; só as linhas completas entram. */
  feed(chunk: string): void {
    const parts = (this.tail + chunk).split("\n");
    this.tail = parts.pop() ?? "";
    for (const line of parts) this.push(line.replace(/\r$/, ""));
  }

  push(line: string): void {
    const waiting = this.waiter;
    if (waiting) {
      this.waiter = undefined;
      waiting({ kind: "line", line });
    } else this.buffered.push(line);
  }

  close(): void {
    if (this.tail !== "") this.push(this.tail);
    this.tail = "";
    this.closed = true;
    const waiting = this.waiter;
    this.waiter = undefined;
    waiting?.({ kind: "end" });
  }

  next(timeoutMs: number): Promise<NextResult> {
    const line = this.buffered.shift();
    if (line !== undefined) return Promise.resolve({ kind: "line", line });
    if (this.closed) return Promise.resolve({ kind: "end" });
    if (timeoutMs <= 0) return Promise.resolve({ kind: "timeout" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        resolve({ kind: "timeout" });
      }, timeoutMs);
      this.waiter = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
    });
  }
}

/** Sobe o `hades watch` (sem `--next`) e devolve a fonte de linhas e o `stop` que o mata. */
export function watchSource(command: string, args: string[]): { source: WakeSource; stop: () => void } {
  const queue = new LineQueue();
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => queue.feed(chunk));
  child.on("close", () => queue.close());
  child.on("error", () => queue.close());
  return { source: queue, stop: () => void child.kill("SIGTERM") };
}

/** Instante (ms) do último despertar gravado no arquivo (epoch em segundos); undefined sem arquivo ou ilegível. */
export function readLastWake(file: string): number | undefined {
  const seconds = Number((readText(file) ?? "").trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export function lastWakeFile(watchDir: string, observer: string | undefined): string {
  return `${watchDir}/wake-${observer ?? "all"}.last`;
}

export function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}
