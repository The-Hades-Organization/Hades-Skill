// O bloco "PR pronta" dos briefs: assignee, labels e reviewers das Configurações. O `agent new` o põe no brief-template.md e
// o `canvas recruit` no primeiro prompt do recruta; as duas saídas vêm da mesma função.
import { configValue } from "./work.ts";

export interface PrReadyValues {
  assignee: string;
  labels: string;
  reviewers: string;
}

const NONE = "—";
const dash = (value: string): string => value || NONE;

/** Papéis do loop cujo trabalho termina numa PR; o papel (ou o papel da predefinição) do recruta decide se o bloco entra. */
export const PR_OPENING_ROLES: readonly string[] = ["impl", "spec", "consolidate"];

export const opensPr = (role: string | null | undefined): boolean => role !== undefined && role !== null && PR_OPENING_ROLES.includes(role);

/** Labels do perfil do projeto (`pr.labels`) em texto; ausente ou vazio vira o traço. */
export const labelsText = (labels: unknown): string => (Array.isArray(labels) && labels.length > 0 ? labels.join(",") : NONE);

/** Os valores das Configurações; `labels` vem do perfil do projeto (quem chama sabe achá-lo). */
export function prReadyValues(labels: string, get: (key: string, fallback: string) => string = configValue): PrReadyValues {
  return { assignee: dash(get("HADES_ORCH_PR_ASSIGNEE", "")), labels: dash(labels), reviewers: dash(get("HADES_ORCH_PR_REVIEWERS", "")) };
}

/** A linha do bloco, com a quebra de linha que o brief-template.md sempre teve antes dos reviewers. */
export function renderPrReady(v: PrReadyValues): string {
  return `Pronta: assignee \`${v.assignee}\`, labels \`${v.labels}\`, reviewers\n  \`${v.reviewers}\`, depois \`gh pr ready\`.`;
}

/** O bloco do primeiro prompt do recruta (sem a quebra recuada do brief). */
export function prReadyPromptBlock(v: PrReadyValues): string {
  return renderPrReady(v).replace("\n  ", " ").replace(/^Pronta:/, "PR pronta:");
}
