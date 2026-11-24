// `hades panel app`: abre o app gpui do painel (`hades-panel-app`) desacoplado do terminal. O painel web segue sendo o padrão.
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { findStateDir } from "../lib/kit.ts";
import { which } from "../lib/proc.ts";
import { configValue } from "../lib/work.ts";

export const PANEL_APP = "hades-panel-app";
export const PANEL_APP_INSTALL = "cargo install --git https://github.com/The-Hades-Organization/Hades-Panel hades-panel-app";
const VERSION_TIMEOUT_MS = 3000;

/** `HADES_PANEL_APP_BIN` (com `~/`) ou `hades-panel-app` do PATH; `undefined` sem binário. */
export function panelAppBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = configValue("HADES_PANEL_APP_BIN", "", env).trim().replace(/^~(?=$|\/)/, homedir());
  if (!configured) return which(PANEL_APP, env.PATH ?? "");
  if (!configured.includes("/")) return which(configured, env.PATH ?? "");
  return which(basename(configured), dirname(configured));
}

/** Primeira linha do `--version`; vazia quando o binário não responde. */
export function panelAppVersion(bin: string): string {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: VERSION_TIMEOUT_MS });
  return r.status === 0 ? (r.stdout.split("\n")[0] ?? "").trim() : "";
}

/** Lança o app com `HADES_DATA` e o projeto atual (cwd), sem prender o terminal. */
export function launchPanelApp(bin: string): void {
  const data = findStateDir();
  const env = { ...process.env, ...(data ? { HADES_DATA: data } : {}) };
  const child = spawn(bin, [], { cwd: process.cwd(), env, stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}
