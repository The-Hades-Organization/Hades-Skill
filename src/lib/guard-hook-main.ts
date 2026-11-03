// Cola do hook: lê o stdin, monta o ambiente real (relógio, perfil do projeto, Cerberus) e escreve a decisão.
// O projeto e o Cerberus só carregam quando a decisão precisa deles (o caminho comum é só ler config e regras).
import { readFileSync } from "node:fs";
import { guardRules } from "./guard-rules.ts";
import { contextOfDir, decide, type Cfg, type HookEnv, type HookInput, type HookResult } from "./guard-hook.ts";
import { agentOfCwd, appendEvent, eventOfHook, journalSettings, journalTarget, journalWorkRoot, markBlocked } from "./journal.ts";
import { home } from "./paths.ts";
import { activeStacks } from "./profile.ts";
import { resolveProject } from "./project.ts";

/** Compila o padrão do perfil; o que o JS não entende (sintaxe só do Python) é ignorado, como o `re.error` no hook antigo. */
function compileOrSkip(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function gatePatterns(cwd: string): RegExp[] {
  try {
    const patterns: RegExp[] = [];
    for (const doc of activeStacks(cwd).values()) {
      const guard = doc.guard;
      const list = typeof guard === "object" && guard !== null && !Array.isArray(guard) ? guard.patterns : undefined;
      if (!Array.isArray(list)) continue;
      for (const pattern of list) {
        const rx = typeof pattern === "string" ? compileOrSkip(pattern) : undefined;
        if (rx) patterns.push(rx);
      }
    }
    return patterns;
  } catch {
    return [];
  }
}

function projectOf(cwd: string): string | undefined {
  try {
    const resolution = resolveProject(cwd);
    return resolution.code === 0 ? (resolution.project ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/** O registro é acessório: sem o corpo, disco cheio ou configuração ilegível, o hook barra igual. */
async function cerberusEmit(guarda: string, conferido: string, d: HookInput): Promise<void> {
  try {
    const { record } = await import("./cerberus.ts");
    record("vigilia", guarda, "continuo", "barra", [{ conferido, onde: `${String(d.tool_name)} da sessão ${String(d.session_id || "?")}` }], {
      cwd: (d.cwd as string | undefined) || process.cwd(),
    });
  } catch {
    // o histórico é acessório: a decisão de barrar já foi tomada
  }
}

/** O guard decide onde já decidia (Bash e o aviso de leitura grande do Read); as outras ferramentas passam pelo PreToolUse (matcher `*`) só para o diário. */
const DECIDING_TOOLS = ["Bash", "Read"] as const;
const BLOCK_EXIT = 2;

/** Diário (src/lib/journal.ts): uma linha por evento; erro de qualquer tipo é engolido, o hook responde igual. */
function journalHook(d: HookInput, cfg: Cfg, result: HookResult): void {
  try {
    const settings = journalSettings((key) => cfg[key]);
    if (!settings.enabled) return;
    const now = new Date();
    const root = journalWorkRoot();
    const home = agentOfCwd(typeof d.cwd === "string" && d.cwd ? d.cwd : process.cwd(), root);
    let event = eventOfHook(d, home?.agent ?? "", now);
    if (!event) return;
    if (result.exit === BLOCK_EXIT && event.kind === "tool_pre") event = markBlocked(event, result.stderr);
    appendEvent(event, journalTarget(event, home, root), settings, now);
  } catch {
    // o diário é acessório: a decisão do hook já está tomada
  }
}

export async function runHook(args: string[]): Promise<number> {
  if (args.length === 2 && args[0] === "context") {
    process.stdout.write(`${contextOfDir(args[1] as string)}\n`);
    return 0;
  }
  let input: HookInput;
  try {
    const parsed: unknown = JSON.parse(readFileSync(0, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return 0;
    input = parsed as HookInput;
  } catch {
    return 0;
  }
  const emits: Promise<void>[] = [];
  const env: HookEnv = {
    now: () => Date.now() / 1000,
    cwd: () => process.cwd(),
    home,
    gatePatterns,
    projectOf,
    cerberusEmit: (guarda, conferido, d) => void emits.push(cerberusEmit(guarda, conferido, d)),
    decidingTools: DECIDING_TOOLS,
    journal: journalHook,
  };
  const result = decide(input, env, guardRules());
  await Promise.all(emits);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exit;
}
