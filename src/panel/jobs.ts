// Jobs do painel: cada ação vira uma unit transitória do gerenciador de serviço (systemd-run ou plist do launchd), que sobrevive ao restart do painel e para pela camada.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fs.ts";
import { pyJsonDumps } from "../lib/kit.ts";
import { serviceManager } from "../lib/service-manager.ts";
import { ListFailedError } from "../lib/service-manager-ctl.ts";
import type { PanelEnv } from "./env.ts";
import { exec, shlexQuote } from "./exec.ts";

const LIST_DEFAULT = 20;
const RC_LAUNCH_FAILED = "127";

export type JobState = "ok" | "falhou" | "rodando" | "interrompido";

export interface Job {
  id: string;
  action: string;
  title: string;
  cmd: string;
  exclusive: boolean;
  started: number;
  state?: JobState;
  rc?: number | string;
  ended?: number;
}

export interface Jobs {
  dir: string;
  unit: string;
  launch(action: string, title: string, script: string, exclusive: boolean): Promise<string>;
  stop(id: string): Promise<void>;
  list(n?: number): Promise<Job[]>;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const localStamp = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** `unit`: prefixo da unit (HADES_JOB_UNIT; a prova de uma unidade usa skilldev-<unidade>-job). */
export function createJobs(env: PanelEnv): Jobs {
  const dir = join(env.dir, "logs", "panel-jobs");
  const unit = process.env.HADES_JOB_UNIT || `${env.hu}-pjob`;
  const manager = serviceManager();
  mkdirSync(dir, { recursive: true });

  async function launch(action: string, title: string, script: string, exclusive: boolean): Promise<string> {
    const id = `${localStamp(new Date())}-${randomBytes(2).toString("hex")}`;
    const log = join(dir, `${id}.log`);
    const rc = join(dir, `${id}.rc`);
    const meta: Job = { id, action, title, cmd: script, exclusive, started: Date.now() / 1000 };
    writeFileSync(join(dir, `${id}.json`), pyJsonDumps(meta));
    writeFileSync(log, `$ ${script}\n`);
    const wrapped = `${script}\nrc=$?; echo $rc > ${shlexQuote(rc)}; exit $rc`;
    const argv = manager.transientArgv({
      unit: `${unit}-${id}`, workdir: env.dir, stdout: log, argv: ["/bin/bash", "-c", wrapped],
      env: [
        ["PATH", process.env.PATH ?? ""], ["NO_COLOR", "1"], ["TERM", "dumb"],
        ["HADES_WT", env.worktree], ["HADES_DATA", env.dir], ["HADES_PANEL_JOB", id],
      ],
    });
    const res = await exec(argv, { timeoutMs: 30_000 });
    if (res.status !== 0) {
      writeFileSync(rc, RC_LAUNCH_FAILED);
      appendFileSync(log, `${argv[0]} falhou: ${res.stderr}\n`);
    }
    return id;
  }

  async function list(n = LIST_DEFAULT): Promise<Job[]> {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      names = [];
    }
    const metas = names.sort().reverse().slice(0, n);
    const active = new Set<string>();
    if (metas.length) {
      try {
        for (const name of await manager.listActiveAsync(`${unit}-`)) active.add(name);
        manager.collectFinished(`${unit}-`, active);
      } catch (error) {
        // listagem que falhou não é conjunto vazio: nada é recolhido neste tick
        if (!(error instanceof ListFailedError)) throw error;
      }
    }
    const jobs: Job[] = [];
    for (const name of metas) {
      let meta: Job;
      try {
        meta = JSON.parse(readText(join(dir, name)) ?? "") as Job;
      } catch {
        continue;
      }
      const rcFile = join(dir, `${meta.id}.rc`);
      const rc = (readText(rcFile) ?? "").trim();
      if (rc) {
        meta.state = rc === "0" ? "ok" : "falhou";
        meta.rc = /^-?\d+$/.test(rc) ? Number.parseInt(rc, 10) : rc;
        meta.ended = statSync(rcFile).mtimeMs / 1000;
      } else meta.state = active.has(`${unit}-${meta.id}`) ? "rodando" : "interrompido";
      jobs.push(meta);
    }
    return jobs;
  }

  return {
    dir,
    unit,
    launch,
    stop: async (id) => void (await manager.stopTransientAsync(`${unit}-${id}`)),
    list,
  };
}
