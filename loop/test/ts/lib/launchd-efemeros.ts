// Jobs, chat, amostrador e log de unit do painel no launchd, contra o launchctl falso do PATH (FAKE_LAUNCHCTL_DIR).
// Uso: bun lib/launchd-efemeros.ts <D>   (HADES_SERVICE_MANAGER=launchd, HADES_CHAT_BIN aponta para um executável qualquer)
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChat } from "../../../../src/panel/chat.ts";
import { panelEnv } from "../../../../src/panel/env.ts";
import { createJobs } from "../../../../src/panel/jobs.ts";
import { loadPlugin, unitNamePattern } from "../../../../src/panel/plugin.ts";
import { createMisc } from "../../../../src/panel/routes-misc.ts";
import { createSampler } from "../../../../src/panel/sampler.ts";
import { serviceManager } from "../../../../src/lib/service-manager.ts";

const fake = process.env.FAKE_LAUNCHCTL_DIR as string;
const privateDir = `${process.env.HOME}/.claude/hades/launchd`;
const ephemeral = (name: string): boolean => name.includes(".pjob-") || name.includes(".chat-");
const plists = (): string[] => (existsSync(privateDir) ? readdirSync(privateDir).filter((f) => f.endsWith(".plist") && ephemeral(f)).sort() : []);
const loadedLabels = (): string[] => (existsSync(`${fake}/loaded`) ? readdirSync(`${fake}/loaded`).filter(ephemeral).sort() : []);
const say = (key: string, value: unknown): void => console.log(`${key} ${JSON.stringify(value)}`);
const older = (file: string): void => utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

const env = panelEnv(process.argv[2] as string);
const jobs = createJobs(env);

const id = await jobs.launch("teste", "Teste", "echo oi", false);
say("job.plist", plists().map((p) => p.replace(id, "<id>")));
say("job.loaded", loadedLabels().map((p) => p.replace(id, "<id>")));
say("job.state", (await jobs.list()).map((j) => j.state));

await jobs.stop(id);
say("stop.plist", plists());
say("stop.loaded", loadedLabels());
say("stop.state", (await jobs.list()).map((j) => j.state));

// job que terminou sozinho: carregado e parado, sem .rc gravado pelo teste; o plist velho é recolhido na listagem
const done = await jobs.launch("teste", "Terminou", "true", false);
writeFileSync(`${fake}/loaded/com.hades.${env.hu}.pjob-${done}`, "exited:0");
older(join(privateDir, `com.hades.${env.hu}.pjob-${done}.plist`));
say("done.state", (await jobs.list()).map((j) => j.state));
say("done.plist", plists());
say("done.loaded", loadedLabels());

const chat = createChat({
  env, unit: `${env.hu}-chat`,
  config: () => ({ HADES_CHAT: "1", HADES_CHAT_BIN: process.env.HADES_CHAT_BIN ?? "", HADES_MODEL_CHAT: "modelo-x", HADES_EFFORT_CHAT: "alto" }),
});
const sid = await chat.send("", "olá", false);
const chatPlist = plists().find((f) => f.includes(".chat-"));
say("chat.stdin", chatPlist !== undefined && (await Bun.file(join(privateDir, chatPlist)).text()).includes(`<key>StandardInPath</key><string>${env.dir}/claude/${sid}.in</string>`));
say("chat.loaded", loadedLabels().map((p) => p.replace(sid, "<sid>")));
await chat.stop(sid);
say("chat.stopped", loadedLabels().filter((l) => l.includes(".chat-")));

// serviço persistente do painel: carregado, com log em arquivo
const manager = serviceManager();
manager.stop(`${env.hu}-panel`);
manager.write({ unit: `${env.hu}-panel`, description: "Painel", workdir: env.dir, env: [["K", "v"]], argv: ["/bin/sh"], logFile: join(env.dir, "logs", "panel.log"), restart: "on-failure", restartSec: 5 });
writeFileSync(join(env.dir, "logs", "panel.log"), "linha 1\nlinha 2\nlinha 3\n");
manager.start(`${env.hu}-panel`);
const sampler = createSampler({
  env, plugin: loadPlugin(env, undefined), jobs, herdr: { badge: async () => null } as never,
  configValues: () => ({ HADES_VERSION_CHECK_HOURS: "0" }), publicUrl: () => undefined, pluginSample: async () => ({}), chatUnit: `${env.hu}-chat`,
});
await sampler.sample();
const snap = sampler.snapshot() as { extras?: Record<string, Record<string, unknown>>; slice?: Record<string, unknown>; error?: string };
const panel = snap.extras?.panel ?? {};
say("sampler.panel", { state: panel.state, sub: panel.sub, restarts: panel.restarts });
say("sampler.slice", snap.slice);
say("sampler.error", snap.error ?? null);
const misc = createMisc({ env, jobs, config: () => ({}), containerNames: () => [], unitName: unitNamePattern(env.hu) });
say("log.unit", await misc.readLog(`unit:${env.hu}-panel`, "2"));
