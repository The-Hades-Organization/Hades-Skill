// Minos: as páginas. O modelo (kit/minos/pagina.html) é estático e o mesmo para todos; o corpo sai dos dados já validados
// e tudo que é texto passa por `esc`. Sem script e sem recurso externo: serve ao Artifact e ao `--html` offline. O corpo de
// `orquestracao` mora aqui; o de `explicacao` e `proposta`, em minos-doc-html.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { skillRoot } from "./paths.ts";
import { esc } from "./minos-esc.ts";
import {
  EXPLANATION_TITLE, explanationDescription, proposalDescription, proposalTitle, renderExplanationBody, renderProposalBody,
} from "./minos-doc-html.ts";
import type { ExplanationData, ProposalData } from "./minos-doc.ts";
import type { AgentState, Confidence, OrchestrationData } from "./minos-model.ts";

export { esc } from "./minos-esc.ts";
export type MinosData = OrchestrationData | ExplanationData | ProposalData;

const STATE_LABEL: Record<AgentState, [string, string]> = {
  working: ["trabalhando", "busy"], idle: ["ocioso", "ok"], blocked: ["espera por você", "warn"], unknown: ["sem sessão", ""],
  done: ["concluído", "ok"], archived: ["arquivado", ""],
};
const CONFIDENCE_LABEL: Record<Confidence, string> = { alta: "alta", media: "média", baixa: "baixa", nenhuma: "sem histórico" };
const TITLES = { personal: "Orquestração Hades", team: "Orquestração do time" } as const;
const NO_VALUE = "—";
const COST_DECIMALS = 2;
const ENDED: readonly AgentState[] = ["done", "archived"];

export const pageTitle = (data: OrchestrationData): string => TITLES[data.scope];

const activeCount = (data: OrchestrationData): number => data.agents.filter((a) => !ENDED.includes(a.state)).length;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const utcText = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;

export function pageDescription(data: OrchestrationData): string {
  return `Acompanhamento de ${data.plan.title}: ${plural(activeCount(data), "agente ativo", "agentes ativos")}, `
    + `${plural(data.escalations.length, "pergunta aberta", "perguntas abertas")}, ${plural(data.prs.length, "PR", "PRs")}.`;
}

export function loadTemplate(): string {
  return readFileSync(join(skillRoot, "kit", "minos", "pagina.html"), "utf8");
}

function section(title: string, summary: string, inner: string): string {
  return `<section><header><h2>${esc(title)}</h2><span class="muted">${esc(summary)}</span></header>${inner}</section>`;
}

const empty = (message: string): string => `<p class="muted">${esc(message)}</p>`;
const table = (head: string[], rows: string[]): string => `<div class="tablewrap"><table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows.join("")}</table></div>`;

function escalations(data: OrchestrationData): string {
  const items = data.escalations.map((e) => `<li class="row"><span class="mono muted">${esc(e.agent)}</span><span class="grow">${esc(e.question)}</span></li>`);
  return section("Perguntas ao dono", plural(items.length, "aberta", "abertas"), items.length ? `<ul>${items.join("")}</ul>` : empty("Nenhuma pergunta aberta."));
}

function agents(data: OrchestrationData): string {
  const items = data.agents.map((a) => {
    const [label, kind] = STATE_LABEL[a.state];
    const extra = [a.phase, a.branch, a.pr !== null ? `#${a.pr}` : ""].filter(Boolean).join(" · ");
    const flags = [a.openQuestions ? `<span class="warn-text">${esc(plural(a.openQuestions, "pergunta aberta", "perguntas abertas"))}</span>` : "",
      a.reportDone ? "<span>relatório pronto</span>" : ""].filter(Boolean).join(" · ");
    return `<li class="row"><strong>${esc(a.name)}</strong><span class="muted">${esc(a.mode)}</span>`
      + `<span><span class="dot ${kind}"></span>${esc(label)}</span><span class="grow mono muted">${esc(extra)}</span>${flags ? `<span>${flags}</span>` : ""}</li>`;
  });
  return section("Agentes", plural(items.length, "agente", "agentes"), items.length ? `<ul>${items.join("")}</ul>` : empty("Nenhum agente registrado."));
}

function prs(data: OrchestrationData): string {
  const rows = data.prs.map((p) => `<tr><td class="num">#${p.number}</td><td class="mono">${esc(p.branch)}</td><td>${esc(p.agent)}</td></tr>`);
  return section("PRs", plural(rows.length, "PR", "PRs"), rows.length ? table(["PR", "Branch", "Agente"], rows) : empty("Nenhuma PR aberta."));
}

