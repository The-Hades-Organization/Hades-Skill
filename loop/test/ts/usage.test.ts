// `hades usage` e as expressões compartilhadas com o hook: comportamento contra o comando novo (a paridade com o original
// está em parity-usage.test.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Rig, SKILL } from "./lib/rig";
import { guardRules, isPolling, stripAgentText, stripHeredocBodies } from "../../../src/lib/guard-rules";
import { PyFloat, pyDumps, pyRound } from "../../../src/lib/pyjson";
import { fixed, parseKeepingFloats } from "../../../src/lib/usage";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const rules = guardRules();

describe("expressões de polling (guard-rules.json)", () => {
  test("dado um heredoc com sleep longo, então não é polling; fora dele, é", () => {
    expect(isPolling(rules, "cat > f <<'EOF'\nsleep 60\nEOF")).toBe(false);
    expect(isPolling(rules, "sleep 60")).toBe(true);
  });
  test("dado texto entre aspas de hades-agent.sh answer, então vira dado; com $( ) fica", () => {
    expect(stripAgentText(rules, 'hades-agent.sh answer w "sleep 90" && ls')).toBe('hades-agent.sh answer w "" && ls');
    expect(stripAgentText(rules, 'hades-agent.sh answer w "$(sleep 90)"')).toBe('hades-agent.sh answer w "$(sleep 90)"');
  });
  test("dado heredoc, então só a linha de abertura fica", () => {
    expect(stripHeredocBodies(rules, "cat <<'EOF' > f\ncorpo\nEOF")).toBe("cat <<'EOF' > f\n");
  });
  test("checagens que o hook só barra na repetição contam como polling no consumo", () => {
    for (const cmd of ["gh pr checks 12", "gh run view 9", "herdr pane list", "~/x/gate-lock.sh status"]) expect(isPolling(rules, cmd)).toBe(true);
    for (const cmd of ["sleep 4 && curl x", "git log | head -5", "npm test 2>&1 | tail -40"]) expect(isPolling(rules, cmd)).toBe(false);
  });
});

describe("números como o Python os escreve", () => {
  test("round(): metade vai para o par e a vizinhança de metade segue o valor exato", () => {
    expect(pyRound(0.125, 2).value).toBe(0.12);
    expect(pyRound(0.375, 2).value).toBe(0.38);
    expect(pyRound(2.675, 2).value).toBe(2.67);
    expect(pyRound(2.68499999999, 2).value).toBe(2.68);
    expect(pyRound(-0.125, 2).value).toBe(-0.12);
  });
  test("format('.0f') e dumps: float inteiro leva .0 e int não", () => {
    expect(fixed(12.5, 0)).toBe("12");
    expect(fixed(13.5, 0)).toBe("14");
    expect(pyDumps({ a: new PyFloat(3), b: 3, c: new PyFloat(0.5) })).toBe('{"a": 3.0, "b": 3, "c": 0.5}');
  });
  test("JSON lido lembra quem era float", () => {
    const parsed = parseKeepingFloats('{"x": 1.0, "y": 1, "z": [2e3, "a\\"b"], "n": null, "t": true}') as Record<string, unknown>;
    expect(parsed.x).toBeInstanceOf(PyFloat);
    expect(parsed.y).toBe(1);
    expect((parsed.z as unknown[])[0]).toBeInstanceOf(PyFloat);
    expect((parsed.z as unknown[])[1]).toBe('a"b');
    expect(() => parseKeepingFloats("{")).toThrow(SyntaxError);
  });
});

describe("hades usage", () => {
  const home = `${r.T}/usage-home`;
  const run = (...args: string[]) => r.hades(["usage", ...args], { env: { HOME: home } });
  const day = new Date().toISOString().slice(0, 10);
  mkdirSync(`${home}/.claude/projects/p`, { recursive: true });
  writeFileSync(`${home}/.claude/projects/p/s.jsonl`, [
    // sem sessionId: o original quebrava ao gravar o cache; aqui a sessão cai no caminho do arquivo
    { type: "assistant", requestId: "r1", timestamp: `${day}T01:00:00Z`, cwd: r.T, message: { model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");

  test("dada uma sessão sem sessionId, então o consumo roda e conta o turno", () => {
    const o = run("--json");
    expect(o.rc).toBe(0);
    expect((JSON.parse(o.out) as { total: { turns: number } }).total.turns).toBe(1);
  });
  test("dado --days inválido, então sai 2 com a mensagem do argparse", () => {
    const o = run("--days", "x");
    expect(o.rc).toBe(2);
    expect(o.err).toContain("argument --days: invalid int value: 'x'");
  });
  test("dado -h, então imprime o uso e sai 0", () => {
    const o = run("-h");
    expect(o.rc).toBe(0);
    expect(o.out).toContain("usage: hades usage");
  });
  test("o cache regravado vale para a próxima rodada", () => {
    run();
    const again = run("--json");
    expect((JSON.parse(again.out) as { total: { turns: number } }).total.turns).toBe(1);
    expect(JSON.parse(readFileSync(`${home}/.claude/hades/usage/cache.json`, "utf8")).v).toBe(3);
  });
});
