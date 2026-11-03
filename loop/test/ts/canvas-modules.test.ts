// Grupo canvas-modules: como a UI recebe os módulos do modelo do canvas (src/panel/ui-transpile.ts + rotas em server.ts) —
// pacote único de src/lib/canvas-*.ts da lista permitida em /ui/lib/canvas-model.js, 404 fora da lista e com `..`,
// import fora da lista e link para fora de src/lib recusados, página do harness em /dev/canvas, scripts do motor como
// scripts clássicos, e o gerador determinístico do harness de escala.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_LIMITS, validateCanvasDoc, type CanvasDoc } from "../../../src/lib/canvas-doc";
import { CANVAS_HARNESS_HTML, CANVAS_UI_BUNDLE, CANVAS_UI_MODULES, createCanvasModuleBundler, createUiTranspiler } from "../../../src/panel/ui-transpile";
import { Rig, SKILL } from "./lib/rig";
import { fetchRaw, startTestPanel, widgetData } from "./lib/widget-rig";
import "../../../kit/panel/ui/argos/canvas-synth.tsx";

interface SynthApi {
  SYNTH_MAX: number;
  syntheticDoc(opts: { count: number; seed?: number }): CanvasDoc;
}
const synth = (globalThis as unknown as { ArgosCanvasSynth: SynthApi }).ArgosCanvasSynth;

const LIB = join(SKILL, "src", "lib");
const T = mkdtempSync(join(tmpdir(), "hades-canvas-modules-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

/** Avalia o pacote num escopo próprio e devolve o que ele registrou em `CanvasModel`. */
function evaluate(js: string): Record<string, Record<string, unknown>> {
  const scope: Record<string, unknown> = {};
  new Function("globalThis", js)(scope);
  return scope.CanvasModel as Record<string, Record<string, unknown>>;
}

/** Cópia de src/lib com só os arquivos da lista (e o que o teste quiser trocar). */
function libCopy(tag: string): string {
  const dir = join(T, tag);
  mkdirSync(dir, { recursive: true });
  for (const file of Object.values(CANVAS_UI_MODULES)) copyFileSync(join(LIB, file), join(dir, file));
  return dir;
}

/** GET com o caminho cru (o fetch normaliza `..` antes de mandar). */
function rawGet(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    let head = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("sem resposta do painel")));
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1");
    });
    socket.on("end", () => resolve(Number(head.split(" ")[1])));
    socket.on("error", reject);
  });
}

