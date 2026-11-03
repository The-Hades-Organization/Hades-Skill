// Nomes e saúde que o painel (hades panel) deriva de um $D: o que a prova multi-instância lê. Uso: bun lib/panel-env.ts <D>
import { panelEnv } from "../../../../src/panel/env.ts";
import { createJobs } from "../../../../src/panel/jobs.ts";
import { createSampler } from "../../../../src/panel/sampler.ts";
import { unitNamePattern } from "../../../../src/panel/plugin.ts";
const env = panelEnv(process.argv[2]!);
const jobs = createJobs(env);
const s = createSampler({ env, plugin: { cycleScripts: [] } as any, jobs, herdr: {} as any, configValues: () => ({}), publicUrl: () => undefined, pluginSample: async () => ({}), chatUnit: `${env.hu}-chat` });
const u = unitNamePattern(env.hu);
console.log(env.hu, env.slice, env.project, env.cookie, jobs.unit, `${env.hu}-chat`, u.test("hds-panel"), u.test("hds_projb-panel"), await s.baseRef());
console.log(JSON.stringify(env.health));
