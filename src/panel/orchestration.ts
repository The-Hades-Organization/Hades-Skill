// Agentes alocados pelo orquestrador e consolidações: o registro que os scripts do loop gravam em <work>/orchestration/, o
// estado vivo do `herdr agent list` e os arquivos de cada agente. Somente leitura.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readText } from "../lib/fs.ts";
import { LEVEL_LABELS, MAX_LEVEL, MIN_LEVEL } from "../lib/autonomy.ts";
import { readEvents } from "../lib/journal.ts";
import { collectOrchestration } from "../lib/minos-collect.ts";
import { publish } from "../lib/minos-publish.ts";
import { skillRoot } from "../lib/paths.ts";
import type { PanelEnv } from "./env.ts";
import { exec, out } from "./exec.ts";
import { BadRequest } from "./http.ts";

type Dict = Record<string, unknown>;

const FILES: Record<string, string> = { brief: "brief.md", questions: "questions.md", report: "report.md", handoff: "handoff.md" };
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const LIVE_TTL_S = 5;
const LIVE_TIMEOUT_MS = 5000;
const TERMINAL_TIMEOUT_MS = 8000;
const TERMINAL_LINES = "160";
const DEFAULT_REPORTS_DIR = ".design-sync-reports";
const DECISIONS_SHOWN = 20;
/** A página offline do painel fica fora de `$D/minos/<saída>/`, que é do registro de saídas publicadas (`hades minos`). */
const OFFLINE_DIR = "minos/offline";
const OFFLINE_FILE = "orquestracao.html";
/** O diário do orquestrador (sem agente): hades agent decide grava em _sessions/_orch. */
const ORCH_JOURNAL = "_sessions/_orch";
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;

export interface Orchestration {
  snapshot(): Promise<Dict>;
  file(name: string, which: string): Dict;
  terminal(name: string): Promise<Dict>;
  /** Botão "Publicar": gera a página offline do plano aprovado (passando pelo Cerberus) e devolve o comando de publicação. */
  publishPage(): Dict;
}

const jsonFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
};

const readJson = (path: string): Dict | undefined => {
  try {
    const parsed: unknown = JSON.parse(readText(path) ?? "");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Dict) : undefined;
  } catch {
    return undefined;
  }
};

