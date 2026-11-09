#!/usr/bin/env bun
// CLI `hades`: roteador de subcomandos. Cada subcomando é um módulo em src/commands/, carregado só quando é chamado.
// Os scripts antigos da skill são wrappers que delegam aqui (lib.sh hades_ts) e mantêm caminho, argumentos, saída e
// código de saída até a 5.0.0.
import { EXIT, HadesError } from "./lib/output.ts";

type Command = (args: string[]) => number | Promise<number>;

const commands: Record<string, () => Promise<Command>> = {
  install: async () => (await import("./commands/install.ts")).installCommand,
  instance: async () => (await import("./commands/instance.ts")).instanceCommand,
  project: async () => (await import("./commands/project.ts")).projectCommand,
  models: async () => (await import("./commands/models.ts")).modelsCommand,
  quality: async () => (await import("./commands/quality.ts")).qualityCommand,
  review: async () => (await import("./commands/review.ts")).reviewCommand,
  "review-record": async () => (await import("./commands/review-record.ts")).reviewRecordCommand,
  "review-anchors": async () => (await import("./commands/review-anchors.ts")).reviewAnchorsCommand,
  "pr-loop-state": async () => (await import("./commands/pr-loop-state.ts")).prLoopStateCommand,
  watch: async () => (await import("./commands/watch.ts")).watchCommand,
  wait: async () => (await import("./commands/wait.ts")).waitCommand,
  consolidate: async () => (await import("./commands/consolidate.ts")).consolidateCommand,
  "gate-lock": async () => (await import("./commands/gate-lock.ts")).gateLockCommand,
  deps: async () => (await import("./commands/deps.ts")).depsCommand,
  cerberus: async () => (await import("./commands/cerberus.ts")).cerberusCommand,
  "cerberus-check": async () => (await import("./commands/cerberus-check.ts")).cerberusCheckCommand,
  "json-merge3": async () => (await import("./commands/json-merge3.ts")).jsonMerge3Command,
  "keep-both": async () => (await import("./commands/keep-both.ts")).keepBothCommand,
  "pr-set": async () => (await import("./commands/pr-set.ts")).prSetCommand,
  prs: async () => (await import("./commands/prs.ts")).prsCommand,
  logrotate: async () => (await import("./commands/logrotate.ts")).logrotateCommand,
  svc: async () => (await import("./commands/svc.ts")).svcCommand,
  linger: async () => (await import("./commands/linger.ts")).lingerCommand,
  clean: async () => (await import("./commands/clean.ts")).cleanCommand,
  onboard: async () => (await import("./commands/onboard.ts")).onboardCommand,
  notify: async () => (await import("./commands/notify.ts")).notifyCommand,
  "rebuild-branch": async () => (await import("./commands/rebuild-branch.ts")).rebuildBranchCommand,
  tunnel: async () => (await import("./commands/tunnel.ts")).tunnelCommand,
  "env-watch": async () => (await import("./commands/env-watch.ts")).envWatchCommand,
  doctor: async () => (await import("./commands/doctor.ts")).doctorCommand,
  rtk: async () => (await import("./commands/rtk.ts")).rtkCommand,
  "stack-add": async () => (await import("./commands/stack-add.ts")).stackAddCommand,
  "project-init": async () => (await import("./commands/project-init.ts")).projectInitCommand,
  agent: async () => (await import("./commands/agent.ts")).agentCommand,
  "version-check": async () => (await import("./commands/version-check.ts")).versionCheckCommand,
  panel: async () => (await import("./commands/panel.ts")).panelCommand,
  config: async () => (await import("./commands/config.ts")).configCommand,
  plugins: async () => (await import("./commands/plugins.ts")).pluginsCommand,
  usage: async () => (await import("./commands/usage.ts")).usageCommand,
  guard: async () => (await import("./commands/guard.ts")).guardCommand,
  "skill-release": async () => (await import("./commands/skill-release.ts")).skillReleaseCommand,
  "widget-apk": async () => (await import("./commands/widget-apk.ts")).widgetApkCommand,
  journal: async () => (await import("./commands/journal.ts")).journalCommand,
  contrib: async () => (await import("./commands/contrib.ts")).contribCommand,
  thanatos: async () => (await import("./commands/thanatos.ts")).thanatosCommand,
  "ux-audit": async () => (await import("./commands/ux-audit.ts")).uxAuditCommand,
  moirai: async () => (await import("./commands/moirai.ts")).moiraiCommand,
  caronte: async () => (await import("./commands/caronte.ts")).caronteCommand,
  canvas: async () => (await import("./commands/canvas.ts")).canvasCommand,
  minos: async () => (await import("./commands/minos.ts")).minosCommand,
  "write-check": async () => (await import("./commands/write-check.ts")).writeCheckCommand,
  explain: async () => (await import("./commands/explain.ts")).explainCommand,
};

