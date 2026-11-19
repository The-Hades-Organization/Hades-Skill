// Grupo cardinal-bridge: lado do painel da ponte postMessage com o editor do Cardinal embutido (src/lib/cardinal-bridge.ts),
// contra um iframe simulado por script: carregar, salvar, 409, mudança externa, exportar, recolher, teto de editores.
import { describe, expect, test } from "bun:test";
import {
  BRIDGE_PROTOCOL, EDITOR_MAX_LIVE, createBridge, createCardinalClient, createCardinalFeed, createEditorSlots, isFromFrame,
  type BridgeApi, type FileRead, type ReadResult, type WriteResult,
} from "../../../src/lib/cardinal-bridge";

const enc = new TextEncoder();
const dec = new TextDecoder();
const buf = (text: string): ArrayBuffer => enc.encode(text).buffer as ArrayBuffer;

interface Sent { message: Record<string, unknown>; text?: string }

/** Painel de mentira: o arquivo vive num objeto, o iframe é uma lista de mensagens recebidas. */
function rig(initial: Partial<FileRead> & { text?: string } = {}) {
  const file = { text: initial.text ?? "v1", rev: initial.rev ?? "r1", format: initial.format ?? 2, supported: initial.supported ?? true, missing: false, broken: false };
  const sent: Sent[] = [];
  const stored: { format: string; text: string; rev: string }[] = [];
  const events: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let writes = 0;
  const api: BridgeApi = {
    async read(): Promise<ReadResult> {
      if (file.missing) return { ok: false, code: "cardinal_not_found" };
      if (file.broken) return { ok: false, code: "cardinal_unreadable" };
      return { ok: true, bytes: enc.encode(file.text), rev: file.rev, format: file.format, supported: file.supported };
    },
    async write(bytes, baseRev): Promise<WriteResult> {
      writes++;
      if (baseRev !== file.rev) return { ok: false, code: "cardinal_stale_revision", rev: file.rev };
      file.text = dec.decode(bytes);
      file.rev = `r${writes + 1}`;
      return { ok: true, rev: file.rev };
    },
    async storeImage(format, bytes, rev) {
      if (rev !== file.rev) return { ok: false, code: "cardinal_stale_revision" };
      stored.push({ format, text: dec.decode(bytes), rev });
      return { ok: true };
    },
  };
  const bridge = createBridge({
    frame: {
      post: (message, transfer) => {
        sent.push({ message, text: message.bytes instanceof ArrayBuffer ? dec.decode(message.bytes) : undefined });
        expect(transfer as unknown).toEqual(message.bytes === undefined ? [] : [message.bytes]);
      },
    },
    api,
    onState: (state, reason) => events.push(`state:${state}${reason ? `:${reason}` : ""}`),
    onDirty: (d) => events.push(`dirty:${d}`),
    onSaved: (rev) => events.push(`saved:${rev}`),
    onMergeNotice: (c) => events.push(`merge:${c.map((x) => x.kind).join(",")}`),
    onError: (code) => events.push(`error:${code}`),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
  });
  const tick = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
  const fromEditor = (message: Record<string, unknown>, text?: string): void => bridge.handle({ cardinal: BRIDGE_PROTOCOL, ...message, ...(text === undefined ? {} : { bytes: buf(text) }) });
  const types = (): string[] => sent.map((s) => s.message.type as string);
  return { file, sent, stored, events, timers, bridge, tick, fromEditor, types, writes: () => writes };
}

const ready = (format = 2): Record<string, unknown> => ({ type: "ready", protocol: 1, app: "cardinal 0.1.0", format });

describe("cardinal-bridge: abrir", () => {
  test("ready → load com os bytes, a rev e readOnly:false; cada mensagem leva cardinal:1", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.message).toMatchObject({ cardinal: 1, type: "load", rev: "r1", readOnly: false });
    expect(r.sent[0]?.text).toBe("v1");
    expect(r.bridge.state()).toBe("ready");
    expect(r.bridge.rev()).toBe("r1");
  });

  test("format do arquivo maior que o do ready → readOnly:true e estado só leitura", async () => {
    const r = rig({ format: 3 });
    r.fromEditor(ready(2));
    await r.tick();
    expect(r.sent[0]?.message.readOnly).toBe(true);
    expect(r.bridge.state()).toBe("readonly");
    expect(r.events).toContain("state:readonly:format_too_new");
  });

  test("arquivo que a rota marca como não suportado também abre só leitura", async () => {
    const r = rig({ supported: false });
    r.fromEditor(ready());
    await r.tick();
    expect(r.sent[0]?.message.readOnly).toBe(true);
  });

  test("protocolo diferente no ready não carrega nada", async () => {
    const r = rig();
    r.fromEditor({ ...ready(), protocol: 2 });
    await r.tick();
    expect(r.sent).toHaveLength(0);
    expect(r.bridge.state()).toBe("failed");
  });

  test("leitura falha → failed; mensagem sem cardinal:1 ou objeto estranho é ignorada", async () => {
    const r = rig();
    r.file.broken = true;
    r.bridge.handle({ type: "ready", protocol: 1, format: 2 });
    r.bridge.handle("ready");
    r.bridge.handle(null);
    r.bridge.handle({ cardinal: 2, type: "ready", protocol: 1 });
    await r.tick();
    expect(r.sent).toHaveLength(0);
    r.fromEditor(ready());
    await r.tick();
    expect(r.events).toContain("state:failed:cardinal_unreadable");
  });

  test("isFromFrame só aceita a janela do iframe", () => {
    const win = {};
    expect(isFromFrame({ source: win }, win)).toBe(true);
    expect(isFromFrame({ source: {} }, win)).toBe(false);
    expect(isFromFrame({ source: undefined }, undefined)).toBe(false);
  });
});

