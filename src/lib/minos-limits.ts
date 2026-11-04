// Minos: a última leitura de uma janela de uso (reference/limites.md), no formato do contrato. Sem amostra, null.
import type { Janela } from "./limites.ts";
import { chaves, medidas } from "./limites-io.ts";
import type { LimitData } from "./minos-model.ts";

const MS = 1000;

export function janelaAtual(janela: Janela, now: Date): LimitData | null {
  const a = medidas(now, chaves()).atual[janela];
  if (!a || !Number.isFinite(a.pct)) return null;
  return { pct: Math.min(100, Math.max(0, a.pct)), resetsAt: `${new Date(a.resetsAt * MS).toISOString().slice(0, 19)}Z` };
}
