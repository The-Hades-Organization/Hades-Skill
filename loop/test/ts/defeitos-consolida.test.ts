// Defeitos registrados na 5.0.0, cada um com o teste que falhava antes da correção.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISPOSABLE_DATA } from "../../../src/commands/agent-skill.ts";
import { gateOverrunLimitS, parseTicket, runningOverrun, typicalDurationS } from "../../../src/lib/gate.ts";
import { guardRules, maskDataStatements } from "../../../src/lib/guard-rules.ts";
import { HOOK } from "./lib/hook";
import { BUN, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

const journalOf = (label: string, durations: number[]): string =>
  durations.map((s, i) => `2026-10-28T0${i}:00:00Z\tdone\ttest\t${label}\t4\tclone\trc=0\tdur=${s}s\tcmd=x`).join("\n");
const running = (label: string, startedS: number) => parseTicket(`state=running\nlabel=${label}\nstarted=${startedS}\n`);
const NOW = 1_800_000_000;

describe("5a: gate rodando muito acima do normal é acusado", () => {
  test("gate de 10 min normais rodando há 7 h dá estouro", () => {
    const overrun = runningOverrun(running("regressao", NOW - 7 * 3600), journalOf("regressao", [600, 650, 580]), NOW, 90, 5);
    expect(overrun).toContain("ESTOURO");
    expect(overrun).toContain("420 min");
  });

  test("gate dentro do normal não dá estouro", () => {
    expect(runningOverrun(running("regressao", NOW - 20 * 60), journalOf("regressao", [600]), NOW, 90, 5)).toBeUndefined();
  });

  test("o limite é o maior entre o piso e o fator vezes o normal", () => {
    expect(gateOverrunLimitS(3600, 90, 5)).toBe(5 * 3600);
    expect(gateOverrunLimitS(60, 90, 5)).toBe(90 * 60);
    expect(gateOverrunLimitS(undefined, 90, 5)).toBe(90 * 60);
  });

  test("sem histórico vale só o piso; ticket que não está rodando nunca overruna", () => {
    expect(runningOverrun(running("novo", NOW - 2 * 3600), "", NOW, 90, 5)).toContain("sem histórico");
    expect(runningOverrun(parseTicket(`state=waiting\nlabel=x\nstarted=${NOW - 99_999}\n`), "", NOW, 90, 5)).toBeUndefined();
  });

  test("a mediana ignora outros labels e execuções sem duração", () => {
    expect(typicalDurationS(`${journalOf("a", [10, 30, 20])}\n${journalOf("b", [999])}`, "a")).toBe(20);
    expect(typicalDurationS("", "a")).toBeUndefined();
  });

  test("gate-lock status mostra o ESTOURO do gate que roda além do limite", () => {
    const locks = `${r.T}/overrun-work/locks/gate-queue`;
    mkdirSync(locks, { recursive: true });
    writeFileSync(`${locks}/1.t`, `state=running\nkind=test\ncost=4\nlabel=lento\npid=${process.pid}\nsince=2026-10-28T00:00:00Z\nclone=x\nstarted=${Math.floor(Date.now() / 1000) - 8 * 3600}\n`);
    const x = r.hades(["gate-lock", "status"], { env: { HADES_WORK: `${r.T}/overrun-work` } });
    expect(x.out).toContain("label=lento");
    expect(x.out).toContain("ESTOURO: rodando há 480 min");
  });
});

describe("5b: o hook não barra padrão de polling citado como dado", () => {
  const rules = guardRules();
  const pollsOn = (cmd: string): boolean => rules.fgPoll.some(({ rx }) => rx.test(maskDataStatements(cmd)));

  test.each([
    ["grep 'tail -f' reference/cli.md"],
    ["rg -n \"sleep 60\" src"],
    ["sed -i 's/tail -f/tail -n 5/' notas.md"],
    ["echo 'rode hades wait depois'"],
    ["git log | grep 'tail -f'"],
  ])("%s passa", (cmd) => expect(pollsOn(cmd)).toBe(false));

  test.each([
    ["tail -f /tmp/x.log"],
    ["sleep 90"],
    ["grep x y && tail -f z.log"],
    ["echo $(sleep 120)"],
    ["FOO=1 tail -f z.log"],
  ])("%s segue barrado", (cmd) => expect(pollsOn(cmd)).toBe(true));
});

describe("5c: reler o log de um processo que terminou não é polling", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-settle-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "build.log");
  const hook = (session: string, env: Record<string, string> = {}) =>
    r.X([BUN, HOOK], {
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, cwd: dir, tool_name: "Bash", tool_input: { command: `cat ${log}` } }),
      cwd: dir, env: { HADES_POLL_GUARD: "1", ...env },
    });

  test("segunda leitura logo depois, com o log ainda escrevendo, é barrada", () => {
    writeFileSync(log, "linha\n");
    expect(hook("s-ativo").rc).toBe(0);
    writeFileSync(log, "linha\noutra\n");
    expect(hook("s-ativo").rc).not.toBe(0);
  });

  test("log que recebeu escrita depois da leitura e já está quieto é relido", () => {
    writeFileSync(log, "linha\n");
    expect(hook("s-fim").rc).toBe(0);
    // o mtime do sistema de arquivos é grosso: fixa a escrita num instante depois da leitura e antes da releitura
    Bun.sleepSync(50);
    writeFileSync(log, "linha\nfim\n");
    const written = Date.now() / 1000;
    utimesSync(log, written, written);
    Bun.sleepSync(20);
    const data = join(dir, "inst");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.tsv"), "");
    writeFileSync(join(data, "config.env"), "HADES_POLL_LOG_SETTLE_S=0\n");
    mkdirSync(join(r.H, ".claude", "hades"), { recursive: true });
    writeFileSync(join(r.H, ".claude", "hades", "instance"), `${data}\n`);
    try {
      expect(hook("s-fim").rc).toBe(0);
    } finally {
      rmSync(join(r.H, ".claude", "hades", "instance"), { force: true });
    }
  });
});