describe("cardinal-bridge: salvar", () => {
  test("save com a rev base → grava e responde saved; dirty volta a falso", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.fromEditor({ type: "dirty" });
    expect(r.bridge.dirty()).toBe(true);
    r.fromEditor({ type: "save", baseRev: "r1" }, "v2");
    await r.tick();
    expect(r.file.text).toBe("v2");
    expect(r.sent.at(-1)?.message).toMatchObject({ type: "saved", rev: "r2" });
    expect(r.bridge.rev()).toBe("r2");
    expect(r.bridge.dirty()).toBe(false);
    expect(r.events).toContain("saved:r2");
  });

  test("409: save-rejected e depois external-change com o conteúdo atual; o save seguinte usa a rev nova", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.fromEditor({ type: "dirty" });
    r.file.text = "do-agente";
    r.file.rev = "r9";
    r.fromEditor({ type: "save", baseRev: "r1" }, "meu");
    await r.tick();
    expect(r.types()).toEqual(["load", "save-rejected", "external-change"]);
    expect(r.sent[1]?.message).toMatchObject({ currentRev: "r9" });
    expect(r.sent[2]?.message).toMatchObject({ rev: "r9" });
    expect(r.sent[2]?.text).toBe("do-agente");
    expect(r.file.text).toBe("do-agente");
    expect(r.bridge.dirty()).toBe(true);
    r.fromEditor({ type: "save", baseRev: "r9" }, "mesclado");
    await r.tick();
    expect(r.file.text).toBe("mesclado");
    expect(r.sent.at(-1)?.message.type).toBe("saved");
  });

  test("409 com arquivo de formato maior: save-rejected e set-readonly, sem external-change", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.file.rev = "r9";
    r.file.format = 3;
    r.fromEditor({ type: "save", baseRev: "r1" }, "x");
    await r.tick();
    expect(r.types()).toEqual(["load", "save-rejected", "set-readonly"]);
    expect(r.bridge.state()).toBe("readonly");
  });

  test("save sem bytes ou sem baseRev vira erro e não grava", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.fromEditor({ type: "save", baseRev: "r1" });
    r.fromEditor({ type: "save" }, "x");
    await r.tick();
    expect(r.writes()).toBe(0);
    expect(r.events.filter((e) => e === "error:panel_invalid_save")).toHaveLength(2);
  });

  test("save em só leitura é descartado", async () => {
    const r = rig({ format: 3 });
    r.fromEditor(ready());
    await r.tick();
    r.fromEditor({ type: "save", baseRev: "r1" }, "x");
    await r.tick();
    expect(r.writes()).toBe(0);
    expect(r.events).toContain("error:panel_readonly");
  });

  test("dois saves seguidos andam em ordem", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.fromEditor({ type: "save", baseRev: "r1" }, "a");
    r.fromEditor({ type: "save", baseRev: "r2" }, "b");
    await r.tick();
    expect(r.file.text).toBe("b");
    expect(r.types()).toEqual(["load", "saved", "saved"]);
  });
});

