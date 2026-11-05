/// <reference path="../../../kit/panel/ui/argos/logic.tsx" />
// Terminal criado no canvas (UI): campos do grafo para a tela (argos-graph-ui), dados e tema do nó `terminal`
// (node-terminal.tsx), cliente das rotas e fluxos de criar/fechar/papel (terminal-create.tsx), tela de papéis
// (terminal-roles.tsx), barra de ferramentas (canvas-toolbar.tsx), comandos T2 e a tecla de fechar no terminal focado.
// Sem DOM: os scripts clássicos rodam num escopo próprio com o HadesCore de mentira; a rede é um fetch falso.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CANVAS_UI_BUNDLE, createCanvasModuleBundler, createUiTranspiler } from "../../../src/panel/ui-transpile";
import { HERDR_DEFAULT_SESSION, ROUND_ID_CHARS, SHORT_ID_MAX, agentShortId, herdrRefOf, roundOf, shortRegistry } from "../../../src/lib/argos-graph-ui";
import "../../../kit/panel/ui/argos/logic.tsx";

const L = (globalThis as unknown as { ArgosLogic: ArgosLogicApi }).ArgosLogic;
const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PANE = { session: "default", pane: "w1:p3" };

type Dict = Record<string, any>;
type Reply = { status: number; body?: unknown } | Error;

let loaded: Promise<Dict> | null = null;
/** Os scripts da UI num escopo só, uma vez por arquivo de teste (o registro de ferramentas é do módulo). */
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
      useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => undefined],
      useEffect: () => undefined, useRef: (v: unknown) => ({ current: v }), useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(),
      cn: (...a: unknown[]) => a.filter(Boolean).join(" "),
      I: new Proxy({}, { get: () => stub("svg") }),
      post: () => Promise.reject(new Error("sem rede no teste")), getJSON: () => Promise.reject(new Error("sem rede no teste")),
      Button: stub("button"), Input: stub("input"), Dialog: stub("div"), DialogHeader: stub("div"), DialogFooter: stub("div"), Segmented: stub("div"),
      Checkbox: stub("button"), Dot: stub("span"), Mono: stub("span"), Tip: stub("span"), Empty: stub("div"), useApp: () => ({}),
    };
    const scope: Dict = { CanvasModel: holder.CanvasModel };
    const transpiler = createUiTranspiler();
    for (const rel of ["term-logic.tsx", "argos/node-terminal.tsx", "argos/node-tty.tsx", "argos/commands-canvas.tsx", "argos/types-user.tsx", "argos/types-live.tsx",
      "argos/terminal-create.tsx", "argos/terminal-roles.tsx", "argos/canvas-toolbar.tsx"]) {
      new Function("globalThis", "window", "React", "HadesCore", transpiler.transpile(join(uiDir, rel)))(scope, scope, React, HadesCore);
    }
    return { ...scope, M: holder.CanvasModel };
  })();
  return loaded;
}

/** fetch falso: responde a fila `replies` na ordem e guarda o que foi pedido. */
function fakeFetch(...replies: Reply[]) {
  const calls: { url: string; body: Dict | undefined }[] = [];
  const fetch = async (url: string, init: { body?: string } = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    const r = replies.shift();
    if (!r) throw new Error("resposta não prevista");
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (r.body === undefined ? Promise.reject(new Error("sem json")) : r.body) };
  };
  return { fetch, calls };
}
const named = (name: string) => Object.assign(new Error(name), { name });

