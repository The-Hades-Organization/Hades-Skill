// Grupo painel-ui-sombra: `.js` de instalação antiga não sombreia o `.tsx` (install remove, servidor prefere o fonte) e o
// redirect do tour só grava a marca quando redireciona de fato.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retireShadowedUiJs } from "../../../src/lib/install-copy";
import { startPanel } from "../../../src/panel/server.ts";

const T = mkdtempSync(join(tmpdir(), "hades-ui-sombra-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => { const d = join(T, `c${n++}`); mkdirSync(d, { recursive: true }); return d; };
const put = (path: string, text: string): void => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };

describe("install: .js obsoleto de panel/ui", () => {
  test("dado .js antigo ao lado de .tsx do kit, quando reinstala, então sai com um aviso por arquivo", () => {
    const kit = fresh(), d = fresh(), said: string[] = [];
    put(`${kit}/panel/ui/app.tsx`, "x"); put(`${kit}/panel/ui/pages/x.tsx`, "x");
    put(`${d}/panel/ui/app.js`, "velho"); put(`${d}/panel/ui/pages/x.js`, "velho");
    retireShadowedUiJs(kit, d, (l) => said.push(l));
    expect([existsSync(`${d}/panel/ui/app.js`), existsSync(`${d}/panel/ui/pages/x.js`)]).toEqual([false, false]);
    expect(said.length).toBe(2);
    expect(said[0]).toContain("panel/ui/app.js");
  });

  test("dado vendor, .js sem .tsx irmão e .js que o próprio kit traz, então ficam", () => {
    const kit = fresh(), d = fresh(), said: string[] = [];
    put(`${kit}/panel/ui/vendor/v.tsx`, "x"); put(`${kit}/panel/ui/dual.tsx`, "x"); put(`${kit}/panel/ui/dual.js`, "kit");
    for (const f of ["vendor/v.js", "sw.js", "tour.js", "dual.js"]) put(`${d}/panel/ui/${f}`, "fica");
    retireShadowedUiJs(kit, d, (l) => said.push(l));
    for (const f of ["vendor/v.js", "sw.js", "tour.js", "dual.js"]) expect(existsSync(`${d}/panel/ui/${f}`)).toBe(true);
    expect(said).toEqual([]);
  });

  test("dado $D sem panel/ui, então não faz nada", () => {
    expect(() => retireShadowedUiJs(fresh(), fresh(), () => undefined)).not.toThrow();
  });
});

describe("servidor: .tsx vence .js irmão", () => {
  test("dado app.js e app.tsx lado a lado, quando GET /ui/app.js, então devolve o transpilado do .tsx", async () => {
    const D = fresh();
    put(`${D}/panel/ui/app.js`, "window.VELHO = 1;\n");
    put(`${D}/panel/ui/app.tsx`, "window.NOVO = (1 as number);\n");
    put(`${D}/panel/ui/sw.js`, "// sem irmão\n");
    put(`${D}/snapshot.sh`, "#!/usr/bin/env bash\n");
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port as number;
    void probe.stop(true);
    const panel = await startPanel(D, port);
    try {
      const base = `http://127.0.0.1:${panel.port}`;
      const app = await (await fetch(`${base}/ui/app.js`)).text();
      expect(app).toContain("NOVO");
      expect(app).not.toContain("VELHO");
      expect(await (await fetch(`${base}/ui/sw.js`)).text()).toBe("// sem irmão\n");
    } finally { panel.stop(); }
  });
});

describe("tour: redirect da primeira etapa", () => {
  const SRC = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/tour.tsx"), "utf8");
  const code = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react" } } }).transformSync(SRC);

  /** Roda o Gate com ganchos de mentira (efeitos na hora) e devolve para onde navegou e o que gravou na sessão. */
  async function gate(hash: string, seen: string[] = []): Promise<{ went: string[]; stored: string[] }> {
    const store = new Set<string>(seen), went: string[] = [], stored: string[] = [];
    const React = { useLayoutEffect: () => undefined, Component: class {}, createElement: () => null };
    const core = {
      useState: (v: unknown) => [v, () => undefined], useEffect: (fn: () => unknown) => { fn(); }, useRef: (v: unknown) => ({ current: v }),
      useCallback: (fn: unknown) => fn, I: {}, cn: () => "", Button: () => null, post: () => undefined,
      route: () => (hash.replace(/^#\/?/, "").split("?")[0] || "overview"),
      getJSON: () => Promise.resolve({ complete: false, tour: "seen" }),
      TL: { subscribe: () => () => undefined, offerVisible: (offered: boolean) => offered, running: () => null },
    };
    const win = { addEventListener: () => undefined, removeEventListener: () => undefined };
    const sessionStorage = {
      getItem: (k: string) => (store.has(k) ? "1" : null), setItem: (k: string) => { store.add(k); stored.push(k); },
    };
    new Function("React", "HadesCore", "window", "location", "sessionStorage", "console", code)(React, core, win, { hash }, sessionStorage, console);
    const g = (win as unknown as { HadesTour: { Gate: (p: unknown) => unknown } }).HadesTour.Gate;
    g({ page: "overview", go: (id: string) => went.push(id) });
    await Bun.sleep(5);
    return { went, stored };
  }

  test("dado hash vazio, então redireciona para onboard e grava a marca", async () => {
    const r = await gate("");
    expect(r.went).toEqual(["onboard"]);
    expect(r.stored).toContain("hades-onboard-redirect");
  });
  test("dado #/overview, então redireciona como o vazio", async () => {
    expect((await gate("#/overview")).went).toEqual(["onboard"]);
  });
  test("dado outra página, então não redireciona e não grava a marca", async () => {
    const r = await gate("#/loop");
    expect(r.went).toEqual([]);
    expect(r.stored).not.toContain("hades-onboard-redirect");
  });
  test("dado outra página e depois a visão geral na mesma aba, então o redirect ainda acontece", async () => {
    expect((await gate("#/logs")).stored).not.toContain("hades-onboard-redirect");
    expect((await gate("#/overview")).went).toEqual(["onboard"]);
  });
  test("dado marca já gravada, então não redireciona de novo", async () => {
    expect((await gate("", ["hades-onboard-redirect"])).went).toEqual([]);
  });
});
