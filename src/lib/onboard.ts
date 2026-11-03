// Onboarding do Hades: catálogo (onboard.tsv + o do plugin), escolha do dono ($D/onboard.json) e saída do estado.
// Aqui só se junta catálogo + escolha + resultado das checagens (passo → estado e nota). Nada de segredo passa por
// aqui: o estado diz só feito/pendente, e o comando é o texto do catálogo.
import { chmodSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { die, EXIT } from "./output.ts";
import { readText } from "./fs.ts";
import { pyDumps, splitLines } from "./pyjson.ts";

const FIELDS = 10;
const STATE_KEYS = ["selected", "skipped", "done"] as const;
type StateKey = (typeof STATE_KEYS)[number];
export type TourChoice = "seen" | "skipped";
const TOUR_CHOICES: readonly string[] = ["seen", "skipped"];
/** `tour` é aditivo: ausente = o tour do painel ainda não foi visto nem pulado. */
export type OnboardState = Record<StateKey, string[]> & { tour?: TourChoice };

export interface Feature {
  id: string;
  label: string;
  desc: string;
}
export interface Step {
  feature: string;
  id: string;
  name: string;
  who: string;
  check: string;
  interactive: boolean;
  command: string;
  doc: string;
  page: string;
  detail: string;
}
export interface Catalog {
  features: Map<string, Feature>;
  steps: Step[];
}
export interface StepResult {
  state: string;
  note: string;
}
export interface BuiltStep {
  id: string;
  name: string;
  who: string;
  state: string;
  note: string;
  command: string;
  interactive: boolean;
  doc: string;
  page: string;
  detail: string;
  manual: boolean;
  runnable: boolean;
}
export interface BuiltFeature {
  id: string;
  label: string;
  desc: string;
  choice: "selecionada" | "pulada" | "nova";
  pending: number;
  done: number;
  na: number;
  steps: BuiltStep[];
}

/** Nota do passo que a sonda rápida (--quick) não mede; não conta como pendência na definição de "completo". */
export const NOT_VERIFIED = "não verificado";

export interface OnboardProgress {
  complete: boolean;
  /** Features que o dono ainda não escolheu nem pulou. */
  unchosen: string[];
  /** Passos pendentes das features escolhidas, e quais features os têm. */
  pending: number;
  pendingFeatures: string[];
  tourDone: boolean;
}

/**
 * Definição única de "onboarding completo" (painel, CLI e doctor): toda feature escolhida ou pulada, nenhum passo
 * pendente nas escolhidas, e o tour do painel visto ou pulado.
 */
export function onboardProgress(features: BuiltFeature[], tour: TourChoice | undefined): OnboardProgress {
  const unchosen = features.filter((f) => f.choice === "nova").map((f) => f.label);
  const pendingOf = (f: BuiltFeature): number => f.steps.filter((s) => s.state === "pendente" && s.note !== NOT_VERIFIED).length;
  const withPending = features.filter((f) => f.choice === "selecionada" && pendingOf(f) > 0);
  const pending = withPending.reduce((sum, f) => sum + pendingOf(f), 0);
  const tourDone = tour !== undefined;
  return { complete: unchosen.length === 0 && pending === 0 && tourDone, unchosen, pending, pendingFeatures: withPending.map((f) => f.label), tourDone };
}

/** Uma linha com o que falta e o comando; vazia quando está completo. */
export function onboardLine(progress: OnboardProgress): string {
  if (progress.complete) return "";
  const missing: string[] = [];
  if (progress.unchosen.length > 0) missing.push(`escolher o que preparar (${progress.unchosen.join(", ")})`);
  if (progress.pending > 0) missing.push(`${progress.pending} passo(s) pendente(s) em ${progress.pendingFeatures.join(", ")}`);
  if (!progress.tourDone) missing.push("o tour do painel");
  return `Onboarding: falta ${missing.join("; ")}. Continue com /hades env onboard (nada muda na máquina sem o seu ok).`;
}

const MARK: Record<string, string> = { feito: "✓", pendente: "!", na: "–" };
const TAG = { selecionada: "preparando", pulada: "pulada", nova: "não escolhida" } as const;

/** Estado (escolha do dono) e catálogo de uma instalação; `fw` é o comando de firewall que o texto do catálogo expande. */
export class Onboard {
  readonly dir: string;
  readonly stateFile: string;
  private readonly catalogFile: string;
  private readonly firewall: string;

  constructor(dir: string, catalogFile: string, firewall = "<comando de firewall>") {
    this.dir = dir;
    this.stateFile = join(dir, "onboard.json");
    this.catalogFile = catalogFile;
    this.firewall = firewall;
  }

  expand(command: string): string {
    return command.replaceAll("{D}", this.dir).replaceAll("{FW}", this.firewall);
  }

  /** Núcleo seguido do plugin (id de passo repetido vale o do núcleo). */
  catalog(): Catalog {
    const core = readText(this.catalogFile);
    if (core === undefined) return die(`catálogo do onboarding ausente: ${this.catalogFile}`, EXIT.fail);
    const lines = splitLines(core);
    const plugin = readText(join(this.dir, "plugin", "onboard.tsv"));
    if (plugin !== undefined) lines.push(...splitLines(plugin));
    const features = new Map<string, Feature>();
    const steps: Step[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      if (!line.trim() || line.startsWith("#")) continue;
      const c = line.split("\t");
      const head = c[0] as string;
      if (head.startsWith("@")) {
        const id = head.slice(1);
        if (!features.has(id)) features.set(id, { id, label: c[1] ?? "", desc: c[2] ?? "" });
        continue;
      }
      while (c.length < FIELDS) c.push("");
      const [feature, id, name, who, check, interactive, command, doc, page, detail] = c as [string, string, string, string, string, string, string, string, string, string];
      if (seen.has(id)) continue;
      seen.add(id);
      steps.push({ feature, id, name, who, check, interactive: interactive === "1", command, doc, page, detail });
    }
    return { features, steps };
  }

  load(): OnboardState {
    let parsed: Partial<Record<StateKey, unknown>> = {};
    try {
      const value: unknown = JSON.parse(readText(this.stateFile) ?? "");
      if (typeof value === "object" && value !== null && !Array.isArray(value)) parsed = value as Partial<Record<StateKey, unknown>>;
    } catch {
      parsed = {};
    }
    const pick = (key: StateKey): string[] => {
      const list = parsed[key];
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    };
    const state: OnboardState = { selected: pick("selected"), skipped: pick("skipped"), done: pick("done") };
    const tour = (parsed as { tour?: unknown }).tour;
    if (typeof tour === "string" && TOUR_CHOICES.includes(tour)) state.tour = tour as TourChoice;
    return state;
  }

  save(state: OnboardState): void {
    const tmp = join(this.dir, `.onboard.${randomBytes(6).toString("hex")}`);
    writeFileSync(tmp, pyDumps({ ...state, updated: Math.trunc(Date.now() / 1000) }, 1), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.stateFile);
  }

  asked(): boolean {
    return existsSync(this.stateFile);
  }

  build(catalog: Catalog, results: Map<string, StepResult>): BuiltFeature[] {
    const state = this.load();
    return [...catalog.features.values()].map((feature) => {
      const steps: BuiltStep[] = catalog.steps
        .filter((s) => s.feature === feature.id)
        .map((s) => {
          let { state: current, note } = results.get(s.id) ?? { state: "pendente", note: "" };
          if (current === "manual") current = state.done.includes(s.id) ? "feito" : "pendente";
          return {
            id: s.id,
            name: s.name,
            who: s.who,
            state: current,
            note,
            command: this.expand(s.command),
            interactive: s.interactive,
            doc: s.doc,
            page: s.page,
            detail: this.expand(s.detail),
            manual: s.check === "manual",
            runnable: s.who === "hades" && s.command !== "",
          };
        });
      const choice = state.selected.includes(feature.id) ? "selecionada" : state.skipped.includes(feature.id) ? "pulada" : "nova";
      const count = (name: string): number => steps.filter((x) => x.state === name).length;
      return { id: feature.id, label: feature.label, desc: feature.desc, choice, pending: count("pendente"), done: count("feito"), na: count("na"), steps };
    });
  }
}

export function renderText(features: BuiltFeature[], tty: boolean, only?: string): string {
  const [bold, green, yellow, reset] = tty ? ["\x1b[1m", "\x1b[32m", "\x1b[33m", "\x1b[0m"] : ["", "", "", ""];
  const lines: string[] = [];
  for (const f of features) {
    if (only && f.id !== only) continue;
    lines.push(`${bold}${f.label}${reset} [${f.id}] — ${TAG[f.choice]} · ${f.pending} pendente(s)`);
    for (const s of f.steps) {
      const color = s.state === "feito" ? green : s.state === "pendente" ? yellow : "";
      lines.push(`  ${color}${MARK[s.state] ?? ""}${reset} ${s.name} (${s.who === "dono" ? "dono" : "Hades"})${s.note ? ` — ${s.note}` : ""}`);
      if (!only) continue;
      if (s.detail) lines.push(`      ${s.detail}`);
      if (s.command && s.state !== "feito") lines.push(`      ${s.interactive ? "! " : ""}${s.command}`);
      if (s.doc) lines.push(`      doc: ${s.doc}${s.page ? ` · painel: #/${s.page}` : ""}`);
    }
  }
  return lines.join("\n");
}
