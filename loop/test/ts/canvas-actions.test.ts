// Grupo canvas-actions: menu de ações de um nó do canvas (src/lib/canvas-actions.ts) — só ações que a rota aceita, motivo
// de indisponível, destrutivas e o corpo do POST. Confere o espelho contra src/panel/argos-actions.ts e src/lib/argos.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSimplePermissionTool } from "../../../src/lib/argos";
import {
  ACTION_REASONS, MENU_ACTIONS, actionRequest, actionsFor, isDangerousAction, type ActionItem, type ActionNode,
} from "../../../src/lib/canvas-actions";
import { ACTION_NAMES, createActions, type ActionName } from "../../../src/panel/argos-actions";

const T = mkdtempSync(join(tmpdir(), "hades-canvas-actions-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const agent = (over: Partial<ActionNode> = {}): ActionNode => ({
  id: "agent:p:a1", type: "agent", label: "a1", state: "working", registryState: "active", herdrState: "working", pendingPermission: null, ...over,
});
const find = (items: ActionItem[], key: ActionName): ActionItem => items.find((i) => i.key === key) as ActionItem;
const availableKeys = (node: ActionNode, ctx = {}): string[] => actionsFor(node, ctx).filter((i) => i.available).map((i) => i.key);

describe("canvas-actions: só o que a rota aceita", () => {
  test("dado qualquer nó, então toda ação oferecida existe na lista fechada da rota", () => {
    const known = new Set<string>(ACTION_NAMES);
    for (const key of MENU_ACTIONS) expect(known.has(key)).toBe(true);
    for (const item of actionsFor(agent())) expect(known.has(item.key)).toBe(true);
  });

  test("dado o menu, então ficam de fora só o texto e as teclas cruas e nada de ação inventada (abrir PR, copiar)", () => {
    expect(ACTION_NAMES.filter((k) => !MENU_ACTIONS.includes(k)).sort()).toEqual(["keys", "text"]);
    const keys = actionsFor(agent()).map((i) => i.key as string);
    for (const invented of ["open_pr", "copy_name", "copy"]) expect(keys).not.toContain(invented);
  });

  test("dado nó que não é agente (unidade, PR, gate, tipo desconhecido), então não há ação nenhuma", () => {
    for (const type of ["unit", "pr", "gate", "note", ""]) expect(actionsFor(agent({ type }))).toEqual([]);
  });
});

describe("canvas-actions: contrato com a rota", () => {
  const act = createActions({
    logFile: join(T, "argos.log"), fallbackCwd: T, herdrPage: {} as never,
    target: () => ({ id: "agent:p:a1", name: "a1", worktree: T, pane: "w1:p1" }),
    live: async () => ({ herdrState: "idle", pending: null }), config: () => ({}), notify: async () => undefined,
  }).act;
  const codeOf = async (body: Record<string, unknown>): Promise<unknown> => act(body, { remote: false }).then(() => "ok", (e: { code?: string }) => e.code);

  test("dado cada ação do menu, então a destrutiva é a mesma que a rota barra sem confirm", async () => {
    for (const key of MENU_ACTIONS) {
      if (key === "stop_session") {
        expect(await codeOf({ node: "agent:p:a1", action: key, args: { session: "s1" } })).toBe("confirm_required");
      } else if (key === "done") {
        expect(await codeOf({ node: "agent:p:a1", action: key })).toBe("confirm_required");
      } else {
        // argumentos que nenhuma ação não destrutiva aceita: a rota para em invalid_args, antes de executar qualquer coisa
        const junk = { session: "sessão inválida", phase: "!", question: "x", reply: "", text: "", reason: "" };
        expect(await codeOf({ node: "agent:p:a1", action: key, args: junk })).toBe("invalid_args");
      }
    }
    expect(MENU_ACTIONS.filter(isDangerousAction).sort()).toEqual(["done", "stop_session"]);
  });

  test("dado campo obrigatório de uma ação, então a rota recusa sem ele (invalid_args)", async () => {
    for (const item of actionsFor(agent({ openQuestions: ["Q1 — x"] }))) {
      if (!item.fields.some((f) => f.required)) continue;
      expect(await codeOf({ node: "agent:p:a1", action: item.key, args: {}, confirm: "a1" })).toBe("invalid_args");
    }
  });

  test("dado cada ferramenta de permissão, então aprovar vale exatamente quando a rota o aceitaria", () => {
    for (const tool of ["Bash", "Edit", "Write", "NotebookEdit", "mcp__x__y", "ExitPlanMode", "AskUserQuestion", "Read", "", null]) {
      const node = agent({ herdrState: "blocked", pendingPermission: { ts: "2026-11-02T10:00:00Z", tool } });
      expect(find(actionsFor(node), "approve_permission").available).toBe(isSimplePermissionTool(tool));
      expect(find(actionsFor(node), "deny_permission").available).toBe(isSimplePermissionTool(tool));
    }
  });
});

