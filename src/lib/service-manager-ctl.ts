// Roda a ferramenta do gerenciador de serviço (systemctl, launchctl, journalctl) com teto de tempo.
import { execFile, spawnSync, type StdioOptions } from "node:child_process";
import { EXIT, HadesError } from "./output.ts";

const CTL_TIMEOUT_MS = 30_000;

export interface CtlResult {
  status: number;
  stdout: string;
}

/** Roda a ferramenta do gerenciador. `inherit`: stdout e stderr no terminal de quem chamou (verbos que mudam estado). */
export function ctl(command: string, args: string[], mode: "capture" | "inherit" | "quiet" = "capture"): CtlResult {
  const stdio: StdioOptions = mode === "inherit" ? ["ignore", "inherit", "inherit"] : mode === "quiet" ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"];
  const r = spawnSync(command, args, { encoding: "utf8", stdio, timeout: CTL_TIMEOUT_MS });
  return { status: r.status ?? EXIT.fail, stdout: typeof r.stdout === "string" ? r.stdout : "" };
}

const CTL_ASYNC_TIMEOUT_MS = 8000;
const EXIT_NOT_FOUND = 127;

/** Como `ctl` em modo capture, sem travar o laço de eventos (o amostrador e os jobs do painel). Falha ao lançar vira 127. */
export function ctlAsync(command: string, args: string[], timeoutMs = CTL_ASYNC_TIMEOUT_MS): Promise<CtlResult> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: timeoutMs }, (error, stdout) => {
      if (error === null) return resolve({ status: 0, stdout });
      const code = (error as NodeJS.ErrnoException).code;
      resolve({ status: typeof code === "number" ? code : code === "ENOENT" ? EXIT_NOT_FOUND : EXIT.fail, stdout: typeof stdout === "string" ? stdout : "" });
    });
  });
}

/** A listagem de units falhou (erro ou timeout do gerenciador): não é o mesmo que "nenhuma unit". Quem coleta o que parece parado não recolhe nada. */
export class ListFailedError extends HadesError {
  constructor(tool: string, status: number) {
    super(`${tool} list falhou (código ${status}): a lista de serviços em execução está indisponível`, EXIT.fail);
    this.name = "ListFailedError";
  }
}

/** `launchctl bootstrap` logo depois de um `bootout` sai 5 (Input/output error) enquanto o job desmonta. */
const BOOTSTRAP_TEARING_DOWN = 5;
const BOOTSTRAP_ATTEMPTS = 4;
const BOOTSTRAP_RETRY_WAIT_MS = 500;

/** Repete o bootstrap só no código de desmonte, com espera curta (no máximo ~1,5 s no total); qualquer outro código volta de imediato. */
export function retryBootstrap(bootstrap: () => number): number {
  let status = bootstrap();
  for (let attempt = 1; attempt < BOOTSTRAP_ATTEMPTS && status === BOOTSTRAP_TEARING_DOWN; attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BOOTSTRAP_RETRY_WAIT_MS);
    status = bootstrap();
  }
  return status;
}
