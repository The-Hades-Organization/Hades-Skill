// Minos: o caminho de `hades minos publish`. A ordem é a garantia: dados validados, página montada, guarda (nada gravado
// se barrar) e só então os arquivos e o registro. Nada aqui fala com o claude.ai: publicar é da sessão (reference/minos.md).
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { collectOrchestration } from "./minos-collect.ts";
import { guardPublication } from "./minos-guard.ts";
import { loadTemplate, pageDescription, renderOrchestrationHtml } from "./minos-html.ts";
import { ContractError, type ModelId, type OrchestrationData, type Scope } from "./minos-model.ts";
import { outputId, readOutputs, saveOutput, writeOutputFiles } from "./minos-store.ts";

export type Refusal = { ok: false; kind: "team-off" | "contract" | "guard" | "input"; reasons: string[] };
export type Published =
  | { ok: true; mode: "offline"; file: string }
  | { ok: true; mode: "artifact"; id: string; file: string; url: string | null; description: string; scope: Scope };

export interface PublishRequest {
  model: ModelId;
  plan: string;
  scope: Scope;
  /** `--html`: grava a página aqui e não pede publicação */
  htmlFile?: string;
  state: string;
  teamEnabled: boolean;
  credentials?: string;
  skillRoots: string[];
  cwd: string;
  now?: Date;
  /** injeção do coletor (teste e painel); o padrão lê o ambiente */
  collect?: (plan: string, scope: Scope, now: Date) => OrchestrationData;
}

const refuse = (kind: Refusal["kind"], ...reasons: string[]): Refusal => ({ ok: false, kind, reasons });

function writableHtml(path: string): string | undefined {
  const file = resolve(path);
  if (!/\.html?$/i.test(file)) return "--html: o arquivo precisa terminar em .html";
  if (!existsSync(dirname(file)) || !statSync(dirname(file)).isDirectory()) return `--html: a pasta ${dirname(file)} não existe`;
  if (existsSync(file) && statSync(file).isDirectory()) return `--html: ${file} é uma pasta`;
  return undefined;
}

export function publish(request: PublishRequest): Published | Refusal {
  if (request.scope === "team" && !request.teamEnabled) {
    return refuse("team-off", "a página do time está desligada (HADES_MINOS_TEAM=0): ela expõe o estado do trabalho a terceiros.", "Ligue no onboarding (passo \"Página do time\") ou em Configurações → Minos.");
  }
  const htmlProblem = request.htmlFile === undefined ? undefined : writableHtml(request.htmlFile);
  if (htmlProblem) return refuse("input", htmlProblem);
  const now = request.now ?? new Date();
  let data: OrchestrationData;
  try {
    data = (request.collect ?? collectOrchestration)(request.plan, request.scope, now);
  } catch (error) {
    if (error instanceof ContractError) return refuse("contract", `os dados não cumprem o contrato: ${error.message}`);
    return refuse("input", error instanceof Error ? error.message : String(error));
  }
  const page = renderOrchestrationHtml(loadTemplate(), data);
  const reasons = guardPublication({ page, data: JSON.stringify(data, null, 2), credentials: request.credentials, skillRoots: request.skillRoots, cwd: request.cwd });
  if (reasons.length) return refuse("guard", ...reasons);

  if (request.htmlFile !== undefined) {
    const file = resolve(request.htmlFile);
    writeFileSync(file, page);
    return { ok: true, mode: "offline", file };
  }
  const id = outputId(request.model, request.plan, request.scope);
  const file = writeOutputFiles(request.state, id, page, `${JSON.stringify(data, null, 2)}\n`);
  const url = readOutputs(request.state)[id]?.url ?? null;
  saveOutput(request.state, id, { model: request.model, scope: request.scope, plan: resolve(request.plan), url, file, updatedAt: `${now.toISOString().slice(0, 19)}Z` });
  return { ok: true, mode: "artifact", id, file, url, description: pageDescription(data), scope: request.scope };
}
