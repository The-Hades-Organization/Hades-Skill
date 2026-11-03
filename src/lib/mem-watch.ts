// Vigia de memória da árvore de um gate no macOS, onde não há cgroup nem MemoryMax (reference/adr/0003-teto-de-memoria.md).
// A cada ~1 s soma o RSS do processo e dos descendentes; passou do teto, ou a memória livre da máquina caiu abaixo do piso,
// manda TERM na árvore e, se ela não sair no prazo, KILL. O que lê (árvore de processos, memória livre) e o que faz
// (sinal, relógio) entram por injeção: o teste usa uma árvore falsa.
import { spawnSync } from "node:child_process";
import { memAvailableMb } from "./proc.ts";

const KIB_PER_MIB = 1024;
const PS_TIMEOUT_MS = 2000;
export const WATCH_INTERVAL_MS = 1000;
export const KILL_GRACE_MS = 3000;
/** Abaixo disto de memória livre a árvore do gate é morta mesmo dentro do teto: a máquina está sem fôlego. */
export const MIN_FREE_KILL_MB = 512;
/** Saída do gate morto pelo vigia: a mesma do SIGKILL do oom-killer no Linux. */
export const OOM_EXIT = 137;

export interface ProcRow {
  pid: number;
  ppid: number;
  rssKb: number;
}

export type Snapshot = () => ProcRow[];

export type KillReason = { kind: "cap"; treeMb: number; capMb: number } | { kind: "free"; freeMb: number; floorMb: number };

/** `ps -axo pid=,ppid=,rss=`; linha que não casa é descartada. */
export function parsePsTree(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]) });
  }
  return rows;
}

export function psSnapshot(): ProcRow[] {
  const r = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8", timeout: PS_TIMEOUT_MS });
  return r.status === 0 ? parsePsTree(r.stdout ?? "") : [];
}

/** O processo raiz e todos os descendentes (a raiz entra só se ainda existe; neto de filho que saiu fica fora, sem ppid ligado). */
export function treeOf(rows: readonly ProcRow[], rootPid: number): ProcRow[] {
  const children = new Map<number, ProcRow[]>();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  const found: ProcRow[] = [];
  const seen = new Set<number>();
  const root = rows.find((r) => r.pid === rootPid);
  const stack = root ? [root] : [...(children.get(rootPid) ?? [])];
  for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
    if (seen.has(cur.pid)) continue;
    seen.add(cur.pid);
    found.push(cur);
    stack.push(...(children.get(cur.pid) ?? []));
  }
  return found;
}

export const treeRssMb = (tree: readonly ProcRow[]): number => Math.ceil(tree.reduce((sum, r) => sum + r.rssKb, 0) / KIB_PER_MIB);

export interface MemWatchOptions {
  rootPid: number;
  capMb: number;
  floorMb?: number;
  snapshot?: Snapshot;
  freeMb?: () => number;
  /** Entrega o sinal ao pid; ESRCH (já saiu) é tratado por quem injeta. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Agenda o KILL; devolve o cancelamento. */
  later?: (fn: () => void, ms: number) => () => void;
  graceMs?: number;
}

function sendSignal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}

function defer(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
}

export class MemWatch {
  private peakMbValue = 0;
  private reason: KillReason | undefined;
  private cancelKill: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly opts: Required<MemWatchOptions>;

  constructor(opts: MemWatchOptions) {
    this.opts = {
      snapshot: opts.snapshot ?? psSnapshot, freeMb: opts.freeMb ?? memAvailableMb, signal: opts.signal ?? sendSignal, later: opts.later ?? defer,
      graceMs: opts.graceMs ?? KILL_GRACE_MS, floorMb: opts.floorMb ?? MIN_FREE_KILL_MB, rootPid: opts.rootPid, capMb: opts.capMb,
    };
  }

  /** Maior RSS da árvore visto até agora, em MB (0 = nunca amostrou). */
  get peakMb(): number {
    return this.peakMbValue;
  }

  /** Por que o vigia matou a árvore; undefined = não matou. */
  get killedFor(): KillReason | undefined {
    return this.reason;
  }

  /** Uma amostra: atualiza o pico e, se passou do teto ou da folga, derruba a árvore (uma vez só). */
  tick(): void {
    const tree = treeOf(this.opts.snapshot(), this.opts.rootPid);
    if (tree.length === 0) return;
    const treeMb = treeRssMb(tree);
    this.peakMbValue = Math.max(this.peakMbValue, treeMb);
    if (this.reason !== undefined) return;
    if (treeMb > this.opts.capMb) return this.terminate({ kind: "cap", treeMb, capMb: this.opts.capMb }, tree);
    const freeMb = this.opts.freeMb();
    // 0 = leitura que falhou (memAvailableMb); não é falta de memória
    if (freeMb > 0 && freeMb < this.opts.floorMb) this.terminate({ kind: "free", freeMb, floorMb: this.opts.floorMb }, tree);
  }

  /** TERM no grupo do filho e em cada pid da árvore (quem saiu do grupo com setsid também cai); KILL no que sobrar depois do prazo. */
  private terminate(reason: KillReason, tree: readonly ProcRow[]): void {
    this.reason = reason;
    const pids = tree.map((r) => r.pid);
    this.deliver("SIGTERM", pids);
    this.cancelKill = this.opts.later(() => {
      const left = new Set(treeOf(this.opts.snapshot(), this.opts.rootPid).map((r) => r.pid));
      this.deliver("SIGKILL", [...new Set([...pids, ...left])]);
    }, this.opts.graceMs);
  }

  private deliver(sig: NodeJS.Signals, pids: readonly number[]): void {
    this.opts.signal(-this.opts.rootPid, sig);
    for (const pid of pids) this.opts.signal(pid, sig);
  }

  start(intervalMs = WATCH_INTERVAL_MS): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  /** Para a amostragem e devolve o pico. Se o vigia matou a árvore, o que sobrou no grupo do filho (órfão do TERM) leva KILL agora. */
  stop(): number {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.cancelKill?.();
    if (this.reason !== undefined) this.opts.signal(-this.opts.rootPid, "SIGKILL");
    return this.peakMbValue;
  }
}
