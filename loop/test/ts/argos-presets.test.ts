// Grupo argos-presets: predefinições dos terminais do canvas (src/lib/argos-presets.ts) — validação, slug único, CRUD em
// `$D/argos/presets.json` e arquivo corrompido como erro alto (nunca lista vazia que a próxima gravação apagaria).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPresetStore, PRESET_LIMITS, validatePreset } from "../../../src/lib/argos-presets";
import { ARGOS_ERROR_CODES, ArgosError } from "../../../src/lib/argos-roles";

const T = mkdtempSync(join(tmpdir(), "hades-presets-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const PRESET = { name: "Claude rápido", agent: "claude", model: "claude-sonnet-5-5", effort: "medium" };
let n = 0;
const fresh = () => {
  const file = join(T, `p${n++}`, "argos", "presets.json");
  return { file, store: createPresetStore(file) };
};
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof ArgosError ? error.code : `outro: ${String(error)}`;
  }
  return undefined;
};

describe("argos-presets: validação", () => {
  test("campos ausentes ficam ausentes (seguem o padrão global); aparência e papel passam", () => {
    expect(validatePreset({ name: "Só agente", agent: "codex" })).toEqual({ name: "Só agente", agent: "codex" });
    expect(validatePreset({ ...PRESET, icon: "🛠", color: "#FFF", theme: "dark", font: "JetBrains Mono", role: "revisor", lixo: 1 })).toEqual({
      ...PRESET, icon: "🛠", color: "#fff", theme: "dark", font: "JetBrains Mono", role: "revisor",
    });
  });

  test("agente é obrigatório e de uma lista fechada; papel é slug; tema é identificador", () => {
    for (const bad of [
      { name: "x" }, { name: "x", agent: "sh" }, { ...PRESET, role: "../r" }, { ...PRESET, theme: "a b" }, { ...PRESET, name: "" },
      { ...PRESET, icon: "x".repeat(PRESET_LIMITS.icon + 1) },
    ]) expect(codeOf(() => validatePreset(bad))).toBe(ARGOS_ERROR_CODES.invalid);
  });
});

describe("argos-presets: CRUD em presets.json", () => {
  test("criar grava { presets: [...] } com slug a partir do nome; repetir o nome ganha -2", () => {
    const { file, store } = fresh();
    expect(store.save(PRESET).slug).toBe("claude-rapido");
    expect(store.save(PRESET).slug).toBe("claude-rapido-2");
    const doc = JSON.parse(readFileSync(file, "utf8")) as { presets: { slug: string }[] };
    expect(doc.presets.map((p) => p.slug)).toEqual(["claude-rapido", "claude-rapido-2"]);
  });

  test("atualizar troca o conteúdo e mantém slug e posição; slug inexistente é not-found", () => {
    const { store } = fresh();
    store.save(PRESET);
    store.save({ name: "Outro", agent: "gemini" });
    store.save({ name: "Renomeado", agent: "claude" }, "claude-rapido");
    expect(store.list()).toEqual([{ name: "Renomeado", agent: "claude", slug: "claude-rapido" }, { name: "Outro", agent: "gemini", slug: "outro" }]);
    expect(codeOf(() => store.save(PRESET, "nao-ha"))).toBe(ARGOS_ERROR_CODES.notFound);
  });

  test("apagar tira só a escolhida; apagar de novo é not-found", () => {
    const { store } = fresh();
    store.save(PRESET);
    store.save({ name: "Outro", agent: "gemini" });
    store.remove("claude-rapido");
    expect(store.list().map((p) => p.slug)).toEqual(["outro"]);
    expect(codeOf(() => store.remove("claude-rapido"))).toBe(ARGOS_ERROR_CODES.notFound);
  });

  test("sem arquivo a lista é vazia", () => {
    expect(fresh().store.list()).toEqual([]);
  });

  test("arquivo corrompido é erro alto na leitura e na gravação, e o arquivo fica como estava", () => {
    const { file, store } = fresh();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, '{"presets": 3}');
    expect(() => store.list()).toThrow("presets.json sem a lista presets");
    expect(() => store.save(PRESET)).toThrow();
    expect(readFileSync(file, "utf8")).toBe('{"presets": 3}');
  });
});