describe("canvas-actions: disponibilidade", () => {
  test("dado agente parado sem pendência, então aprovar, negar e responder ficam indisponíveis com o motivo", () => {
    const items = actionsFor(agent());
    expect(find(items, "approve_permission").reason?.code).toBe(ACTION_REASONS.noPendingPermission);
    expect(find(items, "deny_permission").reason?.code).toBe(ACTION_REASONS.noPendingPermission);
    expect(find(items, "answer").reason?.code).toBe(ACTION_REASONS.noOpenQuestion);
    expect(availableKeys(agent())).toEqual(["prompt", "resume", "phase", "escalate", "park", "free_prompt", "done", "stop_session"]);
  });

  test("dado pedido pendente com o herdr fora de blocked, então aprovar não vale (mesma regra do 409 da rota)", () => {
    const node = agent({ herdrState: "working", pendingPermission: { ts: "2026-11-02T10:00:00Z", tool: "Bash" } });
    expect(find(actionsFor(node), "approve_permission").reason?.code).toBe(ACTION_REASONS.noPendingPermission);
  });

  test("dado pedido de plano ou pergunta, então o motivo diz que se responde no terminal (422 da rota)", () => {
    const node = agent({ herdrState: "blocked", pendingPermission: { ts: "2026-11-02T10:00:00Z", tool: "ExitPlanMode" } });
    expect(find(actionsFor(node), "approve_permission").reason?.code).toBe(ACTION_REASONS.permissionNotSupported);
    expect(find(actionsFor(node), "approve_permission").reason?.message).toContain("terminal");
  });

  test("dado pedido de Bash com o herdr blocked, então aprovar e negar valem e não são destrutivas", () => {
    const node = agent({ herdrState: "blocked", pendingPermission: { ts: "2026-11-02T10:00:00Z", tool: "Bash" } });
    expect(availableKeys(node)).toEqual(expect.arrayContaining(["approve_permission", "deny_permission"]));
    expect(find(actionsFor(node), "approve_permission").dangerous).toBe(false);
  });

  test("dado pergunta aberta, então responder vale e oferece só os Q<n> bem formados", () => {
    const node = agent({ openQuestions: ["Q1 — porta de teste", "Q12 — nome", "texto solto", "Q — sem número"] });
    const answer = find(actionsFor(node), "answer");
    expect(answer.available).toBe(true);
    expect(answer.fields[0]?.choices).toEqual([{ value: "Q1", label: "Q1 — porta de teste" }, { value: "Q12", label: "Q12 — nome" }]);
  });

  test("dado pergunta aberta sem nenhum Q<n> legível, então responder fica indisponível", () => {
    expect(find(actionsFor(agent({ openQuestions: ["sem id"] })), "answer").available).toBe(false);
  });

  test("dado agente encerrado (done ou archived), então as ações do loop ficam indisponíveis e as do terminal seguem o herdr", () => {
    for (const closed of [{ state: "done" }, { registryState: "archived", state: "archived" }]) {
      const items = actionsFor(agent(closed));
      for (const key of ["resume", "prompt", "phase", "escalate", "done"] as const) expect(find(items, key).reason?.code).toBe(ACTION_REASONS.agentClosed);
      expect(find(items, "free_prompt").available).toBe(true);
    }
  });

  test("dado herdr que não vê o agente, então as ações de terminal ficam indisponíveis com o motivo", () => {
    const items = actionsFor(agent({ herdrState: "fora" }));
    for (const key of ["free_prompt", "stop_session"] as const) expect(find(items, key).reason?.code).toBe(ACTION_REASONS.herdrNotSeeing);
    expect(find(items, "resume").available).toBe(true);
  });

  test("dado herdr indisponível no grafo, então o terminal fecha; sem a informação, não bloqueia", () => {
    expect(find(actionsFor(agent(), { herdrAvailable: false }), "free_prompt").reason?.code).toBe(ACTION_REASONS.herdrUnavailable);
    expect(find(actionsFor(agent(), {}), "free_prompt").available).toBe(true);
  });

  test("dado o menu, então as destrutivas são encerrar e parar a sessão e só elas", () => {
    expect(actionsFor(agent()).filter((i) => i.dangerous).map((i) => i.key)).toEqual(["done", "stop_session"]);
  });

  test("dado o mesmo nó duas vezes, então o resultado é igual e o nó recebido não muda", () => {
    const node = agent({ openQuestions: ["Q1 — x"] });
    const before = JSON.stringify(node);
    expect(actionsFor(node)).toEqual(actionsFor(node));
    expect(JSON.stringify(node)).toBe(before);
  });
});

describe("canvas-actions: corpo do POST", () => {
  test("dado nó e ação, então o corpo leva nó, ação e args, e confirm só quando dado", () => {
    expect(actionRequest(agent(), "resume")).toEqual({ node: "agent:p:a1", action: "resume", args: {} });
    expect(actionRequest(agent(), "done", {}, "a1")).toEqual({ node: "agent:p:a1", action: "done", args: {}, confirm: "a1" });
    expect(actionRequest(agent(), "phase", { phase: "impl" })).toEqual({ node: "agent:p:a1", action: "phase", args: { phase: "impl" } });
  });

  test("dado confirmação errada, então o corpo a repassa como veio (quem confere é o servidor)", () => {
    expect(actionRequest(agent(), "done", {}, "outro").confirm).toBe("outro");
  });
});
