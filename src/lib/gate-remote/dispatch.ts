// Política de despacho do `gate-lock run`: local ou worker, e quais workers aquecer. Pura: quem consulta a rede e o
// relógio é o cliente (client.ts); aqui entra o que foi observado e sai a decisão.
import { REASON_DISK, type WorkerSpec } from "./protocol.ts";
import { missingTools } from "./toolchain.ts";

export type WarmState = "ready" | "warming" | "failed";

/** Resposta de `hades worker status --json` (o contrato com o painel). */
export interface WorkerStatus {
  host: string;
  labels: string[];
  memFreeGb: number;
  memTotalGb: number;
  cpus: number;
  queue: number;
  warm: Record<string, WarmState>;
  /**
   * Aditivo: ferramentas que o worker procurou no PATH do ssh não interativo (já com a toolchain do usuário carregada).
   * Valor = versão achada; null = ausente. Sem o campo (worker antigo) ou sem a chave, o cliente não sabe e não recusa.
   */
  tools?: Record<string, string | null>;
  /** Aditivo: disco do sistema de arquivos de `$HADES_WORKER_FS_ROOT` (ou `~/.cache/hades-worker`). Worker antigo não traz: o cliente não recusa. */
  diskFreeGb?: number;
  diskTotalGb?: number;
  inodesFree?: number;
}

/** O que a etapa exige de quem a roda fora: rótulos (`docker`), memória livre mínima e ferramentas no PATH. */
export interface Affinity {
  labels: string[];
  minMemGb: number;
  requires: string[];
  /** disco livre mínimo do worker (GB), `remote.minDiskGb` da stack; ausente ou 0 = sem exigência */
  minDiskGb?: number;
}

/** Motivo de recusa por disco; undefined = serve (ou o worker é antigo e não informa disco). */
export function diskShortage(status: WorkerStatus, minDiskGb: number | undefined): string | undefined {
  if (minDiskGb === undefined || minDiskGb <= 0 || status.diskFreeGb === undefined) return undefined;
  return status.diskFreeGb < minDiskGb ? `${REASON_DISK}: ${status.diskFreeGb} GB < ${minDiskGb} GB` : undefined;
}

export type Where = { mode: "local" } | { mode: "auto" } | { mode: "host"; host: string };

export interface Candidate {
  spec: WorkerSpec;
  /** undefined = o worker não respondeu (inalcançável) */
  status: WorkerStatus | undefined;
}

export interface DispatchInput {
  where: Where;
  waitedS: number;
  autoAfterS: number;
  kind: string;
  affinity: Affinity;
  /** chave de aquecimento do item; undefined = a stack não declara aquecimento (nada a esperar) */
  warmKey: string | undefined;
  workers: readonly Candidate[];
}

export interface Decision {
  target: "local" | "remote";
  host?: string;
  /** hosts onde o aquecimento deve começar em segundo plano (o item roda local enquanto isso) */
  warm: string[];
}

/** Concessão `gate` leva um `run.sh` que mora fora do repo: só o `--where <host>` explícito a manda para fora. */
const LOCAL_ONLY_KINDS = new Set(["gate"]);

export function labelsOf(candidate: Candidate): string[] {
  return [...new Set([...candidate.spec.labels, ...(candidate.status?.labels ?? [])])];
}

function eligible(candidate: Candidate, affinity: Affinity): candidate is Candidate & { status: WorkerStatus } {
  if (candidate.status === undefined) return false;
  const labels = labelsOf(candidate);
  const toolsOk = missingTools(candidate.status.tools, affinity.requires).length === 0;
  return toolsOk && diskShortage(candidate.status, affinity.minDiskGb) === undefined && affinity.labels.every((label) => labels.includes(label)) && candidate.status.memFreeGb >= affinity.minMemGb;
}

function betterThan(a: WorkerStatus, hostA: string, b: WorkerStatus, hostB: string): boolean {
  if (a.queue !== b.queue) return a.queue < b.queue;
  if (a.memFreeGb !== b.memFreeGb) return a.memFreeGb > b.memFreeGb;
  return hostA < hostB;
}

export function decide(input: DispatchInput): Decision {
  const { where } = input;
  if (where.mode === "local") return { target: "local", warm: [] };
  if (where.mode === "host") return { target: "remote", host: where.host, warm: [] };
  if (input.waitedS < input.autoAfterS || LOCAL_ONLY_KINDS.has(input.kind)) return { target: "local", warm: [] };

  const warm: string[] = [];
  let best: (Candidate & { status: WorkerStatus }) | undefined;
  for (const candidate of input.workers) {
    if (!eligible(candidate, input.affinity)) continue;
    const state = input.warmKey === undefined ? "ready" : candidate.status.warm[input.warmKey];
    if (state === "ready") {
      if (best === undefined || betterThan(candidate.status, candidate.spec.host, best.status, best.spec.host)) best = candidate;
    } else if (state === undefined) {
      // "warming" e "failed" não reiniciam sozinhos: warming já anda, failed pede olho do dono (o aviso sai no stderr)
      warm.push(candidate.spec.host);
    }
  }
  return best === undefined ? { target: "local", warm } : { target: "remote", host: best.spec.host, warm: [] };
}

/** Vale consultar os workers agora? Só depois do transbordo, e no máximo a cada `everyS` (cada consulta é uma ida ao ssh). */
export function shouldProbe(waitedS: number, autoAfterS: number, everyS: number): boolean {
  return waitedS >= autoAfterS && (waitedS - autoAfterS) % everyS === 0;
}