describe("grafo do Argos: campos para a tela (argos-graph-ui)", () => {
  test("dado um pane no formato do herdr, então o par vem com a sessão padrão", () => {
    expect(herdrRefOf("w1:p3")).toEqual({ session: HERDR_DEFAULT_SESSION, pane: "w1:p3" });
  });
  test("dado pane ou sessão fora do formato, então nenhum par meio válido", () => {
    for (const bad of [undefined, "", "w1", "w1:3", "../x:p1", 42]) expect(herdrRefOf(bad)).toBeNull();
    expect(herdrRefOf("w1:p3", "sessão com espaço")).toBeNull();
  });
  test("registro curto: _skill vira skill e owner__repo vira repo", () => {
    expect(shortRegistry("_skill")).toBe("skill");
    expect(shortRegistry("acme__loja")).toBe("loja");
    expect(shortRegistry("solto")).toBe("solto");
    expect(shortRegistry("termina__")).toBe("termina__");
  });
  test("id curto do agente é <repo>/<agente> e some acima do teto", () => {
    expect(agentShortId("acme__loja", "impl-1")).toBe("loja/impl-1");
    expect(agentShortId("", "x")).toBeNull();
    expect(agentShortId("r", "a".repeat(SHORT_ID_MAX))).toBeNull();
  });
  test("rodada: os primeiros dígitos do hash e o nome do plano sem .md", () => {
    expect(roundOf("/x/plans/argos-canvas-p9.md", SHA)).toEqual({ id: SHA.slice(0, ROUND_ID_CHARS), name: "argos-canvas-p9" });
    expect(roundOf("/x/plano.md", "nao-hex")).toBeNull();
    expect(roundOf(undefined, SHA)).toBeNull();
    expect(roundOf("/x/", SHA)).toBeNull();
  });
});

describe("nó terminal: dados, tema e alvos (node-terminal.tsx)", () => {
  test("dado data com campos inválidos, então só os válidos voltam (sem padrão inventado)", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const d = NT.readTerminalData({ name: "  dev  ", icon: "Nope", color: "#12a594", theme: "neon", font: "geist", agent: "claude", model: "x y", herdr: PANE });
    expect(d).toEqual({ name: "dev", color: "#12a594", font: "geist", agent: "claude", herdr: PANE });
    expect(NT.readTerminalData(null)).toEqual({ name: null });
    expect(NT.readTerminalData({ name: "x".repeat(NT.TERMINAL_NAME_MAX + 1) }).name).toBeNull();
  });
  test("tema vazio segue o painel; Sistema troca pelo esquema; Personalizado só com fundo e texto", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    expect(NT.terminalThemeStyle({ name: "t" }, true)).toEqual({});
    const dark = NT.terminalThemeStyle({ theme: "system" }, true);
    const light = NT.terminalThemeStyle({ theme: "system" }, false);
    expect(dark["--color-term"]).not.toBe(light["--color-term"]);
    expect(NT.terminalThemeStyle({ theme: "custom", themeBg: "#000000" }, true)).toEqual({});
    expect(NT.terminalThemeStyle({ theme: "custom", themeBg: "#000000", themeFg: "#ffffff" }, true)["--term"]).toBe("#000000");
    expect(NT.terminalThemeStyle({ font: "courier" }, true)["--font-mono"]).toContain("Courier");
  });
  test("alvos do documento: só nós terminal com par válido; conexões contam as duas pontas", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const node = (id: string, type: string, data: object) => ({ id, type, x: 0, y: 0, w: 10, h: 10, z: 0, data, locked: false, blurred: false });
    const doc = { nodes: [node("a", "terminal", { herdr: PANE }), node("b", "terminal", { herdr: { session: "default", pane: "ruim" } }), node("c", "note", { herdr: PANE })],
      edges: [{ id: "e1", from: "a", to: "c" }, { id: "e2", from: "b", to: "a" }, { id: "e3", from: "b", to: "c" }] };
    expect([...NT.ttyTargetsOfDoc(doc)]).toEqual([["a", PANE]]);
    expect(NT.ttyTargetsOfDoc(null).size).toBe(0);
    expect(NT.linkCountOf(doc, "a")).toBe(2);
    expect(NT.linkCountOf(doc, "z")).toBe(0);
  });
  test("nó novo: retângulo arredondado, acima do mais alto, nunca com lado zero", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const n = NT.newTerminalNode({ id: "term-1", rect: { x: 1.4, y: 2.6, w: 0.2, h: 300.5 }, data: { name: "t" }, top: 4 });
    expect(n).toMatchObject({ id: "term-1", type: "terminal", x: 1, y: 3, w: 1, h: 301, z: 5, locked: false, blurred: false });
  });
  test("o tipo registra uma vez, com o menu dos comandos T2, e o nó agent novo nasce maior", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const seen: Dict[] = [];
    const types = { get: (t: string) => seen.find((d) => d.type === t), register: (d: Dict) => void seen.push(d) };
    const def = NT.registerTerminalType(types, () => null);
    expect(def.menu).toEqual(["term:edit", "term:role", "term:appearance", "term:connections", "tty:close"]);
    expect(def.live).toBe(false);
    expect(NT.registerTerminalType(types, () => null)).toBeNull();
    expect(NT.AGENT_NODE_SIZE.w * NT.AGENT_NODE_SIZE.h).toBeGreaterThan(200 * 66);
  });
  test("nó agent com o par do grafo usa o par antes de casar por nome", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    expect(NT.ttyTargetOf(null, { type: "agent", label: "x", herdr: PANE })).toEqual(PANE);
    expect(NT.ttyTargetOf(null, { type: "agent", label: "x" })).toBeNull();
  });
});

