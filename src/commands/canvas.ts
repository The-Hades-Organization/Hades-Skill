// `hades canvas`: o agente de um terminal do canvas fala com o painel local (reference/argos.md §Conexões e §Orquestrador
// no canvas). `note list|read|write` lê e grava as notas a que o nó dele está ligado; `recruit|connect|reassign|dismiss`
// são do orquestrador (D7) sobre os recrutas dele; `notify` manda uma notificação ao dono. O nó de quem chama se resolve
// pelo pane do herdr em que o processo roda (HERDR_PANE_ID e a sessão do socket). Tudo passa pelas rotas do painel: o
// documento muda por `CanvasOp` (desfazer volta exatamente ao anterior) e a escrita na nota é conferida no servidor.
import { join, resolve } from "node:path";
import { type CanvasDoc, type CanvasNode, readCanvasDoc } from "../lib/canvas-doc.ts";
import { applyOp, type CanvasOp } from "../lib/canvas-history.ts";
import { LinkError } from "../lib/canvas-links.ts";
import { directNotesOf, hasNoteAccess, noteChainFrom, NoteError, readableNotesOf } from "../lib/canvas-note.ts";
import {
  type AgentRecordView, concludedAgentAt, findNote, type HerdrTarget, identityPrompt, isOrchestrator, nodeName, nodesAtTarget, planConnect, planDismiss, planJoin, planLeave, planReassign,
  planNewNote, planRecruit, RECRUIT_ERRORS, requireFreshNoteName, RecruitError, recruitsOf, requireOrchestrator, requireRecruit, requireSharedNote, terminalTargetOf,
} from "../lib/canvas-recruit.ts";
import { labelsText, opensPr, prReadyPromptBlock, prReadyValues, type PrReadyValues } from "../lib/brief-pr.ts";
import { effectiveConfig } from "../lib/config.ts";
import { findStateDir } from "../lib/kit.ts";
import { loadProfile, pathValue } from "../lib/profile.ts";
import { resolveProject } from "../lib/project.ts";
import { EXIT, HadesError } from "../lib/output.ts";
import { text } from "../lib/activity.ts";
import { agentFiles, loadWorkEnv, readJson } from "../lib/work.ts";
import { TERMINAL_NAME_MAX } from "../panel/argos-terminals.ts";
import { exec } from "../panel/exec.ts";

export const USAGE = `Uso: hades canvas <subcomando> [--canvas <id>]
  note list                                   notas que o seu terminal lê (diretas e encadeadas)
  note read <nota> [--only]                   texto da nota e da cadeia dela (--only: só ela)
  note write <nota> [--append] [texto]        grava a nota ligada direto a você (sem texto: entrada padrão)
  note new <nome> [--title t] [--text t] [--link-to <recruta>]…
                                              (orquestrador) cria a nota perto de você, ligada a você e aos recrutas citados
                                              (texto: --text ou entrada padrão redirecionada; sem nenhum, a nota nasce vazia)
  recruit [--name n] [--role r|--no-role] [--preset p] [--agent a] [--model m] [--effort e] [--cwd d]
          [--instructions t] [--note <nota>]… [--new-note <nome>] [--prompt <tarefa>]
                                              (orquestrador) cria um recruta abaixo de você (--new-note: com uma nota de andamento nova)
  connect <recruta> <nota>                    (orquestrador) liga o recruta a uma nota já ligada a você
  reassign <recruta> [--role r|--no-role] [--instructions t|--no-instructions]   (orquestrador) troca papel/instruções
  dismiss <recruta>                           (orquestrador) fecha o terminal do recruta
  notify <texto>                              notificação ao dono
  join [--pane p] [--name n] [--role r] [--to <orquestrador>] [--note <nota>]…
                                              traz para o canvas um terminal do herdr que não nasceu nele (sem --pane, o seu)
  leave [--pane p]                            tira o terminal do canvas sem fechar o processo`;

/** Códigos estáveis da CLI (só ganham valores); os de recrutamento vêm de `RECRUIT_ERRORS`. */
export const CANVAS_CLI_ERRORS = {
  noCaller: "canvas_no_caller",
  panelDown: "canvas_panel_unreachable",
  panelRefused: "canvas_panel_refused",
  manyCanvases: "canvas_many_canvases",
  noteNoAccess: "canvas_note_no_access",
  noteWriteDirect: "canvas_note_write_direct_only",
  noteConflict: "canvas_note_conflict",
  docConflict: "canvas_doc_conflict",
  herdrFailed: "canvas_herdr_failed",
  notifyFailed: "canvas_notify_failed",
  joinOutsideHerdr: "canvas_join_outside_herdr",
  joinPaneNotFound: "canvas_join_pane_not_found",
  joinBadPane: "canvas_join_bad_pane",
  noteFileExists: "canvas_note_file_exists",
} as const;
export type CanvasCliErrorCode = (typeof CANVAS_CLI_ERRORS)[keyof typeof CANVAS_CLI_ERRORS];

