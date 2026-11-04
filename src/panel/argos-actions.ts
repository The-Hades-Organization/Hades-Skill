// Argos: POST /api/argos/action `{ node, action, args, confirm? }`. Lista fechada validada no servidor. As ações do loop
// rodam o próprio `hades agent <sub>` (a mesma função de src/commands/agent-run.ts, num subprocesso: `die` e as esperas de
// minutos não seguram o laço de eventos do painel); texto e teclas vão pela página Herdr. Sem trava no remoto: executa,
// notifica e loga. O texto de prompt e de resposta nunca vai ao log nem ao notify.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ARGOS_ERRORS, ARGOS_SCHEMA_VERSION, ArgosError, type PendingPermission, isSimplePermissionTool } from "../lib/argos.ts";
import { selfCli } from "../lib/paths.ts";
import { type Exec, exec } from "./exec.ts";
import { type HerdrPage, typedConfirmRequired } from "./herdr-page.ts";
import { BadRequest } from "./http.ts";

type Dict = Record<string, unknown>;

export const MAX_TEXT = 20_000;
const TIMEOUT_DEFAULT_S = 1200;
const TIMEOUT_QUICK_S = 120;
const NOTIFY_TIMEOUT_MS = 30_000;
const OUTPUT_MAX = 2000;
const ERROR_MAX = 300;
const PHASE = /^[\w][\w .-]{0,39}$/;
const QUESTION = /^Q\d{1,4}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CALLER_ID = /^[0-9A-Fa-f:.]{1,45}$/;

/** Quem chamou: `remote` vem do servidor (Host/Origin/chave), `ip` é só informação para o log. */
export interface Caller {
  remote: boolean;
  ip?: string | undefined;
}

/** Como cada ação vira comando. `hades agent` vai por subprocesso; `herdr` pela página Herdr; as destrutivas pedem `confirm`. */
interface Spec {
  destructive: boolean;
  /** valida os `args` e devolve o que a ação precisa; `invalid_args` se não serve */
  parse(args: Dict): Dict;
}

const str = (value: unknown, label: string, max = MAX_TEXT): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new ArgosError(400, ARGOS_ERRORS.invalidArgs, `${label}: texto de 1 a ${max} caracteres`);
  return value;
};
const optText = (value: unknown, label: string): string | undefined => (value === undefined ? undefined : str(value, label));
const pattern = (value: unknown, label: string, re: RegExp): string => {
  const given = str(value, label, 80);
  if (!re.test(given)) throw new ArgosError(400, ARGOS_ERRORS.invalidArgs, `${label}: formato inválido`);
  return given;
};

const SPECS = {
  phase: { destructive: false, parse: (a) => ({ phase: pattern(a.phase, "phase", PHASE), text: optText(a.text, "text") }) },
  resume: { destructive: false, parse: (a) => ({ text: optText(a.text, "text") }) },
  answer: { destructive: false, parse: (a) => ({ question: pattern(a.question, "question", QUESTION), reply: str(a.reply, "reply") }) },
  prompt: { destructive: false, parse: (a) => ({ text: optText(a.text, "text") }) },
  escalate: { destructive: false, parse: (a) => ({ reason: str(a.reason, "reason", 400) }) },
  park: { destructive: false, parse: (a) => ({ reason: a.reason === undefined ? undefined : str(a.reason, "reason", 400) }) },
  done: { destructive: true, parse: (a) => ({ keepPane: a.keepPane === true }) },
  free_prompt: { destructive: false, parse: (a) => ({ text: str(a.text, "text"), session: optSession(a.session) }) },
  text: { destructive: false, parse: (a) => ({ text: str(a.text, "text"), session: optSession(a.session) }) },
  keys: { destructive: false, parse: (a) => ({ keys: a.keys, session: optSession(a.session) }) },
  approve_permission: { destructive: false, parse: (a) => ({ session: optSession(a.session) }) },
  deny_permission: { destructive: false, parse: (a) => ({ session: optSession(a.session) }) },
  stop_session: { destructive: true, parse: (a) => ({ session: pattern(a.session, "session", SESSION) }) },
} as const satisfies Record<string, Spec>;

function optSession(value: unknown): string | undefined {
  return value === undefined ? undefined : pattern(value, "session", SESSION);
}

export type ActionName = keyof typeof SPECS;
export const ACTION_NAMES = Object.keys(SPECS) as ActionName[];
const isAction = (name: unknown): name is ActionName => typeof name === "string" && Object.hasOwn(SPECS, name);

