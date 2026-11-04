// Estado do canvas da página (src/lib/canvas-store.ts): gesto e pilha, vista filtrada, câmera de abertura e gravador com
// espera e revisão. Temporizador e envio entram por injeção: nada de relógio nem rede.
import { describe, expect, test } from "bun:test";
import { emptyCanvasDoc, type CanvasDoc, type CanvasNode } from "../../../src/lib/canvas-doc.ts";
import { opMove } from "../../../src/lib/canvas-history.ts";
import { FREE_LAYOUT } from "../../../src/lib/canvas-layout.ts";
import {
  CANVAS_STORE_ERRORS, CANVAS_STORE_LIMITS, freshCanvasId, isValidCanvasId, requireCanvasId, requireCanvasName,
  requireCanvasScope, sameScope, scopedCanvasId, scopedCanvasName, slugify,
  commitGesture, createDocSaver, createSaveMeta, firstCamera, GRAPH_EDGE_PREFIX, initialCanvasState, primarySelection, projectView, READABLE_ZOOM, reconcileGraph,
  stepHistory, visibleSelection, type SaveReply, type SaveStatus,
} from "../../../src/lib/canvas-store.ts";

const SIZE = { w: 200, h: 66 };
const node = (id: string, x: number, y: number): CanvasNode => ({ id, type: id.split(":")[0] as string, x, y, ...SIZE, z: 0, data: {}, locked: false, blurred: false });
const docOf = (nodes: CanvasNode[]): CanvasDoc => ({ ...emptyCanvasDoc(), rev: 3, nodes });
const at = (doc: CanvasDoc, id: string): CanvasNode => doc.nodes.find((n) => n.id === id) as CanvasNode;

describe("estado: gesto e pilha", () => {
  const start = () => initialCanvasState(docOf([node("agent:a", 0, 0), node("agent:b", 400, 0)]));

  test("dado um gesto de mover, então o documento muda e o passo vai para a pilha", () => {
    const s0 = start();
    const s1 = commitGesture(s0, opMove(s0.doc, "agent:a", { x: 50, y: 20 }));
    expect([at(s1.doc, "agent:a").x, at(s1.doc, "agent:a").y]).toEqual([50, 20]);
    expect(s1.history.past).toHaveLength(1);
  });

  test("dado desfazer e refazer, então a posição vai e volta", () => {
    const s0 = start();
    const s1 = commitGesture(s0, opMove(s0.doc, "agent:a", { x: 50, y: 20 }));
    const back = stepHistory(s1, "undo");
    expect(at(back?.doc as CanvasDoc, "agent:a").x).toBe(0);
    const again = stepHistory(back as NonNullable<typeof back>, "redo");
    expect(at(again?.doc as CanvasDoc, "agent:a").x).toBe(50);
  });

  test("dado pilha vazia, então desfazer e refazer devolvem undefined", () => {
    expect(stepHistory(start(), "undo")).toBeUndefined();
    expect(stepHistory(start(), "redo")).toBeUndefined();
  });

  test("dado passo que aponta para nó que saiu do grafo, então é descartado e o anterior ainda se desfaz", () => {
    const s0 = start();
    const s1 = commitGesture(s0, opMove(s0.doc, "agent:b", { x: 410, y: 0 }));
    const s2 = commitGesture(s1, opMove(s1.doc, "agent:a", { x: 50, y: 0 }));
    const gone = reconcileGraph(s2, { nodes: [{ id: "agent:a", type: "agent" }], edges: [] }, { layout: FREE_LAYOUT, sizeOf: () => SIZE });
    expect(gone.removed).toEqual(["agent:b"]);
    const undone = stepHistory(gone.state, "undo");
    expect(at(undone?.doc as CanvasDoc, "agent:a").x).toBe(0);
    expect(stepHistory(undone as NonNullable<typeof undone>, "undo")).toBeUndefined();
  });

  test("dado grafo igual ao documento, então reconciliar não muda nem a pilha nem o objeto", () => {
    const s0 = start();
    const r = reconcileGraph(s0, { nodes: [{ id: "agent:a", type: "agent" }, { id: "agent:b", type: "agent" }], edges: [] }, { layout: FREE_LAYOUT, sizeOf: () => SIZE });
    expect(r.changed).toBe(false);
    expect(r.state).toBe(s0);
  });
});

