// Lote de revisões sem teto de seleção (#27): só a fila limita, e nenhum texto fala em "até 6".
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSlot } from "../../../src/lib/review-queue.ts";

const raiz = join(import.meta.dir, "../../..");
const ler = (rel: string): string => readFileSync(join(raiz, rel), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "hades-review-lote-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("lote de revisões", () => {
  test("dado 10 revisões e teto 4, quando todas disparam, então no máximo 4 rodam juntas e as 10 terminam", async () => {
    let rodando = 0;
    let pico = 0;
    let terminadas = 0;
    await Promise.all(Array.from({ length: 10 }, async () => {
      const slot = await acquireSlot({ dir: join(tmp, "vagas"), max: 4, pollMs: 5 });
      try {
        rodando++;
        pico = Math.max(pico, rodando);
        await tick(15);
        rodando--;
        terminadas++;
      } finally {
        slot.release();
      }
    }));
    expect(pico).toBe(4);
    expect(terminadas).toBe(10);
  });

  test("dado a tela, o tour e o comando, quando procuro o teto de seleção, então nenhum fala em 'até 6' nem em MAX_PRS", () => {
    for (const arq of ["kit/panel/ui/pages/reviews.tsx", "kit/panel/ui/pages/reviews.tour.tsx", "commands/hades.md", "reference/loop/review.md"]) {
      const texto = ler(arq);
      expect(texto).not.toMatch(/até 6|maximo 6|teto \*\*6\*\*|MAX_PRS/i);
    }
  });

  test("dado a página, quando alterno uma PR, então a seleção não é cortada por um máximo", () => {
    const fonte = ler("kit/panel/ui/pages/reviews.tsx");
    expect(fonte).toContain("t.has(n) ? t.delete(n) : t.add(n)");
    expect(fonte).toContain("Marcar todas");
    expect(fonte).toContain("Limpar");
  });
});
