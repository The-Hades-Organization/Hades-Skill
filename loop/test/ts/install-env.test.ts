// Grupo install-env: render do env.sh a partir do env.template.sh sem sed: o caminho entra literal.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderEnvSh, upgradeEnvSh } from "../../../src/lib/install-env";

const T = mkdtempSync(join(tmpdir(), "hades-install-env-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));
const TEMPLATE = readFileSync(join(import.meta.dir, "../../../kit/env.template.sh"), "utf8");
const sourced = (envsh: string, vars: string[]): string[] => {
  const file = join(T, "env.sh"); writeFileSync(file, envsh);
  const r = spawnSync("bash", ["-c", `source "$1"; printf '%s\\n' ${vars.map((v) => `"$${v}"`).join(" ")}`, "x", file], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: T } });
  return r.stdout.split("\n").slice(0, vars.length);
};

describe("install-env: render", () => {
  test("dado caminhos com #, & e \\, quando renderiza, então o env.sh lido pelo bash devolve o caminho exato", () => {
    const text = renderEnvSh(TEMPLATE, { wt: "/tmp/a#b&c\\d/wt", data: "/tmp/x&y#z/data", gateLock: "/g#l&k/gl.sh", locks: "/l\\o/locks", nodeBin: "/n&o#de/bin/node", id: "" });
    expect(sourced(text, ["W", "D", "GATE_LOCK", "LOCKS", "NODE_BIN", "HADES_ID"])).toEqual(["/tmp/a#b&c\\d/wt", "/tmp/x&y#z/data", "/g#l&k/gl.sh", "/l\\o/locks", "/n&o#de/bin/node", ""]);
  });

  test("dado o id da instância, então o HADES_ID do env.sh traz o id e nenhum marcador sobra", () => {
    const text = renderEnvSh(TEMPLATE, { wt: "/w", data: "/d", gateLock: "/g", locks: "/l", nodeBin: "/n", id: "proj_b" });
    expect(sourced(text, ["HADES_ID"])).toEqual(["proj_b"]);
    expect(text).not.toMatch(/__[A-Z_]+__/);
  });
});

describe("install-env: env.sh antigo", () => {
  const base = 'W="/w"\nD="/d"\n[[ -f $D/config.sh ]] && source "$D/config.sh"\n';
  test("dado env.sh sem HADES_ID, NODE_BIN e config.sh, quando atualiza, então acrescenta cada um uma vez (idempotente)", () => {
    const once = upgradeEnvSh("W=\"/w\"\nD=\"/d\"\n", "/usr/bin/node");
    expect(once).toContain('[[ -f $D/config.sh ]] && source "$D/config.sh"');
    expect(once).toContain('NODE_BIN="/usr/bin/node"');
    expect(upgradeEnvSh(once, "/usr/bin/node")).toBe(once);
  });
  test("dado env.sh anterior à 4.7.0, então HADES_ID vazio entra antes da linha do config.sh", () => {
    const lines = upgradeEnvSh(base, "/n").split("\n");
    const at = lines.findIndex((l) => l.startsWith("HADES_ID="));
    expect(lines[at]).toBe('HADES_ID=""   # acrescentado pelo install.sh (env.sh anterior à 4.7.0): a instância original');
    expect(lines[at + 1]).toBe('[[ -f $D/config.sh ]] && source "$D/config.sh"');
  });
});
