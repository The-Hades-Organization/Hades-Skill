// Borda dos limites de uso: onde ficam as amostras, as chaves de configuração e a linha do status line.
// A regra está em limites.ts. Tudo em ~/.claude/hades/limits (nunca no repo do projeto); sem rede.
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readText } from "./fs.ts";
import {
  amostraDoStatusLine, amostrasDe, atuais, dentroDaRetencao, JANELAS, ROTULO, vale,
  type Amostra, type Atual, type Janela, type Opcoes,
} from "./limites.ts";
import type { Limiares } from "./limites-aviso.ts";
import { warn } from "./output.ts";
import { hadesHome } from "./paths.ts";
import { configValue } from "./work.ts";

const PORCENTO = 100;
/** Só reescreve o arquivo (poda da retenção) quando as amostras passam disto: a gravação normal é um append. */
const AMOSTRAS_PARA_PODAR = 2000;

export interface Chaves extends Opcoes {
  gapS: number;
  retentionDays: number;
}

function inteiro(key: string, fallback: number, min: number, max: number): number {
  const raw = configValue(key, String(fallback));
  const value = Number(raw);
  if (Number.isInteger(value) && value >= min && value <= max) return value;
  warn(`limites: ${key}=${raw}: esperava um inteiro de ${min} a ${max}; uso ${fallback}`);
  return fallback;
}

export function chaves(): Chaves {
  return {
    gapS: inteiro("HADES_LIMITS_SAMPLE_GAP_S", 60, 0, 3600),
    retentionDays: inteiro("HADES_LIMITS_RETENTION_DAYS", 30, 1, 365),
    minDeltaPct: inteiro("HADES_LIMITS_MIN_DELTA_PCT", 1, 1, 50),
    minIntervals: inteiro("HADES_LIMITS_MIN_INTERVALS", 5, 2, 100),
    cacheReadWeight: inteiro("HADES_LIMITS_CACHE_READ_WEIGHT_PCT", 10, 0, PORCENTO) / PORCENTO,
  };
}

/** Limiares do aviso do `hades watch`: % usado de cada janela (reference/limites.md §Aviso). */
export function limiaresDeAviso(): Limiares {
  return {
    five: inteiro("HADES_LIMITS_WARN_FIVE_PCT", 80, 1, PORCENTO),
    seven: inteiro("HADES_LIMITS_WARN_SEVEN_PCT", 90, 1, PORCENTO),
  };
}

export const limitsDir = (): string => join(hadesHome(), "limits");
const samplesFile = (): string => join(limitsDir(), "samples.jsonl");

export function lerAmostras(): Amostra[] {
  return amostrasDe(readText(samplesFile()) ?? "");
}

export type Gravou = "gravou" | "repetida" | "sem-limites";

/** Grava a amostra do JSON do status line (stdin). Leitura igual à última, ou sem `rate_limits`, não grava. */
export function gravarAmostra(stdin: string, now: Date, k: Chaves): { resultado: Gravou; amostras: Amostra[] } {
  const nova = amostraDoStatusLine(stdin, now);
  const amostras = lerAmostras();
  if (!nova) return { resultado: "sem-limites", amostras };
  if (!vale(nova, amostras[amostras.length - 1], k.gapS)) return { resultado: "repetida", amostras };
  mkdirSync(limitsDir(), { recursive: true });
  appendFileSync(samplesFile(), `${JSON.stringify(nova)}\n`);
  const todas = [...amostras, nova];
  if (todas.length > AMOSTRAS_PARA_PODAR) {
    const mantidas = dentroDaRetencao(todas, now, k.retentionDays);
    const tmp = `${samplesFile()}.tmp`;
    writeFileSync(tmp, mantidas.map((a) => JSON.stringify(a)).join("\n") + "\n");
    renameSync(tmp, samplesFile());
    return { resultado: "gravou", amostras: mantidas };
  }
  return { resultado: "gravou", amostras: todas };
}

/** Amostras dentro da retenção e a leitura atual de cada janela. */
export function medidas(now: Date, k: Chaves): { amostras: Amostra[]; atual: Partial<Record<Janela, Atual>> } {
  const amostras = dentroDaRetencao(lerAmostras(), now, k.retentionDays);
  return { amostras, atual: atuais(amostras, now) };
}

/** Quando renova: hora do dia na janela de 5 h; data e hora na semanal (sempre UTC). */
export function renova(janela: Janela, epochS: number): string {
  const iso = new Date(epochS * 1000).toISOString();
  return janela === "five" ? `${iso.slice(11, 16)}Z` : `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`;
}

/** `5 h 23% (renova 22:10Z) · semana 41% (renova 11-07 03:00Z)`; é o que o status line imprime. */
export function linhaAtual(atual: Partial<Record<Janela, Atual>>): string {
  return JANELAS.flatMap((j) => {
    const a = atual[j];
    return a ? [`${ROTULO[j]} ${Math.round(a.pct)}% (renova ${renova(j, a.resetsAt)})`] : [];
  }).join(" · ");
}
