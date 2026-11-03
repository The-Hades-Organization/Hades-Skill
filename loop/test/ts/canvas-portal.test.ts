// Grupo canvas-portal: src/lib/canvas-portal.ts — URL aceita, lista de hosts, redirecionamento, pode embutir (X-Frame-Options e
// frame-ancestors), ambiente do chamador e o nó portal pela pilha de desfazer. Funções puras: sem rede, sem disco.
import { describe, expect, test } from "bun:test";
import { CANVAS_LIMITS, emptyCanvasDoc, type CanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, createHistory, perform, undo, redo } from "../../../src/lib/canvas-history";
import {
  buildPortalNode,
  buildPortalPolicy,
  checkPortalUrl,
  isHostAllowed,
  judgeEnvironment,
  judgeFraming,
  opCreatePortal,
  opSetPortalUrl,
  PORTAL_BLOCKS,
  PORTAL_DEFAULT_SIZE,
  PORTAL_ERRORS,
  PORTAL_LIMITS,
  PORTAL_NODE_TYPE,
  PortalError,
  portalViewOf,
  resolveRedirect,
} from "../../../src/lib/canvas-portal";

const nodeIn = (d: CanvasDoc, at: number) => d.nodes[at] ?? ((): never => { throw new Error(`sem nó na posição ${at}`); })();
const policy = buildPortalPolicy({ hadesHosts: ["painel.example.invalid"], extraHosts: "docs.example.invalid, *.apps.example.invalid" });

const codeOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    if (error instanceof PortalError) return error.code;
    throw error;
  }
  return "sem erro";
};

describe("canvas-portal: URL aceita", () => {
  test("http e https em localhost, com porta, caminho e consulta, saem normalizados", () => {
    expect(checkPortalUrl("http://localhost:21220/#/argos", policy).href).toBe("http://localhost:21220/#/argos");
    expect(checkPortalUrl("  HTTPS://LocalHost/a?b=1  ", policy).href).toBe("https://localhost/a?b=1");
    expect(checkPortalUrl("http://127.0.0.1:3000", policy).href).toBe("http://127.0.0.1:3000/");
    expect(checkPortalUrl("http://[::1]:8080/x", policy).hostname).toBe("[::1]");
  });

  test("só http e https: outros esquemas dão portal_scheme", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<b>oi</b>", "file:///etc/passwd", "localhost:3000", "ftp://localhost/", "blob:http://localhost/x"]) {
      expect(codeOf(() => checkPortalUrl(bad, policy))).toBe(PORTAL_ERRORS.scheme);
    }
  });

  test("usuário ou senha na URL dão portal_credentials, mesmo em host permitido", () => {
    expect(codeOf(() => checkPortalUrl("http://user@localhost/", policy))).toBe(PORTAL_ERRORS.credentials);
    expect(codeOf(() => checkPortalUrl("http://user:senha@localhost/", policy))).toBe(PORTAL_ERRORS.credentials);
    expect(codeOf(() => checkPortalUrl("http://:senha@localhost/", policy))).toBe(PORTAL_ERRORS.credentials);
  });

  test("vazio, não texto, sem esquema, com espaço ou controle dão portal_invalid_url", () => {
    for (const bad of ["", "   ", "http://", "http://local host/", "http://localhost/a\nb", "http://localhost/\u0000"]) {
      expect(codeOf(() => checkPortalUrl(bad, policy))).toBe(PORTAL_ERRORS.invalidUrl);
    }
    for (const bad of [undefined, null, 42, {}, ["http://localhost/"]]) {
      expect(codeOf(() => checkPortalUrl(bad, policy))).toBe(PORTAL_ERRORS.invalidUrl);
    }
  });

  test("teto de tamanho: no limite passa, um caractere acima dá portal_url_too_long", () => {
    const prefix = "http://localhost/";
    const atLimit = prefix + "a".repeat(PORTAL_LIMITS.urlChars - prefix.length);
    expect(atLimit.length).toBe(PORTAL_LIMITS.urlChars);
    expect(checkPortalUrl(atLimit, policy).href).toBe(atLimit);
    expect(codeOf(() => checkPortalUrl(`${atLimit}a`, policy))).toBe(PORTAL_ERRORS.urlTooLong);
  });

  test("host fora da lista dá portal_host_not_allowed; endereço interno disfarçado também", () => {
    for (const bad of [
      "http://example.com/",
      "http://localhost.evil.example/",
      "http://evil.example/localhost",
      "http://127.0.0.2/",
      "http://0.0.0.0/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::ffff:127.0.0.1]/",
      "http://foo.localhost/",
    ]) {
      expect(codeOf(() => checkPortalUrl(bad, policy))).toBe(PORTAL_ERRORS.hostNotAllowed);
    }
  });

  test("host do túnel, host extra e subdomínio de coringa passam; o domínio nu do coringa não", () => {
    expect(checkPortalUrl("https://painel.example.invalid/x", policy).host).toBe("painel.example.invalid");
    expect(checkPortalUrl("https://docs.example.invalid", policy).host).toBe("docs.example.invalid");
    expect(checkPortalUrl("https://a.apps.example.invalid", policy).host).toBe("a.apps.example.invalid");
    expect(checkPortalUrl("https://b.a.apps.example.invalid", policy).host).toBe("b.a.apps.example.invalid");
    expect(codeOf(() => checkPortalUrl("https://apps.example.invalid", policy))).toBe(PORTAL_ERRORS.hostNotAllowed);
    expect(codeOf(() => checkPortalUrl("https://xapps.example.invalid", policy))).toBe(PORTAL_ERRORS.hostNotAllowed);
  });

  test("a barra invertida, o ponto final e o inteiro decimal valem pelo host que o navegador entende", () => {
    expect(checkPortalUrl("http://localhost\\@evil.example/", policy).hostname).toBe("localhost");
    expect(checkPortalUrl("http://2130706433/", policy).href).toBe("http://127.0.0.1/");
    expect(checkPortalUrl("http://localhost./", policy).hostname).toBe("localhost.");
    expect(isHostAllowed("localhost.", policy)).toBe(true);
  });
});

