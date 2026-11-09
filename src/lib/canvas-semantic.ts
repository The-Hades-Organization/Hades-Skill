// Zoom semântico do Argos (reference/argos.md §Nível de detalhe): o que cada nível ainda cabe dizer. Modelos puros, sem DOM
// e sem Node: o motor só desenha o que sai daqui. Bem longe: contagem por estado nas áreas e nos grupos e onde pôr o rótulo
// sem cobrir outro. De longe e médio: uma linha de resumo por tipo de nó.
import { stateLook } from "./canvas-argos.ts";

// ---- contagem por estado ----

/** Os três baldes da contagem, na ordem em que aparecem no rótulo: o que pede você vem primeiro. */
export const STATE_BUCKETS = ["attention", "working", "rest"] as const;
export type StateBucket = (typeof STATE_BUCKETS)[number];

export const BUCKET_WORDS: Readonly<Record<StateBucket, string>> = { attention: "pede você", working: "trabalhando", rest: "em repouso" };

export type BucketCounts = Readonly<Record<StateBucket, number>>;

/** O que o balde lê do nó vivo do grafo; nó do usuário (sem registro vivo) não conta. */
export interface LiveState {
  state: string;
  pendingPermission?: unknown;
}

/** Mesma regra de "pede você" da página (`needsAttention`): permissão pendente ou agente bloqueado. */
export function bucketOf(live: LiveState | undefined): StateBucket | undefined {
  if (live === undefined) return undefined;
  if ((live.pendingPermission !== null && live.pendingPermission !== undefined) || live.state === "blocked") return "attention";
  return live.state === "working" ? "working" : "rest";
}

/** Conta os nós por balde; quem não tem balde (nó do usuário) fica fora. */
export function countBuckets(buckets: Iterable<StateBucket | undefined>): BucketCounts {
  const counts = { attention: 0, working: 0, rest: 0 };
  for (const bucket of buckets) if (bucket !== undefined) counts[bucket] += 1;
  return counts;
}

/** Texto da contagem ("1 pede você · 3 trabalhando"); balde zerado não aparece e sem nenhum nó vivo o texto é vazio. */
export function countText(counts: BucketCounts): string {
  return STATE_BUCKETS.filter((bucket) => counts[bucket] > 0).map((bucket) => `${counts[bucket]} ${BUCKET_WORDS[bucket]}`).join(" · ");
}

// ---- rótulos de área e de grupo ----

/** Retângulo em pixels de tela. */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Menor largura e altura, em pixels de tela, de uma área para ela ainda levar rótulo (menos que isso o nome não se lê). */
export const LABEL_MIN_AREA_PX = { w: 56, h: 28 } as const;
/** Recuo do rótulo em relação ao canto da área, em pixels de tela. */
export const LABEL_INSET_PX = 4;
/** Folga ao redor do texto, em pixels de tela, para o fundo do rótulo. */
export const LABEL_PAD_PX = 3;

export interface LabelCandidate {
  id: string;
  /** Retângulo da área ou do grupo na tela. */
  box: ScreenRect;
  /** Quantas linhas de texto o rótulo leva (nome; nome e contagem). */
  lines: number;
}

export interface PlacedLabel {
  id: string;
  /** Onde o rótulo ocupa a tela, incluindo a folga; é também a zona de clique. */
  rect: ScreenRect;
  lines: number;
}

const overlaps = (a: ScreenRect, b: ScreenRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Onde cada rótulo vai: no canto superior esquerdo da caixa, com a largura da caixa menos o recuo, e a altura de `lines`
 * linhas de `fontPx`. A caixa pequena demais fica sem rótulo; as maiores escolhem primeiro e um rótulo que cobriria outro já
 * posto é descartado (o nome de uma área nunca passa por cima do de outra). Empate de tamanho: ordem recebida.
 */
export function placeLabels(candidates: readonly LabelCandidate[], fontPx: number): PlacedLabel[] {
  const lineH = fontPx + 2;
  const order = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.box.w >= LABEL_MIN_AREA_PX.w && c.box.h >= LABEL_MIN_AREA_PX.h)
    .sort((a, b) => b.c.box.w * b.c.box.h - a.c.box.w * a.c.box.h || a.i - b.i);
  const placed: PlacedLabel[] = [];
  for (const { c } of order) {
    // a segunda linha só entra se a caixa a comporta
    const lines = Math.min(c.lines, Math.max(1, Math.floor((c.box.h - 2 * LABEL_INSET_PX) / lineH)));
    const rect: ScreenRect = {
      x: c.box.x + LABEL_INSET_PX - LABEL_PAD_PX,
      y: c.box.y + LABEL_INSET_PX - LABEL_PAD_PX,
      w: c.box.w - 2 * (LABEL_INSET_PX - LABEL_PAD_PX),
      h: lines * lineH + 2 * LABEL_PAD_PX,
    };
    if (placed.some((p) => overlaps(p.rect, rect))) continue;
    placed.push({ id: c.id, rect, lines });
  }
  return placed;
}

