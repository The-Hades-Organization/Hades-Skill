// Grupo canvas-cli-cardinal: `hades canvas cardinal` (src/commands/canvas.ts) contra as rotas reais do documento e do nó
// cardinal, com binário falso: o ciclo new → read → apply → export, o acesso (a cadeia só lê), link/unlink, adopt e a recusa sem binário.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_CLI_ERRORS, type CanvasCliDeps, cardinalNameFrom, runCanvas } from "../../../src/commands/canvas";
import { CARDINAL_FORMAT_MAX } from "../../../src/lib/canvas-cardinal";
import { type CanvasDoc, type CanvasEdge, type CanvasNode, emptyCanvasDoc } from "../../../src/lib/canvas-doc";
import { LINK_EDGE_KIND } from "../../../src/lib/canvas-links";
import { RECRUIT_EDGE_KIND } from "../../../src/lib/canvas-recruit";
import { EXIT } from "../../../src/lib/output";
import { createCanvasRoutes } from "../../../src/panel/canvas";
import { createCanvasCardinalRoutes } from "../../../src/panel/canvas-cardinal";
import { createCardinalRunner } from "../../../src/panel/cardinal-runner";

const T = realpathSync(mkdtempSync(join(tmpdir(), "hades-canvas-cli-cardinal-")));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const ORQ = "w0:p1";
const envelope = (app: string): string => `{"format":"cardinal","version":${CARDINAL_FORMAT_MAX},"app":"${app}","project":{"models":[{"diagram":{}}]}}`;
// $1 = subcomando; apply grava o envelope novo em -o; convert imprime o envelope; export e describe respondem fixo
const SCRIPT = `case "$1" in
 convert) cat "$2" > /dev/null; printf '%s\\n' '${envelope("convertido")}';;
 apply) while [ $# -gt 0 ]; do case "$1" in -o) out="$2";; esac; shift; done; cat > /dev/null; printf '%s\\n' '${envelope("aplicado")}' > "$out";;
 export) cat > /dev/null; printf '<svg/>';;
 describe) cat > /dev/null; printf '{"schema":1,"diagrams":[{"index":0,"name":"d","text":"entity A"}]}';;
esac`;

const terminal = (id: string, pane: string, data: Record<string, unknown> = {}): CanvasNode =>
  ({ id, type: "terminal", x: 100, y: 50, w: 400, h: 240, z: 1, data: { name: id, agent: "claude", herdr: { session: "default", pane }, ...data }, locked: false, blurred: false });
const cardinal = (id: string, name: string, title: string): CanvasNode =>
  ({ id, type: "cardinal", x: 900, y: 0, w: 320, h: 220, z: 1, data: { cardinal: name, title }, locked: false, blurred: false });
const edge = (id: string, from: string, to: string, kind: string): CanvasEdge => ({ id, from, to, kind });