describe("estado: vista filtrada", () => {
  const doc = docOf([node("agent:a", 0, 0), node("agent:b", 300, 0), node("pr:1", 600, 0)]);

  test("dado filtro, então só os visíveis vão ao motor e o documento guarda todos", () => {
    const view = projectView(doc, new Set(["agent:a", "pr:1"]), []);
    expect(view.nodes.map((n) => n.id)).toEqual(["agent:a", "pr:1"]);
    expect(doc.nodes).toHaveLength(3);
  });

  test("dado aresta do grafo com as duas pontas visíveis, então entra na vista com prefixo e sem repetir", () => {
    const edge = { from: "agent:a", to: "pr:1", kind: "agent_pr" };
    const view = projectView(doc, new Set(["agent:a", "pr:1"]), [edge, edge, { from: "agent:a", to: "agent:b", kind: "stack" }]);
    expect(view.edges.map((e) => e.id)).toEqual([`${GRAPH_EDGE_PREFIX}agent_pr:agent:a:pr:1`]);
    expect(doc.edges).toEqual([]);
  });

  test("dado seleção, então o painel só vale com exatamente um nó e a seleção visível preserva a ordem", () => {
    expect(primarySelection([])).toBeNull();
    expect(primarySelection(["a"])).toBe("a");
    expect(primarySelection(["a", "b"])).toBeNull();
    const visible = new Set(["a", "c"]);
    const same = ["a", "c"];
    expect(visibleSelection(same, visible)).toBe(same);
    expect(visibleSelection(["c", "b", "a"], visible)).toEqual(["c", "a"]);
  });
});

describe("estado: câmera de abertura", () => {
  const view = { w: 1000, h: 700 };

  test("dado nada ou área zerada, então undefined (o motor enquadra sozinho)", () => {
    expect(firstCamera([], view)).toBeUndefined();
    expect(firstCamera([node("a", 0, 0)], { w: 0, h: 700 })).toBeUndefined();
  });

  test("dado poucos nós, então tudo à vista", () => {
    const cam = firstCamera([node("a", 0, 0), node("b", 300, 0)], view);
    expect(cam?.k).toBeGreaterThanOrEqual(READABLE_ZOOM);
  });

  test("dado grafo enorme, então a escala é a legível, nunca menor", () => {
    const many = Array.from({ length: 400 }, (_, i) => node(`a:${i}`, (i % 20) * 300, Math.floor(i / 20) * 120));
    expect(firstCamera(many, view)?.k).toBe(READABLE_ZOOM);
  });
});

