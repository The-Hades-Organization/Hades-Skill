/// <reference path="../../../kit/panel/ui/term-logic.tsx" />
// Interface do terminal (term-logic.tsx): retomada por offset, recuo, códigos de fechamento e de recusa, colar grande, link
// e a mesa de abas. Regra pura, sem navegador. Contrato: reference/panel.md §Terminal › Interface.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TERM_CLOSE, TERM_CODES, TERM_LIMITS } from "../../../src/panel/term-protocol.ts";
import "../../../kit/panel/ui/term-logic.tsx";

type Logic = ReturnType<typeof makeTermLogic>;
const T = (globalThis as unknown as { TermLogic: Logic }).TermLogic;
const UI = join(import.meta.dir, "../../../kit/panel/ui");
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);

describe("espelho do contrato do servidor", () => {
  test("dado term-protocol.ts, então os códigos de fechamento da interface são os mesmos", () => {
    expect(T.CLOSE).toMatchObject(TERM_CLOSE);
  });
  test("dado term-protocol.ts, então cada código de recusa que a interface usa existe lá com o mesmo texto", () => {
    for (const [name, value] of Object.entries(T.CODES)) expect((TERM_CODES as Record<string, string>)[name]).toBe(value);
  });
  test("dado term-protocol.ts, então os limites de entrada e de tamanho são os mesmos", () => {
    expect(T.LIMITS.inputBytes).toBe(TERM_LIMITS.inputBytes);
    expect(T.LIMITS.cols).toEqual({ min: TERM_LIMITS.cols.min, max: TERM_LIMITS.cols.max });
    expect(T.LIMITS.rows).toEqual({ min: TERM_LIMITS.rows.min, max: TERM_LIMITS.rows.max });
  });
});

describe("retomada por offset", () => {
  test("dado nenhum hello ainda, quando reconecta, então conecta sem offset", () => {
    expect(T.resumeOffset(T.offsetInitial())).toBeUndefined();
  });
  test("dado hello 100 e 40 bytes recebidos, quando reconecta, então pede 140", () => {
    const s = T.onBytes(T.onBytes(T.onHello(T.offsetInitial(), { offset: 100 }), 25), 15);
    expect(T.resumeOffset(s)).toBe(140);
  });
  test("dado bytes já contados, quando chega novo hello, então a contagem recomeça nele", () => {
    const s = T.onHello(T.onBytes(T.onHello(T.offsetInitial(), { offset: 0 }), 500), { offset: 500 });
    expect(T.resumeOffset(s)).toBe(500);
  });
  test("dado bytes contados, quando chega warn com offset, então a contagem zera nesse offset", () => {
    const s = T.onWarn(T.onBytes(T.onHello(T.offsetInitial(), { offset: 10 }), 90), { code: T.CODES.offsetTruncated, offset: 4096, lost: 300 });
    expect(T.resumeOffset(s)).toBe(4096);
  });
  test("dado warn sem offset, então o offset não muda", () => {
    const before = T.onBytes(T.onHello(T.offsetInitial(), { offset: 10 }), 5);
    expect(T.onWarn(before, { code: "term_bad_message" })).toEqual(before);
  });
  test("dado warn com offset 0, então zera mesmo assim (zero é um offset válido)", () => {
    const s = T.onWarn(T.onBytes(T.onHello(T.offsetInitial(), { offset: 10 }), 5), { code: T.CODES.offsetAhead, offset: 0 });
    expect(T.resumeOffset(s)).toBe(0);
  });
  test("dado contagem negativa, então ignora (não anda para trás)", () => {
    expect(T.resumeOffset(T.onBytes(T.onHello(T.offsetInitial(), { offset: 7 }), -50))).toBe(7);
  });
  test("dado warn que perdeu saída, então o aviso diz quanto; outros warn não geram aviso", () => {
    expect(T.warnNotice({ code: T.CODES.outputTruncated, lost: 1024 })).toContain("1024");
    expect(T.warnNotice({ code: T.CODES.offsetTruncated })).toBe("parte da saída anterior se perdeu");
    expect(T.warnNotice({ code: T.CODES.offsetAhead, offset: 5 })).toBeNull();
  });
  test("dado offset, então a URL do socket leva id e offset; sem offset, só o id; https vira wss", () => {
    expect(T.socketUrl({ protocol: "http:", host: "127.0.0.1:21220" }, ID_A, 140)).toBe(`ws://127.0.0.1:21220/api/term/ws?id=${ID_A}&offset=140`);
    expect(T.socketUrl({ protocol: "https:", host: "x.devtunnels.ms" }, ID_A, undefined)).toBe(`wss://x.devtunnels.ms/api/term/ws?id=${ID_A}`);
    expect(T.socketUrl({ protocol: "http:", host: "h" }, ID_A, 0)).toContain("&offset=0");
  });
});

