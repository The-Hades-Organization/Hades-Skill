// Fila das revisões de PR: semáforo por arquivo de lock (sem processo central), no padrão do fetchSerialized e do gate-lock.
// O teto vem de HADES_REVIEW_MAX_PARALLEL. Cada vaga é um arquivo `slot-<i>.lock` com flock(2) não bloqueante que o
// processo segura até sair da revisão: se ele morrer, o kernel solta a vaga e a fila anda sozinha.
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCK_EX, LOCK_NB, LOCK_UN, sysFlock } from "./flock.ts";
import { configValue } from "./work.ts";

export const REVIEW_PHASES = ["fila", "fetch", "checkout", "revisão", "publicação"] as const;
export type ReviewPhase = (typeof REVIEW_PHASES)[number];

const MAX_PARALLEL_DEFAULT = 4;
const MAX_PARALLEL_CEILING = 32;
const POLL_MS = 500;
// um id de job do painel vira nome de arquivo: só o formato que o painel gera
const JOB_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

/** Teto de revisões ao mesmo tempo; valor ausente ou inválido cai no padrão e o aviso vai para `warn`. */
export function maxParallel(warn: (message: string) => void = () => {}): number {
  const raw = configValue("HADES_REVIEW_MAX_PARALLEL", String(MAX_PARALLEL_DEFAULT)).trim();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL_CEILING) {
    warn(`HADES_REVIEW_MAX_PARALLEL=${raw} fora de 1..${MAX_PARALLEL_CEILING}: usando ${MAX_PARALLEL_DEFAULT}`);
    return MAX_PARALLEL_DEFAULT;
  }
  return n;
}

export interface Slot {
  index: number;
  release(): void;
}

export interface AcquireOptions {
  /** Pasta dos arquivos de vaga (criada se não existe). */
  dir: string;
  max: number;
  /** Chamado uma vez, na primeira vez que não há vaga livre. */
  onWait?: () => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

function tryTake(path: string): number | undefined {
  const fd = openSync(path, "a");
  if (sysFlock()(fd, LOCK_EX | LOCK_NB) === 0) return fd;
  closeSync(fd);
  return undefined;
}

/**
 * Espera uma vaga e a devolve. Sem prazo: quem excede o teto fica na fila, não falha. Varre sempre da vaga 0, então
 * baixar o teto com revisões em voo só vale para as que entram depois.
 */
export async function acquireSlot(opts: AcquireOptions): Promise<Slot> {
  mkdirSync(opts.dir, { recursive: true });
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let waited = false;
  for (;;) {
    for (let index = 0; index < opts.max; index++) {
      const fd = tryTake(join(opts.dir, `slot-${index}.lock`));
      if (fd === undefined) continue;
      let held = true;
      return {
        index,
        release() {
          if (!held) return;
          held = false;
          sysFlock()(fd, LOCK_UN);
          closeSync(fd);
        },
      };
    }
    if (!waited) {
      waited = true;
      opts.onWait?.();
    }
    await sleep(opts.pollMs ?? POLL_MS);
  }
}

/** Arquivo da fase de um job do painel (`<panel-jobs>/<id>.phase`), lido pela página de jobs; undefined fora do painel. */
export function phaseFile(jobId: string | undefined, dataDir: string | undefined): string | undefined {
  if (jobId === undefined || dataDir === undefined || !JOB_ID.test(jobId)) return undefined;
  return join(dataDir, "logs", "panel-jobs", `${jobId}.phase`);
}

export function writePhase(file: string | undefined, phase: ReviewPhase): void {
  if (file === undefined) return;
  writeFileSync(file, `${phase}\n`);
}
