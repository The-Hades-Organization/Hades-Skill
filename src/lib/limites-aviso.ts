// Regra de exibição e de aviso dos limites de uso (reference/limites.md §Painel, aviso e orquestrador).
// Funções puras: a leitura das amostras e o estado do "já avisado" ficam na borda (limites-io.ts, watch.ts, painel).
import { JANELAS, ROTULO, type Atual, type Janela } from "./limites.ts";

/** Janela medida pronta para tela: o que o painel e o nó do Argos mostram. */
export interface JanelaMedida {
  janela: Janela;
  rotulo: string;
  /** % usado, 0–100, arredondado a 0,1. */
  pct: number;
  resetsAt: number;
  /** Renovação em UTC (`22:10Z` na janela de 5 h; `11-07 03:00Z` na semanal). */
  renova: string;
  /** Segundos desde a leitura. */
  idadeS: number;
}

/** `coleta` falso = nenhuma amostra aberta: a tela explica como ligar, nunca inventa um número. */
export interface PainelLimites {
  coleta: boolean;
  janelas: JanelaMedida[];
}

const DECIMOS = 10;
const MS = 1000;

function renovaEm(janela: Janela, epochS: number): string {
  const iso = new Date(epochS * MS).toISOString();
  return janela === "five" ? `${iso.slice(11, 16)}Z` : `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`;
}

export function painelDeLimites(atual: Partial<Record<Janela, Atual>>, now: Date): PainelLimites {
  const janelas = JANELAS.flatMap((janela): JanelaMedida[] => {
    const a = atual[janela];
    if (!a) return [];
    const idadeS = Math.max(0, Math.round((now.getTime() - Date.parse(a.at)) / MS));
    return [{ janela, rotulo: ROTULO[janela], pct: Math.round(a.pct * DECIMOS) / DECIMOS, resetsAt: a.resetsAt, renova: renovaEm(janela, a.resetsAt), idadeS }];
  });
  return { coleta: janelas.length > 0, janelas };
}

// ---------------------------------------------------------------- aviso do watch

/** Limiar de aviso por janela, em % usado. */
export type Limiares = Record<Janela, number>;

/** O Claude Code pode mexer na renovação em segundos entre duas leituras; só uma diferença maior é janela nova. */
const JITTER_DA_RENOVACAO_S = 120;

export interface AvisoDeJanela {
  janela: Janela;
  pct: number;
  resetsAt: number;
  renova: string;
}

/**
 * Janelas que passaram do limiar e ainda não foram avisadas nesta renovação. `visto` é a renovação (epoch s) da última
 * vez que a janela foi avisada: o aviso sai uma vez por janela e por renovação, e de novo depois que ela renova.
 */
export function janelasParaAvisar(
  atual: Partial<Record<Janela, Atual>>, limiares: Limiares, visto: Partial<Record<Janela, number>>,
): AvisoDeJanela[] {
  return JANELAS.flatMap((janela): AvisoDeJanela[] => {
    const a = atual[janela];
    if (!a || a.pct < limiares[janela]) return [];
    const ultimo = visto[janela];
    if (ultimo !== undefined && a.resetsAt - ultimo <= JITTER_DA_RENOVACAO_S) return [];
    return [{ janela, pct: Math.floor(a.pct), resetsAt: a.resetsAt, renova: renovaEm(janela, a.resetsAt) }];
  });
}

/** `LIMITE 5 h 83 renova 22:10Z`: mesma forma do BUDGET (palavra, alvo, número). */
export const linhaDeLimite = (a: AvisoDeJanela): string => `LIMITE ${ROTULO[a.janela].replace(" ", "")} ${a.pct} renova ${a.renova}`;

// ---------------------------------------------------------------- coleta ligada?

/** O `statusLine` do settings.json chama `hades usage sample`? Só lê o texto; nunca o altera. */
export function statusLineColeta(settingsText: string | undefined): boolean {
  if (!settingsText) return false;
  try {
    const doc: unknown = JSON.parse(settingsText);
    const line = typeof doc === "object" && doc !== null ? (doc as { statusLine?: unknown }).statusLine : undefined;
    const command = typeof line === "object" && line !== null ? (line as { command?: unknown }).command : undefined;
    return typeof command === "string" && /usage\s+sample/.test(command);
  } catch {
    return false;
  }
}

/** Coleta ligada = o statusLine chama a Hades, ou já há amostra aberta (outro status line que a alimenta). */
export const coletaLigada = (settingsText: string | undefined, amostrasAbertas: number): boolean =>
  amostrasAbertas > 0 || statusLineColeta(settingsText);
