// Minos: o corpo das páginas `explicacao` e `proposta`. Todo texto passa por `esc`; a única marcação aceita no texto é a
// crase (`x` vira <code>), aplicada depois do escape, então nenhum HTML vindo de dado entra cru.
import { esc } from "./minos-esc.ts";
import type {
  CodeData, ExplanationData, Level, ProposalData, ProposalKind, ProposalStatus, SourceData, StepData,
} from "./minos-doc.ts";

const TITLES: Record<ProposalKind, string> = {
  implementacao: "Proposta de implementação", correcao: "Proposta de correção", fluxo: "Proposta de fluxo",
  refatoracao: "Proposta de refatoração", discussao: "Discussão técnica",
};
export const EXPLANATION_TITLE = "Explicação de código";
const STATUS_LABEL: Record<ProposalStatus, [string, string]> = {
  rascunho: ["rascunho", ""], "em-discussao": ["em discussão", "warn"], decidida: ["decidida", "ok"], descartada: ["descartada", "bad"],
};
const LEVEL_LABEL: Record<Level, [string, string]> = { baixo: ["baixo", "ok"], medio: ["médio", "warn"], alto: ["alto", "bad"] };
const NO_VALUE = "—";

export const proposalTitle = (data: ProposalData): string => TITLES[data.kind];
const utcText = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const scopeLabel = (scope: string): string => (scope === "team" ? "página do time" : "página pessoal");

