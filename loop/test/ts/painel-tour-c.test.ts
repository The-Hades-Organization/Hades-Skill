/// <reference path="../../../kit/panel/ui/tour-logic.tsx" />
/// <reference path="../../../kit/panel/ui/globals.d.ts" />
// Lote tour-c do tour por página (reference/panel.md §Tour por página): logs, notify, remote, cerberus e caronte.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOUR_PENDING, tourGuardProblems, tourTargetsIn } from "../../../src/panel/tour-guard.ts";

const UI = join(import.meta.dir, "../../../kit/panel/ui");
const PAGES = join(UI, "pages");
const LOTE = ["logs", "notify", "remote", "cerberus", "caronte"] as const;
const COM_PREVIA = ["cerberus", "caronte"] as const;
const SEM_PREVIA = LOTE.filter((id) => !(COM_PREVIA as readonly string[]).includes(id));

const source = (id: string): string => readFileSync(join(PAGES, `${id}.tsx`), "utf8");
const cache = new Map<string, PanelTour>();
async function loadTour(id: string): Promise<PanelTour> {
  const hit = cache.get(id);
  if (hit) return hit;
  const holder = globalThis as unknown as { HadesCore?: unknown };
  const seen: { id: string; def: PanelTour }[] = [];
  holder.HadesCore = { registerTour: (tourId: string, def: PanelTour) => { seen.push({ id: tourId, def }); } };
  try {
    await import(`${join(PAGES, `${id}.tour.tsx`)}?tour-c=${id}`);
  } finally { holder.HadesCore = undefined; }
  expect(seen.map((s) => s.id)).toEqual([id]);
  const def = seen[0]!.def;
  cache.set(id, def);
  return def;
}

describe("tour-c: guarda", () => {
  test("dadas as páginas do lote, então saíram do TOUR_PENDING e a guarda passa para o kit", async () => {
    expect(TOUR_PENDING.filter((p) => (LOTE as readonly string[]).includes(p))).toEqual([]);
    expect(await tourGuardProblems(UI)).toEqual([]);
  });
});

describe.each([...LOTE])("tour-c: %s", (id) => {
  test("dado o tour, então abre pelo passo da página e cada passo tem texto, alvo no fonte ou fallback", async () => {
    const def = await loadTour(id);
    const alvos = tourTargetsIn(source(id));
    expect(def.steps[0]?.id).toBe(`tour-${id}`);
    for (const s of def.steps) {
      expect(s.title.trim()).not.toBe("");
      expect(s.body.trim()).not.toBe("");
      const tem = s.id === `tour-${id}` || alvos.has(s.id) || (s.fallback ?? "").trim() !== "";
      expect(tem).toBe(true);
    }
  });
  test("dado o fonte, então todo id de alvo da página é usado por um passo (sem alvo órfão)", async () => {
    const def = await loadTour(id);
    const ids = new Set(def.steps.map((s) => s.id));
    const doAtributo = [...source(id).matchAll(/data-tour-step-id="([^"]+)"/g)].map((m) => m[1] ?? "");
    const orfaos = doAtributo.filter((a) => !ids.has(a));
    expect(orfaos).toEqual([]);
  });
  test("dado o tour, então os comandos citados são do hades ou do tunnel.sh, e ref aponta para a referência do painel", async () => {
    const def = await loadTour(id);
    for (const s of def.steps) {
      if (s.command !== undefined) expect(s.command).toMatch(/^(hades|tunnel\.sh) /);
      if (s.ref !== undefined) expect(s.ref).toMatch(/\.md/);
    }
  });
});

describe("tour-c: páginas sem prévia", () => {
  test.each(SEM_PREVIA)("dada %s (sempre tem conteúdo), então o tour roda na tela real", async (id) => {
    const def = await loadTour(id);
    expect(def.preview).toBeUndefined();
    expect(source(id)).not.toContain("useTourPreview");
  });
});

