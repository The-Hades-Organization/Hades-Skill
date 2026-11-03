// Grupo autonomia: hades agent decide (cada nível × cada classe, as que nunca cedem), auto-start (regra allow no
// settings.json sem tocar o resto), a trava de dono (hook e painel remoto) e o rastro no diário. reference/autonomia.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoStart, decide, startOrOwnerCommand } from "../../../src/commands/agent-autonomy";
import { AUTO_START_RULE, NEVER_CLASSES, autoStartStatus, hasAutoStartRule, judge, setAutoStartRule } from "../../../src/lib/autonomy";
import { parseEvent, readEvents } from "../../../src/lib/journal";
import { HadesError } from "../../../src/lib/output";
import { remoteConfigRefusal } from "../../../src/panel/routes-core";
import { BUN, SKILL } from "./lib/rig";

const T = mkdtempSync(join(tmpdir(), "hades-autonomia-"));
const HOME = join(T, "home");
const DATA = join(T, "data");
const SETTINGS = join(T, "settings.json");
const BIN = join(T, "bin");
const PLAN = join(T, "plano.md");
const LOG = join(T, "plano.log.md");
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["HOME", "HADES_DATA", "HADES_WORK_ROOT", "HADES_CLAUDE_SETTINGS", "PATH", "HADES_ORCH_AUTONOMY", "HADES_ORCH_AUTO_START"];

function setLevel(level: number, autoStart = 0): void {
  writeFileSync(join(DATA, "config.env"), `HADES_ORCH_AUTONOMY=${level}\nHADES_ORCH_AUTO_START=${autoStart}\n`);
}
const decideArgs = (needed: number, question: string, chosen: string, ...extra: string[]) =>
  [PLAN, "--level-needed", String(needed), "--question", question, "--chosen", chosen, ...extra];
const logText = () => (existsSync(LOG) ? readFileSync(LOG, "utf8") : "");

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  mkdirSync(join(HOME, ".claude/hades"), { recursive: true });
  mkdirSync(DATA, { recursive: true });
  mkdirSync(BIN, { recursive: true });
  writeFileSync(join(HOME, ".claude/hades/instance"), `${DATA}\n`);
  writeFileSync(join(DATA, "config.sh"), "");
  writeFileSync(join(DATA, "config.tsv"), readFileSync(join(SKILL, "kit/config.tsv")));
  writeFileSync(PLAN, "# Plano\n");
  process.env.HOME = HOME;
  process.env.HADES_DATA = DATA;
  process.env.HADES_WORK_ROOT = join(T, "work");
  process.env.HADES_CLAUDE_SETTINGS = SETTINGS;
  delete process.env.HADES_ORCH_AUTONOMY;
  delete process.env.HADES_ORCH_AUTO_START;
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(T, { recursive: true, force: true });
});

describe("autonomia: judge (nível × classe)", () => {
  const ordinary = { question: "reestimar a unidade?", chosen: "reestimar" };
  for (let level = 0; level <= 3; level++) {
    for (let needed = 1; needed <= 3; needed++) {
      test(`nível ${level} para decisão que pede ${needed}: ${level >= needed ? "permite" : "pergunta ao dono"}`, () => {
        expect(judge({ ...ordinary, levelNeeded: needed, currentLevel: level }).allowed).toBe(level >= needed);
      });
    }
  }
  for (const klass of NEVER_CLASSES) {
    test(`classe ${klass} recusa em todos os níveis, mesmo pedindo só o nível 1`, () => {
      for (let level = 0; level <= 3; level++) {
        const v = judge({ ...ordinary, levelNeeded: 1, currentLevel: level, neverClass: klass });
        expect(v).toMatchObject({ allowed: false, neverClass: klass });
      }
    });
  }
  test.each([
    ["autonivel", "subir HADES_ORCH_AUTONOMY para 3", "ok"],
    ["autonivel", "ligar o auto-start", "ok"],
    ["estouro", "a unidade passou de 150% do estimado: seguir?", "seguir"],
    ["push-publico", "dar push do snapshot da skill?", "push"],
    ["merge", "mergear a PR 12 no main?", "merge"],
    ["invariante", "relaxar um invariante da skill?", "sim"],
  ])("texto da classe %s é reconhecido sem --class: %s", (klass, question, chosen) => {
    expect(judge({ question, chosen, levelNeeded: 1, currentLevel: 3 })).toMatchObject({ allowed: false, neverClass: klass });
  });
});

