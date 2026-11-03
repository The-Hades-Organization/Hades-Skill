// Checagens de estado compartilhadas (doctor e onboard): uma definição só de "está pronto?" (kit/lib-checks.sh, que o doctor do
// plugin ainda carrega em bash). Só leitura.
import { spawnSync } from "node:child_process";
import { run } from "./proc.ts";
import { serviceManager } from "./service-manager.ts";

const DEVTUNNEL_TIMEOUT_MS = 8000;

export function unitIs(unit: string, state: "active" | "enabled"): boolean {
  const manager = serviceManager();
  return (state === "active" ? manager.activeState(unit) : manager.enabledState(unit)) === state;
}

/** Linger ligado; no launchd não existe linger e a resposta é não. */
export function lingering(): boolean {
  if (serviceManager().kind === "launchd") return false;
  const loginctl = process.env.HADES_LOGINCTL || "loginctl";
  return run(loginctl, ["show-user", process.env.USER ?? "", "-p", "Linger", "--value"]).stdout.trim() === "yes";
}

/** Token do gh da conta que abastece o git (HADES_GH_USER ou a ativa); só se mede se há, nunca se mostra. */
export function ghToken(): string {
  const user = process.env.HADES_GH_USER;
  return run("gh", user ? ["auth", "token", "--user", user] : ["auth", "token"]).stdout.replace(/\n+$/, "");
}

export function devtunnelLoggedIn(): boolean {
  const r = spawnSync("devtunnel", ["user", "show"], { encoding: "utf8", timeout: DEVTUNNEL_TIMEOUT_MS });
  // o original mede `devtunnel … | grep` sob pipefail: saída ≠ 0 do devtunnel também vale como deslogado
  return r.status === 0 && /logged in as/i.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}
