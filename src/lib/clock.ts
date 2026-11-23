/** Relógio do Moirai, do Minos e do usage; `HADES_NOW` (ISO 8601) o trava para a matriz de paridade TS × Rust. */
export function clockNow(env: Record<string, string | undefined> = process.env): Date {
  const raw = env.HADES_NOW;
  if (raw === undefined || raw === "") return new Date();
  const fixed = new Date(raw);
  if (Number.isNaN(fixed.getTime())) throw new Error(`HADES_NOW=${raw}: esperava data ISO 8601`);
  return fixed;
}