describe("autonomia: hades agent decide", () => {
  test("nível 0 devolve ao dono (3) e não deixa rastro", async () => {
    setLevel(0);
    expect(await decide(decideArgs(1, "retry do gate?", "retry"))).toBe(3);
    expect(logText()).toBe("");
  });

  test("nível que cobre sai 0 e grava a linha no log do plano e o evento decision no diário", async () => {
    setLevel(2);
    expect(await decide(decideArgs(2, "responder a Q1 do agente x", "opção A", "--alternatives", "opção B; opção C"))).toBe(0);
    expect(logText()).toMatch(/decisão autônoma \(nível 2, exige 2\): responder a Q1 do agente x → opção A \[alternativas: opção B; opção C\]/);
    const [event] = readEvents({ agent: "_sessions/_orch", kind: "decision", limit: 5 }, join(T, "work"));
    expect(event?.source).toBe("orch");
    expect(event?.decision).toEqual({ level: 2, needed: 2, question: "responder a Q1 do agente x", chosen: "opção A", alternatives: ["opção B", "opção C"] });
    expect(parseEvent(JSON.stringify(event))?.decision?.alternatives).toHaveLength(2);
  });

  test("nível 3 não passa classe que nunca cede: sai 3 e não grava", async () => {
    setLevel(3);
    const before = logText();
    expect(await decide(decideArgs(1, "seguir além de 150% do estimado?", "seguir"))).toBe(3);
    expect(await decide(decideArgs(1, "qualquer", "x", "--class", "merge"))).toBe(3);
    expect(await decide(decideArgs(1, "trocar a configuração", "x", "--class", "autonivel"))).toBe(3);
    expect(logText()).toBe(before);
  });

  test("variável exportada na sessão do agente não eleva o nível", async () => {
    setLevel(0);
    process.env.HADES_ORCH_AUTONOMY = "3";
    try {
      expect(await decide(decideArgs(1, "retry?", "retry"))).toBe(3);
    } finally {
      delete process.env.HADES_ORCH_AUTONOMY;
    }
  });

  test.each([
    [["--level-needed", "0", "--question", "q", "--chosen", "c"], "nível 0"],
    [["--level-needed", "4", "--question", "q", "--chosen", "c"], "nível 4"],
    [["--level-needed", "1", "--chosen", "c"], "sem --question"],
    [["--level-needed", "1", "--question", "q", "--chosen", "c", "--class", "x"], "classe inválida"],
    [["--level-needed", "1", "--question", "q", "--chosen", "c", "--bogus", "1"], "opção desconhecida"],
  ])("argumento inválido (%j: %s) falha com erro de uso", async (rest) => {
    const call = decide([PLAN, ...rest]);
    await expect(call).rejects.toBeInstanceOf(HadesError);
  });

  test("plano inexistente falha", async () => {
    await expect(decide([join(T, "nao-existe.md"), "--level-needed", "1", "--question", "q", "--chosen", "c"])).rejects.toBeInstanceOf(HadesError);
  });
});

describe("autonomia: regra allow do auto-start", () => {
  // formatado como o JSON.stringify de 4 espaços: o ciclo on→off devolve o arquivo byte a byte
  const original = `${JSON.stringify({ model: "x", permissions: { allow: ["Bash(git status:*)", "Read(*)"], deny: ["Bash(rm -rf:*)"] }, hooks: { a: [1, 2] } }, null, 4)}\n`;

  test("on grava só a regra restrita, preserva o resto e a indentação; repetir não muda nada", () => {
    writeFileSync(SETTINGS, original);
    expect(setAutoStartRule(true)).toBe("added");
    const after = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(after.permissions.allow).toEqual(["Bash(git status:*)", "Read(*)", AUTO_START_RULE]);
    expect(after.permissions.deny).toEqual(["Bash(rm -rf:*)"]);
    expect(after.model).toBe("x");
    expect(after.hooks).toEqual({ a: [1, 2] });
    expect(readFileSync(SETTINGS, "utf8")).toContain('\n    "model"');
    const once = readFileSync(SETTINGS, "utf8");
    expect(setAutoStartRule(true)).toBe("unchanged");
    expect(readFileSync(SETTINGS, "utf8")).toBe(once);
  });

  test("nunca grava herdr * nem Bash(*)", () => {
    expect(AUTO_START_RULE).toBe("Bash(herdr agent start:*)");
    expect(readFileSync(SETTINGS, "utf8")).not.toMatch(/Bash\(\*\)|herdr \*/);
  });

  test("off remove exatamente a regra e devolve o arquivo ao que era; repetir não muda nada", () => {
    expect(setAutoStartRule(false)).toBe("removed");
    expect(JSON.parse(readFileSync(SETTINGS, "utf8"))).toEqual(JSON.parse(original));
    expect(readFileSync(SETTINGS, "utf8")).toBe(original);
    expect(setAutoStartRule(false)).toBe("unchanged");
    expect(readFileSync(SETTINGS, "utf8")).toBe(original);
  });

  test("off não remove regra parecida", () => {
    writeFileSync(SETTINGS, JSON.stringify({ permissions: { allow: ["Bash(herdr agent start:*)x", "Bash(herdr agent list:*)"] } }));
    expect(setAutoStartRule(false)).toBe("unchanged");
    expect(JSON.parse(readFileSync(SETTINGS, "utf8")).permissions.allow).toHaveLength(2);
  });

  test("arquivo ausente: on cria; off não cria", () => {
    rmSync(SETTINGS, { force: true });
    expect(setAutoStartRule(false)).toBe("unchanged");
    expect(existsSync(SETTINGS)).toBe(false);
    expect(setAutoStartRule(true)).toBe("added");
    expect(hasAutoStartRule()).toBe(true);
  });

  test("JSON inválido: recusa e não sobrescreve", () => {
    writeFileSync(SETTINGS, "{ quebrado");
    expect(() => setAutoStartRule(true)).toThrow(HadesError);
    expect(readFileSync(SETTINGS, "utf8")).toBe("{ quebrado");
  });

  test("auto-start on/off/status: o toggle e a regra andam juntos", () => {
    writeFileSync(SETTINGS, original);
    setLevel(0, 0);
    expect(autoStartStatus()).toMatchObject({ toggle: false, rule: false, active: false });
    expect(autoStart(["on"])).toBe(0);
    expect(autoStartStatus()).toMatchObject({ toggle: true, rule: true, active: true });
    expect(autoStart(["status"])).toBe(0);
    expect(autoStart(["off"])).toBe(0);
    expect(autoStartStatus()).toMatchObject({ toggle: false, rule: false, active: false });
    expect(readFileSync(SETTINGS, "utf8")).toBe(original);
  });
});

