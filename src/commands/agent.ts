// `hades agent`: agentes alocados pelo orquestrador (hades agent, reference/loop/orchestrate.md).
// Portado por subcomando: o que ainda não está aqui continua no hades agent, que delega só o que existe.
import { createHash } from "node:crypto";
import { appendFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isFile, readText } from "../lib/fs.ts";
import { hadesHome } from "../lib/paths.ts";
import { die, out, warn } from "../lib/output.ts";
import { run, which } from "../lib/proc.ts";
import { hasSection } from "../lib/moirai.ts";
import { regUpdate, startCommand } from "../lib/agent-registry.ts";
import { herdr, listPanes, paneFrom } from "../lib/herdr.ts";

import { ExitWith } from "../lib/agent-project.ts";
import { loadWorkEnv, regGet, writeJsonAtomic, type WorkEnv } from "../lib/work.ts";

const ORIGINS = ["terminal", "painel"];
const PLAN_BASE_SECTIONS = [
  "Estado atual", "Objetivo", "Unidades", "Ordem e paralelismo", "Arquivos compartilhados", "Consolidação e gate",
  "Riscos e decisões pendentes", "Encolher o plano", "Estimativa",
];
const CODE_FENCE = /^```/;
const SPACE_TAIL = "[ \\t\\r\\v\\f]*";

const isoNow = (): string => `${new Date().toISOString().slice(0, 19)}Z`;

/** Linhas como o awk as vê: sem o último "\n" e cada uma reimpressa com ORS. */
function awkLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Hash do plano sem a seção "Estado atual" (que é reescrita a cada evento e não pede nova aprovação). */
export function planSha(planText: string): string {
  let inFence = false;
  let skip = false;
  const kept: string[] = [];
  for (const line of awkLines(planText.replaceAll("\r", ""))) {
    if (CODE_FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith("## ")) skip = /^## Estado atual([^A-Za-z0-9_]|$)/.test(line);
    if (!skip) kept.push(line);
  }
  return createHash("sha256").update(kept.map((l) => `${l}\n`).join("")).digest("hex");
}

function needArg(value: string | undefined, label: string): string {
  return value ?? die(`faltou ${label}`);
}

function realPlan(path: string | undefined): string {
  const given = needArg(path, "plan.md");
  try {
    return realpathSync(given);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return die("plano não encontrado");
    throw error;
  }
}

function planApprove(args: string[], work: WorkEnv): number {
  const plan = realPlan(args[0]);
  // ~/.claude/hades/plans guarda planos da evolução da skill: aprovar de um projeto registraria na raiz errada
  if (!work.skillScope && plan.startsWith(`${hadesHome()}/plans/`)) {
    die(`${plan} é plano de escopo skill (${hadesHome()}/plans): rode plan-approve de dentro do repo da skill para registrar em _skill`);
  }
  const origin = process.env.HADES_PLAN_ORIGIN || "terminal";
  if (!ORIGINS.includes(origin)) die("HADES_PLAN_ORIGIN: terminal ou painel");
  const record = {
    path: plan,
    sha: planSha(readText(plan) ?? ""),
    approvedAt: isoNow(),
    by: { user: run("id", ["-un"]).stdout.trim(), origem: origin },
    ...(work.skillScope ? { escopo: "skill" } : {}),
  };
  if (!hasSection(readText(plan) ?? "")) {
    warn(`plano sem "## Estimativa": rode hades moirai estimate ${plan} --write antes de aprovar (a aprovação segue; reestimar depois pede nova aprovação)`);
  }
  writeJsonAtomic(join(work.orch, "plan.json"), record);
  out(work.skillScope ? `plano da skill aprovado: ${plan} (registro em ${join(work.orch, "plan.json")})` : `plano aprovado: ${plan}`);
  return 0;
}

function planTrim(args: string[]): number {
  const plan = realPlan(args[0]);
  const log = `${plan.replace(/\.md$/, "")}.log.md`;
  const base = new RegExp(`^## (${PLAN_BASE_SECTIONS.join("|")})${SPACE_TAIL}$`);
  const moved: string[] = [];
  const kept: string[] = [];
  let history = false;
  for (const line of awkLines(readText(plan) ?? "")) {
    if (line.startsWith("## ")) history = !base.test(line);
    (history ? moved : kept).push(line);
  }
  if (moved.length === 0) {
    out(`plan-trim: nada a mover em ${plan}`);
    return 0;
  }
  appendFileSync(log, `\n<!-- plan-trim ${isoNow()} -->\n${moved.map((l) => `${l}\n`).join("")}`);
  writeFileSync(plan, kept.map((l) => `${l}\n`).join(""));
  const sections = moved.filter((l) => l.startsWith("## ")).length;
  out(`plan-trim: ${sections} seção(ões) de histórico movidas para ${log}; plano com ${Buffer.byteLength(readText(plan) ?? "")} bytes`);
  return 0;
}

