// Casos do mac-fix-review que precisam de processo próprio (umask, env do launchctl falso, painel), contra o launchctl falso.
// Uso: bun lib/mac-fix-review.ts <caso> <D>   (HADES_SERVICE_MANAGER=launchd, FAKE_LAUNCHCTL_DIR)
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChat } from "../../../../src/panel/chat.ts";
import { panelEnv } from "../../../../src/panel/env.ts";
import { createJobs } from "../../../../src/panel/jobs.ts";
import { serviceManager } from "../../../../src/lib/service-manager.ts";

const [kase = "", dir = ""] = process.argv.slice(2);
const fake = process.env.FAKE_LAUNCHCTL_DIR as string;
const privateDir = `${process.env.HOME}/.claude/hades/launchd`;
const say = (key: string, value: unknown): void => console.log(`${key} ${JSON.stringify(value)}`);
const older = (file: string): void => utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
const plists = (): string[] => (existsSync(privateDir) ? readdirSync(privateDir).filter((f) => f.endsWith(".plist")).sort() : []);
const mode = (file: string): string => (statSync(file).mode & 0o777).toString(8);
const calls = (): string[] => readFileSync(`${fake}/calls.log`, "utf8").split("\n").filter(Boolean);
const spec = (argv: string[]) => ({ unit: "hds-fixt", description: "x", workdir: dir, env: [["K", "v"]] as [string, string][], argv, logFile: `${dir}/logs/fixt.log`, restart: "on-failure" as const, restartSec: 5 });

const manager = serviceManager();

if (kase === "jobs-list-fail") {
  const env = panelEnv(dir);
  const jobs = createJobs(env);
  const id = await jobs.launch("teste", "Terminou", "true", false);
  older(join(privateDir, `com.hades.${env.hu}.pjob-${id}.plist`));
  process.env.FAKE_LIST_FAIL = "1";
  await jobs.list();
  say("plists", plists().map((p) => p.replace(id, "<id>")));
  say("loaded", existsSync(`${fake}/loaded/com.hades.${env.hu}.pjob-${id}`));
}

if (kase === "chat-list-fail") {
  const env = panelEnv(dir);
  const chat = createChat({ env, unit: `${env.hu}-chat`, config: () => ({ HADES_CHAT: "1", HADES_CHAT_BIN: process.env.HADES_CHAT_BIN ?? "" }) });
  const sid = await chat.send("", "olá", false);
  older(join(privateDir, `com.hades.${env.hu}.chat-${sid}.plist`));
  process.env.FAKE_LIST_FAIL = "1";
  await chat.overview(false);
  say("plist", plists().some((p) => p.includes(".chat-")));
  say("loaded", existsSync(`${fake}/loaded/com.hades.${env.hu}.chat-${sid}`));
  say("closed", readFileSync(join(env.dir, "claude", `${sid}.jsonl`), "utf8").includes("hds_end"));
}

if (kase === "sync-list-fail") {
  process.env.FAKE_LIST_FAIL = "1";
  try {
    manager.listActive("com.hades.");
    say("threw", false);
  } catch (error) {
    say("threw", (error as Error).name);
  }
  say("async", await manager.listActiveAsync("hds-").then(() => "ok", (error: Error) => error.name));
}

if (kase === "start-rewrite") {
  manager.write(spec(["/bin/sh", "-c", "a"]));
  manager.start("hds-fixt");
  writeFileSync(`${fake}/loaded/com.hades.hds.fixt`, "exited:0\n");
  writeFileSync(`${fake}/calls.log`, "");
  manager.write(spec(["/bin/sh", "-c", "b"]));
  say("rc", manager.start("hds-fixt"));
  say("verbs", calls().map((c) => c.split(" ")[0]).filter((v) => v !== "print"));
  say("state", readFileSync(`${fake}/loaded/com.hades.hds.fixt`, "utf8").trim());
}

if (kase === "start-same") {
  manager.write(spec(["/bin/sh", "-c", "a"]));
  manager.start("hds-fixt");
  writeFileSync(`${fake}/loaded/com.hades.hds.fixt`, "exited:0\n");
  writeFileSync(`${fake}/calls.log`, "");
  manager.write(spec(["/bin/sh", "-c", "a"]));
  say("rc", manager.start("hds-fixt"));
  say("verbs", calls().map((c) => c.split(" ")[0]).filter((v) => v !== "print"));
}

if (kase === "restart-unloaded") {
  manager.write(spec(["/bin/sh"]));
  say("rc", manager.restart("hds-fixt"));
  say("loaded", existsSync(`${fake}/loaded/com.hades.hds.fixt`));
}

if (kase === "restart") {
  manager.write(spec(["/bin/sh"]));
  manager.start("hds-fixt");
  writeFileSync(`${fake}/calls.log`, "");
  // a falha do stub vale só para o restart: o start de preparação já subiu
  for (const key of ["BOOTSTRAP_BUSY", "BOOTSTRAP_FAIL"]) if (process.env[`LATE_${key}`] !== undefined) process.env[`FAKE_${key}`] = process.env[`LATE_${key}`];
  say("rc", manager.restart("hds-fixt"));
  say("bootstraps", calls().filter((c) => c.startsWith("bootstrap")).length);
}

if (kase === "modes") {
  process.umask(0o077);
  manager.write(spec(["/bin/sh"]));
  say("write", mode(`${privateDir}/com.hades.hds.fixt.plist`));
  const [, , , file = ""] = manager.transientArgv({ unit: "hds-fixt-job", workdir: dir, stdout: `${dir}/j.log`, env: [], argv: ["/bin/sh"] });
  say("transient", mode(file));
  manager.writeTimer({ unit: "hds-fixt-timer", description: "x", timerDescription: "x", env: [], argv: ["/bin/sh"], logFile: `${dir}/logs/t.log`, every: "6h", everySec: 21600, background: true });
  say("timer", mode(`${privateDir}/com.hades.hds.fixt-timer.plist`));
}
