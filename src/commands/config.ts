// Configurações do Hades pela linha de comando (config.sh): show | get | set | unset | export | import.
// O catálogo e a validação estão em src/lib/config-catalog.ts.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import {
  ConfigError,
  type ConfigStore,
  type ImportPlan,
  effective,
  exportText,
  plan,
  save,
} from "../lib/config-catalog.ts";
import { EXIT, out } from "../lib/output.ts";
import { findStateDir, kitDir, stateDir } from "../lib/kit.ts";

export const USAGE = `Uso: config.sh show | get <KEY> | set KEY=VALUE [...] | unset KEY [...] | export [--all] [--include-identity] |
     import <arquivo> [--dry-run] [--yes]`;

const fail = (message: string): number => {
  process.stderr.write(`${message}\n`);
  return EXIT.fail;
};

const printPlan = (p: ImportPlan): void => {
  for (const c of p.changes) out(`  ${c.key}: ${c.old || "(vazio)"} → ${c.new || "(vazio)"}   [${c.apply}]`);
  if (p.same.length > 0) out(`  ${p.same.length} chave(s) já com o mesmo valor`);
  for (const e of p.invalid) out(`  ERRO  ${e.key}: ${e.error}`);
  for (const k of p.unknown) out(`  aviso: chave desconhecida nesta versão, ignorada: ${k}`);
  for (const k of p.secret) out(`  aviso: segredo não se importa, ignorado: ${k}`);
  for (const k of p.blocked) out(`  aviso: só se muda pelo painel local, ignorado: ${k}`);
  out(`Aplicar depois: ${p.apply.join(", ") || "nada mudaria"}`);
};

const applied = (modes: string[]): string => modes.join(", ") || "nada mudou";

async function confirm(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Gravar estas mudanças? [s/N] ")).trim().toLowerCase();
  rl.close();
  return ["s", "sim", "y"].includes(answer);
}

async function run(args: string[]): Promise<number> {
  const kit = kitDir();
  const [cmd = "show", ...rest] = args;
  // gravar nunca cai dentro da skill: sem instalação ($D pela instância), recusa; só ler segue com os padrões do kit
  const writes = cmd === "set" || cmd === "unset" || (cmd === "import" && !args.includes("--dry-run"));
  const store: ConfigStore = { dir: writes ? stateDir() : (findStateDir() ?? kit), kit };
  if (cmd === "show") {
    for (const it of effective(store)) {
      out(`${it.key.padEnd(24)} ${(it.value || "(vazio)").padEnd(14)} ${it.changed ? "*" : " "} ${it.label}`);
    }
    out(`\n* = diferente do padrão (gravado em ${join(store.dir, "config.env")})`);
    return EXIT.ok;
  }
  if (cmd === "get" && rest.length === 1) {
    out(effective(store).find((it) => it.key === rest[0])?.value ?? "");
    return EXIT.ok;
  }
  if (cmd === "set" && rest.length > 0) {
    const pairs: Record<string, string> = {};
    for (const arg of rest) {
      const eq = arg.indexOf("=");
      if (eq >= 0) pairs[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
    if (rest.some((arg) => !arg.includes("="))) return fail("uso: config.sh set KEY=VALUE [...]");
    out(`gravado. Aplicar: ${applied(save(store, pairs))}`);
    return EXIT.ok;
  }
  if (cmd === "unset" && rest.length > 0) {
    out(`voltou ao padrão. Aplicar: ${applied(save(store, {}, rest))}`);
    return EXIT.ok;
  }
  if (cmd === "export") {
    if (rest.some((a) => a !== "--all" && a !== "--include-identity")) return fail("uso: config.sh export [--all] [--include-identity]");
    process.stdout.write(exportText(store, rest.includes("--all"), rest.includes("--include-identity")));
    return EXIT.ok;
  }
  if (cmd === "import") {
    const files = rest.filter((a) => !a.startsWith("--"));
    if (files.length !== 1 || rest.some((a) => !files.includes(a) && a !== "--dry-run" && a !== "--yes")) {
      return fail("uso: config.sh import <arquivo> [--dry-run] [--yes]");
    }
    let text: string;
    try {
      text = readFileSync(files[0] as string, "utf8");
    } catch (error) {
      return fail(`${(error as NodeJS.ErrnoException).code === "ENOENT" ? "arquivo não encontrado" : "não consegui ler"}: ${files[0]}`);
    }
    const p = plan(store, text);
    printPlan(p);
    if (rest.includes("--dry-run") || p.changes.length === 0) return EXIT.ok;
    if (p.invalid.length > 0 && !rest.includes("--yes")) return fail("há erro no arquivo: corrija, ou grave só o válido com --yes");
    if (!rest.includes("--yes") && !(await confirm())) return fail("nada gravado (confirme no terminal, ou use --yes)");
    out(`gravado. Aplicar: ${applied(save(store, Object.fromEntries(p.changes.map((c) => [c.key, c.new]))))}`);
    return EXIT.ok;
  }
  return fail(USAGE);
}

export async function configCommand(args: string[]): Promise<number> {
  try {
    return await run(args);
  } catch (error) {
    if (error instanceof ConfigError) return fail(`erro: ${error.message}`);
    throw error;
  }
}