const ERROR_TEXT: Readonly<Record<CanvasCliErrorCode, string>> = {
  [CANVAS_CLI_ERRORS.noCaller]: "este processo não roda num pane do herdr (HERDR_PANE_ID ausente)",
  [CANVAS_CLI_ERRORS.panelDown]: "o painel local não respondeu",
  [CANVAS_CLI_ERRORS.panelRefused]: "o painel recusou",
  [CANVAS_CLI_ERRORS.manyCanvases]: "o seu terminal está em mais de um canvas: escolha com --canvas <id>",
  [CANVAS_CLI_ERRORS.noteNoAccess]: "nenhuma conexão liga o seu terminal a essa nota (nem pela cadeia)",
  [CANVAS_CLI_ERRORS.noteWriteDirect]: "só se escreve na nota ligada direto ao seu terminal (a cadeia só se lê)",
  [CANVAS_CLI_ERRORS.noteConflict]: "a nota mudou enquanto você gravava: tente de novo",
  [CANVAS_CLI_ERRORS.docConflict]: "o canvas mudou durante a operação: tente de novo",
  [CANVAS_CLI_ERRORS.herdrFailed]: "o herdr recusou",
  [CANVAS_CLI_ERRORS.notifyFailed]: "a notificação não saiu",
  [CANVAS_CLI_ERRORS.joinOutsideHerdr]: "este terminal não está dentro do herdr, e o canvas só mostra panes dele: abra o terminal (ou a sessão do Claude Code) num pane do herdr e rode de novo",
  [CANVAS_CLI_ERRORS.joinPaneNotFound]: "o herdr não tem esse pane",
  [CANVAS_CLI_ERRORS.joinBadPane]: "--pane inválido",
  [CANVAS_CLI_ERRORS.noteFileExists]: "já existe um arquivo de nota com esse nome: escolha outro nome",
};

class CanvasCliError extends Error {
  readonly code: CanvasCliErrorCode;
  constructor(code: CanvasCliErrorCode, detail?: string) {
    super(detail ? `${ERROR_TEXT[code]}: ${detail}` : ERROR_TEXT[code]);
    this.code = code;
  }
}

const failWith = (code: CanvasCliErrorCode, detail?: string): never => {
  throw new CanvasCliError(code, detail);
};

/** Quantas vezes refazer sobre o documento (ou a nota) novo quando outra escrita entrou no meio. */
const WRITE_ATTEMPTS = 3;
const STATUS = { ok: 200, notFound: 404, conflict: 409 } as const;
/** Prazos das chamadas ao painel: criar e reiniciar esperam o agente subir (a rota espera até 60 s). */
export const CANVAS_CLI_TIMEOUTS = { panelMs: 15_000, startMs: 90_000, herdrMs: 20_000, notifyMs: 15_000 } as const;
const DEFAULT_PANEL_PORT = 21220;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
const PANE_ID = /^[\w:.-]{1,64}$/;
const SESSION_NAME = /^[\w.-]{1,64}$/;

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

export interface PanelReply {
  status: number;
  body: unknown;
}

export interface CanvasCliDeps {
  /** Chamada ao painel local (token e prazo já postos); falha de rede lança. */
  panel(method: "GET" | "POST" | "PUT", path: string, body?: unknown, timeoutMs?: number): Promise<PanelReply>;
  /** `herdr [--session s] <args>`. */
  herdr(session: string, args: string[]): Promise<{ rc: number; err: string }>;
  /** O pane do herdr deste processo, ou `undefined` fora do herdr. */
  caller(): Promise<HerdrTarget | undefined>;
  stdin(): Promise<string>;
  /** A entrada padrão é um pipe ou arquivo (não o teclado)? Sem isso, `note new` não a lê. Ausente: lê. */
  stdinPiped?(): boolean;
  /** Assignee, labels e reviewers das Configurações (e do perfil do projeto) para o bloco "PR pronta" do recruta. */
  prReady?(): PrReadyValues;
  /** `notify.sh send agent info <texto> --obj <nome>` da instância. */
  notify(text: string, obj: string): Promise<{ rc: number; err: string }>;
  out(text: string): void;
  err(text: string): void;
}

// ---- argumentos ----

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

const VALUE_FLAGS = new Set(["canvas", "name", "role", "preset", "agent", "model", "effort", "cwd", "instructions", "note", "prompt", "pane", "to", "text", "title", "link-to", "new-note"]);
const BOOL_FLAGS = new Set(["only", "append", "no-role", "no-instructions"]);

class UsageError extends Error {}

function parseArgs(args: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (BOOL_FLAGS.has(key)) flags.set(key, ["1"]);
    else if (VALUE_FLAGS.has(key)) {
      const value = args[i + 1];
      if (value === undefined) throw new UsageError(`--${key} pede um valor`);
      flags.set(key, [...(flags.get(key) ?? []), value]);
      i += 1;
    } else throw new UsageError(`opção desconhecida: ${arg}`);
  }
  return { positional, flags };
}

const flag = (p: Parsed, key: string): string | undefined => p.flags.get(key)?.at(-1);
const has = (p: Parsed, key: string): boolean => p.flags.has(key);

// ---- painel ----

async function panelJson(deps: CanvasCliDeps, method: "GET" | "POST" | "PUT", path: string, body?: unknown, timeoutMs?: number): Promise<PanelReply> {
  try {
    return await deps.panel(method, path, body, timeoutMs);
  } catch (error) {
    return failWith(CANVAS_CLI_ERRORS.panelDown, error instanceof Error ? error.message : String(error));
  }
}

const refusedCode = (reply: PanelReply): string => (isDict(reply.body) && typeof reply.body.code === "string" ? reply.body.code : `http_${reply.status}`);

/** Resposta de recusa do painel → erro com o código que o painel deu (a mensagem dele é genérica e sem caminho). */
function refused(reply: PanelReply): never {
  const body = isDict(reply.body) ? reply.body : {};
  const code = typeof body.code === "string" ? body.code : `http_${reply.status}`;
  const text = typeof body.error === "string" ? body.error : "";
  return failWith(CANVAS_CLI_ERRORS.panelRefused, `${text || "sem detalhe"} (${code})`);
}

interface Located {
  canvas: string;
  doc: CanvasDoc;
  /** Os nós do documento que são o processo que chama (terminal pelo pane, agente pelo grafo). */
  me: CanvasNode[];
}

