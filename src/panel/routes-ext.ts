// Página Extensões: GET /api/extensions (o mesmo JSON do `hades ext list --json`) e POST (liga/desliga, grava HADES_EXT_<NOME>).
// A regra é do carregador (src/lib/extension.ts); aqui só a fronteira: formato do pedido, painel local e token (conferido no server.ts).
// Nada daqui instala: o comando de instalação é texto para o dono (reference/extensoes.md §Página do painel).
import { ConfigError, type ConfigStore } from "../lib/config-catalog.ts";
import { loadManifests, realDeps, setEnabled, statusOf, type ExtensionDeps, type ExtensionStatus } from "../lib/extension.ts";
import type { PanelEnv } from "./env.ts";

type Dict = Record<string, unknown>;

/** Códigos estáveis do que a página recusa (só ganham valores). */
export const EXT_PANEL_ERRORS = {
  unknown: "ext.unknown",
  badRequest: "ext.bad-request",
  localOnly: "ext.local-only",
  configInvalid: "ext.config-invalid",
} as const;

const JSON_VERSION = 1;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/; // o `name` do manifesto
// o comando de versão e o de saúde rodam de forma síncrona (até 5 s cada): a lista guarda o resultado por pouco tempo
const LIST_TTL_MS = 10_000;

export class ExtPanelRefused extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface ExtensionsRoutes {
  list(): Dict;
  /** liga ou desliga; só pelo painel local */
  act(body: Dict, remote: boolean): Dict;
}

export interface ExtensionsRoutesDeps {
  env: PanelEnv;
  /** relógio injetado (ms) para o cache da lista */
  now?: () => number;
  /** dependências do carregador; o padrão lê PATH e a configuração do $D do painel */
  deps?: () => ExtensionDeps;
}

export function createExtensionsRoutes(opts: ExtensionsRoutesDeps): ExtensionsRoutes {
  const now = opts.now ?? Date.now;
  const store: ConfigStore = { dir: opts.env.dir, kit: opts.env.dir };
  const deps = opts.deps ?? ((): ExtensionDeps => realDeps(process.env, store));
  let cached: { at: number; statuses: ExtensionStatus[] } | undefined;

  function statuses(): ExtensionStatus[] {
    if (cached !== undefined && now() - cached.at < LIST_TTL_MS) return cached.statuses;
    const d = deps();
    const fresh = loadManifests().extensions.map((e) => statusOf(e.manifest, d));
    cached = { at: now(), statuses: fresh };
    return fresh;
  }

  return {
    list: () => ({ version: JSON_VERSION, extensions: statuses() }),
    act(body, remote) {
      if (remote) throw new ExtPanelRefused(EXT_PANEL_ERRORS.localOnly, "ligar e desligar extensões só se faz pelo painel local", 403);
      const { op, name } = body;
      if (op !== "enable" && op !== "disable") throw new ExtPanelRefused(EXT_PANEL_ERRORS.badRequest, "operação inválida (enable ou disable)", 400);
      if (typeof name !== "string" || !NAME.test(name)) throw new ExtPanelRefused(EXT_PANEL_ERRORS.badRequest, "nome de extensão inválido", 400);
      const found = loadManifests().extensions.find((e) => e.manifest.name === name);
      if (found === undefined) throw new ExtPanelRefused(EXT_PANEL_ERRORS.unknown, `extensão desconhecida: ${name}`, 404);
      try {
        setEnabled(found.manifest, op === "enable", store);
      } catch (error) {
        if (error instanceof ConfigError) throw new ExtPanelRefused(EXT_PANEL_ERRORS.configInvalid, error.message, 400);
        throw error;
      }
      cached = undefined;
      return { version: JSON_VERSION, ok: true, name, enabled: op === "enable" };
    },
  };
}
