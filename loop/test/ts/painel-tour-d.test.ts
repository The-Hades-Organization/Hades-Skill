/// <reference path="../../../kit/panel/ui/tour-logic.tsx" />
/// <reference path="../../../kit/panel/ui/globals.d.ts" />
// Tours por página do lote tour-d (reference/panel.md §Tour por página): argos, onboard, plugins, quality, config e docs.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOUR_PENDING, tourGuardProblems, tourTargetsIn } from "../../../src/panel/tour-guard.ts";

const UI = join(import.meta.dir, "../../../kit/panel/ui");
const PAGES = join(UI, "pages");
const LOTE = ["argos", "onboard", "plugins", "quality", "config", "docs"] as const;
/** páginas do lote que podem aparecer vazias e por isso têm prévia de exemplo */
const COM_PREVIA: readonly string[] = ["plugins"];

interface Passo { id: string; title: string; body: string; command?: string; ref?: string; fallback?: string }
interface Tour { steps: Passo[]; preview?: () => unknown }

const lidos = new Map<string, Tour>();
/** registra o tour de `id` com um HadesCore falso (o import de cada arquivo roda uma vez por processo) */
async function carrega(id: string): Promise<Tour> {
  const cache = lidos.get(id);
  if (cache) return cache;
  const holder = globalThis as unknown as { HadesCore?: unknown };
  const vistos: { id: string; def: Tour }[] = [];
  holder.HadesCore = { registerTour: (pid: string, def: Tour) => { vistos.push({ id: pid, def }); } };
  try {
    await import(`${join(PAGES, `${id}.tour.tsx`)}?tour-d=${id}`);
  } finally { holder.HadesCore = undefined; }
  expect(vistos.map((v) => v.id)).toEqual([id]);
  const def = vistos[0]!.def;
  lidos.set(id, def);
  return def;
}
const fonte = (id: string): string => readFileSync(join(PAGES, `${id}.tsx`), "utf8");

describe("tour-d: guarda", () => {
  test("dado o lote, então nenhuma das suas páginas está no TOUR_PENDING e a guarda não acusa problema nelas", async () => {
    for (const id of LOTE) expect(TOUR_PENDING).not.toContain(id);
    const problems = await tourGuardProblems(UI);
    expect(problems.filter((p) => LOTE.some((id) => p.startsWith(`página ${id}:`)))).toEqual([]);
  });
});

for (const id of LOTE) {
  describe(`tour-d: ${id}`, () => {
    test("dado o tour, então abre pelo cabeçalho/introdução e cada passo tem texto e alvo no fonte ou fallback", async () => {
      const def = await carrega(id);
      expect(def.steps[0]?.id).toBe(`tour-${id}`);
      const alvos = tourTargetsIn([fonte(id), ...(id === "argos" ? argosPartes() : [])].join("\n"));
      for (const s of def.steps) {
        expect(s.title.trim()).not.toBe("");
        expect(s.body.trim().length).toBeGreaterThan(20);
        const ok = s.id === `tour-${id}` || alvos.has(s.id) || (s.fallback ?? "").trim() !== "";
        expect(ok).toBe(true);
      }
    });
    test("dado o tour, então os ids dos passos não se repetem", async () => {
      const def = await carrega(id);
      expect(new Set(def.steps.map((s) => s.id)).size).toBe(def.steps.length);
    });
    test(COM_PREVIA.includes(id) ? "dada a página que pode ficar vazia, então tem prévia" : "dada a página que sempre tem conteúdo, então não tem prévia", async () => {
      const def = await carrega(id);
      expect(typeof def.preview === "function").toBe(COM_PREVIA.includes(id));
    });
  });
}

function argosPartes(): string[] {
  return ["reading-bar", "canvas-toolbar", "canvas-controls", "canvas-overlays", "parts"].map((n) => readFileSync(join(UI, "argos", `${n}.tsx`), "utf8"));
}

describe("tour-d: argos", () => {
  test("dado o Argos, então o tour cobre estado, leitura, lista, ferramentas, câmera e minimapa, com alvos nos arquivos de argos/", async () => {
    const def = await carrega("argos");
    const ids = def.steps.map((s) => s.id);
    for (const id of ["argos-estado", "argos-leitura", "argos-lista", "argos-ferramentas", "argos-camera", "argos-minimapa"]) expect(ids).toContain(id);
    const alvos = tourTargetsIn(argosPartes().join("\n"));
    for (const id of ["argos-estado", "argos-leitura", "argos-lista", "argos-ferramentas", "argos-camera", "argos-minimapa"]) expect(alvos.has(id)).toBe(true);
  });
  test("dado o Argos, então o ? sozinho segue abrindo os atalhos e o tour abre pela paleta", () => {
    const src = fonte("argos");
    expect(src).toContain("HadesCore.startPageTour('argos')");
    expect(src).toContain("HadesCore.hasTour('argos')");
  });
});

describe("tour-d: plugins", () => {
  test("dada a prévia, então devolve pacotes marcados como exemplo, sem tocar na rede", async () => {
    const def = await carrega("plugins");
    const antes = globalThis.fetch;
    let chamadas = 0;
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => { chamadas++; return antes(...a); }) as typeof fetch;
    try {
      const dados = (def.preview as () => { list: { ok: boolean; remote: boolean; packs: { name: string; url: string; repo: string }[] } })();
      expect(chamadas).toBe(0);
      expect(dados.list.ok).toBe(true);
      expect(dados.list.remote).toBe(false);
      expect(dados.list.packs.length).toBe(2);
      for (const p of dados.list.packs) {
        expect(p.name).toContain("exemplo");
        expect(p.url).toContain("exemplo.invalid");
        expect(p.repo.startsWith("exemplo/")).toBe(true);
      }
    } finally { globalThis.fetch = antes; }
  });
  test("dada a página, então lê a prévia, marca o selo Exemplo e trava as ações enquanto o exemplo está na tela", () => {
    const src = fonte("plugins");
    expect(src).toContain("useTourPreview('plugins')");
    expect(src).toContain("<ExampleSeal />");
    expect(src).toContain("const locked = busy || !!exemplo;");
    expect(src).toContain("disabled={locked} onClick={() => setAdding(true)}");
    expect(src).toContain("busy={locked}");
  });
  test("dado o card sem dados, então os passos de pacote têm fallback dizendo como ligar", async () => {
    const def = await carrega("plugins");
    for (const id of ["plugins-pacote", "plugins-avisos", "plugins-acoes", "plugins-estado-pacote", "plugins-adicionar"]) {
      expect((def.steps.find((s) => s.id === id)?.fallback ?? "").length).toBeGreaterThan(20);
    }
  });
});

describe("tour-d: textos", () => {
  test("dado cada tour, então command e ref só existem quando preenchidos e o ref aponta para um documento", async () => {
    for (const id of LOTE) {
      const def = await carrega(id);
      for (const s of def.steps) {
        if (s.command !== undefined) expect(s.command.trim()).not.toBe("");
        if (s.ref !== undefined) expect(s.ref).toMatch(/^[\w-]+\.md( › .+)?$/);
      }
    }
  });
});
