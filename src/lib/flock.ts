// flock(2) do sistema: o mesmo lock que o Python (fcntl.flock) toma, para o histórico e as exceções do Cerberus não
// serem gravados por dois processos ao mesmo tempo, venha o processo do TS ou do módulo Python antigo.
import { closeSync, openSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

// Os valores de LOCK_* são os mesmos no Linux e no macOS (<sys/file.h>).
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

export type Flock = (fd: number, op: number) => number;

// No macOS a libc é a libSystem; "libc.so.6" só existe no Linux (glibc).
const LIBC = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";

let flockFn: Flock | undefined;

/** flock(2) da libc, carregada na primeira chamada: quem só importa o módulo não paga o dlopen. */
export function sysFlock(): Flock {
  if (flockFn) return flockFn;
  const lib = dlopen(LIBC, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  flockFn = (fd, op) => lib.symbols.flock(fd, op);
  return flockFn;
}

/** Roda `fn` com o lock exclusivo do arquivo (criado se não existe); solta o lock e fecha o descritor ao fim. */
export function withFlock<T>(path: string, fn: () => T): T {
  const fd = openSync(path, "a");
  try {
    const flock = sysFlock();
    if (flock(fd, LOCK_EX) !== 0) throw new Error(`flock falhou em ${path}`);
    try {
      return fn();
    } finally {
      flock(fd, LOCK_UN);
    }
  } finally {
    closeSync(fd);
  }
}

/** `flock -n`: toma o lock exclusivo sem esperar e o mantém até o processo sair; false se outro processo o tem. */
export function tryFlockForProcess(path: string): boolean {
  const fd = openSync(path, "w");
  if (sysFlock()(fd, LOCK_EX | LOCK_NB) === 0) return true;
  closeSync(fd);
  return false;
}

/** O prazo de `withFlockAsync` estourou com o lock ainda de outro processo. */
export class FlockTimeoutError extends Error {
  constructor(path: string, waitSeconds: number) {
    super(`flock de ${path} nao veio em ${waitSeconds} s`);
    this.name = "FlockTimeoutError";
  }
}

const RETRY_MS = 25;

/** Toma o lock com `LOCK_NB` e nova tentativa a cada `RETRY_MS` (sem prazo: `waitSeconds` indefinido). Nunca chama o
 * `flock` bloqueante: preso no syscall, o laço de eventos para e a seção que segura o lock no mesmo processo não termina. */
async function lockWithin(flock: Flock, fd: number, path: string, waitSeconds?: number): Promise<void> {
  const deadline = waitSeconds === undefined ? Number.POSITIVE_INFINITY : Date.now() + waitSeconds * 1000;
  while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    if (Date.now() >= deadline) throw new FlockTimeoutError(path, waitSeconds ?? 0);
    await new Promise<void>((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

/** Fila por arquivo dentro do processo: uma seção por vez chega ao `flock`, a seguinte espera a anterior soltar. */
const inProcess = new Map<string, Promise<void>>();

async function queued<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const before = inProcess.get(path) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = before.then(() => mine);
  inProcess.set(path, tail);
  try {
    await before;
    return await fn();
  } finally {
    release();
    if (inProcess.get(path) === tail) inProcess.delete(path);
  }
}

/**
 * Como `withFlock`, para trabalho assíncrono dentro do lock. Seções do mesmo processo entram em fila antes do `flock`;
 * com `waitSeconds`, a espera pelo lock de outro processo tem prazo e lança `FlockTimeoutError`; sem ele, não tem.
 * O prazo conta só a espera pelo `flock`, não a fila do próprio processo.
 */
export function withFlockAsync<T>(path: string, fn: () => Promise<T>, waitSeconds?: number): Promise<T> {
  return queued(path, async () => {
    const fd = openSync(path, "a");
    try {
      const flock = sysFlock();
      await lockWithin(flock, fd, path, waitSeconds);
      try {
        return await fn();
      } finally {
        flock(fd, LOCK_UN);
      }
    } finally {
      closeSync(fd);
    }
  });
}
