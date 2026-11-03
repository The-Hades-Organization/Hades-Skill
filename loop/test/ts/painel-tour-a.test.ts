/// <reference path="../../../kit/panel/ui/globals.d.ts" />
// Lote tour-a do tour por página (overview, code, loop, orchestration, reviews): cada passo tem alvo no fonte ou fallback,
// a prévia (onde há) é só dado de exemplo marcado e a página sai do TOUR_PENDING. Contrato: reference/panel.md §Tour por página.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOUR_PENDING, tourGuardProblems, tourTargetsIn } from "../../../src/panel/tour-guard.ts";

const UI = join(import.meta.dir, "../../../kit/panel/ui");
const PAGES = join(UI, "pages");
const LOTE = ["overview", "code", "loop", "orchestration", "reviews"] as const;
const COM_PREVIA = ["loop", "orchestration", "reviews"] as const;
const SEM_PREVIA = ["overview", "code"] as const;

interface Passo { id: string; title: string; body: string; command?: string; ref?: string; fallback?: string }
interface Tour { steps: Passo[]; preview?: () => unknown }

const cache = new Map<string, Tour>();
async function carregar(id: string): Promise<Tour> {
  const feito = cache.get(id);
  if (feito) return feito;
  // roda o fonte como o navegador (script clássico com HadesCore em escopo) em vez de importar: o cache de módulos do bun
  // ignora a query e faria a guarda do painel-tour.test.ts achar o arquivo "já carregado" sem registrar nada
  const codigo = readFileSync(join(PAGES, `${id}.tour.tsx`), "utf8");
  let achado: Tour | undefined;
  new Function("HadesCore", codigo)({ registerTour: (pagina: string, def: Tour) => { if (pagina === id) achado = def; } });
  if (!achado) throw new Error(`${id}.tour.tsx não registrou o tour de ${id}`);
  cache.set(id, achado);
  return achado;
}
const fonte = (id: string): string => readFileSync(join(PAGES, `${id}.tsx`), "utf8");
const tudo = (v: unknown): string => JSON.stringify(v);

describe("tour-a: passos", () => {
  for (const id of LOTE) {
    test(`dada a página ${id}, então o primeiro passo é o cabeçalho e todo passo tem alvo no fonte ou fallback`, async () => {
      const tour = await carregar(id);
      expect(tour.steps[0]?.id).toBe(`tour-${id}`);
      const alvos = tourTargetsIn(fonte(id));
      for (const p of tour.steps) {
        if (p.id === `tour-${id}`) continue;
        expect(alvos.has(p.id) || (p.fallback ?? "").trim() !== "").toBe(true);
      }
    });
    test(`dada a página ${id}, então os ids dos passos são da página e não se repetem`, async () => {
      const ids = (await carregar(id)).steps.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const i of ids) expect(i === `tour-${id}` || i.startsWith(`${id}-`)).toBe(true);
    });
    test(`dada a página ${id}, então os alvos do fonte têm passo (nenhum card marcado fica sem explicação)`, async () => {
      const ids = new Set((await carregar(id)).steps.map((p) => p.id));
      // só o valor do atributo: tourTargetsIn pega toda palavra entre aspas da linha (className incluso)
      const marcados = [...fonte(id).matchAll(/data-tour-step-id="([^"]+)"/g)].map((m) => m[1] as string);
      expect(marcados.length).toBeGreaterThan(0);
      for (const alvo of marcados) expect(ids.has(alvo)).toBe(true);
    });
  }
});

describe("tour-a: prévia", () => {
  for (const id of COM_PREVIA) {
    test(`dada a página ${id}, então a prévia traz dados fictícios marcados como exemplo`, async () => {
      const tour = await carregar(id);
      expect(typeof tour.preview).toBe("function");
      const dados = (tour.preview as () => unknown)();
      const texto = tudo(dados);
      expect(texto).toContain("xemplo");
      expect(texto).not.toMatch(/hadson|ramalho|hades-skill|@/i);
    });
    test(`dada a página ${id}, então a página lê a prévia, põe o selo e o arquivo do tour não chama a rede`, async () => {
      const src = fonte(id);
      expect(src).toContain(`useTourPreview('${id}')`);
      expect(src).toContain("<ExampleSeal");
      const tourSrc = readFileSync(join(PAGES, `${id}.tour.tsx`), "utf8");
      expect(tourSrc).not.toMatch(/\bpost\(|fetch\(|getJSON\(/);
    });
  }
  test("dada a Revisões, então Revisar fica desligado com o exemplo na tela e nenhum item do exemplo está rodando", async () => {
    expect(fonte("reviews")).toContain("disabled={!nums.length || example}");
    const itens = ((await carregar("reviews")).preview as () => { items: { state: string; title: string }[] })().items;
    for (const i of itens) { expect(i.state).not.toBe("rodando"); expect(i.title.startsWith("Exemplo")).toBe(true); }
  });
  test("dada a Orquestração, então abrir arquivo ou terminal não dispara com o exemplo e nenhum agente de exemplo tem pane", async () => {
    expect(fonte("orchestration")).toContain("if (!exemplo) setSrc({ name, file });");
    const dados = ((await carregar("orchestration")).preview as () => { agents: { pane: string | null; name: string }[] })();
    for (const a of dados.agents) { expect(a.pane).toBeNull(); expect(a.name.startsWith("exemplo")).toBe(true); }
  });
  for (const id of SEM_PREVIA) {
    test(`dada a página ${id}, que sempre tem conteúdo, então o tour roda na tela real, sem prévia`, async () => {
      expect((await carregar(id)).preview).toBeUndefined();
      expect(fonte(id)).not.toContain("useTourPreview");
    });
  }
});

describe("tour-a: guarda", () => {
  test("dado o lote, então as cinco páginas saíram do TOUR_PENDING e a guarda não acusa problema nelas", async () => {
    for (const id of LOTE) expect(TOUR_PENDING).not.toContain(id);
    const problems = await tourGuardProblems(UI);
    expect(problems.filter((p) => LOTE.some((id) => p.startsWith(`página ${id}:`)))).toEqual([]);
  });
});
