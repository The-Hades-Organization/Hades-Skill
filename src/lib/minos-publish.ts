// Minos: o caminho de `hades minos publish`. A ordem é a garantia: dados validados, página montada, guarda (nada gravado
// se barrar) e só então os arquivos e o registro. Nada aqui fala com o claude.ai: publicar é da sessão (reference/minos.md).
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { collectOrchestration } from "./minos-collect.ts";
import { guardPublication } from "./minos-guard.ts";
import { activeProjectTerms } from "./release-guard.ts";
import { readText } from "./fs.ts";
import { descriptionOf, loadTemplate, renderPage, type MinosData } from "./minos-html.ts";
import { ContractError, MODELS, type ModelId, type OrchestrationData, type Scope } from "./minos-model.ts";
import { outputId, readOutputs, saveOutput, writeOutputFiles } from "./minos-store.ts";

export type Refusal = { ok: false; kind: "team-off" | "contract" | "guard" | "input"; reasons: string[] };
export type Published =
  | { ok: true; mode: "offline"; file: string }
  | { ok: true; mode: "artifact"; id: string; file: string; url: string | null; description: string; scope: Scope };

export interface PublishRequest {
  model: ModelId;
  /** a fonte: o plano (`orquestracao`) ou o JSON de dados que a sessão escreveu (`explicacao`, `proposta`) */
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

const DATA_FILE_MAX = 2 * 1024 * 1024;

/** O JSON da sessão: `scope` vem da invocação (o arquivo não escolhe ser do time) e `generatedAt`, se faltar, é agora. */
function loadDocument(model: ModelId, path: string, scope: Scope, now: Date): MinosData {
  const raw = readText(path);
  if (raw === undefined) throw new Error(`dados não encontrados: ${path}`);
  if (raw.length > DATA_FILE_MAX) throw new Error(`dados acima de ${DATA_FILE_MAX} bytes: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`dados não são JSON válido: ${path} (o exemplo sai em hades minos schema ${model})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ContractError("$", "esperava um objeto");
  const input = { generatedAt: `${now.toISOString().slice(0, 19)}Z`, ...parsed, scope };
  return MODELS[model].validate(input) as MinosData;
}

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
  let data: MinosData;
  try {
    data = MODELS[request.model].source === "plan"
      ? (request.collect ?? collectOrchestration)(request.plan, request.scope, now)
      : loadDocument(request.model, request.plan, request.scope, now);
  } catch (error) {
    if (error instanceof ContractError) return refuse("contract", `os dados não cumprem o contrato: ${error.message}`);
    return refuse("input", error instanceof Error ? error.message : String(error));
  }
  const page = renderPage(loadTemplate(), data);
  // a página pessoal de explicação/proposta descreve o projeto do dono: o nome dele não é vazamento ali
  const exceptProject = MODELS[request.model].source === "json" && request.scope === "personal" ? activeProjectTerms(request.cwd) : undefined;
  const reasons = guardPublication({ page, data: JSON.stringify(data, null, 2), credentials: request.credentials, skillRoots: request.skillRoots, cwd: request.cwd, exceptProject });
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
  return { ok: true, mode: "artifact", id, file, url, description: descriptionOf(data), scope: request.scope };
}