describe("recuo da reconexão", () => {
  test("dado jitter neutro (0.5), então dobra a cada tentativa a partir de 500 ms", () => {
    expect([0, 1, 2, 3].map((n) => T.backoffMs(n, 0.5))).toEqual([500, 1000, 2000, 4000]);
  });
  test("dado muitas tentativas, então não passa do teto", () => {
    expect(T.backoffMs(40, 1)).toBeLessThanOrEqual(T.BACKOFF.capMs * (1 + T.BACKOFF.jitter));
    expect(T.backoffMs(10, 0.5)).toBe(T.BACKOFF.capMs);
  });
  test("dado os extremos do acaso, então o jitter fica dentro de ±25%", () => {
    expect(T.backoffMs(2, 0)).toBe(1500);
    expect(T.backoffMs(2, 1)).toBe(2500);
  });
  test("dado acaso fora de 0..1 ou tentativa negativa, então não quebra", () => {
    expect(T.backoffMs(-3, 9)).toBe(Math.round(500 * 1.25));
    expect(T.backoffMs(Number.NaN, 0.5)).toBe(500);
  });
  test("dado o limite de tentativas, então desiste na última e não antes", () => {
    expect(T.gaveUp(T.BACKOFF.maxAttempts - 1)).toBe(false);
    expect(T.gaveUp(T.BACKOFF.maxAttempts)).toBe(true);
  });
});

describe("códigos de fechamento", () => {
  test.each([
    [1000, "exited"], [4001, "replaced"], [4002, "closed"], [4003, "expired"], [4004, "shutdown"], [4005, "protocol"],
  ] as const)("dado %d, então para e mostra o motivo %s", (code, reason) => {
    expect(T.decideClose(code)).toEqual({ action: "stop", reason });
    expect(T.reasonText(reason).length).toBeGreaterThan(0);
  });
  test.each([1001, 1005, 1006, 1009, 1011, 4999])("dado %d (rede, 1009 ou desconhecido), então reconecta com o offset", (code) => {
    expect(T.decideClose(code)).toEqual({ action: "reconnect", reason: "drop" });
  });
  test("dado 4001, então a mensagem fala de outra tela", () => {
    expect(T.reasonText("replaced")).toContain("outra tela");
  });
});

describe("recusas pelo code (nunca pelo texto)", () => {
  test.each([
    [TERM_CODES.disabled, "disabled"], [TERM_CODES.maxSessions, "limit"], [TERM_CODES.rateLimited, "rate"], [TERM_CODES.forbiddenCwd, "cwd"],
    [TERM_CODES.kindUnavailable, "kind"], [TERM_CODES.unknownSession, "unknown_session"], [TERM_CODES.origin, "origin"], [TERM_CODES.spawnFailed, "failed"],
  ] as [string, TermRefusalKind][])("dado %s, então a recusa é %s", (code, kind) => {
    expect(T.refusal(code, 403).kind).toBe(kind);
  });
  test("dado term_disabled, então diz onde ligar", () => {
    expect(T.refusal(TERM_CODES.disabled, 403).hint).toContain("Configurações → Terminal");
  });
  test("dado term_rate_limited com Retry-After, então o aviso leva os segundos; sem ele, não inventa", () => {
    expect(T.refusal(TERM_CODES.rateLimited, 429, 17)).toMatchObject({ retryAfterS: 17 });
    expect(T.refusal(TERM_CODES.rateLimited, 429, 17).hint).toContain("17 s");
    expect(T.refusal(TERM_CODES.rateLimited, 429).hint).not.toMatch(/\d+ s/);
  });
  test("dado code desconhecido ou ausente, então cai na recusa genérica com o status, sem ler texto do servidor", () => {
    expect(T.refusal("term_algo_novo", 418)).toMatchObject({ kind: "request" });
    expect(T.refusal(undefined, 500).title).toContain("500");
  });
});