/** Os pares do herdr dos agentes do grafo vivo (id do nó → par); grafo fora do ar só deixa de casar nós `agent`. */
async function graphTargets(deps: CanvasCliDeps): Promise<Map<string, HerdrTarget>> {
  const reply = await panelJson(deps, "GET", "/api/argos/graph");
  const out = new Map<string, HerdrTarget>();
  if (reply.status !== STATUS.ok || !isDict(reply.body) || !Array.isArray(reply.body.nodes)) return out;
  for (const node of reply.body.nodes) {
    if (!isDict(node) || typeof node.id !== "string" || !isDict(node.herdr)) continue;
    const { session, pane } = node.herdr;
    if (typeof session === "string" && typeof pane === "string") out.set(node.id, { session, pane });
  }
  return out;
}

async function loadDoc(deps: CanvasCliDeps, canvas: string): Promise<CanvasDoc> {
  const reply = await panelJson(deps, "GET", `/api/canvases/${encodeURIComponent(canvas)}`);
  if (reply.status !== STATUS.ok) return refused(reply);
  return readCanvasDoc(reply.body);
}

async function canvasIds(deps: CanvasCliDeps): Promise<string[]> {
  const list = await panelJson(deps, "GET", "/api/canvases");
  if (list.status !== STATUS.ok || !isDict(list.body) || !Array.isArray(list.body.canvases)) return refused(list);
  return list.body.canvases.flatMap((c) => (isDict(c) && typeof c.id === "string" && c.unreadable !== true ? [c.id] : []));
}

/**
 * O canvas onde o processo que chama tem nó; nenhum é recusa, mais de um pede `--canvas`. Com `--canvas` só ele se lê (e a
 * recusa dele sobe); na procura, um canvas que o painel não serve é pulado com aviso, sem derrubar os outros.
 */
async function locate(deps: CanvasCliDeps, only: string | undefined): Promise<Located> {
  const target = (await deps.caller()) ?? failWith(CANVAS_CLI_ERRORS.noCaller);
  const found = await locateAll(deps, only, target);
  return found[0] ?? fail(new RecruitError(RECRUIT_ERRORS.notInCanvas));
}

/** Os canvases onde o pane tem nó (mais de um é recusa: o chamador escolhe com `--canvas`). */
async function locateAll(deps: CanvasCliDeps, only: string | undefined, target: HerdrTarget): Promise<Located[]> {
  const ids = only !== undefined ? [only] : await canvasIds(deps);
  const targets = await graphTargets(deps);
  const found: Located[] = [];
  for (const canvas of ids) {
    let doc: CanvasDoc;
    try {
      doc = await loadDoc(deps, canvas);
    } catch (error) {
      if (only !== undefined || !(error instanceof CanvasCliError) || error.code !== CANVAS_CLI_ERRORS.panelRefused) throw error;
      deps.err(`hades canvas: canvas ${canvas} pulado (${error.message})`);
      continue;
    }
    const me = nodesAtTarget(doc, target, targets);
    if (me.length) found.push({ canvas, doc, me });
  }
  if (found.length > 1) return failWith(CANVAS_CLI_ERRORS.manyCanvases, found.map((f) => f.canvas).join(", "));
  return found;
}

const fail = (error: Error): never => {
  throw error;
};

/** Grava o documento com a revisão lida; se outra escrita entrou, relê e refaz o plano (até `WRITE_ATTEMPTS`). */
async function commit<T>(deps: CanvasCliDeps, at: Located, plan: (doc: CanvasDoc) => { op: CanvasOp | undefined; result: T }): Promise<{ doc: CanvasDoc; result: T }> {
  let doc = at.doc;
  for (let attempt = 1; ; attempt++) {
    const { op, result } = plan(doc);
    if (op === undefined) return { doc, result };
    const next = applyOp(doc, op);
    const reply = await panelJson(deps, "PUT", `/api/canvases/${encodeURIComponent(at.canvas)}`, { ...next, rev: doc.rev });
    if (reply.status === STATUS.ok) {
      const rev = isDict(reply.body) && typeof reply.body.rev === "number" ? reply.body.rev : doc.rev + 1;
      return { doc: { ...next, rev }, result };
    }
    if (reply.status !== STATUS.conflict) return refused(reply);
    if (attempt >= WRITE_ATTEMPTS) return failWith(CANVAS_CLI_ERRORS.docConflict);
    doc = await loadDoc(deps, at.canvas);
  }
}

// ---- notas ----

const noteName = (doc: CanvasDoc, id: string): string => {
  const node = doc.nodes.find((n) => n.id === id);
  const data = node && isDict(node.data) ? node.data : {};
  return typeof data.note === "string" ? data.note : id;
};

