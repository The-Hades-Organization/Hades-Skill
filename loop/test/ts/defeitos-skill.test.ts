// Grupo defeitos-skill (4.10): skill-clean --merged com unidade sem commit, adopt preserva o modo, plan-approve da skill sem origin,
// hash do plano idêntico no agente e no Cerberus, plano da skill na release.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL, readJson, writeJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const S = `${r.T}/skill-df`, sd = `${r.H}/.claude/hades/skill-dev`, o = `${r.T}/work/_skill/orchestration/agents`;
const agent = (args: string[], o2: { cwd?: string; env?: Record<string, string> } = {}) => r.agentIn(S, args, o2);
const state = (n: string) => readJson(`${o}/${n}.json`).state;
/** Veredito da guarda plano-aprovado do Cerberus para um diretório. */
const chk = (dir: string) => {
  const p = r.X([BUN, `${SKILL}/src/cli.ts`, "cerberus-check", "porta/plano-aprovado"], {
    cwd: dir, env: { CERBERUS_DIR: dir, CERBERUS_SKILL: SKILL, CERBERUS_MOMENTO: "release", CERBERUS_CTX: "{}" } });
  try { return (JSON.parse(p.out) as { resultado: string }).resultado; } catch { return ""; }
};

describe("defeitos-skill", () => {
  r.skillCopy(S);

  test("skill-clean --merged: branch recém-criada (sem commit próprio) está contida na main mas não foi entregue", () => {
    agent(["skill-new", "df1", "--port", "21291"]); agent(["skill-new", "df2", "--port", "21292"]); agent(["skill-new", "df3", "--port", "21293"]);
    const j2 = readJson(`${o}/df2.json`); j2.state = "done"; writeJson(`${o}/df2.json`, j2);
    const W = `${sd}/df3`;
    writeFileSync(`${W}/entrega.txt`, "feito\n"); r.git(W, "add", "entrega.txt"); r.git(W, "commit", "-qm", "feat: entrega");
    if (r.git(S, "merge", "-q", "df3").rc !== 0) r.git(S, "merge", "-q", "skill/df3");
    const out = agent(["skill-clean", "--merged"]).out;
    expect(existsSync(`${sd}/df1`) && state("df1") === "allocated" && out.includes("pulada"), "clean --merged: unidade ativa sem commit fica").toBe(true);
    expect(!existsSync(`${sd}/df2`) && state("df2") === "archived", "clean --merged: unidade done sem commit é arquivada").toBe(true);
    expect(!existsSync(`${sd}/df3`), "clean --merged: unidade com commit já na main é arquivada").toBe(true);
    agent(["skill-clean", "df1"]);
    expect(!existsSync(`${sd}/df1`), "clean <nome>: pedido explícito arquiva a unidade sem commit").toBe(true);
  });

  test("adopt --for não regrava o modo de uma unidade da skill", () => {
    agent(["skill-new", "df4", "--port", "21294"]);
    const ag = JSON.stringify({ result: { agents: [{ name: "df4", cwd: `${sd}/df4`, pane_id: "p9", agent_status: "idle" }] } });
    agent(["adopt", "df4", "--for", "deliver"], { env: { FAKE_HERDR_AGENTS: ag } });
    expect(readJson(`${o}/df4.json`).mode, "adopt --for: o modo da unidade da skill continua skill").toBe("skill");
    expect(readJson(`${o}/df4.json`).pane, "adopt --for: o painel é religado").toBe("p9");
    for (const n of ["df1", "df2", "df3", "df4"]) rmSync(`${o}/${n}.json`, { force: true });
  });

  const pl = `${r.T}/plano-skill.md`, sk = `${r.T}/work/_skill/orchestration/plan.json`;
  test("plan-approve no repo da skill (sem origin): registro na raiz da skill, e a Porta o acha de lá", () => {
    writeFileSync(pl, "# Plano\n\n## Estado atual\n- a\n\n## Objetivo\nx\n");
    const p = agent(["plan-approve", pl], { cwd: S });
    expect(p.rc, "plan-approve: repo da skill sem origin aprova").toBe(0);
    const j = readJson(sk);
    expect(`${j.escopo} ${j.by.origem}`, "plan-approve: o registro fica em _skill e diz a origem").toBe("skill terminal");
    expect(chk(S), "plano-aprovado: o repo da skill sem origin acha o plano da skill").toBe("ok");
    rmSync(sk, { force: true });
  });

  describe("o hash do plano é o mesmo no agente e no Cerberus, e reescrever o Estado atual não invalida", () => {
    const planos: Record<string, string> = {
      lf: "# Plano\n\n## Estado atual\n- a: pronta\n\n## Objetivo\nentregar\n",
      crlf: "# Plano\n\n## Estado atual\n- a: pronta\n\n## Objetivo\nentregar\n",
      "sem-newline-final": "# Plano\n\n## Estado atual\n- a: pronta\n\n## Objetivo\nentregar",
      "titulo-com-sufixo": "# Plano\n\n## Estado atual (26/10)\n- a: pronta\n\n## Objetivo\nentregar\n",
      "bloco-de-codigo": "# Plano\n\n## Estado atual\n```\n## exemplo\n```\n- a: pronta\n\n## Objetivo\nentregar\n",
    };
    const sedFirst = (txt: string, from: string, to: string) => txt.split("\n").map((l) => l.replace(from, to)).join("\n");
    for (const [nome, txt0] of Object.entries(planos)) {
      test(nome, () => {
        let txt = nome === "crlf" ? txt0.split("\n").map((l) => l + "\r").join("\n") : txt0;
        if (nome === "crlf") txt = txt.replace(/\r$/, ""); // sed 's/$/\r/' não acrescenta \r depois do último \n
        writeFileSync(pl, txt);
        agent(["plan-approve", pl]);
        expect(chk(r.C), `plano ${nome}: o Cerberus confere o hash do plan-approve`).toBe("ok");
        txt = sedFirst(txt, "a: pronta", "a: em review"); writeFileSync(pl, txt);
        expect(chk(r.C), `plano ${nome}: reescrever o Estado atual não invalida`).toBe("ok");
        txt = sedFirst(txt, "entregar", "entregar outra coisa"); writeFileSync(pl, txt);
        expect(chk(r.C), `plano ${nome}: mudar o Objetivo invalida`).toBe("barra");
      });
    }
  });

  test("release sem --plano: o plano da skill, nunca o plan.json mais novo de outro projeto", () => {
    rmSync(`${r.T}/work/example__monorepo/orchestration/plan.json`, { force: true });
    const R = `${r.T}/skill-rel2`, rd = `${r.T}/rel2-data`, wk = `${r.T}/work`;
    for (const d of [R, rd, `${wk}/outro__proj/orchestration`, `${wk}/_skill/orchestration`]) mkdirSync(d, { recursive: true });
    cpSync(`${SKILL}/kit`, `${R}/kit`, { recursive: true }); cpSync(`${SKILL}/loop`, `${R}/loop`, { recursive: true });
    writeFileSync(`${R}/VERSION`, "9.9.9\n"); writeFileSync(`${R}/CHANGELOG.md`, "# Changelog\n\n## 9.9.8 — 2026-01-01\n\n- antes\n"); writeFileSync(`${rd}/env.sh`, `W="${r.C}"\n`);
    writeFileSync(`${wk}/_skill/orchestration/plan.json`, "{}\n"); utimesSync(`${wk}/_skill/orchestration/plan.json`, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    writeFileSync(`${wk}/outro__proj/orchestration/plan.json`, "{}\n");
    const plano = () => r.X(["bash", `${R}/kit/skill-release.sh`, "release", "same", "x"], { merge: true, env: { HADES_DATA: rd, HADES_WT: r.C } })
      .out.split("\n").filter((l) => l.startsWith("plano para o Cerberus")).join("\n");
    let v = plano();
    expect(v.includes("_skill/orchestration/plan.json") && !v.includes("outro__proj"), `release: escolhe o plano da skill, não o mais novo de outro projeto (${v})`).toBe(true);
    rmSync(`${wk}/_skill/orchestration/plan.json`);
    v = plano();
    expect(v.includes("nenhum") && !v.includes("outro__proj"), `release: sem plano da skill, não pega o de outro projeto (${v})`).toBe(true);
  });
});
void readFileSync;