describe("nó legível usa o xterm, nó distante fica no resumo leve", () => {
  test("dado o zoom e o tamanho do nó, então só o que dá para ler vira xterm", async () => {
    const { ArgosNodeTerminal: NT, ArgosNodeTty: Tty } = await load();
    const frame = { cols: 80, rows: 24 };
    const drawingAt = (zoom: number, w: number, h: number) => Tty.ttyDrawing(NT.ttyHeaderOnly(zoom, NT.ttyScaleOf(w, h, frame)));
    expect(drawingAt(1, 800, 520)).toBe("xterm");
    expect(drawingAt(0.2, 800, 520)).toBe("summary");
    expect(drawingAt(1, 300, 200)).toBe("summary");
  });
});

describe("terminal não corta as linhas de baixo (node-tty.tsx)", () => {
  test("dado texto com mais linhas que o quadro anuncia, então a grade mostra todas; vazias do fim não contam", async () => {
    const { ArgosNodeTty: Tty } = await load();
    const line = [{ text: "x" }];
    expect(Tty.rowsToShow(3, [line, line])).toBe(3);
    expect(Tty.rowsToShow(3, [line, line, line, line, line])).toBe(5);
    expect(Tty.rowsToShow(3, [line, line, line, [], []])).toBe(3);
    expect(Tty.rowsToShow(3, [line, line, line, line, []])).toBe(4);
  });
  test("a escala mede o tamanho de layout, não o da tela (que já vem com o zoom do canvas)", () => {
    const src = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/argos/node-tty.tsx"), "utf8");
    // só a altura de linha da roda (screenLinePx) quer a medida da tela; a escala de encaixe nunca
    expect(src.replace(/const screenLinePx = [^\n]*\n/, "")).not.toMatch(/\.getBoundingClientRect\(/);
    expect(src).toContain("areaBox(el.clientWidth, el.clientHeight)");
  });
});

describe("Ctrl+Shift+V e Ctrl+Shift+C no terminal (node-tty.tsx)", () => {
  const ev = (code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) =>
    ({ code, key: code.slice(3).toLowerCase(), ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta });
  test("dado Ctrl+Shift+V ou C, então é colar ou copiar, em qualquer layout (pelo code)", async () => {
    const { ArgosNodeTty: Tty } = await load();
    expect(Tty.clipboardAction(ev("KeyV", { ctrl: true, shift: true }))).toBe("paste");
    expect(Tty.clipboardAction(ev("KeyC", { ctrl: true, shift: true }))).toBe("copy");
  });
  test("dado Ctrl+C sem Shift, então segue sendo a interrupção do agente, não cópia", async () => {
    const { ArgosNodeTty: Tty } = await load();
    expect(Tty.clipboardAction(ev("KeyC", { ctrl: true }))).toBeNull();
    expect(Tty.translateKey(ev("KeyC", { ctrl: true }))).toEqual({ keys: ["Ctrl+C"] });
    expect(Tty.clipboardAction(ev("KeyV", { ctrl: true, shift: true, alt: true }))).toBeNull();
    expect(Tty.clipboardAction(ev("KeyX", { ctrl: true, shift: true }))).toBeNull();
  });
});

describe("cursor do quadro (node-tty.tsx)", () => {
  test("dado um cursor dentro da grade e visível, então ele volta", async () => {
    const { ArgosNodeTty: Tty } = await load();
    expect(Tty.cursorOf({ rows: 10, cols: 40, cursor: { row: 2, col: 5 } })).toEqual({ row: 2, col: 5 });
  });
  test("sem campo, escondido ou fora da grade, então nada é desenhado", async () => {
    const { ArgosNodeTty: Tty } = await load();
    expect(Tty.cursorOf({ rows: 10, cols: 40 })).toBeNull();
    expect(Tty.cursorOf({ rows: 10, cols: 40, cursor: { row: 2, col: 5, visible: false } })).toBeNull();
    expect(Tty.cursorOf({ rows: 10, cols: 40, cursor: { row: 10, col: 0 } })).toBeNull();
    expect(Tty.cursorOf({ rows: 10, cols: 40, cursor: { row: 1.5, col: 0 } })).toBeNull();
  });
  test("Ctrl+Alt+W não vira texto para o agente (sobe ao canvas)", async () => {
    const { ArgosNodeTty: Tty } = await load();
    expect(Tty.TTY_CANVAS_KEYS).toContain("Ctrl+Alt+W");
    expect(Tty.translateKey({ key: "w", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toBeNull();
    // AltGr (Ctrl+Alt) com outra tecla segue produzindo o caractere
    expect(Tty.translateKey({ key: "@", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toEqual({ text: "@" });
  });
});

describe("cliente das rotas de terminais e papéis (terminal-create.tsx)", () => {
  test("dado 200 no contrato, então ok com o valor lido", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch, calls } = fakeFetch({ status: 200, body: { herdr: PANE, agent: "claude", model: "opus" } });
    const r = await TC.createTerminalClient({ fetch }).create({ name: "dev" });
    expect(r).toEqual({ ok: true, value: { herdr: PANE, agent: "claude", model: "opus", effort: undefined, role: undefined } });
    expect(calls[0]).toEqual({ url: "/api/argos/terminals", body: { name: "dev" } });
  });
  test("erro com código do contrato: o código vem do corpo, a mensagem do servidor junto", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch } = fakeFetch({ status: 502, body: { error: "pane sumiu", code: "herdr-failed" } });
    expect(await TC.createTerminalClient({ fetch }).close({ session: "default", pane: "w1:p3", name: "dev" }))
      .toEqual({ ok: false, code: "herdr-failed", message: "pane sumiu" });
  });
  test("503 herdr-server-down: o código do corpo vale e a tela diz o que fazer", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch } = fakeFetch({ status: 503, body: { error: "o servidor do herdr não está rodando: abra o `herdr` e tente de novo", code: "herdr-server-down" } });
    const r = await TC.createTerminalClient({ fetch }).create({ name: "dev" });
    expect(r.code).toBe(TC.TERMINAL_ERRORS.herdrServerDown);
    expect(TC.errorText(r)).toContain("abra o `herdr`");
  });
  test("429 rate-limited: erro genérico com a mensagem do servidor", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch } = fakeFetch({ status: 429, body: { error: "tente de novo em 30 s", code: "rate-limited" } });
    const r = await TC.createTerminalClient({ fetch }).create({ name: "dev" });
    expect(r.code).toBe(TC.TERMINAL_ERRORS.rateLimited);
    expect(TC.errorText(r)).toBe("tente de novo em 30 s");
  });
  test("código desconhecido no corpo cai no do status; status sem código vira resposta fora do contrato", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch } = fakeFetch({ status: 404, body: { code: "inventado" } }, { status: 500 });
    const client = TC.createTerminalClient({ fetch });
    expect((await client.roles()).code).toBe("not-found");
    expect((await client.roles()).code).toBe(TC.TERMINAL_ERRORS.badResponse);
  });
  test("prazo estourado e rede fora viram códigos próprios, sem rejeitar", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch } = fakeFetch(named("TimeoutError"), new Error("offline"));
    const client = TC.createTerminalClient({ fetch, timeoutMs: 5 });
    expect((await client.presets()).code).toBe(TC.TERMINAL_ERRORS.timeout);
    expect((await client.presets()).code).toBe(TC.TERMINAL_ERRORS.network);
  });
  test("200 fora do contrato não passa como sucesso", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch } = fakeFetch({ status: 200, body: { herdr: { session: "default", pane: "ruim" }, agent: "claude" } }, { status: 200, body: { ok: "sim" } });
    const client = TC.createTerminalClient({ fetch });
    expect((await client.create({ name: "x" })).code).toBe(TC.TERMINAL_ERRORS.badResponse);
    expect((await client.deletePreset("p")).code).toBe(TC.TERMINAL_ERRORS.badResponse);
  });
});

