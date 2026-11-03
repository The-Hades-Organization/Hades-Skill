// `hades cerberus-check <cabeca>/<guarda> [arg]`: roda um check do Cerberus portado e imprime o veredito (uma linha JSON).
// O JSON das guardas em loop/cerberus aponta para este comando.
import { checkEnvFromProcess, type CheckVerdict } from "../lib/cerberus-check.ts";
import { LIMIAR_GUARDS, rodarLimiar } from "../lib/cerberus-limiar.ts";
import { PORTA_GUARDS } from "../lib/cerberus-porta.ts";
import { AUDITORIA, COERENCIA, rodarVigilia } from "../lib/cerberus-vigilia.ts";
import { EXIT, out, warn } from "../lib/output.ts";
import { pyDumps } from "../lib/pyjson.ts";

const USAGE = "uso: hades cerberus-check <porta/<guarda> | limiar <guarda> | vigilia/auditoria <guarda> | vigilia/coerencia <guarda>>  (ambiente: CERBERUS_DIR, CERBERUS_SKILL, CERBERUS_MOMENTO, CERBERUS_CTX)";

function evaluate(args: string[]): CheckVerdict | undefined {
  const [target, arg, ...extra] = args;
  const ce = checkEnvFromProcess();
  const [head, id] = (target ?? "").split("/");
  if (head === "porta") return id ? PORTA_GUARDS[id]?.(ce) : undefined;
  if (head === "limiar") return id || extra.length ? undefined : rodarLimiar(arg ?? "", ce);
  if (head !== "vigilia" || !arg || extra.length) return undefined;
  if (id === "auditoria") return rodarVigilia(AUDITORIA, arg, ce);
  if (id === "coerencia") return rodarVigilia(COERENCIA, arg, ce);
  return undefined;
}

/** O uso que cada script original imprimia ao receber guarda desconhecida (stderr, saída 2). */
function usageOf(target: string | undefined): string {
  if (target === "vigilia/auditoria") return `uso: auditoria.py ${Object.keys(AUDITORIA).join("|")}`;
  if (target === "limiar") return `uso: limiar.py ${Object.keys(LIMIAR_GUARDS).join("|")}`;
  if (target === "vigilia/coerencia") return `uso: coerencia.py ${Object.keys(COERENCIA).join("|")}`;
  return USAGE;
}

export function cerberusCheckCommand(args: string[]): number {
  const verdict = evaluate(args);
  if (!verdict) {
    warn(usageOf(args[0]));
    return EXIT.usage;
  }
  out(pyDumps(verdict));
  return EXIT.ok;
}