function plan(data: OrchestrationData): string {
  const state = data.plan.state.length ? `<ul>${data.plan.state.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : empty('Plano sem "Estado atual".');
  const rows = data.plan.units.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.role)}</td><td>${esc(u.dependsOn.join(", ") || NO_VALUE)}</td></tr>`);
  const units = rows.length ? table(["Unidade", "Papel", "Depende de"], rows) : "";
  return section("Plano", plural(rows.length, "unidade", "unidades"), `${data.plan.objective ? `<p>${esc(data.plan.objective)}</p>` : ""}${state}${units}`);
}

function meter(label: string, limit: { pct: number; resetsAt: string } | null): string {
  if (!limit) return `<div><div class="row"><strong>${esc(label)}</strong><span class="muted">sem amostras</span></div></div>`;
  const pct = Math.round(limit.pct);
  return `<div><div class="row"><strong>${esc(label)}</strong><span class="mono">${pct}%</span><span class="muted">renova ${esc(utcText(limit.resetsAt))}</span></div>`
    + `<div class="meter" role="img" aria-label="${esc(label)}: ${pct}% usado"><span style="width:${pct}%"></span></div></div>`;
}

function consumption(data: OrchestrationData): string {
  const { estimate, limits } = data.consumption;
  const rows = estimate.map((e) => `<tr><td>${esc(e.unit)}</td><td class="num">${e.costP50 === null ? NO_VALUE : `US$ ${e.costP50.toFixed(COST_DECIMALS)}`}</td>`
    + `<td class="num">${e.minutesP50 === null ? NO_VALUE : `${Math.round(e.minutesP50)} min`}</td><td>${esc(CONFIDENCE_LABEL[e.confidence])}</td></tr>`);
  const estimates = rows.length ? table(["Unidade", "Custo (mediana)", "Duração (mediana)", "Confiança"], rows) : empty("Plano sem estimativa da Moirai.");
  return section("Consumo", "Moirai e janelas de uso", `${meter("Janela de 5 h", limits.five)}${meter("Janela semanal", limits.seven)}${estimates}`);
}

export function renderOrchestrationBody(data: OrchestrationData): string {
  const lead = data.escalations.length ? plural(data.escalations.length, "pergunta aberta", "perguntas abertas") : "nenhuma pergunta aberta";
  const header = `<header><h1>${esc(data.plan.title)}</h1>`
    + `<div class="meta">${esc(pageTitle(data))} · atualizado em ${esc(utcText(data.generatedAt))}</div>`
    + `<p class="lead">${esc(lead)} · ${esc(plural(activeCount(data), "agente ativo", "agentes ativos"))} · ${esc(plural(data.prs.length, "PR", "PRs"))}</p></header>`;
  return [header, escalations(data), agents(data), prs(data), plan(data), consumption(data)].join("\n  ");
}

/** JSON dentro de <script>: `<` vira \\u003c, então nenhum dado fecha o bloco nem abre outro. */
export const dataBlock = (data: MinosData): string =>
  JSON.stringify(data).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

export function titleOf(data: MinosData): string {
  if (data.model === "orquestracao") return pageTitle(data);
  return data.model === "explicacao" ? EXPLANATION_TITLE : proposalTitle(data);
}

export function descriptionOf(data: MinosData): string {
  if (data.model === "orquestracao") return pageDescription(data);
  return data.model === "explicacao" ? explanationDescription(data) : proposalDescription(data);
}

function bodyOf(data: MinosData): string {
  if (data.model === "orquestracao") return renderOrchestrationBody(data);
  return data.model === "explicacao" ? renderExplanationBody(data) : renderProposalBody(data);
}

export function renderPage(template: string, data: MinosData): string {
  const values: Record<string, string> = { LAYOUT: data.model === "orquestracao" ? "ops" : "doc", TITLE: esc(titleOf(data)), DESCRIPTION: esc(descriptionOf(data)), BODY: bodyOf(data), DATA: dataBlock(data) };
  // uma passada só: o valor inserido nunca é relido como marcador
  return template.replace(/\{\{([A-Z]+)\}\}/g, (all, key: string) => values[key] ?? all);
}

export const renderOrchestrationHtml = (template: string, data: OrchestrationData): string => renderPage(template, data);
