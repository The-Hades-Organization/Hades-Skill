/// <reference path="../../../kit/panel/ui/argos/logic.tsx" />
// Menu do nó de agente do Argos: "Abrir terminal na worktree" e "Abrir cliente do herdr" (argos/logic.tsx).
import { describe, expect, test } from "bun:test";
import "../../../kit/panel/ui/argos/logic.tsx";

type Dict = Record<string, any>;
const L = (globalThis as unknown as { ArgosLogic: Dict }).ArgosLogic;

const nodes: Record<string, Dict> = {
  a1: { worktree: "/home/u/wt/a1", herdr: { session: "default", pane: "w1:p1" } },
  a2: { worktree: "relativa/a2" },
  a3: { worktree: "/home/u/wt/a3", herdr: { session: "x y; rm" } },
};
const setup = () => {
  const opened: Dict[] = [];
  const defs = L.termOpenCommandDefs({ node: (id: string) => nodes[id], open: (s: Dict) => void opened.push(s) });
  const by = (id: string) => defs.find((d: Dict) => d.id === id);
  const ctx = (nodeId: string | null) => ({ reading: { nodeId } });
  return { opened, by, ctx };
};

describe("Abrir terminal no menu do nó de agente", () => {
  test("dado o agente com worktree absoluta, então o shell abre na pasta dele", () => {
    const { opened, by, ctx } = setup();
    expect(by(L.TERM_OPEN_SHELL).when(ctx("a1"))).toBe(true);
    by(L.TERM_OPEN_SHELL).run(ctx("a1"));
    expect(opened).toEqual([{ kind: "shell", cwd: "/home/u/wt/a1" }]);
  });
  test("dado worktree relativa, nó desconhecido ou sem nó, então o comando não aparece e não abre nada", () => {
    const { opened, by, ctx } = setup();
    for (const id of ["a2", "zz", null]) {
      expect(by(L.TERM_OPEN_SHELL).when(ctx(id))).toBe(false);
      by(L.TERM_OPEN_SHELL).run(ctx(id));
    }
    expect(opened).toEqual([]);
  });
  test("dado o agente com sessão do herdr, então abre o cliente dessa sessão", () => {
    const { opened, by, ctx } = setup();
    expect(by(L.TERM_OPEN_CLIENT).when(ctx("a1"))).toBe(true);
    by(L.TERM_OPEN_CLIENT).run(ctx("a1"));
    expect(opened).toEqual([{ kind: "herdr-client", session: "default" }]);
  });
  test("dado sessão com nome inseguro ou ausente, então o cliente do herdr não é oferecido", () => {
    const { opened, by, ctx } = setup();
    for (const id of ["a2", "a3"]) {
      expect(by(L.TERM_OPEN_CLIENT).when(ctx(id))).toBe(false);
      by(L.TERM_OPEN_CLIENT).run(ctx(id));
    }
    expect(opened).toEqual([]);
  });
  test("os dois comandos são só do menu do nó", () => {
    const { by } = setup();
    expect(by(L.TERM_OPEN_SHELL).surfaces).toEqual(["node-menu"]);
    expect(by(L.TERM_OPEN_CLIENT).surfaces).toEqual(["node-menu"]);
  });
});
