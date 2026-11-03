// Histórico do terminal do nó (#13): rota GET /api/herdr/scrollback (src/panel/herdr-page.ts) com o herdr de mentira.
import { describe, expect, test } from "bun:test";
import { SCROLLBACK_LINES_DEFAULT, SCROLLBACK_LINES_MAX, createHerdrPage, scrollbackLinesOf } from "../../../src/panel/herdr-page";

type Dict = Record<string, any>;

function page(over: { rc?: number; out?: string } = {}) {
  const calls: string[][] = [];
  const herdr = {
    call: async (_s: string | null, args: string[]) => {
      calls.push(args);
      if (args[0] === "session") return { rc: 0, out: JSON.stringify({ sessions: [{ name: "default", running: true, default: true }] }), err: "" };
      return { rc: over.rc ?? 0, out: over.out ?? "\x1b[31mlinha\x1b[0m\r\n", err: "" };
    },
    json: async () => null,
    cached: async (_k: string, load: () => Promise<unknown>) => load(),
    snap: async () => ({ panes: [{ pane_id: "w1:p1", scroll: { max_offset_from_bottom: 267, offset_from_bottom: 0, viewport_rows: 39 } }] }),
    forget: () => undefined,
    badge: async () => null,
  };
  return { calls, api: createHerdrPage({ dir: "/nonexistent" } as Dict as never, herdr as never) };
}

describe("#13 histórico do pane", () => {
  test("dado um pane da listagem, então lê source recent em ANSI com o teto pedido e devolve o texto", async () => {
    const { api, calls } = page();
    const r = await api.scrollback("default", "w1:p1", "300");
    expect(calls.at(-1)).toEqual(["pane", "read", "w1:p1", "--source", "recent", "--format", "ansi", "--lines", "300"]);
    expect(r).toMatchObject({ pane: "w1:p1", lines: 300, ansi: "\x1b[31mlinha\x1b[0m\r\n", scroll: { max_offset_from_bottom: 267 } });
  });

  test("dado lines vazio, então vale o padrão", async () => {
    const { api } = page();
    expect((await api.scrollback("default", "w1:p1", undefined)).lines).toBe(SCROLLBACK_LINES_DEFAULT);
  });

  test("dado lines fora de 1..teto ou não numérico, então é recusado e o herdr nem é lido", async () => {
    const { api, calls } = page();
    for (const bad of ["0", String(SCROLLBACK_LINES_MAX + 1), "-5", "1e3", "abc", "99999999"]) {
      await expect(api.scrollback("default", "w1:p1", bad)).rejects.toThrow("lines");
    }
    expect(calls).toEqual([]);
    expect(scrollbackLinesOf(String(SCROLLBACK_LINES_MAX))).toBe(SCROLLBACK_LINES_MAX);
  });

  test("dado pane fora da listagem ou com id malformado, então é recusado", async () => {
    const { api, calls } = page();
    await expect(api.scrollback("default", "w9:p9", "100")).rejects.toThrow("painel inexistente");
    await expect(api.scrollback("default", "w1:p1; rm -rf /", "100")).rejects.toThrow("painel inválido");
    expect(calls.some((c) => c[0] === "pane")).toBe(false);
  });

  test("dada sessão desconhecida, então é recusada", async () => {
    const { api } = page();
    await expect(api.scrollback("outra", "w1:p1", "100")).rejects.toThrow("sessão do herdr desconhecida");
  });

  test("dado o herdr falhando na leitura, então o erro é genérico, sem a saída do herdr", async () => {
    const { api } = page({ rc: 1, out: "detalhe interno /home/x" });
    await expect(api.scrollback("default", "w1:p1", "100")).rejects.toThrow("o herdr não leu o histórico do painel");
  });
});
