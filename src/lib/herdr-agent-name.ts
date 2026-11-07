// Nome de agente do herdr derivado do nome do terminal no painel. O fork do herdr só aceita `[a-z][a-z0-9_-]{0,31}`; o painel
// aceita maiúscula, espaço, ponto e acento e continua mostrando o nome dele no canvas. Só o `herdr agent start` recebe o derivado.

export const HERDR_AGENT_NAME_MAX = 32;
export const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
/** Prefixo de quando nada sobra que sirva (vazio, só símbolos) ou o nome começa por dígito ou sublinhado. */
export const HERDR_AGENT_NAME_PREFIX = "agent";

/** Minúsculas, sem acento, o que não cabe vira `-`, hífens repetidos e das pontas somem, começa por letra, até 32 caracteres. */
export function slugAgentName(name: string): string {
  const folded = name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "");
  const lettered = /^[a-z]/.test(folded) ? folded : folded === "" ? HERDR_AGENT_NAME_PREFIX : `${HERDR_AGENT_NAME_PREFIX}-${folded}`;
  return lettered.slice(0, HERDR_AGENT_NAME_MAX).replace(/-+$/, "");
}

/** O derivado; colisão com um nome de `taken` (agentes já na sessão) ganha o sufixo `-2`, `-3`… sem passar de 32 caracteres. */
export function deriveHerdrAgentName(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const base = slugAgentName(name);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, HERDR_AGENT_NAME_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
