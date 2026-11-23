// `hades panel dump <rota>`: o corpo das rotas GET de leitura do painel, pelas mesmas funções, sem subir HTTP.
import { dirname } from "node:path";
import { effectiveConfig, resolveHerdrBin } from "../lib/config.ts";
import { PANEL_ERRORS } from "../lib/human-errors.ts";
import { home } from "../lib/paths.ts";
import { inheritedView } from "../lib/settings-default.ts";
import { registriesOf } from "./argos-graph.ts";
import { panelEnv, readEnvSh } from "./env.ts";
import { createGateWatch, workRoot } from "./gatewatch.ts";
import { createHerdr } from "./herdr.ts";
import { BadRequest } from "./http.ts";
import { createJobs } from "./jobs.ts";
import { createMoiraiRoutes, MoiraiError } from "./moirai.ts";
import { createOrchestration } from "./orchestration.ts";
import { loadPlugin, unitNamePattern } from "./plugin.ts";
import * as core from "./routes-core.ts";
import { createMisc } from "./routes-misc.ts";
import { createSampler } from "./sampler.ts";

type Query = Record<string, string>;
type Read = (query: Query, rest: string) => Promise<unknown>;

export interface DumpResult {
  rc: number;
  body: unknown;
}

/** Rotas de leitura do painel (sem `/api/`); a que termina em `/` leva o resto do caminho, como `moirai/unit/<nome>`. */
export function panelReads(dir: string): Record<string, Read> {
  const env = panelEnv(dir);
  const config = (): Record<string, string> => core.configValues(env);
  const jobs = createJobs(env);
  const herdrBin = resolveHerdrBin(effectiveConfig(dir).get("HADES_HERDR_BIN"));
  const sampler = createSampler({
    env, plugin: loadPlugin(env, undefined), jobs, herdr: createHerdr({ bin: herdrBin }), configValues: config,
    publicUrl: () => undefined, pluginSample: async () => ({}), chatUnit: process.env.HADES_CHAT_UNIT || `${env.hu}-chat`,
  });
  const sampled = async (): Promise<Record<string, unknown>> => {
    await sampler.sample();
    const { history: _history, ...snap } = sampler.snapshot();
    return snap;
  };
  const root = env.locks ? dirname(dirname(env.locks)) : workRoot(process.env, home());
  const containerNames = (): string[] => ((sampler.snapshot().containers as { name: string }[] | undefined) ?? []).map((c) => c.name);
  const misc = createMisc({ env, jobs, config, containerNames, unitName: unitNamePattern(env.hu) });
  const orchestration = createOrchestration(env, config, herdrBin);
  const moirai = createMoiraiRoutes({ registries: () => registriesOf(env.locks, root), config });
  const gates = async (): Promise<unknown> => {
    const watch = createGateWatch({ dir: env.dir, locks: env.locks, gateLock: readEnvSh(env.dir).GATE_LOCK, fallbackGates: sampler.gateQueue, root });
    await watch.sample();
    return watch.detail();
  };
  return {
    snapshot: sampled,
    gates,
    config: async () => core.configState(env),
    "config/inherited": async () => inheritedView(),
    "config/export": async (q) => new TextDecoder().decode(core.configExport(env, q, false)),
    doctor: async () => core.doctorState(env),
    quality: async () => core.qualityState(env),
    cerberus: async () => ({ ...core.cerberusState(env), remote: false }),
    "rtk-trust": async () => core.rtkTrustState(env),
    docs: async () => core.docsIndex(env),
    doc: async (q) => core.docText(env, q.id ?? ""),
    orchestration: () => orchestration.snapshot(),
    "orchestration/file": async (q) => orchestration.file(q.name ?? "", q.file ?? ""),
    "moirai/plan": async () => moirai.plan(),
    "moirai/unit/": async (q, rest) => moirai.unit(decodeURIComponent(rest), q.registry),
    usage: async () => misc.usage(),
    limits: async () => misc.limits(),
    reviews: () => misc.reviews(),
    "reviews/loop": async () => misc.reviewsLoop(),
    "review/report": async (q) => misc.reviewReport(q.id ?? ""),
    journal: async (q) => misc.journal.list(q),
    "log-files": async () => (await sampled(), misc.logSources()),
    log: async (q) => (await sampled(), misc.readLog(q.src ?? "", q.n ?? "400", q.offset)),
  };
}

/** `rota` aceita `?k=v` e `/api/` na frente; `args` extra vêm como `k=v`. Rota desconhecida: rc 2 com a lista. */
export async function panelDump(dir: string, route: string, args: string[] = []): Promise<DumpResult> {
  const [pathPart = "", search = ""] = route.split("?", 2);
  const path = pathPart.replace(/^\/?(api\/)?/, "").replace(/\/$/, "");
  const query: Query = {};
  for (const [k, v] of new URLSearchParams([search, ...args].filter(Boolean).join("&"))) if (v !== "" && !(k in query)) query[k] = v;
  const reads = panelReads(dir);
  const key = path in reads && !path.endsWith("/") ? path : Object.keys(reads).find((k) => k.endsWith("/") && path.startsWith(k) && path.length > k.length);
  if (!key) return { rc: 2, body: { error: `rota desconhecida: ${route}`, code: "unknown_route", routes: Object.keys(reads).map((k) => (k.endsWith("/") ? `${k}<nome>` : k)) } };
  try {
    return { rc: 0, body: await reads[key]!(query, path.slice(key.length)) };
  } catch (error) {
    if (error instanceof MoiraiError) return { rc: 1, body: { error: error.message, code: error.code } };
    if (error instanceof BadRequest) return { rc: 1, body: { error: error.message, code: PANEL_ERRORS.badRequest } };
    if (error instanceof URIError) return { rc: 1, body: { error: "nome de unidade inválido", code: "invalid_unit" } };
    throw error;
  }
}
