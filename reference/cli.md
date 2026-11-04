# CLI `hades` (Bun + TypeScript)

Toda a lógica da Hades mora em `src/`, roda do fonte pelo Bun (sem binário compilado, sem build) e a skill não tem
dependência de runtime: `package.json` só lista `typescript` e `@types/bun`, ambas de desenvolvimento
(`bun x tsc --noEmit`). Não há wrappers `.sh`, `.py` ou `.mjs` de lógica: tudo é `hades <subcomando>`. O HELP
(`bun src/cli.ts --help`) é a fonte desta tabela.

```bash
bun src/cli.ts <subcomando> [argumentos]     # o mesmo que `hades <subcomando>` quando o alias existe
```

Os subcomandos vêm agrupados por área. Coluna "Shim": `kit/<arquivo>` é um shim permanente de uma linha (via
`kit/hades-ts.sh`) que o `$D` instalado e o painel chamam (a exceção, `config.sh`, está em §Shims); `—` = só a CLI.

### Loop e agentes

| Subcomando | O que faz | Shim |
|---|---|---|
| `cerberus avaliar\|registrar\|guardas\|historico\|modos\|excecao\|estado …` | corpo do Cerberus (`reference/cerberus.md`) | — |
| `cerberus-check porta/<guarda>\|limiar <guarda>\|vigilia/auditoria <guarda>\|vigilia/coerencia <guarda>` | os checks das guardas `exec` do Cerberus (uma linha JSON de veredito); o `cmd` do JSON da guarda chama este subcomando | — |
| `models [--dry-run]` | aplica o mapa de modelos dos subagentes de review ao `model:` de `~/.claude/agents/review-*.md` | — |
| `quality list\|on\|off\|packs\|validate\|reset\|inject\|conflicts\|state` | catálogo de qualidade (regras, pacotes, bloco dos briefs) | — |
| `review --wt <worktree> --pr <n> --cmd review-pr\|review-agents --model <m> --effort <e> [--post] [--id <id>] [--dry-run]` | revisão de PR pelo painel: worktree descartável no head da PR, `claude -p`, registro em `~/.claude/hades/reviews/` | — |
| `review-record <pr> <headOid> <reviewId> <verdict> <🔴> <🟡> <inline> <fora>` | grava o registro `review` no shard da PR | — |
| `review-anchors <pr> [--emit <arquivo>]` | valida as âncoras in-line contra os hunks RIGHT do diff e monta o payload do review | — |
| `pr-loop-state [--json] [--author <l>\|--others] [--pr <n>]... [--repo o/r] [--state <p>] [--limit <n>]` | estado das PRs para o loop (read-only): classificação, threads vivas, checks, pilhas | — |
| `journal list\|tail\|show <agente> [--since <dur\|iso>] [--kind k] [--limit n] [--json]` | diário de eventos por agente (ferramentas, permissões, gate, watch, Cerberus), só leitura (`reference/journal.md`) | — |
| `thanatos new <card\|PR\|<iso>..<iso>> [--force] [--json]` · `list\|show <id>\|search <termo>` · `cited [--base <ref>\|--pr <n>\|<arquivo>…]` | post-mortem de incidente em produção do projeto, gravado fora do repo; `cited` avisa arquivo já citado em post-mortem (`reference/thanatos.md`) | `cited` sempre 0 |
| `watch [--next] [--all\|--agent <nome>…\|--agents a,b\|--orchestrator <sessão:pane>] [<segundos>]` | eventos novos dos agentes do seu pane (sem flag, num pane do herdr; `--all` = todos), um por linha (QUESTION, PR-OPEN, DONE, REVIEW, MERGED, THANATOS, PARKED, CONTEXT, STALLED, BUDGET) | — |
| `wait ci <PR>\|gate <pid> [sumário]\|queue <label>\|merged <PR>\|review <PR>\|answer <worktree> <Qn>\|agent <nome> [estado]\|proc <padrão>` | espera até o evento e sai com uma linha; rode em segundo plano (`HADES_WAIT_EVERY`, `HADES_WAIT_MAX`) | — |
| `consolidate plan\|merge\|verify <PR>…`, `comment <N> <PR>… [--post]`, `ready <N> [--post]`, `after-merge <N> <PR>… [--post]` | junta PRs abertas numa PR de consolidação (a do orquestrador), por merge | — |
| `gate-lock run <kind> [--label L] [--timeout S] [--cost-gb N] [--step S:E] [--priority N] -- <cmd>`, `status`, `peak <label>` | fila de admissão de gates (FIFO por projeto, memória, scope systemd); saída 75 = não admitido até o timeout; `status` e o notify overrunam gate longo (`HADES_GATE_OVERRUN_MIN`, `HADES_GATE_OVERRUN_FACTOR`) | `kit/gate/gate-lock.sh` |
| `json-merge3 <arquivo>…` | merge estrutural de 3 vias de JSON em conflito | — |
| `keep-both <arquivo>…` | resolve conflitos de merge mantendo os dois lados | — |
| `agent new\|adopt\|reassign-orchestrator\|review\|prompt\|answer\|phase\|resume\|park\|escalate\|status\|list\|done\|plan-approve\|plan-trim\|start-cmd\|decide\|auto-start\|skill-new\|skill-clean …` | agentes do orquestrador: alocação, tarefa, fases, estado e encerramento (argumento faltando sai 2 com `hades: faltou <x>`); notas abaixo da tabela | — |
| `agent decide <plano> --level-needed 1\|2\|3 --question "…" --chosen "…" [--alternatives "a; b"] [--class <c>]` | o nível `HADES_ORCH_AUTONOMY` cobre a decisão? Sai 0 e grava log do plano, diário (`decision`) e notificação; sai 3 = pergunta ao dono (sempre nas classes que nunca cedem); 2 = argumento inválido (`reference/autonomia.md`) | — |
| `agent auto-start on\|off\|status` | liga/desliga o interruptor e grava/remove só a regra allow `Bash(herdr agent start:*)` no `settings.json` do usuário (idempotente, preserva o resto); só o dono (o hook barra `on\|off` vindo do Claude) | — |
| `agent park <nome> ["<motivo>"]` | pede ao agente o `handoff.md` (`STATUS: PARKED`) e que pare; marca o registro `parked` quando o handoff chega fresco. Não mata a sessão nem fecha o painel; já estacionado ou encerrado: avisa e sai 0 | — |
| `caronte pack <plano> [--out <arq>] [--with-journal] [--allow <caminho>]… [--dry-run]` | empacota a orquestração (plano, registros, relatórios, worktrees como bundle + patch) num arquivo cifrado com senha (AES-256-GCM); recusa se algum agente não está estacionado (`reference/caronte.md`) | — |
| `caronte unpack <arq> [--work-root <d>] [--plans <d>] [--worktrees <d>] [--clone <d>] [--dry-run]` | abre o pacote cifrado e refaz plano, registros (agentes `parked`), relatórios e worktrees (bundle + patch) com os caminhos reescritos; recusa sem tocar em nada se algo já existe ou falta, desfaz se falha no meio, nunca clona (`reference/caronte.md`) | — |
| `caronte brief <plano>` | imprime o prompt de retomada do orquestrador numa outra sessão da mesma máquina (só leitura) | — |
| `pr-set [--heads]` | conjunto de PRs da `hades/local` (`$D/prs.list`) em ordem topológica | — |
| `usage [--days N] [--json] [--baseline]` | consumo de tokens por papel de sessão (custo equivalente de API, polling, reescrita de contexto) e, ao lado do US$, `% 5h` e `% semana` estimados pela calibração mais o % medido das janelas; grava `~/.claude/hades/usage/` | — |
| `usage sample [--quiet]` | comando do `statusLine`: lê o JSON do Claude Code no stdin e grava o % das janelas de 5 h e semanal em `~/.claude/hades/limits/samples.jsonl` (`reference/limites.md`) | — |
| `guard [context <cwd>]` · `guard register` | hook PreToolUse/PostToolUse (JSON no stdin) e o registro dele no `settings.json` (abaixo) | — |

