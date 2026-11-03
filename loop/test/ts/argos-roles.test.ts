// Grupo argos-roles: papéis dos terminais do canvas (src/lib/argos-roles.ts) — validação do role.json portátil, slug a
// partir do nome com sufixo de colisão, CRUD em `$D/argos/roles/<slug>.json` e a descoberta de role.json até 3 níveis.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARGOS_ERROR_CODES, ArgosError, createRoleStore, DISCOVER_MAX_DEPTH, discoverRoles, ROLE_LIMITS, slugify, uniqueSlug, validateRole,
} from "../../../src/lib/argos-roles";

const T = mkdtempSync(join(tmpdir(), "hades-roles-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const ROLE = { name: "Revisor", color: "#A0b", instructions: "Revise o diff." };
let n = 0;
const fresh = (): { dir: string; warnings: string[]; store: ReturnType<typeof createRoleStore> } => {
  const dir = join(T, `r${n++}`);
  const warnings: string[] = [];
  return { dir, warnings, store: createRoleStore(dir, (event) => warnings.push(event)) };
};
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof ArgosError ? error.code : `outro: ${String(error)}`;
  }
  return undefined;
};

describe("argos-roles: validação e slug", () => {
  test("papel válido sai só com os campos do contrato e a cor em minúsculas", () => {
    expect(validateRole({ ...ROLE, agent: "claude", model: "claude-opus-5-5", effort: "high", extra: 1 })).toEqual({
      name: "Revisor", color: "#a0b", instructions: "Revise o diff.", agent: "claude", model: "claude-opus-5-5", effort: "high",
    });
  });

  test("campo fora do formato é invalid: cor, agente, esforço, nome com quebra, instruções vazias ou longas", () => {
    for (const bad of [
      { ...ROLE, color: "vermelho" }, { ...ROLE, agent: "bash" }, { ...ROLE, effort: "turbo" }, { ...ROLE, name: "a\nb" },
      { ...ROLE, instructions: "  " }, { ...ROLE, instructions: "x".repeat(ROLE_LIMITS.instructions + 1) }, [ROLE], null,
    ]) expect(codeOf(() => validateRole(bad))).toBe(ARGOS_ERROR_CODES.invalid);
  });

  test("slug: minúsculas sem acento, a-z0-9-, até 48; sem letra vira o padrão", () => {
    expect(slugify("Líder de Ação!")).toBe("lider-de-acao");
    expect(slugify("x".repeat(60))).toHaveLength(ROLE_LIMITS.slug);
    expect(slugify("!!!")).toBe("papel");
  });

  test("colisão ganha -2, -3, e o sufixo cabe no teto", () => {
    expect(uniqueSlug("revisor", new Set(["revisor", "revisor-2"]))).toBe("revisor-3");
    const long = "a".repeat(48);
    expect(uniqueSlug(long, new Set([long]))).toBe(`${"a".repeat(46)}-2`);
  });
});

describe("argos-roles: CRUD em $D/argos/roles", () => {
  test("criar grava <slug>.json sem o slug dentro e a lista devolve com o slug", () => {
    const { dir, store } = fresh();
    const entry = store.save(ROLE);
    expect(entry.slug).toBe("revisor");
    expect(JSON.parse(readFileSync(join(dir, "revisor.json"), "utf8"))).toEqual({ ...ROLE, color: "#a0b" });
    expect(store.list()).toEqual([{ ...ROLE, color: "#a0b", slug: "revisor" }]);
  });

  test("dois papéis com o mesmo nome ganham slugs distintos", () => {
    const { store } = fresh();
    expect([store.save(ROLE).slug, store.save(ROLE).slug]).toEqual(["revisor", "revisor-2"]);
  });

  test("atualizar com slug mantém o slug mesmo mudando o nome; slug inexistente é not-found", () => {
    const { store } = fresh();
    store.save(ROLE);
    expect(store.save({ ...ROLE, name: "Revisora" }, "revisor").slug).toBe("revisor");
    expect(store.get("revisor")?.name).toBe("Revisora");
    expect(codeOf(() => store.save(ROLE, "fantasma"))).toBe(ARGOS_ERROR_CODES.notFound);
  });

  test("apagar remove o arquivo; apagar de novo é not-found; slug com barra é invalid", () => {
    const { dir, store } = fresh();
    store.save(ROLE);
    store.remove("revisor");
    expect(existsSync(join(dir, "revisor.json"))).toBe(false);
    expect(codeOf(() => store.remove("revisor"))).toBe(ARGOS_ERROR_CODES.notFound);
    expect(codeOf(() => store.remove("../x"))).toBe(ARGOS_ERROR_CODES.invalid);
  });

  test("arquivo corrompido na pasta é pulado na lista e registrado, sem derrubar os outros", () => {
    const { dir, store, warnings } = fresh();
    store.save(ROLE);
    writeFileSync(join(dir, "quebrado.json"), "{");
    expect(store.list().map((r) => r.slug)).toEqual(["revisor"]);
    expect(warnings).toEqual(["papel ilegível"]);
  });

  test("pasta ainda inexistente lista vazio sem criá-la", () => {
    const { dir, store } = fresh();
    expect(store.list()).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("argos-roles: descoberta de role.json", () => {
  const root = join(T, "work");
  const put = (rel: string, body: unknown): void => {
    mkdirSync(join(root, rel), { recursive: true });
    writeFileSync(join(root, rel, "role.json"), typeof body === "string" ? body : JSON.stringify(body));
  };
  put("", { ...ROLE, name: "Raiz" });
  put("a/b/c", { ...ROLE, name: "Nível 3" });
  put("a/b/c/d", { ...ROLE, name: "Nível 4" });
  put("x", "{ quebrado");
  put(".oculta", { ...ROLE, name: "Oculta" });
  put("node_modules/pkg", { ...ROLE, name: "Dependência" });
  mkdirSync(join(T, "fora"), { recursive: true });
  writeFileSync(join(T, "fora", "role.json"), JSON.stringify({ ...ROLE, name: "Fora" }));
  symlinkSync(join(T, "fora"), join(root, "link"));

  test(`acha até ${DISCOVER_MAX_DEPTH} níveis abaixo; o 4º nível fica de fora`, () => {
    const names = discoverRoles(root, () => undefined).map((f) => f.role.name);
    expect(names).toContain("Nível 3");
    expect(names).not.toContain("Nível 4");
  });

  test("pula inválido (registrado), pasta oculta, dependências e link simbólico para fora", () => {
    const warnings: string[] = [];
    const found = discoverRoles(root, (event) => warnings.push(event));
    expect(found.map((f) => f.role.name).sort()).toEqual(["Nível 3", "Raiz"]);
    expect(found.map((f) => f.path).sort()).toEqual([join(root, "a/b/c/role.json"), join(root, "role.json")]);
    expect(warnings).toEqual(["role.json ignorado"]);
  });
});