describe("canvas-modules: o pacote", () => {
  test("o pacote registra os quatro módulos da lista em CanvasModel, congelado", async () => {
    const js = await createCanvasModuleBundler(LIB).bundle(CANVAS_UI_BUNDLE);
    if (js === undefined) throw new Error("esperava o pacote");
    const model = evaluate(js);
    expect(Object.keys(model).sort()).toEqual(Object.keys(CANVAS_UI_MODULES).sort());
    expect(Object.isFrozen(model)).toBe(true);
    expect(typeof model.doc?.validateCanvasDoc).toBe("function");
    expect(typeof model.history?.applyOp).toBe("function");
    expect(typeof model.camera?.zoomAt).toBe("function");
    expect(typeof model.selection?.moveOp).toBe("function");
  });

  test("uma fonte só: o módulo do pacote se comporta como o do servidor (mesmo erro, mesmo código)", async () => {
    const js = await createCanvasModuleBundler(LIB).bundle(CANVAS_UI_BUNDLE);
    const model = evaluate(js as string);
    const validate = model.doc?.validateCanvasDoc as (raw: unknown) => unknown;
    expect(() => validate({ v: 1 })).toThrow();
    try {
      validate({ v: 1 });
    } catch (error) {
      expect((error as { code?: string }).code).toBe("canvas_invalid_shape");
    }
    expect((model.doc?.CANVAS_LIMITS as typeof CANVAS_LIMITS).nodes).toBe(CANVAS_LIMITS.nodes);
  });

  test("nome fora da lista não é empacotado", async () => {
    const bundler = createCanvasModuleBundler(LIB);
    for (const name of ["canvas-doc.js", "argos.js", "", "../canvas-model.js", "canvas-model.ts"]) expect(await bundler.bundle(name)).toBeUndefined();
  });

  test("módulo da lista que importa arquivo fora dela derruba o empacotamento", async () => {
    const dir = libCopy("import-fora");
    writeFileSync(join(dir, "segredo.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "canvas-camera.ts"), `import { x } from "./segredo.ts";\nexport const y = x;\n`);
    await expect(createCanvasModuleBundler(dir).bundle(CANVAS_UI_BUNDLE)).rejects.toThrow();
  });

  test("módulo da lista que importa Node derruba o empacotamento", async () => {
    const dir = libCopy("import-node");
    writeFileSync(join(dir, "canvas-camera.ts"), `import { readFileSync } from "node:fs";\nexport const y = readFileSync;\n`);
    await expect(createCanvasModuleBundler(dir).bundle(CANVAS_UI_BUNDLE)).rejects.toThrow();
  });

  test("arquivo da lista que é link para fora de src/lib é recusado (caminho real conferido na base)", async () => {
    const dir = libCopy("link-fora");
    const outside = join(T, "fora.ts");
    writeFileSync(outside, "export const z = 1;\n");
    rmSync(join(dir, "canvas-camera.ts"));
    symlinkSync(outside, join(dir, "canvas-camera.ts"));
    await expect(createCanvasModuleBundler(dir).bundle(CANVAS_UI_BUNDLE)).rejects.toThrow();
  });

  test("arquivo mudou: o pacote é refeito (cache por mtime)", async () => {
    const dir = libCopy("cache");
    const bundler = createCanvasModuleBundler(dir);
    const before = await bundler.bundle(CANVAS_UI_BUNDLE);
    expect(await bundler.bundle(CANVAS_UI_BUNDLE)).toBe(before);
    const path = join(dir, "canvas-camera.ts");
    writeFileSync(path, `${await Bun.file(path).text()}\nexport const MARCA_DO_TESTE = 1;\n`);
    const after = await bundler.bundle(CANVAS_UI_BUNDLE);
    expect(after).toContain("MARCA_DO_TESTE");
  });
});

describe("canvas-modules: pelo painel real", () => {
  const r = new Rig().setup();
  let P: Awaited<ReturnType<typeof startTestPanel>>;
  beforeAll(async () => {
    P = await startTestPanel(widgetData(r, "canvas-modules").D);
  });
  afterAll(() => {
    P?.stop();
    r.cleanup();
  });

  test("GET /ui/lib/canvas-model.js entrega o pacote como JavaScript", async () => {
    const res = await fetchRaw(P.base, `/ui/lib/${CANVAS_UI_BUNDLE}`);
    expect(res.status).toBe(200);
    expect(res.hdr.get("content-type")).toContain("javascript");
    expect(Object.keys(evaluate(res.text)).sort()).toEqual(Object.keys(CANVAS_UI_MODULES).sort());
  });

  test("fora da lista responde 404, mesmo arquivo que existe em src/lib", async () => {
    for (const path of ["/ui/lib/canvas-doc.js", "/ui/lib/canvas-doc.ts", "/ui/lib/argos.js", "/ui/lib/", "/ui/lib/x/canvas-model.js"]) {
      expect([path, (await fetchRaw(P.base, path)).status]).toEqual([path, 404]);
    }
  });

  test("com `..` (cru, codificado ou com barra codificada) responde 404 e nada sai de fora", async () => {
    for (const path of ["/ui/lib/../lib/canvas-doc.ts", "/ui/lib/..%2f..%2fpanel%2fserver.ts", "/ui/lib/%2e%2e/%2e%2e/src/lib/canvas-doc.ts", "/ui/lib/..%5ccanvas-doc.ts", "/ui/lib/canvas-model.js/.."]) {
      expect([path, await rawGet(P.port, path)]).toEqual([path, 404]);
    }
  });

  test("GET /dev/canvas é a página do harness (fora da navegação), sem token", async () => {
    const res = await fetchRaw(P.base, "/dev/canvas");
    expect(res.status).toBe(200);
    expect(res.text).toBe(CANVAS_HARNESS_HTML);
    expect(res.text).not.toContain(P.token);
    for (const src of [`/ui/lib/${CANVAS_UI_BUNDLE}`, "/ui/argos/canvas-engine.js", "/ui/argos/canvas-synth.js", "/ui/argos/canvas-harness.js"]) expect(res.text).toContain(`src="${src}"`);
  });
});

describe("canvas-modules: scripts do motor", () => {
  test("os .tsx do motor saem como scripts clássicos (sem import nem export depois da transpilação)", () => {
    const transpiler = createUiTranspiler();
    for (const file of ["canvas-engine.tsx", "canvas-synth.tsx", "canvas-harness.tsx"]) {
      const js = transpiler.transpile(join(SKILL, "kit", "panel", "ui", "argos", file));
      expect([file, /^\s*(import|export)\b/m.test(js)]).toEqual([file, false]);
    }
  });
});

describe("canvas-modules: gerador do harness de escala", () => {
  test("mesma semente, mesmo documento; semente diferente, documento diferente", () => {
    expect(synth.syntheticDoc({ count: 300, seed: 7 })).toEqual(synth.syntheticDoc({ count: 300, seed: 7 }));
    expect(synth.syntheticDoc({ count: 300, seed: 7 })).not.toEqual(synth.syntheticDoc({ count: 300, seed: 8 }));
  });

  test("1000 e 2000 nós passam na validação do documento, com arestas e alguns bloqueados", () => {
    for (const count of [1000, synth.SYNTH_MAX]) {
      const doc = validateCanvasDoc(synth.syntheticDoc({ count }));
      expect(doc.nodes).toHaveLength(count);
      expect(doc.edges.length).toBeGreaterThan(count / 4);
      expect(doc.nodes.some((n) => n.locked)).toBe(true);
    }
  });

  test("zero nós dá documento vazio válido; fora de 0..2000 ou fracionário é erro", () => {
    expect(validateCanvasDoc(synth.syntheticDoc({ count: 0 })).nodes).toEqual([]);
    for (const count of [-1, synth.SYNTH_MAX + 1, 1.5]) expect(() => synth.syntheticDoc({ count })).toThrow(RangeError);
  });
});