/** Panes vivos do herdr; undefined se o herdr falta ou a listagem falha (aí não dá para afirmar que o pane morreu). */
function livePanes(): Set<string> | undefined {
  if (!which("herdr")) return undefined;
  const listed = herdr(["pane", "list"]);
  if (listed.status !== 0) return undefined;
  return new Set(listPanes().map((pane) => String(pane.pane_id ?? "")));
}

/** Depois que o herdr reinicia o pane gravado não existe mais: workspace novo na worktree (como o skill-new) e o registro leva o pane novo. */
function startCmd(args: string[], work: WorkEnv): number {
  const name = needArg(args[0], "nome");
  if (!isFile(join(work.orch, "agents", `${name}.json`))) die(`agente ${name} não registrado`);
  let pane = regGet(work, name, "pane");
  const live = livePanes();
  if (live !== undefined && !live.has(pane)) {
    const worktree = regGet(work, name, "worktree");
    const created = herdr(["workspace", "create", "--cwd", worktree, "--label", `hd-${name}`, "--no-focus"]);
    if (created.status !== 0) die(`herdr workspace create falhou: ${created.stdout.replace(/\n+$/, "")}`);
    const fresh = paneFrom(created.stdout);
    if (!fresh) die(`herdr workspace create não devolveu o pane de ${name}`);
    warn(`${name}: o pane ${pane || "(vazio)"} não existe mais no herdr; workspace novo, pane ${fresh}`);
    regUpdate(work, name, (r) => ({ ...r, pane: fresh }));
    pane = fresh;
  }
  out(startCommand(name, pane, regGet(work, name, "role")));
  return 0;
}

/** Quais subcomandos usam a raiz própria da skill (HADES_LIB_SKILL_FORCE / HADES_LIB_AGENT do script original). */
function workFor(sub: string, args: string[]): WorkEnv {
  const agentScoped = ["adopt", "prompt", "answer", "start-cmd", "phase", "resume", "park", "escalate", "done", "status"];
  return loadWorkEnv({
    skillOk: true,
    skillForce: sub.startsWith("skill-"),
    ...(agentScoped.includes(sub) ? { agent: args.find((a) => !a.startsWith("--")) ?? "" } : {}),
  });
}

