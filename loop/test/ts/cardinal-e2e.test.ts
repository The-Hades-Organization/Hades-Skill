// Grupo cardinal-e2e: ponta a ponta com o binário real do Cardinal e o build web, numa instância própria do painel (127.0.0.1,
// pasta de dados temporária, sem túnel). Só roda com CARDINAL_E2E_BIN (binário) e CARDINAL_E2E_WEB (pasta dist/ do build web):
// sem eles os testes de binário ficam de fora e sobra o caso "sem binário". O editor em si (WASM no iframe) só roda num
// navegador; aqui a ponte é exercida contra o painel real, com o iframe simulado (reference/argos.md §Nó cardinal). O CLI `hades canvas
// cardinal` exige um pane do herdr para identificar quem chama; o teste usa as mesmas rotas que ele (`convert`, `PUT`, `describe`, `edit`, `export`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, createBridge, createCardinalClient } from "../../../src/lib/cardinal-bridge.ts";
import { startPanel, type Panel } from "../../../src/panel/server.ts";

const SKILL = join(import.meta.dir, "../../..");
const BIN = process.env.CARDINAL_E2E_BIN ?? "";
const WEB = process.env.CARDINAL_E2E_WEB ?? "";
const real = BIN !== "" && existsSync(BIN) && WEB !== "" && existsSync(join(WEB, "index.html"));
const T = mkdtempSync(join(tmpdir(), "hades-cardinal-e2e-"));
const enc = new TextEncoder();
const dec = new TextDecoder();

const LOJA = 'model conceptual "Loja"\nentity Cliente {\n *Id: INT;\n Nome: TEXT;\n}\nentity Pedido {\n *Numero: INT;\n}\nrelationship Faz (Cliente (1,1), Pedido (0,n))\n';
const LOJA_V2 = LOJA.replace("Nome: TEXT;", "Nome: TEXT;\n Email: TEXT;");

interface Rig { panel: Panel; base: string; D: string; token: string }
let rig: Rig;

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  void probe.stop(true);
  return port;
}

const hdr = (): Record<string, string> => ({ "x-panel-token": rig.token, "content-type": "application/json", origin: rig.base });
const post = (path: string, body: unknown): Promise<Response> => fetch(`${rig.base}${path}`, { method: "POST", headers: hdr(), body: JSON.stringify(body) });

async function boot(withBinary: boolean): Promise<void> {
  const D = join(T, `data-${withBinary ? "bin" : "nobin"}`);
  const wt = join(T, "proj");
  mkdirSync(join(D, "panel"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", wt]);
  copyFileSync(join(SKILL, "kit/config.tsv"), join(D, "config.tsv"));
  writeFileSync(join(D, "env.sh"), `W="${wt}"\n`);
  const node = (id: string, name: string, y: number) => ({ id, type: "cardinal", x: 0, y, w: 800, h: 560, z: 0, data: { cardinal: name, title: name }, locked: false, blurred: false });
  writeFileSync(join(D, "canvas.json"), JSON.stringify({ v: 1, rev: 0, nodes: [node("c1", "loja", 0), node("c2", "desenho", 700)], edges: [], groups: [] }));
  const panel = await startPanel(D, await freePort());
  rig = { panel, base: `http://127.0.0.1:${panel.port}`, D, token: panel.token };
  const values: Record<string, string> = { HADES_EXT_CARDINAL: "1", HADES_CARDINAL_BIN: withBinary ? BIN : "/nao/existe/cardinal", HADES_CARDINAL_WEB: withBinary ? WEB : "" };
  await post("/api/config", { values });
}

const CANVAS = "/api/canvas-cardinal/default";
const get = (path: string): Promise<Response> => fetch(`${rig.base}${path}`, { headers: hdr() });
const asText = async (res: Response): Promise<string> => res.text();

/** `cardinal new --from-text`: o binário converte o texto, o painel grava o arquivo do nó (rev nula = cria). */
async function created(nodeId: string, text: string): Promise<Response> {
  const conv = await post("/api/canvas-cardinal/convert", { from: "text", text });
  const { text: file } = (await conv.json()) as { text: string };
  return fetch(`${rig.base}${CANVAS}/${nodeId}`, { method: "PUT", headers: hdr(), body: JSON.stringify({ text: file, rev: null }) });
}
/** `cardinal read`: o texto canônico (describe). */
async function described(nodeId: string): Promise<string> {
  const body = (await (await get(`${CANVAS}/${nodeId}/describe`)).json()) as { describe: unknown };
  return JSON.stringify(body.describe);
}
const revOf = async (nodeId: string): Promise<string> => ((await (await get(`${CANVAS}/${nodeId}`)).json()) as { rev: string }).rev;

/** Lê o SSE do canvas até chegar `want` eventos `cardinal` ou o tempo acabar. */
function listen(): { events: { name: string; rev: string | null; source: string }[]; stop(): void } {
  const events: { name: string; rev: string | null; source: string }[] = [];
  const ctl = new AbortController();
  void (async () => {
    try {
      const res = await fetch(`${rig.base}/api/canvas/stream`, { headers: { "x-panel-token": rig.token }, signal: ctl.signal });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!/^event: cardinal$/m.test(frame)) continue;
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (data !== undefined) events.push(JSON.parse(data));
        }
      }
    } catch {
      // abortado
    }
  })();
  return { events, stop: () => ctl.abort() };
}
const until = async (cond: () => boolean, ms = 6000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 40));
};