let n = 0;
async function rig(doc: CanvasDoc, withBinary = true) {
  const D = join(T, `d${n++}`);
  mkdirSync(join(D, "canvas-cardinal"), { recursive: true });
  const bin = join(D, "cardinal");
  writeFileSync(bin, `#!/bin/sh\n${SCRIPT}\n`);
  chmodSync(bin, 0o755);
  const canvas = createCanvasRoutes(D, () => new Date("2026-11-02T12:00:00Z"));
  expect((await canvas.put(new Request("http://127.0.0.1/api/canvas", { method: "PUT", body: JSON.stringify({ ...doc, rev: 0 }) }), { remote: false })).status).toBe(200);
  const loadDoc = async (id: string): Promise<CanvasDoc | undefined> => {
    const res = canvas.getMany(`/api/canvases/${id}`);
    return res?.status === 200 ? ((await res.json()) as CanvasDoc) : undefined;
  };
  const routes = createCanvasCardinalRoutes(D, { loadDoc, roots: [D], runner: createCardinalRunner({ binary: () => (withBinary ? bin : undefined) }) });
  const req = (method: string, path: string, body: unknown): Request =>
    new Request(`http://127.0.0.1${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const reply = async (res: Response | undefined) => {
    if (!res) return { status: 404, body: { error: "not found" } };
    if ((res.headers.get("content-type") ?? "").startsWith("image/")) return { status: res.status, body: null, bytes: new Uint8Array(await res.arrayBuffer()) };
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
  };
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, Uint8Array>();
  const files = new Map<string, string>();
  const local = { remote: false };
  const sub = (path: string): string => path;
  const deps: CanvasCliDeps = {
    async panel(method, path, body) {
      if (method === "GET" && path === "/api/argos/graph") return { status: 200, body: { nodes: [] } };
      if (path.startsWith("/api/canvas-cardinal")) {
        const [clean = "", query = ""] = path.split("?");
        const asked = Object.fromEntries(new URLSearchParams(query));
        if (method === "POST") return reply(await routes.action(sub(clean), req(method, clean, body), local));
        if (method === "PUT") return reply(await routes.write(sub(clean), req(method, clean, body), local));
        if (clean === "/api/canvas-cardinal") return reply(routes.list(asked));
        return reply(await routes.get(sub(clean), asked, local));
      }
      if (path.startsWith("/api/canvases")) return reply(method === "GET" ? canvas.getMany(path) : await canvas.writeMany(method as "POST" | "PUT", path, {}, req(method, path, body), local));
      return { status: 404, body: { error: "not found" } };
    },
    async herdr() {
      return { rc: 0, err: "" };
    },
    caller: async () => ({ session: "default", pane: ORQ }),
    prReady: () => ({ assignee: "x", labels: "", reviewers: "" }),
    stdin: async () => "entity A",
    readText(path) {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error("sem arquivo"), { code: "ENOENT" });
      return text;
    },
    writeFile: (path, bytes) => void written.set(path, bytes),
    async notify() {
      return { rc: 0, err: "" };
    },
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
  };
  const run = async (...args: string[]): Promise<number> => {
    out.length = 0;
    err.length = 0;
    return runCanvas(args, deps);
  };
  const current = async (): Promise<CanvasDoc> => (await loadDoc("default")) as CanvasDoc;
  return { D, run, out, err, written, files, current };
}

const lastCode = (err: string[]): string | undefined => /\(([a-z_0-9]+)\)\s*$/.exec((err.at(-1) ?? "").split("\n")[0] ?? "")?.[1];

/** Chefe ligado direto a `c-direto`; `c-cadeia` só liga a `c-direto` (cadeia: lê, não escreve); `term-r1` é um terminal solto. */
const baseDoc = (): CanvasDoc => ({
  ...emptyCanvasDoc(),
  nodes: [terminal("term-orq", ORQ, { name: "Chefe", orchestrator: true }), terminal("term-r1", "w9:p1", { name: "Recruta", recruiter: "term-orq" }), cardinal("c-direto", "direto", "Direto"), cardinal("c-cadeia", "cadeia", "Cadeia")],
  edges: [edge("l1", "term-orq", "c-direto", LINK_EDGE_KIND), edge("l2", "c-direto", "c-cadeia", LINK_EDGE_KIND), edge("rec", "term-orq", "term-r1", RECRUIT_EDGE_KIND)],
});

describe("cardinalNameFrom", () => {
  test("slug sem acento, minúsculo, com hífen; vazio vira diagrama", () => {
    expect(cardinalNameFrom("Modelo Conceitual — Pagamentos")).toBe("modelo-conceitual-pagamentos");
    expect(cardinalNameFrom("???")).toBe("diagrama");
    expect(cardinalNameFrom("Ação")).toBe("acao");
  });
});

describe("canvas cardinal: ciclo", () => {
  test("new --from-text → read → apply → export", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("cardinal", "new", "Meu Modelo", "--from-text", "-")).toBe(EXIT.ok);
    expect(r.out.join("\n")).toContain("meu-modelo");
    const doc = await r.current();
    const node = doc.nodes.find((x) => x.type === "cardinal" && (x.data as { cardinal?: string }).cardinal === "meu-modelo");
    expect(node).toBeDefined();
    expect(doc.edges.some((e) => e.kind === LINK_EDGE_KIND && [e.from, e.to].includes("term-orq") && [e.from, e.to].includes((node as CanvasNode).id))).toBe(true);
    expect(readFileSync(join(r.D, "canvas-cardinal", "meu-modelo.cardinal"), "utf8")).toContain("convertido");

    expect(await r.run("cardinal", "read", "meu-modelo")).toBe(EXIT.ok);
    expect(r.out.join("\n")).toBe("entity A");

    r.files.set("novo.txt", "entity B");
    expect(await r.run("cardinal", "apply", "meu-modelo", "--text", "novo.txt")).toBe(EXIT.ok);
    expect(readFileSync(join(r.D, "canvas-cardinal", "meu-modelo.cardinal"), "utf8")).toContain("aplicado");

    expect(await r.run("cardinal", "export", "meu-modelo", "--svg")).toBe(EXIT.ok);
    expect(r.out.join("")).toBe("<svg/>");
    expect(await r.run("cardinal", "export", "meu-modelo", "--png")).toBe(EXIT.usage);
    expect(await r.run("cardinal", "export", "meu-modelo", "--svg", "-o", "/x/saida.svg")).toBe(EXIT.ok);
    expect(new TextDecoder().decode(r.written.get("/x/saida.svg"))).toBe("<svg/>");
  });
  test("read --file imprime o caminho absoluto do arquivo, do diagrama no diretório padrão e do adotado", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("cardinal", "new", "Meu Modelo", "--from-text", "-")).toBe(EXIT.ok);
    expect(await r.run("cardinal", "read", "meu-modelo", "--file")).toBe(EXIT.ok);
    expect(r.out).toEqual([join(r.D, "canvas-cardinal", "meu-modelo.cardinal")]);
    expect(r.err).toEqual([]);

    const own = join(r.D, "proprio.cardinal");
    writeFileSync(own, envelope("meu"));
    expect(await r.run("cardinal", "adopt", own)).toBe(EXIT.ok);
    expect(await r.run("cardinal", "read", "proprio", "--file")).toBe(EXIT.ok);
    expect(r.out).toEqual([own]);
  });
  test("new com nome repetido ganha sufixo -2", async () => {
    const r = await rig(baseDoc());
    await r.run("cardinal", "new", "Igual", "--from-text", "-");
    await r.run("cardinal", "new", "Igual", "--from-text", "-");
    const names = (await r.current()).nodes.flatMap((x) => (x.type === "cardinal" ? [(x.data as { cardinal: string }).cardinal] : []));
    expect(names).toContain("igual");
    expect(names).toContain("igual-2");
  });
  test("duas origens juntas: uso", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("cardinal", "new", "X", "--from-text", "-", "--from-sql", "-")).toBe(EXIT.usage);
  });
});

describe("canvas cardinal: acesso", () => {
  test("list mostra direto e cadeia", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("cardinal", "list")).toBe(EXIT.ok);
    const text = r.out.join("\n");
    expect(text).toContain("c-direto");
    expect(text).toContain("cadeia de Direto");
  });
  test("a cadeia lê mas não escreve; o que não se alcança é recusado", async () => {
    const r = await rig(baseDoc());
    writeFileSync(join(r.D, "canvas-cardinal", "cadeia.cardinal"), `${envelope("a")}\n`);
    expect(await r.run("cardinal", "read", "cadeia")).toBe(EXIT.ok);
    r.files.set("t.txt", "x");
    expect(await r.run("cardinal", "apply", "cadeia", "--text", "t.txt")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(CANVAS_CLI_ERRORS.cardinalWriteDirect);
    expect(await r.run("cardinal", "read", "inexistente")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(CANVAS_CLI_ERRORS.cardinalNoAccess);
  });
});

describe("canvas cardinal: link, unlink e adopt", () => {
  test("link liga o recruta ao diagrama direto; repetir não muda; unlink desliga", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("cardinal", "link", "c-direto", "term-r1")).toBe(EXIT.ok);
    expect(r.out.join("\n")).toContain("ligado");
    const edges = (await r.current()).edges.length;
    expect(await r.run("cardinal", "link", "c-direto", "term-r1")).toBe(EXIT.ok);
    expect(r.out.join("\n")).toContain("já estava ligado");
    expect((await r.current()).edges.length).toBe(edges);
    expect(await r.run("cardinal", "unlink", "c-direto", "term-r1")).toBe(EXIT.ok);
    expect((await r.current()).edges.length).toBe(edges - 1);
    expect(await r.run("cardinal", "unlink", "c-direto", "term-r1")).toBe(EXIT.ok);
    expect(r.out.join("\n")).toContain("não estava ligado");
  });
  test("link a diagrama que o chefe só alcança pela cadeia é recusado", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("cardinal", "link", "c-cadeia", "term-r1")).toBe(EXIT.fail);
  });
  test("adopt aponta para o arquivo e cria o nó; de novo, reaproveita o nó", async () => {
    const r = await rig(baseDoc());
    const file = join(r.D, "externo.cardinal");
    writeFileSync(file, `${envelope("ext")}\n`);
    expect(await r.run("cardinal", "adopt", file)).toBe(EXIT.ok);
    const count = (await r.current()).nodes.length;
    expect(await r.run("cardinal", "adopt", file)).toBe(EXIT.ok);
    expect(r.out.join("\n")).toContain("já tinha nó");
    expect((await r.current()).nodes.length).toBe(count);
  });
});

describe("canvas cardinal: sem binário", () => {
  test("new recusa e não cria nó", async () => {
    const r = await rig(baseDoc(), false);
    const before = (await r.current()).nodes.length;
    expect(await r.run("cardinal", "new", "X", "--from-text", "-")).toBe(EXIT.fail);
    expect((await r.current()).nodes.length).toBe(before);
  });
});
