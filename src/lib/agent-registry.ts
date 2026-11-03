// Registro dos agentes e estado das entregas (lib.sh reg_get/reg_set/delivery_set) e as pequenas regras do hades agent
// que mais de um subcomando usa.
import { join } from "node:path";
import { herdrRefOf, type HerdrRef } from "./argos-graph-ui.ts";
import { run, which } from "./proc.ts";
import { readJson, writeJsonAtomic, agentFile, configValue, type Json, type WorkEnv } from "./work.ts";

export const isoNow = (): string => `${new Date().toISOString().slice(0, 19)}Z`;

/** Registro novo no lugar do anterior (o `reg_set` com um objeto literal do jq). */
export function regReplace(work: WorkEnv, name: string, record: Json): void {
  writeJsonAtomic(agentFile(work, name), record);
}

/** `reg_set` com atualização: os campos novos entram no fim, os existentes ficam na posição. */
export function regUpdate(work: WorkEnv, name: string, update: (current: Json) => Json): void {
  const file = agentFile(work, name);
  writeJsonAtomic(file, update(readJson(file) ?? {}));
}

const counter = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/**
 * Sessão limpa de `phase` ou `resume`: os dois fazem /clear (`clears` conta os dois); só o resume incrementa `resumes`,
 * que o histórico da Moirai lê. Registro antigo, sem o campo, começa de zero.
 */
export function afterFreshSession(record: Json, sub: "phase" | "resume", label: string, promptedAt: string): Json {
  return {
    ...record, phase: label, state: "working", promptedAt, clears: counter(record.clears) + 1,
    ...(sub === "resume" ? { resumes: counter(record.resumes) + 1 } : {}),
  };
}

/** O texto de um campo como o `jq -r`: ausente vira "null". */
export function jqText(value: unknown): string {
  if (value === undefined || value === null) return "null";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Entrega no estado global do loop: deliveries[<chave>] (delivery_set). */
export function deliverySet(work: WorkEnv, key: string, update: (delivery: Json) => Json): void {
  const file = join(work.state, "global.json");
  const doc = readJson(file) ?? { version: 2, deliveries: {} };
  const deliveries = typeof doc.deliveries === "object" && doc.deliveries !== null && !Array.isArray(doc.deliveries) ? (doc.deliveries as Json) : {};
  const current = deliveries[key];
  const delivery = typeof current === "object" && current !== null && !Array.isArray(current) ? (current as Json) : {};
  writeJsonAtomic(file, { ...doc, deliveries: { ...deliveries, [key]: update(delivery) } });
}

/** O comando de start do dono, com modelo e esforço do papel (Configurações). */
export function startCommand(name: string, pane: string, role: string): string {
  const key = role.toUpperCase();
  const model = configValue(`HADES_MODEL_${key}`, "");
  const effort = configValue(`HADES_EFFORT_${key}`, "");
  return `! herdr agent start ${name} --kind claude --pane ${pane || "<pane>"} -- --permission-mode auto${model ? ` --model ${model}` : ""}${effort ? ` --effort ${effort}` : ""}`;
}

export function roleCard(skillRoot: string, role: string): string {
  return join(skillRoot, "reference", "loop", "roles", `${role}.md`);
}

/** `${HADES_ORCH_…:-padrão}` com o til da raiz de pastas expandido. */
export function expandHome(path: string, home: string): string {
  return path.startsWith("~") ? `${home}${path.slice(1)}` : path;
}

const SESSION_LIST_TIMEOUT_MS = 5_000;

/**
 * O pane do herdr de quem roda a CLI (o orquestrador que aloca o agente): `HERDR_PANE_ID` e a sessão de
 * `HADES_HERDR_SESSION`, ou a do socket do ambiente (`herdr session list`), ou `default` — a mesma regra do
 * `hades canvas`. Fora de um pane, `undefined`.
 */
export function callerPane(env: NodeJS.ProcessEnv = process.env): HerdrRef | undefined {
  const pane = env.HERDR_PANE_ID;
  if (!pane) return undefined;
  const fixed = env.HADES_HERDR_SESSION;
  if (fixed) return herdrRefOf(pane, fixed) ?? undefined;
  const socket = env.HERDR_SOCKET_PATH;
  let session = "default";
  if (socket && which("herdr")) {
    const r = run("herdr", ["session", "list", "--json"], { timeoutMs: SESSION_LIST_TIMEOUT_MS });
    try {
      const sessions: unknown = r.status === 0 ? (JSON.parse(r.stdout) as Json).sessions : [];
      const match = Array.isArray(sessions) ? sessions.find((s) => typeof s === "object" && s !== null && (s as Json).socket_path === socket) : undefined;
      if (match && typeof (match as Json).name === "string") session = (match as Json).name as string;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return herdrRefOf(pane, session) ?? undefined;
}

/**
 * `{ orchestrator }` para o registro do agente quando quem chama roda num pane do herdr que não é o do próprio agente
 * (reference/argos.md §Orquestrador no canvas): o Argos liga o terminal desse pane ao agente. Fora de pane, nada.
 */
export function orchestratorField(agentPane: string, env: NodeJS.ProcessEnv = process.env): { orchestrator?: HerdrRef } {
  const caller = callerPane(env);
  return caller && caller.pane !== agentPane ? { orchestrator: caller } : {};
}
