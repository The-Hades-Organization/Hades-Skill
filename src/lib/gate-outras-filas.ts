// Orçamento de gate pela máquina (issue 136): a fila é por repositório, mas a memória é uma só.
// Lê só o `.t` dos tickets `running` das filas vizinhas em <work-root>/*/locks/gate-queue.
import { join } from "node:path";
import { listDir, readText } from "./fs.ts";
import { field, num, parseTicket } from "./gate.ts";
import { run as runSync, sameProcess } from "./proc.ts";
import { slugOfRemote } from "./work.ts";

const QUEUE_DIR = "gate-queue";
const TICKET_SUFFIX = ".t";
const RUNNING = "running";

export interface OtherQueue {
  slug: string;
  gates: number;
  usedGb: number;
}

/** Gates vivos em `running` das outras filas; pasta ilegível ou ticket morto não contam. `ownLocks` é a fila de quem pergunta. */
export function otherQueues(workRoot: string, ownLocks: string): OtherQueue[] {
  const found: OtherQueue[] = [];
  for (const slug of listDir(workRoot)) {
    const locks = join(workRoot, slug, "locks");
    if (locks === ownLocks) continue;
    const dir = join(locks, QUEUE_DIR);
    let gates = 0;
    let usedGb = 0;
    for (const name of listDir(dir)) {
      if (!name.endsWith(TICKET_SUFFIX)) continue;
      const ticket = parseTicket(readText(join(dir, name)) ?? "");
      if (field(ticket, "state") !== RUNNING || !sameProcess(field(ticket, "pid"), field(ticket, "pstart"))) continue;
      gates += 1;
      usedGb += num(ticket, "cost");
    }
    if (gates > 0) found.push({ slug, gates, usedGb });
  }
  return found;
}

export function totalOf(queues: readonly OtherQueue[]): { gates: number; usedGb: number } {
  return queues.reduce((sum, q) => ({ gates: sum.gates + q.gates, usedGb: sum.usedGb + q.usedGb }), { gates: 0, usedGb: 0 });
}

/** `outras filas: N gates, X GB (slug, slug)`; vazio quando não há gate rodando nelas. */
export function otherQueuesLine(queues: readonly OtherQueue[]): string {
  if (queues.length === 0) return "";
  const { gates, usedGb } = totalOf(queues);
  return `outras filas: ${gates} gates, ${usedGb} GB (${queues.map((q) => `${q.slug}: ${q.gates} gates, ${q.usedGb} GB`).join("; ")})`;
}

function originSlug(cwd: string): string {
  const url = runSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"]);
  const remote = url.status === 0 ? url.stdout.trim() : "";
  return remote === "" ? "" : slugOfRemote(remote);
}

/** Repositório aninhado em worktree de outro com origin diferente: a nota que diz qual fila foi usada; "" nos demais casos. */
export function nestedRepoNote(cwd: string): string {
  const top = runSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return "";
  const own = top.stdout.trim();
  const parent = own.slice(0, own.lastIndexOf("/"));
  if (parent === "") return "";
  const outer = runSync("git", ["-C", parent, "rev-parse", "--show-toplevel"]);
  if (outer.status !== 0) return "";
  const ownSlug = originSlug(own);
  const outerSlug = originSlug(outer.stdout.trim());
  if (ownSlug === "" || outerSlug === "" || ownSlug === outerSlug) return "";
  return `fila de ${ownSlug}, separada da de ${outerSlug}; o orçamento é somado entre as filas`;
}
