// Minos: o registro das saídas publicadas ($D/minos/outputs.json) e a pasta de cada uma ($D/minos/<saída>/). O link
// estável de cada saída mora aqui: a próxima publicação atualiza no mesmo lugar.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./work.ts";
import { isModelId, SCOPES, type ModelId, type Scope } from "./minos-model.ts";

const OUTPUT_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const ARTIFACT_PATH = /^\/(?:code\/)?artifact\/[A-Za-z0-9._-]+\/?$/;
export const ARTIFACT_HOST = "claude.ai";

export interface OutputRecord {
  model: ModelId;
  scope: Scope;
  plan: string;
  url: string | null;
  file: string;
  updatedAt: string;
}

export const minosDir = (state: string): string => join(state, "minos");
const registryFile = (state: string): string => join(minosDir(state), "outputs.json");

export function isOutputId(id: string): boolean {
  return OUTPUT_ID.test(id);
}

/** `<modelo>-<plano>` (e `-team` na página do time): o mesmo plano e escopo caem sempre na mesma saída. */
export function outputId(model: ModelId, planPath: string, scope: Scope): string {
  const base = (planPath.split("/").pop() ?? "").replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${model}-${base || "plano"}${scope === "team" ? "-team" : ""}`;
}

/** Só https://claude.ai/…/artifact/<id>: host de saída vindo de dado nunca é usado sem lista permitida. */
export function parseArtifactUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== ARTIFACT_HOST || url.port !== "" || url.username !== "" || url.password !== "") return undefined;
    if (!ARTIFACT_PATH.test(url.pathname)) return undefined;
    return `https://${ARTIFACT_HOST}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return undefined;
  }
}

function record(value: unknown): OutputRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const model = typeof r.model === "string" && isModelId(r.model) ? r.model : undefined;
  const scope = (SCOPES as readonly unknown[]).includes(r.scope) ? (r.scope as Scope) : undefined;
  if (!model || !scope || typeof r.file !== "string" || typeof r.plan !== "string" || typeof r.updatedAt !== "string") return undefined;
  const url = typeof r.url === "string" ? (parseArtifactUrl(r.url) ?? null) : null;
  return { model, scope, plan: r.plan, url, file: r.file, updatedAt: r.updatedAt };
}

export function readOutputs(state: string): Record<string, OutputRecord> {
  const raw = readJson(registryFile(state))?.outputs;
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([id, v]) => (isOutputId(id) && record(v) ? [[id, record(v) as OutputRecord]] : [])));
}

export function saveOutput(state: string, id: string, rec: OutputRecord): void {
  mkdirSync(minosDir(state), { recursive: true });
  writeJsonAtomic(registryFile(state), { outputs: { ...readOutputs(state), [id]: rec } });
}

/** Grava a página e os dados da saída; devolve o caminho do index.html. */
export function writeOutputFiles(state: string, id: string, page: string, data: string): string {
  const dir = join(minosDir(state), id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.html");
  writeFileSync(file, page);
  writeFileSync(join(dir, "data.json"), data);
  return file;
}