Notas do `agent`:
- `reassign-orchestrator <nome>…|--all` aponta o `orchestrator` dos registros para o pane atual.
- `phase <nome> <fase> --no-commit`: a fase não faz commit e o `DONE` do `hades watch` exige só a prova (`resume` mantém,
  `phase` sem a flag reseta).
- `prompt|resume|answer|phase` avisam quando o `report.md` ainda começa com `STATUS: DONE`.

### Ambiente

| Subcomando | O que faz | Shim |
|---|---|---|
| `install` | instala o kit em `$HADES_DATA` e prepara o worktree (detalhe em §install abaixo) | `kit/install.sh` (casca) |
| `prs show\|set\|add\|remove\|reset` | edita e mostra o `prs.list` | `kit/prs.sh` |
| `logrotate [--dry-run] [--json]` | rotação dos logs por copiar + truncar | — |
| `linger sync\|state` | linger do systemd para o painel em modo boot | `kit/linger.sh` |
| `svc run\|stop\|status\|list` | serviços de apoio do pacote (`env/svc.sh`) pelo gerenciador da máquina; o caminho do macOS (`reference/projects.md` §Serviços de apoio no macOS) | — |
| `clean status [--tsv]\|list <cat>\|run [--dry-run] [--quiet] [--yes <cat>]\|yes <cat>\|rotate\|apply` | rotação de logs e limpeza de disco (categorias, timer do usuário) | `kit/clean.sh` |
| `notify send\|test\|topic [rotate]\|status [--json] [--reveal]\|apply\|restart\|watch` | notificações no desktop (notify-send) e no celular (ntfy), dedupe, histórico e o vigia `<HU>-notify` | `kit/notify.sh` |
| `onboard status\|show\|select\|skip\|done\|undone\|run\|pick\|reset` | onboarding dos recursos (`reference/onboard.md`) | `kit/onboard.sh` |
| `rebuild-branch` | reconstrói a `hades/local`: base + conjunto de PRs em ordem topológica (`rebuild.report`, `prs.tsv`) | `kit/rebuild-branch.sh` |
| `tunnel install\|login-cmd\|create\|publish-cmds\|url\|status\|stop-cmd\|panel-start\|panel-url\|panel-stop\|panel-status\|widget-…` | túnel público (devtunnel) do front, do painel e do widget Android; publicar é do dono (imprime `! …`) e passa pelo Cerberus | `kit/tunnel.sh` |
| `widget-apk [build\|test\|shots\|list\|new <id>\|image\|status]` | gera o APK assinado do widget Android num container Docker (§widget-apk; `reference/android-widget.md`) | `kit/android/build.sh` |
| `env-watch` | plantão: `HEADS-CHANGED`, `CEDE` e `GATES-CLEAR`, uma linha por evento, sem parar | `kit/watch.sh` |
| `doctor [--quick] [--json]` | diagnóstico: ferramentas, máquina, instalação, painel, plugin e onboarding; o `doctor.sh` do plugin roda num shim de bash | `kit/doctor.sh` |
| `config show\|get\|set\|unset\|export\|import` | configurações do dono (`reference/config.md`) | `kit/config.sh` (§Shims) |
| `version-check status\|doctor [--refresh] [--json]` | checagem de versão da skill | — |

