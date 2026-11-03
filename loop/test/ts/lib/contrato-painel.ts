// Amostra o painel e lê o log de uma unit contra os comandos falsos do PATH: o que o painel mostra de cada unit e o que
// ele pergunta ao gerenciador. Uso: bun lib/contrato-painel.ts <D>
import { panelEnv } from "../../../../src/panel/env.ts";
import { createJobs } from "../../../../src/panel/jobs.ts";
import { createMisc } from "../../../../src/panel/routes-misc.ts";
import { loadPlugin, unitNamePattern } from "../../../../src/panel/plugin.ts";
import { createSampler } from "../../../../src/panel/sampler.ts";

const env = panelEnv(process.argv[2]!);
const jobs = createJobs(env);
const sampler = createSampler({
  env, plugin: loadPlugin(env, undefined), jobs, herdr: { badge: async () => null } as never,
  configValues: () => ({ HADES_VERSION_CHECK_HOURS: "0" }), publicUrl: () => undefined, pluginSample: async () => ({}), chatUnit: `${env.hu}-chat`,
});
await sampler.sample();
const snap = sampler.snapshot() as { services?: Array<Record<string, unknown>>; extras?: Record<string, Record<string, unknown>> };
const view = (v: Record<string, unknown>) => ({ state: v.state, sub: v.sub, result: v.result, restarts: v.restarts, mem: v.mem, aged: v.age !== null });
for (const s of snap.services ?? []) if (s.state !== "inactive") console.log(`service ${s.name} ${JSON.stringify(view(s))}`);
for (const [k, v] of Object.entries(snap.extras ?? {})) if (v.state !== "inactive") console.log(`extra ${k} ${JSON.stringify(view(v))}`);
const misc = createMisc({ env, jobs, config: () => ({}), containerNames: () => [], unitName: unitNamePattern(env.hu) });
console.log(`log unit: ${JSON.stringify(await misc.readLog(`unit:${env.hu}-panel`, "5"))}`);
