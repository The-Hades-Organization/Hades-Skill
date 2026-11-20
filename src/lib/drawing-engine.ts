// Motor de desenho do canvas (reference/extensoes.md §Cardinal): `hades` é o Desenho atual, `cardinal` vem da extensão.
// O valor configurado nunca é lido às cegas: `cardinal` só vale com a extensão ligada e o binário saudável ou o build web presente.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isEnabled, loadManifests, statusOf, type ExtensionDeps, type ExtensionStatus } from "./extension.ts";
import { home } from "./paths.ts";

export const ENGINE_KEY = "HADES_DRAWING_ENGINE";
export const CARDINAL_WEB_KEY = "HADES_CARDINAL_WEB";
export const CARDINAL_EXT = "cardinal";

export type DrawingEngine = "hades" | "cardinal";

/** Códigos estáveis do que impede o Cardinal (só ganham valores); os do binário vêm de `ext.*` (EXT_ERRORS). */
export const ENGINE_REASONS = {
  extensionMissing: "engine.extension-missing",
  extensionOff: "engine.extension-off",
} as const;

export interface EngineReason {
  code: string;
  message: string;
}

export interface EngineView {
  configured: DrawingEngine;
  effective: DrawingEngine;
  /** a extensão está em condição de ser o motor, seja qual for o valor configurado */
  usable: boolean;
  /** por que o Cardinal não vale agora; null quando vale */
  reason: EngineReason | null;
}

/** Padrão `cardinal` (decisão do dono, U17): só `hades` explícito mantém o Desenho antigo. Sem extensão utilizável o efetivo cai para `hades`. */
export function configuredEngine(config: ReadonlyMap<string, string>): DrawingEngine {
  return config.get(ENGINE_KEY) === "hades" ? "hades" : "cardinal";
}

/** Julgamento puro: recebe o estado medido da extensão (undefined = manifesto ausente) e se o build web existe. */
export function judgeEngine(config: ReadonlyMap<string, string>, status: ExtensionStatus | undefined, webPresent: boolean): EngineView {
  const configured = configuredEngine(config);
  let reason: EngineReason | null = null;
  if (status === undefined) reason = { code: ENGINE_REASONS.extensionMissing, message: "a extensão cardinal não está nesta instalação" };
  else if (!status.enabled) reason = { code: ENGINE_REASONS.extensionOff, message: "a extensão cardinal está desligada" };
  else if (!webPresent && (!status.installed || status.problems.length > 0)) {
    const problem = status.problems[0];
    reason = problem === undefined ? { code: "ext.binary-missing", message: "binário do cardinal não encontrado" } : { code: problem.code, message: problem.message };
  }
  const usable = reason === null;
  return { configured, effective: configured === "cardinal" && usable ? "cardinal" : "hades", usable, reason };
}

/** A pasta do build web tem o index.html? Valor vazio = não configurado. */
export function webBuildPresent(dir: string | undefined): boolean {
  if (dir === undefined || dir === "") return false;
  const abs = dir === "~" || dir.startsWith("~/") ? join(home(), dir.slice(1)) : dir;
  return existsSync(join(abs, "index.html"));
}

export function drawingEngine(deps: ExtensionDeps, webPresent: (dir: string | undefined) => boolean = webBuildPresent): EngineView {
  const found = loadManifests().extensions.find((e) => e.manifest.name === CARDINAL_EXT);
  if (found === undefined) return judgeEngine(deps.config, undefined, false);
  // desligada não mede nada: não roda binário que o dono mandou ignorar
  const status = isEnabled(found.manifest, deps.config) ? statusOf(found.manifest, deps) : statusOf(found.manifest, { ...deps, run: () => ({ status: 1, stdout: "", stderr: "", timedOut: false }) });
  return judgeEngine(deps.config, status, webPresent(deps.config.get(CARDINAL_WEB_KEY)));
}