describe("colar grande", () => {
  const bytes = (n: number): Uint8Array => new Uint8Array(n).map((_, i) => i % 251);
  test("dado entrada vazia, então nenhum quadro", () => {
    expect(T.chunkInput(new Uint8Array(0))).toEqual([]);
  });
  test("dado exatamente 64 KiB, então um quadro; com 1 byte a mais, dois (64 KiB e 1)", () => {
    expect(T.chunkInput(bytes(65_536)).map((c) => c.length)).toEqual([65_536]);
    expect(T.chunkInput(bytes(65_537)).map((c) => c.length)).toEqual([65_536, 1]);
  });
  test("dado 200 KiB, então nenhum quadro passa de 64 KiB e a união devolve os mesmos bytes", () => {
    const input = bytes(200 * 1024);
    const parts = T.chunkInput(input);
    expect(parts.every((c) => c.length <= TERM_LIMITS.inputBytes)).toBe(true);
    const joined = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of parts) { joined.set(c, at); at += c.length; }
    expect(Array.from(joined)).toEqual(Array.from(input));
  });
  test("dado UTF-8 partido na fronteira, então os bytes seguem como vieram (o servidor aceita partição no meio do caractere)", () => {
    const text = new TextEncoder().encode("é".repeat(40_000));
    const parts = T.chunkInput(text);
    expect(parts[0]?.length).toBe(65_536);
    expect(parts.reduce((n, c) => n + c.length, 0)).toBe(text.length);
  });
});