describe("fluxos de criar, fechar e trocar papel (terminal-create.tsx)", () => {
  const form = (TC: Dict, extra: Dict = {}) => ({ ...TC.EMPTY_FORM, name: "dev", ...extra });

  test("criar local: uma chamada, sem perguntar o nome, e o data do nó só com o escolhido", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch, calls } = fakeFetch({ status: 200, body: { herdr: PANE, agent: "claude", role: "dev" } });
    let asked = 0;
    const r = await TC.createTerminal({ client: TC.createTerminalClient({ fetch }), form: form(TC, { color: "#e5484d", role: "dev" }), askName: async () => { asked += 1; return null; } });
    expect(asked).toBe(0);
    expect(calls).toHaveLength(1);
    expect(r).toEqual({ ok: true, data: { name: "dev", color: "#e5484d", agent: "claude", role: "dev", herdr: PANE } });
  });
  test("criar pelo acesso remoto: 403 confirm-required pede o nome e repete com confirm", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch, calls } = fakeFetch({ status: 403, body: { error: "confirme", code: "confirm-required" } }, { status: 200, body: { herdr: PANE, agent: "claude" } });
    const r = await TC.createTerminal({ client: TC.createTerminalClient({ fetch }), form: form(TC), askName: async (n: string) => n });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.body?.confirm)).toEqual([undefined, "dev"]);
  });
  test("criar pelo acesso remoto e cancelar o nome: nada é repetido", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch, calls } = fakeFetch({ status: 403, body: { code: "confirm-required" } });
    const r = await TC.createTerminal({ client: TC.createTerminalClient({ fetch }), form: form(TC), askName: async () => null });
    expect(r.code).toBe("cancelled");
    expect(calls).toHaveLength(1);
  });
  test("fechar sempre pede o nome antes da rota e manda o digitado como confirm", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch, calls } = fakeFetch({ status: 200, body: { ok: true } });
    const asked: string[] = [];
    const r = await TC.closeTerminal({ client: TC.createTerminalClient({ fetch }), data: { name: "dev", herdr: PANE }, askName: async (n: string) => { asked.push(n); return n; } });
    expect(r.ok).toBe(true);
    expect(asked).toEqual(["dev"]);
    expect(calls[0]).toEqual({ url: "/api/argos/terminals/close", body: { session: "default", pane: "w1:p3", name: "dev", confirm: "dev" } });
  });
  test("fechar cancelado não chama a rota; nó sem pane só sai do documento", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch, calls } = fakeFetch();
    const client = TC.createTerminalClient({ fetch });
    expect((await TC.closeTerminal({ client, data: { name: "dev", herdr: PANE }, askName: async () => null })).code).toBe("cancelled");
    expect((await TC.closeTerminal({ client, data: { name: "dev" }, askName: async (n: string) => n })).ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
  test("trocar papel grava o pane novo; tirar o papel apaga o campo", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const next = { session: "default", pane: "w1:p9" };
    const { fetch, calls } = fakeFetch({ status: 200, body: { herdr: next } });
    const r = await TC.changeRole({ client: TC.createTerminalClient({ fetch }), data: { name: "dev", role: "dev", herdr: PANE }, role: null, askName: async () => null });
    expect(r).toEqual({ ok: true, data: { name: "dev", herdr: next } });
    expect(calls[0]?.body).toEqual({ session: "default", pane: "w1:p3", name: "dev", role: null });
  });
  test("trocar papel de nó sem pane é recusado antes da rede", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const { fetch, calls } = fakeFetch();
    expect((await TC.changeRole({ client: TC.createTerminalClient({ fetch }), data: { name: "dev" }, role: "x", askName: async () => null })).code).toBe("not-found");
    expect(calls).toHaveLength(0);
  });
});

