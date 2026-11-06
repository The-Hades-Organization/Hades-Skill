// Acompanhamento × decisão: a regra pura sobre o turno do transcript e a soma por grupo no relatório de consumo.
import { describe, expect, test } from "bun:test";
import { bashIsFollowUp, classifyTurn, isWakeText, type TurnTool } from "../../../src/lib/turn-class";
import { byRoles, buildReport, plain, type Row } from "../../../src/lib/usage";

const bash = (command: string): TurnTool => ({ name: "Bash", command });
const follow = (tools: TurnTool[], afterWake = false): boolean => classifyTurn({ tools, afterWake }) === "follow";

describe("bashIsFollowUp", () => {
  test.each([
    "hades wait agents --any",
    "~/.claude/skills/hades/loop/bin/hades watch --next",
    "cd ~/proj && hades agent status --compact",
    "rtk hades agent list",
    "herdr pane read 3 --lines 40",
    "H=~/.claude/skills/hades/loop/bin/hades; $H agent status orq",
    "$B/hades-agent.sh list",
    "tail -5 /tmp/claude-1000/-home-x/abc-123/tasks/bmlejcfn5.output",
    "hades wait agents --any 2>&1",
    "hades agent list | head -5",
  ])("dado %s, então é acompanhamento", (command) => expect(bashIsFollowUp(command)).toBe(true));

  test.each([
    "hades agent prompt orq 'faça X'",
    "hades agent spawn x",
    "herdr agent prompt 3 'x'",
    "git commit -m x",
    "hades wait agents --any > /tmp/out.txt",
    "hades agent list && git push",
    "cat src/lib/usage.ts",
    "tail -5 /tmp/log.txt",
    "cat /tmp/claude-1000/p/s/tasks/a.output /etc/passwd",
    "cat <<EOF\nx\nEOF",
    "cd /tmp",
    "",
  ])("dado %p, então é decisão", (command) => expect(bashIsFollowUp(command)).toBe(false));

  test("dado redirecionamento para /dev/null e 2>&1, então segue acompanhamento", () => {
    expect(bashIsFollowUp("hades agent status 2>/dev/null")).toBe(true);
    expect(bashIsFollowUp("hades agent status &>/dev/null")).toBe(true);
  });
});

describe("classifyTurn", () => {
  test("dado turno sem tool logo após um aviso de segundo plano, então acompanhamento", () => {
    expect(follow([], true)).toBe(true);
  });
  test("dado turno sem tool fora de um despertar, então decisão (é resposta ao dono)", () => {
    expect(follow([], false)).toBe(false);
  });
  test("dado Monitor ou ScheduleWakeup, então acompanhamento (arma a próxima espera)", () => {
    expect(follow([{ name: "Monitor" }])).toBe(true);
    expect(follow([{ name: "ScheduleWakeup" }])).toBe(true);
  });
  test("dado wait junto de uma escrita no mesmo turno, então decisão", () => {
    expect(follow([bash("hades wait agents --any"), { name: "Write" }])).toBe(false);
    expect(follow([bash("hades wait agents --any"), bash("hades agent prompt orq x")])).toBe(false);
  });
  test("dado vários status em sequência, então acompanhamento", () => {
    expect(follow([bash("hades agent status a"), bash("herdr pane read 1")])).toBe(true);
  });
  test("dado Edit, Agent, SendMessage ou Read, então decisão", () => {
    for (const name of ["Edit", "Agent", "SendMessage", "Read", "AskUserQuestion"]) expect(follow([{ name }], true)).toBe(false);
  });
  test("dado Bash sem comando, então decisão", () => {
    expect(follow([{ name: "Bash" }])).toBe(false);
  });
});

describe("isWakeText", () => {
  test("dado texto que abre com task-notification, então é despertar; no meio do texto não", () => {
    expect(isWakeText("<task-notification>\n<task-id>x</task-id>")).toBe(true);
    expect(isWakeText("  \n<task-notification>")).toBe(true);
    expect(isWakeText("veja o <task-notification> no meio")).toBe(false);
  });
});

describe("relatório: acompanhamento × decisão do orquestrador", () => {
  const row = (cwd: string, over: Partial<Row>): Row => ({
    session: cwd, sidechain: false, day: "2026-11-01", cwd, cost: 10, turns: 10, poll_turns: 0, poll_cost: 0, rewrite_cost: 0,
    ctx_sum: 1000, ctx_max: 200, models: {}, efforts: {}, read: 0, write: 0, output: 0, first: "", last: "", tok: {}, ...over,
  });
  const gitDir = (dir: string): boolean | undefined => (dir === "/proj" ? true : undefined);
  const report = (rows: Row[]) => buildReport(rows, byRoles(rows, [], gitDir), 7, "2026-11-01", "2026-11-02T00:00:00Z");
  const orchestrator = (r: ReturnType<typeof report>) => (r.byRole as Record<string, unknown>[]).find((x) => x.role === "orchestrator");

  test("dado turnos de acompanhamento, então separa turnos, contexto médio e custo dos dois grupos", () => {
    const split = orchestrator(report([row("/proj", { follow_turns: 4, follow_cost: 1, follow_ctx_sum: 800 })]))?.followup as Record<string, Record<string, unknown>>;
    expect(split.follow).toMatchObject({ turns: 4, ctxAvg: 200 });
    expect(plain(split.follow?.cost)).toBe(1);
    expect(split.decision).toMatchObject({ turns: 6, ctxAvg: 33 });
    expect(plain(split.decision?.cost)).toBe(9);
  });
  test("dado linha sem a medida (anterior à 6.17), então o papel não ganha o bloco", () => {
    expect(orchestrator(report([row("/proj", {})]))?.followup).toBeUndefined();
  });
  test("dado papel que não é orquestrador, então não ganha o bloco", () => {
    const rows = [row("/solto", { follow_turns: 2, follow_cost: 1, follow_ctx_sum: 100 })];
    const r = report(rows);
    expect((r.byRole as Record<string, unknown>[])[0]?.followup).toBeUndefined();
  });
});
