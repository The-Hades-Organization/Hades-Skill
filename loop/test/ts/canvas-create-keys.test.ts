// Atalhos de criar terminal no canvas (src/lib/canvas-create-keys.ts): mapa tecla → ação respeitando o foco, o corpo da
// criação do shell sem agente e o ponto em que o nó nasce.
import { describe, expect, test } from "bun:test";
import { createCommandRegistry } from "../../../src/lib/canvas-commands.ts";
import {
  CREATE_KINDS, CREATE_SHORTCUT_CHORDS, createCommandDefs, createKeyAction, createLegendRows, createRect, terminalCreateBody,
} from "../../../src/lib/canvas-create-keys.ts";

const key = (k: string, over: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) => ({ key: k, shiftKey: true, ...over });

describe("tecla → ação", () => {
  test("Shift+A, Shift+O e Shift+S, com o foco no canvas, pedem agente, orquestrador e shell", () => {
    expect(createKeyAction(key("A"), "canvas")).toBe("agent");
    expect(createKeyAction(key("O"), "canvas")).toBe("orchestrator");
    expect(createKeyAction(key("S"), "canvas")).toBe("shell");
  });

  test.each(["terminal", "note", "field"] as const)("com o foco em %s a tecla é dele", (focus) => {
    for (const k of ["A", "O", "S"]) expect(createKeyAction(key(k), focus)).toBeNull();
  });

  test("sem Shift, com Ctrl ou com Alt a tecla não cria nada", () => {
    expect(createKeyAction({ key: "a", shiftKey: false }, "canvas")).toBeNull();
    expect(createKeyAction(key("A", { ctrlKey: true }), "canvas")).toBeNull();
    expect(createKeyAction(key("S", { altKey: true }), "canvas")).toBeNull();
    expect(createKeyAction(key("Q"), "canvas")).toBeNull();
  });
});

describe("registro", () => {
  test("os três comandos entram num registro com as teclas atuais do canvas sem conflito", () => {
    const registry = createCommandRegistry<object>();
    // as teclas que o canvas já tem e que o pedido deixou de fora: Shift+A (aprovar) e Shift+O (organizar) migraram
    for (const chord of ["shift+t", "shift+y", "shift+r", "shift+x", "shift+g", "shift+m", "shift+f", "shift+n", "shift+b", "shift+e", "shift+l", "shift+p"]) {
      registry.register({ id: `ocupa:${chord.replace("+", "-")}`, label: chord, group: "x", shortcut: chord, surfaces: ["palette"], run: () => undefined });
    }
    for (const def of createCommandDefs(() => undefined)) registry.register(def as never);
    expect(registry.help({}).map((e) => e.id).filter((id) => id.startsWith("create:"))).toEqual(CREATE_KINDS.map((k) => `create:${k}`));
  });

  test("o acorde de cada ação é o do pedido", () => {
    expect(CREATE_SHORTCUT_CHORDS).toEqual({ agent: "shift+a", orchestrator: "shift+o", shell: "shift+s" });
  });

  test("rodar o comando entrega o tipo ao tratador", () => {
    const seen: string[] = [];
    for (const def of createCommandDefs((kind) => seen.push(kind))) def.run({} as never);
    expect(seen).toEqual(["agent", "orchestrator", "shell"]);
  });

  test("a legenda lista as três teclas com o acorde escrito para a tela", () => {
    expect(createLegendRows().map((r) => [r.kind, r.keys])).toEqual([["agent", "Shift+A"], ["orchestrator", "Shift+O"], ["shell", "Shift+S"]]);
  });
});

describe("corpo da criação", () => {
  test("shell vai sem agente, papel, predefinição nem orquestrador", () => {
    const body = terminalCreateBody("shell", { name: "shell", cwd: "/p" });
    expect(body).toEqual({ name: "shell", cwd: "/p", shell: true });
    for (const field of ["agent", "role", "preset", "orchestrator", "model", "effort"]) expect(body).not.toHaveProperty(field);
  });

  test("shell sem pasta deixa o servidor escolher a do projeto", () => {
    expect(terminalCreateBody("shell", { name: "shell" })).toEqual({ name: "shell", shell: true });
    expect(terminalCreateBody("shell", { name: "shell", cwd: "  " })).toEqual({ name: "shell", shell: true });
  });

  test("agente comum não leva orquestrador e o orquestrador leva", () => {
    expect(terminalCreateBody("agent", { name: "agente" })).toEqual({ name: "agente" });
    expect(terminalCreateBody("orchestrator", { name: "orquestrador", cwd: "/p" })).toEqual({ name: "orquestrador", cwd: "/p", orchestrator: true });
  });
});

describe("onde o nó nasce", () => {
  const size = { w: 100, h: 60 };
  test("sobre o canvas, centrado no cursor", () => {
    expect(createRect({ x: 500, y: 300 }, { x: 0, y: 0 }, size)).toEqual({ x: 450, y: 270, w: 100, h: 60 });
  });
  test("sem cursor sobre o canvas, centrado na vista", () => {
    expect(createRect(null, { x: 10, y: 20 }, size)).toEqual({ x: -40, y: -10, w: 100, h: 60 });
  });
});