describe("autonomia: start entregue ao orquestrador só com toggle e regra", () => {
  const OWNER = "! herdr agent start agente-x --kind claude --pane w1:p1";

  test("toggle desligado: devolve o comando do dono", () => {
    writeFileSync(SETTINGS, "{}\n");
    setLevel(0, 0);
    const r = startOrOwnerCommand("agente-x", "w1:p1", "impl");
    expect(r.byOrchestrator).toBe(false);
    expect(r.command.startsWith(OWNER)).toBe(true);
  });

  test("toggle ligado sem a regra: comando do dono", () => {
    setLevel(0, 1);
    const r = startOrOwnerCommand("agente-x", "w1:p1", "impl");
    expect(r.byOrchestrator).toBe(false);
    expect(r.command.startsWith("! ")).toBe(true);
  });

  test("toggle e regra: comando sem '! ', para o orquestrador rodar como Bash", () => {
    setAutoStartRule(true);
    const r = startOrOwnerCommand("agente-x", "w1:p1", "impl");
    expect(r.byOrchestrator).toBe(true);
    expect(r.command.startsWith("herdr agent start agente-x --kind claude --pane w1:p1")).toBe(true);
    expect(r.command).toContain("-- --permission-mode auto");
  });

  test("sem painel: comando do dono", () => {
    expect(startOrOwnerCommand("agente-x", "", "impl").byOrchestrator).toBe(false);
  });
});

describe("autonomia: só o dono muda as chaves", () => {
  const hook = (command: string) => {
    const p = Bun.spawnSync([BUN, join(SKILL, "src/hook.ts")], {
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: T, tool_name: "Bash", tool_input: { command } })),
      env: { ...process.env, HOME },
    });
    return { rc: p.exitCode, err: p.stderr.toString() };
  };

  test.each([
    "hades config set HADES_ORCH_AUTONOMY=3",
    "bash ~/.claude/hades/instance/config.sh set HADES_ORCH_AUTO_START=1",
    "hades config unset HADES_ORCH_AUTONOMY",
    "HADES_ORCH_AUTONOMY=3 hades agent decide plano.md",
    `curl -s -X POST localhost:21220/api/config -d '{"values":{"HADES_ORCH_AUTONOMY":"3"}}'`,
    "hades agent auto-start on",
    "hades agent auto-start off",
  ])("o hook barra o que vem das ferramentas do Claude: %s", (command) => {
    const r = hook(command);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("Só o dono faz isso");
  });

  test.each([
    "hades agent auto-start status",
    "hades config get HADES_ORCH_AUTONOMY",
    "hades config set HADES_JOURNAL_DAYS=7",
    "hades agent decide plano.md --level-needed 1 --question q --chosen c",
  ])("o hook deixa passar a leitura e o resto: %s", (command) => {
    expect(hook(command).rc).toBe(0);
  });

  test("o painel remoto recusa as duas chaves; o local não é barrado", () => {
    expect(remoteConfigRefusal(["HADES_ORCH_AUTONOMY"])).toContain("painel local");
    expect(remoteConfigRefusal(["HADES_ORCH_AUTO_START"])).toContain("painel local");
    expect(remoteConfigRefusal(["HADES_ORCH_STALL_MIN"])).toBeUndefined();
  });
});
