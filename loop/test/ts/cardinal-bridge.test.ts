// Grupo cardinal-bridge: lado do painel da ponte postMessage com o editor do Cardinal embutido (src/lib/cardinal-bridge.ts),
// contra um iframe simulado por script: carregar, salvar, 409, mudança externa, exportar, recolher, teto de editores.
import { describe, expect, test } from "bun:test";
import {
  BRIDGE_PROTOCOL, EDITOR_MAX_LIVE, canonicalText, cardNotice, cardSummary, cardThumb, cardViewOf, createBridge, createCardViewStore, svgDataUrl, createCardinalClient, createCardinalFeed, createEditorSlots, isFromFrame, engineChoiceOf, freshDiagramName, emptyDiagramText, prepareDiagram,
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
  const prefs: { text: string; saved: string[]; fail: boolean } = { text: "", saved: [], fail: false };
  /** Segura a resposta da próxima leitura (o resultado já está decidido quando ela parte), como a rede faz. */
  let hold: Promise<void> | undefined;
  const holdRead = (): (() => void) => {
    let release = (): void => {};
    hold = new Promise<void>((resolve) => { release = resolve; });
    return release;
  };
  const api: BridgeApi = {
    async read(): Promise<ReadResult> {
      const held = hold;
      hold = undefined;
      const answer = ((): ReadResult => {
        if (file.missing) return { ok: false, code: "cardinal_not_found" };
        if (file.broken) return { ok: false, code: "cardinal_unreadable" };
        return { ok: true, bytes: enc.encode(file.text), rev: file.rev, format: file.format, supported: file.supported };
      })();
      if (held) await held;
      return answer;
    },
    async write(bytes, baseRev): Promise<WriteResult> {
      writes++;
      if (baseRev !== file.rev) return { ok: false, code: "cardinal_stale_revision", rev: file.rev };
      file.text = dec.decode(bytes);
      file.rev = `r${writes + 1}`;
      return { ok: true, rev: file.rev };
    },
    async settings() {
      return prefs.text;
    },
    async saveSettings(text) {
      prefs.saved.push(text);
      return prefs.fail ? { ok: false, code: "cardinal_unreadable" } : { ok: true };
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
    onMergeFailed: () => events.push("merge-failed"),
    onError: (code) => events.push(`error:${code}`),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
  });
  const tick = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
  const fromEditor = (message: Record<string, unknown>, text?: string): void => bridge.handle({ cardinal: BRIDGE_PROTOCOL, ...message, ...(text === undefined ? {} : { bytes: buf(text) }) });
  const types = (): string[] => sent.map((s) => s.message.type as string);
  return { prefs, file, sent, stored, events, timers, bridge, tick, fromEditor, types, holdRead, writes: () => writes };
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

  test("load leva as preferências que o painel guardou, como vieram; sem nenhuma, texto vazio", async () => {
    const stored = '{"theme":"dark","onboarded":true}';
    const r = rig();
    r.prefs.text = stored;
    r.fromEditor(ready());
    await r.tick();
    expect(r.sent[0]?.message.settings).toBe(stored);
    const fresh = rig();
    fresh.fromEditor(ready());
    await fresh.tick();
    expect(fresh.sent[0]?.message.settings).toBe("");
  });

  test("settings-changed grava o texto inteiro, sem interpretar, e uma falha vira erro sem derrubar o editor", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.fromEditor({ type: "settings-changed", settings: '{"theme":"light","extra":1}' });
    await r.tick();
    expect(r.prefs.saved).toEqual(['{"theme":"light","extra":1}']);
    r.prefs.fail = true;
    r.fromEditor({ type: "settings-changed", settings: "{}" });
    await r.tick();
    expect(r.events).toContain("error:cardinal_unreadable");
    expect(r.bridge.state()).toBe("ready");
    r.fromEditor({ type: "settings-changed" });
    await r.tick();
    expect(r.events).toContain("error:panel_invalid_settings");
    expect(r.prefs.saved).toHaveLength(2);
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

  test("arquivo recém-criado: o editor montou antes do PUT, leu 'ausente' e o aviso SSE o ressincroniza", async () => {
    const r = rig({ text: "novo", rev: "r1" });
    r.file.missing = true;
    r.fromEditor(ready());
    await r.tick();
    expect(r.bridge.state()).toBe("failed");
    r.file.missing = false;
    r.bridge.fileChanged("r1");
    await r.tick();
    expect(r.bridge.state()).toBe("ready");
    expect(r.types()).toEqual(["load"]);
    expect(r.sent.at(-1)?.text).toBe("novo");
  });

  test("o aviso SSE chega com a leitura 'ausente' ainda em voo: o editor relê ao terminar, sem esperar outro aviso", async () => {
    const r = rig({ text: "novo", rev: "r1" });
    r.file.missing = true;
    const release = r.holdRead();
    r.fromEditor(ready());
    await r.tick();
    expect(r.bridge.state()).toBe("loading");
    r.file.missing = false;
    r.bridge.fileChanged("r1");
    release();
    await r.tick();
    expect(r.bridge.state()).toBe("ready");
    expect(r.sent.at(-1)?.text).toBe("novo");
  });

  test("aviso durante a leitura que deu certo e já traz o conteúdo novo: não repete o load à toa", async () => {
    const r = rig({ text: "v1", rev: "r1" });
    const release = r.holdRead();
    r.fromEditor(ready());
    await r.tick();
    r.bridge.fileChanged("r1");
    release();
    await r.tick();
    expect(r.types()).toEqual(["load"]);
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

  test("merge-failed (error com esse code) chega como aviso próprio, não como erro; outro code segue erro", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.fromEditor({ type: "error", code: "merge-failed", message: "invalid project" });
    r.fromEditor({ type: "error", code: "save-failed", message: "x" });
    expect(r.events.filter((e) => e.startsWith("merge-failed") || e.startsWith("error:"))).toEqual(["merge-failed", "error:save-failed"]);
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

  test("feed.resync chama os assinantes que pediram e para depois de cancelar", () => {
    const feed = createCardinalFeed();
    const got: string[] = [];
    const offA = feed.subscribe("a", () => {}, () => got.push("a"));
    feed.subscribe("b", () => {}, () => got.push("b"));
    feed.subscribe("c", () => {});
    feed.resync();
    offA();
    feed.resync();
    expect(got).toEqual(["a", "b", "b"]);
  });
});

describe("cardinal-bridge: resync ao religar o stream", () => {
  test("arquivo mudou durante a queda: o editor recebe os bytes novos", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.file.text = "por-fora";
    r.file.rev = "r9";
    r.bridge.resync();
    await r.tick();
    expect(r.sent.at(-1)?.message).toMatchObject({ type: "external-change", rev: "r9" });
    expect(r.sent.at(-1)?.text).toBe("por-fora");
    expect(r.bridge.rev()).toBe("r9");
  });

  test("rev igual não manda nada", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.bridge.resync();
    await r.tick();
    expect(r.types()).toEqual(["load"]);
  });

  test("antes do ready (waiting) é ignorado", async () => {
    const r = rig();
    r.bridge.resync();
    await r.tick();
    expect(r.sent).toHaveLength(0);
    expect(r.bridge.state()).toBe("waiting");
  });

  test("load que falhou antes: o resync refaz o load", async () => {
    const r = rig();
    r.file.broken = true;
    r.fromEditor(ready());
    await r.tick();
    expect(r.bridge.state()).toBe("failed");
    r.file.broken = false;
    r.bridge.resync();
    await r.tick();
    expect(r.types()).toEqual(["load"]);
    expect(r.bridge.state()).toBe("ready");
  });

  test("fechado, não faz nada", async () => {
    const r = rig();
    r.fromEditor(ready());
    await r.tick();
    r.bridge.close();
    r.file.rev = "r9";
    r.bridge.resync();
    await r.tick();
    expect(r.types()).toEqual(["load"]);
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

  test("settings e saveSettings falam com a rota do painel, não com a do nó; falha de leitura vira texto vazio", async () => {
    const c = client((call) => (call.method === "GET" ? { status: 200, body: { text: '{"a":1}' } } : { status: 200, body: { ok: true } }));
    expect(await c.api.settings()).toBe('{"a":1}');
    expect(await c.api.saveSettings('{"a":2}')).toEqual({ ok: true });
    expect(c.calls).toEqual([
      { url: "/api/canvas-cardinal/settings", method: "GET", body: undefined },
      { url: "/api/canvas-cardinal/settings", method: "PUT", body: { text: '{"a":2}' } },
    ]);
    const bad = client(() => ({ status: 500, body: { code: "cardinal_unreadable" } }));
    expect(await bad.api.settings()).toBe("");
    expect(await bad.api.saveSettings("{}")).toEqual({ ok: false, code: "cardinal_unreadable" });
    const down = client(() => new Error("rede"));
    expect(await down.api.settings()).toBe("");
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

describe("cardinal-bridge: cartão fechado", () => {
  const SVG = "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>";
  test("cardViewOf: em dia, defasado, indisponível, ausente e erro", () => {
    expect(cardViewOf(200, { svg: SVG, stale: false })).toEqual({ kind: "fresh", svg: SVG });
    expect(cardViewOf(200, { svg: SVG, stale: true })).toEqual({ kind: "stale", svg: SVG });
    expect(cardViewOf(503, { code: "cardinal_unavailable" })).toEqual({ kind: "unavailable", code: "cardinal_unavailable" });
    expect(cardViewOf(404, { code: "cardinal_not_found" }).kind).toBe("missing");
    expect(cardViewOf(200, { svg: "" }).kind).toBe("error");
    expect(cardViewOf(500, {}).kind).toBe("error");
  });
  test("cardThumb: a miniatura guardada vira URL de imagem, em dia ou defasada; sem ela, nada", () => {
    expect(cardThumb({ kind: "fresh", svg: "<svg/>" })).toBe(svgDataUrl("<svg/>"));
    expect(cardThumb({ kind: "stale", svg: "<svg/>" })).toBe(svgDataUrl("<svg/>"));
    for (const kind of ["loading", "unavailable", "missing", "error"] as const) expect(cardThumb({ kind, svg: "<svg/>" })).toBeUndefined();
    expect(cardThumb({ kind: "fresh" })).toBeUndefined();
    expect(cardThumb({ kind: "fresh", svg: "" })).toBeUndefined();
    expect(cardThumb(undefined)).toBeUndefined();
  });

  test("cardSummary: uma linha por estado, nada enquanto carrega", () => {
    expect(cardSummary(undefined)).toBeUndefined();
    expect(cardSummary({ kind: "loading" })).toBeUndefined();
    expect(cardSummary({ kind: "fresh", svg: SVG })).toBe("diagrama");
    expect(cardSummary({ kind: "stale", svg: SVG })).toBe("miniatura defasada");
    expect(cardSummary({ kind: "unavailable" })).toBe("indisponível (sem binário)");
    expect(cardSummary({ kind: "missing" })).toBe("arquivo não encontrado");
  });
  test("cardNotice: aviso de defasagem e de indisponível; em dia e sem razão não avisa", () => {
    expect(cardNotice({ kind: "fresh", svg: SVG })).toBeNull();
    expect(cardNotice({ kind: "stale", svg: SVG })).toContain("defasada");
    expect(cardNotice({ kind: "unavailable" }, { message: "binário do cardinal não encontrado" })).toContain("binário do cardinal não encontrado");
    expect(cardNotice({ kind: "fresh", svg: SVG }, { message: "extensão desligada" })).toContain("extensão desligada");
    expect(cardNotice(undefined)).toBe("Lendo o diagrama…");
  });
  test("canonicalText: o diagrama pedido, o primeiro na falta, undefined fora da forma", () => {
    const describe = { diagrams: [{ index: 0, text: "a" }, { index: 1, text: "b" }] };
    expect([canonicalText(describe), canonicalText(describe, 1), canonicalText(describe, 7)]).toEqual(["a", "b", "a"]);
    expect([canonicalText(null), canonicalText({}), canonicalText({ diagrams: [] })]).toEqual([undefined, undefined, undefined]);
  });
  test("svgDataUrl: data URL de imagem que dá a volta pelo SVG", () => {
    const url = svgDataUrl(SVG);
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.split(",").slice(1).join(","))).toBe(SVG);
  });

  const res = (status: number, body: unknown) => async () => ({ status, json: async () => body });
  test("cliente: view, text e openNative falam com as rotas do nó", async () => {
    const calls: string[] = [];
    const reply: Record<string, [number, unknown]> = {
      "GET /api/canvas-cardinal/default/c1/svg": [200, { svg: SVG, stale: true }],
      "GET /api/canvas-cardinal/default/c1/describe": [200, { describe: { diagrams: [{ index: 0, text: "model" }] } }],
      "POST /api/canvas-cardinal/default/c1/open": [503, { code: "cardinal_unavailable" }],
    };
    const client = createCardinalClient({
      canvasId: "default", nodeId: "c1",
      fetch: (url, init) => { calls.push(`${init.method} ${url}`); const [status, body] = reply[`${init.method} ${url}`] ?? [404, {}]; return res(status, body)(); },
    });
    expect(await client.view()).toEqual({ kind: "stale", svg: SVG });
    expect(await client.text()).toEqual({ ok: true, text: "model" });
    expect(await client.openNative()).toEqual({ ok: false, code: "cardinal_unavailable" });
    expect(calls).toHaveLength(3);
  });
  test("cliente: falha de rede vira código, view vira error", async () => {
    const client = createCardinalClient({ canvasId: "default", nodeId: "c1", fetch: async () => { throw new Error("off"); } });
    expect(await client.view()).toEqual({ kind: "error", code: "cardinal_network" });
    expect(await client.text()).toEqual({ ok: false, code: "cardinal_network" });
  });

  describe("store de miniaturas", () => {
    const setup = () => {
      const feed = createCardinalFeed();
      const loads: string[] = [];
      let next: Record<string, { kind: "fresh" | "stale"; svg: string }> = {};
      const store = createCardViewStore({ feed, load: async (id) => (loads.push(id), next[id] ?? { kind: "fresh" as const, svg: SVG }) });
      return { feed, loads, store, set: (v: typeof next) => { next = v; } };
    };
    const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

    test("track lê cada nó uma vez e avisa os assinantes", async () => {
      const { store, loads } = setup();
      let notices = 0;
      store.subscribe(() => notices++);
      store.track("default", [{ id: "c1", name: "pag" }]);
      store.track("default", [{ id: "c1", name: "pag" }]);
      await flush();
      expect(loads).toEqual(["c1"]);
      expect(store.get("c1")).toEqual({ kind: "fresh", svg: SVG });
      expect(notices).toBe(1);
    });
    test("aviso do SSE do arquivo (e o religar do stream) relê a miniatura", async () => {
      const { store, loads, feed, set } = setup();
      store.track("default", [{ id: "c1", name: "pag" }]);
      await flush();
      set({ c1: { kind: "stale", svg: SVG } });
      feed.publish({ name: "pag", rev: "r2", source: "disk" });
      await flush();
      expect(store.get("c1")?.kind).toBe("stale");
      feed.resync();
      await flush();
      expect(loads).toEqual(["c1", "c1", "c1"]);
    });
    test("nó que sai do documento é esquecido e deixa de reagir ao SSE; trocar de canvas limpa tudo", async () => {
      const { store, loads, feed } = setup();
      store.track("a", [{ id: "c1", name: "pag" }, { id: "c2", name: "est" }]);
      await flush();
      store.track("a", [{ id: "c2", name: "est" }]);
      expect(store.get("c1")).toBeUndefined();
      feed.publish({ name: "pag", rev: "r9", source: "disk" });
      await flush();
      expect(loads.filter((id) => id === "c1")).toHaveLength(1);
      store.track("b", []);
      expect(store.get("c2")).toBeUndefined();
    });
    test("leitura que rejeita vira error sem derrubar o store", async () => {
      const store = createCardViewStore({ feed: createCardinalFeed(), load: () => Promise.reject(new Error("boom")) });
      store.track("a", [{ id: "c1", name: "pag" }]);
      await flush();
      expect(store.get("c1")).toEqual({ kind: "error" });
    });
  });
});

describe("cardinal-bridge: desenho novo com o motor cardinal (U16)", () => {
  test("engineChoiceOf: só `effective: cardinal` vale cardinal; o resto vale hades; a razão acompanha", () => {
    expect(engineChoiceOf({ drawingEngine: { configured: "cardinal", effective: "cardinal", reason: null } })).toEqual({ effective: "cardinal", reason: null });
    expect(engineChoiceOf({ drawingEngine: { configured: "cardinal", effective: "hades", reason: { message: "sem binário" } } })).toEqual({ effective: "hades", reason: { message: "sem binário" } });
    for (const bad of [undefined, null, 3, {}, { drawingEngine: 1 }, { drawingEngine: { effective: "outro" } }]) expect(engineChoiceOf(bad).effective).toBe("hades");
  });

  test("freshDiagramName: pula os nomes tomados e desiste depois de 50 tentativas", () => {
    expect(freshDiagramName(new Set())).toBe("desenho");
    expect(freshDiagramName(new Set(["desenho", "desenho-2"]))).toBe("desenho-3");
    expect(freshDiagramName(new Set(["desenho", ...Array.from({ length: 49 }, (_, i) => `desenho-${i + 2}`)]))).toBeUndefined();
  });

  test("emptyDiagramText escapa aspas e barras do título", () => {
    expect(emptyDiagramText("Desenho")).toBe('model conceptual "Desenho"');
    expect(emptyDiagramText('a"b\\c')).toBe('model conceptual "a\\"b\\\\c"');
  });

  type Call = { url: string; method: string; body?: unknown };
  const seeded = (handler: (call: Call) => { status: number; body: unknown } | Error) => {
    const calls: Call[] = [];
    const fetch = async (url: string, init: { method: string; body?: string }) => {
      const call = { url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) };
      calls.push(call);
      const out = handler(call);
      if (out instanceof Error) throw out;
      return { status: out.status, json: async () => out.body };
    };
    return { fetch, calls };
  };

  test("prepareDiagram junta arquivos conhecidos (todas as páginas) e nós do documento e pede o texto ao binário", async () => {
    const s = seeded((call) => call.url.startsWith("/api/canvas-cardinal?")
      ? call.url.includes("after=") ? { status: 200, body: { files: [{ name: "desenho-2" }], next: null } } : { status: 200, body: { files: [{ name: "desenho" }], next: "desenho" } }
      : { status: 200, body: { ok: true, text: "{\"format\":\"cardinal\"}" } });
    const out = await prepareDiagram(s.fetch, ["desenho-3"], "Desenho");
    expect(out).toEqual({ ok: true, name: "desenho-4", text: '{"format":"cardinal"}' });
    expect(s.calls.map((c) => c.url)).toEqual(["/api/canvas-cardinal?limit=200", "/api/canvas-cardinal?limit=200&after=desenho", "/api/canvas-cardinal/convert"]);
    expect(s.calls[2]?.body).toEqual({ from: "text", text: 'model conceptual "Desenho"' });
  });

  test("prepareDiagram sem binário devolve o código da rota; rede caída e lista inválida têm código próprio", async () => {
    const noBinary = seeded((call) => call.url.startsWith("/api/canvas-cardinal?") ? { status: 200, body: { files: [], next: null } } : { status: 503, body: { code: "cardinal_unavailable" } });
    expect(await prepareDiagram(noBinary.fetch, [], "Desenho")).toEqual({ ok: false, code: "cardinal_unavailable" });
    expect(await prepareDiagram(seeded(() => new Error("rede")).fetch, [], "Desenho")).toEqual({ ok: false, code: "cardinal_network" });
    expect(await prepareDiagram(seeded(() => ({ status: 200, body: {} })).fetch, [], "Desenho")).toEqual({ ok: false, code: "cardinal_bad_response" });
  });
});