/** Os leitores entre os nós de quem chama (agente e terminal); a união das notas de todos eles. */
function readable(at: Located): { id: string; via: string | null }[] {
  const out: { id: string; via: string | null }[] = [];
  const seen = new Set<string>();
  for (const node of at.me) {
    for (const entry of readableNotesOf(at.doc, node.id)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

function noteOrFail(at: Located, ref: string): CanvasNode {
  const note = findNote(at.doc, ref);
  // nota que não existe e nota sem conexão respondem igual: fora do alcance é como inexistente
  if (!note || !readable(at).some((entry) => entry.id === note.id)) return failWith(CANVAS_CLI_ERRORS.noteNoAccess, ref);
  return note;
}

async function noteText(deps: CanvasCliDeps, name: string): Promise<{ text: string; rev: string | null }> {
  const reply = await panelJson(deps, "GET", `/api/canvas-notes/${encodeURIComponent(name)}`);
  if (reply.status === STATUS.notFound) return { text: "", rev: null };
  if (reply.status !== STATUS.ok || !isDict(reply.body) || typeof reply.body.text !== "string") return refused(reply);
  return { text: reply.body.text, rev: typeof reply.body.rev === "string" ? reply.body.rev : null };
}

async function noteList(deps: CanvasCliDeps, at: Located): Promise<number> {
  const notes = readable(at);
  if (notes.length === 0) {
    deps.out("nenhuma nota ligada ao seu terminal");
    return EXIT.ok;
  }
  for (const entry of notes) deps.out(`${noteName(at.doc, entry.id)}\t${entry.via === null ? "direta" : `cadeia de ${noteName(at.doc, entry.via)}`}`);
  return EXIT.ok;
}

async function noteRead(deps: CanvasCliDeps, at: Located, p: Parsed): Promise<number> {
  const ref = p.positional[2] ?? fail(new UsageError("note read <nota>"));
  const note = noteOrFail(at, ref);
  const chain = has(p, "only") ? [{ id: note.id, via: null }] : noteChainFrom(at.doc, note.id);
  for (const [i, entry] of chain.entries()) {
    const name = noteName(at.doc, entry.id);
    const { text } = await noteText(deps, name);
    if (i > 0) deps.out("");
    deps.out(`=== ${name}${entry.via === null ? "" : ` (cadeia de ${noteName(at.doc, entry.via)})`} ===`);
    deps.out(text);
  }
  return EXIT.ok;
}

async function noteWrite(deps: CanvasCliDeps, at: Located, p: Parsed): Promise<number> {
  const ref = p.positional[2] ?? fail(new UsageError("note write <nota> [texto]"));
  const note = noteOrFail(at, ref);
  const writer = at.me.find((node) => hasNoteAccess(at.doc, note.id, node.id)) ?? failWith(CANVAS_CLI_ERRORS.noteWriteDirect, ref);
  const given = p.positional.slice(3).join(" ");
  const text = given !== "" ? given : await deps.stdin();
  const name = noteName(at.doc, note.id);
  for (let attempt = 1; ; attempt++) {
    const current = await noteText(deps, name);
    const body = has(p, "append") && current.text !== "" ? `${current.text.replace(/\n*$/, "")}\n\n${text}` : text;
    const reply = await panelJson(deps, "PUT", `/api/canvas-notes/${encodeURIComponent(name)}`, {
      text: body, rev: current.rev, as: { canvas: at.canvas, node: note.id, agent: writer.id },
    });
    if (reply.status === STATUS.ok) {
      deps.out(`nota ${name} gravada`);
      return EXIT.ok;
    }
    if (reply.status !== STATUS.conflict) return refused(reply);
    if (attempt >= WRITE_ATTEMPTS) return failWith(CANVAS_CLI_ERRORS.noteConflict, name);
  }
}

/** O texto inicial da nota de andamento de um recruta. */
const progressSeed = (recruitName: string): string => `# Andamento: ${recruitName}\n`;

/** Recusa nome cujo arquivo já existe (nota órfã de outro canvas, por exemplo): gravar com revisão nula o perderia. */
async function requireNoNoteFile(deps: CanvasCliDeps, name: string): Promise<void> {
  if ((await noteText(deps, name)).rev !== null) failWith(CANVAS_CLI_ERRORS.noteFileExists, name);
}

/**
 * Cria o arquivo da nota (revisão nula) como quem chama; o nó e a ligação já estão no documento, e é isso que a rota confere.
 * Ao final de `commit` o nó existe: sem arquivo a nota se lê vazia, e `note write` a cria, então falha aqui não deixa estado quebrado.
 */
async function createNoteFile(deps: CanvasCliDeps, canvas: string, doc: CanvasDoc, name: string, writerId: string, text: string): Promise<void> {
  const node = findNote(doc, name) as CanvasNode;
  const reply = await panelJson(deps, "PUT", `/api/canvas-notes/${encodeURIComponent(name)}`, { text, rev: null, as: { canvas, node: node.id, agent: writerId } });
  if (reply.status !== STATUS.ok) refused(reply);
}

async function noteNew(deps: CanvasCliDeps, at: Located, p: Parsed): Promise<number> {
  const name = p.positional[2] ?? fail(new UsageError("note new <nome> [--title t] [--text t] [--link-to <recruta>]…"));
  const orchestrator = orchestratorOf(at);
  const linkTo = p.flags.get("link-to") ?? [];
  // tudo que se pode recusar se confere antes de gravar: nome, recrutas e arquivo existente
  requireFreshNoteName(at.doc, name);
  await requireNoNoteFile(deps, name);
  const given = flag(p, "text");
  const text = given ?? (deps.stdinPiped?.() === false ? "" : await deps.stdin());
  const placed = await commit(deps, at, (doc) => {
    const plan = planNewNote(doc, { callerId: orchestrator.id, name, linkTo });
    return { op: plan.op, result: plan };
  });
  await createNoteFile(deps, at.canvas, placed.doc, name, orchestrator.id, text);
  const title = flag(p, "title");
  if (title !== undefined) {
    const renamed = await panelJson(deps, "POST", `/api/canvas-notes/${encodeURIComponent(name)}/rename`, { title });
    if (renamed.status !== STATUS.ok) deps.err(`hades canvas: a nota ${name} nasceu sem o título (${refusedCode(renamed)})`);
  }
  const { node, recruits } = placed.result;
  const linked = [nodeName(orchestrator), ...recruits.map(nodeName)].join(", ");
  deps.out(`nota ${name}: nó ${node.id}, em (${node.x}, ${node.y}), ligada a ${linked}`);
  return EXIT.ok;
}

// ---- orquestrador ----

const orchestratorOf = (at: Located): CanvasNode => at.me.find((node) => isOrchestrator(node)) ?? requireOrchestrator(at.doc, (at.me[0] as CanvasNode).id);

/** Aparência do orquestrador que o recruta herda (o mesmo desenho no canvas). */
const LOOK_KEYS = ["icon", "color", "theme", "themeBg", "themeFg", "font"] as const;
/** O que o recruta copia do orquestrador quando nada foi escolhido. */
const CHOICE_KEYS = ["agent", "model", "effort", "role", "preset"] as const;

const textField = (data: Dict, key: string): string | undefined => (typeof data[key] === "string" ? (data[key] as string) : undefined);

/**
 * Nome livre `<base> <n>` entre os nomes dos nós do documento, contando a partir do próximo recruta; a base encurta para o
 * nome caber no limite da rota de terminais.
 */
function freeName(doc: CanvasDoc, orchestrator: CanvasNode): string {
  const taken = new Set(doc.nodes.map((node) => nodeName(node)));
  const named = (i: number): string => `${nodeName(orchestrator).slice(0, TERMINAL_NAME_MAX - ` ${i}`.length).trimEnd()} ${i}`;
  let i = recruitsOf(doc, orchestrator.id).length + 1;
  while (taken.has(named(i))) i += 1;
  return named(i);
}

/** O corpo da rota de criar: o que foi pedido vence; sem predefinição nem papel nem agente, cópia do orquestrador. */
export function recruitBody(orchestrator: Dict, p: Parsed, name: string): Dict {
  const picked = has(p, "preset") || has(p, "role") || has(p, "no-role") || has(p, "agent");
  const body: Dict = { name };
  if (!picked) for (const key of CHOICE_KEYS) if (textField(orchestrator, key) !== undefined) body[key] = textField(orchestrator, key);
  for (const key of ["preset", "role", "agent", "model", "effort", "cwd", "instructions"]) {
    const value = flag(p, key);
    if (value !== undefined) body[key] = value;
  }
  if (has(p, "no-role")) delete body.role;
  return body;
}

function identityOf(deps: CanvasCliDeps, doc: CanvasDoc, recruit: CanvasNode, orchestrator: CanvasNode, task?: string): string {
  const data = isDict(recruit.data) ? recruit.data : {};
  // o papel (ou o da predefinição, que o painel devolve em `data.role`) diz se o recruta abre PR
  const role = textField(data, "role") ?? null;
  const values = opensPr(role) ? deps.prReady?.() : undefined;
  return identityPrompt({
    name: nodeName(recruit), role, orchestrator: nodeName(orchestrator),
    notes: directNotesOf(doc, recruit.id).map((id) => noteName(doc, id)),
    ...(values !== undefined && { prReady: prReadyPromptBlock(values) }), ...(task !== undefined && { task }),
  });
}

/** Modelo ou esforço que ninguém definiu (flag, papel, predefinição, Configurações): o terminal herda o settings.json do dono. */
function inheritedDefaults(reply: Dict): string[] {
  return (["model", "effort"] as const).filter((key) => typeof reply[key] !== "string");
}

async function sendPrompt(deps: CanvasCliDeps, target: HerdrTarget, text: string): Promise<void> {
  // texto que começa com "-" viraria opção do herdr: o espaço na frente não muda o que o agente lê
  const r = await deps.herdr(target.session, ["agent", "prompt", target.pane, text.startsWith("-") ? ` ${text}` : text]);
  if (r.rc !== 0) failWith(CANVAS_CLI_ERRORS.herdrFailed, r.err.trim().slice(0, 200));
}

const closeBody = (node: CanvasNode): Dict => {
  const target = terminalTargetOf(node) ?? failWith(CANVAS_CLI_ERRORS.herdrFailed, `o nó ${node.id} não tem pane`);
  return { name: nodeName(node), session: target.session, pane: target.pane };
};

/** `--cwd` na worktree de um agente que já concluiu: avisa que a correção abre agente novo (aviso, não recusa). */
function warnConcludedWorktree(deps: CanvasCliDeps, cwd: string | undefined): void {
  if (cwd === undefined) return;
  const target = resolve(cwd);
  let records: AgentRecordView[];
  try {
    const work = loadWorkEnv({ skillOk: true, cwd: target });
    records = agentFiles(work).flatMap((file) => {
      const reg = readJson(file);
      if (reg === undefined) return [];
      return [{ name: text(reg.name), worktree: text(reg.worktree), state: text(reg.state), closedOnDone: reg.closedOnDone === true }];
    });
  } catch (error) {
    // sem projeto ao redor do cwd não há registro a consultar; o aviso é cortesia, o recrutamento segue
    if (error instanceof HadesError) return;
    throw error;
  }
  const concluded = concludedAgentAt(target, records);
  if (concluded === undefined) return;
  deps.err(`hades canvas: aviso: ${concluded} foi encerrado ao concluir; a correção abre agente novo na mesma worktree a partir do handoff.md/report.md, não reaproveita a sessão`);
}

async function recruit(deps: CanvasCliDeps, at: Located, p: Parsed): Promise<number> {
  const orchestrator = orchestratorOf(at);
  const look = isDict(orchestrator.data) ? orchestrator.data : {};
  const notes = p.flags.get("note") ?? [];
  const newNote = flag(p, "new-note");
  // as notas pedidas são conferidas antes de abrir o pane: recusa não deixa terminal órfão
  for (const ref of notes) requireSharedNote(at.doc, orchestrator.id, ref);
  if (newNote !== undefined) {
    requireFreshNoteName(at.doc, newNote);
    await requireNoNoteFile(deps, newNote);
  }
  const name = flag(p, "name") ?? freeName(at.doc, orchestrator);
  const body = recruitBody(look, p, name);
  warnConcludedWorktree(deps, flag(p, "cwd"));
  const created = await panelJson(deps, "POST", "/api/argos/terminals", body, CANVAS_CLI_TIMEOUTS.startMs);
  if (created.status !== STATUS.ok || !isDict(created.body) || !isDict(created.body.herdr)) return refused(created);
  const reply = created.body;
  const herdr = reply.herdr as Dict;
  const target: HerdrTarget = { session: String(herdr.session), pane: String(herdr.pane) };
  const data: Dict = { name, herdr: target };
  for (const key of LOOK_KEYS) if (look[key] !== undefined) data[key] = look[key];
  for (const key of ["agent", "model", "effort", "role"]) if (typeof reply[key] === "string") data[key] = reply[key];
  if (typeof body.preset === "string") data.preset = body.preset;
  let placed: { doc: CanvasDoc; result: string };
  try {
    placed = await commit(deps, at, (doc) => {
      const plan = planRecruit(doc, { orchestratorId: orchestrator.id, data, notes, ...(newNote !== undefined && { newNote }) });
      return { op: plan.op, result: plan.nodeId };
    });
  } catch (error) {
    // o nó não entrou no canvas: o pane não fica para trás sem ninguém que o feche
    const closed = await panelJson(deps, "POST", "/api/argos/terminals/close", { name, ...target });
    if (closed.status !== STATUS.ok) deps.err(`hades canvas: o terminal ${name} ficou aberto (pane ${target.pane}): feche pelo herdr`);
    throw error;
  }
  const node = placed.doc.nodes.find((n) => n.id === placed.result) as CanvasNode;
  if (newNote !== undefined) await createNoteFile(deps, at.canvas, placed.doc, newNote, orchestrator.id, progressSeed(name));
  await sendPrompt(deps, target, identityOf(deps, placed.doc, node, orchestrator, flag(p, "prompt")));
  const inherited = inheritedDefaults(reply);
  if (inherited.length > 0) {
    deps.err(`hades canvas: aviso: o recruta ${name} ficou sem ${inherited.join(" e ")} (sem papel com valor nas Configurações): herda o default do settings.json`);
  }
  if (newNote !== undefined) deps.out(`nota ${newNote}: ligada a ${name} e a você`);
  deps.out(`recruta ${name}: nó ${node.id}, pane ${target.pane}, em (${node.x}, ${node.y})${data.model !== undefined ? `, modelo ${String(data.model)}` : ""}${data.effort !== undefined ? `, esforço ${String(data.effort)}` : ""}`);
  return EXIT.ok;
}

async function connect(deps: CanvasCliDeps, at: Located, p: Parsed): Promise<number> {
  const [recruitRef, noteRef] = [p.positional[1], p.positional[2]];
  if (recruitRef === undefined || noteRef === undefined) throw new UsageError("connect <recruta> <nota>");
  const orchestrator = orchestratorOf(at);
  const { result } = await commit(deps, at, (doc) => {
    const plan = planConnect(doc, orchestrator.id, recruitRef, noteRef);
    return { op: plan.op, result: plan };
  });
  const name = noteName(at.doc, result.note.id);
  deps.out(result.op === undefined ? `${nodeName(result.recruit)} já estava ligado a ${name}` : `${nodeName(result.recruit)} ligado a ${name}`);
  return EXIT.ok;
}

async function reassign(deps: CanvasCliDeps, at: Located, p: Parsed): Promise<number> {
  const ref = p.positional[1] ?? fail(new UsageError("reassign <recruta> [--role r|--no-role] [--instructions t|--no-instructions]"));
  const orchestrator = orchestratorOf(at);
  const recruitNode = requireRecruit(at.doc, orchestrator.id, ref);
  const data = isDict(recruitNode.data) ? recruitNode.data : {};
  const role = has(p, "no-role") ? null : (flag(p, "role") ?? textField(data, "role") ?? null);
  const body: Dict = { ...closeBody(recruitNode), role };
  if (has(p, "no-instructions")) body.instructions = null;
  else if (flag(p, "instructions") !== undefined) body.instructions = flag(p, "instructions");
  // o nó primeiro: se o documento recusa, o processo segue como estava; se o reinício falha, o nó volta ao papel de antes
  const before = textField(data, "role") ?? null;
  const placed = await commit(deps, at, (doc) => ({ op: planReassign(doc, requireRecruit(doc, orchestrator.id, ref).id, role), result: undefined }));
  const changed = await panelJson(deps, "POST", "/api/argos/terminals/role", body, CANVAS_CLI_TIMEOUTS.startMs);
  if (changed.status !== STATUS.ok) {
    try {
      await commit(deps, { ...at, doc: placed.doc }, (doc) => ({ op: planReassign(doc, recruitNode.id, before), result: undefined }));
    } catch (error) {
      deps.err(`hades canvas: o nó ${nodeName(recruitNode)} ficou com o papel ${role ?? "nenhum"}, mas o processo não reiniciou (${error instanceof Error ? error.message : String(error)})`);
    }
    return refused(changed);
  }
  const node = placed.doc.nodes.find((n) => n.id === recruitNode.id) as CanvasNode;
  await sendPrompt(deps, terminalTargetOf(node) as HerdrTarget, identityOf(deps, placed.doc, node, orchestrator, flag(p, "prompt")));
  deps.out(`recruta ${nodeName(node)} reiniciado com papel ${role ?? "nenhum"}`);
  return EXIT.ok;
}

async function dismiss(deps: CanvasCliDeps, at: Located, p: Parsed): Promise<number> {
  const ref = p.positional[1] ?? fail(new UsageError("dismiss <recruta>"));
  const orchestrator = orchestratorOf(at);
  const recruitNode = requireRecruit(at.doc, orchestrator.id, ref);
  const closed = await panelJson(deps, "POST", "/api/argos/terminals/close", closeBody(recruitNode));
  if (closed.status !== STATUS.ok) return refused(closed);
  await commit(deps, at, (doc) => {
    const still = doc.nodes.some((n) => n.id === recruitNode.id);
    return { op: still ? planDismiss(doc, recruitNode.id) : undefined, result: undefined };
  });
  deps.out(`recruta ${nodeName(recruitNode)} dispensado`);
  return EXIT.ok;
}

async function notifyOwner(deps: CanvasCliDeps, at: Located, p: Parsed): Promise<number> {
  const text = p.positional.slice(1).join(" ").trim();
  if (text === "") throw new UsageError("notify <texto>");
  const r = await deps.notify(text, nodeName(at.me[0] as CanvasNode));
  if (r.rc !== 0) return failWith(CANVAS_CLI_ERRORS.notifyFailed, r.err.trim().slice(0, 200));
  deps.out("notificação enviada");
  return EXIT.ok;
}

// ---- join e leave ----

const DEFAULT_CANVAS = "default";
const JOIN_NAME_MAX = TERMINAL_NAME_MAX;

/** O pane pedido por `--pane` (sessão do chamador, ou `default`) ou o do próprio processo; fora do herdr é recusa. */
async function paneToTarget(deps: CanvasCliDeps, p: Parsed): Promise<HerdrTarget> {
  const caller = await deps.caller();
  const pane = flag(p, "pane");
  if (pane === undefined) return caller ?? failWith(CANVAS_CLI_ERRORS.joinOutsideHerdr);
  if (!PANE_ID.test(pane)) return failWith(CANVAS_CLI_ERRORS.joinBadPane, pane);
  return { session: caller?.session ?? "default", pane };
}

/** O que o registro de terminais ($D/argos/terminals.json) sabe do pane, se ele é um terminal criado pelo canvas e está sem nó. */
async function registeredAt(deps: CanvasCliDeps, target: HerdrTarget): Promise<Dict | undefined> {
  const reply = await panelJson(deps, "GET", "/api/argos/terminals/orphans");
  if (reply.status !== STATUS.ok || !isDict(reply.body) || !Array.isArray(reply.body.orphans)) return undefined;
  return reply.body.orphans.find((o): o is Dict => isDict(o) && o.session === target.session && o.pane === target.pane);
}

/** Campos do registro que o nó herda (o resto, como `createdAt`, não é do nó). */
const REGISTERED_KEYS = ["name", "agent", "model", "effort", "role"] as const;

/** O `data` do nó novo: o registro, depois o que foi pedido; sem nome, `Terminal <pane>`. */
function joinData(registered: Dict | undefined, p: Parsed, target: HerdrTarget): Dict {
  const data: Dict = {};
  for (const key of REGISTERED_KEYS) if (registered && typeof registered[key] === "string") data[key] = registered[key];
  if (registered?.orchestrator === true) data.orchestrator = true;
  const name = flag(p, "name") ?? (typeof data.name === "string" ? data.name : `Terminal ${target.pane}`);
  data.name = name.slice(0, JOIN_NAME_MAX);
  const role = flag(p, "role");
  if (role !== undefined) data.role = role;
  return data;
}

/** O canvas do join: `--canvas`; senão onde o pane já é nó; senão onde o chamador está; senão o padrão. */
async function joinCanvas(deps: CanvasCliDeps, p: Parsed, target: HerdrTarget): Promise<Located> {
  const only = flag(p, "canvas");
  const holding = await locateAll(deps, only, target);
  if (holding[0]) return holding[0];
  const caller = await deps.caller();
  const near = caller === undefined ? [] : await locateAll(deps, only, caller);
  const canvas = near[0]?.canvas ?? only ?? DEFAULT_CANVAS;
  return { canvas, doc: near[0]?.doc ?? (await loadDoc(deps, canvas)), me: [] };
}

async function joinCommand(deps: CanvasCliDeps, p: Parsed): Promise<number> {
  const target = await paneToTarget(deps, p);
  const at = await joinCanvas(deps, p, target);
  const alreadyNode = nodesAtTarget(at.doc, target).length > 0;
  const registered = alreadyNode ? undefined : await registeredAt(deps, target);
  if (!alreadyNode && registered === undefined && (await deps.herdr(target.session, ["pane", "get", target.pane])).rc !== 0) {
    return failWith(CANVAS_CLI_ERRORS.joinPaneNotFound, target.pane);
  }
  const given: Dict = {};
  if (alreadyNode) {
    if (has(p, "name")) given.name = (flag(p, "name") as string).slice(0, JOIN_NAME_MAX);
    if (has(p, "role")) given.role = flag(p, "role");
  }
  const data = alreadyNode ? given : joinData(registered, p, target);
  const targets = await graphTargets(deps);
  const placed = await commit(deps, at, (doc) => {
    const agentIds = nodesAtTarget(doc, target, targets).filter((n) => n.type !== "terminal").map((n) => n.id);
    const to = flag(p, "to");
    const plan = planJoin(doc, { target, data, ...(to !== undefined && { to }), notes: p.flags.get("note") ?? [], agentIds });
    return { op: plan.op, result: plan };
  });
  const node = placed.doc.nodes.find((n) => n.id === placed.result.nodeId) as CanvasNode;
  deps.out(placed.result.op === undefined
    ? `${nodeName(node)} já está no canvas ${at.canvas} (nó ${node.id}): nada a mudar`
    : `${nodeName(node)} ${placed.result.created ? "entrou no" : "atualizado no"} canvas ${at.canvas}: nó ${node.id}, pane ${target.pane}`);
  return EXIT.ok;
}

async function leave(deps: CanvasCliDeps, p: Parsed): Promise<number> {
  const target = await paneToTarget(deps, p);
  const at = (await locateAll(deps, flag(p, "canvas"), target))[0] ?? fail(new RecruitError(RECRUIT_ERRORS.notInCanvas));
  const placed = await commit(deps, at, (doc) => {
    const plan = planLeave(doc, target);
    return { op: plan.op, result: plan.nodes };
  });
  deps.out(`${placed.result.map(nodeName).join(", ")} saiu do canvas ${at.canvas}; o processo segue no pane ${target.pane}`);
  return EXIT.ok;
}

// ---- entrada ----

type Handler = (deps: CanvasCliDeps, at: Located, p: Parsed) => Promise<number>;
const NOTE_HANDLERS: Readonly<Record<string, Handler>> = { list: noteList, read: noteRead, write: noteWrite, new: noteNew };
const HANDLERS: Readonly<Record<string, Handler>> = { recruit, connect, reassign, dismiss, notify: notifyOwner };

/** Comandos que valem para um pane que ainda não é nó: não procuram o chamador no canvas. */
const STANDALONE: Readonly<Record<string, (deps: CanvasCliDeps, p: Parsed) => Promise<number>>> = { join: joinCommand, leave };

export async function runCanvas(args: readonly string[], deps: CanvasCliDeps): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    deps.err(`hades canvas: ${error.message}\n${USAGE}`);
    return EXIT.usage;
  }
  const [command, sub] = parsed.positional;
  const standalone = command !== undefined && Object.hasOwn(STANDALONE, command) ? STANDALONE[command] : undefined;
  const handler = standalone ? undefined : command === "note" ? (sub !== undefined && Object.hasOwn(NOTE_HANDLERS, sub) ? NOTE_HANDLERS[sub] : undefined)
    : command !== undefined && Object.hasOwn(HANDLERS, command) ? HANDLERS[command] : undefined;
  if (!handler && !standalone) {
    deps.err(USAGE);
    return command === undefined || command === "-h" || command === "--help" ? EXIT.ok : EXIT.usage;
  }
  try {
    if (standalone) return await standalone(deps, parsed);
    return await (handler as Handler)(deps, await locate(deps, flag(parsed, "canvas")), parsed);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`hades canvas: uso: ${error.message}`);
      return EXIT.usage;
    }
    const code = error instanceof CanvasCliError || error instanceof RecruitError || error instanceof LinkError || error instanceof NoteError ? error.code : undefined;
    if (code === undefined) throw error;
    deps.err(`hades canvas: ${error instanceof Error ? error.message : String(error)} (${code})`);
    return EXIT.fail;
  }
}

