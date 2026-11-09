// Minos: os modelos de documento, `explicacao` (explicação de código) e `proposta` (proposta ou discussão de implementação,
// correção, fluxo ou refatoração). A sessão escreve o JSON; aqui ele é conferido na fronteira. `title` e `summary` são
// obrigatórios; lista ausente vira lista vazia e campo opcional ausente vira null, nunca valor inventado.
import { ContractError, SCOPES, list, obj, oneOf, text, utc, type Obj, type Scope } from "./minos-check.ts";

export const EXPLICACAO_SCHEMA = 1;
export const PROPOSTA_SCHEMA = 1;
export const PARAGRAPH_MAX = 4000;
export const SNIPPET_MAX = 12000;
const SNIPPETS_MAX = 40;

export const PROPOSAL_KINDS = ["implementacao", "correcao", "fluxo", "refatoracao", "discussao"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const PROPOSAL_STATUSES = ["rascunho", "em-discussao", "decidida", "descartada"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const LEVELS = ["baixo", "medio", "alto"] as const;
export type Level = (typeof LEVELS)[number];
export const QUESTION_STATUSES = ["aberta", "respondida"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export interface SourceData { repo: string | null; ref: string | null; paths: string[] }
export interface CodeData { file: string; lines: string | null; lang: string | null; snippet: string; note: string | null }
export interface StepData { step: string; where: string | null; detail: string | null }
export interface SectionData { title: string; paragraphs: string[]; code: CodeData[] }
export interface FileRoleData { path: string; role: string }
export interface TermData { term: string; meaning: string }

export interface ExplanationData {
  model: "explicacao";
  schema: number;
  scope: Scope;
  generatedAt: string;
  title: string;
  question: string | null;
  summary: string;
  source: SourceData;
  flow: StepData[];
  sections: SectionData[];
  files: FileRoleData[];
  glossary: TermData[];
  caveats: string[];
  nextQuestions: string[];
}

export interface OptionData {
  id: string; title: string; summary: string; pros: string[]; cons: string[];
  effort: Level | null; risk: Level | null; touches: string[]; sketch: CodeData[];
}
export interface RiskData { risk: string; mitigation: string | null }
export interface QuestionData { id: string; question: string; status: QuestionStatus; answer: string | null }
export interface ReferenceData { label: string; ref: string }

export interface ProposalData {
  model: "proposta";
  schema: number;
  scope: Scope;
  generatedAt: string;
  kind: ProposalKind;
  status: ProposalStatus;
  title: string;
  summary: string;
  source: SourceData;
  context: string[];
  problem: string[];
  goals: string[];
  nonGoals: string[];
  currentFlow: StepData[];
  proposedFlow: StepData[];
  options: OptionData[];
  recommendation: { option: string | null; why: string[] } | null;
  plan: StepData[];
  risks: RiskData[];
  questions: QuestionData[];
  references: ReferenceData[];
}

const optText = (value: unknown, path: string, max?: number): string | null => (value === undefined || value === null ? null : text(value, path, max));
const optList = (value: unknown, path: string, max?: number): unknown[] => (value === undefined || value === null ? [] : list(value, path, max));
const texts = (value: unknown, path: string, max?: number): string[] => optList(value, path).map((t, i) => text(t, `${path}[${i}]`, max));
const paragraphs = (value: unknown, path: string): string[] => texts(value, path, PARAGRAPH_MAX);
const optLevel = (value: unknown, path: string): Level | null => (value === undefined || value === null ? null : oneOf(value, LEVELS, path));

function header(o: Obj, model: string, schema: number): { scope: Scope; generatedAt: string } {
  if (o.model !== model) throw new ContractError("model", `esperava "${model}"`);
  if (o.schema !== schema) throw new ContractError("schema", `versão ${String(o.schema)} não suportada (esta é a ${schema})`);
  return { scope: oneOf(o.scope, SCOPES, "scope"), generatedAt: utc(o.generatedAt, "generatedAt") };
}

function source(value: unknown): SourceData {
  if (value === undefined || value === null) return { repo: null, ref: null, paths: [] };
  const o = obj(value, "source");
  return { repo: optText(o.repo, "source.repo"), ref: optText(o.ref, "source.ref"), paths: texts(o.paths, "source.paths") };
}

function code(value: unknown, path: string): CodeData[] {
  return optList(value, path, SNIPPETS_MAX).map((c, i) => {
    const x = obj(c, `${path}[${i}]`);
    return {
      file: text(x.file, `${path}[${i}].file`), lines: optText(x.lines, `${path}[${i}].lines`), lang: optText(x.lang, `${path}[${i}].lang`),
      snippet: text(x.snippet, `${path}[${i}].snippet`, SNIPPET_MAX), note: optText(x.note, `${path}[${i}].note`, PARAGRAPH_MAX),
    };
  });
}

function steps(value: unknown, path: string): StepData[] {
  return optList(value, path).map((s, i) => {
    const x = obj(s, `${path}[${i}]`);
    return { step: text(x.step, `${path}[${i}].step`), where: optText(x.where, `${path}[${i}].where`), detail: optText(x.detail, `${path}[${i}].detail`, PARAGRAPH_MAX) };
  });
}

function pairs<K extends string, V extends string>(value: unknown, path: string, k: K, v: V, vMax?: number): Array<Record<K | V, string>> {
  return optList(value, path).map((p, i) => {
    const x = obj(p, `${path}[${i}]`);
    return { [k]: text(x[k], `${path}[${i}].${k}`), [v]: text(x[v], `${path}[${i}].${v}`, vMax) } as Record<K | V, string>;
  });
}

export function validateExplanation(input: unknown): ExplanationData {
  const o = obj(input, "$");
  const head = header(o, "explicacao", EXPLICACAO_SCHEMA);
  return {
    model: "explicacao", schema: EXPLICACAO_SCHEMA, ...head,
    title: text(o.title, "title"), question: optText(o.question, "question", PARAGRAPH_MAX), summary: text(o.summary, "summary", PARAGRAPH_MAX),
    source: source(o.source), flow: steps(o.flow, "flow"),
    sections: optList(o.sections, "sections").map((s, i) => {
      const x = obj(s, `sections[${i}]`);
      return { title: text(x.title, `sections[${i}].title`), paragraphs: paragraphs(x.paragraphs, `sections[${i}].paragraphs`), code: code(x.code, `sections[${i}].code`) };
    }),
    files: pairs(o.files, "files", "path", "role"), glossary: pairs(o.glossary, "glossary", "term", "meaning", PARAGRAPH_MAX),
    caveats: paragraphs(o.caveats, "caveats"), nextQuestions: paragraphs(o.nextQuestions, "nextQuestions"),
  };
}

function options(value: unknown): OptionData[] {
  const seen = new Set<string>();
  return optList(value, "options").map((p, i) => {
    const at = `options[${i}]`;
    const x = obj(p, at);
    const id = text(x.id, `${at}.id`);
    if (seen.has(id)) throw new ContractError(`${at}.id`, "id repetido");
    seen.add(id);
    return {
      id, title: text(x.title, `${at}.title`), summary: text(x.summary, `${at}.summary`, PARAGRAPH_MAX),
      pros: paragraphs(x.pros, `${at}.pros`), cons: paragraphs(x.cons, `${at}.cons`),
      effort: optLevel(x.effort, `${at}.effort`), risk: optLevel(x.risk, `${at}.risk`),
      touches: texts(x.touches, `${at}.touches`), sketch: code(x.sketch, `${at}.sketch`),
    };
  });
}

function recommendation(value: unknown, ids: Set<string>): ProposalData["recommendation"] {
  if (value === undefined || value === null) return null;
  const o = obj(value, "recommendation");
  const option = optText(o.option, "recommendation.option");
  if (option !== null && !ids.has(option)) throw new ContractError("recommendation.option", "não é o id de nenhuma opção");
  return { option, why: paragraphs(o.why, "recommendation.why") };
}

export function validateProposal(input: unknown): ProposalData {
  const o = obj(input, "$");
  const head = header(o, "proposta", PROPOSTA_SCHEMA);
  const opts = options(o.options);
  return {
    model: "proposta", schema: PROPOSTA_SCHEMA, ...head,
    kind: oneOf(o.kind, PROPOSAL_KINDS, "kind"), status: oneOf(o.status ?? "rascunho", PROPOSAL_STATUSES, "status"),
    title: text(o.title, "title"), summary: text(o.summary, "summary", PARAGRAPH_MAX), source: source(o.source),
    context: paragraphs(o.context, "context"), problem: paragraphs(o.problem, "problem"),
    goals: paragraphs(o.goals, "goals"), nonGoals: paragraphs(o.nonGoals, "nonGoals"),
    currentFlow: steps(o.currentFlow, "currentFlow"), proposedFlow: steps(o.proposedFlow, "proposedFlow"),
    options: opts, recommendation: recommendation(o.recommendation, new Set(opts.map((x) => x.id))),
    plan: steps(o.plan, "plan"),
    risks: optList(o.risks, "risks").map((r, i) => {
      const x = obj(r, `risks[${i}]`);
      return { risk: text(x.risk, `risks[${i}].risk`, PARAGRAPH_MAX), mitigation: optText(x.mitigation, `risks[${i}].mitigation`, PARAGRAPH_MAX) };
    }),
    questions: optList(o.questions, "questions").map((q, i) => {
      const x = obj(q, `questions[${i}]`);
      return {
        id: text(x.id, `questions[${i}].id`), question: text(x.question, `questions[${i}].question`, PARAGRAPH_MAX),
        status: oneOf(x.status ?? "aberta", QUESTION_STATUSES, `questions[${i}].status`), answer: optText(x.answer, `questions[${i}].answer`, PARAGRAPH_MAX),
      };
    }),
    references: pairs(o.references, "references", "label", "ref"),
  };
}

/**
 * Esqueletos para `hades minos schema <modelo>`: `scope` e `generatedAt` a CLI preenche quando faltam. Cada texto do
 * exemplo mostra o tom esperado (conclusão primeiro, afirmação com `arquivo:linha`, lacuna nomeada), não só o formato.
 */
export const EXPLICACAO_EXAMPLE = {
  model: "explicacao", schema: EXPLICACAO_SCHEMA,
  title: "Como o pedido vira registro", question: "O que acontece entre a rota POST /pedidos e a gravação no banco?",
  summary: "A rota valida o corpo e entrega ao handler, que grava o pedido e o evento na mesma transação. Corpo com campo desconhecido volta 400 antes de chegar ao handler.",
  source: { repo: "dono/repo", ref: "main@abc1234", paths: ["src/pedidos/"] },
  flow: [
    { step: "A rota valida o corpo", where: "src/pedidos/rota.ts:42", detail: "Campo desconhecido volta 400 aqui." },
    { step: "O handler grava pedido e evento numa transação", where: "src/pedidos/criar.handler.ts:18", detail: null },
  ],
  sections: [{
    title: "Validação",
    paragraphs: ["`valida` recusa o corpo inteiro no primeiro campo inválido; a resposta lista só esse campo."],
    code: [{ file: "src/pedidos/rota.ts", lines: "40-48", lang: "ts", snippet: "export function valida(corpo: unknown): Pedido {\n  return esquema.parse(corpo);\n}", note: "A recusa acontece no parse." }],
  }],
  files: [{ path: "src/pedidos/rota.ts", role: "entrada HTTP e validação" }, { path: "src/pedidos/criar.handler.ts", role: "transação de gravação" }],
  glossary: [{ term: "handler", meaning: "a classe que executa um caso de uso" }],
  caveats: ["Não conferi o comportamento com o banco fora do ar: o código não trata esse caso e não há teste dele."],
  nextQuestions: ["Quem consome o evento gravado na transação?"],
} as const;

export const PROPOSTA_EXAMPLE = {
  model: "proposta", schema: PROPOSTA_SCHEMA, kind: "correcao", status: "em-discussao",
  title: "Reprocessar pedidos presos",
  summary: "Proponho tentar de novo com espera crescente (opção A): resolve o caso medido sem operação manual e muda só o consumidor.",
  source: { repo: "dono/repo", ref: "main@abc1234", paths: ["src/pedidos/"] },
  context: ["Em 3 de novembro, 41 pedidos ficaram presos depois de uma queda do banco de 2 minutos (log do consumidor)."],
  problem: ["O consumidor descarta a mensagem na primeira falha (`src/pedidos/consumidor.ts:88`), então uma queda curta perde o pedido."],
  goals: ["Pedido preso por falha transitória volta a andar sozinho."], nonGoals: ["Mudar o formato do evento."],
  currentFlow: [{ step: "O consumidor falha e descarta a mensagem", where: "src/pedidos/consumidor.ts:88", detail: null }],
  proposedFlow: [{ step: "O consumidor falha e agenda nova tentativa", where: "src/pedidos/consumidor.ts", detail: "Espera de 1, 4 e 16 s; depois da terceira, vai para a fila de mortos." }],
  options: [
    {
      id: "A", title: "Nova tentativa com espera crescente", summary: "Três tentativas no próprio consumidor antes da fila de mortos.",
      pros: ["Cobre a queda de 2 minutos medida."], cons: ["Segura a partição durante as esperas."],
      effort: "medio", risk: "baixo", touches: ["src/pedidos/consumidor.ts"], sketch: [],
    },
    {
      id: "B", title: "Fila de mortos e reprocesso manual", summary: "Toda falha vai direto para a fila de mortos; alguém reprocessa.",
      pros: ["Não segura a partição."], cons: ["Depende de alguém olhar a fila."],
      effort: "baixo", risk: "medio", touches: ["src/pedidos/consumidor.ts"], sketch: [],
    },
  ],
  recommendation: { option: "A", why: ["A queda medida dura menos que a soma das esperas (21 s), então a maioria se resolve sem gente."] },
  plan: [{ step: "Spec da nova tentativa", where: null, detail: "Antes do código." }, { step: "Teste com o banco derrubado no meio do consumo", where: null, detail: null }],
  risks: [{ risk: "Esperas somadas atrasam a partição inteira", mitigation: "Teto de 21 s por mensagem; acima disso, fila de mortos." }],
  questions: [{ id: "Q1", question: "Quedas acima de 21 s acontecem? Não achei métrica disso.", status: "aberta", answer: null }],
  references: [{ label: "Log do consumidor de 3/11", ref: "observabilidade, consulta salva pedidos-presos" }],
} as const;
