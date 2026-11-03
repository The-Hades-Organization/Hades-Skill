// Retomar de um handoff manda conferir a fila do gate-lock; start-cmd sobre registro com pane morto cria workspace novo.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionPrompt } from "../../../src/commands/agent-run";
import { Rig } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("agent: retomar confere a fila do gate-lock", () => {
  const base = { label: "impl", card: "roles/impl.md", worktree: "/wt/u", reports: ".design-sync-reports", extra: "" };
  test("dado resume, então o prompt manda conferir hades gate-lock status e esperar o que já está na fila", () => {
    const text = sessionPrompt({ ...base, sub: "resume" });
    expect(text).toContain("hades gate-lock status");
    expect(text).toContain("em vez de reenfileirar");
  });
  test("dado phase, então o prompt não leva a conferência (sessão de fase nova, sem check pendente)", () => {
    expect(sessionPrompt({ ...base, sub: "phase" })).not.toContain("gate-lock");
  });
});

describe("agent: start-cmd com pane morto", () => {
  const orch = join(r.T, "work/example__monorepo/orchestration");
  const bin = join(r.T, "herdr-vivo");
  const log = join(r.T, "herdr-vivo.log");
  mkdirSync(join(orch, "agents"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  // herdr com um único pane vivo (w9:p1); `workspace create` devolve o pane novo w7:p1
  writeFileSync(join(bin, "herdr"), `#!/usr/bin/env bash
echo "herdr $*" >> "${log}"
case "\${1:-} \${2:-}" in
  'pane list') echo '{"result":{"panes":[{"pane_id":"w9:p1","cwd":"/outro"}]}}' ;;
  'workspace create') echo '{"result":{"workspace":{"workspace_id":"w7"},"pane":{"pane_id":"w7:p1"}}}' ;;
  *) echo '{}' ;;
esac
`);
  chmodSync(join(bin, "herdr"), 0o755);
  const reg = (name: string, pane: string): void => {
    writeFileSync(join(orch, "agents", `${name}.json`), JSON.stringify({ name, mode: "deliver", role: "impl", worktree: join(r.T, `wt-${name}`), pane, state: "allocated" }));
  };
  const startCmd = (name: string): string => r.agent(["start-cmd", name], { env: { PATH: `${bin}:${r.env0.PATH}` } }).out;

  test("dado pane ausente do herdr, então cria workspace novo, imprime o pane novo e grava no registro", () => {
    reg("u-morto", "w1:p1");
    const text = startCmd("u-morto");
    expect(text).toContain("w7:p1");
    expect(text.split("\n").find((l) => l.startsWith("! herdr"))).not.toContain("w1:p1");
    expect(readFileSync(log, "utf8")).toContain("workspace create --cwd");
    expect(JSON.parse(readFileSync(join(orch, "agents/u-morto.json"), "utf8")).pane).toBe("w7:p1");
  });
  test("dado pane vivo, então reimprime o mesmo pane sem criar workspace", () => {
    reg("u-vivo", "w9:p1");
    writeFileSync(log, "");
    expect(startCmd("u-vivo")).toContain("w9:p1");
    expect(readFileSync(log, "utf8")).not.toContain("workspace create");
  });
});
