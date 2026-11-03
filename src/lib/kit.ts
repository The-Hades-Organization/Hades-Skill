// Contexto dos scripts do kit portados: onde está o kit que os chamou ($D quando instalado) e o git do worktree.
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { EXIT, die } from "./output.ts";
import { skillRoot } from "./paths.ts";
import { instanceFor } from "./instance.ts";
import { run } from "./proc.ts";

/** Pasta do wrapper que delegou (exportada por kit/hades-ts.sh); sem wrapper (chamada direta da CLI), o kit da skill. */
export function kitDir(): string {
  return process.env.HADES_KIT_DIR || join(skillRoot, "kit");
}

/**
 * Pasta de estado do Hades que os subcomandos leem e gravam (prs.list, clean.lock, notify/…): o `$D`. O shim a exporta em
 * HADES_KIT_DIR; chamada direta da CLI, ou shim do kit da própria skill, resolve pela instância do diretório atual
 * (HADES_DATA primeiro), e nunca grava na skill: sem instalação, recusa.
 */
/** O `$D` pela regra do `stateDir`, ou undefined quando não há instalação (quem só lê pode seguir com os padrões). */
export function findStateDir(): string | undefined {
  const skillKit = join(skillRoot, "kit");
  const exported = process.env.HADES_KIT_DIR;
  if (exported && resolve(exported) !== skillKit) return exported;
  return process.env.HADES_DATA || instanceFor(process.cwd()) || undefined;
}

export function stateDir(): string {
  const found = findStateDir();
  if (found) return found;
  return die("sem instalação do Hades para guardar o estado: rode kit/install.sh (ou defina HADES_DATA)", EXIT.fail);
}

/** Texto do JSON no estilo do json.dump(ensure_ascii=False, indent=2) do Python. */
export function dumpJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function git(args: string[], cwd?: string): { status: number; stdout: string; stderr: string } {
  return run("git", args, { cwd });
}

export function gitOrDie(args: string[], cwd?: string): string {
  const r = git(args, cwd);
  if (r.status !== 0) die(`git ${args.join(" ")}: ${r.stderr.trim()}`, EXIT.fail);
  return r.stdout;
}


/** Comando com a saída direta no terminal do chamador (o que o script em bash fazia ao chamar loginctl, systemctl…). */
export function runInherit(command: string, args: string[]): number {
  return spawnSync(command, args, { stdio: "inherit" }).status ?? EXIT.fail;
}

const pyEscape = (text: string): string =>
  JSON.stringify(text).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** `json.dumps` do Python com os padrões (separadores ", " e ": ", ensure_ascii): o que o painel e o clean.sh já leem. */
export function pyJsonDumps(value: unknown): string {
  if (typeof value === "string") return pyEscape(value);
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).map(([k, v]) => `${pyEscape(k)}: ${pyJsonDumps(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}