describe("gravador", () => {
  const doc = (n: number): CanvasDoc => docOf([node("agent:a", n, 0)]);
  function rig(replies: SaveReply[] | ((d: CanvasDoc) => SaveReply)) {
    const sent: { rev: number; x: number; leaving: boolean }[] = [];
    const statuses: SaveStatus[] = [];
    const stale: number[] = [];
    const timers = new Map<number, { run: () => void; ms: number }>();
    let next = 0;
    const queue = Array.isArray(replies) ? [...replies] : undefined;
    const saver = createDocSaver({
      put: async (d, { leaving }) => {
        sent.push({ rev: d.rev, x: (d.nodes[0] as CanvasNode).x, leaving });
        return queue ? (queue.shift() as SaveReply) : (replies as (d: CanvasDoc) => SaveReply)(d);
      },
      setTimer: (run, ms) => { timers.set(++next, { run, ms }); return next; },
      clearTimer: (h) => { timers.delete(h as number); },
      onStatus: (s) => statuses.push(s),
      onStale: (rev) => stale.push(rev),
    });
    const fire = async (): Promise<void> => { const [id, t] = [...timers][0] as [number, { run: () => void }]; timers.delete(id); t.run(); await saver.flush(); };
    return { saver, sent, statuses, stale, timers, fire };
  }

  test("dado vários agendamentos seguidos, então um envio só, com o último documento e a revisão lida", async () => {
    const r = rig([{ kind: "saved", rev: 4 }]);
    r.saver.setRev(3);
    r.saver.schedule(doc(1)); r.saver.schedule(doc(2)); r.saver.schedule(doc(3));
    expect(r.timers.size).toBe(1);
    expect([...r.timers.values()][0]?.ms).toBe(600);
    await r.fire();
    expect(r.sent).toEqual([{ rev: 3, x: 3, leaving: false }]);
    expect(r.statuses.at(-1)).toEqual({ kind: "idle" });
  });

  test("dado gravação concluída, então o envio seguinte leva a revisão nova", async () => {
    const r = rig([{ kind: "saved", rev: 4 }, { kind: "saved", rev: 5 }]);
    r.saver.setRev(3);
    r.saver.schedule(doc(1)); await r.fire();
    r.saver.schedule(doc(2)); await r.fire();
    expect(r.sent.map((s) => s.rev)).toEqual([3, 4]);
  });

  test("dado 409, então chama onStale com a revisão do servidor e não reenvia", async () => {
    const r = rig([{ kind: "stale", rev: 9 }]);
    r.saver.schedule(doc(1)); await r.fire();
    expect(r.stale).toEqual([9]);
    expect(r.sent).toHaveLength(1);
    expect(r.timers.size).toBe(0);
  });

  test("dado falha, então o estado é erro com o código e há nova tentativa em 5 s com o mesmo documento", async () => {
    const r = rig([{ kind: "failed", code: "canvas_unreadable" }, { kind: "saved", rev: 4 }]);
    r.saver.schedule(doc(7)); await r.fire();
    expect(r.statuses.at(-1)).toEqual({ kind: "error", code: "canvas_unreadable" });
    expect([...r.timers.values()].map((t) => t.ms)).toEqual([5000]);
    await r.fire();
    expect(r.sent.map((s) => s.x)).toEqual([7, 7]);
    expect(r.statuses.at(-1)).toEqual({ kind: "idle" });
  });

  test("dado put que lança, então vira falha com código estável e nova tentativa", async () => {
    const r = rig(() => { throw new Error("rede"); });
    r.saver.schedule(doc(1)); await r.fire();
    expect(r.statuses.at(-1)).toEqual({ kind: "error", code: "canvas_save_unreachable" });
    expect(r.timers.size).toBe(1);
  });

  test("dado flush ao sair, então envia já, sem esperar o temporizador, marcado como saída", async () => {
    const r = rig([{ kind: "saved", rev: 4 }]);
    r.saver.schedule(doc(1));
    await r.saver.flush({ leaving: true });
    expect(r.sent).toEqual([{ rev: 0, x: 1, leaving: true }]);
    expect(r.timers.size).toBe(0);
  });

  test("dado dispose, então o que estava na fila não é enviado e o temporizador some", async () => {
    const r = rig([{ kind: "saved", rev: 4 }]);
    r.saver.schedule(doc(1));
    r.saver.dispose();
    expect(r.timers.size).toBe(0);
    r.saver.schedule(doc(2));
    await r.saver.flush();
    expect(r.sent).toHaveLength(0);
  });
});

describe("vários canvases: id e nome", () => {
  test("dado ids dentro da lista fechada, então valem", () => {
    for (const id of ["default", "a", "meu-mapa", "mapa_2", "0abc", "a".repeat(CANVAS_STORE_LIMITS.idChars)]) expect(isValidCanvasId(id)).toBe(true);
  });

  test.each(["", "..", "../x", "a/b", "a\\b", ".oculto", "-x", "_x", "Maiuscula", "a b", "a.json", "a%2e%2e", "ação", "a".repeat(CANVAS_STORE_LIMITS.idChars + 1)])(
    "dado o id %j, então é recusado com canvas_invalid_id",
    (id) => {
      expect(isValidCanvasId(id)).toBe(false);
      expect(() => requireCanvasId(id)).toThrow(expect.objectContaining({ code: CANVAS_STORE_ERRORS.invalidId }));
    },
  );

  test("dado id que não é texto, então é recusado", () => {
    for (const id of [undefined, null, 1, {}, []]) expect(isValidCanvasId(id)).toBe(false);
  });

  test("dado nome com espaços nas pontas, então volta aparado", () => {
    expect(requireCanvasName("  Meu mapa ")).toBe("Meu mapa");
  });

  test.each(["", "   ", "a\nb", "a\u0000b", "x".repeat(CANVAS_STORE_LIMITS.nameChars + 1), 5, undefined])("dado o nome %j, então canvas_invalid_name", (name) => {
    expect(() => requireCanvasName(name)).toThrow(expect.objectContaining({ code: CANVAS_STORE_ERRORS.invalidName }));
  });

  test("dado nome com acento e símbolo, então o id derivado fica na lista fechada", () => {
    expect(freshCanvasId("Açaí & Cia!", new Set())).toBe("acai-cia");
    expect(isValidCanvasId(freshCanvasId("!!!", new Set()))).toBe(true);
  });

  test("dado id tomado ou reservado, então o derivado ganha sufixo", () => {
    expect(freshCanvasId("Mapa", new Set(["mapa"]))).toBe("mapa-2");
    expect(freshCanvasId("Mapa", new Set(["mapa", "mapa-2"]))).toBe("mapa-3");
    expect(freshCanvasId("Default", new Set())).toBe("default-2");
  });

  test("dado nome enorme, então o id derivado cabe no limite", () => {
    const id = freshCanvasId("a".repeat(500), new Set());
    expect(id.length).toBeLessThanOrEqual(CANVAS_STORE_LIMITS.idChars);
    expect(isValidCanvasId(freshCanvasId("a".repeat(500), new Set([id])))).toBe(true);
  });
});

