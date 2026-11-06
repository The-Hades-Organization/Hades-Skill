// settings-padrao: o padrão herdado do ~/.claude/settings.json (analisador puro, leitura do arquivo, doctor e a rota da página).
// Nunca grava no settings.json: o caminho vem de HADES_CLAUDE_SETTINGS e a pasta de sessões de HADES_CLAUDE_PROJECTS.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costOf, inheritedView, judgeSettings, readSettings, recentModelIds, type Finding } from "../../../src/lib/settings-default";
import { startPanel, type Panel } from "../../../src/panel/server";

const SKILL = join(import.meta.dir, "../../..");
const T = realpathSync(mkdtempSync(join(tmpdir(), "hades-settings-padrao-")));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const ROLES = [{ role: "IMPL", model: "claude-sonnet-5-5", effort: "medium" }, { role: "SPEC", model: "claude-opus-5-5", effort: "medium" }];
const RECENT = new Set(["claude-opus-5-5"]);
const ids = (json: Record<string, unknown>, recent: ReadonlySet<string> = RECENT, roles = ROLES): Finding["id"][] => judgeSettings({ json, roles, recentModels: recent }).map((f) => f.id);

describe("judgeSettings", () => {
  test("dado effortLevel xhigh, então avisa esforço com o trecho e a sugestão", () => {
    const [f] = judgeSettings({ json: { effortLevel: "xhigh" }, roles: ROLES, recentModels: RECENT });
    expect(f?.id).toBe("esforco");
    expect(f?.msg).toContain('"effortLevel": "xhigh"');
    expect(f?.fix).toContain("Modelos por papel");
  });
  test("dado effortLevel max, então avisa; com high não", () => {
    expect(ids({ effortLevel: "max" })).toEqual(["esforco"]);
    expect(ids({ effortLevel: "high" })).toEqual([]);
  });
  test("dado modelo com [1m], então avisa a janela e sugere o id sem o sufixo", () => {
    const [f] = judgeSettings({ json: { model: "opus[1m]", effortLevel: "low" }, roles: ROLES, recentModels: RECENT });
    expect(f?.id).toBe("janela-1m");
    expect(f?.msg).toContain("HADES_CTX_CAP_*");
    expect(f?.fix).toContain('"opus"');
  });
  test("dado chave do modelSettings que não casa com a sessão, então avisa a chave e os ids em uso", () => {
    const [f] = judgeSettings({ json: { modelSettings: { "claude-opus-5": {} } }, roles: ROLES, recentModels: RECENT });
    expect(f?.id).toBe("chave-modelsettings");
    expect(f?.msg).toContain("claude-opus-5-5");
  });
  test("dado chave do modelSettings que casa, ou sem sessões recentes, então não avisa", () => {
    expect(ids({ modelSettings: { "claude-opus-5-5": {} } })).toEqual([]);
    expect(ids({ modelSettings: { "claude-opus-5": {} } }, new Set())).toEqual([]);
  });
  test("dado padrão mais caro que todos os papéis, então avisa; igual a um papel não", () => {
    expect(ids({ model: "claude-fable-5-1", effortLevel: "high" })).toEqual(["mais-caro"]);
    expect(ids({ model: "claude-opus-5-5", effortLevel: "medium" })).toEqual([]);
  });
  test("dado papel sem modelo (herda o padrão), então o padrão não é mais caro que ele", () => {
    expect(ids({ model: "claude-opus-5-5", effortLevel: "high" }, RECENT, [{ role: "CHAT", model: "", effort: "" }])).toEqual([]);
  });
  test("dado settings sem nenhum caso, então nada", () => {
    expect(ids({ model: "claude-sonnet-5-5", effortLevel: "low" })).toEqual([]);
    expect(ids({})).toEqual([]);
  });
  test("a ordem de custo põe haiku < sonnet < opus < fable e esforço low < max", () => {
    expect(costOf("haiku", "max")).toBeLessThan(costOf("sonnet", "low"));
    expect(costOf("claude-opus-5-5", "low")).toBeLessThan(costOf("claude-fable-5-1", "low"));
    expect(costOf("claude-opus-5-5", "low")).toBeLessThan(costOf("claude-opus-5-5", "max"));
    expect(costOf("gpt-x", "low")).toBe(-1);
  });
});

