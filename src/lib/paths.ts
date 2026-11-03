import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const skillRoot = resolve(import.meta.dirname, "..", "..");

/** Argv que roda a própria CLI (src/cli.ts) pelo mesmo Bun: o que antes passava pelos scripts wrapper. */
export function selfCli(...args: string[]): { command: string; args: string[] } {
  return { command: process.execPath, args: [join(skillRoot, "src", "cli.ts"), ...args] };
}

export function home(): string {
  return process.env.HOME || homedir();
}

export function hadesHome(): string {
  return join(home(), ".claude", "hades");
}
