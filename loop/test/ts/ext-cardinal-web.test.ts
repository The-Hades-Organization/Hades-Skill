// Rota estática do build web do Cardinal (U14): cabeçalhos por tipo de arquivo, contenção na pasta e o resto do painel em DENY.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { cardinalWebItem, webBuildVersion } from "../../../src/lib/doctor-ext";
import { send } from "../../../src/panel/http";
import { CARDINAL_WEB_ERRORS, createCardinalWebRoute } from "../../../src/panel/ext-cardinal-web";

let root: string;
let outside: string;
const WASM = new Uint8Array(4096).fill(7);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hades-cardweb-"));
  outside = mkdtempSync(join(tmpdir(), "hades-cardweb-out-"));
  mkdirSync(join(root, "dist", "assets"), { recursive: true });
  const dist = join(root, "dist");
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>c</title>");
  writeFileSync(join(dist, "assets", "cardinal_bg-DP8vFbtw.wasm"), WASM);
  writeFileSync(join(dist, "assets", "index-DamWOiy_.js"), "export const a = 1;".repeat(200));
  writeFileSync(join(dist, "assets", "index-DamWOiy_.js.br"), "BR");
  writeFileSync(join(dist, "icon.svg"), "<svg/>");
  writeFileSync(join(outside, "segredo.txt"), "fora");
  symlinkSync(join(outside, "segredo.txt"), join(dist, "assets", "fuga.js"));
  symlinkSync(outside, join(dist, "pasta-fora"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const route = (dir: string | undefined) => createCardinalWebRoute({ dir: () => dir });
const get = (path: string, headers: Record<string, string> = {}): Response | undefined => {
  const url = new URL(`http://127.0.0.1:1${path}`);
  return route(join(root, "dist")).serve(new Request(url.href, { headers }), url);
};

describe("arquivos do build", () => {
  test(".wasm: application/wasm, immutable e liberado para origem opaca", async () => {
    const res = get("/ext/cardinal/web/assets/cardinal_bg-DP8vFbtw.wasm");
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("application/wasm");
    expect(res?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res?.headers.get("access-control-allow-origin")).toBe("*");
    expect(res?.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(res?.headers.get("x-frame-options")).toBeNull();
    expect(new Uint8Array(await (res as Response).arrayBuffer())).toEqual(WASM);
  });

  test("index.html (também na raiz da rota) é no-cache", () => {
    for (const p of ["/ext/cardinal/web/index.html", "/ext/cardinal/web/", "/ext/cardinal/web"]) {
      const res = get(p);
      expect(res?.status).toBe(200);
      expect(res?.headers.get("cache-control")).toBe("no-cache");
      expect(res?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    }
    expect(get("/ext/cardinal/web/icon.svg")?.headers.get("cache-control")).toBe("no-cache");
  });

  test("gzip na hora quando aceito e o arquivo é compressível; sem Accept-Encoding vai cru", async () => {
    const res = get("/ext/cardinal/web/assets/cardinal_bg-DP8vFbtw.wasm", { "accept-encoding": "gzip" });
    expect(res?.headers.get("content-encoding")).toBe("gzip");
    expect(new Uint8Array(gunzipSync(new Uint8Array(await (res as Response).arrayBuffer())))).toEqual(WASM);
    expect(get("/ext/cardinal/web/assets/cardinal_bg-DP8vFbtw.wasm")?.headers.get("content-encoding")).toBeNull();
  });

  test(".br pré-comprimido ao lado tem prioridade", async () => {
    const res = get("/ext/cardinal/web/assets/index-DamWOiy_.js", { "accept-encoding": "gzip, br" });
    expect(res?.headers.get("content-encoding")).toBe("br");
    expect(res?.headers.get("vary")).toBe("Accept-Encoding");
    expect(await (res as Response).text()).toBe("BR");
  });
});

describe("contenção na pasta", () => {
  test("`..`, `%2e%2e`, barra invertida e NUL são recusados", () => {
    for (const p of ["/ext/cardinal/web/../x", "/ext/cardinal/web/%2e%2e/x", "/ext/cardinal/web/assets/..%2f..%2fx", "/ext/cardinal/web/a%5Cb", "/ext/cardinal/web/a%00b"]) {
      // o URL já normaliza `..` e `%2e%2e` para fora do prefixo (a rota nem responde); o resto chega e leva 404
      const res = get(p);
      expect(res === undefined || res.status === 404).toBe(true);
    }
    expect(get("/ext/cardinal/web/assets/..%2f..%2fx")?.status).toBe(404);
    expect(get("/ext/cardinal/web/a%5Cb")?.status).toBe(404);
    expect(get("/ext/cardinal/web/a%00b")?.status).toBe(404);
  });

  test("symlink que sai da pasta é recusado (arquivo e diretório)", () => {
    expect(get("/ext/cardinal/web/assets/fuga.js")?.status).toBe(404);
    expect(get("/ext/cardinal/web/pasta-fora/segredo.txt")?.status).toBe(404);
  });

  test("arquivo inexistente é 404 do build, não do painel", async () => {
    const res = get("/ext/cardinal/web/nada.js");
    expect(res?.status).toBe(404);
    expect(((await (res as Response).json()) as { code: string }).code).toBe(CARDINAL_WEB_ERRORS.notFound);
  });
});

describe("pasta ausente e outras rotas", () => {
  test("cardinal_web_missing sem configuração, com pasta inexistente ou sem index.html", async () => {
    for (const dir of [undefined, "", join(root, "nao-existe"), outside]) {
      const url = new URL("http://127.0.0.1:1/ext/cardinal/web/index.html");
      const res = route(dir).serve(new Request(url.href), url);
      expect(res?.status).toBe(404);
      expect(((await (res as Response).json()) as { code: string }).code).toBe(CARDINAL_WEB_ERRORS.missing);
    }
  });

  test("caminho fora do prefixo não é da rota", () => {
    expect(get("/ext/cardinalx")).toBeUndefined();
    expect(get("/api/snapshot")).toBeUndefined();
    expect(get("/ext/cardinal/webx/a")).toBeUndefined();
  });

  test("o resto do painel continua com X-Frame-Options DENY e sem CORS aberto", () => {
    const res = send(200, { ok: true });
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("doctor: versão do build web", () => {
  const present = (): boolean => true;
  test("versões iguais: ok; diferentes: aviso; sem versão declarada: ok", () => {
    expect(cardinalWebItem("/w", present, "0.2.0", () => "0.2.0")).toMatchObject({ level: "ok" });
    const diverge = cardinalWebItem("/w", present, "0.2.0", () => "0.1.0");
    expect(diverge.level).toBe("warn");
    expect(diverge.msg).toContain("0.1.0");
    expect(diverge.msg).toContain("0.2.0");
    expect(cardinalWebItem("/w", present, "0.2.0", () => undefined)).toMatchObject({ level: "ok" });
    expect(cardinalWebItem("/w", present, null, () => "0.1.0")).toMatchObject({ level: "ok" });
  });

  test("webBuildVersion lê version.txt e tolera ausência", () => {
    writeFileSync(join(root, "dist", "version.txt"), "cardinal-web 0.2.0\n");
    expect(webBuildVersion(join(root, "dist"))).toBe("0.2.0");
    expect(webBuildVersion(outside)).toBeUndefined();
  });
});
