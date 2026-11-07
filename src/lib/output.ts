// Saída e códigos de saída padronizados da CLI. Os códigos são os dos scripts em bash que ela substitui.
export const EXIT = {
  ok: 0,
  fail: 1,
  usage: 2,
  noProfile: 3,
  outsideRepo: 4,
  missingDependency: 69,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class HadesError extends Error {
  /** código de saída do processo */
  readonly code: number;
  /** código estável do catálogo de erros para humano (src/lib/human-errors-catalog.ts); sem ele vale o da classe do código de saída */
  readonly errorCode: string | undefined;
  constructor(message: string, code: number = EXIT.usage, errorCode?: string) {
    super(message);
    this.name = "HadesError";
    this.code = code;
    this.errorCode = errorCode;
  }
}

export function die(message: string, code: number = EXIT.usage, errorCode?: string): never {
  throw new HadesError(message, code, errorCode);
}

const SIGPIPE_EXIT = 141;

// Leitor que fechou o pipe (`| head`): sai calado como o bash, em vez de despejar a pilha.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(SIGPIPE_EXIT);
    throw error;
  });
}

export function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function warn(text: string): void {
  process.stderr.write(`${text}\n`);
}