describe("5d: skill-clean conhece o wt da prova de install sem remote", () => {
  test("wt está entre os artefatos descartáveis das provas", () => expect(DISPOSABLE_DATA).toContain("wt"));
  test("o contrato da lista continua o do orchestrate.md", () => {
    const text = readFileSync(join(SKILL, "reference/loop/orchestrate.md"), "utf8");
    for (const name of DISPOSABLE_DATA) expect(text).toContain(name);
  });
});

describe("5g: config import de arquivo inexistente e estado fora da skill", () => {
  test("config import <inexistente> dá mensagem acionável, sem stack", () => {
    const x = r.hades(["config", "import", `${r.T}/nao-existe.env`], { env: { HADES_DATA: `${r.T}/cfg-data` } });
    expect(x.rc).toBe(1);
    expect(x.out + x.err).toContain(`arquivo não encontrado: ${r.T}/nao-existe.env`);
    expect(x.out + x.err).not.toContain("ENOENT");
    expect(x.out + x.err).not.toContain("    at ");
  });

  test("sem instalação, prs não grava prs.list na skill: recusa e diz o que fazer", () => {
    const x = r.X([BUN, `${SKILL}/src/cli.ts`, "prs", "list"], { merge: true, cwd: r.T, env: { HADES_KIT_DIR: `${SKILL}/kit`, HADES_DATA: "", HOME: `${r.T}/home-vazio` } });
    expect(x.all).toContain("sem instalação do Hades");
    expect(existsSync(`${SKILL}/kit/prs.list`)).toBe(false);
  });
});

describe("(i.1) config set nunca grava dentro da skill", () => {
  const cfg = (args: string[], env: Record<string, string>) =>
    r.X([BUN, `${SKILL}/src/cli.ts`, "config", ...args], { merge: true, cwd: r.T, env: { HADES_KIT_DIR: `${SKILL}/kit`, HADES_DATA: "", HOME: `${r.T}/home-vazio`, ...env } });

  test("sem instalação (sem HADES_DATA nem instância): recusa e não cria kit/config.env na skill", () => {
    const antes = existsSync(`${SKILL}/kit/config.env`);
    const x = cfg(["set", "HADES_GATE_OVERRUN_MIN=91"], {});
    expect(x.rc).not.toBe(0);
    expect(x.all).toContain("sem instalação do Hades");
    expect(x.all).not.toContain("gravado");
    expect(existsSync(`${SKILL}/kit/config.env`)).toBe(antes);
  });

  test("com HADES_DATA grava no $D; sem instalação, show e get seguem com os padrões", () => {
    const D = `${r.T}/data-cfg`;
    mkdirSync(D, { recursive: true });
    expect(cfg(["set", "HADES_GATE_OVERRUN_MIN=91"], { HADES_DATA: D }).rc).toBe(0);
    expect(readFileSync(`${D}/config.env`, "utf8")).toContain("HADES_GATE_OVERRUN_MIN=91");
    expect(cfg(["get", "HADES_GATE_OVERRUN_MIN"], {}).out.trim()).toBe("90");
  });
});