/** O rótulo sob o ponto de tela, ou `undefined`. */
export function labelAt(placed: readonly PlacedLabel[], point: { x: number; y: number }): PlacedLabel | undefined {
  return placed.find(({ rect }) => point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h);
}

// ---- resumo por tipo ----

/** Altura mínima do bloco na tela, em pixels, para caber a linha de resumo sob o rótulo; abaixo disso o bloco fica só com o rótulo. */
export const SUMMARY_MIN_BLOCK_PX = 30;

/** Teto do resumo em caracteres, antes do corte por largura: guarda o custo do texto de uma linha que veio de fora. */
export const SUMMARY_MAX_CHARS = 120;

/** O que o resumo lê do nó: o tipo, o registro vivo do grafo (se houver) e o `data` do documento. */
export interface SummaryInput {
  type: string;
  live?: Readonly<Record<string, unknown>>;
  data?: Readonly<Record<string, unknown>>;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** "CI ok", "CI falhou" ou "CI rodando" a partir das contagens do `gh`; `undefined` sem verificação conhecida. */
export function ciWord(ci: unknown): string | undefined {
  if (typeof ci !== "object" || ci === null) return undefined;
  const { failing, pending, passing } = ci as Record<string, unknown>;
  if (count(failing) > 0) return "CI falhou";
  if (count(pending) > 0) return "CI rodando";
  return count(passing) > 0 ? "CI ok" : undefined;
}

const firstLine = (body: string): string => body.split("\n").map((line) => line.trim().replace(/^#+\s*/, "")).find((line) => line !== "") ?? "";

const clip = (value: string): string => (value.length > SUMMARY_MAX_CHARS ? value.slice(0, SUMMARY_MAX_CHARS) : value);

/**
 * A linha de resumo do nó, ou `undefined` quando não há o que dizer além do rótulo.
 * Agente: estado e fase. PR: número e CI. Nota: título ou primeira linha do texto quando o documento os guarda (o corpo da
 * nota mora num arquivo que o motor não lê). Terminal: sem resumo, porque a última linha dele só chega pelo fluxo do tty.
 */
export function summaryOf(input: SummaryInput): string | undefined {
  const { type, live, data } = input;
  switch (type) {
    case "agent": {
      if (live === undefined) return undefined;
      const state = bucketOf({ state: text(live.state), pendingPermission: live.pendingPermission }) === "attention" ? stateLook("", "attention").word : stateLook(text(live.state)).word;
      const phase = text(live.phase);
      return clip(phase === "" ? state : `${state} · ${phase}`);
    }
    case "pr": {
      if (live === undefined) return undefined;
      const number = count(live.number);
      const head = number > 0 ? `#${number}` : "";
      const state = stateLook(text(live.state)).word.toLowerCase();
      const ci = ciWord(live.ci);
      return clip([head, state, ci].filter((part) => part !== undefined && part !== "").join(" · ")) || undefined;
    }
    case "note": {
      const title = text(data?.title);
      if (title !== "") return clip(title);
      return clip(firstLine(text(data?.text))) || undefined;
    }
    default:
      return undefined;
  }
}

/** O bloco na tela tem altura para a linha de resumo (`SUMMARY_MIN_BLOCK_PX`). */
export const summaryFits = (blockHeightPx: number): boolean => blockHeightPx >= SUMMARY_MIN_BLOCK_PX;
