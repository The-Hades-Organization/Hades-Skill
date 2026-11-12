// Grupo ext-painel: rotas /api/extensions do painel (GET e POST) sobre o carregador de extensões, com painel real em processo,
// $D descartável e binário falso no PATH (nada do herdr ou do Mark reais).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Rig } from "./lib/rig";
import { fetchRaw, JSON_CT, remoteHeaders, startTestPanel, widgetData } from "./lib/widget-rig";

type Dict = Record<string, unknown>;
const r = new Rig().setup();
afterAll(() => r.cleanup());

const BIN = `${r.T}/ext-bin`;
const { D } = widgetData(r, "extp");
const saved = { PATH: process.env.PATH, HERDR: process.env.HADES_EXT_HERDR, BIN: process.env.HADES_HERDR_BIN };
let P: Awaited<ReturnType<typeof startTestPanel>>;
let token: Record<string, string>;
let remote: Record<string, string>;

const list = async (headers: Record<string, string> = {}) => fetchRaw(P.base, "/api/extensions", headers);
const post = (headers: Record<string, string>, body: unknown) => fetchRaw(P.base, "/api/extensions", headers, body);
const byName = (j: Dict | null, name: string) => ((j?.extensions as Dict[]) ?? []).find((e) => e.name === name) as Dict;
const configEnv = () => readFileSync(`${D}/config.env`, "utf8");

beforeAll(async () => {
  mkdirSync(BIN, { recursive: true });
  // herdr falso: responde a --version; o mark não existe no PATH
  writeFileSync(`${BIN}/herdr`, "#!/bin/sh\necho 'herdr 0.9.4'\n");
  chmodSync(`${BIN}/herdr`, 0o755);
  delete process.env.HADES_EXT_HERDR;
  delete process.env.HADES_HERDR_BIN;
  process.env.PATH = `${BIN}:/usr/bin:/bin`;
  P = await startTestPanel(D);
  token = { ...JSON_CT, "X-Panel-Token": P.token };
  remote = remoteHeaders(D);
});
afterAll(() => {
  P?.stop();
  if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
  if (saved.HERDR !== undefined) process.env.HADES_EXT_HERDR = saved.HERDR;
  if (saved.BIN !== undefined) process.env.HADES_HERDR_BIN = saved.BIN;
});

describe("GET /api/extensions", () => {
  test("dado herdr falso no PATH, então devolve a versão 1 com versão, mínima e instalada", async () => {
    const rep = await list();
    expect(rep.status).toBe(200);
    expect(rep.json?.version).toBe(1);
    expect(byName(rep.json, "herdr")).toMatchObject({ installed: true, version: "0.9.4", minVersion: "0.9.0", enabled: true, problems: [] });
  });

  test("dado mark ausente, então instalada é false e o problema leva o código estável", async () => {
    const mark = byName((await list()).json, "mark");
    expect(mark).toMatchObject({ installed: false, version: null });
    expect((mark.problems as Dict[]).map((p) => p.code)).toEqual(["ext.binary-missing"]);
  });

  test("dado o acesso remoto com a chave, então lê a lista (só leitura)", async () => {
    expect((await list(remote)).status).toBe(200);
  });

  test("dado o acesso remoto sem a chave, então 401", async () => {
    expect((await list({ Host: remote.Host as string, "X-Forwarded-Host": remote["X-Forwarded-Host"] as string })).status).toBe(401);
  });
});

describe("POST /api/extensions", () => {
  test("dado pedido sem o token da sessão, então 403 e nada é gravado", async () => {
    const rep = await post(JSON_CT, { op: "disable", name: "herdr" });
    expect(rep.status).toBe(403);
    expect(configEnv()).not.toContain("HADES_EXT_HERDR");
  });

  test("dado disable de herdr, então grava HADES_EXT_HERDR=0 e a lista seguinte mostra desligada", async () => {
    const rep = await post(token, { op: "disable", name: "herdr" });
    expect(rep.status).toBe(200);
    expect(rep.json).toMatchObject({ version: 1, ok: true, name: "herdr", enabled: false });
    expect(configEnv()).toContain("HADES_EXT_HERDR=0");
    expect(byName((await list()).json, "herdr").enabled).toBe(false);
  });

  test("dado enable de herdr, então o config.env volta ao padrão (sem a chave) e a lista mostra ligada", async () => {
    const rep = await post(token, { op: "enable", name: "herdr" });
    expect(rep.json).toMatchObject({ ok: true, enabled: true });
    expect(configEnv()).not.toContain("HADES_EXT_HERDR");
    expect(byName((await list()).json, "herdr").enabled).toBe(true);
  });

  test("dado o acesso remoto, então recusa com ext.local-only e não grava", async () => {
    const before = configEnv();
    const rep = await post({ ...remote, ...token }, { op: "disable", name: "herdr" });
    expect([rep.status, rep.code]).toEqual([403, "ext.local-only"]);
    expect(configEnv()).toBe(before);
  });

  test("dado nome desconhecido, então 404 com ext.unknown", async () => {
    const rep = await post(token, { op: "disable", name: "nao-existe" });
    expect([rep.status, rep.code]).toEqual([404, "ext.unknown"]);
  });

  test.each([
    ["nome com caminho", { op: "disable", name: "../herdr" }],
    ["nome ausente", { op: "disable" }],
    ["operação desconhecida", { op: "apagar", name: "herdr" }],
    ["nome que não é texto", { op: "enable", name: 7 }],
  ])("dado %s, então 400 com ext.bad-request", async (_caso, body) => {
    const rep = await post(token, body);
    expect([rep.status, rep.code]).toEqual([400, "ext.bad-request"]);
  });
});
