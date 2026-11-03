// Grupo canvas-files-route: seletor de arquivos do compositor e anexo (src/panel/canvas-files.ts) — raiz pelo pane do herdr
// (nunca da tela), recusa de `..` e de link simbólico para fora do diretório do terminal, busca com tetos, sem ler conteúdo,
// e o anexo gravado com nome gerado e tipo da lista fechada. Pastas temporárias e um herdr de mentira.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSE_ATTACHMENT_PATH, FILES_ERRORS, TERMINAL_FILES_PATH, createCanvasFilesRoutes, paneCwdOf } from "../../../src/panel/canvas-files";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
let base = "";
let root = "";
let outside = "";
let data = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "canvas-files-"));
  root = join(base, "wt");
  outside = join(base, "fora");
  data = join(base, "data");
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "README.md"), "segredo que a rota nunca lê");
  writeFileSync(join(root, "src", "lib", "canvas-doc.ts"), "x");
  writeFileSync(join(root, "node_modules", "pkg", "canvas-doc.ts"), "x");
  writeFileSync(join(outside, "senha.txt"), "x");
  symlinkSync(outside, join(root, "atalho-fora"));
  symlinkSync(join(outside, "senha.txt"), join(root, "senha-fora.txt"));
  symlinkSync(join(root, "src"), join(root, "atalho-dentro"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const UNKNOWN_PANE = Symbol("sem pane");
const routes = (cwd: string | null | typeof UNKNOWN_PANE = root, limits = {}) =>
  createCanvasFilesRoutes({ dataDir: data, now: () => NOW, limits, paneCwd: async () => (cwd === UNKNOWN_PANE ? undefined : cwd) });
type Listing = { path: string; entries: { path: string; name: string; type: string }[]; truncated: boolean; code?: string };
const files = async (query: Record<string, string>, r = routes()): Promise<{ status: number; body: Listing }> => {
  const res = (await r.get(TERMINAL_FILES_PATH, { session: "default", pane: "w1:p1", ...query })) as Response;
  return { status: res.status, body: (await res.json()) as Listing };
};
const names = (body: Listing): string[] => body.entries.map((e) => `${e.type}:${e.path}`);

describe("seletor de arquivos do terminal", () => {
  test("dada a raiz, então lista pastas primeiro, links internos pelo alvo, sem os links para fora", async () => {
    const { status, body } = await files({});
    expect(status).toBe(200);
    expect(body.path).toBe("");
    expect(names(body)).toEqual(["dir:.git", "dir:atalho-dentro", "dir:node_modules", "dir:src", "file:README.md"]);
  });

  test("dado `..` no caminho, então recusa como caminho inválido", async () => {
    for (const path of ["..", "src/../..", "../fora"]) {
      const { status, body } = await files({ path });
      expect([status, body.code]).toEqual([400, FILES_ERRORS.invalidPath]);
    }
  });

  test("dado caminho absoluto, com barra invertida ou NUL, então recusa", async () => {
    for (const path of ["/etc", "src\\lib", "src\0"]) expect((await files({ path })).body.code).toBe(FILES_ERRORS.invalidPath);
  });

  test("dado link simbólico para fora do cwd pedido como pasta, então responde como inexistente", async () => {
    const { status, body } = await files({ path: "atalho-fora" });
    expect([status, body.code]).toEqual([404, FILES_ERRORS.pathNotFound]);
    expect(JSON.stringify(body)).not.toContain(outside);
  });

  test("dado link simbólico para dentro, então lista a pasta pelo caminho real", async () => {
    const { body } = await files({ path: "atalho-dentro" });
    expect(names(body)).toEqual(["dir:src/lib"]);
  });

  test("dado um arquivo como pasta, então recusa com not_directory", async () => {
    expect((await files({ path: "README.md" })).body.code).toBe(FILES_ERRORS.notDirectory);
  });

  test("dada uma busca, então acha pelo nome sem acento nem caixa e não desce em node_modules nem .git", async () => {
    const { body } = await files({ q: "CANVAS-doc" });
    expect(names(body)).toEqual(["file:src/lib/canvas-doc.ts"]);
  });

  test("dada pasta acima do teto de entradas, então corta com truncated", async () => {
    const { body } = await files({ q: "" }, routes(root, { entries: 2 }));
    expect([body.entries.length, body.truncated]).toEqual([2, true]);
  });

  test("dado alvo fora do formato do herdr, pane desconhecido ou pane sem diretório, então recusa com o código", async () => {
    expect((await files({ session: "../x" })).body.code).toBe(FILES_ERRORS.invalidTarget);
    expect((await files({ pane: "p1" })).body.code).toBe(FILES_ERRORS.invalidTarget);
    expect((await files({}, routes(UNKNOWN_PANE))).body.code).toBe(FILES_ERRORS.unknownPane);
    expect((await files({}, routes(null))).body.code).toBe(FILES_ERRORS.noCwd);
  });

  test("dada outra rota, então não responde", async () => {
    expect(await routes().get("/api/argos/graph", {})).toBeUndefined();
  });

  test("dado o retrato do herdr, então o diretório é o do processo em primeiro plano, senão o do pane", async () => {
    const herdr = { snap: async () => ({ panes: [{ pane_id: "w1:p1", foreground_cwd: "/a", cwd: "/b" }, { pane_id: "w1:p2", cwd: "/c" }, { pane_id: "w1:p3" }] }) };
    expect(await paneCwdOf(herdr, "default", "w1:p1")).toBe("/a");
    expect(await paneCwdOf(herdr, "default", "w1:p2")).toBe("/c");
    expect(await paneCwdOf(herdr, "default", "w1:p3")).toBeNull();
    expect(await paneCwdOf(herdr, "default", "w1:p9")).toBeUndefined();
    expect(await paneCwdOf({ snap: async () => null }, "x", "w1:p1")).toBeUndefined();
  });

  test("dada uma busca, então ela não segura o laço de eventos até terminar", async () => {
    let looped = false;
    setImmediate(() => {
      looped = true;
    });
    await files({ q: "canvas" });
    expect(looped).toBe(true);
  });

  test("dadas duas buscas do mesmo terminal, então a nova encerra a anterior com truncated", async () => {
    const r = routes();
    const [old, latest] = await Promise.all([files({ q: "canvas" }, r), files({ q: "canvas" }, r)]);
    expect([old.body.truncated, names(latest.body), latest.body.truncated]).toEqual([true, ["file:src/lib/canvas-doc.ts"], false]);
  });

  test("dadas buscas de terminais diferentes, então uma não encerra a outra", async () => {
    const r = routes();
    const [a, b] = await Promise.all([files({ q: "canvas" }, r), files({ q: "canvas", pane: "w1:p2" }, r)]);
    expect([a.body.truncated, b.body.truncated]).toEqual([false, false]);
  });
});

describe("anexo do compositor", () => {
  const post = async (body: unknown, r = routes()): Promise<{ status: number; body: Record<string, unknown> }> => {
    const req = new Request("http://x/", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
    const res = (await r.post(COMPOSE_ATTACHMENT_PATH, req, { remote: false })) as Response;
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

  test("dada uma imagem, então grava em canvas-compose com nome gerado e devolve o caminho", async () => {
    const { status, body } = await post({ name: "../../captura.png", type: "image/png", data: png });
    expect(status).toBe(200);
    expect(body.image).toBe(true);
    const path = String(body.path);
    expect(path.startsWith(join(data, "canvas-compose", "2026-11-02-"))).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(path).not.toContain("captura");
    expect(statSync(path).size).toBe(4);
  });

  test("dado tipo fora da lista, então recusa com 415", async () => {
    const { status, body } = await post({ name: "x.sh", type: "application/x-sh", data: png });
    expect([status, body.code]).toEqual([415, FILES_ERRORS.attachmentType]);
  });

  test("dado corpo que não é JSON, base64 inválido ou vazio, então recusa como anexo inválido", async () => {
    for (const body of ["{", { name: "a", type: "image/png", data: "@@" }, { name: "a", type: "image/png", data: "" }, { type: "image/png", data: png }]) {
      expect((await post(body)).body.code).toBe(FILES_ERRORS.invalidAttachment);
    }
  });

  test("dado anexo acima do teto, então recusa com 413", async () => {
    const { status, body } = await post({ name: "a", type: "text/plain", data: Buffer.alloc(64).toString("base64") }, routes(root, { attachmentBytes: 16 }));
    expect([status, body.code]).toEqual([413, FILES_ERRORS.attachmentTooLarge]);
  });

  test("dado anexo velho, quando outro é gravado, então o velho sai", async () => {
    const folder = join(data, "canvas-compose");
    mkdirSync(folder, { recursive: true });
    const old = join(folder, "2026-10-01-velho.png");
    writeFileSync(old, "x");
    utimesSync(old, new Date(NOW - 8 * 86_400_000), new Date(NOW - 8 * 86_400_000));
    await post({ name: "a", type: "image/png", data: png });
    expect(readdirSync(folder)).not.toContain("2026-10-01-velho.png");
  });

  test("dada outra rota, então não responde", () => {
    expect(routes().post("/api/argos/action", new Request("http://x/", { method: "POST" }), { remote: false })).toBeUndefined();
  });
});