describe("formulário do terminal (terminal-create.tsx)", () => {
  test("predefinição sugere os valores, mas o que o dono mexeu fica", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const preset = { slug: "rev", name: "Revisor", agent: "claude", model: "opus", color: "#0090ff" };
    const f = TC.applyPreset({ ...TC.EMPTY_FORM, model: "sonnet" }, preset, new Set(["model"]));
    expect(f).toMatchObject({ preset: "rev", name: "Revisor", agent: "claude", model: "sonnet", color: "#0090ff" });
    expect(TC.applyPreset(f, null).agent).toBe("");
  });
  test("problemas do formulário: nome vazio, longo e tema personalizado incompleto", async () => {
    const { ArgosTerminalCreate: TC, ArgosNodeTerminal: NT } = await load();
    expect(TC.formProblem({ ...TC.EMPTY_FORM, name: "  " })).not.toBeNull();
    expect(TC.formProblem({ ...TC.EMPTY_FORM, name: "x".repeat(NT.TERMINAL_NAME_MAX + 1) })).not.toBeNull();
    expect(TC.formProblem({ ...TC.EMPTY_FORM, name: "x", theme: "custom", themeBg: "#000000" })).not.toBeNull();
    expect(TC.formProblem({ ...TC.EMPTY_FORM, name: "x" })).toBeNull();
  });
  test("corpo da criação leva só o escolhido, aparado", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    expect(TC.createBody({ ...TC.EMPTY_FORM, name: " dev ", agent: " claude ", cwd: "" })).toEqual({ name: "dev", agent: "claude" });
  });
  test("editar troca nome e aparência e guarda agente, papel e pane; tema deixa de ser personalizado e as cores saem", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const data = { name: "dev", agent: "claude", role: "dev", herdr: PANE, theme: "custom", themeBg: "#000000", themeFg: "#ffffff", icon: "Bug" };
    const out = TC.editedData(data, { ...TC.formOf(data), name: "rev", theme: "dark", icon: "" });
    expect(out).toEqual({ name: "rev", agent: "claude", role: "dev", herdr: PANE, theme: "dark" });
  });
  test("nome livre: base, depois sufixo numerado; base vazia vira terminal", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    expect(TC.nextTerminalName("Revisor", [])).toBe("Revisor");
    expect(TC.nextTerminalName("Revisor", ["Revisor", "Revisor 2"])).toBe("Revisor 3");
    expect(TC.nextTerminalName("", ["terminal"])).toBe("terminal 2");
  });
  test("predefinição a partir do formulário: agente padrão claude e só os campos escolhidos", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    expect(TC.presetOf({ ...TC.EMPTY_FORM, name: "Rev", color: "#0090ff" })).toEqual({ name: "Rev", agent: "claude", color: "#0090ff" });
  });
});