### Painel

| Subcomando | O que faz | Shim |
|---|---|---|
| `panel serve [--port <porta>]` | servidor do painel em TypeScript (`src/panel/`, `reference/panel.md`) | — |
| `panel service start\|stop\|restart\|status\|url\|autostart` | o painel como serviço do usuário, pelo gerenciador da plataforma (systemd ou launchd; `HADES_SERVICE_MANAGER` força um) | `kit/panel.sh` |
| `canvas note list\|read\|write`, `recruit\|connect\|reassign\|dismiss\|notify [--canvas <id>]` | o agente de um terminal do canvas lê e grava as notas ligadas ao nó dele (a cadeia só se lê) e, se o terminal tem a caixa Orquestrador, comanda os recrutas que criou; recusa sai 1, uso errado sai 2 (`reference/argos.md` §Orquestrador no canvas) | — |

### Projeto e plugin

| Subcomando | O que faz | Shim |
|---|---|---|
| `instance [--dir <d>]` · `instance list` | instância do Hades do diretório | — |
| `deps [--json]` · `deps need <id>…` | dependências externas: o que falta e como instalar | — |
| `project resolve\|get\|pack\|ref\|core-check\|names\|validate\|stacks\|step\|detect\|packs\|patterns\|domain` | projeto ativo, perfil, stacks e guarda de nome | — |
| `stack-add propose <repo> [--name N] [--stage DIR]`, `measure <rascunho> <repo> <etapa> [--project P] [--timeout S]`, `save <rascunho> --confirmed [--force]` | propõe, mede pela fila e grava o pacote de stack de um repo | — |
| `project-init draft <repo> [--name N] [--slug o/r] [--gh-user U] [--stage DIR] [--dry-run]`, `save <rascunho> <repo> --confirmed [--force]` | rascunho do perfil de um repo e gravação com o ok do dono | — |
| `plugins list\|add\|update\|enable\|disable\|remove …` | pacotes de plugin: prévia, confirmação por commit, Cerberus | `kit/plugins.sh` |

