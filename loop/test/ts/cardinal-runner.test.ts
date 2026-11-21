// Executor do binário e rotas de agente do nó cardinal (U9), com binário falso de respostas fixas.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { CARDINAL_FORMAT_MAX } from "../../../src/lib/canvas-cardinal";
import { CARDINAL_ROUTE_ERRORS, createCanvasCardinalRoutes, revisionOf } from "../../../src/panel/canvas-cardinal";
import { createCardinalRunner, launchCardinalApp, RUNNER_ERRORS, RunnerError } from "../../../src/panel/cardinal-runner";

type Dict = Record<string, unknown>;
const T = mkdtempSync(join(tmpdir(), "hades-runner-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));
const DOC = validateCanvasDoc({ v: 1, rev: 0, nodes: [{ id: "c1", type: "cardinal", x: 0, y: 0, w: 320, h: 220, z: 0, data: { cardinal: "pag" }, locked: false, blurred: false }], edges: [], groups: [] });
const sample = (tag: string): string => JSON.stringify({ format: "cardinal", version: CARDINAL_FORMAT_MAX, app: tag, project: { models: [{ diagram: {} }] } }) + "\n";
const local = { remote: false };
const BASE = "/api/canvas-cardinal/default/c1";
const post = (leaf: string, body: unknown): Request => new Request(`http://127.0.0.1${BASE}/${leaf}`, { method: "POST", body: JSON.stringify(body) });
const json = async (r: Response): Promise<Dict> => (await r.json()) as Dict;

let n = 0;
/** `script` é o corpo de um sh que recebe o subcomando em $1. */
function setup(script: string | undefined) {
  const D = join(T, `d${n++}`);
  mkdirSync(join(D, "canvas-cardinal"), { recursive: true });
  let bin: string | undefined;
  if (script !== undefined) {
    bin = join(D, "cardinal");
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
  }
  const runner = createCardinalRunner({ binary: () => bin });
  const routes = createCanvasCardinalRoutes(D, { loadDoc: async () => DOC, runner });
  const file = join(D, "canvas-cardinal", "pag.cardinal");
  return { D, runner, routes, file, bin };
}
const apply = `case "$1" in
 apply) while [ $# -gt 0 ]; do case "$1" in -o) out="$2";; esac; shift; done; cat > /dev/null; printf '%s\\n' '{"format":"cardinal","version":${CARDINAL_FORMAT_MAX},"app":"novo","project":{"models":[{"diagram":{}}]}}' > "$out";;
 export) cat > /dev/null; printf '<svg/>';;
 describe) cat > /dev/null; printf '{"schema":1,"diagrams":[]}';;
esac`;

describe("executor", () => {
  test("sem binário: cardinal_unavailable", async () => {
    await expect(createCardinalRunner({ binary: () => undefined }).run(["--version"])).rejects.toMatchObject({ code: RUNNER_ERRORS.unavailable });
  });
  test("ambiente mínimo: nada do painel chega ao binário", async () => {
    process.env.HADES_SECRET_TESTE = "x";
    const { runner } = setup('env | sort');
    const out = await runner.run([]);
    delete process.env.HADES_SECRET_TESTE;
    const names = out.stdout.toString().split("\n").map((l) => l.split("=")[0]);
    expect(names).not.toContain("HADES_SECRET_TESTE");
    expect(names).toContain("HOME");
  });
  test("teto de saída mata o processo; timeout também", async () => {
    const big = setup("head -c 100000 /dev/zero");
    await expect(big.runner.run([], { stdoutBytes: 1000 })).rejects.toMatchObject({ code: RUNNER_ERRORS.outputTooLarge });
    const slow = setup("sleep 5");
    await expect(slow.runner.run([], { timeoutMs: 100 })).rejects.toBeInstanceOf(RunnerError);
  });
  test("argv sem shell: metacaracteres chegam como texto", async () => {
    const { runner } = setup('printf "%s" "$1"');
    expect((await runner.run(["a; rm -rf x $(id)"])).stdout.toString()).toBe("a; rm -rf x $(id)");
  });
});

describe("rotas", () => {
  test("edit: aplica, grava, carimba o SVG e avisa", async () => {
    const t = setup(apply);
    writeFileSync(t.file, sample("velho"));
    const rev = revisionOf(readFileSync(t.file));
    const res = await (t.routes.action(`${BASE}/edit`, post("edit", { rev, text: "entity A" }), local) as Promise<Response>);
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(readFileSync(t.file, "utf8")).toContain("novo");
    expect(body.rev).toBe(revisionOf(readFileSync(t.file)));
    expect(readFileSync(join(t.D, "canvas-cardinal", "pag.svg.rev"), "utf8")).toBe(body.rev as string);
    const svg = await json(await (t.routes.get(`${BASE}/svg`, {}, local) as Promise<Response>));
    expect(svg.stale).toBe(false);
  });
  test("edit com rev velha: 409 sem gravar", async () => {
    const t = setup(apply);
    writeFileSync(t.file, sample("velho"));
    const res = await (t.routes.action(`${BASE}/edit`, post("edit", { rev: "0000", text: "x" }), local) as Promise<Response>);
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe(CARDINAL_ROUTE_ERRORS.staleRevision);
    expect(readFileSync(t.file, "utf8")).toContain("velho");
  });
  test("gravação entre a leitura e a escrita: repete sobre os bytes novos", async () => {
    // o binário falso muda o arquivo na primeira chamada de apply (como outro escritor durante o apply)
    const t = setup("");
    const marker = join(t.D, "once");
    writeFileSync(t.bin as string, `#!/bin/sh\n${apply.replace('apply) ', `apply) if [ ! -e ${marker} ]; then touch ${marker}; printf '%s' '${sample("concorrente").trim()}' > ${t.file}; fi; `)}\n`);
    writeFileSync(t.file, sample("velho"));
    const rev = revisionOf(readFileSync(t.file));
    const res = await (t.routes.action(`${BASE}/edit`, post("edit", { rev, text: "x" }), local) as Promise<Response>);
    expect(res.status).toBe(200);
    expect((await json(res)).attempts).toBe(2);
  });
  test("texto com erro de parse: 400 com a lista; falha do binário: 502", async () => {
    const parse = setup(`cat > /dev/null; printf '%s' '{"error":{"code":"parse","errors":[{"line":3,"col":8,"message":"x"}]}}'; exit 1`);
    writeFileSync(parse.file, sample("a"));
    const res = await (parse.routes.action(`${BASE}/edit`, post("edit", { rev: revisionOf(readFileSync(parse.file)), text: "?" }), local) as Promise<Response>);
    expect(res.status).toBe(400);
    expect(((await json(res)).errors as Dict[])[0]?.line).toBe(3);
    const bad = setup("exit 1");
    writeFileSync(bad.file, sample("a"));
    const r2 = await (bad.routes.action(`${BASE}/edit`, post("edit", { rev: revisionOf(readFileSync(bad.file)), text: "?" }), local) as Promise<Response>);
    expect(r2.status).toBe(502);
  });
  test("sem binário: describe e edit respondem cardinal_unavailable (503); o arquivo não muda", async () => {
    const t = setup(undefined);
    writeFileSync(t.file, sample("a"));
    const d = await (t.routes.get(`${BASE}/describe`, {}, local) as Promise<Response>);
    expect(d.status).toBe(503);
    expect((await json(d)).code).toBe(CARDINAL_ROUTE_ERRORS.unavailable);
    const e = await (t.routes.action(`${BASE}/edit`, post("edit", { rev: revisionOf(readFileSync(t.file)), text: "x" }), local) as Promise<Response>);
    expect(e.status).toBe(503);
    expect(existsSync(join(t.D, "canvas-cardinal", "pag.svg"))).toBe(false);
  });
  test("describe e export (svg/png) passam pelo binário", async () => {
    const t = setup(apply);
    writeFileSync(t.file, sample("a"));
    const d = await json(await (t.routes.get(`${BASE}/describe`, {}, local) as Promise<Response>));
    expect((d.describe as Dict).schema).toBe(1);
    const ex = await (t.routes.action(`${BASE}/export`, post("export", { format: "svg" }), local) as Promise<Response>);
    expect(await ex.text()).toBe("<svg/>");
    expect(ex.headers.get("content-type")).toBe("image/svg+xml");
    const bad = await (t.routes.action(`${BASE}/export`, post("export", { format: "pdf" }), local) as Promise<Response>);
    expect(bad.status).toBe(400);
  });
  test("SVG defasado volta marcado como defasado", async () => {
    const t = setup(apply);
    writeFileSync(t.file, sample("a"));
    await (t.routes.get(`${BASE}/svg`, {}, local) as Promise<Response>);
    writeFileSync(t.file, sample("b"));
    const svg = await json(await (t.routes.get(`${BASE}/svg`, {}, local) as Promise<Response>));
    expect(svg.stale).toBe(true);
  });
});

describe("convert", () => {
  const convertBin = `cat "$2" > /dev/null; printf '%s\\n' '{"format":"cardinal","version":${CARDINAL_FORMAT_MAX},"app":"conv","project":{"models":[{"diagram":{}}]}}'`;
  const conv = (t: ReturnType<typeof setup>, body: unknown) => t.routes.action("/api/canvas-cardinal/convert", post("convert", body), local) as Promise<Response>;
  test("devolve o texto convertido sem gravar arquivo", async () => {
    const t = setup(convertBin);
    const res = await conv(t, { from: "text", text: "entity A" });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.text as string).toContain('"conv"');
    expect(existsSync(t.file)).toBe(false);
  });
  test("linguagem fora da lista e corpo inválido: 400", async () => {
    const t = setup(convertBin);
    expect((await conv(t, { from: "nosql", text: "x" })).status).toBe(400);
    expect((await conv(t, { from: "text" })).status).toBe(400);
    expect((await conv(t, { from: "text", text: "x", arrange: "sim" })).status).toBe(400);
  });
  test("sem binário: 503 cardinal_unavailable", async () => {
    const res = await conv(setup(undefined), { from: "sql", text: "create table a(id int)" });
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe(CARDINAL_ROUTE_ERRORS.unavailable);
  });
  test("saída que não é um .cardinal: recusada (400)", async () => {
    const res = await conv(setup("printf 'lixo'"), { from: "text", text: "x" });
    expect(res.status).toBe(400);
  });
});