export function createOrchestration(env: PanelEnv, config: () => Record<string, string>): Orchestration {
  const root = env.locks ? join(dirname(env.locks), "orchestration") : undefined;
  let herdr: { t: number; agents: Dict[] } = { t: 0, agents: [] };
  const reportsDir = (): string => config().HADES_ORCH_REPORTS_DIR || DEFAULT_REPORTS_DIR;

  async function live(): Promise<Dict[]> {
    if (Date.now() / 1000 - herdr.t > LIVE_TTL_S) {
      let agents: Dict[] = [];
      try {
        const raw = (await exec(["herdr", "agent", "list"], { timeoutMs: LIVE_TIMEOUT_MS })).stdout;
        const result = (JSON.parse(raw || "{}") as { result?: { agents?: Dict[] } }).result;
        agents = result?.agents ?? [];
      } catch {
        agents = [];
      }
      herdr = { t: Date.now() / 1000, agents };
    }
    return herdr.agents;
  }

  function agent(name: string): Dict {
    if (!root || !AGENT_NAME.test(name)) throw new BadRequest("agente inválido");
    const a = readJson(join(root, "agents", `${name}.json`));
    if (!a) throw new BadRequest(`agente ${name} não registrado`);
    return a;
  }

  function autonomy(): Dict {
    const raw = Number(config().HADES_ORCH_AUTONOMY ?? "0");
    const level = Number.isInteger(raw) && raw >= MIN_LEVEL && raw <= MAX_LEVEL ? raw : MIN_LEVEL;
    return { level, label: LEVEL_LABELS[level] };
  }

  /** Mais recentes primeiro. */
  function decisions(): Dict[] {
    return readEvents({ agent: ORCH_JOURNAL, kind: "decision", limit: DECISIONS_SHOWN })
      .flatMap((e) => (e.decision ? [{ ts: e.ts, ...e.decision }] : []))
      .reverse();
  }

  async function snapshot(): Promise<Dict> {
    if (!root) return { available: false, agents: [], consolidations: [], autonomy: autonomy(), decisions: [] };
    const liveByName = new Map((await live()).filter((a) => a.name).map((a) => [a.name as string, a]));
    const rd = reportsDir();
    const agents: Dict[] = [];
    for (const f of jsonFiles(join(root, "agents"))) {
      const a = readJson(join(root, "agents", f));
      if (!a) continue;
      const w = join(String(a.worktree || "/nonexistent"), rd);
      const q = readText(join(w, "questions.md")) ?? "";
      const heads = [...q.matchAll(/^## (Q\d+.*)$/gm)].map((m) => m[1] as string);
      const answered = new Set([...q.matchAll(/^## Resposta do dono \((Q\d+)\)/gm)].map((m) => m[1] as string));
      const openQ = heads.filter((h) => !h.includes("(respondida)") && !answered.has(h.split(/\s+/)[0] as string));
      const report = (readText(join(w, "report.md")) ?? "").trimStart();
      const h = liveByName.get(a.name as string) ?? {};
      agents.push({
        ...a,
        live: (h.agent_status as string | undefined) || (a.state !== "done" ? "fora" : null),
        title: h.terminal_title_stripped ?? null, cwd: h.foreground_cwd ?? null, pane: h.pane_id ?? null,
        openQuestions: openQ, questions: heads.length, reportDone: report.startsWith("STATUS: DONE"),
        files: Object.entries(FILES).filter(([, v]) => existsSync(join(w, v))).map(([k]) => k),
      });
    }
    const consolidations = jsonFiles(join(root, "consolidations")).map((f) => readJson(join(root, "consolidations", f))).filter((c): c is Dict => c !== undefined);
    return { available: true, reportsDir: rd, agents, consolidations, autonomy: autonomy(), decisions: decisions() };
  }

  function file(name: string, which: string): Dict {
    const a = agent(name);
    const fileName = FILES[which];
    if (fileName === undefined || !Object.hasOwn(FILES, which)) throw new BadRequest("arquivo inválido");
    const path = join(String(a.worktree || "/nonexistent"), reportsDir(), fileName);
    return { name, file: path, text: readText(path) ?? null };
  }

  async function terminal(name: string): Promise<Dict> {
    agent(name);
    const raw = await out(["herdr", "agent", "read", name, "--source", "recent-unwrapped", "--lines", TERMINAL_LINES], TERMINAL_TIMEOUT_MS);
    return { name, text: raw.replace(ANSI, "") };
  }

  function publishPage(): Dict {
    const plan = root ? readJson(join(root, "plan.json"))?.path : undefined;
    if (!root || typeof plan !== "string" || !existsSync(plan)) {
      return { ok: false, message: "Sem plano aprovado: aprove um com hades agent plan-approve <plano.md> e tente de novo." };
    }
    const dir = join(env.dir, OFFLINE_DIR);
    mkdirSync(dir, { recursive: true });
    const htmlFile = join(dir, OFFLINE_FILE);
    const result = publish({
      model: "orquestracao", plan, scope: "personal", htmlFile, state: env.dir, teamEnabled: false,
      credentials: readText(join(env.dir, "credenciais.md")), skillRoots: [skillRoot], cwd: env.worktree,
      collect: (planPath, scope, now) => collectOrchestration(planPath, scope, now, { orch: root, skillOrch: root, skillScope: true }),
    });
    if (!result.ok) return { ok: false, message: "A página não foi gerada.", reasons: result.reasons, guard: result.kind === "guard" };
    return { ok: true, file: result.file, command: `hades minos publish orquestracao ${plan}` };
  }

  return { snapshot, file, terminal, publishPage };
}
