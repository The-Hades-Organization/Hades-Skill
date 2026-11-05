/// <reference path="../../../kit/panel/ui/stream-logic.tsx" />
// Fluxo SSE do painel que solta a conexão com a aba escondida (stream-logic.tsx). Contrato: reference/panel.md §Armadilhas
// (Conexões do navegador).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import "../../../kit/panel/ui/stream-logic.tsx";

const PanelStreamFactory = (globalThis as unknown as { PanelStreamFactory: typeof makePanelStream }).PanelStreamFactory;
const UI = join(import.meta.dir, "../../../kit/panel/ui");

class FakeSource {
  readyState = 1;
  closed = false;
  handlers = new Map<string, Array<(ev: unknown) => void>>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  fire(type: string, ev: unknown = {}): void {
    for (const fn of this.handlers.get(type) ?? []) fn(ev);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

function harness(startHidden = false) {
  let hidden = startHidden;
  const created: FakeSource[] = [];
  const visibility = new Set<() => void>();
  const timers = new Map<number, () => void>();
  let seq = 0;
  const api = PanelStreamFactory({
    create: (url) => { const s = new FakeSource(url); created.push(s); return s; },
    hidden: () => hidden,
    onVisibility: (fn) => { visibility.add(fn); return () => visibility.delete(fn); },
    setTimer: (run) => { seq += 1; timers.set(seq, run); return seq; },
    clearTimer: (h) => { timers.delete(h as number); },
  });
  return {
    api, created, visibility, timers,
    setHidden(next: boolean) { hidden = next; for (const fn of [...visibility]) fn(); },
    runTimers() { const all = [...timers.values()]; timers.clear(); for (const run of all) run(); },
  };
}

describe("PanelStream", () => {
  test("dada a aba visível, quando abre, então conecta já e repassa os eventos aos ouvintes", () => {
    const h = harness();
    const stream = h.api.open("/api/canvas/stream");
    const got: string[] = [];
    stream.addEventListener("canvas", () => got.push("canvas"));
    stream.onopen = () => got.push("open");
    h.created[0]!.fire("open");
    h.created[0]!.fire("canvas");
    expect(h.created.map((s) => s.url)).toEqual(["/api/canvas/stream"]);
    expect(got).toEqual(["open", "canvas"]);
    expect(stream.readyState).toBe(1);
  });

  test("dada a aba escondida além da carência, então solta a conexão e conta como conectando", () => {
    const h = harness();
    const stream = h.api.open("/x");
    h.setHidden(true);
    expect(h.created[0]!.closed).toBe(false);
    h.runTimers();
    expect(h.created[0]!.closed).toBe(true);
    expect(stream.paused).toBe(true);
    expect(stream.readyState).toBe(0);
  });

  test("dada a aba que volta antes da carência, então a conexão fica e nada religa", () => {
    const h = harness();
    h.api.open("/x");
    h.setHidden(true);
    h.setHidden(false);
    expect(h.timers.size).toBe(0);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.closed).toBe(false);
  });

  test("dada a conexão solta, quando a aba volta, então religa com os mesmos ouvintes e propriedades", () => {
    const h = harness();
    const stream = h.api.open("/x");
    const got: string[] = [];
    stream.addEventListener("frame", () => got.push("frame"));
    stream.onopen = () => got.push("open");
    h.setHidden(true);
    h.runTimers();
    h.setHidden(false);
    expect(h.created).toHaveLength(2);
    h.created[1]!.fire("open");
    h.created[1]!.fire("frame");
    expect(got).toEqual(["open", "frame"]);
    expect(stream.paused).toBe(false);
  });

  test("dada a página aberta escondida, então só conecta quando a aba aparece", () => {
    const h = harness(true);
    const stream = h.api.open("/x");
    expect(h.created).toHaveLength(0);
    expect(stream.readyState).toBe(0);
    h.setHidden(false);
    expect(h.created).toHaveLength(1);
  });

  test("dado close, então fecha, para de ouvir a visibilidade e não religa", () => {
    const h = harness();
    const stream = h.api.open("/x");
    stream.close();
    expect(h.created[0]!.closed).toBe(true);
    expect(h.visibility.size).toBe(0);
    expect(stream.readyState).toBe(2);
    h.setHidden(false);
    expect(h.created).toHaveLength(1);
  });

  test("dado o onerror de propriedade, então o erro de conexão chega a ele", () => {
    const h = harness();
    const stream = h.api.open("/x");
    let errors = 0;
    stream.onerror = () => { errors += 1; };
    h.created[0]!.fire("error");
    expect(errors).toBe(1);
  });
});

describe("fiação na tela", () => {
  test("dado o index.html, então stream-logic carrega antes do app", () => {
    const html = readFileSync(join(UI, "index.html"), "utf8");
    expect(html.indexOf("/ui/stream-logic.js")).toBeGreaterThan(-1);
    expect(html.indexOf("/ui/stream-logic.js")).toBeLessThan(html.indexOf("/ui/app.js"));
  });

  test("dado o Argos e o terminal do herdr, então nenhum fluxo abre por new EventSource sem passar pelo PanelStream", () => {
    const files = ["pages/argos.tsx", "herdr-term.tsx"];
    for (const file of files) {
      const src = readFileSync(join(UI, file), "utf8");
      const bare = src.split("\n").filter((line) => line.includes("new EventSource(") && !line.includes("PanelStream"));
      expect({ file, bare }).toEqual({ file, bare: [] });
    }
    expect(readdirSync(UI)).toContain("stream-logic.tsx");
  });
});
