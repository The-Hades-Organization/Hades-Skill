// `hades watch`: fechamento ao concluir (reference/loop/orchestrate.md). Cada caso monta uma worktree de unidade da skill
// (modo `skill`: sem PR, valem herdr e a auditoria do `agent done`), um report DONE e o herdr simulado, e roda o vigia.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL } from "./lib/rig";
import { shaCitavel } from "./sha-citavel";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const orch = `${r.T}/work/_skill/orchestration/agents`;
const PROVA = "- Teste: `bun test x.test.ts` passou, 0 fail.\n";
const herdrCom = (name: string, status: string): string => JSON.stringify({ result: { agents: [{ name, agent_status: status }] } });

/** Unidade `name` pronta para concluir: worktree com um commit e report DONE com prova e commit citado. */
function unidade(name: string): { worktree: string; registro: string } {
  const worktree = `${r.T}/wtdismiss/${name}`;
  mkdirSync(`${worktree}/.design-sync-reports`, { recursive: true });
  r.X(["git", "init", "-q", "-b", "main", worktree]);
  writeFileSync(`${worktree}/a.txt`, "a\n");
  r.git(worktree, "add", "-A");
  r.git(worktree, "commit", "-qm", "base");
  const sha = shaCitavel(worktree, (d, ...a) => r.git(d, ...a).out.trim());
  writeFileSync(`${worktree}/.design-sync-reports/report.md`, `STATUS: DONE\nCommit \`${sha}\` na branch.\n${PROVA}`);
  mkdirSync(orch, { recursive: true });
  const registro = `${orch}/${name}.json`;
  writeFileSync(registro, JSON.stringify({ name, mode: "skill", role: "impl", worktree, state: "working", branch: "main", promptedAt: "2026-01-02T00:00:00Z" }));
  return { worktree, registro };
}

/** Saída inteira do vigia (uma passada). */
const watch = (state: string, herdr: string, env: Record<string, string> = {}): string =>
  r.X(["timeout", "5", BUN, `${SKILL}/src/cli.ts`, "watch", "1"], {
    cwd: r.C, merge: true, env: { HADES_WATCH_STATE: state, FAKE_HERDR_AGENTS: herdr, ...env },
  }).out;
const eventos = (saida: string, name: string): string[] => saida.split("\n").filter((l) => /^(DONE|DISMISS-HELD|DISMISS-READY|DISMISSED) /.test(l) && l.split(" ")[1] === name);
const lerRegistro = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8"));

describe("hades watch: fecha ao concluir", () => {
  test("dado DONE limpo e herdr idle, então DONE e DISMISSED; o registro vira done com closedOnDone", () => {
    const { registro } = unidade("fc-ok");
    const saida = watch(`${r.T}/st-fc-ok`, herdrCom("fc-ok", "idle"));
    expect(eventos(saida, "fc-ok")).toEqual(["DONE fc-ok", "DISMISSED fc-ok fechado ao concluir"]);
    expect(lerRegistro(registro)).toMatchObject({ state: "done", closedOnDone: true });
  }, 20_000);

  test("dado o fechamento feito, então o closeAgent não vaza a linha de encerramento no stdout do vigia", () => {
    unidade("fc-quieto");
    const saida = watch(`${r.T}/st-fc-quieto`, herdrCom("fc-quieto", "idle"));
    expect(saida).not.toContain("encerrado; a worktree");
    expect(saida).not.toContain("painel");
  }, 20_000);

  test("dado herdr done, então também fecha", () => {
    unidade("fc-done");
    expect(eventos(watch(`${r.T}/st-fc-done`, herdrCom("fc-done", "done")), "fc-done")).toEqual(["DONE fc-done", "DISMISSED fc-done fechado ao concluir"]);
  }, 20_000);

  test("dado o ciclo já fechado, então a passada seguinte não repete nada", () => {
    unidade("fc-uma");
    const state = `${r.T}/st-fc-uma`;
    expect(eventos(watch(state, herdrCom("fc-uma", "idle")), "fc-uma")).toHaveLength(2);
    expect(eventos(watch(state, herdrCom("fc-uma", "idle")), "fc-uma")).toEqual([]);
  }, 30_000);
});

