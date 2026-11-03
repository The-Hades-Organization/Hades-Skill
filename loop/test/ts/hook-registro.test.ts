// Grupo hook-registro: o install.sh registra o hook pelo Bun direto no settings.json do Claude Code, troca a entrada antiga
// (python3 …/hades-guard.py) sem duplicar e não mexe no settings.json de uma instalação descartável.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const OLD = "python3 ~/.claude/skills/hades/loop/hooks/hades-guard.py";
const group = (matcher: string, command: string) => ({ matcher, hooks: [{ type: "command", command }] });
const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { hooks: Record<string, { matcher: string; hooks: { command: string }[] }[]>; [k: string]: unknown };
const register = (file: string, env: Record<string, string> = {}) => r.hades(["guard", "register"], { merge: true, env: { HADES_CLAUDE_SETTINGS: file, ...env } });
const commands = (file: string, event: string) => read(file).hooks[event]!.flatMap((g) => g.hooks.map((h) => h.command));

describe("hook-registro", () => {
  test("sem settings.json: cria os cinco eventos chamando o Bun direto, sem Python", () => {
    const f = `${r.T}/s-novo/settings.json`;
    const o = register(f);
    expect(o.rc).toBe(0);
    for (const event of ["PreToolUse", "PostToolUse", "Notification", "Stop", "UserPromptSubmit"]) {
      const c = commands(f, event);
      expect(c).toHaveLength(1);
      expect(c[0]).toContain(`${SKILL}/src/hook.ts`);
      expect(c[0]).not.toContain("python");
    }
    expect(read(f).hooks.PreToolUse![0]!.matcher).toBe("*");
    expect(read(f).hooks.PostToolUse![0]!.matcher).toBe("*");
  });

  test("instalação existente: troca a entrada antiga no lugar, mantém as outras e o resto do arquivo", () => {
    const f = `${r.T}/s-velho.json`;
    writeFileSync(f, JSON.stringify({ model: "x", hooks: {
      PreToolUse: [group("Edit", "echo outro"), group("Bash", OLD)],
      PostToolUse: [group("*", OLD), group("*", "echo depois")],
      Stop: [group("", "echo fim")],
    } }));
    expect(register(f).rc).toBe(0);
    const doc = read(f);
    expect(doc.model).toBe("x");
    expect(commands(f, "PreToolUse")).toEqual(["echo outro", expect.stringContaining("src/hook.ts")]);
    expect(commands(f, "PostToolUse")).toEqual([expect.stringContaining("src/hook.ts"), "echo depois"]);
    expect(commands(f, "Stop")).toEqual(["echo fim", expect.stringContaining("src/hook.ts")]);
    expect(JSON.stringify(doc)).not.toContain("hades-guard.py");
  });

  test("rodar de novo não muda o arquivo nem duplica", () => {
    const f = `${r.T}/s-velho.json`, before = readFileSync(f, "utf8");
    const o = register(f);
    expect(o.out).toContain("já registrado");
    expect(readFileSync(f, "utf8")).toBe(before);
  });

  test("entradas nossas repetidas (antiga e nova) ficam numa só", () => {
    const f = `${r.T}/s-dup.json`;
    writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [group("Bash", OLD), group("Bash", OLD)], PostToolUse: [group("*", OLD)] } }));
    register(f);
    expect(commands(f, "PreToolUse")).toHaveLength(1);
    expect(commands(f, "PostToolUse")).toHaveLength(1);
  });

  test("settings.json que não é JSON: avisa, sai 1 e não sobrescreve", () => {
    const f = `${r.T}/s-ruim.json`;
    writeFileSync(f, "{ isto não fecha");
    const o = register(f);
    expect(o.rc).toBe(1);
    expect(o.all).toContain("não é JSON válido");
    expect(readFileSync(f, "utf8")).toBe("{ isto não fecha");
  });

  test("o comando gravado barra e libera como o hook: test fora da fila sai 2, comando comum sai 0", () => {
    const f = `${r.T}/s-run.json`;
    register(f);
    const cmd = commands(f, "PreToolUse")[0]!;
    const call = (command: string) => r.X(["sh", "-c", cmd], {
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "reg", cwd: r.T, tool_name: "Bash", tool_input: { command } }),
    });
    expect(call("sleep 30").rc).toBe(2);
    expect(call("echo oi").rc).toBe(0);
  });

  test("install.sh: grava o hook onde HADES_CLAUDE_SETTINGS manda; descartável sem a variável não toca no settings do HOME", () => {
    const wt = `${r.T}/wt-reg`;
    r.must(r.git(r.C, "worktree", "add", "-q", "-b", "reg/wt", wt));
    const inst = (data: string, env: Record<string, string>) => r.X(["bash", `${SKILL}/kit/install.sh`], { merge: true, env: { HADES_WT: wt, HADES_DATA: data, SKIP_SYSTEMD: "1", SKIP_DOCTOR: "1", ...env } });
    const f = `${r.T}/s-install.json`;
    writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [group("Bash", OLD)] } }));
    const first = inst(`${r.T}/d-reg1`, { HADES_CLAUDE_SETTINGS: f });
    expect(first.rc).toBe(0);
    expect(first.all, "o registro do hook não encerra o install (hades_ts faz exec)").toContain("kit instalado em");
    expect(commands(f, "PreToolUse")).toEqual([expect.stringContaining("src/hook.ts")]);
    expect(commands(f, "PostToolUse")).toHaveLength(1);
    mkdirSync(`${r.H}/.claude`, { recursive: true });
    expect(inst(`${r.T}/d-reg2`, {}).rc).toBe(0);
    expect(existsSync(`${r.H}/.claude/settings.json`)).toBe(false);
  });

  test("install.sh sem remote.origin: diz o que falta (antes abortava mudo)", () => {
    const repo = `${r.T}/sem-origin`;
    r.must(r.X(["git", "init", "-q", "-b", "main", repo]));
    r.must(r.X(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "x"]));
    const o = r.X(["bash", `${SKILL}/kit/install.sh`], { merge: true, env: { HADES_WT: repo, HADES_DATA: `${r.T}/d-sem-origin`, SKIP_SYSTEMD: "1", SKIP_WORKTREE: "1", SKIP_DOCTOR: "1" } });
    expect(o.rc).toBe(1);
    expect(o.all).toContain("remote.origin");
    expect(o.all).toContain("git -C");
  });
});