describe("tamanho do terminal", () => {
  test("dado medida válida, então passa; fora dos limites, prende no limite do servidor", () => {
    expect(T.clampSize(120, 40)).toEqual({ cols: 120, rows: 40 });
    expect(T.clampSize(5, 2)).toEqual({ cols: 20, rows: 5 });
    expect(T.clampSize(900, 900)).toEqual({ cols: 500, rows: 200 });
  });
  test("dado aba oculta (0 colunas) ou NaN, então não há tamanho para mandar", () => {
    expect(T.clampSize(0, 24)).toBeNull();
    expect(T.clampSize(Number.NaN, 24)).toBeNull();
  });
  test("dado o mesmo tamanho, então não reenvia", () => {
    expect(T.sameSize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
    expect(T.sameSize({ cols: 80, rows: 24 }, null)).toBe(false);
  });
});

describe("links", () => {
  test("dado http e https, então abre; outros esquemas e lixo, não", () => {
    expect(T.safeUrl("https://exemplo.com/a?b=1")).toBe("https://exemplo.com/a?b=1");
    expect(T.safeUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://x", "vbscript:x", "//x.com", "nada"]) expect(T.safeUrl(bad)).toBeNull();
  });
  test("dado uma linha com URL entre texto, então devolve a faixa sem a pontuação final", () => {
    const line = "veja https://exemplo.com/x, ou (http://a.io/b).";
    const links = T.findLinks(line);
    expect(links.map((l) => l.url)).toEqual(["https://exemplo.com/x", "http://a.io/b"]);
    expect(line.slice(links[0]?.start, links[0]?.end)).toBe("https://exemplo.com/x");
  });
  test("dado linha sem link, vazia ou gigante, então nada (a gigante não vira custo)", () => {
    expect(T.findLinks("sem nada")).toEqual([]);
    expect(T.findLinks("")).toEqual([]);
    expect(T.findLinks(`https://a.io/${"x".repeat(5000)}`)).toEqual([]);
  });
});

describe("mesa de abas", () => {
  const two = T.layoutAdd(T.layoutAdd(T.layoutEmpty(), ID_A), ID_B);
  test("dado mesa vazia, quando abre duas, então a última fica ativa e sem split", () => {
    expect(two).toEqual({ tabs: [ID_A, ID_B], active: ID_B, split: null });
  });
  test("dado a mesma sessão aberta de novo, então não duplica a aba", () => {
    expect(T.layoutAdd(two, ID_A).tabs).toEqual([ID_A, ID_B]);
  });
  test("dado split na outra aba, quando escolhe a do split, então trocam de lugar", () => {
    const s = T.layoutSplit(two, ID_A);
    expect(T.layoutSelect(s, ID_A)).toEqual({ tabs: [ID_A, ID_B], active: ID_A, split: ID_B });
  });
  test("dado split igual à ativa ou aba inexistente, então o split se desfaz", () => {
    expect(T.layoutSplit(two, ID_B).split).toBeNull();
    expect(T.layoutSplit(two, ID_C).split).toBeNull();
  });
  test("dado fechar a ativa com split, então o split assume; sem split, a última restante", () => {
    const withSplit = T.layoutSplit(two, ID_A);
    expect(T.layoutRemove(withSplit, ID_B)).toEqual({ tabs: [ID_A], active: ID_A, split: null });
    expect(T.layoutRemove(two, ID_B)).toEqual({ tabs: [ID_A], active: ID_A, split: null });
  });
  test("dado fechar a última aba, então a mesa fica vazia", () => {
    expect(T.layoutRemove(T.layoutAdd(T.layoutEmpty(), ID_A), ID_A)).toEqual(T.layoutEmpty());
  });
  test("dado rascunho que abriu, então vira a sessão real no mesmo lugar", () => {
    const l = T.layoutReplace(T.layoutAdd(T.layoutAdd(T.layoutEmpty(), ID_A), "draft:1"), "draft:1", ID_C);
    expect(l).toEqual({ tabs: [ID_A, ID_C], active: ID_C, split: null });
  });
  test("dado sessões que sumiram do servidor, então saem da mesa, menos rascunho e recém-aberta", () => {
    const l = T.layoutAdd(T.layoutAdd(T.layoutAdd(T.layoutEmpty(), ID_A), ID_B), "draft:1");
    const pruned = T.layoutPrune(l, [ID_A], (id) => id.startsWith("draft:"));
    expect(pruned.tabs).toEqual([ID_A, "draft:1"]);
    expect(T.layoutPrune(l, [ID_A], (id) => id === ID_B || id.startsWith("draft:")).tabs).toEqual([ID_A, ID_B, "draft:1"]);
  });
  test("dado o que o sessionStorage guardou, então só ids de 32 hex entram; lixo vira mesa vazia", () => {
    expect(T.layoutParse(JSON.stringify({ tabs: [ID_A, "draft:1", 7, "../x"], active: ID_A, split: null }))).toEqual({ tabs: [ID_A], active: ID_A, split: null });
    for (const raw of [null, "", "{", "[]", '{"tabs":"x"}']) expect(T.layoutParse(raw)).toEqual(T.layoutEmpty());
  });
  test("dado id de retomada, então segue o formato do servidor", () => {
    expect(T.RESUME_RE.test("abc_DEF-123")).toBe(true);
    for (const bad of ["", "a b", "a;b", "x".repeat(65), "../x"]) expect(T.RESUME_RE.test(bad)).toBe(false);
  });
});

describe("fiação da interface", () => {
  const read = (f: string): string => readFileSync(join(UI, f), "utf8");
  test("dado o index.html, então xterm, addon e css carregam antes do term.js, e a regra antes de tudo", () => {
    const html = read("index.html");
    const at = (s: string): number => html.indexOf(s);
    expect(at('href="/ui/vendor/xterm.css"')).toBeGreaterThan(0);
    expect(at("/ui/vendor/xterm.js")).toBeLessThan(at("/ui/term.js"));
    expect(at("/ui/vendor/xterm-addon-fit.js")).toBeLessThan(at("/ui/term.js"));
    expect(at("/ui/term-logic.js")).toBeLessThan(at("/ui/term.js"));
    expect(at("/ui/app.js")).toBeLessThan(at("/ui/term.js"));
    expect(at("/ui/term.js")).toBeLessThan(at("/ui/pages/herdr.js"));
  });
  test("dado o term.tsx, então exporta o PtyTerminal nas duas APIs e não usa HTML cru nem link fora de http(s)", () => {
    const src = read("term.tsx");
    expect(src).toContain("HadesCore.PtyTerminal = PtyTerminal");
    expect(src).toContain("HadesPanel.PtyTerminal = PtyTerminal");
    expect(src).not.toMatch(/innerHTML|dangerouslySetInnerHTML|eval\(/);
    expect(src).toContain("allowNonHttpProtocols: false");
  });
  test("dado o vendor do xterm, então a licença acompanha e o aviso registra versão e sha256 reais", async () => {
    const notices = readFileSync(join(import.meta.dir, "../../../THIRD_PARTY_NOTICES.md"), "utf8");
    for (const f of ["xterm.js", "xterm.css", "xterm-addon-fit.js"]) {
      const sha = new Bun.CryptoHasher("sha256").update(readFileSync(join(UI, "vendor", f))).digest("hex");
      expect(notices).toContain(sha);
    }
    expect(notices).toContain("@xterm/xterm");
    expect(notices).toContain("6.0.0");
    expect(notices).toContain("0.11.0");
    expect(read("vendor/xterm-LICENSE.txt")).toContain("Permission is hereby granted");
  });
});
