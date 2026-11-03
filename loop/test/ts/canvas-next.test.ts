// Grupo canvas-next: próximo nó que precisa do dono (src/lib/canvas-next.ts) — razões, ordem estável com empate, ciclo.
import { describe, expect, test } from "bun:test";
import { cycleOwner, ownerQueue, type NextNode } from "../../../src/lib/canvas-next";

const agent = (id: string, over: Partial<NextNode> = {}): NextNode => ({ id, type: "agent", state: "working", registryState: "active", lastEventTs: null, ...over });
const perm = (id: string, ts: string, over: Partial<NextNode> = {}): NextNode => agent(id, { pendingPermission: { ts, tool: "Bash" }, ...over });
const ids = (nodes: NextNode[]): string[] => ownerQueue(nodes).map((i) => i.id);

describe("canvas-next: quem entra", () => {
  test("dado permissão pendente, pergunta aberta e gate falho, então cada um entra com a sua razão", () => {
    const queue = ownerQueue([
      perm("agent:p:a", "2026-11-02T10:00:00Z"),
      agent("agent:p:b", { openQuestions: ["Q1 — x"] }),
      agent("agent:p:c", { gateFailed: true }),
      { id: "gate:9", type: "gate", state: "failed" },
    ]);
    expect(queue.map((i) => [i.id, i.reason])).toEqual([["agent:p:a", "permission"], ["agent:p:b", "question"], ["agent:p:c", "gate"], ["gate:9", "gate"]]);
  });

  test("dado agente sem pendência, gate rodando ou esperando, PR e unidade, então ninguém entra", () => {
    expect(ids([agent("agent:p:a"), { id: "gate:1", type: "gate", state: "running" }, { id: "gate:2", type: "gate", state: "waiting" },
      { id: "pr:p:7", type: "pr", state: "open" }, { id: "unit:p:u", type: "unit", state: "planned", openQuestions: ["Q1 — x"] }])).toEqual([]);
  });

  test("dado agente encerrado com pendência velha, então não entra", () => {
    expect(ids([perm("agent:p:a", "2026-11-02T10:00:00Z", { state: "done" }), perm("agent:p:b", "2026-11-02T10:00:00Z", { registryState: "archived" })])).toEqual([]);
  });

  test("dado lista de perguntas vazia ou nula, então não conta como pergunta aberta", () => {
    expect(ids([agent("agent:p:a", { openQuestions: [] }), agent("agent:p:b", { openQuestions: null })])).toEqual([]);
  });

  test("dado agente com permissão e pergunta, então vale a razão mais urgente, uma vez só", () => {
    const queue = ownerQueue([perm("agent:p:a", "2026-11-02T10:00:00Z", { openQuestions: ["Q1 — x"], gateFailed: true })]);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.reason).toBe("permission");
  });

  test("dado id repetido, então conta uma vez (vale o primeiro)", () => {
    const queue = ownerQueue([perm("agent:p:a", "2026-11-02T10:00:00Z"), agent("agent:p:a", { openQuestions: ["Q1 — x"] })]);
    expect(queue.map((i) => i.reason)).toEqual(["permission"]);
  });
});

