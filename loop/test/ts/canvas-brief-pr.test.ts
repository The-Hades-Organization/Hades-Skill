// Grupo canvas-brief-pr: o bloco "PR pronta" (src/lib/brief-pr.ts) que o `agent new` põe no brief e o `canvas recruit` no
// primeiro prompt do recruta: a mesma função renderiza os dois, e só os papéis que abrem PR o recebem.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { labelsText, opensPr, prReadyPromptBlock, prReadyValues, renderPrReady } from "../../../src/lib/brief-pr";

const config = (map: Record<string, string>) => (key: string, fallback: string): string => map[key] ?? fallback;

describe("canvas-brief-pr", () => {
  test("dadas as Configurações, quando renderiza, então a linha é a que o brief-template sempre teve", () => {
    const v = prReadyValues("fix,bug", config({ HADES_ORCH_PR_ASSIGNEE: "ana", HADES_ORCH_PR_REVIEWERS: "bia,caio" }));
    expect(renderPrReady(v)).toBe("Pronta: assignee `ana`, labels `fix,bug`, reviewers\n  `bia,caio`, depois `gh pr ready`.");
  });

  test("dado campo vazio, quando renderiza, então vira o traço", () => {
    const v = prReadyValues(labelsText(undefined), config({}));
    expect(v).toEqual({ assignee: "—", labels: "—", reviewers: "—" });
    expect(labelsText([])).toBe("—");
  });

  test("dado o prompt do recruta, quando monta o bloco, então sai numa linha só", () => {
    const block = prReadyPromptBlock({ assignee: "ana", labels: "x", reviewers: "bia" });
    expect(block).toBe("PR pronta: assignee `ana`, labels `x`, reviewers `bia`, depois `gh pr ready`.");
    expect(block).not.toContain("\n");
  });

  test("dado o papel, quando se pergunta se abre PR, então impl, spec e consolidate abrem e review, vazio e nulo não", () => {
    expect(["impl", "spec", "consolidate"].every(opensPr)).toBe(true);
    expect([opensPr("review"), opensPr(""), opensPr(null), opensPr(undefined)]).toEqual([false, false, false, false]);
  });

  test("o brief-template usa o token do bloco, não os três campos soltos", () => {
    const text = readFileSync(join(import.meta.dir, "../../../reference/loop/brief-template.md"), "utf8");
    expect(text).toContain("{{PR_PRONTA}}");
    expect(text).not.toContain("{{ASSIGNEE}}");
  });
});
