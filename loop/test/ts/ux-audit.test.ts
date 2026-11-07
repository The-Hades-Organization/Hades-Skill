// Grupo ux-audit: itens de trabalho da auditoria de usabilidade (src/lib/ux-audit.ts) e a recusa sem Impeccable.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addItem, impeccableInstalled, itemKey, latestByKey, newRound, readLast, reminderText, roundItems, setStatus, sortItems, writeLast,
} from "../../../src/lib/ux-audit";

const T = mkdtempSync(join(tmpdir(), "hades-ux-audit-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));
const base = { page: "#/argos", rule: "contraste", severity: "alta", title: "Texto fraco", fix: "subir o contraste", evidence: [] as string[] };

describe("ux-audit", () => {
  test("a chave junta página e regra sem acento nem símbolo", () => {
    expect(itemKey("#/Argos", "Contraste Média")).toBe("argos--contraste-media");
    expect(itemKey("###", "x")).toBe("");
  });

  test("achado novo grava; o mesmo em outra rodada é repetido", () => {
    const root = join(T, "a");
    const r1 = newRound(root, "2026-11-07");
    expect(addItem(root, r1, base).kind).toBe("added");
    const r2 = newRound(root, "2026-11-07");
    expect(r2).toBe("2026-11-07-2");
    const again = addItem(root, r2, base);
    expect(again).toMatchObject({ kind: "duplicate", round: r1 });
    expect(roundItems(root, r2)).toHaveLength(0);
  });

  test("resolvido que volta entra como regressão", () => {
    const root = join(T, "b");
    const r1 = newRound(root, "2026-11-07");
    addItem(root, r1, base);
    setStatus(root, "argos--contraste", "resolved");
    const r2 = newRound(root, "2026-11-08");
    const res = addItem(root, r2, base);
    expect(res.kind).toBe("added");
    expect(latestByKey(root).get("argos--contraste")).toMatchObject({ regression: true, round: r2, status: "open" });
  });

  test("entrada inválida é recusada", () => {
    const root = join(T, "c");
    const r = newRound(root, "2026-11-07");
    expect(addItem(root, r, { ...base, severity: "urgente" }).kind).toBe("invalid");
    expect(addItem(root, r, { ...base, title: " " }).kind).toBe("invalid");
    expect(addItem(root, "2026-01-01", base).kind).toBe("invalid");
  });

  test("captura existente é copiada para a rodada", () => {
    const root = join(T, "d");
    const r = newRound(root, "2026-11-07");
    const png = join(T, "cap.png");
    writeFileSync(png, "x");
    const res = addItem(root, r, { ...base, evidence: [png, "linha 12 do argos.tsx"] });
    expect(res.kind === "added" && res.item.evidence).toEqual(["capturas/cap.png", "linha 12 do argos.tsx"]);
    expect(existsSync(join(root, r, "capturas", "cap.png"))).toBe(true);
  });

  test("ordena por severidade", () => {
    const root = join(T, "e");
    const r = newRound(root, "2026-11-07");
    addItem(root, r, { ...base, rule: "a", severity: "baixa" });
    addItem(root, r, { ...base, rule: "b", severity: "bloqueante" });
    expect(sortItems(roundItems(root, r)).map((i) => i.rule)).toEqual(["b", "a"]);
  });

  test("lembrete: desligado, sem rodada, UI mudou e UI igual", () => {
    expect(reminderText("off", "abc", undefined)).toBeUndefined();
    expect(reminderText("release", "", undefined)).toBeUndefined();
    expect(reminderText("release", "abc", undefined)).toContain("ainda não passaram");
    expect(reminderText("release", "abc", { round: "2026-11-01", uiCommit: "old" })).toContain("2026-11-01");
    expect(reminderText("release", "abc", { round: "2026-11-01", uiCommit: "abc" })).toBeUndefined();
  });

  test("last.json vai e volta", () => {
    const root = join(T, "f");
    writeLast(root, { round: "2026-11-07", uiCommit: "abc" });
    expect(readLast(root)).toEqual({ round: "2026-11-07", uiCommit: "abc" });
  });

  test("sem SKILL.md o Impeccable não conta como instalado", () => {
    const dir = join(T, "imp");
    mkdirSync(dir);
    expect(impeccableInstalled(dir)).toBe(false);
    writeFileSync(join(dir, "SKILL.md"), "x");
    expect(impeccableInstalled(dir)).toBe(true);
  });

  test("start recusa com a dica de instalar quando falta o Impeccable", () => {
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../../../src/cli.ts"), "ux-audit", "start"], {
      env: { ...process.env, HADES_IMPECCABLE_DIR: join(T, "nao-existe"), HADES_WORK_ROOT: join(T, "w") },
    });
    expect(r.exitCode).toBe(69);
    expect(r.stderr.toString()).toContain("não está instalado");
    expect(existsSync(join(T, "w"))).toBe(false);
  });
});
