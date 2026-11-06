// Argos (reference/argos.md): o servidor da página de agentes. Junta o grafo (argos-graph.ts) e as ações (argos-actions.ts)
// às rotas GET /api/argos/graph, GET /api/argos/node/:id e POST /api/argos/action. A faixa ao vivo reaproveita o SSE do
// diário (/api/journal/stream); nenhum stream novo.
import { join } from "node:path";
import { ARGOS_ERRORS, ArgosError } from "../lib/argos.ts";
import { ctxCapOf } from "../lib/ctx-cap.ts";
import { journalWorkRoot } from "../lib/journal.ts";
import { type Caller, createActions, notifyVia } from "./argos-actions.ts";
import { createGraph, registriesOf } from "./argos-graph.ts";
import type { PanelEnv } from "./env.ts";
import type { Herdr } from "./herdr.ts";
import type { HerdrPage } from "./herdr-page.ts";
import { send } from "./http.ts";

type Dict = Record<string, unknown>;

const DEFAULT_REPORTS_DIR = ".design-sync-reports";
const NODE_PREFIX = "/api/argos/node/";

export interface ArgosDeps {
  env: PanelEnv;
  herdr: Herdr;
  herdrPage: HerdrPage;
  /** a fila do gate-lock (o `gates` de gatewatch.detail()) */
  gates(): Dict[];
  config(): Record<string, string>;
  /** raiz de trabalho (`<raiz>/<owner__repo>/…` e `_skill`) */
  workRoot: string;
  journalRoot?: () => string;
}

export interface Argos {
  /** GET /api/argos/*: undefined se o caminho não é do Argos */
  get(path: string, query: Record<string, string>): Promise<Response | undefined>;
  /** POST /api/argos/action */
  act(body: Dict, caller: Caller): Promise<Response>;
}

/** O erro do Argos vira resposta com status e código estável; o resto sobe para o servidor (500 genérico). */
function refused(error: unknown): Response {
  if (error instanceof ArgosError) return send(error.status, { error: error.message, code: error.code });
  throw error;
}

export function createArgos(deps: ArgosDeps): Argos {
  const reportsDir = (): string => deps.config().HADES_ORCH_REPORTS_DIR || DEFAULT_REPORTS_DIR;
  const graph = createGraph({
    registries: () => registriesOf(deps.env.locks, deps.workRoot),
    journalRoot: deps.journalRoot ?? journalWorkRoot,
    herdr: deps.herdr,
    gates: deps.gates,
    reportsDir,
    ctxCap: (role) => ctxCapOf(role, (key) => deps.config()[key]),
    modelOf: (role) => deps.config()[`HADES_MODEL_${role.toUpperCase()}`] || undefined,
    agentMaxAgeHours: () => {
      const n = Number.parseInt(deps.config().HADES_ARGOS_AGENT_MAX_AGE_H ?? "", 10);
      // o padrão (24) vem do catálogo; sem a chave ou com valor inválido, nada é cortado
      return Number.isNaN(n) || n < 0 ? 0 : n;
    },
  });
  const actions = createActions({
    logFile: join(deps.env.dir, "logs", "panel-argos.log"),
    fallbackCwd: deps.env.worktree,
    herdrPage: deps.herdrPage,
    target(node) {
      const agent = graph.agentOf(node);
      return { id: node, name: agent.name, worktree: String(agent.data.worktree ?? ""), pane: String(agent.data.pane ?? "") };
    },
    live: (node) => graph.live(node),
    config: deps.config,
    notify: notifyVia(deps.env.dir, undefined),
  });

  return {
    async get(path, query) {
      try {
        if (path === "/api/argos/graph") return send(200, await graph.graph());
        if (path.startsWith(NODE_PREFIX)) {
          let id: string;
          try {
            id = decodeURIComponent(path.slice(NODE_PREFIX.length));
          } catch {
            throw new ArgosError(400, ARGOS_ERRORS.invalidNode, "id de nó inválido");
          }
          return send(200, await graph.node(id, query));
        }
        return undefined;
      } catch (error) {
        return refused(error);
      }
    },
    async act(body, caller) {
      try {
        return send(200, await actions.act(body, caller));
      } catch (error) {
        return refused(error);
      }
    },
  };
}