describe("canvas-next: ordem", () => {
  test("dado razões diferentes, então a prioridade vence a antiguidade (permissão, pergunta, gate)", () => {
    expect(ids([
      agent("agent:p:gate", { gateFailed: true, lastEventTs: "2026-01-01T00:00:00Z" }),
      agent("agent:p:q", { openQuestions: ["Q1 — x"], lastEventTs: "2026-02-01T00:00:00Z" }),
      perm("agent:p:perm", "2026-11-02T10:00:00Z"),
    ])).toEqual(["agent:p:perm", "agent:p:q", "agent:p:gate"]);
  });

  test("dado a mesma razão, então o que espera há mais tempo vem primeiro", () => {
    expect(ids([perm("agent:p:novo", "2026-11-02T11:00:00Z"), perm("agent:p:velho", "2026-11-02T09:00:00Z"), perm("agent:p:meio", "2026-11-02T10:00:00Z")]))
      .toEqual(["agent:p:velho", "agent:p:meio", "agent:p:novo"]);
  });

  test("dado empate de instante, então o id desempata e a ordem de entrada não importa", () => {
    const nodes = [perm("agent:p:c", "2026-11-02T10:00:00Z"), perm("agent:p:a", "2026-11-02T10:00:00Z"), perm("agent:p:b", "2026-11-02T10:00:00Z")];
    const expected = ["agent:p:a", "agent:p:b", "agent:p:c"];
    expect(ids(nodes)).toEqual(expected);
    expect(ids([...nodes].reverse())).toEqual(expected);
    expect(ids([nodes[1] as NextNode, nodes[2] as NextNode, nodes[0] as NextNode])).toEqual(expected);
  });

  test("dado o mesmo instante em fusos diferentes, então empata de verdade (compara o instante, não o texto)", () => {
    expect(ids([perm("agent:p:b", "2026-11-02T10:00:00Z"), perm("agent:p:a", "2026-11-02T07:00:00-03:00")])).toEqual(["agent:p:a", "agent:p:b"]);
    expect(ids([perm("agent:p:a", "2026-11-02T11:00:00Z"), perm("agent:p:b", "2026-11-02T07:30:00-03:00")])).toEqual(["agent:p:b", "agent:p:a"]);
  });

  test("dado instante sem fuso ou ilegível, então não é lido como hora local e vai para o fim da razão", () => {
    const queue = ownerQueue([
      perm("agent:p:a", "2026-11-02 10:00:00"),
      perm("agent:p:b", "ontem"),
      perm("agent:p:c", "2026-11-02T10:00:00Z"),
    ]);
    expect(queue.map((i) => i.id)).toEqual(["agent:p:c", "agent:p:a", "agent:p:b"]);
    expect(queue.map((i) => i.since)).toEqual(["2026-11-02T10:00:00Z", null, null]);
  });

  test("dado pergunta sem instante próprio, então espera desde o último evento do nó", () => {
    const queue = ownerQueue([agent("agent:p:q", { openQuestions: ["Q1 — x"], lastEventTs: "2026-11-02T08:00:00Z" })]);
    expect(queue[0]?.since).toBe("2026-11-02T08:00:00Z");
  });

  test("dado o mesmo grafo duas vezes, então a fila é idêntica e a entrada não é alterada", () => {
    const nodes = [perm("agent:p:b", "2026-11-02T10:00:00Z"), agent("agent:p:a", { openQuestions: ["Q1 — x"] })];
    const before = JSON.stringify(nodes);
    expect(ownerQueue(nodes)).toEqual(ownerQueue(nodes));
    expect(JSON.stringify(nodes)).toBe(before);
  });
});

describe("canvas-next: ciclo", () => {
  const queue = ownerQueue([perm("agent:p:a", "2026-11-02T09:00:00Z"), perm("agent:p:b", "2026-11-02T10:00:00Z"), perm("agent:p:c", "2026-11-02T11:00:00Z")]);

  test("dado o nó atual na fila, então próximo e anterior andam um passo", () => {
    expect(cycleOwner(queue, "agent:p:a", "next")?.id).toBe("agent:p:b");
    expect(cycleOwner(queue, "agent:p:c", "previous")?.id).toBe("agent:p:b");
  });

  test("dado o fim da fila, então próximo volta ao primeiro, e anterior do primeiro vai ao último", () => {
    expect(cycleOwner(queue, "agent:p:c", "next")?.id).toBe("agent:p:a");
    expect(cycleOwner(queue, "agent:p:a", "previous")?.id).toBe("agent:p:c");
  });

  test("dado nada selecionado ou nó fora da fila, então próximo vai ao primeiro e anterior ao último", () => {
    for (const current of [null, undefined, "", "agent:p:zzz"]) {
      expect(cycleOwner(queue, current, "next")?.id).toBe("agent:p:a");
      expect(cycleOwner(queue, current, "previous")?.id).toBe("agent:p:c");
    }
  });

  test("dado fila vazia, então não há próximo; com um item só, o ciclo devolve esse item", () => {
    expect(cycleOwner([], "agent:p:a", "next")).toBeUndefined();
    const one = ownerQueue([perm("agent:p:a", "2026-11-02T09:00:00Z")]);
    expect(cycleOwner(one, "agent:p:a", "next")?.id).toBe("agent:p:a");
    expect(cycleOwner(one, "agent:p:a", "previous")?.id).toBe("agent:p:a");
  });
});