describe("canvas-portal: política de hosts", () => {
  test("sem entrada, só os três de loopback", () => {
    const empty = buildPortalPolicy();
    expect([...empty.exact].sort()).toEqual(["127.0.0.1", "[::1]", "localhost"]);
    expect(empty.suffixes).toEqual([]);
    expect(empty.ignored).toEqual([]);
  });

  test("entradas inválidas e coringa largo demais vão para ignored, nunca viram permissão", () => {
    const built = buildPortalPolicy({ extraHosts: "*.com, *, *.*.x, ok.example.invalid, com espaço, http://x.invalid, -ruim.invalid, a..b" });
    expect(built.exact.has("ok.example.invalid")).toBe(true);
    expect(built.suffixes).toEqual([]);
    expect(built.ignored).toEqual(["*.com", "*", "*.*.x", "com espaço", "http://x.invalid", "-ruim.invalid", "a..b"]);
    expect(isHostAllowed("qualquer.com", built)).toBe(false);
  });

  test("maiúsculas, espaços, vírgulas sobrando e duplicados são normalizados", () => {
    const built = buildPortalPolicy({ hadesHosts: ["A.Example.Invalid"], extraHosts: " a.example.invalid ,, B.EXAMPLE.invalid. " });
    expect([...built.exact].filter((h) => h.endsWith(".invalid")).sort()).toEqual(["a.example.invalid", "b.example.invalid"]);
  });

  test("passou do teto de entradas, o resto vai para ignored e a lista não cresce", () => {
    const many = Array.from({ length: PORTAL_LIMITS.extraHosts + 3 }, (_, i) => `h${i}.example.invalid`).join(",");
    const built = buildPortalPolicy({ extraHosts: many });
    expect(built.ignored).toEqual(["h100.example.invalid", "h101.example.invalid", "h102.example.invalid"]);
    expect(built.exact.has("h99.example.invalid")).toBe(true);
    expect(built.exact.has("h100.example.invalid")).toBe(false);
  });

  test("host acima de 253 caracteres é ignorado", () => {
    const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(30)}`;
    expect(long.length).toBeGreaterThan(PORTAL_LIMITS.hostChars);
    expect(buildPortalPolicy({ extraHosts: long }).ignored).toEqual([long]);
  });
});

describe("canvas-portal: redirecionamento", () => {
  const from = new URL("http://localhost:3000/a");

  test("relativo e absoluto dentro da lista seguem", () => {
    expect(resolveRedirect(from, "/login", policy)?.href).toBe("http://localhost:3000/login");
    expect(resolveRedirect(from, "https://docs.example.invalid/x", policy)?.href).toBe("https://docs.example.invalid/x");
  });

  test("para fora da lista, sem Location, vazio, esquema ruim ou credencial: undefined", () => {
    for (const bad of ["https://example.com/", "//example.com/", null, "", "   ", "javascript:alert(1)", "http://u:p@localhost/"]) {
      expect(resolveRedirect(from, bad, policy)).toBeUndefined();
    }
  });
});

describe("canvas-portal: pode embutir (cabeçalhos)", () => {
  const page = "http://localhost:3000";
  const panel = "http://127.0.0.1:21220";
  const judgeAt = (headers: { frameOptions?: string | null; csp?: string | null }, ancestorOrigin: string | undefined) =>
    judgeFraming({ frameOptions: headers.frameOptions ?? null, csp: headers.csp ?? null }, { pageOrigin: page, ancestorOrigin });
  const judge = (headers: { frameOptions?: string | null; csp?: string | null }, ancestorOrigin: string = panel) => judgeAt(headers, ancestorOrigin);

  test("sem cabeçalho de moldura, embute", () => {
    expect(judge({})).toBeUndefined();
    expect(judge({ csp: "default-src 'self'; img-src *" })).toBeUndefined();
  });

  test("X-Frame-Options DENY bloqueia, em qualquer caixa e com espaço", () => {
    expect(judge({ frameOptions: "DENY" })).toBe(PORTAL_BLOCKS.frameOptionsDeny);
    expect(judge({ frameOptions: "  deny " })).toBe(PORTAL_BLOCKS.frameOptionsDeny);
  });

  test("SAMEORIGIN bloqueia de outra origem e libera na mesma origem", () => {
    expect(judge({ frameOptions: "SAMEORIGIN" })).toBe(PORTAL_BLOCKS.frameOptionsSameOrigin);
    expect(judge({ frameOptions: "sameorigin" }, page)).toBeUndefined();
    expect(judgeAt({ frameOptions: "sameorigin" }, undefined)).toBe(PORTAL_BLOCKS.frameOptionsSameOrigin);
  });

  test("ALLOW-FROM e valor desconhecido bloqueiam; lista com um DENY bloqueia", () => {
    expect(judge({ frameOptions: "ALLOW-FROM http://127.0.0.1:21220" })).toBe(PORTAL_BLOCKS.frameOptionsUnknown);
    expect(judge({ frameOptions: "talvez" })).toBe(PORTAL_BLOCKS.frameOptionsUnknown);
    expect(judge({ frameOptions: "SAMEORIGIN, DENY" }, page)).toBe(PORTAL_BLOCKS.frameOptionsDeny);
  });

  test("frame-ancestors 'none' e vazio bloqueiam", () => {
    expect(judge({ csp: "frame-ancestors 'none'" })).toBe(PORTAL_BLOCKS.cspFrameAncestors);
    expect(judge({ csp: "default-src 'self'; frame-ancestors" })).toBe(PORTAL_BLOCKS.cspFrameAncestors);
  });

  test("frame-ancestors 'self' vale só na mesma origem", () => {
    expect(judge({ csp: "frame-ancestors 'self'" })).toBe(PORTAL_BLOCKS.cspFrameAncestors);
    expect(judge({ csp: "frame-ancestors 'self'" }, page)).toBeUndefined();
  });

  test("frame-ancestors com * libera; com host, esquema ou porta confere a origem de quem embute", () => {
    expect(judge({ csp: "frame-ancestors *" })).toBeUndefined();
    expect(judgeAt({ csp: "frame-ancestors *" }, undefined)).toBeUndefined();
    expect(judge({ csp: "frame-ancestors http://127.0.0.1:21220" })).toBeUndefined();
    expect(judge({ csp: "frame-ancestors http://127.0.0.1:*" })).toBeUndefined();
    expect(judge({ csp: "frame-ancestors 127.0.0.1:21220" })).toBeUndefined();
    expect(judge({ csp: "frame-ancestors http:" })).toBeUndefined();
    expect(judge({ csp: "frame-ancestors https:" })).toBe(PORTAL_BLOCKS.cspFrameAncestors);
    expect(judge({ csp: "frame-ancestors http://127.0.0.1:9999" })).toBe(PORTAL_BLOCKS.cspFrameAncestors);
    expect(judge({ csp: "frame-ancestors http://127.0.0.1" })).toBe(PORTAL_BLOCKS.cspFrameAncestors);
    expect(judge({ csp: "frame-ancestors https://*.example.invalid" }, "https://painel.example.invalid")).toBeUndefined();
    expect(judge({ csp: "frame-ancestors https://*.example.invalid" }, "https://example.invalid")).toBe(PORTAL_BLOCKS.cspFrameAncestors);
    expect(judgeAt({ csp: "frame-ancestors http://127.0.0.1:21220" }, undefined)).toBe(PORTAL_BLOCKS.cspFrameAncestors);
  });

  test("a CSP com frame-ancestors vence o X-Frame-Options, como no navegador", () => {
    expect(judge({ csp: "frame-ancestors *", frameOptions: "DENY" })).toBeUndefined();
    expect(judge({ csp: "frame-ancestors 'none'", frameOptions: "" })).toBe(PORTAL_BLOCKS.cspFrameAncestors);
    expect(judge({ csp: "default-src 'self'", frameOptions: "DENY" })).toBe(PORTAL_BLOCKS.frameOptionsDeny);
  });

  test("várias políticas no cabeçalho: todas precisam permitir; a primeira diretiva de cada uma vale", () => {
    expect(judge({ csp: "frame-ancestors *, frame-ancestors 'none'" })).toBe(PORTAL_BLOCKS.cspFrameAncestors);
    expect(judge({ csp: "frame-ancestors *, default-src 'self'" })).toBeUndefined();
    expect(judge({ csp: "frame-ancestors 'none'; frame-ancestors *" })).toBe(PORTAL_BLOCKS.cspFrameAncestors);
  });
});

describe("canvas-portal: ambiente do chamador", () => {
  const local = new URL("http://localhost:3000/");
  const external = new URL("http://docs.example.invalid/");

  test("pelo acesso remoto, loopback vira link (localhost seria a máquina de quem olha)", () => {
    expect(judgeEnvironment(local, { remote: true, ancestorOrigin: "https://painel.example.invalid" })).toBe(PORTAL_BLOCKS.remoteLoopback);
    expect(judgeEnvironment(new URL("http://[::1]:1/"), { remote: true, ancestorOrigin: undefined })).toBe(PORTAL_BLOCKS.remoteLoopback);
    expect(judgeEnvironment(local, { remote: false, ancestorOrigin: "http://127.0.0.1:21220" })).toBeUndefined();
  });

  test("http dentro de painel https é conteúdo misto; https dentro de https e http dentro de http passam", () => {
    expect(judgeEnvironment(external, { remote: true, ancestorOrigin: "https://painel.example.invalid" })).toBe(PORTAL_BLOCKS.mixedContent);
    expect(judgeEnvironment(new URL("https://docs.example.invalid/"), { remote: true, ancestorOrigin: "https://painel.example.invalid" })).toBeUndefined();
    expect(judgeEnvironment(external, { remote: false, ancestorOrigin: "http://127.0.0.1:21220" })).toBeUndefined();
  });
});

describe("canvas-portal: o nó no documento (pilha de desfazer)", () => {
  const withNode = (): CanvasDoc => ({
    ...emptyCanvasDoc(),
    nodes: [{ id: "n1", type: "note", x: 0, y: 0, w: 10, h: 10, z: 4, data: { text: "oi" }, locked: false, blurred: false }],
  });

  test("buildPortalNode usa o tamanho padrão, fica acima dos demais e guarda só a URL normalizada", () => {
    const node = buildPortalNode(withNode(), { id: "p1", x: 5, y: 6, url: "HTTP://localhost:3000" }, policy);
    expect(node).toEqual({
      id: "p1", type: PORTAL_NODE_TYPE, x: 5, y: 6, ...PORTAL_DEFAULT_SIZE, z: 5, data: { url: "http://localhost:3000/" }, locked: false, blurred: false,
    });
  });

  test("tamanho e camada pedidos valem; camada no documento vazio começa em 1", () => {
    const sized = buildPortalNode(emptyCanvasDoc(), { id: "p1", x: 0, y: 0, w: 300, h: 200, z: 9, url: "http://localhost/" }, policy);
    expect([sized.w, sized.h, sized.z]).toEqual([300, 200, 9]);
    expect(buildPortalNode(emptyCanvasDoc(), { id: "p1", x: 0, y: 0, url: "http://localhost/" }, policy).z).toBe(1);
  });

  test("URL inválida, id repetido e documento cheio recusam sem tocar o documento", () => {
    const doc = withNode();
    const before = structuredClone(doc);
    expect(codeOf(() => buildPortalNode(doc, { id: "p1", x: 0, y: 0, url: "http://example.com/" }, policy))).toBe(PORTAL_ERRORS.hostNotAllowed);
    expect(codeOf(() => buildPortalNode(doc, { id: "n1", x: 0, y: 0, url: "http://localhost/" }, policy))).toBe(PORTAL_ERRORS.invalidNode);
    const full: CanvasDoc = {
      ...emptyCanvasDoc(),
      nodes: Array.from({ length: CANVAS_LIMITS.nodes }, (_, i) => ({ id: `n${i}`, type: "note", x: 0, y: 0, w: 1, h: 1, z: 0, data: {}, locked: false, blurred: false })),
    };
    expect(codeOf(() => buildPortalNode(full, { id: "novo", x: 0, y: 0, url: "http://localhost/" }, policy))).toBe(PORTAL_ERRORS.invalidNode);
    expect(doc).toEqual(before);
  });

  test("criar, desfazer e refazer: o desfazer volta exatamente ao documento anterior", () => {
    const doc = withNode();
    const before = structuredClone(doc);
    const created = perform(createHistory(), doc, opCreatePortal(doc, { id: "p1", x: 1, y: 2, url: "https://docs.example.invalid/a" }, policy));
    expect(created.doc.nodes.map((n) => n.id)).toEqual(["n1", "p1"]);
    expect(created.doc.nodes[1]?.data).toEqual({ url: "https://docs.example.invalid/a" });
    const undone = undo(created.history, created.doc);
    expect(undone?.doc).toEqual(before);
    const redone = redo((undone as NonNullable<typeof undone>).history, (undone as NonNullable<typeof undone>).doc);
    expect(redone?.doc).toEqual(created.doc);
    expect(doc).toEqual(before);
  });

  test("a operação aplicada direto também deixa o documento válido para o PUT", () => {
    const doc = emptyCanvasDoc();
    const next = applyOp(doc, opCreatePortal(doc, { id: "p1", x: 0, y: 0, url: "http://localhost:21220/" }, policy));
    expect(next.nodes).toHaveLength(1);
    expect(doc.nodes).toHaveLength(0);
  });
});

describe("canvas-portal: o que a UI desenha", () => {
  const node = (data: Record<string, unknown>, type = PORTAL_NODE_TYPE) => ({ type, data });

  test("URL boa vira ready com a forma normalizada", () => {
    expect(portalViewOf(node({ url: "http://localhost:21220" }), policy)).toEqual({ state: "ready", url: "http://localhost:21220/" });
  });

  test("documento importado com URL ruim, host que saiu da lista ou data vazio vira blocked com código", () => {
    expect(portalViewOf(node({ url: "javascript:alert(1)" }), policy)).toEqual({ state: "blocked", code: PORTAL_ERRORS.scheme });
    expect(portalViewOf(node({ url: "https://docs.example.invalid/" }), buildPortalPolicy())).toEqual({ state: "blocked", code: PORTAL_ERRORS.hostNotAllowed });
    expect(portalViewOf(node({}), policy)).toEqual({ state: "blocked", code: PORTAL_ERRORS.invalidUrl });
    expect(portalViewOf(node({ url: 7 }), policy)).toEqual({ state: "blocked", code: PORTAL_ERRORS.invalidUrl });
  });

  test("nó de outro tipo nunca vira ready", () => {
    expect(portalViewOf(node({ url: "http://localhost/" }, "note"), policy)).toEqual({ state: "blocked", code: PORTAL_ERRORS.invalidNode });
  });
});

describe("canvas-portal: trocar a URL pela pilha de desfazer", () => {
  const withPortal = (): CanvasDoc => ({
    ...emptyCanvasDoc(),
    nodes: [
      buildPortalNode(emptyCanvasDoc(), { id: "p1", x: 3, y: 4, w: 500, h: 300, url: "http://localhost:3000/a" }, policy),
      { id: "n1", type: "note", x: 0, y: 0, w: 10, h: 10, z: 0, data: {}, locked: false, blurred: false },
    ],
    edges: [{ id: "e1", from: "p1", to: "n1", kind: "link" }],
    groups: [{ id: "g1", label: "g", members: ["p1", "n1"] }],
  });

  test("troca a URL normalizada; o resto do nó, as arestas e os grupos seguem; o desfazer volta exato e o refazer repete", () => {
    const before = withPortal();
    const op = opSetPortalUrl(before, "p1", "HTTP://localhost:4000/b", policy)!;
    expect(op.kind).toBe("update");
    const first = perform(createHistory(), before, op);
    expect(first.doc.nodes[0]).toEqual({ ...nodeIn(before, 0), data: { url: "http://localhost:4000/b" } });
    expect(first.doc.edges).toEqual(before.edges);
    expect(first.doc.groups).toEqual(before.groups);
    const back = undo(first.history, first.doc)!;
    expect(back.doc).toEqual(before);
    expect(redo(back.history, back.doc)?.doc).toEqual(first.doc);
  });

  test("a mesma URL (mesmo escrita de outro jeito) não gera passo", () => {
    expect(opSetPortalUrl(withPortal(), "p1", "http://LOCALHOST:3000/a", policy)).toBeUndefined();
  });

  test("URL fora da política, com credencial, de outro esquema ou longa demais é recusada e o documento não muda", () => {
    const doc = withPortal();
    const frozen = structuredClone(doc);
    expect(codeOf(() => opSetPortalUrl(doc, "p1", "http://example.com/", policy))).toBe(PORTAL_ERRORS.hostNotAllowed);
    expect(codeOf(() => opSetPortalUrl(doc, "p1", "http://u:p@localhost/", policy))).toBe(PORTAL_ERRORS.credentials);
    expect(codeOf(() => opSetPortalUrl(doc, "p1", "ftp://localhost/", policy))).toBe(PORTAL_ERRORS.scheme);
    expect(codeOf(() => opSetPortalUrl(doc, "p1", `http://localhost/${"a".repeat(3000)}`, policy))).toBe(PORTAL_ERRORS.urlTooLong);
    expect(codeOf(() => opSetPortalUrl(doc, "p1", "", policy))).toBe(PORTAL_ERRORS.invalidUrl);
    expect(doc).toEqual(frozen);
  });

  test("nó que não existe ou não é portal é portal_invalid_node", () => {
    expect(codeOf(() => opSetPortalUrl(withPortal(), "zz", "http://localhost/", policy))).toBe(PORTAL_ERRORS.invalidNode);
    expect(codeOf(() => opSetPortalUrl(withPortal(), "n1", "http://localhost/", policy))).toBe(PORTAL_ERRORS.invalidNode);
  });
});
