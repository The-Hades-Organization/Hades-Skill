// Campos do grafo do Argos que a página usa para endereçar o nó sem adivinhar: o pane do herdr do agente e os ids curtos
// de worktree e de rodada. Puro (sem Node): o servidor (`src/panel/argos-graph.ts`) chama, a página só lê o resultado.

/** Sessão do herdr que o `herdr agent list` do grafo lê (a padrão: o grafo não passa `--session`). */
export const HERDR_DEFAULT_SESSION = "default";
/** Mesmo formato de pane que `herdr-page.ts` aceita nas rotas de entrada e de fluxo. */
const PANE_ID = /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/;
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{40,64}$/;
/** Dígitos do hash do plano no id curto da rodada (o `git` usa 7 pelo mesmo motivo: único na prática, curto na tela). */
export const ROUND_ID_CHARS = 7;
/** Teto do id curto (cabe na chave de escopo do canvas, `CANVAS_STORE_LIMITS.scopeKeyChars`). */
export const SHORT_ID_MAX = 80;

export interface HerdrRef {
  session: string;
  pane: string;
}

export interface RoundRef {
  /** os primeiros `ROUND_ID_CHARS` do hash do plano aprovado */
  id: string;
  /** o nome do arquivo do plano, sem `.md` */
  name: string;
}

/** `{ session, pane }` do agente quando o herdr o conhece; pane ou sessão fora do formato é `null` (nunca um par meio válido). */
export function herdrRefOf(paneId: unknown, session: string = HERDR_DEFAULT_SESSION): HerdrRef | null {
  if (typeof paneId !== "string" || !PANE_ID.test(paneId) || !SESSION_NAME.test(session)) return null;
  return { session, pane: paneId };
}

/**
 * O pane do orquestrador que alocou o agente (`orchestrator` do registro, gravado pela CLI), ou `undefined`: campo ausente,
 * meio preenchido ou fora do formato some do nó em vez de virar uma ligação errada.
 */
export function orchestratorOf(record: Record<string, unknown>): HerdrRef | undefined {
  const by = record.orchestrator;
  if (typeof by !== "object" || by === null || Array.isArray(by)) return undefined;
  const { session, pane } = by as Record<string, unknown>;
  return (typeof session === "string" && herdrRefOf(pane, session)) || undefined;
}

/** Registro na forma curta: `_skill` → `skill`; `<owner>__<repo>` → `<repo>`; o resto fica como está. */
export function shortRegistry(slug: string): string {
  if (slug === "_skill") return "skill";
  const cut = slug.lastIndexOf("__");
  return cut >= 0 && cut + 2 < slug.length ? slug.slice(cut + 2) : slug;
}

/** Id curto do agente para a tela (`<repo>/<agente>`); acima do teto, `null` (a página mostra o nome). */
export function agentShortId(registry: string, name: string): string | null {
  if (!registry || !name) return null;
  const id = `${shortRegistry(registry)}/${name}`;
  return id.length <= SHORT_ID_MAX ? id : null;
}

/** Rodada do registro: o plano aprovado (hash válido e caminho com nome). Sem plano ou hash fora do formato, `null`. */
export function roundOf(planPath: unknown, sha: unknown): RoundRef | null {
  if (typeof planPath !== "string" || typeof sha !== "string" || !SHA.test(sha)) return null;
  const file = planPath.split(/[\\/]/).pop() ?? "";
  const name = file.replace(/\.md$/i, "");
  if (!name || name.length > SHORT_ID_MAX) return null;
  return { id: sha.slice(0, ROUND_ID_CHARS), name };
}
