// Fechamento automático do agente ao concluir (reference/loop/orchestrate.md): a decisão pura, sem I/O. O watch junta os
// fatos (herdr, PR, git) e a executa; o fechamento em si é o `closeAgent` do `hades agent done`.

export type DismissHeld =
  | "herdr-working"
  | "herdr-blocked"
  | "herdr-fora"
  | "herdr-desconhecido"
  | "sem-pr"
  | "pr-ilegivel"
  | "pr-head-diferente";

export interface DismissFacts {
  /** `mode` do registro do agente. */
  mode: string;
  /** `agent_status` do herdr; "" quando o agente não está na lista dele. */
  herdr: string;
  /** Número da PR da unidade; "" quando não há. */
  pr: string;
  /** `headRefOid` da PR; undefined quando o `gh` não respondeu. Lazy: só se lê com a sessão já parada. */
  prHead: () => string | undefined;
  /** HEAD da worktree. */
  localHead: string;
}

/** O modo `skill` (sem PR) e o `review` (PR de terceiro) não têm PR da unidade: valem só a auditoria do `closeAgent`. */
export function modeTemPrDaUnidade(mode: string): boolean {
  return mode !== "skill" && mode !== "review";
}

function herdrHeld(status: string): DismissHeld | undefined {
  switch (status) {
    case "idle":
    case "done":
      return undefined;
    case "working":
      return "herdr-working";
    case "blocked":
      return "herdr-blocked";
    case "":
    case "fora":
      return "herdr-fora";
    default:
      return "herdr-desconhecido";
  }
}

/** Por que o agente que concluiu ainda não pode ser fechado; undefined quando pode. */
export function dismissHeld(facts: DismissFacts): DismissHeld | undefined {
  const session = herdrHeld(facts.herdr);
  if (session !== undefined) return session;
  if (!modeTemPrDaUnidade(facts.mode)) return undefined;
  if (facts.pr === "") return "sem-pr";
  const prHead = facts.prHead();
  if (prHead === undefined || prHead === "") return "pr-ilegivel";
  return prHead === facts.localHead ? undefined : "pr-head-diferente";
}
