// Decisão pura do fechamento ao concluir (src/lib/agent-dismiss.ts) e o aviso de recrutar em worktree já concluída.
import { describe, expect, test } from "bun:test";
import { dismissHeld, modeTemPrDaUnidade, type DismissFacts, type DismissHeld } from "../../../src/lib/agent-dismiss";
import { concludedAgentAt } from "../../../src/lib/canvas-recruit";

const HEAD = "abc1234";
const facts = (over: Partial<DismissFacts> = {}): DismissFacts => ({ mode: "deliver", herdr: "idle", pr: "8", prHead: () => HEAD, localHead: HEAD, ...over });

describe("dismissHeld", () => {
  test("dado herdr idle ou done com a PR no mesmo head, então nada segura", () => {
    expect(dismissHeld(facts())).toBeUndefined();
    expect(dismissHeld(facts({ herdr: "done" }))).toBeUndefined();
  });
  test.each<[string, DismissHeld]>([
    ["working", "herdr-working"],
    ["blocked", "herdr-blocked"],
    ["", "herdr-fora"],
    ["fora", "herdr-fora"],
    ["unknown", "herdr-desconhecido"],
  ])("dado herdr %p, então segura por %s", (herdr, motivo) => {
    expect(dismissHeld(facts({ herdr }))).toBe(motivo);
  });
  test("dado herdr working e sem PR, então o motivo é o da sessão (a ordem das condições)", () => {
    expect(dismissHeld(facts({ herdr: "working", pr: "" }))).toBe("herdr-working");
  });
  test("dado modo com PR e sem número de PR, então sem-pr", () => {
    expect(dismissHeld(facts({ pr: "" }))).toBe("sem-pr");
  });
  test("dado gh sem resposta ou resposta vazia, então pr-ilegivel", () => {
    expect(dismissHeld(facts({ prHead: () => undefined }))).toBe("pr-ilegivel");
    expect(dismissHeld(facts({ prHead: () => "" }))).toBe("pr-ilegivel");
  });
  test("dado head da PR diferente do último commit da worktree, então pr-head-diferente", () => {
    expect(dismissHeld(facts({ prHead: () => "ffff999" }))).toBe("pr-head-diferente");
  });
  test.each(["skill", "review"])("dado modo %s, então a PR nem é consultada", (mode) => {
    let consultas = 0;
    const result = dismissHeld(facts({ mode, pr: "", prHead: () => { consultas += 1; return undefined; } }));
    expect(result).toBeUndefined();
    expect(consultas).toBe(0);
  });
  test("dado herdr working num modo sem PR, então ainda segura", () => {
    expect(dismissHeld(facts({ mode: "skill", herdr: "working" }))).toBe("herdr-working");
  });
});

describe("modeTemPrDaUnidade", () => {
  test("dado deliver, então tem; skill e review, não", () => {
    expect(modeTemPrDaUnidade("deliver")).toBe(true);
    expect(modeTemPrDaUnidade("skill")).toBe(false);
    expect(modeTemPrDaUnidade("review")).toBe(false);
  });
});

describe("concludedAgentAt", () => {
  const view = (name: string, worktree: string, state: string, closedOnDone = false) => ({ name, worktree, state, closedOnDone });
  const records = [view("fechado", "/wt/fechado/", "working", true), view("feito", "/wt/feito", "done"), view("vivo", "/wt/vivo", "working"), view("sem-pasta", "", "done")];

  test("dado cwd na worktree de agente fechado ao concluir, então devolve o nome (com ou sem barra final)", () => {
    expect(concludedAgentAt("/wt/fechado", records)).toBe("fechado");
    expect(concludedAgentAt("/wt/fechado/", records)).toBe("fechado");
  });
  test("dado cwd numa subpasta da worktree de agente com state done, então devolve o nome", () => {
    expect(concludedAgentAt("/wt/feito/src/lib", records)).toBe("feito");
  });
  test("dado agente ainda ativo, então undefined", () => {
    expect(concludedAgentAt("/wt/vivo", records)).toBeUndefined();
  });
  test("dado pasta que só começa com o mesmo texto, então não é a worktree", () => {
    expect(concludedAgentAt("/wt/feito-outro", records)).toBeUndefined();
  });
  test("dado registro sem worktree, então nunca casa", () => {
    expect(concludedAgentAt("/qualquer", records)).toBeUndefined();
  });
});