### Evolução da skill

| Subcomando | O que faz | Shim |
|---|---|---|
| `skill-release drift\|check [--regressao]\|guard\|release <nível> "<resumo>"` | evolução da própria skill: drift, check (guardas, `bash -n`, `tsc`, perfis, regressão `bun test` pela fila de gates com pulo por HEAD verde, instalação descartável), release | `kit/skill-release.sh` |
| `contrib suggest\|prepare\|pr\|html --title <t> --why <t> --gains <l> --proof <t> [--what <t>] [--base <ref>] [--slug <s>] [--yes]` | devolve ao repo da skill a melhoria do núcleo: guarda de nome/domínio/segredo, PR com confirmação (com acesso de escrita) ou `.html` (sem acesso); nada sai sozinho (`reference/contrib.md`) | — |

## install

`hades install` instala o kit em `$HADES_DATA` e prepara o worktree:
- cópia pelo manifesto sha256, sem `rsync`;
- remoção dos `*.js` de `panel/ui/**` (fora de `vendor/`) que têm `*.tsx` irmão no kit, com um aviso por arquivo (UI gerada de antes do TSX, que sombreava o fonte);
- `env.sh`, slice, overlay do `env.pack`, portas por bind, hook e registro das instâncias.

O cabeçalho de `src/commands/install.ts` tem o contrato inteiro. A entrada documentada segue sendo o `kit/install.sh`: uma casca que só confere o Bun pelo registro e faz `exec` aqui, porque roda antes de haver Bun.

## Lib comum (`src/lib/`)

`output` (saída e códigos de saída: `EXIT`, `HadesError`), `paths`, `fs`, `proc` (subprocesso com timeout), `config`
(leitura de `config.tsv`, `env.sh` e `config.env`), `instance` (resolução igual à do `hades instance`), `project`
(igual à do `hades project resolve`) e `deps` (o registro, abaixo).

Códigos de saída: os mesmos dos scripts que a CLI substitui; `69` é o único novo: **dependência externa ausente**.

## Registro único de dependências (`src/deps/registry.tsv`)

Uma linha por dependência externa (gh, docker, herdr, systemctl, devtunnel, git, jq, bun…): id, comando, argumentos de
versão, nível (`error` ou `warn`), quem diagnostica no doctor (`own` ou `registry`), como instalar e para quê, mais a coluna `sistema` (`linux` | `macos`; vazia vale para os dois). É TSV porque
o bash (`lib.sh`, `doctor.sh`, `install.sh`) lê o registro antes de existir Bun.

- `hades deps` lista só as dependências do sistema da máquina (`systemctl`, `journalctl`, `systemd-run` e `loginctl` no Linux; `launchctl` no macOS; `HADES_SERVICE_MANAGER` força um) e o que falta, com a instrução de instalar de cada ausente; `hades deps --json` é o contrato
  `version: 1` que o painel consome (a página é do bun-painel). `hades deps need <id>…` sai `69` se faltar alguma.
- No bash: `dep_need <id>…` (em `loop/bin/lib.sh`) falha cedo com exit `69` e a mesma mensagem da CLI.
- O `doctor.sh` mostra as linhas `doctor=registry` (bun, git, herdr); as `own` já têm checagem própria e mais rica
  (`reference/doctor.md`). O `kit/install.sh` exige o Bun pelo registro.
