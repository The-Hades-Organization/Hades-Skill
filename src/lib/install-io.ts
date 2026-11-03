// Saída e subprocessos do install: a saída própria e a dos filhos (inherit) precisam sair na ordem em que acontecem,
// por isso o texto vai por writeSync e não pelo stream assíncrono do processo.
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { HadesError } from "./output.ts";

const STDOUT = 1;
const STDERR = 2;
const WRITE_RETRIES = 50;

function writeAll(fd: number, text: string): void {
  const data = Buffer.from(text);
  let offset = 0;
  let tries = 0;
  while (offset < data.length) {
    try {
      offset += writeSync(fd, data, offset);
    } catch (error) {
      // pipe não bloqueante cheio: o leitor ainda vai esvaziar
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || ++tries > WRITE_RETRIES) throw error;
    }
  }
}

export const say = (text: string): void => writeAll(STDOUT, `${text}\n`);
export const sayErr = (text: string): void => writeAll(STDERR, `${text}\n`);

export interface StepOptions {
  env?: Record<string, string>;
  /** descarta a saída do filho (o `>/dev/null` do script) */
  quiet?: boolean;
  quietErr?: boolean;
}

/** Roda o filho com o terminal do install; devolve o status (1 se morreu por sinal). */
export function runStep(command: string, args: string[], options: StepOptions = {}): number {
  const r = spawnSync(command, args, {
    env: { ...process.env, ...options.env },
    stdio: ["inherit", options.quiet ? "ignore" : "inherit", options.quietErr ? "ignore" : "inherit"],
  });
  return r.status ?? 1;
}

/** Como um comando sem `|| true` sob `set -e`: status diferente de zero encerra o install com esse status. */
export function mustStep(command: string, args: string[], options: StepOptions = {}): void {
  const status = runStep(command, args, options);
  if (status !== 0) exitWith(status);
}

/** Encerra o install com o status dado sem mensagem (quem saiu já falou); o comando install devolve o status calado. */
export function exitWith(status: number): never {
  throw new HadesError("", status);
}
