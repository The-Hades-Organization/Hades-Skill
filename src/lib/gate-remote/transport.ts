// Transporte SSH atrás de uma abstração: o comando é configurável (HADES_GATE_SSH), para os testes usarem um
// transporte local (um script que roda `hades worker exec` com outro HADES_HOME). Sem agent forwarding, sem pty, sem
// pergunta: a chave do worker é dedicada e forçada ao `hades worker exec`.
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { isHost } from "./protocol.ts";

export const SSH_ENV = "HADES_GATE_SSH";
const DEFAULT_SSH = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3"];
const STATUS_TIMEOUT_MS = 8000;

export interface SshCommand {
  argv: string[];
  /** comando trocado pelo ambiente: quem o troca responde pelas opções (o git também não presume um `ssh`) */
  custom: boolean;
}

export function sshCommand(env: NodeJS.ProcessEnv = process.env): SshCommand {
  const custom = (env[SSH_ENV] ?? "").trim();
  return custom === "" ? { argv: [...DEFAULT_SSH], custom: false } : { argv: custom.split(/\s+/), custom: true };
}

const shellWord = (word: string): string => (/^[A-Za-z0-9_./:=@+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/** Para o `GIT_SSH_COMMAND` (o git a interpreta como shell). */
export function gitSshCommand(ssh: SshCommand): string {
  return ssh.argv.map(shellWord).join(" ");
}

/** argv do transporte para rodar `command` no worker. O host já foi validado; o comando vai como um argumento só. */
export function remoteArgv(ssh: SshCommand, host: string, command: string): string[] {
  if (!isHost(host)) throw new Error(`host inválido: ${host}`);
  return [...ssh.argv, host, command];
}

export function spawnRemote(ssh: SshCommand, host: string, command: string, stdio: StdioOptions, env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const [file = "", ...args] = remoteArgv(ssh, host, command);
  return spawn(file, args, { stdio, env });
}

export interface Captured {
  rc: number;
  stdout: Buffer;
  stderr: string;
}

/** Roda um comando curto no worker e junta a saída; estourou o prazo ou o transporte morreu = rc 255 (como o ssh). */
export function captureRemote(ssh: SshCommand, host: string, command: string, timeoutMs = STATUS_TIMEOUT_MS, env: NodeJS.ProcessEnv = process.env): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawnRemote(ssh, host, command, ["ignore", "pipe", "pipe"], env);
    const out: Buffer[] = [];
    let err = "";
    let settled = false;
    const finish = (rc: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ rc, stdout: Buffer.concat(out), stderr: err });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(255);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.once("error", () => finish(255));
    child.once("close", (code) => finish(code ?? 255));
  });
}
