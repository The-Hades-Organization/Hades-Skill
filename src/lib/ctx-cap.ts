/**
 * Teto de contexto por papel: o único lugar que traduz papel (ou slug do Argos) em número. Hook, `hades watch`, Argos e
 * Consumo chamam `ctxCapOf`; trocar a política do slug que não é papel do hook (recruta do canvas) mexe só aqui.
 */

export const INTERACTIVE_CAP_KEY = "HADES_CTX_CAP_INTERACTIVE";
export const DEFAULT_INTERACTIVE_CAP = 300_000;
export const RECRUIT_CAP_KEY = "HADES_CTX_CAP_RECRUIT";
export const DEFAULT_RECRUIT_CAP = 200_000;

/** Leitor de chave de configuração: ausente = `undefined`. */
export type CapReader = (key: string) => string | undefined;

/** `revisor-2` → `HADES_CTX_CAP_REVISOR_2` (o slug do Argos é livre; o nome da chave não). */
export function ctxCapKey(role: string): string {
  return `HADES_CTX_CAP_${role.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function positiveInt(raw: string | undefined): number | undefined {
  const value = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Teto do papel. Chave própria vence sempre. Sem ela: recruta do canvas (terminal sem registro de agente, com papel
 * do Argos sem chave ou sem papel) usa `HADES_CTX_CAP_RECRUIT`; o resto usa o das sessões interativas (só avisa).
 */
export function ctxCapOf(role: string, read: CapReader, recruit = false): number {
  const own = positiveInt(read(ctxCapKey(role)));
  if (own !== undefined) return own;
  if (recruit) return positiveInt(read(RECRUIT_CAP_KEY)) ?? DEFAULT_RECRUIT_CAP;
  return positiveInt(read(INTERACTIVE_CAP_KEY)) ?? DEFAULT_INTERACTIVE_CAP;
}