/** Escapa e depois troca `x` por <code>x</code>. */
export const inline = (value: string): string => esc(value).replace(/`([^`\n]+)`/g, "<code>$1</code>");

function section(title: string, summary: string, inner: string): string {
  return `<section><header><h2>${esc(title)}</h2>${summary ? `<span class="muted">${esc(summary)}</span>` : ""}</header>${inner}</section>`;
}

const prose = (items: string[]): string => `<div class="prose">${items.map((p) => `<p>${inline(p)}</p>`).join("")}</div>`;
const bullets = (items: string[]): string => `<ul class="bullets">${items.map((p) => `<li>${inline(p)}</li>`).join("")}</ul>`;
const badge = (label: string, kind: string): string => `<span class="badge${kind ? ` ${kind}` : ""}">${esc(label)}</span>`;
const levelBadge = (name: string, level: Level | null): string => (level ? badge(`${name} ${LEVEL_LABEL[level][0]}`, LEVEL_LABEL[level][1]) : "");

function snippets(items: CodeData[]): string {
  return items.map((c) => {
    const where = [c.file, c.lines].filter(Boolean).join(":");
    const caption = `<figcaption>${esc(where)}${c.lang ? ` · ${esc(c.lang)}` : ""}${c.note ? ` · ${inline(c.note)}` : ""}</figcaption>`;
    return `<figure>${caption}<pre><code>${esc(c.snippet)}</code></pre></figure>`;
  }).join("");
}

function stepList(items: StepData[]): string {
  return `<ol class="steps">${items.map((s) => `<li><span>${inline(s.step)}</span>`
    + `${s.where ? `<span class="mono muted">${esc(s.where)}</span>` : ""}${s.detail ? `<span class="muted">${inline(s.detail)}</span>` : ""}</li>`).join("")}</ol>`;
}

function sourceLine(src: SourceData): string {
  const parts = [src.repo, src.ref].filter((x): x is string => Boolean(x));
  const paths = src.paths.length ? ` · ${src.paths.map((p) => `<code>${esc(p)}</code>`).join(" ")}` : "";
  return parts.length || paths ? `<div class="meta mono">${esc(parts.join(" @ "))}${paths}</div>` : "";
}

function head(title: string, kicker: string, generatedAt: string, scope: string, lead: string, extra = ""): string {
  return `<header><h1>${esc(title)}</h1><div class="meta">${esc(kicker)} · ${esc(scopeLabel(scope))} · atualizado em ${esc(utcText(generatedAt))}</div>`
    + `${extra}<p class="lead">${inline(lead)}</p></header>`;
}

export function explanationDescription(data: ExplanationData): string {
  return `Explicação de ${data.title}: ${plural(data.flow.length, "passo", "passos")} no fluxo, ${plural(data.sections.length, "seção", "seções")}, `
    + `${plural(data.files.length, "arquivo", "arquivos")}.`;
}

export function renderExplanationBody(data: ExplanationData): string {
  const parts = [head(data.title, EXPLANATION_TITLE, data.generatedAt, data.scope, data.summary, sourceLine(data.source))];
  if (data.question) parts.push(section("Pergunta", "", prose([data.question])));
  if (data.flow.length) parts.push(section("Fluxo", plural(data.flow.length, "passo", "passos"), stepList(data.flow)));
  for (const s of data.sections) parts.push(section(s.title, "", `${s.paragraphs.length ? prose(s.paragraphs) : ""}${snippets(s.code)}`));
  if (data.files.length) {
    const rows = data.files.map((f) => `<tr><td class="mono">${esc(f.path)}</td><td>${inline(f.role)}</td></tr>`);
    parts.push(section("Arquivos", plural(rows.length, "arquivo", "arquivos"), `<div class="tablewrap"><table><tr><th>Arquivo</th><th>Papel</th></tr>${rows.join("")}</table></div>`));
  }
  if (data.glossary.length) {
    parts.push(section("Glossário", "", `<ul>${data.glossary.map((g) => `<li class="row"><strong>${esc(g.term)}</strong><span class="grow">${inline(g.meaning)}</span></li>`).join("")}</ul>`));
  }
  if (data.caveats.length) parts.push(section("Ressalvas", "o que não foi verificado", bullets(data.caveats)));
  if (data.nextQuestions.length) parts.push(section("Para investigar", "", bullets(data.nextQuestions)));
  return parts.join("\n  ");
}

const openQuestions = (data: ProposalData): number => data.questions.filter((q) => q.status === "aberta").length;

export function proposalDescription(data: ProposalData): string {
  return `${proposalTitle(data)}: ${data.title} (${STATUS_LABEL[data.status][0]}), ${plural(data.options.length, "opção", "opções")}, `
    + `${plural(openQuestions(data), "pergunta aberta", "perguntas abertas")}.`;
}

function optionCard(o: ProposalData["options"][number], chosen: boolean): string {
  const badges = [chosen ? badge("recomendada", "vivo") : "", levelBadge("esforço", o.effort), levelBadge("risco", o.risk)].filter(Boolean).join(" ");
  const cols = [o.pros.length ? `<div><h3>A favor</h3>${bullets(o.pros)}</div>` : "", o.cons.length ? `<div><h3>Contra</h3>${bullets(o.cons)}</div>` : ""].join("");
  const touches = o.touches.length ? `<div class="meta">toca: ${o.touches.map((t) => `<code>${esc(t)}</code>`).join(" ")}</div>` : "";
  return `<div class="option${chosen ? " chosen" : ""}"><div class="row"><h3>${esc(o.id)} · ${esc(o.title)}</h3>${badges ? `<span>${badges}</span>` : ""}</div>`
    + `<p>${inline(o.summary)}</p>${cols ? `<div class="cols">${cols}</div>` : ""}${touches}${snippets(o.sketch)}</div>`;
}

function comparison(data: ProposalData, chosen: string | null): string {
  if (data.options.length < 2) return "";
  const cell = (l: Level | null): string => (l ? badge(LEVEL_LABEL[l][0], LEVEL_LABEL[l][1]) : NO_VALUE);
  const rows = data.options.map((o) => `<tr><td>${esc(o.id)}${o.id === chosen ? ` ${badge("recomendada", "vivo")}` : ""}</td><td>${esc(o.title)}</td>`
    + `<td>${cell(o.effort)}</td><td>${cell(o.risk)}</td></tr>`);
  return `<div class="tablewrap"><table><tr><th>Opção</th><th>Título</th><th>Esforço</th><th>Risco</th></tr>${rows.join("")}</table></div>`;
}

export function renderProposalBody(data: ProposalData): string {
  const [statusLabel, statusKind] = STATUS_LABEL[data.status];
  const chosen = data.recommendation?.option ?? null;
  const open = data.questions.filter((q) => q.status === "aberta");
  const answered = data.questions.filter((q) => q.status === "respondida");
  const parts = [head(data.title, proposalTitle(data), data.generatedAt, data.scope, data.summary,
    `${sourceLine(data.source)}<div class="meta">${badge(statusLabel, statusKind)}</div>`)];
  if (open.length) {
    parts.push(section("Perguntas em aberto", plural(open.length, "aberta", "abertas"),
      `<ul>${open.map((q) => `<li class="row"><span class="mono muted">${esc(q.id)}</span><span class="grow">${inline(q.question)}</span></li>`).join("")}</ul>`));
  }
  if (data.context.length) parts.push(section("Contexto", "", prose(data.context)));
  if (data.problem.length) parts.push(section("Problema", "", prose(data.problem)));
  if (data.goals.length || data.nonGoals.length) {
    const cols = [data.goals.length ? `<div><h3>Objetivos</h3>${bullets(data.goals)}</div>` : "", data.nonGoals.length ? `<div><h3>Fora do escopo</h3>${bullets(data.nonGoals)}</div>` : ""];
    parts.push(section("Escopo", "", `<div class="cols">${cols.join("")}</div>`));
  }
  if (data.currentFlow.length || data.proposedFlow.length) {
    const cols = [data.currentFlow.length ? `<div><h3>Hoje</h3>${stepList(data.currentFlow)}</div>` : "", data.proposedFlow.length ? `<div><h3>Proposto</h3>${stepList(data.proposedFlow)}</div>` : ""];
    parts.push(section("Fluxo", "", `<div class="cols">${cols.join("")}</div>`));
  }
  if (data.options.length) {
    parts.push(section("Opções", plural(data.options.length, "opção", "opções"), `${comparison(data, chosen)}${data.options.map((o) => optionCard(o, o.id === chosen)).join("")}`));
  }
  if (data.recommendation) {
    const which = chosen ? `<p><strong>${esc(chosen)}</strong> · ${esc(data.options.find((o) => o.id === chosen)?.title ?? "")}</p>` : "";
    parts.push(section("Recomendação", "", `${which}${data.recommendation.why.length ? bullets(data.recommendation.why) : ""}`));
  }
  if (data.plan.length) parts.push(section("Plano", plural(data.plan.length, "passo", "passos"), stepList(data.plan)));
  if (data.risks.length) {
    const rows = data.risks.map((r) => `<tr><td>${inline(r.risk)}</td><td>${r.mitigation ? inline(r.mitigation) : NO_VALUE}</td></tr>`);
    parts.push(section("Riscos", plural(rows.length, "risco", "riscos"), `<div class="tablewrap"><table><tr><th>Risco</th><th>Mitigação</th></tr>${rows.join("")}</table></div>`));
  }
  if (answered.length) {
    parts.push(section("Perguntas respondidas", "", `<ul>${answered.map((q) => `<li><div class="row"><span class="mono muted">${esc(q.id)}</span>`
      + `<span class="grow">${inline(q.question)}</span></div>${q.answer ? `<p class="muted">${inline(q.answer)}</p>` : ""}</li>`).join("")}</ul>`));
  }
  if (data.references.length) {
    parts.push(section("Referências", "", `<ul>${data.references.map((r) => `<li class="row"><span>${inline(r.label)}</span><span class="grow mono muted">${esc(r.ref)}</span></li>`).join("")}</ul>`));
  }
  return parts.join("\n  ");
}