- Dependência nova: uma linha no TSV; nada mais precisa mudar.
- O `jq` segue necessário: `loop/bin/lib.sh` (perfil do projeto) e `kit/config.sh` o chamam. O `dep_need` do
  bash só confere o `bun` (o resto é conferido pelo `doctor.sh` e por `hades deps`).

## widget-apk (`src/commands/widget-apk.ts`)

Lado host do build do APK do widget: `hades widget-apk [build|test|shots|list|new <id>|image|status]` (sem argumento, `build`).
`kit/android/build.sh` é só o shim. Sem `docker` no PATH falha cedo (saída 69) com o "como instalar" do registro de dependências.
- **Fontes:** `kit/android/widget/` é copiado (em TS, sem rsync; modo e data preservados) para `$D/android/build/src`, que é o
  que o container compila. `build/` e `.gradle` não entram na cópia nem no hash e a cópia não os apaga do destino.
- **`sourcesSha`:** `src/lib/widget-sources.ts`, uma implementação só: o build a grava no sidecar `hades-widget.apk.json` e o
  painel (`src/panel/widget.ts`) a refaz sobre `$D/android/widget` para dizer "APK desatualizado".
- **Container:** `docker run --rm --user uid:gid` com `$D/android` em `/work` e `kit/android/docker/inside.sh` (bash, roda
  só dentro do container) em `/inside.sh`; versão e hash dos fontes entram por `-e HADES_VERSION_NAME|CODE|SOURCES_SHA`.
  `list` e `new` rodam `tools/run.sh` com as fontes em `/widget` (`:ro` no `list`).
- **Fila:** fora do gate-lock (`GATE_LOCK_TICKET` vazio) e com `$GATE_LOCK` (ou `$D/gate/gate-lock.sh`) executável, o comando
  se re-executa por `gate-lock run build --label widget-android --cost-gb 3`.
- **Dados:** dentro do kit instalado (`HADES_KIT_DIR` = `$D/android`) o estado é a própria pasta e a versão vem de
  `$D/kit.version`; no kit da skill, o `$D` vem de `HADES_DATA` ou da instância do diretório e a versão da `VERSION` da skill.

## Shims do kit (`kit/`)

A ajuda (`hades --help`) diz o que cada subcomando faz, sem apontar o shim: o `kit/<x>.sh` correspondente continua existindo
e é só uma linha que chama a CLI (esta seção).

Os shims de `kit/` ficam no `$D` instalado, que não leva o `src/`: `kit/hades-ts.sh` acha a CLI na skill ao lado
(`kit/` dentro da skill) ou em `HADES_SKILL_DIR` (padrão `~/.claude/skills/hades`) e exporta `HADES_KIT_DIR`, a pasta do
shim: é o `$D` dos subcomandos que leem estado do kit (`prs.list`, `linger.mine`, `logs/`). Cada shim é uma linha que
chama o subcomando (`hades_ts` em `lib.sh`); são permanentes (units, timers e o painel os chamam por caminho). Sem Bun o
shim falha cedo (`69`, com a instrução de instalar). `HADES_BUN` aponta outro executável do Bun. A exceção é
`kit/config.sh`, que tem lógica própria (`hades config`) e é também o arquivo que o `env.sh` lê (`reference/config.md` §Peças).

## Hook (`src/hook.ts`, `hades guard`)

O hook de toda sessão do Claude Code (PreToolUse, PostToolUse, Notification, Stop e UserPromptSubmit) é TypeScript: `src/lib/guard-hook.ts`, com o ponto de
entrada `src/hook.ts` (só o hook, sem o roteador da CLI) e `hades guard` como a mesma lógica pela CLI. As expressões
seguem em `loop/hooks/guard-rules.json`, fonte única do hook e do `hades usage`. O `install.sh` grava no
`~/.claude/settings.json`, por `hades guard register`, o comando `bun ~/.claude/skills/hades/src/hook.ts` (os cinco eventos; PreToolUse e PostToolUse com matcher `*`, só para o diário: as decisões do guard seguem só no Bash, `reference/journal.md`), sem duplicar e sem tocar nos outros hooks (`HADES_CLAUDE_SETTINGS` aponta outro arquivo;
instalação descartável com `SKIP_SYSTEMD` ou `SKIP_WORKTREE` não mexe no settings do dono).
