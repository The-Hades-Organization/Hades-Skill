// Grupo wait-proc: `hades wait proc <padrão>` e o aviso do guard para laço com sleep em segundo plano (issue #11).
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

const waitProc = (args: string[]) =>
  r.X(["timeout", "30", BUN, `${SKILL}/src/cli.ts`, "wait", "proc", ...args], { env: { HADES_WAIT_EVERY: "0.2" } });
const hook = (command: string, background: boolean, env: Record<string, string> = {}) =>
  r.X([BUN, `${SKILL}/src/hook.ts`], {
    stdin: JSON.stringify({ session_id: "wp1", cwd: r.T, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, run_in_background: background } }),
    env,
  });
const LOOP = 'while pgrep -f "skill-release.sh check" >/dev/null; do sleep 5; done; tail -6 saida';

describe("hades wait proc", () => {
  test("processo que termina: sai 0 e notifica com PROC <padrão> terminou", async () => {
    const marker = `wp-marker-${process.pid}`;
    const child = spawn("bash", ["-c", `exec -a ${marker} sleep 1`], { stdio: "ignore" });
    const o = waitProc([marker]);
    child.kill();
    expect(`${o.rc} ${o.out.trim()}`).toBe(`0 PROC ${marker} terminou`);
  });

  test("padrão que nada casa: sai na hora com 0", () => {
    const o = waitProc([`nada-casa-${process.pid}-zz`]);
    expect(`${o.rc} ${o.out.trim()}`).toBe(`0 PROC nada-casa-${process.pid}-zz terminou`);
  });

  test("padrão vazio é recusado com código de uso", () => {
    const o = r.X([BUN, `${SKILL}/src/cli.ts`, "wait", "proc", "  "], { merge: true });
    expect(o.rc).toBe(2);
    expect(o.all).toContain("padrão vazio");
  });

  test("padrão que casa com o próprio hades wait é recusado", () => {
    const o = r.X([BUN, `${SKILL}/src/cli.ts`, "wait", "proc", "wait proc"], { merge: true });
    expect(o.rc).toBe(2);
    expect(o.all).toContain("casa com o próprio hades wait");
  });

  test("sem o padrão: faltou <padrão>", () => {
    const o = r.X([BUN, `${SKILL}/src/cli.ts`, "wait", "proc"], { merge: true });
    expect(o.rc).not.toBe(0);
    expect(o.all).toContain("faltou <padrão>");
  });
});

describe("guard: laço com sleep", () => {
  test("em segundo plano: avisa com wait proc e não barra", () => {
    const o = hook(LOOP, true);
    expect(o.rc).toBe(0);
    const ctx = (JSON.parse(o.out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("laço com sleep em segundo plano");
    expect(ctx).toContain("hades wait proc 'skill-release.sh check'");
  });

  test("em segundo plano, laço sobre a fila do gate sugere wait queue", () => {
    const o = hook("until ! bash gate-lock.sh status | grep -q x; do sleep 5; done", true);
    expect(o.rc).toBe(0);
    expect(o.out).toContain("hades wait queue");
  });

  test("em primeiro plano continua barrado (exit 2)", () => {
    const o = hook(LOOP, false);
    expect(o.rc).toBe(2);
    expect(o.err).toContain("polling barrado (laço com sleep)");
    expect(o.err).toContain("proc <padrão-do-pgrep -f>");
  });

  test("segundo plano sem laço com sleep: nenhum aviso", () => {
    const o = hook("echo oi", true);
    expect(`${o.rc} ${o.out}`).toBe("0 ");
  });

  test("HADES_POLL_GUARD=0 desliga também o aviso", () => {
    const data = `${r.T}/data-poll-off`;
    mkdirSync(data, { recursive: true });
    writeFileSync(`${data}/config.tsv`, "HADES_POLL_GUARD\t1\n");
    writeFileSync(`${data}/config.env`, "HADES_POLL_GUARD=0\n");
    mkdirSync(`${r.H}/.claude/hades`, { recursive: true });
    writeFileSync(`${r.H}/.claude/hades/instance`, data);
    try {
      const o = hook(LOOP, true);
      expect(`${o.rc} ${o.out}`).toBe("0 ");
    } finally {
      rmSync(`${r.H}/.claude/hades/instance`, { force: true });
    }
  });
});