describe("cardinal-bridge: mudança externa (SSE)", () => {
  test("aviso com rev nova → external-change com os bytes atuais", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.file.text = "agente";
    r.file.rev = "r5";
    r.bridge.fileChanged("r5");
    await r.tick();
    expect(r.sent.at(-1)?.message).toMatchObject({ type: "external-change", rev: "r5" });
    expect(r.sent.at(-1)?.text).toBe("agente");
    expect(r.bridge.rev()).toBe("r5");
  });

  test("eco da própria gravação (mesma rev) não manda nada", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.fromEditor({ type: "save", baseRev: "r1" }, "v2");
    await r.tick();
    r.bridge.fileChanged("r2");
    await r.tick();
    expect(r.types()).toEqual(["load", "saved"]);
  });

  test("aviso antes do ready é ignorado; com load falho, o aviso refaz o load", async () => {
    const r = rig();
    r.bridge.fileChanged("r5");
    await r.tick();
    expect(r.sent).toHaveLength(0);
    r.file.broken = true;
    r.fromEditor(ready());
    await r.tick();
    r.file.broken = false;
    r.bridge.fileChanged("r1");
    await r.tick();
    expect(r.types()).toEqual(["load"]);
    expect(r.bridge.state()).toBe("ready");
  });

  test("rev nula: o arquivo saiu do disco; quando volta, o editor recebe o conteúdo", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.bridge.fileChanged(null);
    await r.tick();
    expect(r.bridge.state()).toBe("gone");
    r.file.text = "de-volta";
    r.file.rev = "r7";
    r.bridge.fileChanged("r7");
    await r.tick();
    expect(r.bridge.state()).toBe("ready");
    expect(r.sent.at(-1)?.text).toBe("de-volta");
  });

  test("merge-notice chega ao painel; lista vazia ou tipo estranho não", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.fromEditor({ type: "merge-notice", conflicts: [{ kind: "both-changed", id: 3 }, { kind: "x" }] });
    r.fromEditor({ type: "merge-notice", conflicts: [] });
    r.fromEditor({ type: "merge-notice", conflicts: [{ kind: "nope" }] });
    expect(r.events.filter((e) => e.startsWith("merge:"))).toEqual(["merge:both-changed"]);
  });
});

describe("cardinal-bridge: exportar", () => {
  test("SVG sem edição pendente: pede ao editor, recebe e grava ao lado com a rev", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    const done = r.bridge.requestExport("svg");
    const id = r.sent.at(-1)?.message.id;
    expect(r.sent.at(-1)?.message).toMatchObject({ type: "request-export", format: "svg" });
    r.fromEditor({ type: "export-result", id, format: "svg" }, "<svg/>");
    const out = await done;
    expect(out).toMatchObject({ ok: true, stored: true });
    expect(r.stored).toEqual([{ format: "svg", text: "<svg/>", rev: "r1" }]);
  });

  test("com edição pendente a imagem volta mas não é gravada ao lado", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.fromEditor({ type: "dirty" });
    const done = r.bridge.requestExport("png", { scale: 2 });
    expect(r.sent.at(-1)?.message).toMatchObject({ format: "png", scale: 2 });
    r.fromEditor({ type: "export-result", id: r.sent.at(-1)?.message.id, format: "png" }, "PNG");
    expect(await done).toMatchObject({ ok: true, stored: false, storedReason: "dirty" });
    expect(r.stored).toHaveLength(0);
  });

  test("diagrama explícito não substitui o SVG do cartão", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    const done = r.bridge.requestExport("svg", { diagram: "m2" });
    expect(r.sent.at(-1)?.message.diagram).toBe("m2");
    r.fromEditor({ type: "export-result", id: r.sent.at(-1)?.message.id, format: "svg" }, "<svg/>");
    expect(await done).toMatchObject({ ok: true, stored: false, storedReason: "diagram" });
  });

  test("erro do editor, falta de bytes e prazo viram falha", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    const a = r.bridge.requestExport("svg");
    r.fromEditor({ type: "export-result", id: r.sent.at(-1)?.message.id, format: "svg", error: "no model" });
    expect(await a).toEqual({ ok: false, error: "no model" });
    const b = r.bridge.requestExport("svg");
    r.fromEditor({ type: "export-result", id: r.sent.at(-1)?.message.id, format: "svg" });
    expect(await b).toEqual({ ok: false, error: "missing-bytes" });
    const c = r.bridge.requestExport("svg");
    r.timers.filter((t) => t.live).at(-1)?.fn();
    expect(await c).toEqual({ ok: false, error: "export_timeout" });
  });

  test("antes do ready não exporta", async () => {
    const r = rig();
    expect(await r.bridge.requestExport("svg")).toEqual({ ok: false, error: "editor_unavailable" });
  });
});

describe("cardinal-bridge: recolher o nó", () => {
  test("flush tira o foco do iframe e espera o saved", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.fromEditor({ type: "dirty" });
    let blurred = 0;
    const done = r.bridge.flush(() => {
      blurred++;
      r.fromEditor({ type: "save", baseRev: "r1" }, "v2");
    });
    expect(blurred).toBe(1);
    expect(await done).toBe(true);
    expect(r.file.text).toBe("v2");
  });

  test("sem edição pendente não mexe no foco; sem resposta no prazo devolve false", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    expect(await r.bridge.flush(() => { throw new Error("não devia"); })).toBe(true);
    r.fromEditor({ type: "dirty" });
    const done = r.bridge.flush(() => undefined);
    r.timers.filter((t) => t.live).at(-1)?.fn();
    expect(await done).toBe(false);
  });

  test("close: não manda mais nada e fecha exportações em voo", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    const pending = r.bridge.requestExport("svg");
    r.bridge.close();
    expect(await pending).toEqual({ ok: false, error: "closed" });
    const before = r.sent.length;
    r.bridge.fileChanged("r9");
    r.fromEditor({ type: "save", baseRev: "r1" }, "x");
    await r.tick();
    expect(r.sent).toHaveLength(before);
  });
});