describe("tela de papéis (terminal-roles.tsx)", () => {
  test("papel precisa de nome, cor e instruções", async () => {
    const { ArgosTerminalRoles: TR } = await load();
    const ok = { ...TR.EMPTY_ROLE, name: "Dev", color: "#46a758", instructions: "faça" };
    expect(TR.roleFormProblem(ok)).toBeNull();
    expect(TR.roleFormProblem({ ...ok, name: "" })).not.toBeNull();
    expect(TR.roleFormProblem({ ...ok, color: "verde" })).not.toBeNull();
    expect(TR.roleFormProblem({ ...ok, instructions: " " })).not.toBeNull();
    expect(TR.roleFormProblem({ ...ok, instructions: "x".repeat(TR.ROLE_INSTRUCTIONS_MAX + 1) })).not.toBeNull();
  });
  test("corpo do papel: opcionais só quando preenchidos", async () => {
    const { ArgosTerminalRoles: TR } = await load();
    expect(TR.roleBodyOf({ ...TR.EMPTY_ROLE, name: " Dev ", color: "#46a758", instructions: " faça ", model: "opus" }))
      .toEqual({ name: "Dev", color: "#46a758", instructions: "faça", model: "opus" });
  });
  test("descoberta: começa marcando só o que ainda não existe aqui", async () => {
    const { ArgosTerminalRoles: TR } = await load();
    expect([...TR.initialPicks([{ path: "/a/role.json", exists: false }, { path: "/b/role.json", exists: true }])]).toEqual(["/a/role.json"]);
    expect(TR.initialPicks([]).size).toBe(0);
  });
  test("prévia corta as instruções longas", async () => {
    const { ArgosTerminalRoles: TR } = await load();
    expect(TR.previewOf("curto")).toBe("curto");
    expect(TR.previewOf("x".repeat(1000)).endsWith("…")).toBe(true);
    expect(TR.previewOf(undefined)).toBe("");
  });
});

