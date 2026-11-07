// Grupo canvas-absorb: `DocSaver.absorb` (reference/argos.md §Sincronia automática). O servidor andou por fora (CLI, outra aba,
// agente) e a aba tem edição na fila: a edição é reaplicada sobre a revisão nova sem esperar o 409 e nada que o usuário
// acabou de fazer se perde.
import { describe, expect, test } from "bun:test";
import type { CanvasDoc, CanvasNode } from "../../../src/lib/canvas-doc";
import { createDocSaver, PERMANENT_SAVE_ERRORS, type DocSaver, type SaveReply } from "../../../src/lib/canvas-store";

const node = (id: string, x = 0): CanvasNode => ({ id, type: "note", x, y: 0, w: 100, h: 50, z: 0, data: {}, locked: false, blurred: false });
const docOf = (rev: number, nodes: CanvasNode[]): CanvasDoc => ({ v: 1, rev, nodes, edges: [], groups: [] });
const ids = (doc: CanvasDoc): string[] => doc.nodes.map((n) => n.id).sort();
const xOf = (doc: CanvasDoc, id: string): number | undefined => doc.nodes.find((n) => n.id === id)?.x;

interface Rig {
  saver: DocSaver;
  sent: CanvasDoc[];
  timers: { run: () => void; ms: number; live: boolean }[];
  release(reply: SaveReply): void;
}

/** Gravador com envio controlado pelo teste: `hold` deixa o `put` em andamento até `release`. */
function rig(hold = false, failWith?: string): Rig {
  const sent: CanvasDoc[] = [];
  const timers: Rig["timers"] = [];
  let resolvePut: ((reply: SaveReply) => void) | undefined;
  const saver = createDocSaver({
    put: (doc) => {
      sent.push(doc);
      if (failWith !== undefined) return Promise.resolve({ kind: "failed", code: failWith });
      if (!hold) return Promise.resolve({ kind: "saved", rev: doc.rev + 1 });
      return new Promise<SaveReply>((resolve) => { resolvePut = resolve; });
    },
    setTimer: (run, ms) => {
      timers.push({ run, ms, live: true });
      return timers.length - 1;
    },
    clearTimer: (handle) => {
      const t = timers[handle as number];
      if (t) t.live = false;
    },
    onStatus: () => {},
    onStale: () => {},
  });
  return { saver, sent, timers, release: (reply) => resolvePut?.(reply) };
}

describe("canvas-absorb: servidor andou com edição na fila", () => {
  test("dado edição de um nó na fila e nó novo no servidor, então o resultado tem os dois e a revisão é a do servidor", () => {
    const { saver, timers } = rig();
    const base = docOf(1, [node("a")]);
    saver.setRev(1, base);
    saver.schedule(docOf(1, [node("a", 40)]));
    const merged = saver.absorb(docOf(2, [node("a"), node("b")]));
    expect(merged).toBeDefined();
    expect(ids(merged!)).toEqual(["a", "b"]);
    expect(xOf(merged!, "a")).toBe(40);
    expect(merged!.rev).toBe(2);
    expect(timers.filter((t) => t.live)).toHaveLength(1);
  });

  test("dado absorb, então o envio seguinte sai com a revisão nova e o documento mesclado, sem 409", async () => {
    const { saver, sent } = rig();
    saver.setRev(1, docOf(1, [node("a")]));
    saver.schedule(docOf(1, [node("a", 40)]));
    saver.absorb(docOf(2, [node("a"), node("b")]));
    await saver.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.rev).toBe(2);
    expect(ids(sent[0]!)).toEqual(["a", "b"]);
    expect(xOf(sent[0]!, "a")).toBe(40);
  });

  test("dado o servidor ter apagado o nó que a aba não mexeu, então ele some; o que a aba mexeu continua", () => {
    const { saver } = rig();
    saver.setRev(1, docOf(1, [node("a"), node("b"), node("c")]));
    saver.schedule(docOf(1, [node("a"), node("b", 90), node("c")]));
    const merged = saver.absorb(docOf(2, [node("b"), node("c")]));
    expect(ids(merged!)).toEqual(["b", "c"]);
    expect(xOf(merged!, "b")).toBe(90);
  });

  test("dado dois absorb seguidos, então a edição na fila sobrevive aos dois", () => {
    const { saver } = rig();
    saver.setRev(1, docOf(1, [node("a")]));
    saver.schedule(docOf(1, [node("a", 40)]));
    saver.absorb(docOf(2, [node("a"), node("b")]));
    const merged = saver.absorb(docOf(3, [node("a"), node("b"), node("c")]));
    expect(ids(merged!)).toEqual(["a", "b", "c"]);
    expect(xOf(merged!, "a")).toBe(40);
    expect(merged!.rev).toBe(3);
  });

  test("dado recusa permanente (sem nova tentativa agendada), então absorb rearma o envio com a edição mesclada", async () => {
    const permanent = [...PERMANENT_SAVE_ERRORS][0]!;
    const { saver, timers } = rig(false, permanent);
    saver.setRev(1, docOf(1, [node("a")]));
    saver.schedule(docOf(1, [node("a", 40)]));
    await saver.flush();
    expect(timers.filter((t) => t.live)).toHaveLength(0);
    const merged = saver.absorb(docOf(2, [node("a"), node("b")]));
    expect(ids(merged!)).toEqual(["a", "b"]);
    expect(timers.filter((t) => t.live)).toHaveLength(1);
  });
});

describe("canvas-absorb: limites", () => {
  test("dado nenhuma edição na fila, então devolve o documento do servidor e adota a revisão", async () => {
    const { saver, sent } = rig();
    saver.setRev(1, docOf(1, [node("a")]));
    const theirs = docOf(4, [node("a"), node("z")]);
    expect(saver.absorb(theirs)).toBe(theirs);
    saver.schedule(docOf(4, [node("a", 5), node("z")]));
    await saver.flush();
    expect(sent[0]!.rev).toBe(4);
  });

  test("dado revisão igual ou mais antiga que a da aba, então devolve undefined e não mexe na fila", () => {
    const { saver, timers } = rig();
    saver.setRev(5, docOf(5, [node("a")]));
    saver.schedule(docOf(5, [node("a", 40)]));
    const armed = timers.length;
    expect(saver.absorb(docOf(5, [node("a"), node("b")]))).toBeUndefined();
    expect(saver.absorb(docOf(3, [node("b")]))).toBeUndefined();
    expect(timers).toHaveLength(armed);
  });

  test("dado envio em andamento, então devolve undefined e o 409 dele reconcilia pelo caminho de sempre", async () => {
    const r = rig(true);
    r.saver.setRev(1, docOf(1, [node("a")]));
    r.saver.schedule(docOf(1, [node("a", 40)]));
    const draining = r.saver.flush();
    expect(r.sent).toHaveLength(1);
    expect(r.saver.absorb(docOf(2, [node("a"), node("b")]))).toBeUndefined();
    r.release({ kind: "saved", rev: 2 });
    await draining;
  });

  test("dado gravador descartado, então devolve undefined", () => {
    const { saver } = rig();
    saver.setRev(1, docOf(1, [node("a")]));
    saver.dispose();
    expect(saver.absorb(docOf(2, [node("a")]))).toBeUndefined();
  });
});
