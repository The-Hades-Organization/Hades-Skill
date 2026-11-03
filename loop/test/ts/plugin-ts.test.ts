// Grupo plugin-ts: o contrato `panel/api.ts` (host em TypeScript): os dois pacotes portados (proj-a, proj-b) respondem como
// o contrato manda, plugin quebrado não derruba o painel, e o `api.py` (contrato anterior à 5.0.0) é recusado.
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { FX, GOLD, Rig, SKILL, readJson, writeJson } from "./lib/rig";
import { startPanel } from "../../../src/panel/server.ts";
import type { PanelEnv } from "../../../src/panel/env.ts";
import { PluginRefused, startPluginHost, type PluginHost, type PluginState } from "../../../src/panel/plugin-host.ts";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const PK = `${FX}/packs-api`;

/** $D com plugin/panel/<arquivos> e um snapshot.sh de mentira. */
function dataDir(tag: string, pack: string, files: string[]): PanelEnv {
  const dir = `${r.T}/pt-${tag}`;
  mkdirSync(`${dir}/plugin/panel`, { recursive: true }); mkdirSync(`${dir}/panel`, { recursive: true });
  for (const f of files) copyFileSync(`${PK}/${pack}/env/panel/${f}`, `${dir}/plugin/panel/${f}`);
  writeFileSync(`${dir}/snapshot.sh`, '#!/usr/bin/env bash\n[[ $1 == list ]] && echo \'{"snapshots":[{"id":"20260101-000000"}],"bytes":7}\'\n');
  return { dir, worktree: `${dir}-wt`, panelDir: `${dir}/panel`, nodeBin: "node" } as PanelEnv;
}

const state = (extra: Partial<PluginState> = {}): PluginState => ({ config: { K: "v" }, snapshot: {}, containers: [], ...extra });
const units = { "hds-dev-s1": { Result: "failed" }, "hds-dev-s2": { Result: "success" }, "hds-dev-bus": {}, "hds-demo-sim": {} };
const views: Record<string, Record<string, unknown>> = { "hds-dev-s1": { state: "failed", mem: 10 }, "hds-dev-s2": { state: "inactive", mem: 5 }, "hds-dev-bus": { state: "active", mem: 3 } };
const withUnits = state({ units, unitViews: views, unitViewDefault: { state: "inactive", mem: null } });

/** Resultado ou o tipo do erro: o que o painel veria (recusa = 400, outro erro = 500). */
async function outcome(call: () => Promise<unknown>): Promise<unknown> {
  try { return await call(); } catch (e) { return e instanceof PluginRefused ? `recusa:${e.message}` : "erro"; }
}

/** O $D de cada ponta tem nome próprio; o resto da resposta tem de ser igual. */
const norm = (value: unknown[], tag: string): unknown[] => JSON.parse(JSON.stringify(value).replaceAll(r.T, "<T>").replaceAll(`pt-${tag}`, "pt-X")) as unknown[];

async function calls(h: PluginHost): Promise<unknown[]> {
  return [
    [...(h.functions ?? [])].sort(),
    await outcome(() => h.route("snapshots", {}, state())),
    await outcome(() => h.action("snapshot", { op: "take" }, state())),
    await outcome(() => h.action("snapshot", { op: "rm", id: "20260101-000000-x" }, state())),
    await outcome(() => h.action("snapshot", { op: "restore", id: "20260101-000000" }, state())),
    await outcome(() => h.action("snapshot", { op: "rm", id: "../x" }, state())),
    await outcome(() => h.action("snapshot", { op: "apaga" }, state())),
    await outcome(() => h.action("nao-existe", {}, state())),
    await outcome(() => h.action("sims", { op: "status" }, state())),
    await outcome(() => h.action("console", { op: "status" }, state())),
    await outcome(() => h.action("alarm-sim", { op: "rules" }, state())),
    await outcome(() => h.action("alarm-sim", { op: "start" }, state())),
    await outcome(() => h.action("bootstrap", { skipTopology: true }, state())),
    await outcome(() => h.action("bootstrap", {}, state())),
    await outcome(() => h.sample(withUnits)),
  ];
}

