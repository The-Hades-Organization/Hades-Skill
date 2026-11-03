// Grupo install-instance: HADES_ID, portas livres provadas por bind e registro das instâncias.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HadesError } from "../../../src/lib/output";
import { isPortFree, pickPort, resolveHadesId, sanitizeId } from "../../../src/lib/install-instance";

const T = mkdtempSync(join(tmpdir(), "hades-install-inst-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));
const listen = (port = 0): Promise<Server> => new Promise((ok, no) => { const s = createServer(); s.once("error", no); s.listen(port, "0.0.0.0", () => ok(s)); });
const close = (s: Server): Promise<void> => new Promise((ok) => s.close(() => ok()));

describe("install-instance: portas", () => {
  test("dado porta com alguém escutando, então isPortFree é falso e, depois de fechar, verdadeiro", async () => {
    const s = await listen(); const port = (s.address() as { port: number }).port;
    expect(await isPortFree(port)).toBe(false);
    await close(s);
    expect(await isPortFree(port)).toBe(true);
  });

  test("dado a primeira porta ocupada por bind, quando escolhe, então pula para a próxima livre", async () => {
    const s = await listen(); const busy = (s.address() as { port: number }).port;
    try {
      const got = await pickPort(busy, busy + 20, new Set());
      expect(got).toBeGreaterThan(busy);
      expect(await isPortFree(got as number)).toBe(true);
    } finally { await close(s); }
  });

  test("dado portas já gravadas em outras instâncias, então a escolha as evita mesmo livres", async () => {
    const free = async (): Promise<boolean> => true;
    expect(await pickPort(21220, 21225, new Set([21220, 21221]), free)).toBe(21222);
  });

  test("dado faixa inteira tomada, então não devolve porta", async () => {
    expect(await pickPort(10, 12, new Set(), async () => false)).toBeUndefined();
  });
});

describe("install-instance: HADES_ID", () => {
  test("dado nome de projeto, então o id é minúsculo, só [a-z0-9_], até 24 e sem _ no fim", () => {
    expect(sanitizeId("Meu Projeto-X!")).toBe("meu_projeto_x");
    expect(sanitizeId("a".repeat(30))).toBe("a".repeat(24));
    expect(sanitizeId("ab_cd_______________________x")).toBe("ab_cd");
  });

  const ctx = (data: string, over: Partial<Parameters<typeof resolveHadesId>[0]> = {}) => ({
    data, envId: undefined as string | undefined, project: "proj_a", slug: "o__repo", others: [] as string[], skipSystemd: false, say: () => undefined, sayErr: () => undefined, ...over,
  });

  test("dado env.sh existente com outro id que o do ambiente, então recusa com exit 1", () => {
    const d = join(T, "d1"); mkdirSync(d, { recursive: true }); writeFileSync(`${d}/env.sh`, 'HADES_ID="aa"\n');
    let err: unknown; try { resolveHadesId(ctx(d, { envId: "bb" })); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HadesError);
    expect((err as HadesError).code).toBe(1);
  });

  test("dado instalação nova com outra instância registrada, então o id vem do nome do projeto", () => {
    const d = join(T, "d2"); const o = join(T, "outra"); mkdirSync(o, { recursive: true }); writeFileSync(`${o}/env.sh`, 'HADES_ID=""\n');
    expect(resolveHadesId(ctx(d, { others: [o] }))).toBe("proj_a");
  });

  test("dado instalação nova sozinha na máquina, então o id é vazio (a original)", () => {
    expect(resolveHadesId(ctx(join(T, "d3")))).toBe("");
  });

  test("dado id igual ao de outra instância e systemd ligado, então recusa; sem systemd, só avisa", () => {
    const d = join(T, "d4"); const o = join(T, "outra2"); mkdirSync(o, { recursive: true }); writeFileSync(`${o}/env.sh`, 'HADES_ID="x"\n');
    expect(() => resolveHadesId(ctx(d, { envId: "x", others: [o] }))).toThrow(HadesError);
    expect(resolveHadesId(ctx(d, { envId: "x", others: [o], skipSystemd: true }))).toBe("x");
  });

  test("dado HADES_ID inválido, então recusa com exit 1", () => {
    expect(() => resolveHadesId(ctx(join(T, "d5"), { envId: "Maiúscula" }))).toThrow(HadesError);
  });
});
