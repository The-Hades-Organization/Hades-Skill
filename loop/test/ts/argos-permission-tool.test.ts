// Grupo argos-permission-tool: a ferramenta do pedido de permissão quando o texto do aviso não a traz (issue #16).
import { describe, expect, test } from "bun:test";
import { pendingPermission } from "../../../src/lib/argos";
import { actionsFor, type ActionNode } from "../../../src/lib/canvas-actions";
import { eventOfHook } from "../../../src/lib/journal";
import type { JournalEvent } from "../../../src/lib/journal";

const NOW = new Date("2026-03-10T10:00:00Z");
const at = (min: number): Date => new Date(NOW.getTime() + min * 60_000);
const hook = (min: number, input: Record<string, unknown>): JournalEvent =>
  eventOfHook({ session_id: "s", cwd: "/w", ...input }, "a1", at(min)) as JournalEvent;
const pre = (min: number, tool: string): JournalEvent => hook(min, { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command: "ls" } });
const post = (min: number, tool: string): JournalEvent => hook(min, { hook_event_name: "PostToolUse", tool_name: tool, tool_input: { command: "ls" } });
const ask = (min: number, message: string): JournalEvent =>
  hook(min, { hook_event_name: "Notification", notification_type: "permission_prompt", message });

const node = (events: JournalEvent[], herdrState: string): ActionNode => ({
  id: "agent:p:a1", type: "agent", label: "a1", state: herdrState, registryState: "active", herdrState, pendingPermission: pendingPermission(events),
});
const available = (n: ActionNode): boolean[] => actionsFor(n).filter((i) => i.key === "approve_permission" || i.key === "deny_permission").map((i) => i.available);

describe("argos: ferramenta do pedido inferida do diário", () => {
  test("dado tool_pre Bash e aviso sem 'use <Ferramenta>' com herdr blocked, então aprovar e negar valem", () => {
    const events = [pre(0, "Bash"), ask(1, "Claude needs your permission")];
    expect(pendingPermission(events)?.tool).toBe("Bash");
    expect(available(node(events, "blocked"))).toEqual([true, true]);
  });

  test("dado tool_pre de ferramenta desconhecida sem aviso de ferramenta, então os botões ficam bloqueados com o motivo do terminal", () => {
    const events = [pre(0, "ExitPlanMode"), ask(1, "Claude needs your permission")];
    const items = actionsFor(node(events, "blocked"));
    const approve = items.find((i) => i.key === "approve_permission");
    expect(approve?.available).toBe(false);
    expect(approve?.reason?.message).toContain("terminal");
  });

  test("dado herdr diferente de blocked, então os botões ficam bloqueados mesmo com a ferramenta inferida", () => {
    const events = [pre(0, "Bash"), ask(1, "Claude needs your permission")];
    expect(available(node(events, "working"))).toEqual([false, false]);
  });

  test("dado tool_pre já fechado por tool_post, então não há ferramenta a inferir", () => {
    const events = [pre(0, "Bash"), post(1, "Bash"), ask(2, "Claude needs your permission")];
    expect(pendingPermission(events)?.tool).toBeNull();
  });

  test("dado dois tool_pre e só o primeiro fechado, então vale o segundo, o que ficou aberto", () => {
    const events = [pre(0, "Bash"), pre(1, "Edit"), post(2, "Bash"), ask(3, "Claude needs your permission")];
    expect(pendingPermission(events)?.tool).toBe("Edit");
  });

  test("dado o texto do aviso com a ferramenta, então ela vence a inferência", () => {
    const events = [pre(0, "Bash"), ask(1, "Claude needs your permission to use Write")];
    expect(pendingPermission(events)?.tool).toBe("Write");
  });

  test("dado tool_pre de antes de uma parada, então não é a ferramenta do pedido", () => {
    const events = [pre(0, "Bash"), hook(1, { hook_event_name: "Stop" }), ask(2, "Claude needs your permission")];
    expect(pendingPermission(events)?.tool).toBeNull();
  });

  test("dado pedido sem nenhum tool_pre, então a ferramenta segue nula e o motivo é o terminal", () => {
    const events = [ask(0, "Claude needs your permission")];
    expect(pendingPermission(events)?.tool).toBeNull();
    const approve = actionsFor(node(events, "blocked")).find((i) => i.key === "approve_permission");
    expect(approve?.reason?.message).toContain("terminal");
  });
});
