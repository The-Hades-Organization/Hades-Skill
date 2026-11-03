// Subprocessos do painel sem travar o laço de eventos (o amostrador chama systemctl, docker e git a cada 3 s).
// Falha ou tempo esgotado devolvem saída vazia.

export interface Exec {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 8000;

export async function exec(argv: string[], options: { timeoutMs?: number; env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<Exec> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: options.env ?? process.env, cwd: options.cwd });
  } catch (error) {
    return { status: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { status, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** Só a saída padrão; vazia se falhou ou estourou o tempo. */
export async function out(argv: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return (await exec(argv, { timeoutMs })).stdout;
}

const SHLEX_SAFE = /^[\w@%+=:,./-]+$/;

/** shlex.quote do Python: aspas simples só quando há caractere fora da lista segura. */
export function shlexQuote(arg: string): string {
  if (arg === "") return "''";
  return SHLEX_SAFE.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`;
}

export const shlexJoin = (args: readonly string[]): string => args.map(shlexQuote).join(" ");
