// Log do painel: uma linha JSON por evento em stderr (a unit do systemd o leva ao journal). Sem corpo de requisição nem
// credencial: só identificadores e o motivo.
export type Level = "info" | "warn" | "error";

export function log(level: Level, event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level, service: "hades-panel", event, ...fields })}\n`);
}