describe("barra de ferramentas (canvas-toolbar.tsx)", () => {
  test("arrasto normaliza o retângulo em qualquer direção; arrasto curto é clique", async () => {
    const { ArgosCanvasToolbar: TB } = await load();
    expect(TB.dragRect({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 60, click: false });
    expect(TB.dragRect({ x: 5, y: 5 }, { x: 5 + TB.CLICK_PX - 1, y: 5 }).click).toBe(true);
  });
  test("clique vira o tamanho padrão centrado no ponto; arrasto vale no mundo, nunca abaixo do mínimo", async () => {
    const { ArgosCanvasToolbar: TB } = await load();
    const cam = { x: 100, y: 50, k: 2 };
    const opts = { size: { w: 640, h: 420 }, min: { w: 300, h: 200 } };
    expect(TB.rectToWorld(cam, { x: 20, y: 40, w: 0, h: 0, click: true }, opts)).toEqual({ x: 110 - 320, y: 70 - 210, w: 640, h: 420 });
    expect(TB.rectToWorld(cam, { x: 0, y: 0, w: 1000, h: 100, click: false }, opts)).toEqual({ x: 100, y: 50, w: 500, h: 200 });
  });
  test("Terminal vem registrada; id repetido ou inválido é recusado com código", async () => {
    const { ArgosCanvasToolbar: TB } = await load();
    expect(TB.listTools().map((t: Dict) => t.id)).toContain("terminal");
    expect(() => TB.registerTool({ id: "terminal", label: "x", icon: "X" })).toThrow(expect.objectContaining({ code: TB.TOOL_ERRORS.duplicate }));
    expect(() => TB.registerTool({ id: "Ruim", label: "x", icon: "X" })).toThrow(expect.objectContaining({ code: TB.TOOL_ERRORS.invalid }));
  });
  test("ferramenta nova entra na ordem pedida", async () => {
    const { ArgosCanvasToolbar: TB } = await load();
    TB.registerTool({ id: "teste-antes", label: "Antes", icon: "Square", order: 1 });
    expect(TB.listTools()[0].id).toBe("teste-antes");
  });
});

describe("comandos T2 do terminal criado no canvas (commands-canvas.tsx)", () => {
  async function mount(target: string | null) {
    const { M, ArgosCanvasCommands, ArgosTypesUser, ArgosTypesLive } = await load();
    const reg = M.argos.createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null });
    const ran: string[] = [];
    const notes: string[] = [];
    const terminals = {
      armTool: () => void ran.push("arm"), target: () => target, edit: async (id: string, tab: string) => void ran.push(`edit:${id}:${tab}`),
      role: async (id: string) => void ran.push(`role:${id}`), connections: async (id: string) => void ran.push(`conn:${id}`),
      close: async (id: string) => void ran.push(`close:${id}`), roles: () => void ran.push("roles"),
    };
    const api = {
      doc: { doc: () => M.doc.emptyCanvasDoc(), selection: () => [], select: () => undefined, commit: () => undefined, reveal: () => undefined, notify: (n: { text: string }) => void notes.push(n.text) },
      dialogs: { askText: async () => null, choose: async () => null, confirm: async () => false },
      terminals,
    };
    const deps = { fetch: () => Promise.reject(new Error("sem rede no teste")), now: () => 0 };
    const report = L.mountCanvasRegistries(reg as never, { canvasCommands: ArgosCanvasCommands, typesUser: ArgosTypesUser, typesLive: ArgosTypesLive } as never,
      { api, userDeps: deps, liveDeps: deps }) as { refused: unknown[] };
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    return { commands: reg.commands, ran, notes, report, settle };
  }

  test("com alvo, os comandos do menu do nó agem sobre ele", async () => {
    const t = await mount("term-1");
    expect(t.report.refused).toEqual([]);
    for (const id of ["term:edit", "term:role", "term:appearance", "term:connections", "tty:close"]) t.commands.get(id).run({});
    await t.settle();
    expect(t.ran).toEqual(["edit:term-1:details", "role:term-1", "edit:term-1:appearance", "conn:term-1", "close:term-1"]);
  });
  test("sem alvo, fechar avisa e não chama a página", async () => {
    const t = await mount(null);
    t.commands.get("tty:close").run({});
    await t.settle();
    expect(t.ran).toEqual([]);
    expect(t.notes.length).toBe(1);
  });
  test("Ctrl+Alt+W resolve para fechar mesmo com o teclado num campo, e o terminal focado o deixa passar", async () => {
    const t = await mount("term-1");
    const { ArgosNodeTerminal: NT } = await load();
    const cmd = t.commands.resolveKey(NT.ttyKeyInput({ key: "w", code: "KeyW", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }), { editable: true, ctx: {} });
    expect(cmd?.id).toBe("tty:close");
    expect(NT.ttyLetsCommand(true, "tty:close")).toBe(true);
    expect(NT.ttyLetsCommand(true, "term:edit")).toBe(false);
  });
  test("a ajuda de atalhos lista Fechar terminal com Ctrl+Alt+W, com ou sem alvo", async () => {
    const t = await mount(null);
    const row = t.commands.help({}).find((r: { id: string }) => r.id === "tty:close");
    expect(row?.shortcuts).toEqual(["mod+alt+w"]);
  });
  test("ferramenta e papéis rodam sem alvo", async () => {
    const t = await mount(null);
    t.commands.get("term:tool").run({});
    t.commands.get("term:roles").run({});
    await t.settle();
    expect(t.ran).toEqual(["arm", "roles"]);
  });
});