const HELP = `hades <subcomando> [argumentos]
  install                        instala o kit em $HADES_DATA e prepara o worktree (kit/install.sh é a entrada; HADES_WT, HADES_ID…)
  instance [--dir <d>] | list    instância do Hades do diretório (hades instance)
  deps [--json] | need <id>…     dependências externas: o que falta e como instalar (src/deps/registry.tsv)
  cerberus <operação> [argumentos]  Cerberus: avaliar, registrar, guardas, historico, modos, excecao, estado (hades cerberus)
  json-merge3 <arquivo>…         merge de 3 vias de JSON em conflito (hades json-merge3)
  keep-both <arquivo>…           resolve conflitos de merge mantendo os dois lados (hades keep-both)
  pr-set [--heads]               conjunto de PRs do Hades em ordem topológica (hades pr-set)
  prs show|set|add|remove|reset  edita e mostra o prs.list
  logrotate [--dry-run] [--json] rotação dos logs por copiar + truncar (hades logrotate)
  svc run|stop|status|list       serviços de apoio do pacote (env/svc.sh) pelo gerenciador da máquina (hades svc)
  linger sync|state              linger do systemd do painel
  clean status|list|run|yes|rotate|apply  rotação de logs e limpeza de disco
  notify send|test|topic|status|apply|restart|watch  notificações desktop e celular, vigia
  onboard status|show|select|skip|done|undone|run|pick|reset  onboarding das features
  rebuild-branch                 reconstrói a hades/local: base + conjunto de PRs
  tunnel install|create|publish-cmds|url|status|panel-start|widget-…  túnel público do front, do painel e do widget
  env-watch                      plantão: HEADS-CHANGED, CEDE e GATES-CLEAR, uma linha por evento
  doctor [--quick] [--json]      diagnóstico: pré-requisitos, máquina, instalação e painel
  rtk status|apply [<dir>]       resumidores por stack entregues pelo rtk (reference/rtk.md)
  config show|get|set|unset|export|import  configurações do dono (config.sh)
  version-check status|doctor [--refresh] [--json]  checagem de versão da skill (hades version-check)
  panel serve [--port <porta>]   servidor do painel em TypeScript
  usage [--days N] [--json] [--baseline]  consumo de tokens por papel de sessão (hades usage)
  guard [context <cwd>]          hook PreToolUse/PostToolUse da Hades, JSON no stdin (hades guard, src/hook.ts)
  skill-release drift|check|guard|release  evolução da própria skill: drift, check (regressão pela fila), guardas, release
  journal list|tail|show <agente> [--since d] [--kind k] [--json]  diário de eventos por agente (hades journal)
  thanatos new|list|show|search|cited  post-mortem de incidente em produção do projeto, fora do repo (hades thanatos)
  ux-audit start|add|list|forward|resolve|done|reminder  auditoria de usabilidade do painel e do Argos com o Impeccable (reference/ux-audit.md)
  moirai history|estimate <plan.md>  histórico das unidades encerradas e estimativa de custo e duração por unidade do plano (hades moirai)
  caronte pack|unpack|brief      leva uma orquestração para outra sessão ou máquina: pacote cifrado com senha, abrir o pacote, ou o prompt de retomada (hades caronte)
  canvas note list|read|write | recruit|connect|reassign|dismiss|notify   o agente do terminal fala com o canvas: notas ligadas e equipe do orquestrador (hades canvas)
  minos list|schema|publish|link|open   publica as saídas da Hades fora do painel (orquestração, explicação de código, proposta): página do modelo, Cerberus, link estável (hades minos, reference/minos.md)
  contrib suggest|prepare|pr|html  devolve ao repo da skill a melhoria do núcleo: PR com confirmação ou .html sem acesso (hades contrib)
  plugins list|add|update|enable|disable|remove  pacotes de plugin: prévia, confirmação por commit, Cerberus
  project resolve|get|pack|ref|core-check|names|validate|stacks|step|detect   projeto ativo e perfil (hades project, hades project)
  models [--dry-run]             aplica o mapa de modelos dos subagentes de review (hades models)
  quality list|on|off|packs|validate|reset|inject|conflicts|state   catálogo de qualidade (hades quality)
  review --wt <worktree> --pr <n> --cmd review-pr|review-agents --model <m> --effort <e>   revisão de PR pelo painel (hades review)
  review-record <pr> <headOid> <reviewId> <verdict> <🔴> <🟡> <inline> <fora>   registro do review no shard da PR (hades review-record)
  review-anchors <pr> [--emit <arquivo>]   valida as âncoras in-line contra o diff (hades review-anchors)
  pr-loop-state [--json] [--author <l>|--others] [--pr <n>]... [--repo o/r]   estado das PRs para o loop, read-only (hades pr-loop-state)
  watch [--next] [<segundos>]    eventos novos dos agentes registrados, um por linha (hades watch)
  wait ci|gate|queue|merged|review|answer|agent …   esperas que notificam, rode em segundo plano (hades wait)
  consolidate plan|merge|verify|comment|ready|after-merge …   PR de consolidação (hades consolidate)
  gate-lock run <kind> [...] -- <cmd>|status|peak <label>   fila de admissão de gates, saída 75 = não admitido
  stack-add propose|measure|save  propõe, mede e grava o pacote de stack de um repo (hades stack-add)
  project-init draft|save        rascunho e gravação do perfil de um repo (hades project-init)
  widget-apk [build|test|shots|list|new <id>|image|status]   APK do widget Android, num container Docker (kit/android/build.sh)
  explain [<código>]             o que um erro quer dizer, por quê e o que fazer (hades explain, reference/erros.md)
  agent new|adopt|review|prompt|answer|phase|resume|park|escalate|status|list|done|plan-approve|plan-trim|start-cmd|decide|auto-start|skill-new|skill-clean …
                                 agentes do orquestrador (hades agent)`;

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === "-h" || name === "--help") {
    process.stdout.write(`${HELP}\n`);
    return name === undefined ? EXIT.usage : EXIT.ok;
  }
  const load = commands[name];
  if (!load) {
    // o catálogo só carrega quando há erro a explicar: o caminho feliz da CLI não paga o parse dele
    const { CLI_ERRORS, renderCli, suggestName } = await import("./lib/human-errors.ts");
    const near = suggestName(name, Object.keys(commands));
    const hint = near === undefined ? "" : ` Você quis dizer \`hades ${near}\`?`;
    process.stderr.write(`${renderCli(`subcomando desconhecido: ${name}.${hint}`, CLI_ERRORS.unknownCommand)}\n`);
    return EXIT.usage;
  }
  return (await load())(args);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const { CLI_ERRORS, cliCodeOfExit, renderCli } = await import("./lib/human-errors.ts");
  if (error instanceof HadesError) {
    process.stderr.write(`${renderCli(error.message, error.errorCode ?? cliCodeOfExit(error.code))}\n`);
    process.exitCode = error.code;
  } else {
    // a pilha é de quem depura: sem HADES_DEBUG=1 a tela mostra só a explicação (nunca caminho nem trecho de código)
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${renderCli("erro inesperado", CLI_ERRORS.unexpected)}\n`);
    if (process.env.HADES_DEBUG === "1") process.stderr.write(`${detail}\n`);
    process.exitCode = EXIT.fail;
  }
}