/** O `herdrState` que o grafo dá a quem não está no `herdr agent list`. */
const PANE_GONE_STATE = "fora";

export interface AgentTarget {
  id: string;
  name: string;
  worktree: string;
  pane: string;
}

export interface ActionDeps {
  /** `<pasta de dados>/logs/panel-argos.log` */
  logFile: string;
  /** a worktree do ambiente: onde o `hades agent` roda para agente de projeto sem worktree no disco */
  fallbackCwd: string;
  herdrPage: HerdrPage;
  /** resolve o id do nó para o agente do registro (`unknown_node`/`invalid_node` se não vale) */
  target(node: string): AgentTarget;
  /** estado vivo do agente: herdr e a permissão pendente do diário */
  live(node: string): Promise<{ herdrState: string; pending: PendingPermission | null }>;
  config(): Record<string, string>;
  notify(message: string, state: string): Promise<void>;
  env?: Record<string, string | undefined>;
  now?(): Date;
}

export interface Actions {
  act(body: Dict, caller: Caller): Promise<Dict>;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const lastLine = (text: string): string => text.trim().split("\n").filter(Boolean).pop() ?? "";
const extra = (value: unknown): string[] => (typeof value === "string" ? [value] : []);

/** O `hades agent <sub> …` de cada ação do loop (argumentos já validados); undefined nas que vão pela página Herdr. */
function agentArgs(action: ActionName, name: string, p: Dict): string[] | undefined {
  switch (action) {
    case "phase": return ["phase", name, p.phase as string, ...extra(p.text)];
    case "resume": return ["resume", name, ...extra(p.text)];
    case "answer": return ["answer", name, p.question as string, p.reply as string];
    case "prompt": return ["prompt", name, ...extra(p.text)];
    case "escalate": return ["escalate", name, p.reason as string];
    case "park": return ["park", name, ...extra(p.reason)];
    case "done": return ["done", name, ...(p.keepPane === true ? ["--keep-pane"] : [])];
    default: return undefined;
  }
}

export function createActions(deps: ActionDeps): Actions {
  const now = (): Date => (deps.now ? deps.now() : new Date());

  const timeoutMs = (action: ActionName): number => {
    const configured = Number.parseInt(deps.config().HADES_ARGOS_ACTION_TIMEOUT_S ?? "", 10);
    const seconds = Number.isInteger(configured) && configured > 0 ? configured : TIMEOUT_DEFAULT_S;
    // resposta e prompt avulso não esperam turno: o teto curto pega herdr travado sem prender o painel (o park espera o turno acabar)
    return (action === "answer" || action === "prompt" ? Math.min(seconds, TIMEOUT_QUICK_S) : seconds) * 1000;
  };

  function record(caller: Caller, action: string, node: string, result: string): void {
    const who = caller.remote ? `remoto${caller.ip && CALLER_ID.test(caller.ip) ? `:${caller.ip}` : ""}` : "local";
    mkdirSync(dirname(deps.logFile), { recursive: true });
    appendFileSync(deps.logFile, `${now().toISOString()} quem=${who} acao=${action} alvo=${node} resultado=${result}\n`);
  }

  /** A página Herdr recusa com BadRequest e mensagem; aqui vira `action_failed` com a mesma mensagem. */
  async function herdrCall(call: () => Promise<Dict>): Promise<void> {
    try {
      await call();
    } catch (error) {
      if (error instanceof BadRequest) throw new ArgosError(422, ARGOS_ERRORS.actionFailed, clip(error.message, ERROR_MAX));
      throw error;
    }
  }

  async function viaHerdr(action: ActionName, target: AgentTarget, p: Dict, remote: boolean): Promise<string> {
    const session = typeof p.session === "string" ? p.session : "";
    // `confirm` já foi conferido contra o nome do alvo; a página Herdr confere de novo contra o nome da sessão
    if (action === "approve_permission" || action === "deny_permission") {
      await guardPermission(target);
      await herdrCall(() => deps.herdrPage.act({ action: "keys", session, pane: target.pane, keys: [action === "approve_permission" ? "Enter" : "Escape"] }, remote));
    } else if (action === "stop_session") await herdrCall(() => deps.herdrPage.sessionAct({ action: "stop", name: session, confirm: session }, remote));
    else await herdrCall(() => deps.herdrPage.act({ action: action === "free_prompt" ? "prompt" : action, session, pane: target.pane, text: p.text, keys: p.keys }, remote));
    return "";
  }

  /** As travas do dono: pane vivo, permissão pendente de ferramenta com diálogo "Yes" simples e herdr do agente `blocked`. */
  async function guardPermission(target: AgentTarget): Promise<void> {
    const { herdrState, pending } = await deps.live(target.id);
    if (herdrState === PANE_GONE_STATE) throw new ArgosError(409, ARGOS_ERRORS.paneGone, "o pane deste agente não existe mais no herdr: nada a aprovar nem negar");
    if (!pending || herdrState !== "blocked") throw new ArgosError(409, ARGOS_ERRORS.permissionNotPending, "não há permissão pendente neste agente");
    if (!isSimplePermissionTool(pending.tool)) throw new ArgosError(422, ARGOS_ERRORS.permissionNotSupported, "este diálogo (plano, pergunta ou ferramenta desconhecida) se responde no terminal");
  }

  async function viaAgent(argv: string[], target: AgentTarget, action: ActionName): Promise<string> {
    const cli = selfCli("agent", ...argv);
    const cwd = existsSync(target.worktree) ? target.worktree : deps.fallbackCwd;
    const r = await exec([cli.command, ...cli.args], { timeoutMs: timeoutMs(action), cwd, env: deps.env });
    if (r.timedOut) throw new ArgosError(504, ARGOS_ERRORS.actionTimeout, "o comando do agente não terminou a tempo");
    if (r.status !== 0) throw new ArgosError(422, ARGOS_ERRORS.actionFailed, clip(lastLine(r.stderr) || lastLine(r.stdout) || "o comando do agente falhou", ERROR_MAX));
    return clip(r.stdout.trim(), OUTPUT_MAX);
  }

  /** Valida tudo (ação, nó, argumentos, confirmação) antes de executar qualquer coisa. */
  function prepare(body: Dict): { action: ActionName; target: AgentTarget; parsed: Dict } {
    if (!isAction(body.action)) throw new ArgosError(400, ARGOS_ERRORS.unknownAction, "ação desconhecida");
    const action = body.action;
    const raw = body.args ?? {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ArgosError(400, ARGOS_ERRORS.invalidArgs, "args deve ser um objeto");
    const target = deps.target(typeof body.node === "string" ? body.node : "");
    const spec: Spec = SPECS[action];
    const parsed = spec.parse(raw as Dict);
    if (spec.destructive && typedConfirmRequired(deps.config()) && body.confirm !== target.name) throw new ArgosError(400, ARGOS_ERRORS.confirmRequired, "digite o nome do alvo em confirm");
    return { action, target, parsed };
  }

  async function act(body: Dict, caller: Caller): Promise<Dict> {
    const label = typeof body.action === "string" && /^\w{1,30}$/.test(body.action) ? body.action : "-";
    const nodeLabel = typeof body.node === "string" && /^[\w.:-]{1,200}$/.test(body.node) ? body.node : "-";
    let result = "ok";
    try {
      const { action, target, parsed } = prepare(body);
      const argv = agentArgs(action, target.name, parsed);
      const output = argv ? await viaAgent(argv, target, action) : await viaHerdr(action, target, parsed, caller.remote);
      return { v: ARGOS_SCHEMA_VERSION, ok: true, node: target.id, action, output };
    } catch (error) {
      result = error instanceof ArgosError ? `recusada:${error.code}` : "erro";
      throw error;
    } finally {
      record(caller, label, nodeLabel, result);
      if (caller.remote) {
        await deps.notify(`ação remota: ${label} em ${nodeLabel} (${result})`, `${label}:${nodeLabel}`).catch((error: unknown) => {
          console.warn(`aviso remoto do argos falhou: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  return { act };
}

/** O aviso remoto: o evento `herdr` do notify ("Herdr remoto") com a ação e o alvo, nunca o texto. */
export function notifyVia(dir: string, env: Record<string, string | undefined> | undefined): (message: string, state: string) => Promise<void> {
  return async (message, state) => {
    await exec(["bash", join(dir, "notify.sh"), "send", "herdr", "warn", message, "--obj", "argos", "--state", state], {
      timeoutMs: NOTIFY_TIMEOUT_MS, env: { ...(env ?? process.env), HADES_DATA: dir },
    });
  };
}
