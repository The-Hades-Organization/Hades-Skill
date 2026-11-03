// Grupo canvas-releitura: mudança do canvas feita por fora da página chega à tela sem reload (reference/argos.md §Releitura do
// documento). Três peças: o empurrão do servidor (stream SSE com `{ id, rev }` a cada gravação), a regra da releitura na
// página (createCanvasWatch: relê, pula com motivo, avisa) e o gravador, que volta a `idle` depois de um 409.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CANVAS_UI_BUNDLE, createCanvasModuleBundler, createUiTranspiler } from "../../../src/panel/ui-transpile";
import { readCanvasDoc, type CanvasDoc, type CanvasNode } from "../../../src/lib/canvas-doc";
import { createDocSaver, type SaveReply, type SaveStatus } from "../../../src/lib/canvas-store";
import { createCanvasRoutes } from "../../../src/panel/canvas";
import { createCanvasHub } from "../../../src/panel/canvas-stream";

type Dict = Record<string, any>;
const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
const T = mkdtempSync(join(tmpdir(), "hades-canvas-sync-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const node = (id: string): CanvasNode => ({ id, type: "note", x: 0, y: 0, w: 100, h: 50, z: 0, data: {}, locked: false, blurred: false });
const docOf = (rev: number, nodes: CanvasNode[]): CanvasDoc => ({ v: 1, rev, nodes, edges: [], groups: [] });

let loaded: Promise<Dict> | null = null;
function load(): Promise<Dict> {
  loaded ??= (async () => {
    const mod: { exports: any } = { exports: {} };
    new Function("exports", "module", readFileSync(join(uiDir, "vendor/react.js"), "utf8"))(mod.exports, mod);
    const React = mod.exports;
    const bundle = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const holder: Dict = {};
    new Function("globalThis", bundle as string)(holder);
    const stub = (tag: string) => (p: object) => React.createElement(tag, p);
    const HadesCore = {
      useState: (v: unknown) => [v, () => undefined], useEffect: () => undefined, useRef: (v: unknown) => ({ current: v }), useCallback: (fn: unknown) => fn,
      useMemo: (fn: () => unknown) => fn(), cn: (...a: unknown[]) => a.filter(Boolean).join(" "), I: new Proxy({}, { get: () => stub("svg") }),
      post: () => Promise.reject(new Error("sem rede")), getJSON: () => Promise.reject(new Error("sem rede")),
      Button: stub("button"), Dot: stub("span"), Mono: stub("span"), Tip: stub("span"), Empty: stub("div"), useApp: () => ({}),
    };
    const scope: Dict = { CanvasModel: holder.CanvasModel };
    new Function("globalThis", "window", "React", "HadesCore", createUiTranspiler().transpile(join(uiDir, "argos/node-terminal.tsx")))(scope, scope, React, HadesCore);
    return scope;
  })();
  return loaded;
}

/** Lê do corpo do stream até aparecer `text` (ou desiste). */
async function readUntil(res: Response, text: string): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  reader.releaseLock();
  return seen;
}

describe("canvas-releitura: empurrão do servidor", () => {
  test("dado um stream aberto, quando o documento é gravado, então chega { id, rev } da gravação", async () => {
    const hub = createCanvasHub();
    const dir = join(T, "push");
    mkdirSync(dir, { recursive: true });
    const routes = createCanvasRoutes(dir, undefined, { onWrite: (id, rev) => hub.publishCanvas(id, rev) });
    const abort = new AbortController();
    const res = hub.open(new Request("http://127.0.0.1/api/canvas/stream", { signal: abort.signal }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const put = await routes.put(new Request("http://127.0.0.1/api/canvas", { method: "PUT", body: JSON.stringify(docOf(0, [node("a")])) }), { remote: false });
    expect(put.status).toBe(200);
    const seen = await readUntil(res, "event: canvas");
    expect(seen).toContain('event: canvas\ndata: {"id":"default","rev":1}\n\n');
    abort.abort();
    hub.close();
  });

  test("dado gravação recusada (409), então nada é empurrado", async () => {
    const pushed: [string, number][] = [];
    const dir = join(T, "refused");
    mkdirSync(dir, { recursive: true });
    const routes = createCanvasRoutes(dir, undefined, { onWrite: (id, rev) => pushed.push([id, rev]) });
    const send = (rev: number) => routes.put(new Request("http://127.0.0.1/api/canvas", { method: "PUT", body: JSON.stringify(docOf(rev, [])) }), { remote: false });
    expect((await send(0)).status).toBe(200);
    expect((await send(0)).status).toBe(409);
    expect(pushed).toEqual([["default", 1]]);
  });

  test("dado o registro de terminais mudou, então o stream avisa `registry` (o grafo e os órfãos se releem)", async () => {
    const hub = createCanvasHub();
    const abort = new AbortController();
    const res = hub.open(new Request("http://127.0.0.1/api/canvas/stream", { signal: abort.signal }));
    hub.publishRegistry();
    expect(await readUntil(res, "event: registry")).toContain("event: registry\ndata: {}\n\n");
    abort.abort();
    hub.close();
  });

  test("dado o teto de streams, então o excedente recebe 429 com Retry-After", () => {
    const hub = createCanvasHub({ maxStreams: 1 });
    const abort = new AbortController();
    hub.open(new Request("http://127.0.0.1/api/canvas/stream", { signal: abort.signal }));
    const second = hub.open(new Request("http://127.0.0.1/api/canvas/stream"));
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).not.toBeNull();
    abort.abort();
    hub.close();
  });
});

describe("canvas-releitura: regra da releitura na página (createCanvasWatch)", () => {
  function watchOf(NT: Dict, state: { busy: string | null; at: number }) {
    const log: string[] = [];
    const stale: boolean[] = [];
    let reloads = 0;
    // a página, ao reler, entrega a revisão lida ao `loaded` (loadCanvas)
    const watch: Dict = NT.createCanvasWatch({
      now: () => state.at, busy: () => state.busy, log: (r: string) => log.push(r), onStale: (on: boolean) => stale.push(on),
      reload: async () => { reloads += 1; watch.loaded(100 + reloads); return true; },
    });
    return { watch, log, stale, reloads: () => reloads };
  }

  test("dado escrita externa e gravador ocioso, quando o servidor avisa a revisão, então relê", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const { watch, reloads } = watchOf(NT, { busy: null, at: 0 });
    watch.loaded(4);
    const out = await watch.observe({ serverRev: 5, hidden: false });
    expect(out.reloaded).toBe(true);
    expect(reloads()).toBe(1);
  });

  test("dado edição na fila, quando o servidor avisa, então não relê, avisa depois de N s e relê quando o envio termina", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const state = { busy: "fila" as string | null, at: 0 };
    const { watch, log, stale, reloads } = watchOf(NT, state);
    watch.loaded(4);
    expect((await watch.observe({ serverRev: 5, hidden: false })).reason).toBe("busy: fila");
    expect(stale).toEqual([]);
    state.at = NT.EXTERNAL_STALE_MS + 1;
    await watch.observe({ serverRev: 5, hidden: false });
    expect(stale).toEqual([true]);
    expect(reloads()).toBe(0);
    state.busy = null;
    await watch.settled({ hidden: false });
    expect(reloads()).toBe(1);
    expect(log).toEqual(["busy: fila"]);
  });

  test("dado a releitura que entrou, então o aviso 'o canvas mudou por fora' some", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const state = { busy: "error" as string | null, at: 0 };
    const { watch, stale } = watchOf(NT, state);
    watch.loaded(1);
    await watch.observe({ serverRev: 2, hidden: false });
    state.at = NT.EXTERNAL_STALE_MS;
    await watch.observe({ serverRev: 2, hidden: false });
    state.busy = null;
    await watch.settled({ hidden: false });
    expect(stale).toEqual([true, false]);
  });

  test("dado aba escondida, revisão igual ou revisão inválida, então pula e registra o motivo uma vez", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const { watch, log, reloads } = watchOf(NT, { busy: null, at: 0 });
    watch.loaded(3);
    await watch.observe({ serverRev: 3, hidden: false });
    await watch.observe({ serverRev: 3, hidden: false });
    await watch.observe({ serverRev: 4, hidden: true });
    await watch.observe({ serverRev: "5", hidden: false });
    expect(log).toEqual(["rev igual", "hidden", "rev inválida"]);
    expect(reloads()).toBe(0);
  });

  test("dado o eco da própria gravação chegando antes da resposta do PUT, então não relê a tela que acabou de gravar", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const state = { busy: "saving" as string | null, at: 0 };
    const { watch, reloads } = watchOf(NT, state);
    watch.loaded(5);
    await watch.observe({ serverRev: 6, hidden: false });
    watch.saved(6);
    state.busy = null;
    await watch.settled({ hidden: false });
    expect(reloads()).toBe(0);
  });

  test("dado conflito fundido com edição na fila (a tela não recebeu o servidor), então a revisão da gravação não conta e relê depois do envio", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const state = { busy: "saving" as string | null, at: 0 };
    const { watch, reloads } = watchOf(NT, state);
    watch.loaded(5);
    watch.diverged();
    watch.saved(7);
    state.busy = null;
    await watch.settled({ hidden: false });
    expect(reloads()).toBe(1);
  });

  test("dado a releitura descartada (edição entrou durante a leitura), então segue atrasada e tenta no próximo ocioso", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    let applied = false;
    const watch = NT.createCanvasWatch({ now: () => 0, busy: () => null, log: () => undefined, onStale: () => undefined, reload: async () => applied });
    watch.loaded(1);
    expect((await watch.observe({ serverRev: 2, hidden: false })).reloaded).toBe(false);
    applied = true;
    expect((await watch.settled({ hidden: false })).reloaded).toBe(true);
  });
});