const USAGE = `Agentes alocados pelo orquestrador (reference/loop/orchestrate.md). Rode de dentro de um clone do repositório.
  hades agent plan-approve <plan.md>                registra o plano aprovado pelo dono (o new exige, se configurado)
  hades agent plan-trim <plan.md>                   move as seções de histórico do plano para <plan>.log.md e deixa o "Estado atual"
  hades agent new <nome> --role spec|impl|consolidate --branch <b> [--base <ref>] [--card <ID> | --new-card "<título>" --tags a,b [--desc "<txt>"]]
                 [--for deliver|inbox|consolidate] [--pr N] [--specs A,B] [--resume <worktree>] [--dry-run]
      card (só se o perfil declara card; --new-card o cria pelo card.create do pacote) → worktree pelo herdr → node_modules (symlink), hooks, sem upstream, pasta de
      relatórios → lock → entrega no estado → brief.md a partir do modelo → registro. Imprime o comando de start.
  hades agent adopt <nome> [--for deliver|inbox|consolidate|review]   registra um agente já rodando no herdr
                                                       (worktree, branch, card, painel e lock vêm do que existe)
  hades agent reassign-orchestrator <nome>…|--all   aponta o orquestrador dos agentes para o pane atual (o herdr reiniciou e
                                                       os panes mudaram); o watch passa a acompanhá-los daqui
  hades agent review <nome> --pr N [--dry-run]      worktree só de leitura (HEAD destacado) para revisar PR alheia
  hades agent prompt <nome> ["<texto>"] [--phase <fase>]   manda a tarefa (padrão: ler o brief e executar) e confere o cwd;
                                                       --phase grava a fase no registro desde o primeiro prompt
  hades agent answer <nome> <Qn> "<resposta>"       grava a resposta do dono em questions.md e avisa o agente
  hades agent start-cmd <nome>                     o comando de start do dono, com modelo e esforço do papel (Configurações)
  hades agent phase <nome> <fase> ["<texto>"] [--no-commit]
                                                       /clear + prompt da fase (sessão nova por fase; continuidade = handoff.md);
                                                       --no-commit: a fase não faz commit, o DONE do watch exige só a prova
  hades agent resume <nome>                         /clear + retomar do handoff (depois de PARKED ou do teto de contexto);
                                                       a fase vem do registro ou do cabeçalho do handoff; sem ela, o prompt não cita fase
  hades agent park <nome> ["<motivo>"]              pede o handoff.md (STATUS: PARKED) e que o agente pare; a sessão e o painel ficam
                                                       (já estacionado ou encerrado: avisa e sai 0; é o que o caronte pack exige)
  hades agent escalate <nome> "<motivo>"            agente estaciona; painel novo no mesmo worktree para o dono iniciar
                                                       com o modelo de escalada (nunca /model: ele vira padrão global)
  hades agent status [--compact] [<nome>]           agentes, estado no herdr, PR, perguntas abertas e relatório
                                                     --compact: uma linha por agente (nome herdr fase evento pr ctx custo)
  hades agent list [--all] [--json]                 rápido e offline (registro + um herdr agent list): nome, papel, modo,
                                                       registro (ativo|encerrado|arquivado), herdr, branch, worktree; sem --all
                                                       só os não encerrados
  hades agent done <nome> [--keep-pane]             audita (relatório, git limpo, nada sem push, PR), libera o lock,
                                                       atualiza o estado e fecha o painel; a worktree fica
  hades agent decide <plano> --level-needed 1|2|3 --question "<texto>" --chosen "<opção>" [--alternatives "a; b"] [--class <c>]
                                                       o nível de autonomia (Configurações) cobre a decisão? sai 0 e deixa o rastro
                                                       (log do plano, diário, notificação); sai 3 = pergunte ao dono (reference/autonomia.md)
  hades agent auto-start on|off|status              auto-alocação: grava ou remove a regra allow Bash(herdr agent start:*) no
                                                       settings.json do usuário e liga o toggle; só o dono (painel local ou !)
  hades agent skill-new <unidade> [--base <ref>] [--role impl|consolidate] [--port N] [--dry-run]
                                                       unidade de evolução da própria skill: worktree skill/<u> no git local
                                                       da skill, brief do modelo, porta de teste, workspace herdr e registro
                                                       (modo skill: sem card, lock nem PR; adopt/prompt/phase/resume/done valem)
  hades agent skill-clean [<unidade>…|--merged] [--force-data] [--dry-run]
                                                       arquiva brief/relatórios e remove worktree, branch e dados de teste de
                                                       unidades já na main e sem agente ativo; fecha o workspace herdr
Registro único das unidades da skill: os skill-* gravam sempre em _skill (de qualquer clone ou da própria skill) e os
comandos que levam o nome do agente usam _skill quando o agente está lá (o lib.sh decide por HADES_LIB_SKILL_FORCE/AGENT)`;

export async function agentCommand(args: string[]): Promise<number> {
  const [sub = "status", ...rest] = args;
  const work = workFor(sub, rest);
  try {
    switch (sub) {
      case "plan-approve": return planApprove(rest, work);
      case "plan-trim": return planTrim(rest);
      case "start-cmd": return startCmd(rest, work);
      case "new": return await (await import("./agent-new.ts")).newAgent(rest, work);
      case "adopt": return (await import("./agent-new.ts")).adopt(rest, work);
      case "review": return (await import("./agent-new.ts")).reviewAgent(rest, work);
      case "reassign-orchestrator": return (await import("./agent-new.ts")).reassignOrchestrator(rest, work);
      case "prompt": return (await import("./agent-run.ts")).prompt(rest, work);
      case "answer": return (await import("./agent-run.ts")).answer(rest, work);
      case "phase": case "resume": return (await import("./agent-run.ts")).phaseOrResume(sub, rest, work);
      case "park": return (await import("./agent-run.ts")).park(rest, work);
      case "escalate": return (await import("./agent-run.ts")).escalate(rest, work);
      case "status": return (await import("./agent-run.ts")).status(rest, work);
      case "list": return (await import("./agent-run.ts")).list(rest, work);
      case "done": return (await import("./agent-run.ts")).done(rest, work);
      case "decide": return await (await import("./agent-autonomy.ts")).decide(rest);
      case "auto-start": return (await import("./agent-autonomy.ts")).autoStart(rest);
      case "skill-new": return (await import("./agent-skill.ts")).skillNew(rest, work);
      case "skill-clean": return (await import("./agent-skill.ts")).skillClean(rest, work);
      default:
        out(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof ExitWith) {
      warn(error.message);
      return error.code;
    }
    throw error;
  }
}
