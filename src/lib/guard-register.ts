// Registro do hook da Hades no settings.json do Claude Code: o comando chama o Bun direto (src/hook.ts), sem Python no meio.
// Numa instalação existente a entrada antiga (`python3 …/hades-guard.py`) é trocada no lugar, sem duplicar; as entradas de
// outros hooks e o resto do arquivo ficam como estão.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readText } from "./fs.ts";
import { home, skillRoot } from "./paths.ts";

type Dict = Record<string, unknown>;

/** Matcher de cada evento. O diário grava toda ferramenta, então PreToolUse e PostToolUse casam `*` (as decisões do guard
 *  seguem só no Bash, ver DECIDING_TOOLS). Notification, Stop e UserPromptSubmit não têm ferramenta: sem matcher. */
const EVENTS: { event: string; matcher?: string }[] = [
  { event: "PreToolUse", matcher: "*" },
  { event: "PostToolUse", matcher: "*" },
  { event: "Notification" },
  { event: "Stop" },
  { event: "UserPromptSubmit" },
];
const OURS = /hades-guard\.py|src\/hook\.ts/;

export interface RegisterResult {
  file: string;
  command: string;
  changed: boolean;
  replaced: number;
  added: number;
  removedDuplicates: number;
}

export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.HADES_CLAUDE_SETTINGS || join(home(), ".claude", "settings.json");
}

/** `~/…` no lugar do HOME: o settings.json é do dono e segue valendo se a pasta pessoal mudar de lugar. */
function tilde(path: string): string {
  const h = home();
  return path === h || path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

function bunPath(env: NodeJS.ProcessEnv): string {
  const wanted = env.HADES_BUN || Bun.which("bun") || join(home(), ".bun", "bin", "bun");
  return tilde(wanted);
}

export function hookCommand(env: NodeJS.ProcessEnv = process.env): string {
  return `${bunPath(env)} ${tilde(join(skillRoot, "src", "hook.ts"))}`;
}

const isObject = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

/** Troca o comando (e o matcher, quando o evento tem um) de toda entrada nossa; mantém uma só por evento, na posição da
 *  primeira. Entrada nossa num grupo com hooks de outros sai para um grupo próprio logo depois dele. */
function applyEvent(hooks: Dict, event: string, matcher: string | undefined, command: string): { replaced: number; added: number; removed: number } {
  const counts = { replaced: 0, added: 0, removed: 0 };
  const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  const ours = (entry: unknown): entry is Dict => isObject(entry) && typeof entry.command === "string" && OURS.test(entry.command);
  let kept = false;
  const next: unknown[] = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(ours)) {
      next.push(group);
      continue;
    }
    const mine = group.hooks.filter(ours);
    counts.removed += kept ? mine.length : mine.length - 1;
    const first = mine[0] as Dict;
    const entry = first.command === command ? first : { ...first, command };
    const replacing = !kept;
    let placed = false;
    const rebuilt = group.hooks.flatMap((h: unknown) => {
      if (!ours(h)) return [h];
      if (kept || placed) return [];
      placed = true;
      return [entry];
    });
    const others = group.hooks.filter((h: unknown) => !ours(h));
    if (kept) {
      if (others.length > 0) next.push({ ...group, hooks: others });
      continue;
    }
    kept = true;
    const matcherOk = matcher === undefined || group.matcher === matcher;
    if (replacing && (entry !== first || !matcherOk)) counts.replaced += 1;
    if (matcherOk) next.push({ ...group, hooks: rebuilt });
    else if (others.length === 0) next.push({ ...group, matcher, hooks: [entry] });
    else {
      next.push({ ...group, hooks: others });
      next.push({ matcher, hooks: [entry] });
    }
  }
  if (!kept) {
    next.push({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] });
    counts.added += 1;
  }
  hooks[event] = next;
  return counts;
}

/** Grava o comando novo no settings.json; undefined com a mensagem quando o arquivo existe mas não é JSON de objeto. */
export function registerHook(env: NodeJS.ProcessEnv = process.env): RegisterResult | { error: string } {
  const file = settingsFile(env);
  const command = hookCommand(env);
  const text = readText(file);
  let doc: Dict = {};
  if (text !== undefined && text.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isObject(parsed)) return { error: `${file} não é um objeto JSON` };
      doc = parsed;
    } catch (error) {
      return { error: `${file} não é JSON válido (${(error as Error).message}); o hook não foi registrado` };
    }
  }
  const hooks = isObject(doc.hooks) ? doc.hooks : {};
  const result: RegisterResult = { file, command, changed: false, replaced: 0, added: 0, removedDuplicates: 0 };
  for (const { event, matcher } of EVENTS) {
    const c = applyEvent(hooks, event, matcher, command);
    result.replaced += c.replaced;
    result.added += c.added;
    result.removedDuplicates += c.removed;
  }
  result.changed = result.replaced + result.added + result.removedDuplicates > 0;
  if (!result.changed) return result;
  doc.hooks = hooks;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.hades-tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, file);
  return result;
}

/** O install.sh só mexe no settings.json de verdade numa instalação de verdade: a descartável (SKIP_SYSTEMD/SKIP_WORKTREE)
 *  só registra quando o teste aponta HADES_CLAUDE_SETTINGS. */
export function shouldRegister(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HADES_CLAUDE_SETTINGS) return true;
  return !env.SKIP_SYSTEMD && !env.SKIP_WORKTREE;
}