describe("canvas-releitura: gravador depois de um 409", () => {
  function saverOver(routes: ReturnType<typeof createCanvasRoutes>, opts: { failFetch?: number } = {}) {
    const statuses: SaveStatus[] = [];
    const timers: (() => void)[] = [];
    let failures = opts.failFetch ?? 0;
    const saver = createDocSaver({
      put: async (doc): Promise<SaveReply> => {
        const res = await routes.put(new Request("http://127.0.0.1/api/canvas", { method: "PUT", body: JSON.stringify(doc) }), { remote: false });
        const body = (await res.json()) as { rev: number };
        return res.ok ? { kind: "saved", rev: body.rev } : res.status === 409 ? { kind: "stale", rev: body.rev } : { kind: "failed", code: "x" };
      },
      setTimer: (run) => { timers.push(run); return timers.length; }, clearTimer: () => undefined,
      onStatus: (s) => statuses.push(s), onStale: () => undefined,
      fetchServer: async () => { if (failures-- > 0) throw new Error("sem rede"); return readCanvasDoc(await routes.get().json()); },
    });
    return { saver, statuses, timers };
  }
  const routesIn = (name: string) => { const dir = join(T, name); mkdirSync(dir, { recursive: true }); return createCanvasRoutes(dir); };
  const put = (routes: ReturnType<typeof createCanvasRoutes>, doc: CanvasDoc) => routes.put(new Request("http://127.0.0.1/api/canvas", { method: "PUT", body: JSON.stringify(doc) }), { remote: false });

  test("dado escrita externa antes do envio, quando o servidor recusa com 409, então o gravador reconcilia e termina em idle", async () => {
    const routes = routesIn("idle-after-409");
    const { saver, statuses } = saverOver(routes);
    saver.setRev(0, docOf(0, []));
    await put(routes, docOf(0, [node("externo")]));
    saver.schedule(docOf(0, [node("meu")]));
    await saver.flush();
    expect(statuses.at(-1)).toEqual({ kind: "idle" });
    expect(readCanvasDoc(await routes.get().json()).nodes.map((n) => n.id).sort()).toEqual(["externo", "meu"]);
  });

  test("dado 409 e a releitura do servidor falhando, então vira erro com nova tentativa e volta a idle quando ela passa", async () => {
    const routes = routesIn("idle-after-failed-fetch");
    const { saver, statuses, timers } = saverOver(routes, { failFetch: 1 });
    saver.setRev(0, docOf(0, []));
    await put(routes, docOf(0, [node("externo")]));
    saver.schedule(docOf(0, [node("meu")]));
    await saver.flush();
    expect(statuses.at(-1)).toMatchObject({ kind: "error" });
    timers.at(-1)?.();
    await saver.flush();
    expect(statuses.at(-1)).toEqual({ kind: "idle" });
  });
});
