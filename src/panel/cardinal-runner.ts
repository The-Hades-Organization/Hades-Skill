// Executor do binário `cardinal` (reference/argos.md §Nó cardinal §Executor). O Cardinal é GPL-3.0: só se fala com ele por
// processo. Roda por argv (sem shell), com timeout, teto de stdin e de saída, ambiente mínimo e uma pasta pessoal descartável.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveHerdrBin } from "../lib/config.ts";
import { extensionEnabled } from "../lib/extension.ts";
import { which } from "../lib/proc.ts";

export const RUNNER_LIMITS = {
  timeoutMs: 30_000,
  stdinBytes: 8 * 1024 * 1024,
  stdoutBytes: 32 * 1024 * 1024,
  stderrBytes: 64 * 1024,
} as const;

export const RUNNER_ERRORS = {
  unavailable: "cardinal_unavailable",
  timeout: "cardinal_timeout",
  outputTooLarge: "cardinal_output_too_large",
  inputTooLarge: "cardinal_input_too_large",
} as const;
export type RunnerErrorCode = (typeof RUNNER_ERRORS)[keyof typeof RUNNER_ERRORS];

/** Falha do executor (não do comando): o binário não existe, estourou tempo ou teto. */
export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  constructor(code: RunnerErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface RunOptions {
  stdin?: Uint8Array;
  timeoutMs?: number;
  stdoutBytes?: number;
}

export interface RunOutput {
  status: number;
  stdout: Buffer;
  stderr: string;
}

export interface CardinalRunner {
  /** Roda `cardinal <args>`; lança `RunnerError`. Status diferente de 0 não lança: quem chama lê `stdout`/`stderr`. */
  run(args: readonly string[], options?: RunOptions): Promise<RunOutput>;
  available(): boolean;
}

export interface RunnerDeps {
  /** Caminho do binário agora, ou `undefined` (extensão desligada ou binário ausente); lido a cada chamada. */
  binary: () => string | undefined;
}

export function createCardinalRunner(deps: RunnerDeps): CardinalRunner {
  return {
    available: () => deps.binary() !== undefined,
    async run(args, options = {}) {
      const bin = deps.binary();
      if (bin === undefined) throw new RunnerError(RUNNER_ERRORS.unavailable);
      if ((options.stdin?.length ?? 0) > RUNNER_LIMITS.stdinBytes) throw new RunnerError(RUNNER_ERRORS.inputTooLarge);
      const home = mkdtempSync(join(tmpdir(), "hades-cardinal-"));
      try {
        return await execute(bin, args, options, home);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

function execute(bin: string, args: readonly string[], options: RunOptions, home: string): Promise<RunOutput> {
  const maxOut = options.stdoutBytes ?? RUNNER_LIMITS.stdoutBytes;
  return new Promise((resolve, reject) => {
    // ambiente mínimo: nada do ambiente do painel (tokens, chaves) chega ao binário
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
    const child = spawn(bin, [...args], { env, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: true });
    const out: Buffer[] = [];
    let outSize = 0;
    let errText = "";
    let failure: RunnerError | undefined;
    const stop = (error: RunnerError): void => {
      failure ??= error;
      // grupo inteiro: um neto que segura o stdout não pode prender o `close` depois do timeout
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => stop(new RunnerError(RUNNER_ERRORS.timeout)), options.timeoutMs ?? RUNNER_LIMITS.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize > maxOut) return stop(new RunnerError(RUNNER_ERRORS.outputTooLarge));
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errText.length < RUNNER_LIMITS.stderrBytes) errText += chunk.toString("utf8");
    });
    child.stdin.on("error", () => undefined); // o binário pode sair sem ler o stdin (EPIPE)
    child.on("error", () => {
      clearTimeout(timer);
      reject(new RunnerError(RUNNER_ERRORS.unavailable));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure !== undefined) return reject(failure);
      resolve({ status: code ?? 1, stdout: Buffer.concat(out), stderr: errText.slice(0, RUNNER_LIMITS.stderrBytes) });
    });
    child.stdin.end(options.stdin === undefined ? undefined : Buffer.from(options.stdin));
  });
}

/** Caminho do binário: `HADES_CARDINAL_BIN` ou `cardinal` do PATH; `undefined` com a extensão desligada ou sem binário. */
export function cardinalBinary(config: ReadonlyMap<string, string>): string | undefined {
  if (!extensionEnabled("cardinal", config)) return undefined;
  const configured = config.get("HADES_CARDINAL_BIN");
  if (!configured) return which("cardinal");
  try {
    const resolved = resolveHerdrBin(configured);
    return isAbsolute(resolved) ? resolved : which(resolved);
  } catch {
    return undefined;
  }
}