describe("hades watch: não fecha", () => {
  test.each([
    ["working", "herdr-working"],
    ["blocked", "herdr-blocked"],
  ])("dado herdr %s, então DISMISS-HELD %s uma vez e o registro segue working", (status, motivo) => {
    const nome = `nf-${status}`;
    const { registro } = unidade(nome);
    const state = `${r.T}/st-${nome}`;
    expect(eventos(watch(state, herdrCom(nome, status)), nome)).toEqual([`DONE ${nome}`, `DISMISS-HELD ${nome} ${motivo}`]);
    expect(eventos(watch(state, herdrCom(nome, status)), nome)).toEqual([]);
    expect(lerRegistro(registro)).toMatchObject({ state: "working" });
  }, 30_000);

  test("dado agente fora da lista do herdr, então DISMISS-HELD herdr-fora", () => {
    const { registro } = unidade("nf-fora");
    expect(eventos(watch(`${r.T}/st-nf-fora`, '{"result":{"agents":[]}}'), "nf-fora")).toEqual(["DONE nf-fora", "DISMISS-HELD nf-fora herdr-fora"]);
    expect(lerRegistro(registro)).toMatchObject({ state: "working" });
  }, 20_000);

  test("dado a sessão que fica idle depois, então a passada seguinte fecha (a condição é reavaliada)", () => {
    const { registro } = unidade("nf-depois");
    const state = `${r.T}/st-nf-depois`;
    expect(eventos(watch(state, herdrCom("nf-depois", "working")), "nf-depois")).toEqual(["DONE nf-depois", "DISMISS-HELD nf-depois herdr-working"]);
    expect(eventos(watch(state, herdrCom("nf-depois", "idle")), "nf-depois")).toEqual(["DISMISSED nf-depois fechado ao concluir"]);
    expect(lerRegistro(registro)).toMatchObject({ state: "done", closedOnDone: true });
  }, 30_000);

  test("dado worktree com mudança sem commit, então DISMISS-HELD auditoria uma vez e nada fecha", () => {
    const { worktree, registro } = unidade("nf-suja");
    writeFileSync(`${worktree}/a.txt`, "mudou\n");
    const state = `${r.T}/st-nf-suja`;
    expect(eventos(watch(state, herdrCom("nf-suja", "idle")), "nf-suja")).toEqual(["DONE nf-suja", "DISMISS-HELD nf-suja auditoria"]);
    expect(eventos(watch(state, herdrCom("nf-suja", "idle")), "nf-suja")).toEqual([]);
    expect(lerRegistro(registro)).toMatchObject({ state: "working" });
  }, 30_000);
});

describe("hades watch: chave desligada", () => {
  test("dado HADES_ORCH_AUTO_DISMISS=0 e tudo ok, então DISMISS-READY uma vez e nada fecha", () => {
    const { registro } = unidade("of-ready");
    const state = `${r.T}/st-of-ready`;
    const env = { HADES_ORCH_AUTO_DISMISS: "0" };
    expect(eventos(watch(state, herdrCom("of-ready", "idle"), env), "of-ready")).toEqual(["DONE of-ready", "DISMISS-READY of-ready"]);
    expect(eventos(watch(state, herdrCom("of-ready", "idle"), env), "of-ready")).toEqual([]);
    expect(lerRegistro(registro)).toMatchObject({ state: "working" });
    expect(lerRegistro(registro)).not.toHaveProperty("closedOnDone");
  }, 30_000);

  test("dado a chave desligada e herdr working, então DISMISS-HELD (o motivo vence o READY)", () => {
    unidade("of-working");
    const saida = watch(`${r.T}/st-of-working`, herdrCom("of-working", "working"), { HADES_ORCH_AUTO_DISMISS: "0" });
    expect(eventos(saida, "of-working")).toEqual(["DONE of-working", "DISMISS-HELD of-working herdr-working"]);
  }, 20_000);
});
