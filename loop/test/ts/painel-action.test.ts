// `hades panel action <id> [k=v ...] --json`: a montagem da rota POST /api/action sem HTTP, com $D fictício e
// systemd-run/systemctl de mentira no PATH (nenhuma ação roda de fato).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionBody } from "../../../src/panel/action-cli.ts";

const CLI = join(import.meta.dir, "../../../src/cli.ts");
const UNIT = "tpjob";

let root: string;
let D: string;
let bin: string;
let argvLog: string;
let active: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "painel-action-"));
  D = join(root, "hades-data");
  bin = join(root, "bin");
  argvLog = join(root, "systemd-run.argv");
  active = join(root, "active-units");
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(D, { recursive: true });
  writeFileSync(join(D, "env.sh"), `W="${join(root, "wt")}"\n`);
  writeFileSync(join(D, "gen-status.sh"), "echo status\n");
  writeFileSync(join(bin, "systemd-run"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\n`);
  writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash\ncat "${active}" 2>/dev/null\nexit 0\n`);
  chmodSync(join(bin, "systemd-run"), 0o755);
  chmodSync(join(bin, "systemctl"), 0o755);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(argvLog, { force: true });
  rmSync(active, { force: true });
  rmSync(join(D, "logs"), { recursive: true, force: true });
});

function action(...args: string[]): { rc: number; json: Record<string, unknown> & unknown[] } {
  const r = Bun.spawnSync(["bun", CLI, "panel", "action", ...args, "--json"], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: join(root, "home"), HADES_DATA: D,
      HADES_SERVICE_MANAGER: "systemd", HADES_JOB_UNIT: UNIT, WORK_ROOT: join(root, "work"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { rc: r.exitCode ?? -1, json: JSON.parse(r.stdout.toString() || "null") };
}

const jobsDir = (): string => join(D, "logs", "panel-jobs");

describe("actionBody", () => {
  test("k=v vira campo; repetido vira lista; [..] é JSON; true/false são booleanos", () => {
    expect(actionBody("svc", ["op=restart", "targets=a", "targets=b"])).toEqual({ action: "svc", op: "restart", targets: ["a", "b"] });
    expect(actionBody("select", ["mode=prs", "prs=[12,34]", "apply=true"])).toEqual({ action: "select", mode: "prs", prs: [12, 34], apply: true });
  });
  test("argumento sem = é recusado", () => {
    expect(() => actionBody("status", ["solto"])).toThrow("k=v");
  });
});

describe("hades panel action", () => {
  test("--list dá id, rótulo, ops e confirmação", () => {
    const { rc, json } = action("--list");
    expect(rc).toBe(0);
    const list = json as unknown as { id: string; label: string; ops: string[]; confirm: boolean | string[] }[];
    expect(list.map((a) => a.id)).toContain("status");
    expect(list.find((a) => a.id === "pause")).toEqual({ id: "pause", label: "Pausar ou retomar o Hades", ops: ["pause", "resume"], confirm: ["pause", "resume"] });
    expect(list.find((a) => a.id === "status")?.confirm).toBe(false);
  });

  test("ação válida lança o job pela unit transitória e devolve o id", () => {
    const { rc, json } = action("status");
    expect(rc).toBe(0);
    expect(json.title).toBe("Gerar STATUS.md");
    expect(json.exclusive).toBe(false);
    const id = json.job as string;
    expect(id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(readFileSync(argvLog, "utf8")).toContain(`--unit=${UNIT}-${id}`);
    const meta = JSON.parse(readFileSync(join(jobsDir(), `${id}.json`), "utf8"));
    expect(meta.action).toBe("status");
  });

  test("ação desconhecida sai com rc 2 e a lista", () => {
    const { rc, json } = action("nao-existe");
    expect(rc).toBe(2);
    expect(json.code).toBe("unknown_action");
    expect(json.actions).toContain("doctor");
    expect(existsSync(argvLog)).toBe(false);
  });

  test("valor fora da lista sai com rc 1 e código, sem lançar", () => {
    const { rc, json } = action("pause", "op=explodir");
    expect(rc).toBe(1);
    expect(typeof json.code).toBe("string");
    expect(json.error).toContain("valor fora da lista");
    expect(existsSync(argvLog)).toBe(false);
  });

  test("exclusiva com outra exclusiva rodando: ambiente ocupado", () => {
    mkdirSync(jobsDir(), { recursive: true });
    const id = "20261123-100000-abcd";
    writeFileSync(join(jobsDir(), `${id}.json`), JSON.stringify({ id, action: "update", title: "Atualizar (update.sh)", cmd: "x", exclusive: true, started: 1 }));
    writeFileSync(active, `${UNIT}-${id}.service loaded active running x\n`);
    const { rc, json } = action("update");
    expect(rc).toBe(1);
    expect(json.error).toBe("ambiente ocupado: Atualizar (update.sh)");
    expect(readdirSync(jobsDir()).filter((f) => f.endsWith(".json"))).toEqual([`${id}.json`]);
  });
});