describe("cardinal-bridge: teto de editores e feed", () => {
  test("o terceiro editor não cabe; soltar um libera; pedir o mesmo nó é idempotente", () => {
    const slots = createEditorSlots();
    expect(EDITOR_MAX_LIVE).toBe(2);
    expect(slots.acquire("a")).toBe(true);
    expect(slots.acquire("a")).toBe(true);
    expect(slots.acquire("b")).toBe(true);
    expect(slots.acquire("c")).toBe(false);
    slots.release("a");
    expect(slots.acquire("c")).toBe(true);
    expect(slots.live().sort()).toEqual(["b", "c"]);
  });

  test("o feed entrega só ao nome do diagrama e para depois de cancelar", () => {
    const feed = createCardinalFeed();
    const got: string[] = [];
    const off = feed.subscribe("a", (n) => got.push(`a:${n.rev}`));
    feed.subscribe("b", (n) => got.push(`b:${n.rev}`));
    feed.publish({ name: "a", rev: "1", source: "disk" });
    feed.publish({ name: "b", rev: null, source: "panel" });
    off();
    feed.publish({ name: "a", rev: "2", source: "disk" });
    expect(got).toEqual(["a:1", "b:null"]);
  });
});

describe("cardinal-bridge: cliente das rotas", () => {
  type Call = { url: string; method: string; body?: unknown };
  const client = (handler: (call: Call) => { status: number; body: unknown } | Error) => {
    const calls: Call[] = [];
    const api = createCardinalClient({
      canvasId: "default", nodeId: "c 1",
      fetch: async (url, init) => {
        const call = { url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) };
        calls.push(call);
        const out = handler(call);
        if (out instanceof Error) throw out;
        return { status: out.status, json: async () => out.body };
      },
    });
    return { api, calls };
  };

  test("read devolve bytes, rev e format; save manda text e rev; 409 traz a rev atual", async () => {
    const c = client((call) => call.method === "GET"
      ? { status: 200, body: { text: "{}", rev: "r1", format: 2, supported: true, valid: true } }
      : call.body && (call.body as { rev: string }).rev === "r1" ? { status: 200, body: { ok: true, rev: "r2" } } : { status: 409, body: { code: "cardinal_stale_revision", rev: "r9" } });
    const read = await c.api.read();
    expect(read).toMatchObject({ ok: true, rev: "r1", format: 2, supported: true });
    expect(c.calls[0]?.url).toBe("/api/canvas-cardinal/default/c%201");
    expect(await c.api.write(enc.encode("novo"), "r1")).toEqual({ ok: true, rev: "r2" });
    expect(c.calls[1]?.body).toEqual({ text: "novo", rev: "r1" });
    expect(await c.api.write(enc.encode("novo"), "r0")).toEqual({ ok: false, code: "cardinal_stale_revision", rev: "r9" });
  });

  test("storeImage: SVG como texto, PNG em base64, para /artifact", async () => {
    const c = client(() => ({ status: 200, body: { ok: true } }));
    await c.api.storeImage("svg", enc.encode("<svg/>"), "r1");
    await c.api.storeImage("png", new Uint8Array([0x89, 0x50]), "r1");
    expect(c.calls[0]).toMatchObject({ url: "/api/canvas-cardinal/default/c%201/artifact", method: "POST", body: { format: "svg", rev: "r1", data: "<svg/>" } });
    expect((c.calls[1]?.body as { data: string }).data).toBe(btoa(String.fromCharCode(0x89, 0x50)));
  });

  test("rede que cai, resposta fora do contrato e UTF-8 inválido viram código, sem lançar", async () => {
    const down = client(() => new Error("rede"));
    expect(await down.api.read()).toEqual({ ok: false, code: "cardinal_network" });
    const odd = client(() => ({ status: 200, body: "texto" }));
    expect(await odd.api.read()).toEqual({ ok: false, code: "cardinal_bad_response" });
    expect(await odd.api.write(new Uint8Array([0xff, 0xfe]), "r1")).toEqual({ ok: false, code: "cardinal_not_utf8" });
    expect(odd.calls).toHaveLength(1);
  });
});