describe("tour-c: páginas com prévia", () => {
  type Item = { title?: string; name?: string };
  test("dada a prévia do Caronte, então os planos e pacotes são de exemplo e a página trava o Estacionar", async () => {
    const def = await loadTour("caronte");
    const data = (def.preview as () => { data: { plans: { name: string; agents: { name: string }[] }[]; packages: Item[] }; details: Record<string, { commands: { pack: string } }> })();
    expect(data.data.plans.length).toBeGreaterThan(0);
    for (const p of data.data.plans) {
      expect(p.name.startsWith("exemplo")).toBe(true);
      for (const a of p.agents) expect(a.name.startsWith("exemplo")).toBe(true);
      expect(data.details[p.name]).toBeDefined();
    }
    for (const k of data.data.packages) expect(k.name?.startsWith("exemplo")).toBe(true);
    const src = source("caronte");
    expect(src).toContain("useTourPreview('caronte')");
    expect(src).toContain("<ExampleSeal />");
    expect(src).toContain("disabled={busy || example}");
    expect(src).toContain("if (!selected || exemplo) return Promise.resolve();");
  });
  test("dada a prévia do Cerberus, então traz as listas todas, vereditos de exemplo, e a página não abre exceção nem blocos", async () => {
    const def = await loadTour("cerberus");
    const x = (def.preview as () => Record<string, unknown> & { cabecas: { id: string }[]; guardas: { id: string; titulo: string }[]; historico: { guarda: string }[] })();
    for (const k of ["erros", "cabecas", "guardas", "historico", "barrados", "excecoes", "blocos"]) expect(Array.isArray(x[k])).toBe(true);
    expect(x.cabecas.map((c) => c.id)).toEqual(["porta", "limiar", "vigilia"]);
    for (const g of x.guardas) { expect(g.id.startsWith("exemplo")).toBe(true); expect(g.titulo.startsWith("Exemplo")).toBe(true); }
    const ids = new Set(x.guardas.map((g) => g.id));
    for (const v of x.historico) expect(ids.has(v.guarda)).toBe(true);
    expect(x.blocos).toEqual([]);
    expect(x.remote).toBe(false);
    const src = source("cerberus");
    expect(src).toContain("useTourPreview('cerberus')");
    expect(src).toContain("disabled={remote || example}");
    expect(src).toContain("open={opening && !remote && !exemplo}");
    expect(src).toContain("(exemplo ? [] : x.cabecas.filter");
  });
  test.each(COM_PREVIA)("dada a prévia de %s, então o arquivo do tour não faz post nem rede e não cita projeto real", async (id) => {
    const tourSrc = readFileSync(join(PAGES, `${id}.tour.tsx`), "utf8");
    expect(tourSrc).not.toMatch(/\bpost\(|getJSON|fetch\(/);
    const def = await loadTour(id);
    expect(JSON.stringify((def.preview as () => unknown)())).not.toMatch(/\/home\/|@|github\.com/);
  });
});

describe("tour-c: cerberus, rótulo do botão das guardas", () => {
  // a página é script clássico (sem export): extrai a função pura pelo nome e avalia com o plural do app
  const fonteCerberus = readFileSync(join(PAGES, "cerberus.tsx"), "utf8");
  const linha = fonteCerberus.split("\n").find((l) => l.startsWith("const verGuardas = "));
  const plural = (n: number, um: string, varios: string): string => `${n.toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;
  const verGuardas = new Function("plural", `${linha}; return verGuardas;`)(plural) as (n: number) => string;
  test("dada uma guarda, então o botão diz 'Ver a guarda'", () => { expect(verGuardas(1)).toBe("Ver a guarda"); });
  test("dadas várias guardas, então o botão diz 'Ver as N guardas'", () => {
    expect(verGuardas(2)).toBe("Ver as 2 guardas");
    expect(verGuardas(12)).toBe("Ver as 12 guardas");
  });
});