describe("tipo terminal ao lado dos tipos vivos (node-terminal.tsx, types-live.tsx, página)", () => {
  const NO_NET = { fetch: () => Promise.reject(new Error("sem rede no teste")), now: () => 0 };
  test("dado o terminal do canvas registrado antes, quando os tipos vivos montam, então ele fica e os outros vivos entram", async () => {
    const { ArgosNodeTerminal: NT, ArgosTypesLive: TL, M } = await load();
    const reg = M.argos.createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null });
    const render = () => null;
    NT.registerTerminalType(reg.types, render);
    TL.registerLiveTypes(reg.types, NO_NET);
    expect(reg.types.get("terminal").draw.render).toBe(render);
    for (const type of ["portal", "tree", "plan", "agent-file", "conversation"]) expect(reg.types.has(type)).toBe(true);
  });
  test("session/pane soltos sem herdr é o formato dos tipos vivos; com o par herdr, vazio ou incompleto, não", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    expect(NT.isLiveTerminalData({ session: "default", pane: "w1:p3", hasAgent: true })).toBe(true);
    expect(NT.isLiveTerminalData({ herdr: PANE })).toBe(false);
    expect(NT.isLiveTerminalData({ herdr: PANE, session: "default", pane: "w1:p3" })).toBe(false);
    expect(NT.isLiveTerminalData({ session: "default" })).toBe(false);
    expect(NT.isLiveTerminalData({})).toBe(false);
    expect(NT.isLiveTerminalData(null)).toBe(false);
  });
  test("a página registra o tipo terminal antes de montar os tipos vivos (senão o nó criado sai com o desenho deles)", () => {
    const page = readFileSync(join(uiDir, "pages/argos.tsx"), "utf8");
    const at = (s: string) => page.indexOf(s);
    expect(at("NT.registerTerminalType(")).toBeGreaterThan(-1);
    expect(at("NT.registerTerminalType(")).toBeLessThan(at("L.mountCanvasRegistries("));
  });
});
