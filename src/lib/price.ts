// Tabela de preço dos modelos: a única fonte do custo do Consumo, da divergência de modelo e da ordem de custo do doctor.
import type { Tok } from "./usage.ts";

/** US$/MTok: entrada, saída, leitura de cache. */
export const PRICE: Record<string, readonly [number, number, number]> = {
  "opus-5-5": [4, 20, 0.2],
  "sonnet-5-5": [2, 10, 0.2],
  "haiku-5-5": [0.1, 0.5, 0.01],
  "fable-5-1": [10, 50, 0.25],
  "opus-5": [5, 25, 0.5],
  "opus-4-8": [5, 25, 0.5],
  "sonnet-5": [2, 10, 0.2],
};

const MODEL_KEYS = Object.keys(PRICE).sort((a, b) => b.length - a.length);

const familyOfKey = (key: string): string => key.split("-")[0] ?? key;

/** Famílias do mais barato ao mais caro, pelo maior preço de entrada de cada uma. */
export const MODEL_COST_ORDER: readonly string[] = [...new Set(Object.keys(PRICE).map(familyOfKey))].sort((a, b) => {
  const top = (family: string): number => Math.max(...Object.entries(PRICE).filter(([key]) => familyOfKey(key) === family).map(([, [input]]) => input));
  return top(a) - top(b);
});

/** Chave da tabela para um nome de modelo (`claude-opus-5-5[1m]` → `opus-5-5`); undefined quando não é conhecido. */
export function modelKey(model: unknown): string | undefined {
  const name = (typeof model === "string" ? model : "").replaceAll("claude-", "");
  return MODEL_KEYS.find((key) => name.startsWith(key));
}

/** Como `modelKey`, e o apelido de família (`sonnet`) vale como a versão mais nova dela na tabela. */
export function resolveModelKey(model: unknown): string | undefined {
  const known = modelKey(model);
  if (known !== undefined) return known;
  const family = (typeof model === "string" ? model : "").replaceAll("claude-", "").trim().toLowerCase();
  return Object.keys(PRICE).find((key) => familyOfKey(key) === family);
}

const WRITE_5M_FACTOR = 1.25;

/** US$ de um conjunto de tokens no modelo da chave; a escrita de cache entra como a de 5 min (a divisão por TTL não fica no Tok). */
export function tokCost(key: string, [input, output, write, read]: Tok): number {
  const [inPrice, outPrice, readPrice] = PRICE[key] as readonly [number, number, number];
  return (input * inPrice + output * outPrice + read * readPrice + write * inPrice * WRITE_5M_FACTOR) / 1e6;
}
