// Fila das revisões de PR (src/lib/review-queue.ts): o teto vale para quem chega junto, o excedente espera sem falhar.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSlot, maxParallel, phaseFile, writePhase, type ReviewPhase } from "../../../src/lib/review-queue.ts";

const root = mkdtempSync(join(tmpdir(), "hades-review-fila-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Simula uma revisão: fila → checkout (segurando a vaga) → revisão, e devolve o que cada uma viu. */
async function disparar(total: number, max: number, dir: string) {
  const fase = new Map<number, ReviewPhase>();
  let emCheckout = 0;
  let picoCheckout = 0;
  let naFila = 0;
  let picoFila = 0;
  const falhas: number[] = [];
  await Promise.all(
    Array.from({ length: total }, async (_, n) => {
      fase.set(n, "fila");
      const slot = await acquireSlot({
        dir, max, pollMs: 5,
        onWait: () => { naFila++; picoFila = Math.max(picoFila, naFila); },
      });
      try {
        fase.set(n, "checkout");
        emCheckout++;
        picoCheckout = Math.max(picoCheckout, emCheckout);
        await tick(20);
        emCheckout--;
        fase.set(n, "revisão");
        await tick(10);
      } catch {
        falhas.push(n);
      } finally {
        slot.release();
      }
    }),
  );
  return { picoCheckout, picoFila, falhas, fase };
}

describe("fila das revisões", () => {
  test("dado 12 disparos juntos e teto 3, quando todos tentam o checkout, então no máximo 3 estão nele ao mesmo tempo", async () => {
    const r = await disparar(12, 3, join(root, "teto"));
    expect(r.picoCheckout).toBe(3);
    expect(r.falhas).toEqual([]);
    expect([...r.fase.values()].every((f) => f === "revisão")).toBe(true);
  });

  test("dado 12 disparos e teto 3, quando excedem o teto, então os 9 restantes esperam em fila e nenhum falha", async () => {
    const r = await disparar(12, 3, join(root, "fila"));
    expect(r.picoFila).toBe(9);
    expect(r.falhas).toEqual([]);
  });

  test("dado teto 1, quando duas revisões chegam, então a segunda só entra depois que a primeira solta a vaga", async () => {
    const dir = join(root, "um");
    const primeira = await acquireSlot({ dir, max: 1, pollMs: 5 });
    let admitida = false;
    const segunda = acquireSlot({ dir, max: 1, pollMs: 5 }).then((s) => { admitida = true; return s; });
    await tick(60);
    expect(admitida).toBe(false);
    primeira.release();
    const s = await segunda;
    expect(admitida).toBe(true);
    s.release();
  });

  test("dado uma vaga solta duas vezes, quando release repete, então não quebra nem libera a vaga de outro", async () => {
    const dir = join(root, "dupla");
    const a = await acquireSlot({ dir, max: 1, pollMs: 5 });
    a.release();
    const b = await acquireSlot({ dir, max: 1, pollMs: 5 });
    a.release();
    let terceira = false;
    const c = acquireSlot({ dir, max: 1, pollMs: 5 }).then((s) => { terceira = true; return s; });
    await tick(40);
    expect(terceira).toBe(false);
    b.release();
    (await c).release();
  });

  test("dado o relógio injetado, quando espera, então a espera não tem prazo e usa o sleep dado", async () => {
    const dir = join(root, "relogio");
    const ocupada = await acquireSlot({ dir, max: 1 });
    let voltas = 0;
    const s = await acquireSlot({ dir, max: 1, sleep: async () => { if (++voltas === 50) ocupada.release(); } });
    expect(voltas).toBe(50);
    s.release();
  });
});

describe("teto configurado", () => {
  const avisos: string[] = [];
  const com = (valor: string | undefined): number => {
    const antes = process.env.HADES_REVIEW_MAX_PARALLEL;
    if (valor === undefined) delete process.env.HADES_REVIEW_MAX_PARALLEL;
    else process.env.HADES_REVIEW_MAX_PARALLEL = valor;
    try {
      return maxParallel((m) => avisos.push(m));
    } finally {
      if (antes === undefined) delete process.env.HADES_REVIEW_MAX_PARALLEL;
      else process.env.HADES_REVIEW_MAX_PARALLEL = antes;
    }
  };

  test("dado um valor válido, então vale; dado zero, texto ou acima do limite, então cai em 4 e avisa", () => {
    expect(com("7")).toBe(7);
    expect(com("1")).toBe(1);
    avisos.length = 0;
    for (const ruim of ["0", "abc", "-2", "2.5", "99"]) expect(com(ruim)).toBe(4);
    expect(avisos).toHaveLength(5);
  });
});

describe("fase do job", () => {
  test("dado o id gerado pelo painel, então o arquivo da fase fica na pasta dos jobs; id fora do formato não vira caminho", () => {
    expect(phaseFile("20261103-155100-ab12", "/d")).toBe("/d/logs/panel-jobs/20261103-155100-ab12.phase");
    expect(phaseFile("../x", "/d")).toBeUndefined();
    expect(phaseFile(undefined, "/d")).toBeUndefined();
    expect(phaseFile("20261103-155100-ab12", undefined)).toBeUndefined();
  });

  test("dado uma fase, quando gravada, então o arquivo guarda só o nome", () => {
    const file = join(root, "fase.phase");
    writePhase(file, "checkout");
    expect(readFileSync(file, "utf8")).toBe("checkout\n");
    writePhase(undefined, "fila");
  });
});