describe("readSettings e recentModelIds", () => {
  test("dado arquivo ausente, então devolve o motivo sem lançar", () => {
    const s = readSettings(join(T, "nao-existe.json"));
    expect(s.ok).toBe(false);
    expect(s.ok ? "" : s.reason).toContain("ausente");
  });
  test("dado JSON inválido ou que não é objeto, então devolve o motivo", () => {
    writeFileSync(join(T, "bad.json"), "{x");
    writeFileSync(join(T, "arr.json"), "[]");
    expect(readSettings(join(T, "bad.json")).ok).toBe(false);
    expect(readSettings(join(T, "arr.json")).ok).toBe(false);
  });
  test("dado projetos com sessões, então junta os ids de modelo e ignora o resto", () => {
    mkdirSync(join(T, "proj/a"), { recursive: true });
    writeFileSync(join(T, "proj/a/s.jsonl"), '{"message":{"model":"claude-opus-5-5"}}\n{"model":"<synthetic>"}\n');
    expect([...recentModelIds(join(T, "proj"))]).toEqual(["claude-opus-5-5"]);
    expect(recentModelIds(join(T, "nada")).size).toBe(0);
  });
});

describe("hades doctor, linha settings-padrao", () => {
  mkdirSync(join(T, "proj/b"), { recursive: true });
  const doctor = (json: string | undefined): { level: string; msg: string }[] => {
    const file = join(T, "s.json");
    if (json !== undefined) writeFileSync(file, json);
    const r = Bun.spawnSync([process.execPath, join(SKILL, "src/cli.ts"), "doctor", "--quick", "--json"], {
      env: { ...process.env, HADES_WT: SKILL, HADES_CLAUDE_SETTINGS: json === undefined ? join(T, "ausente.json") : file, HADES_CLAUDE_PROJECTS: join(T, "proj") },
    });
    const items = (JSON.parse(r.stdout.toString()) as { items: { id: string; level: string; msg: string }[] }).items;
    return items.filter((i) => i.id === "settings-padrao");
  };
  test("dado xhigh, [1m], chave que não casa e padrão caro, então quatro avisos", () => {
    const rows = doctor('{"model":"opus[1m]","effortLevel":"xhigh","modelSettings":{"claude-opus-5":{}}}');
    expect(rows.map((r) => r.level)).toEqual(["warn", "warn", "warn", "warn"]);
  });
  test("dado padrão barato e sem armadilha, então uma linha ok", () => {
    const rows = doctor('{"model":"claude-sonnet-5-5","effortLevel":"low"}');
    expect(rows.map((r) => r.level)).toEqual(["ok"]);
  });
  test("dado settings.json ausente, então aviso com o motivo e o doctor não quebra", () => {
    const rows = doctor(undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.msg).toContain("ausente");
  });
  test("o doctor não grava no settings.json", () => {
    const body = '{"effortLevel":"max"}';
    doctor(body);
    expect(readFileSync(join(T, "s.json"), "utf8")).toBe(body);
  });
});

describe("rota /api/config/inherited", () => {
  let panel: Panel;
  let base = "";
  beforeAll(async () => {
    const D = join(T, "data");
    mkdirSync(join(D, "panel"), { recursive: true });
    copyFileSync(join(SKILL, "kit/config.tsv"), join(D, "config.tsv"));
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port as number;
    void probe.stop(true);
    panel = await startPanel(D, port);
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => panel.stop());
  test("dado settings legível, então devolve modelo, esforço e quem herda", async () => {
    writeFileSync(join(T, "rota.json"), '{"model":"opus[1m]","effortLevel":"xhigh"}');
    process.env.HADES_CLAUDE_SETTINGS = join(T, "rota.json");
    const v = (await (await fetch(`${base}/api/config/inherited`)).json()) as { ok: boolean; model: string; effort: string; heirs: string[] };
    expect([v.ok, v.model, v.effort]).toEqual([true, "opus[1m]", "xhigh"]);
    expect(v.heirs.join(" ")).toContain("subagentes");
  });
  test("dado settings ausente, então ok:false com o motivo", async () => {
    process.env.HADES_CLAUDE_SETTINGS = join(T, "sumiu.json");
    const v = (await (await fetch(`${base}/api/config/inherited`)).json()) as { ok: boolean; reason: string };
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("ausente");
    expect(inheritedView(join(T, "sumiu.json")).ok).toBe(false);
  });
});
