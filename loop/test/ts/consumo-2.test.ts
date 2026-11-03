// Grupo consumo-2: polling do hades-usage, aviso de leitura grande do guard, plan-trim e hash do plano sem o "Estado atual".
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL, cutBytes, readJson } from "./lib/rig";
import { guardRules, isPolling } from "../../../src/lib/guard-rules";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const G = `${SKILL}/src/hook.ts`, d = `${r.T}/c2`;
const rd = (p: string) => readFileSync(p, "utf8");

mkdirSync(`${d}/tool-results`, { recursive: true });
const grande = (("a".repeat(79) + "\n").repeat(380)).slice(0, 30000);
writeFileSync(`${d}/grande.txt`, grande); writeFileSync(`${d}/pequeno.txt`, "pequeno\n"); writeFileSync(`${d}/tool-results/saida.txt`, grande);

describe("consumo-2", () => {
  describe("polling do uso: só espera em primeiro plano (mesma definição do guard)", () => {
    const table = `1\tsleep 30
1\tsleep 2m
1\tuntil gh pr checks 5 | grep -q pass; do sleep 5; done
1\ttail -f build.log
1\tgh pr checks 12
1\tgh run watch 99
1\tgh run view 99
1\therdr agent read impl-a --lines 50
1\therdr pane list
1\t~/.claude/skills/hades/loop/bin/gate-lock.sh status
0\tnpm test 2>&1 | tail -40
0\tcat log | tail -n 100
0\tsleep 1
0\tsleep 4 && curl -s localhost:3000
0\tgit log --oneline | head -5
0\tcat > f <<'EOF'\\nsleep 30\\nEOF`;
    for (const line of table.split("\n")) {
      const [esperado, raw] = line.split("\t") as [string, string];
      const cmd = raw.replaceAll("\\n", "\n");
      test(`usage: polling=${esperado} para: ${cmd.slice(0, 50)}`, () => {
        expect(String(Number(isPolling(guardRules(), cmd)))).toBe(esperado);
      });
    }
  });

  describe("aviso de leitura grande: avisa sem barrar; sem falso positivo", () => {
    let n = 0;
    /** "rc=<n> <aviso|->": o limite vem do config.env do ambiente instalado, se houver. */
    const rd2 = (tool: string, input: Record<string, unknown>) => {
      const ev = JSON.stringify({ hook_event_name: "PreToolUse", session_id: `c2-${process.pid}-${n++}`, cwd: d, tool_name: tool, tool_input: input });
      const o = r.X([BUN, G], { stdin: ev, merge: true });
      let ctx = "";
      try { ctx = (JSON.parse(o.out)?.hookSpecificOutput?.additionalContext as string | undefined) ?? ""; } catch { ctx = ""; }
      return `rc=${o.rc} ${ctx}`;
    };
    const W = "rc=0 HADES: leitura inteira de arquivo grande";
    const head = (s: string) => cutBytes(s, W.length);
    const NO = "rc=0 ";
    const cases: [string, () => string, string][] = [
      ["Read sem limit avisa", () => head(rd2("Read", { file_path: `${d}/grande.txt` })), W],
      ["Read com limit não avisa", () => rd2("Read", { file_path: `${d}/grande.txt`, limit: 100 }), NO],
      ["Read com offset não avisa", () => rd2("Read", { file_path: `${d}/grande.txt`, offset: 10 }), NO],
      ["Read de arquivo pequeno não avisa", () => rd2("Read", { file_path: `${d}/pequeno.txt` }), NO],
      ["Read de saída persistida avisa", () => head(rd2("Read", { file_path: `${d}/tool-results/saida.txt` })), W],
      ["cat de arquivo grande avisa", () => head(rd2("Bash", { command: "cat grande.txt" })), W],
      ["cat de arquivo pequeno não avisa", () => rd2("Bash", { command: "cat pequeno.txt" }), NO],
      ["cat com heredoc não avisa", () => rd2("Bash", { command: "cat > grande.txt <<EOF\ntexto\nEOF" }), NO],
      ["cat de arquivo grande com pipe não avisa", () => rd2("Bash", { command: "cat grande.txt | head -5" }), NO],
      ["sed -n de faixa grande avisa", () => head(rd2("Bash", { command: "sed -n '1,900p' grande.txt" })), W],
      ["sed -n de trecho não avisa", () => rd2("Bash", { command: "sed -n '10,60p' grande.txt" }), NO],
      ["head -n grande avisa", () => head(rd2("Bash", { command: "head -n 1000 grande.txt" })), W],
      ["tail -500 avisa", () => head(rd2("Bash", { command: "tail -500 grande.txt" })), W],
      ["head -n pequeno não avisa", () => rd2("Bash", { command: "head -n 20 grande.txt" }), NO],
      ["tail sobre pipe não avisa", () => rd2("Bash", { command: "git log | tail -n 1000" }), NO],
      ["arquivo inexistente não avisa", () => rd2("Bash", { command: "cat nao-existe.txt" }), NO],
    ];
    for (const [nome, got, esperado] of cases) test(`guard: ${nome}`, () => { expect(got()).toBe(esperado); });

    test("guard: HADES_READ_WARN_KB=0 desliga", () => {
      mkdirSync(`${d}/inst`, { recursive: true }); writeFileSync(`${r.H}/.claude/hades/instance`, `${d}/inst\n`);
      try { writeFileSync(`${d}/inst/config.env`, "HADES_READ_WARN_KB=0\n"); expect(rd2("Bash", { command: "cat grande.txt" })).toBe(NO); }
      finally { rmSync(`${r.H}/.claude/hades/instance`, { force: true }); }
    });
    test("guard: limite maior que o arquivo não avisa", () => {
      writeFileSync(`${r.H}/.claude/hades/instance`, `${d}/inst\n`);
      try { writeFileSync(`${d}/inst/config.env`, "HADES_READ_WARN_KB=100\n"); expect(rd2("Bash", { command: "cat grande.txt" })).toBe(NO); }
      finally { rmSync(`${r.H}/.claude/hades/instance`, { force: true }); }
    });
    test("guard: o aviso sugere grep -n e sed -n", () => { expect(rd2("Read", { file_path: `${d}/grande.txt` }).includes("grep -n")).toBe(true); });
    test("guard: sleep de espera segue barrado", () => {
      const ev = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "c2b", cwd: d, tool_name: "Bash", tool_input: { command: "sleep 30" } });
      expect(r.X([BUN, G], { stdin: ev }).rc).toBe(2);
    });
  });

  describe("plan-trim e o hash do plano sem o \"Estado atual\"", () => {
    const pl = `${d}/plan.md`, planJson = `${r.T}/work/example__monorepo/orchestration/plan.json`;
    const approve = () => { r.agent(["plan-approve", pl]); return readJson(planJson).sha as string; };
    let sha1 = "";
    writeFileSync(pl, "# Plano\n\n## Estado atual\n- a: pronta\n\n## Objetivo\nentregar\n\n## Unidades\n| a |\n\n## Rodada 1 (10/26)\nhistória\n\n## Decisão X\nfoi assim\n");
    test("reescrever o Estado atual não muda o hash aprovado", () => {
      sha1 = approve();
      writeFileSync(pl, rd(pl).replace("- a: pronta", "- a: em review, aguardando o dono"));
      expect(approve()).toBe(sha1);
    });
    test("mudar o Objetivo muda o hash", () => {
      writeFileSync(pl, rd(pl).replace(/^entregar$/m, "entregar outra coisa"));
      expect(sha1 !== approve() ? "sim" : "não").toBe("sim");
    });
    test("plan-trim: histórico sai do plano", () => {
      r.agent(["plan-trim", pl]);
      expect(rd(pl).split("\n").filter((l) => l.startsWith("#")).join("|")).toBe("# Plano|## Estado atual|## Objetivo|## Unidades");
    });
    test("plan-trim: histórico vai para o .log.md", () => {
      expect(rd(`${d}/plan.log.md`).split("\n").filter((l) => l.startsWith("## ")).join("|")).toBe("## Rodada 1 (10/26)|## Decisão X");
    });
    test("plan-trim: repetido não mexe em nada", () => {
      expect(r.agent(["plan-trim", pl]).out.replace(/\n$/, "")).toBe(`plan-trim: nada a mover em ${pl}`);
    });
    test("plan-trim: segundo trim não duplica o log", () => {
      expect(rd(`${d}/plan.log.md`).split("\n").filter((l) => l.startsWith("## ")).length).toBe(2);
    });
  });
});
