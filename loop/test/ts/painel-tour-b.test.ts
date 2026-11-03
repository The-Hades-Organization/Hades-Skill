/// <reference path="../../../kit/panel/ui/globals.d.ts" />
// Tour da tour-b (queue, usage, claude, herdr, jobs): cada passo tem alvo no fonte da página ou fallback, nenhuma tem
// prévia (a decisão está no cabeçalho de cada .tour.tsx) e as cinco saíram do TOUR_PENDING com a guarda passando.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOUR_PENDING, tourGuardProblems, tourTargetsIn } from "../../../src/panel/tour-guard.ts";

const UI = join(import.meta.dir, "../../../kit/panel/ui");
const PAGES = ["queue", "usage", "claude", "herdr", "jobs"] as const;
const read = (rel: string): string => readFileSync(join(UI, rel), "utf8");
const STEP_ID = /^\s*id:\s*'([^']+)'/gm;
const stepIds = (id: string): string[] => [...read(`pages/${id}.tour.tsx`).matchAll(STEP_ID)].map((m) => m[1] as string);

describe("tour-b: lote queue, usage, claude, herdr, jobs", () => {
  test("dadas as páginas do lote, quando a guarda roda sem a lista pendente, então não acusa problema nelas", async () => {
    const problems = await tourGuardProblems(UI, TOUR_PENDING);
    expect(problems.filter((p) => PAGES.some((id) => p.startsWith(`página ${id}:`)))).toEqual([]);
  });

  test.each(PAGES)("dada a página %s, então saiu do TOUR_PENDING", (id) => {
    expect(TOUR_PENDING).not.toContain(id);
  });

  test.each(PAGES)("dada a página %s, então o primeiro passo é o cabeçalho e todo passo tem alvo no fonte ou fallback", (id) => {
    const ids = stepIds(id);
    expect(ids[0]).toBe(`tour-${id}`);
    const targets = tourTargetsIn(read(`pages/${id}.tsx`));
    const source = read(`pages/${id}.tour.tsx`);
    for (const step of ids.slice(1)) {
      const block = source.slice(source.indexOf(`id: '${step}'`)).split("\n    },")[0] ?? "";
      expect(targets.has(step) || block.includes("fallback:")).toBe(true);
    }
  });

  test.each(PAGES)("dada a página %s, então os alvos que ela declara são só ids que algum passo usa", (id) => {
    const used = new Set(stepIds(id));
    // só o valor do atributo (tourTargetsIn lê toda aspa da linha, inclusive className)
    for (const m of read(`pages/${id}.tsx`).matchAll(/data-tour-step-id="([^"]+)"/g)) expect(used.has(m[1] as string)).toBe(true);
  });

  test.each(PAGES)("dada a página %s, então não declara prévia e a página não lê useTourPreview", (id) => {
    expect(read(`pages/${id}.tour.tsx`)).not.toMatch(/preview\s*:/);
    expect(read(`pages/${id}.tsx`)).not.toContain("useTourPreview");
  });

  test.each(PAGES)("dada a página %s, então o tour não cita nome de projeto, pessoa nem caminho real", (id) => {
    expect(read(`pages/${id}.tour.tsx`)).not.toMatch(/\/home\/|@[a-z]+\.[a-z]+|Quito/);
  });
});
