// Grupo qualidade-pacotes: validade do catálogo, ligar/desligar pacote, parcial, precedência regra x pacote, pacote do usuário e guarda de nome.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Rig, SKILL, readJson, writeJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const U = `${r.H}/.claude/hades/quality`;
const q = (args: string[]) => r.hades(["quality", ...args]);
type Pack = { id: string; state: string; on: number; total: number; source?: string; rules?: unknown[] };
const packs = () => JSON.parse(q(["packs", "--json"]).out) as Pack[];
const pstate = (p: string) => { const x = packs().find((k) => k.id === p)!; return `${x.state} ${x.on}/${x.total}`; };
const rstate = (i: string) => (JSON.parse(q(["list", "--json"]).out) as { id: string; state: string }[]).find((k) => k.id === i)?.state ?? "";
const nlines = (s: string) => s.split("\n").filter(Boolean).length;
const base = readJson(`${SKILL}/quality/base.json`), packsJson = readJson(`${SKILL}/quality/packs.json`);
const rulesOf = (id: string): string[] => packsJson.packs.find((p: { id: string }) => p.id === id).rules;

describe("qualidade-pacotes", () => {
  test("catálogo válido (ids únicos, todo id de pacote existe)", () => expect(q(["validate"]).rc).toBe(0));
  test("esquema aceita base e pacotes", () => {
    const files = readdirSync(`${SKILL}/quality`).filter((f) => f.endsWith(".json")).sort().map((f) => `${SKILL}/quality/${f}`);
    expect(r.hades(["project", "validate", ...files]).rc).toBe(0);
  });
  test("ids únicos no base", () => {
    const ids: string[] = base.rules.map((x: { id: string }) => x.id);
    expect(ids.filter((v, i) => ids.indexOf(v) !== i).join("\n")).toBe("");
  });
  test("pacote rust: todas as regras rs. e só elas", () => {
    const rs = base.rules.map((x: { id: string }) => x.id).filter((i: string) => i.startsWith("rs.")).sort();
    expect(rs).toEqual([...rulesOf("rust")].sort());
  });
  test("regra rs. nasce desligada, com a tag rust", () => {
    expect(base.rules.filter((x: { id: string; default?: string; tags: string[] }) => x.id.startsWith("rs.") && (x.default !== "off" || !x.tags.includes("rust"))).length).toBe(0);
  });

  test("catálogo do usuário com defeito e pacotes ligados/desligados", () => {
    mkdirSync(U, { recursive: true });
    writeFileSync(`${U}/ruim.json`, '{"schema":"hades.quality/1","packs":[{"id":"ruim","title":"Ruim","rules":["nao.existe","teste.deterministico","teste.deterministico"]}]}\n');
    const v = q(["validate"]);
    expect(`${v.rc} ${v.out.split("\n").filter((l) => /nao\.existe|repete teste\.deterministico/.test(l)).length}`, "validate reprova pacote com id desconhecido e repetido").toBe("1 2");
    const ruim = packs().find((k) => k.id === "ruim")!;
    expect(`${ruim.source} ${ruim.total}`, "pacote do usuário aparece, só com as regras que existem").toBe("usuario 1");
    rmSync(`${U}/ruim.json`);
    expect(q(["on", "--pack", "nao-existe"]).rc, "pacote desconhecido é recusado").toBe(2);

    q(["off", "--all"]);
    const total = rulesOf("testes").length;
    expect(pstate("testes"), "tudo desligado: pacote desligado").toBe(`off 0/${total}`);
    q(["on", "--pack", "testes"]);
    expect(pstate("testes"), "on --pack liga todas as regras do pacote").toBe(`on ${total}/${total}`);
    expect(`${nlines(q(["list", "--pack", "testes"]).out)} ${nlines(q(["list", "--pack", "testes", "--on"]).out)}`, "list --pack lista só as do pacote").toBe(`${total} ${total}`);
    expect(rstate("pratica.nome-revela-intencao"), "regra fora do pacote segue desligada").toBe("off");
    q(["off", "teste.deterministico"]);
    expect(pstate("testes"), "regra desligada depois do pacote: pacote parcial").toBe(`partial ${total - 1}/${total}`);
    expect(rstate("teste.deterministico"), "regra desligada depois do pacote: vale a regra").toBe("off");
    q(["on", "--pack", "testes"]);
    expect(rstate("teste.deterministico"), "pacote ligado depois da regra: vale o pacote").toBe("on");
    q(["on", "--pack", "servicos"]); q(["off", "--pack", "banco"]);
    expect(`${rstate("pratica.operacao-composta-atomica")} ${packs().find((k) => k.id === "servicos")!.state}`, "regra em dois pacotes: desligar um desliga a regra; o outro fica parcial").toBe("off partial");
    q(["on", "--pack", "banco"]); q(["off", "--pack", "banco"]);
    expect(pstate("banco"), "liga e desliga de volta: desligado").toBe(`off 0/${rulesOf("banco").length}`);
    const st = (JSON.parse(q(["state", "--dir", r.C]).out) as { packs: { id: string; state: string; rules: unknown[] }[] }).packs.find((k) => k.id === "testes")!;
    expect(`${st.state} ${st.rules.length}`, "state (painel) traz os pacotes").toBe(`on ${total}`);
    expect(q(["inject", "--phase", "brief", "--dir", r.C]).out.split("\n").filter((l) => l.startsWith("- `teste.")).length, "inject sem mudança de formato: só linhas de regra").toBe(total);
    q(["off", "--all"]);
  });

  test("o catálogo não cita projeto: termos dos perfis da fixture e dos instalados na máquina (só leitura)", () => {
    const col = (cmd: string, own: boolean) => {
      const a = r.hades(["project", cmd]).out;
      // o run.sh lia também os perfis instalados na máquina, fora do ambiente fechado (só leitura)
      const b = own ? Bun.spawnSync([process.execPath, `${SKILL}/src/cli.ts`, "project", cmd], { stdout: "pipe", stderr: "ignore" }).stdout.toString() : "";
      return a + b;
    };
    const terms = [...new Set(col("names", true).split("\n").flatMap((l) => (l.includes("\t") ? l.split("\t").slice(1) : [])).filter(Boolean))].sort();
    const pats = [...new Set(col("patterns", true).split("\n").filter(Boolean))].sort();
    const files = readdirSync(`${SKILL}/quality`).filter((f) => f.endsWith(".json")).map((f) => `${SKILL}/quality/${f}`);
    const count = (fs: string[]) => {
      let n = 0;
      const lo = terms.map((t) => t.toLowerCase()), res = pats.map((p) => new RegExp(p, "i"));
      for (const f of fs) for (const l of readFileSync(f, "utf8").split("\n")) {
        if (lo.some((t) => l.toLowerCase().includes(t))) n++;
        if (res.some((x) => x.test(l))) n++;
      }
      return n;
    };
    expect(count(files), "catálogo sem termo da guarda de nome").toBe(0);
    mkdirSync(`${r.T}/qp-cat`, { recursive: true });
    const b2 = readJson(`${SKILL}/quality/base.json`); b2.rules[0].text += ` ${terms[0]}`;
    writeJson(`${r.T}/qp-cat/base.json`, b2);
    const lo = terms.map((t) => t.toLowerCase());
    const planted = readFileSync(`${r.T}/qp-cat/base.json`, "utf8").split("\n").filter((l) => lo.some((t) => l.toLowerCase().includes(t))).length;
    expect(planted, "a mesma checagem acusa um termo plantado").toBe(1);
  });
});