describe("plugin-ts: pacote portado × original", () => {
  for (const pack of ["proj-a", "proj-b"]) {
    test(`${pack}: api.ts responde como o golden`, async () => {
      const ts = await startPluginHost(dataDir(`${pack}-ts`, pack, ["api.ts"]), true);
      try {
        const got = norm(await calls(ts), `${pack}-ts`);
        const file = `${GOLD}/plugin-ts-${pack}.json`;
        if (process.env.UPDATE_GOLDEN) writeFileSync(file, `${JSON.stringify(got, null, 2)}\n`);
        expect(got).toEqual(readJson(file) as unknown[]);
        expect(got[1]).toEqual({ snapshots: [{ id: "20260101-000000" }], bytes: 7 });
      } finally { ts.stop(); }
    });
  }

  test("api.ts que não carrega: sem rotas, sem derrubar o painel", async () => {
    const env = dataDir("quebrado", "proj-b", []);
    writeFileSync(`${env.dir}/plugin/panel/api.ts`, "export function x( {\n");
    const h = await startPluginHost(env, true);
    expect(h.functions).toBeUndefined();
    await expect(h.route("x", {}, state())).rejects.toThrow();
    h.stop();
  });

  test("erro do plugin vira falha opaca; recusa leva a mensagem; o host segue de pé", async () => {
    const env = dataDir("erros", "proj-b", []);
    writeFileSync(`${env.dir}/plugin/panel/api.ts`,
      'export function quebra() { throw new Error("caminho interno /x/y"); }\nexport function nega(ctx: { refuse(m: string): never }) { return ctx.refuse("não pode"); }\nexport async function ok() { return { ok: true }; }\n');
    const h = await startPluginHost(env, true);
    try {
      expect(await outcome(() => h.route("quebra", {}, state()))).toBe("erro");
      expect(await outcome(() => h.route("nega", {}, state()))).toBe("recusa:não pode");
      expect(await h.route("ok", {}, state())).toEqual({ ok: true });
    } finally { h.stop(); }
  });
});

// o contrato de plugin exige núcleo >=5: a skill do teste é uma cópia com VERSION 5.0.0 (independe da versão em desenvolvimento)
const SK = `${r.T}/skill-5`;
r.skillCopy(SK); writeFileSync(`${SK}/VERSION`, "5.0.0\n");

describe("plugin-ts: painel numa instalação descartável (host TS)", () => {
  const I = `${SK}/kit/install.sh`;
  /** instala o pacote com o api dado e sobe o painel TS numa porta livre; devolve a resposta de GET /api/plugin/eco */
  function setup(tag: string, file: string, code: string) {
    const packs = `${r.T}/pe-packs-${tag}`, pk = `${packs}/example-monorepo`, wt = `${r.T}/pe-wt-${tag}`, D = `${r.T}/pe-data-${tag}`;
    r.must(r.git(r.C, "worktree", "add", "-q", "-b", `pe/${tag}`, wt));
    mkdirSync(`${pk}/env/panel`, { recursive: true });
    const prof = readJson(`${FX}/packs/example-monorepo/profile.json`); prof.env = { pack: "env" }; prof.core = ">=5"; writeJson(`${pk}/profile.json`, prof);
    writeJson(`${pk}/env/plugin.json`, { name: "example-monorepo", panel: { routes: [{ path: "eco", method: "GET", fn: "eco" }] } });
    writeFileSync(`${pk}/env/panel/${file}`, code);
    const ins = r.X(["bash", I], { merge: true, env: { HADES_PACKS_ROOT: packs, HADES_WT: wt, HADES_DATA: D, SKIP_SYSTEMD: "1", SKIP_WORKTREE: "1", SKIP_DOCTOR: "1" } });
    return { ins, D };
  }

  async function ask(tag: string, file: string, code: string): Promise<{ status: number; body: unknown; routes: unknown }> {
    const { ins, D } = setup(tag, file, code);
    if (ins.rc !== 0) throw new Error(ins.all.split("\n").slice(-5).join("\n"));
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port as number;
    void probe.stop(true);
    const panel = await startPanel(D, port);
    try {
      const base = `http://127.0.0.1:${panel.port}`;
      const res = await fetch(`${base}/api/plugin/eco`);
      const info = (await (await fetch(`${base}/api/plugin`)).json()) as { routes: unknown };
      return { status: res.status, body: await res.json(), routes: info.routes };
    } finally { panel.stop(); }
  }

  test("api.ts responde pelo host TS (contrato novo)", async () => {
    const o = await ask("ts", "api.ts", 'export function eco() { return { ok: true, via: "ts" }; }\n');
    expect([o.status, o.body]).toEqual([200, { ok: true, via: "ts" }]);
    expect(o.routes).toEqual([{ method: "GET", path: "eco" }]);
  });

});