// ---- dependências reais ----

/** O painel desta instância: `HADES_PANEL_URL` (só loopback) ou a porta das configurações. */
export function panelBase(env: NodeJS.ProcessEnv, config: ReadonlyMap<string, string>): string {
  const url = env.HADES_PANEL_URL;
  if (url !== undefined && url !== "") {
    if (!LOOPBACK.test(url)) throw new CanvasCliError(CANVAS_CLI_ERRORS.panelDown, "HADES_PANEL_URL tem de ser http://127.0.0.1:<porta>");
    return url;
  }
  const port = Number(config.get("HADES_PANEL_PORT") ?? DEFAULT_PANEL_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CanvasCliError(CANVAS_CLI_ERRORS.panelDown, "HADES_PANEL_PORT inválida");
  return `http://127.0.0.1:${port}`;
}

/** O par do herdr deste processo: o pane do ambiente e a sessão cujo socket é o do ambiente (sem casar, `default`). */
async function callerTarget(env: NodeJS.ProcessEnv): Promise<HerdrTarget | undefined> {
  const pane = env.HERDR_PANE_ID;
  if (!pane || !PANE_ID.test(pane)) return undefined;
  const fixed = env.HADES_HERDR_SESSION;
  if (fixed && SESSION_NAME.test(fixed)) return { session: fixed, pane };
  const socket = env.HERDR_SOCKET_PATH;
  if (!socket) return { session: "default", pane };
  const r = await exec(["herdr", "session", "list", "--json"], { timeoutMs: CANVAS_CLI_TIMEOUTS.herdrMs });
  let sessions: unknown = [];
  try {
    sessions = r.status === 0 ? (JSON.parse(r.stdout) as Dict).sessions : [];
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const match = Array.isArray(sessions) ? sessions.find((s) => isDict(s) && s.socket_path === socket && typeof s.name === "string") : undefined;
  const name = isDict(match) && typeof match.name === "string" && SESSION_NAME.test(match.name) ? match.name : "default";
  return { session: name, pane };
}

/** Labels de PR do perfil do projeto do diretório atual; fora de um projeto (ou sem perfil), sem labels. */
function projectLabels(): string {
  return labelsText(pathValue(loadProfile(resolveProject(process.cwd())), "pr.labels"));
}

function realDeps(): CanvasCliDeps {
  const dir = findStateDir();
  const base = panelBase(process.env, dir ? effectiveConfig(dir) : new Map());
  let token: string | undefined;
  const request = async (method: string, path: string, body: unknown, timeoutMs: number): Promise<Response> => {
    if (token === undefined && method !== "GET") {
      const got = await fetch(`${base}/api/token`, { signal: AbortSignal.timeout(CANVAS_CLI_TIMEOUTS.panelMs) });
      const parsed: unknown = await got.json();
      token = isDict(parsed) && typeof parsed.token === "string" ? parsed.token : "";
    }
    return fetch(`${base}${path}`, {
      method, signal: AbortSignal.timeout(timeoutMs),
      ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json", "X-Panel-Token": token ?? "" } }),
    });
  };
  return {
    async panel(method, path, body, timeoutMs = CANVAS_CLI_TIMEOUTS.panelMs) {
      const res = await request(method, path, body, timeoutMs);
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      return { status: res.status, body: parsed };
    },
    async herdr(session, args) {
      const r = await exec(["herdr", ...(session !== "default" ? ["--session", session] : []), ...args], { timeoutMs: CANVAS_CLI_TIMEOUTS.herdrMs });
      return { rc: r.timedOut ? 124 : r.status, err: r.stderr };
    },
    caller: () => callerTarget(process.env),
    prReady: () => prReadyValues(projectLabels()),
    stdin: () => Bun.stdin.text(),
    stdinPiped: () => !process.stdin.isTTY,
    async notify(text, obj) {
      if (!dir) return { rc: 1, err: "sem instalação do Hades" };
      const r = await exec(["bash", join(dir, "notify.sh"), "send", "agent", "info", text, "--obj", obj], { timeoutMs: CANVAS_CLI_TIMEOUTS.notifyMs });
      return { rc: r.timedOut ? 124 : r.status, err: r.stderr };
    },
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  };
}

export async function canvasCommand(args: string[]): Promise<number> {
  return runCanvas(args, realDeps());
}