describe("abrir no app nativo", () => {
  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  test("launchCardinalApp passa só o arquivo e um ambiente enxuto (sem token)", async () => {
    const out = join(T, `launch${n}`);
    mkdirSync(out);
    const { D, bin } = setup(`printf '%s\\n' "$1" > ${out}/argv; env > ${out}/env`);
    const file = join(D, "canvas-cardinal", "pag.cardinal");
    const opened = await launchCardinalApp(bin as string, file, { PATH: process.env.PATH, HOME: "/h", HADES_PANEL_TOKEN: "segredo", INTERNAL_TOKEN: "x" });
    expect(opened).toBe(true);
    await until(() => existsSync(join(out, "env")));
    expect(readFileSync(join(out, "argv"), "utf8").trim()).toBe(file);
    const env = readFileSync(join(out, "env"), "utf8");
    expect(env).not.toContain("segredo");
    expect(env).not.toContain("HADES_PANEL_TOKEN");
  });

  test("binário que não executa resolve false, sem lançar", async () => {
    expect(await launchCardinalApp(join(T, "nao-existe"), "x.cardinal", {})).toBe(false);
  });

  describe("rota POST …/open", () => {
    const rig = (script: string | undefined, openNative?: (file: string) => Promise<boolean>) => {
      const s = setup(script);
      const routes = createCanvasCardinalRoutes(s.D, { loadDoc: async () => DOC, runner: s.runner, openNative });
      writeFileSync(s.file, sample("a"));
      const open = (path = `${BASE}/open`, caller = { remote: false }) => routes.action(path, new Request(`http://127.0.0.1${path}`, { method: "POST" }), caller) as Promise<Response>;
      return { ...s, open };
    };

    test("feliz: chama openNative com o arquivo do nó e responde o nome", async () => {
      const opened: string[] = [];
      const r = rig("true", async (file) => (opened.push(file), true));
      const res = await r.open();
      expect([res.status, await json(res)]).toEqual([200, { name: "pag", opened: true }]);
      expect(opened).toEqual([r.file]);
    });
    test("painel remoto: 403 cardinal_local_only e nada abre", async () => {
      let calls = 0;
      const r = rig("true", async () => (calls++, true));
      const res = await r.open(undefined, { remote: true });
      expect([res.status, (await json(res)).code, calls]).toEqual([403, "cardinal_local_only", 0]);
    });
    test("sem binário ou sem openNative: 503 cardinal_unavailable", async () => {
      for (const r of [rig(undefined, async () => true), rig("true")]) {
        const res = await r.open();
        expect([res.status, (await json(res)).code]).toEqual([503, "cardinal_unavailable"]);
      }
    });
    test("openNative devolve false: 503 cardinal_unavailable", async () => {
      const res = await rig("true", async () => false).open();
      expect([res.status, (await json(res)).code]).toEqual([503, "cardinal_unavailable"]);
    });
    test("nó fora do documento: 404, e a rota não abre nada", async () => {
      let calls = 0;
      const res = await rig("true", async () => (calls++, true)).open(`${BASE.replace("c1", "zz")}/open`);
      expect([res.status, calls]).toEqual([404, 0]);
    });
  });
});
