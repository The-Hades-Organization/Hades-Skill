// Job e chat do painel numa instância com outro HOME: a unit transitória leva o HOME e as variáveis de instância do painel
// que a disparou, em vez do HOME do gerenciador de serviço (reference/panel.md §Ações).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceEnv } from "../../../src/lib/systemd-run-env.ts";
import { panelEnv } from "../../../src/panel/env.ts";
import { createJobs } from "../../../src/panel/jobs.ts";

const T = mkdtempSync(join(tmpdir(), "jobs-home-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const bin = join(T, "bin");
const argvLog = join(T, "argv.log");
mkdirSync(bin);
writeFileSync(join(bin, "systemd-run"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\n`);
chmodSync(join(bin, "systemd-run"), 0o755);

const painelHome = join(T, "home-do-painel");
const D = join(T, "limpo-data");
mkdirSync(D, { recursive: true });
writeFileSync(join(D, "env.sh"), `W="${join(T, "wt")}"\nHADES_ID="limpo"\n`);

function withEnv<R>(vars: Record<string, string>, run: () => R): R {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return run();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

const envFlags = (log: string): Map<string, string> => {
  const lines = log.split("\n");
  const pairs = new Map<string, string>();
  lines.forEach((line, i) => {
    if (line !== "-E") return;
    const [k, ...v] = (lines[i + 1] ?? "").split("=");
    pairs.set(k as string, v.join("="));
  });
  return pairs;
};

describe("jobs do painel: ambiente da unit", () => {
  test("dado um painel com HOME diferente do gerenciador, quando dispara um job, então a unit leva o HOME do painel", async () => {
    await withEnv({ HOME: painelHome, PATH: `${bin}:${process.env.PATH}`, HADES_SERVICE_MANAGER: "systemd", HADES_ID: "limpo" }, async () => {
      const jobs = createJobs(panelEnv(D));
      await jobs.launch("status", "Status", "echo oi", false);
    });
    const pairs = envFlags(readFileSync(argvLog, "utf8"));
    expect(pairs.get("HOME")).toBe(painelHome);
  });

  test("dada a instância limpo, quando dispara um job, então a unit leva HADES_ID e os nomes derivados", async () => {
    await withEnv({ HOME: painelHome, PATH: `${bin}:${process.env.PATH}`, HADES_SERVICE_MANAGER: "systemd", HADES_ID: "limpo" }, async () => {
      await createJobs(panelEnv(D)).launch("status", "Status", "echo oi", false);
    });
    const pairs = envFlags(readFileSync(argvLog, "utf8"));
    expect(pairs.get("HADES_ID")).toBe("limpo");
    expect(pairs.get("HU")).toBe("hds_limpo");
    expect(pairs.get("HSLICE")).toBe("hades_limpo");
    expect(pairs.get("HPROJ")).toBe("hades_limpo");
    expect(pairs.get("HADES_DATA")).toBe(D);
  });

  test("dada a instância original, então HADES_ID vai vazio e os nomes são os de sempre", () => {
    const dir = join(T, "orig-data");
    mkdirSync(dir);
    writeFileSync(join(dir, "env.sh"), `W="${join(T, "wt")}"\nHADES_ID=""\n`);
    const pairs = new Map(withEnv({ HADES_ID: "" }, () => instanceEnv(panelEnv(dir))));
    expect(pairs.get("HADES_ID")).toBe("");
    expect(pairs.get("HU")).toBe("hds");
    expect(pairs.get("HSLICE")).toBe("hades");
  });
});