describe("canvas por escopo: chave, id e nome", () => {
  test("dado worktree e rodada, então o id é determinístico, válido e com o prefixo do tipo", () => {
    const wt = scopedCanvasId({ kind: "worktree", key: "p-org" });
    expect(wt).toBe(scopedCanvasId({ kind: "worktree", key: "p-org" }));
    expect(wt).toMatch(/^wt-p-org-[0-9a-f]{14}$/);
    expect(scopedCanvasId({ kind: "round", key: "p4" })).toMatch(/^rd-p4-[0-9a-f]{14}$/);
    expect(isValidCanvasId(wt)).toBe(true);
  });

  test("dado o mesmo texto em tipos diferentes, ou chaves que só diferem em caixa ou símbolo, então os ids diferem", () => {
    const ids = [
      scopedCanvasId({ kind: "worktree", key: "p4" }),
      scopedCanvasId({ kind: "round", key: "p4" }),
      scopedCanvasId({ kind: "worktree", key: "P4" }),
      scopedCanvasId({ kind: "worktree", key: "p/4" }),
      scopedCanvasId({ kind: "worktree", key: "p.4" }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("dado chave só com símbolos, acento ou 128 caracteres, então o id continua na lista fechada e no limite", () => {
    for (const key of ["!!!", "ação/é", "x".repeat(CANVAS_STORE_LIMITS.scopeKeyChars), "../../etc/passwd", "a b c"]) {
      const id = scopedCanvasId({ kind: "worktree", key });
      expect(isValidCanvasId(id)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(CANVAS_STORE_LIMITS.idChars);
      expect(id).not.toContain("..");
    }
  });

  test("dado chave com espaços nas pontas, então é aparada e dá o mesmo id", () => {
    expect(requireCanvasScope({ kind: "round", key: "  p4 " })).toEqual({ kind: "round", key: "p4" });
    expect(scopedCanvasId({ kind: "round", key: "  p4 " })).toBe(scopedCanvasId({ kind: "round", key: "p4" }));
  });

  test.each([
    ["sem corpo", undefined],
    ["lista", []],
    ["tipo desconhecido", { kind: "repo", key: "x" }],
    ["sem tipo", { key: "x" }],
    ["chave vazia", { kind: "worktree", key: "" }],
    ["chave em branco", { kind: "worktree", key: "   " }],
    ["chave que não é texto", { kind: "worktree", key: 5 }],
    ["chave com controle", { kind: "worktree", key: "a\nb" }],
    ["chave acima do limite", { kind: "worktree", key: "x".repeat(CANVAS_STORE_LIMITS.scopeKeyChars + 1) }],
  ])("dado escopo inválido (%s), então canvas_invalid_scope", (_, raw) => {
    expect(() => requireCanvasScope(raw)).toThrow(expect.objectContaining({ code: CANVAS_STORE_ERRORS.invalidScope }));
    expect(() => scopedCanvasId(raw as never)).toThrow(expect.objectContaining({ code: CANVAS_STORE_ERRORS.invalidScope }));
  });

  test("dado chave no limite, então o nome padrão cabe no limite de nome", () => {
    const name = scopedCanvasName({ kind: "worktree", key: "x".repeat(CANVAS_STORE_LIMITS.scopeKeyChars) });
    expect(requireCanvasName(name)).toBe(name);
    expect(scopedCanvasName({ kind: "round", key: "p4" })).toBe("Rodada: p4");
    expect(scopedCanvasName({ kind: "worktree", key: "p-org" })).toBe("Worktree: p-org");
  });

  test("dado dois escopos, então sameScope compara tipo e chave", () => {
    expect(sameScope({ kind: "round", key: "a" }, { kind: "round", key: "a" })).toBe(true);
    expect(sameScope({ kind: "round", key: "a" }, { kind: "worktree", key: "a" })).toBe(false);
    expect(sameScope({ kind: "round", key: "a" }, { kind: "round", key: "b" })).toBe(false);
  });

  test("dado texto para slug, então corta no limite sem deixar hífen na ponta", () => {
    expect(slugify("Açaí & Cia!", 40)).toBe("acai-cia");
    expect(slugify("aaa-bbb", 4)).toBe("aaa");
    expect(slugify("!!!", 10)).toBe("");
  });
});

describe("gravador com a confirmação de remoção (a ligação da página)", () => {
  const doc = (n: number): CanvasDoc => docOf([node("agent:a", n, 0)]);
  const MASS = "canvas_mass_removal";

  /** O que a página faz: cada envio lê `peek`, e só o aceito zera. `replies` são as respostas do servidor, em ordem. */
  function page(replies: SaveReply[]) {
    const meta = createSaveMeta();
    const headers: { cause: string; confirmRemoval: boolean }[] = [];
    const timers = new Map<number, () => void>();
    let next = 0;
    const saver = createDocSaver({
      put: async () => {
        const sent = meta.peek();
        headers.push({ ...sent });
        const reply = replies.shift() as SaveReply;
        if (reply.kind === "saved") meta.saved(sent);
        return reply;
      },
      setTimer: (run) => { timers.set(++next, run); return next; },
      clearTimer: (h) => { timers.delete(h as number); },
      onStatus: () => undefined,
      onStale: () => undefined,
      fetchServer: async () => ({ ...doc(0), rev: 9 }),
    });
    return { meta, saver, headers, timers };
  }

  test("dado 409 depois de apagar em massa, então o reenvio leva a mesma confirmação", async () => {
    const p = page([{ kind: "stale", rev: 9 }, { kind: "saved", rev: 10 }]);
    p.saver.setRev(3, doc(0));
    p.meta.note({ cause: "user", confirmRemoval: true }, false);
    p.saver.schedule(doc(1));
    await p.saver.flush();
    expect(p.headers).toEqual([{ cause: "user", confirmRemoval: true }, { cause: "user", confirmRemoval: true }]);
    expect(p.meta.peek()).toEqual({ cause: "user", confirmRemoval: false });
  });

  test("dado falha de rede, então o reenvio também leva a confirmação até o servidor aceitar", async () => {
    const p = page([{ kind: "failed", code: "canvas_save_unreachable" }, { kind: "saved", rev: 4 }]);
    p.meta.note({ confirmRemoval: true }, false);
    p.saver.schedule(doc(1));
    await p.saver.flush();
    expect(p.timers.size).toBe(1);
    [...p.timers.values()][0]?.();
    await p.saver.flush();
    expect(p.headers.map((h) => h.confirmRemoval)).toEqual([true, true]);
  });

  test("dado edição nova durante o envio aceito, então a confirmação dela não se perde", () => {
    const meta = createSaveMeta();
    const sent = meta.peek();
    meta.note({ cause: "user", confirmRemoval: true }, true);
    meta.saved(sent);
    expect(meta.peek()).toEqual({ cause: "user", confirmRemoval: true });
  });

  test("dado grafo e gesto no mesmo envio, então a causa é a do gesto", () => {
    const meta = createSaveMeta();
    meta.note({ cause: "user" }, false);
    meta.note({ cause: "graph" }, true);
    expect(meta.peek().cause).toBe("user");
  });

  test("dado 422 de remoção em massa, então o erro aparece e nada é reenviado sozinho", async () => {
    const p = page([{ kind: "failed", code: MASS }, { kind: "saved", rev: 4 }]);
    p.saver.schedule(doc(1));
    await p.saver.flush();
    expect(p.timers.size).toBe(0);
    expect(p.headers).toHaveLength(1);
  });

  test("dado 422 e depois uma edição do dono, então o envio novo sai", async () => {
    const p = page([{ kind: "failed", code: MASS }, { kind: "saved", rev: 4 }]);
    p.saver.schedule(doc(1));
    await p.saver.flush();
    p.saver.schedule(doc(2));
    [...p.timers.values()][0]?.();
    await p.saver.flush();
    expect(p.headers).toHaveLength(2);
  });
});