afterAll(() => {
  rig?.panel.stop();
  rmSync(T, { recursive: true, force: true });
});

const clientFor = (nodeId: string) => createCardinalClient({ fetch: (u, i) => fetch(`${rig.base}${u}`, { ...i, headers: { ...hdr(), ...(i?.headers as Record<string, string> | undefined) } }), canvasId: "default", nodeId });
const mount = (nodeId: string) => {
  const sent: { type: string; text?: string }[] = [];
  const states: string[] = [];
  const bridge = createBridge({ frame: { post: (m) => sent.push({ type: m.type as string, text: m.bytes instanceof ArrayBuffer ? dec.decode(m.bytes) : undefined }) }, api: clientFor(nodeId), onState: (s) => states.push(s) });
  bridge.handle({ cardinal: BRIDGE_PROTOCOL, type: "ready", protocol: 1, app: "cardinal", format: 2 });
  return { bridge, sent, states };
};
const FILE = (name: string): string => join(rig.D, "canvas-cardinal", `${name}.cardinal`);

describe.skipIf(!real)("cardinal e2e: binário real e build web", () => {
  beforeAll(() => boot(true));
  afterAll(() => rig.panel.stop());

  test("motor padrão é cardinal e o build web sai pela rota do painel", async () => {
    const ext = (await (await get("/api/extensions")).json()) as { drawingEngine: { configured: string; effective: string; reason: unknown } };
    expect(ext.drawingEngine).toMatchObject({ configured: "cardinal", effective: "cardinal", reason: null });
    const idx = await fetch(`${rig.base}/ext/cardinal/web/index.html`);
    expect(idx.status).toBe(200);
    expect(await idx.text()).toContain("<");
  });

  test("new --from-text: o binário converte e o painel grava o arquivo do nó", async () => {
    const res = await created("c1", LOJA);
    expect(res.status).toBe(200);
    expect(existsSync(FILE("loja"))).toBe(true);
  });

  test("read: o describe traz as entidades", async () => {
    const out = await described("c1");
    expect(out).toContain("Cliente");
    expect(out).toContain("Pedido");
  });

  test("apply (edit): troca o diagrama e o read seguinte vê a mudança", async () => {
    const rev = await revOf("c1");
    const res = await post(`${CANVAS}/c1/edit`, { text: LOJA_V2, rev });
    expect(res.status).toBe(200);
    expect(await described("c1")).toContain("Email");
  });

  test("export svg e png", async () => {
    const svg = await post(`${CANVAS}/c1/export`, { format: "svg" });
    expect(svg.status).toBe(200);
    expect(await asText(svg)).toContain("<svg");
    const png = await post(`${CANVAS}/c1/export`, { format: "png" });
    expect(png.status).toBe(200);
    expect([...new Uint8Array(await png.arrayBuffer()).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("editor no nó: a ponte carrega, salva e o painel grava no arquivo", async () => {
    const { bridge, sent } = mount("c1");
    await until(() => bridge.state() === "ready");
    expect(bridge.state()).toBe("ready");
    expect(sent[0]?.type).toBe("load");
    expect(sent[0]?.text).toContain("Email");
    const edited = readFileSync(FILE("loja"), "utf8").replace("Email", "Mail");
    bridge.handle({ cardinal: BRIDGE_PROTOCOL, type: "save", baseRev: await revOf("c1"), bytes: enc.encode(edited).buffer });
    await until(() => readFileSync(FILE("loja"), "utf8") === edited);
    expect(readFileSync(FILE("loja"), "utf8")).toBe(edited);
    expect(await described("c1")).toContain("Mail");
  });

  test("mudança externa vira aviso SSE, o editor recebe external-change e o salvamento com base velha é recusado sem perda", async () => {
    const watch = listen();
    await new Promise((r) => setTimeout(r, 300));
    const { bridge, sent } = mount("c1");
    await until(() => bridge.state() === "ready");
    const before = await revOf("c1");
    // o app nativo grava por rename atômico
    const external = readFileSync(FILE("loja"), "utf8").replace("Mail", "Correio");
    writeFileSync(`${FILE("loja")}.tmp`, external);
    renameSync(`${FILE("loja")}.tmp`, FILE("loja"));
    await until(() => watch.events.some((e) => e.name === "loja" && e.source === "disk"));
    const ev = watch.events.find((e) => e.name === "loja" && e.source === "disk");
    expect(ev).toBeDefined();
    expect(ev?.rev).not.toBe(before);
    bridge.fileChanged(ev?.rev ?? null);
    await until(() => sent.some((s) => s.type === "external-change"));
    expect(sent.find((s) => s.type === "external-change")?.text).toContain("Correio");
    // o editor ainda salva com a base velha: o painel recusa, manda save-rejected e depois o conteúdo atual
    bridge.handle({ cardinal: BRIDGE_PROTOCOL, type: "save", baseRev: before, bytes: enc.encode(external.replace("Correio", "Perdido")).buffer });
    await until(() => sent.some((s) => s.type === "save-rejected"));
    const order = sent.map((s) => s.type);
    expect(order.indexOf("save-rejected")).toBeGreaterThan(-1);
    expect(readFileSync(FILE("loja"), "utf8")).toContain("Correio");
    expect(readFileSync(FILE("loja"), "utf8")).not.toContain("Perdido");
    watch.stop();
  });

  test("agente com base velha: o edit dá 409 e nada é perdido; com a rev nova passa", async () => {
    const stale = await revOf("c1");
    const external = readFileSync(FILE("loja"), "utf8").replace("Correio", "Contato");
    writeFileSync(`${FILE("loja")}.tmp`, external);
    renameSync(`${FILE("loja")}.tmp`, FILE("loja"));
    const res = await post(`${CANVAS}/c1/edit`, { text: LOJA_V2, rev: stale });
    expect(res.status).toBe(409);
    expect(readFileSync(FILE("loja"), "utf8")).toContain("Contato");
    const ok = await post(`${CANVAS}/c1/edit`, { text: LOJA_V2, rev: await revOf("c1") });
    expect(ok.status).toBe(200);
  });

  test("arquivo novo com o editor já montado: o aviso SSE o tira de 'ausente'", async () => {
    const watch = listen();
    await new Promise((r) => setTimeout(r, 300));
    // o nó c2 já está no documento, o arquivo ainda não: o editor monta, lê 'ausente'...
    const { bridge, sent } = mount("c2");
    await until(() => bridge.state() === "failed");
    expect(bridge.state()).toBe("failed");
    // ...e o PUT termina depois; o painel avisa pelo SSE e o editor se ressincroniza sem outro gesto
    expect((await created("c2", LOJA)).status).toBe(200);
    await until(() => watch.events.some((e) => e.name === "desenho" && e.rev !== null));
    const ev = watch.events.find((e) => e.name === "desenho" && e.rev !== null);
    expect(ev).toBeDefined();
    bridge.fileChanged(ev?.rev ?? null);
    await until(() => bridge.state() === "ready");
    expect(bridge.state()).toBe("ready");
    expect(sent.map((s) => s.type)).toContain("load");
    expect(sent.find((s) => s.type === "load")?.text).toContain("Cliente");
    watch.stop();
  });
});

describe("cardinal e2e: sem binário e sem build web", () => {
  beforeAll(() => boot(false));
  afterAll(() => rig.panel.stop());

  test("motor efetivo cai para hades, com a razão", async () => {
    const ext = (await (await fetch(`${rig.base}/api/extensions`, { headers: hdr() })).json()) as { drawingEngine: { configured: string; effective: string; reason: { code: string } | null } };
    expect(ext.drawingEngine.configured).toBe("cardinal");
    expect(ext.drawingEngine.effective).toBe("hades");
    expect(ext.drawingEngine.reason?.code).toBeDefined();
  });

  test("a rota do build web responde 404 sem a pasta configurada", async () => {
    expect((await fetch(`${rig.base}/ext/cardinal/web/index.html`)).status).toBeGreaterThanOrEqual(400);
  });

  test("preferências do editor: o painel guarda o texto e a ponte o devolve no load seguinte, de qualquer nó", async () => {
    const text = '{"theme":"dark","onboarded":true}';
    expect(await clientFor("c1").settings()).toBe("");
    const first = mount("c1");
    first.bridge.handle({ cardinal: BRIDGE_PROTOCOL, type: "settings-changed", settings: text });
    await until(() => existsSync(join(rig.D, "canvas-cardinal", ".settings.json")));
    expect(await clientFor("c2").settings()).toBe(text);
  });

  test("convert recusa com cardinal_unavailable (503), nada é criado", async () => {
    const res = await post("/api/canvas-cardinal/convert", { from: "text", text: LOJA });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("cardinal_unavailable");
  });
});
