---
name: hades
description: Hades: o conjunto de trabalho do dev, por projeto, global (~/.claude) e acionado por /hades. (1) Loop de engenharia: leva spec até a PR, reconcilia os reviews recebidos nas minhas PRs, revisa PRs de terceiros em paralelo, cascateia stacks, orquestra agentes pelo herdr com PR de consolidação e gate único, e cuida de locks e da fila de gates. (2) Ambiente local: branch hades/local (base do projeto + PRs), infra docker própria, serviços sob teto de memória, dados e processos de apoio do projeto, painel web (com chat com o Claude, também pelo celular) e túnel (/hades env up|update|pause|resume|status|panel|config|doctor|onboard). Use para "leva a spec X até a PR", "aplica os reviews das minhas PRs", "continua as PRs em voo", "revisa N PRs do autor Y", "cascateia a stack", "orquestra agentes", "consolida as PRs", "libera os locks presos", "sobe o Hades", "atualiza o Hades", "abre o painel", "prepara as features", "o que falta configurar", e quando o dev pedir algo que a Hades ainda não cobre (ela se estende). Não é review pontual de branch (/review-agents).
argument-hint: '[deliver|inbox|review|cascade|sweep|status|locks|answer|ready|watch|resume|orchestrate|consolidate|usage|env <acao|onboard>|project init] [--orchestrated] [--max N] [--author L] [--pr N] [--deep] [--loop [--every 30m] [--until H] [--rounds N] [--no-post] [--note N]] [--dry-run] [--allow-in-review] [--no-integration] [--max-iters N] [--pattern P]'
---

# Hades

O conjunto de trabalho do dono no projeto ativo (o perfil em `~/.claude/hades/packs/`), numa skill só e num comando só (`/hades`):

- **Parte I — Ambiente local:** roda o estado mais recente das PRs de um autor para validação manual, com infra,
  dados, processos de apoio do projeto, painel e túnel (`kit/` da máquina + `env/` do pacote do projeto, instalados em `<worktree>-data`).
- **Parte II — Loop de engenharia:** leva a PR do começo ao fim e reconcilia os reviews, sem nunca fazer merge
  (`reference/loop/`, `loop/bin/`).

As duas partes dividem a **fila de gates** (`hades gate-lock`, estado em `~/.claude/hades/work`), as **Configurações**
e o **painel** (http://127.0.0.1:21220: Loop, Fila de gates, Serviços, …). Versão em `VERSION`, histórico em
`CHANGELOG.md`; a skill evolui pelo `reference/evolving.md`.

**Termos.** **a Hades** = esta skill; **o Hades** = o ambiente local no ar (branch, infra, serviços, painel).
**Dono** = quem opera a instalação e decide (o "você" do README); **autor** = quem abriu a PR; **mantenedor da skill**
= quem publica as versões da skill. **Gate** = checagem pesada antes da PR (build, lint, testes), sempre pela fila.
**Tick** (= passada) = uma volta do loop: coletor → escolhe o alvo → age → reporta (`reference/loop/gates.md` §7). **Card** = o item
do rastreador de tarefas que o perfil exige (`card.*`). **Thread** = conversa de review numa linha da PR.
**`$D`** = a pasta de dados da instância (abaixo). **`ref <nome>`** = `hades project ref <nome>`, o texto que o pacote
do projeto declara. **Pasta de relatórios** = `.design-sync-reports/` na worktree de cada agente (brief, `report.md`
do agente, `questions.md`, `handoff.md`).

## Comando `/hades`

`~/.claude/commands/hades.md` faz o parsing; esta skill é a fonte das regras. Esta tabela é a canônica dos modos e
das flags.

| Invocação | Faz |
|---|---|
| `/hades` | loop: `inbox` e, se nada estiver acionável, `deliver` |
| `/hades deliver [<spec-id\|caminho>] [--allow-in-review] [--no-integration] [--max-iters N]` | spec → código → gates → `/review-agents` → PR (`reference/loop/deliver.md`) |
| `/hades inbox [--pr N] [--no-integration] [--max-iters N]` | triagem e achados vivos das minhas PRs (`reference/loop/inbox.md`) |
| `/hades review [--max N] [--author L] [--pr N] [--deep]` | revisa PRs de terceiros em paralelo e publica como comentário (`reference/loop/review.md`) |
| `/hades review --loop [--every 30m] [--author L \| --pr N…] [--until H] [--rounds N]` | loop: de tempos em tempos revisa só as PRs de head novo, sem repetir achado (`reference/loop/review.md` §7) |
| `/hades cascade [--pr N]` · `/hades sweep [--pattern P]` | cascata da stack nos quatro sentidos (`reference/loop/cascade.md`) |
| `/hades orchestrate [<objetivo>]` | papel de orquestrador: aloca agentes pelo herdr, escreve briefs, acompanha, audita e leva decisões ao dono (`reference/loop/orchestrate.md`) |
| `/hades consolidate <PR>...` | PR de consolidação: originais entram por merge, gate uma vez, merge único na base (`reference/loop/consolidate.md`) |
| `--orchestrated` (deliver, inbox, cascade, consolidate) | a passada é de um agente alocado: segue o cartão do papel, o brief e o gate do modo orquestrado (`reference/loop/gates.md` §1.0) |
| `--dry-run` (qualquer modo que escreve) | plano, checklist e relatório locais; nada sai de `~/.claude/hades/work` |
| `/hades status` | coletor + locks + escalações; read-only |
| `/hades locks` · `answer` · `ready` · `watch` · `resume` | manutenção do loop (`reference/loop/ops.md`) |
| `/hades usage [--days N]` | consumo de tokens (`hades usage`): por papel, agente e dia, contra a linha de base |
| `/hades project init [--dry-run]` | gera o perfil do repo atual (lê CLAUDE.md, CI, commitlint, regras; detecta stacks; mapeia regras ao catálogo) e só grava em `~/.claude/hades/packs/<projeto>/` com o ok do dono; num repo com perfil mostra o diff (`reference/project-init.md`) |
| `/hades env up [PRs…] [--no-tunnel\|--tunnel] [--no-<passo>] [--rebuild]` | `$D/run-hades.sh` (Parte I, Fases 1→7) |
| `/hades env update [--all]` · `pause` · `resume` | `$D/update.sh` · `$D/hades.sh pause\|resume` |
| `/hades env status` · `panel` · `config [K=V…]` | `run-hades.sh --status` · `panel.sh start` · `config.sh show\|set` |
| `/hades env onboard` | onboarding: pergunta quais recursos preparar agora (acesso remoto, notificações, início do painel, contas e loop), roda com o ok do dono o que é da Hades e entrega os passos do dono com o comando pronto (`$D/onboard.sh`, `reference/onboard.md`) |
| `/hades env doctor [--quick\|--json]` | `$D/doctor.sh`: pré-requisitos, máquina, instalação e painel, com o comando que corrige cada item (`reference/doctor.md`) |

CLI de apoio da orquestração (no terminal, não é modo do `/hades`):

| Comando | Faz |
|---|---|
| `hades agent plan-trim <plan.md>` | move o histórico do plano do orquestrador para `<plano>.log.md` e deixa o "Estado atual" (`reference/loop/plan-template.md`) |
| `hades agent park <agente>` | estaciona o agente (`reference/caronte.md`) |
| `hades caronte pack\|unpack\|brief` | empacota a orquestração cifrada, abre o pacote em outra máquina ou imprime o prompt de retomada (`reference/caronte.md`) |

`$D` vem de `hades instance` (do diretório atual): a instância do projeto (`~/.claude/hades/instances/<projeto>`)
ou, sem ela, a padrão (`~/.claude/hades/instance`); o `install.sh` grava as duas. O `/hades env` funciona de qualquer clone,
e vários projetos convivem na máquina, cada um na sua instância (`reference/projects.md` §Várias instâncias).

## Parte I — Ambiente local

### Regras duras do ambiente

Valem para a branch `hades/local` e o ambiente; o loop (Parte II) tem as suas.

- `hades/local` é **local**: nunca push, nunca commitar nas branches das PRs, nunca comentar/editar PR no GitHub.
  Problema que exige mudança de código numa PR → registrar em `notes.md` (vai para o STATUS) e avisar o dono.
- **Não é gate**: nada de `nx test`/`nx lint` de suíte. Compilar para rodar é o mínimo, pela fila do gate-lock.
- **O Hades cede, nunca um gate**: gate pesado esperando memória > 2 min → `hades.sh pause` (sem perder dados);
  `hades.sh resume` quando a fila esvaziar. O `watch.sh` detecta os dois. **Só o dono suspende a regra**: ele
  pede → criar `$D/cede.disabled` (o `watch.sh` para de emitir `CEDE`); reativar apagando o arquivo. Parar um gate de
  outro agente também só com pedido explícito do dono (`systemctl --user stop <scope run-p…>` do gate, nunca `pkill`).
- **Nada destrutivo fora do Hades**: nada de `docker system prune`, `pkill -f`, volume que não seja do projeto
  `hades`, nem os containers de nome aleatório (testcontainers de gates alheios) e os containers de outro projeto com `container_name` fixo.
- **Túnel público é passo do dono**: liberar acesso anônimo e hospedar o túnel são recusados ao agente pelo auto
  mode (External Ingress). O agente prepara e entrega os comandos `! ...` (ver `reference/tunnel.md`).
- Credenciais só em `$D/credenciais.md` (600). Nunca em log, commit ou conversa além do necessário.
- **Antes de subir qualquer coisa numa máquina nova, proponha e espere o ok** (Fase 0).
- **A skill evolui com o uso**: pedido fora do escopo → resolver no vivo, generalizar no `kit/` (nunca só em `$D`),
  documentar e gerar versão nova com `kit/skill-release.sh` (`reference/evolving.md`). Versão atual em `VERSION`,
  histórico em `CHANGELOG.md`.

### Onde fica cada coisa

| | |
|---|---|
| `kit/` (esta skill) | a parte da **máquina**: install, config, doctor, onboarding, painel, notificações, túnel, fila de gates, rotação de logs, `skill-release` |
| `<pacote>/env/` (`env.pack` do perfil) | o **ambiente do projeto**, com o mesmo layout do `$D`: infra, dados, processos de apoio, serviços (`services.tsv`, `svc.sh`…), `run-hades.sh`, `update.sh`, `STATUS.template.md`; `assets/`, `reference/` (textos, abertos por `ref env-<nome>`) e `post-install.sh` não vão para o `$D`. Sem `env.pack` o `install.sh` instala só a máquina |
| `VERSION` · `CHANGELOG.md` (esta skill) | versão atual e histórico (o que mudou, por quê, o que se descobriu) |
| `$D` = `<worktree>-data` | kit e ambiente do pacote instalados (o `install.sh` copia o `kit/` e depois sobrepõe o `env/`) + estado (`env.sh`, `config.env`, `root.env`, `credenciais.md`, `seed/*state.json`, `conflicts.log`, `notes.md`, `STATUS.md`, `logs/`) |
| `<worktree>` | branch `hades/local`, `.env` de cada serviço (gerados), `dist/` e o que o pacote extrair (excluído do git) |

Scripts da máquina instalados em `$D` (todos fazem `source env.sh`):
**`run-hades.sh`** (entrypoint único do dono: sobe tudo, idempotente, à prova de reboot — `reference/run-hades.md`) ·
`config.sh` · `config.tsv` · `prs.sh` · `hades.sh` · `rebuild-branch.sh` · `panel.sh` · `gate/gate-lock.sh` · `tunnel.sh` · `watch.sh`. Os `.sh` do kit são shims permanentes de uma linha da CLI `hades <subcomando>` (`reference/cli.md`), exceto `config.sh` (lógica própria, o mesmo que `hades config`).
Os scripts do ambiente do projeto (infra, serviços, dados, processos de apoio) vêm do `env/` do pacote: lista e roteiro em `ref env-phases`.

### Fluxo

> **Atalho do dono:** as Fases 1→7 abaixo estão encapsuladas em `$D/run-hades.sh` (alias `run-hades`) — um comando
> idempotente e à prova de reboot que o **dono** roda direto, sem agente, inclusive para trocar o conjunto de PRs
> (`run-hades 4937 4959`). O agente usa as fases individualmente quando precisa de controle fino ou quando algo saiu
> do script. Detalhes, flags e troubleshooting em `reference/run-hades.md`.

#### Fase 0 — medir e propor (máquina nova ou pedido novo)
1. `free -h`, `docker ps`, `docker stats --no-stream`, `ss -ltn`, `gate-lock.sh status` (se houver).
2. `gh pr list --author @me --state open --json number,title,headRefName,baseRefName,isDraft,headRefOid,files`
   — ordem topológica (base de PR antes da PR), drafts fora salvo pedido.
3. Propor ao dono: serviços (os obrigatórios do ambiente, `services.required`, + os tocados pelas PRs + dependências diretas), modo
   (`reference/architecture.md` §Decisões), teto de memória, faixa de portas, matriz de usuários. **Esperar o ok.**

#### Fase 1 — instalar o kit
```bash
HADES_WT=<worktree com a branch hades/local> ~/.claude/skills/hades/kit/install.sh
```
Cria `$D`, `env.sh` (com `HADES_ID`: vazio na primeira instância da máquina), a slice systemd da instância (`hades`; `hades_<id>` nas outras), liga rerere, aplica o `env/` do pacote (`post-install.sh`) e exclui do git o que ele extrair.
O install copia em TypeScript pelo manifesto (sem `rsync`, e nunca por espelho: o `$D` guarda estado) preservando o modo dos `.sh`: grava `$D/kit.manifest` (sha256 de cada arquivo do kit que instalou) e, na reinstalação, remove do `$D` o que saiu do kit e não foi editado à mão (editado: aviso e fica; sem manifesto anterior, só avisa `*.py` e `panel/ui/**` que o kit não tem mais).
O worktree precisa de `node_modules`: ver `ref env-operations` §node_modules (symlinks + `pdfjs-dist` local).
No fim da **primeira** instalação o `install.sh` imprime o resumo do onboarding (o que dá para preparar agora) e aponta `/hades env onboard`, `$D/onboard.sh pick` e a página Onboarding do painel (`reference/onboard.md`).

#### Fase 2 — conjunto de PRs e branch `hades/local`
**Conjunto de PRs** — `$D/prs.list` (uma entrada por linha), gerido por `$D/prs.sh`:

| Entrada | Efeito |
|---|---|
| `4937` | inclui a PR, mesmo draft ou de outro autor |
| `@me` / `author:<login>` | todas as abertas não-draft do autor |
| `-4964` | exclui (vence qualquer inclusão) |

Sem arquivo = `@me`. O dono passou uma lista ("sobe com a 4937, 4959 e 5012") → `$D/prs.sh set 4937 4959 5012`
(só elas) ou `$D/prs.sh add …` (somar às que já estão no conjunto); conferir com `$D/prs.sh show` antes de aplicar. PR mergeada/fechada
sai com aviso; PR empilhada sobre base fora do conjunto entra com aviso (o merge traz os commits da base). O plantão
acompanha os heads desse mesmo conjunto.

`$D/rebuild-branch.sh` (reset para a base do perfil — `branch.base` > `origin/<flow.base>`, `origin/develop` sem perfil — + merge de cada PR do conjunto, stack desalinhada via cherry-pick, rerere,
depois `fixups.sh`). Conflito novo → resolver à mão **pelo conteúdo** (as duas funcionalidades convivem), commitar,
anotar em `conflicts.log` (par, arquivos, resolução) e seguir. Migration conflitante ou contrato sem resolução
equilibrada → tirar a PR mais nova, anotar e avisar. Detalhes: `reference/branch.md`.

#### Fases 3 a 5 — ambiente, infra, serviços e dados
Do ambiente do projeto: geração dos `.env`, infra docker, migrations, build pela fila do gate-lock (`gl_run build …`),
`svc.sh start`, confirmação de `/health/ready` e carga de dados. Roteiro e comandos em `ref env-phases`; o `run-hades`
os encadeia. Nunca deixar `.env` na raiz do worktree (`ref env-operations`). Arquitetura e portas: `reference/architecture.md`.

#### Fase 6 — processos de apoio, painel, túnel (sob demanda)
- Processos de apoio do projeto (os que o ambiente declara além dos serviços): `ref env-phases` §Fase 6.
- `$D/panel.sh start` → http://127.0.0.1:21220 (`reference/panel.md`): painel do dono para monitorar e operar o
  Hades em tempo real (serviços, infra, processos de apoio, branch/PRs, fila do gate-lock, memória) chamando os mesmos
  scripts do kit. O `run-hades` já sobe o painel; ele fica fora do slice e continua no ar com o Hades pausado.
- Onboarding dos recursos desta fase (túnel, notificações, início do painel, contas): `/hades env onboard` ou `$D/onboard.sh show <feature>` (`reference/onboard.md`); o que é público/sudo/token é do dono.
- Túnel: `tunnel.sh install|create`, o **dono** roda `tunnel.sh login-cmd`/`publish-cmds`, depois `tunnel.sh url`
  e reiniciar os serviços cujo `.env` mudou (`reference/tunnel.md`).

#### Fase 7 — STATUS e plantão
O `$D/STATUS.md` vem do script de status do pacote do projeto, se houver. Plantão: `Monitor` com
`bash $D/watch.sh | grep --line-buffered -E "HEADS-CHANGED|CEDE|GATES-CLEAR|rror"` (30 min, rearmar ao expirar).
- `HEADS-CHANGED` → `$D/update.sh` (ciclo completo; para em conflito novo).
- `CEDE` → `$D/hades.sh pause`; `GATES-CLEAR` → `$D/hades.sh resume`.
Rotina e recuperação de falhas: `ref env-operations`.

#### Fase 8 — pedido fora do escopo (a skill evolui)
Seguir `reference/evolving.md`: resolver no vivo → generalizar no kit → documentar (referência + a tabela "Pedidos típicos do dono" +
`description` se o gatilho mudou) → reinstalar e provar → `kit/skill-release.sh drift` (zero) →
`kit/skill-release.sh release minor|patch "<resumo>"` → completar o `CHANGELOG.md` → entregar versão, caminho e
sha256 do pacote ao dono; se a melhoria é do núcleo e serve a qualquer usuário, `hades contrib suggest` (guarda,
PR com confirmação ou `.html`; `reference/contrib.md`). Defeito de produto encontrado no caminho vai para `notes.md`, não para a skill.

## Pedidos típicos do dono

Pedido do dono → comando e referência, por tema. Na dúvida entre duas linhas, abra a referência citada.

### Ambiente local: subir, PRs, serviços e dados

| Pedido | Como |
|---|---|
| "sobe tudo" · "sobe depois do reboot" · "sobe com as PRs X Y" (dono, sem agente) | `run-hades` (alias) — entrypoint idempotente que faz as Fases 1→7; aceita conjunto de PRs e flags (`reference/run-hades.md`) |
| "atualiza agora" | `$D/update.sh` |
| "inclui/tira a PR N" · "só as PRs A, B, C" | `$D/prs.sh add N` / `remove N` / `set A B C` → `$D/prs.sh show` → `$D/update.sh` |
| "liga/desliga o serviço X" · "sobe o serviço X" | `$D/svc-enable.sh <serviço>` / `--disable <serviço>`, ou o switch no painel. Fica salvo em `$D/services.enabled`; desligado por padrão, só os de `services.required` são obrigatórios (`reference/panel.md` §Serviços sob demanda) |
| "tira um snapshot dos bancos" · "volta o banco de antes do update" · "a migration quebrou" | `$D/snapshot.sh take\|list\|restore <id>\|rm <id>`; o `update.sh` já tira o `pre-update` (`reference/snapshot.md`) |
| serviço novo · carga de dados · processos de apoio do projeto · API como outro usuário · senha de usuário do ambiente | pedidos do ambiente do projeto: `ref env-requests` (cada linha traz o comando; sem `env.pack` não há) |
| "sobe outro projeto ao lado" · "instala o Hades do projeto X sem derrubar o outro" · "quais instâncias tem aqui" | `HADES_ID=<id> HADES_WT=<worktree> ~/.claude/skills/hades/kit/install.sh`: units `hds_<id>-*`, slice `hades_<id>`, compose `hades_<id>`, porta do painel livre; `hades instance list` (`reference/projects.md` §Várias instâncias) |
| "o Hades no Mac" · "painel no macOS" · "launchd" | suportado via launchd: o painel e o vigia sobem como serviço do usuário (`hades panel service`, `reference/adr/0001-gerenciador-de-servico.md`, `reference/architecture.md` §macOS) |
| "os logs estão enormes" · "libera disco" · "rotaciona os logs" · "limpa imagens/pacotes antigos" | `$D/clean.sh status` → `run [--dry-run]` (seguro) / `run --yes images\|releases\|worktrees` (só com o pedido); card Disco no painel; timer `hds-logrotate` (`reference/limpeza.md`) |

### Instalação, diagnóstico e Configurações

| Pedido | Como |
|---|---|
| "filtros do rtk" · "a saída está cortada" · "desliga os resumidores" · "o rtk não filtra" | `hades rtk status` → `apply` (o dono confia: `rtk trust`); Configurações → Resumidores (rtk) ou `HADES_RTK_FILTERS=off`; o agente vê tudo com `rtk proxy <cmd>` / `rtk recall <hash>`, não muda a política (`reference/rtk.md`) |
| "o ambiente não sobe" · "o que falta instalar" · "confere os pré-requisitos" | `$D/doctor.sh` (`--quick`, `--json`; exit 0 ok · 1 erro · 2 avisos) ou `/hades env doctor`; diz o comando que corrige cada item, não corrige sozinho (`reference/doctor.md`) |
| "qual dependência externa falta" · "falta o bun/herdr/gh?" | `hades deps` (`--json` para máquina): gh, docker, herdr, systemctl, devtunnel, git, jq, bun… com como instalar cada uma (`reference/cli.md`); o `doctor.sh` mostra as mesmas |
| "o que falta configurar" · "me mostra o tour de novo" · "prepara as features" · "quero acesso remoto/notificações/início do painel" · "onboarding" | `/hades env onboard`: `AskUserQuestion` (multiSelect) com os recursos, `$D/onboard.sh select\|skip` grava a escolha, `onboard.sh run <passo>` executa só passo da Hades (com ok do dono), os do dono saem como comando (`! ` nos interativos); mesma fonte na página Onboarding do painel (o tour de novo: *Fazer o tour*) e no aviso do doctor; é a primeira etapa de quem instalou e não completou (`reference/onboard.md`) |
| "muda o teto de memória" · "heap dos serviços" · "sobe sem túnel por padrão" · qualquer parâmetro | painel → Configurações, ou `$D/config.sh set K=V` e aplicar (`reference/config.md`) |
| "desliga o segurar para confirmar" · "não quero digitar o nome para confirmar" | Configurações → Painel, só pelo painel local, ou `$D/config.sh set HADES_CONFIRM_HOLD=0` / `HADES_CONFIRM_TYPED=0` (`reference/config.md`) |
| "exporta/importa minhas configurações" · "leva as configurações para outra instalação" · "acha a configuração X" | painel → Configurações (Exportar, Importar, busca), ou `$D/config.sh export [--all]` / `import <arquivo> [--dry-run]` (`reference/config.md` §Exportar e importar, §Busca) |
| "tem versão nova da skill?" · "avisa quando sair versão" | Já avisa sozinho: selo na sidebar e card na Visão geral do painel, linha `versao-nova` no `doctor.sh`, com o comando de atualizar. Só avisa (nunca atualiza); oculto sem acesso ao repo. `hades version-check status --refresh`; chaves `HADES_VERSION_CHECK_*` (`reference/config.md`, `reference/panel.md` §Versão nova, `reference/doctor.md`) |

### Painel e acesso remoto

| Pedido | Como |
|---|---|
| "abre o painel" · "quero ver/controlar o Hades pela tela" | `$D/panel.sh start` → http://127.0.0.1:21220 (`reference/panel.md`) |
| "painel sobe sozinho" · "inicia o painel com a máquina" · "no login" · "sobe o Hades com a máquina" · "sobe sozinho no boot/login" · "o boot falhou" | só o painel inicia sozinho: Configurações → Painel → Iniciar o painel automaticamente, ou `$D/config.sh set HADES_PANEL_AUTOSTART=boot\|login\|off` e `$D/panel.sh autostart`; infra e serviços sobem pelo painel ou pelo `run-hades` (`reference/panel.md` §Início automático, `reference/run-hades.md` §Início automático) |
| "a sidebar do painel não cabe" · "minimiza o menu" | No painel: Ctrl+B ou o botão no topo da sidebar vira trilho de ícones; cabeçalhos de grupo recolhem (`reference/panel.md` §Navegação lateral) |
| "abre o painel de fora" · "acesso remoto ao painel" | `$D/tunnel.sh panel-start`, ou a página Acesso remoto. Só a conta dona do devtunnel entra, e o painel ainda exige a chave (`reference/panel.md` §Acesso remoto); publicar é passo do dono |
| "instala o painel no celular" · "PWA" · "adicionar à tela inicial" | abrir a URL do túnel no celular e instalar (`reference/panel.md` §Instalar como app (PWA)); só funciona por HTTPS (túnel) ou localhost |
| "conversa com o Claude pelo painel" · "abre uma sessão do Claude no celular" · "chat com o Claude" | painel → página **Claude** (ligada por padrão; desliga em Configurações → Sessão Claude, `HADES_CHAT=0`); `claude -p` em auto mode no clone principal, também pelo acesso remoto, que avisa o dono (`reference/panel.md` §Claude) |
| "vê/gerencia o herdr pelo painel" · "o que os agentes do herdr estão fazendo" · "manda um prompt ao agente do finance" · "para a sessão do herdr" | painel → página **Herdr** (grupo Operação, também pelo acesso remoto, que avisa o dono): árvore workspace → aba → pane do herdr, de todas as sessões, saída do terminal, prompt/texto/teclas, renomear, parar/apagar sessão com o nome digitado; log em `$D/logs/panel-herdr.log` (`reference/panel.md` §Herdr) |
| "liga o terminal no painel" · "abre um shell pelo painel" | Configurações → Terminal → `HADES_TERMINAL=1`, só pelo painel local; WebSocket e protocolo em `reference/panel.md` §Terminal |

### Widget e notificações

| Pedido | Como |
|---|---|
| "gera o APK do widget" · "baixar o APK do widget" · "widget no celular" · "widget Android" · "widget novo" · "widget de sistema" · "widget de PRs" | `kit/android/build.sh` (Docker, pela fila de builds) gera `$D/android/hades-widget.apk` (baixar pelo painel: Visão geral (ou Acesso remoto) → App do widget); `build.sh list` lista os widgets e `build.sh new <id>` cria um widget novo no mesmo APK (já vêm Sistema, com memória, infra e fila, e PRs, com CI e review); instalar, configurar e acrescentar widget em `reference/android-widget.md` |
| "token do widget" · "widget do celular" · "atalhos do app" · "o app instalado não tem atalhos" | painel local → Acesso remoto → Token do widget Android (gerar/revogar; aparece uma vez); o widget lê `GET /api/widget` com `Authorization: Bearer`. Atalhos Orquestração, Herdr e Claude vêm do `manifest.webmanifest` (`reference/panel.md` §Widget Android) |
| "o widget não atualiza fora de casa" · "publica o túnel do widget" · "renova o túnel do widget" | `tunnel.sh widget-*`: o agente cria e lê a URL; publicar e renovar são comandos do dono (`reference/tunnel.md` §Túnel do widget) |
| "avisa no celular" · "notificação quando o gate falhar / serviço cair / review chegar" | Configurações → Notificações, ou `$D/config.sh set HADES_NOTIFY=1 HADES_NOTIFY_NTFY=1` + `$D/notify.sh apply`; `notify.sh test` (`reference/notify.md`) |

### Qualidade e Cerberus

| Pedido | Como |
|---|---|
| "mantém as PRs revisadas" · "revisa de 30 em 30 min" · "loop de revisão" · "para o loop de revisão" | `/hades review --loop --every 30m` (processo em segundo plano, estado em `<work>/review-loop/`); `hades review loop stop\|status`; painel → Revisões → Loop de revisão; limite de uso em `HADES_REVIEW_LOOP_PAUSE_*` (`reference/loop/review.md` §7) |
| "liga/desliga regra de qualidade" · "quais regras a Hades aplica" · "sem any" · "boas práticas nos briefs" | painel → Qualidade, ou `hades quality list\|on\|off\|reset`; as ligadas entram nos briefs e nas fases deliver, inbox e review (`reference/quality.md`) |
| "liga/desliga pacote de regras" · "liga as regras de frontend" · "quais pacotes estão ligados" | painel → Qualidade → Pacotes, ou `hades quality packs` e `on\|off --pack <id>`; estado ligado, desligado ou parcial (`reference/quality.md` §Pacotes) |
| "o que o Cerberus barrou" · "libera essa exceção" · "muda o modo da Vigília" | painel → Cerberus (histórico, o que cada guarda barrou, **Abrir exceção**) e Configurações → Cerberus; no terminal, `hades cerberus historico\|excecao listar\|modos`. Exceção e modo só o dono abre e muda, pelo painel local ou com `!` (`reference/cerberus.md`) |
| "o Cerberus barrou o ensaio do plugin" · "o plugin precisa de rede" | painel → Cerberus → Limiar mostra, por script, ensaiado / barrado (motivo) / não ensaiado; para rede declare `ensaio.rede` (`{item, motivo}`) no `plugin.json` do plugin (`reference/cerberus/limiar.md` §plugin-ensaio-isolado); sem `bwrap` é só aviso (`hades deps`) |

### Projeto, perfil e plugins

| Pedido | Como |
|---|---|
| "qual o projeto ativo aqui" · "este repo tem perfil?" · "valida o perfil" | `hades project resolve` (sai 3 sem perfil, 4 fora de repo) e `hades project validate`; formatos em `reference/projects.md` |
| "cria o perfil deste repo" · "a Hades diz que o repo está sem perfil" · "prepara o projeto X para o loop" · "atualiza o perfil" | `/hades project init`: lê o repo, monta o rascunho com a evidência (arquivo:linha) de cada campo, pergunta ao dono o que ficou incerto e grava com o ok (`hades project-init`, `reference/project-init.md`) |
| "adiciona a stack do projeto X" · "o hook barra o comando do meu repo" · "mede o gate" | `/hades stack add`: lê manifests e CI, propõe o pacote, mede o pico pela fila e grava só com o ok do dono (`hades stack-add`, `reference/stacks.md`) |
| "instala/atualiza o plugin do projeto X" · "o plugin pede outro núcleo" | página Plugins do painel, ou `$D/plugins.sh add <url>` / `update <nome>`: prévia do commit e do que executa antes de ativar; a faixa `core` do perfil e a recusa do `install.sh` (`reference/projects.md` §Plugin do Hades) |
| "desliga/remove o plugin" · "religa o plugin" | página Plugins, ou `$D/plugins.sh disable <nome>` / `enable <nome>` / `remove <nome> --confirm <nome>`: desligado sobrevive à reinstalação e mantém as chaves; remover recusa commit não publicado (`reference/projects.md` §Plugin do Hades) |

### Orquestração e agentes

| Pedido | Como |
|---|---|
| "o que o agente X fez" · "diário do agente" · "histórico de ferramentas" · "o agente está esperando permissão?" | `hades journal list` / `tail <agente>` / `show <agente> --since 2h` (`--kind tool\|permission\|gate`); painel `GET /api/journal` (`reference/journal.md`) |
| "grafo dos agentes" · "o que cada agente está fazendo" · "aprova a permissão do agente X pelo painel" · "manda um prompt ao agente pelo painel" | painel → página **Argos** (grupo Hades; grafo, painel do nó ao vivo, ações, Ctrl+K, também pelo celular e pelo acesso remoto) sobre o servidor do Argos: `GET /api/argos/graph`, `GET /api/argos/node/<id>` e `POST /api/argos/action` (`reference/argos.md`). Permissão pendente aparece no nó (`pendingPermission`); `approve_permission`/`deny_permission` (Enter/Escape, só Bash/Edit/Write/NotebookEdit/MCP e herdr `blocked`) |
| "traz esse terminal para o canvas" · "esse pane do herdr não aparece no Argos" · "tira esse terminal do canvas sem matar" · "o orquestrador sumiu do canvas" | `hades canvas join [--pane <id>] [--name n] [--role r] [--to <orquestrador>] [--note <nota>]…` (sem `--pane`, o próprio terminal; só pane do herdr) e `hades canvas leave [--pane <id>]`; terminal do registro volta com nome, agente e a caixa Orquestrador (`reference/argos.md` §Orquestrador no canvas e §Órfãos) |
| "post-mortem do incidente X" · "monta o post-mortem da PR 123" · "o que já quebrou neste arquivo" | `hades thanatos new <PR\|card\|<iso>..<iso>>`, `list\|show\|search`, `cited <arquivo>…`; página Thanatos no painel (`reference/thanatos.md`) |
| "quanto vai custar esse plano" · "estima a unidade" · "quanto custaram as unidades até hoje" | `hades moirai estimate <plan.md> [--write] [--deep]` (seção `## Estimativa` do plano, dentro do hash da aprovação) · `hades moirai history [--json]` (`reference/moirai.md`) |
| "quanto a unidade já gastou" · "passou do estimado?" | a página Consumo (seção *Estimado × real*) e o painel do nó no Argos; o `hades watch` emite `BUDGET <agente> <pct>` ao passar do p75 e grava a pergunta ao dono (seguir, reestimar, estacionar) em `HADES_MOIRAI_ASK_PCT`; `GET /api/moirai/plan` (`reference/moirai.md`) |
| "quanto da janela de 5 h / semanal eu gastei" · "o plano cabe na janela?" · "liga a medida dos limites" | `hades usage` (colunas `% 5h` e `% semana` e o % medido) e `hades moirai estimate` (faixa em % e "cabe na janela atual?"); a medida vem do `statusLine` do dono por `hades usage sample` (`reference/limites.md`: fonte, calibração e como ligar) |
| "deixa o orquestrador decidir sozinho" · "sobe a autonomia" · "o que o orquestrador decidiu sozinho" · "o orquestrador inicia os agentes sozinho" | Configurações → Orquestração → **Autonomia** (slider 0–3) e **Auto-alocação**, só o dono (painel local ou `!`); `hades agent decide <plano> --level-needed N --question … --chosen …` (sai 0 permite, 3 pergunta ao dono) · `hades agent auto-start on\|off\|status` (regra allow `Bash(herdr agent start:*)`); decisões na página Orquestração (`reference/autonomia.md`) |
| "página do Caronte" · "ver a orquestração pronta para levar" | painel, página **Caronte** (grupo Hades): planos e agentes com a prontidão para o pack, prévia do `pack --dry-run`, pacotes, prompt de retomada e os comandos para copiar; **Estacionar** por agente. Pack e unpack ficam no terminal (a senha não passa pelo navegador) (`reference/panel.md` §Caronte) |
| "leva a orquestração para outra sessão" · "empacota o plano para outra máquina" · "estaciona o agente X" | `hades agent park <nome>` (pede o handoff e que pare), depois `hades caronte pack <plano> [--out <arq>] [--with-journal] [--allow <caminho>]… [--dry-run]` (pacote cifrado com senha; senha esquecida perde o pacote) ou, na mesma máquina, `hades caronte brief <plano>` (prompt de retomada) (`reference/caronte.md`) |
| "levar a orquestração para outra máquina" · "abrir o pacote do Caronte" | clone o projeto e `hades caronte unpack <arq> [--work-root <d>] [--plans <d>] [--worktrees <d>] [--clone <d>] [--dry-run]` (senha uma vez; refaz plano, worktrees e registros, agentes `parked`; imprime a retomada por agente) (`reference/caronte.md`) |
| "cria a nota do briefing" · "recruta com nota de andamento" | `hades canvas note new <nome> [--title t] [--text t] [--link-to <recruta>]…` (texto também pela entrada padrão) e `hades canvas recruit --new-note <nome>` (`reference/argos.md` §Orquestrador no canvas) |
| "fecha o agente quando terminar" · "por que o agente não fechou" | o watch fecha sozinho no `DONE` limpo (`DISMISSED`); `HADES_ORCH_AUTO_DISMISS=0` só emite `DISMISS-READY`; condição que falha emite `DISMISS-HELD <motivo>` (`reference/loop/orchestrate.md`) |
| "o que o settings.json está custando" · "por que o agente sem flags está caro" | `hades doctor` (linha `settings-padrao`) e Configurações → Modelos por papel, que mostra o padrão herdado (`reference/doctor.md`) |
| "esse agente está no modelo certo?" · "quanto custou a divergência de modelo" | `hades usage` (coluna modelo, `DIVERGE de X: +US$ N`) e o evento `MODEL-MISMATCH` do watch (`reference/loop/tokens.md`) |
| "acompanha os agentes sem gastar contexto" · "o que cada agente está fazendo" · "espera qualquer agente" | `hades agent status --compact`; `hades wait agents --any` em segundo plano (`reference/loop/orchestrate.md` §4) |

### Evolução da skill

| Pedido | Como |
|---|---|
| algo que a skill não cobre | Fase 8 (`reference/evolving.md`) — termina em `hades-skill-v<versão>.tar.gz` |
| "gera o pacote da skill" | `kit/skill-release.sh release patch "<resumo>"` (ou `check` para só validar). A instalação principal é `git clone` + `kit/install.sh` (README §Instalação); o `.tar.gz` é a alternativa sem git |
| "devolve a melhoria ao repo da skill" · "manda essa evolução para o mantenedor da skill" · "abre PR da skill" | `hades contrib suggest\|prepare\|pr\|html`: só o núcleo, varredura de nome/domínio/segredo; com acesso de escrita prepara a PR e só abre com confirmação, sem acesso grava `~/.claude/hades/contrib/<slug>.html` (`reference/contrib.md`) |
| "publica o acompanhamento da orquestração" · "atualiza a página do acompanhamento" · "gera o HTML offline" | `hades minos publish orquestracao <plano.md> [--html <arquivo>] [--team]` prepara a página (Cerberus antes); você publica o arquivo com a ferramenta Artifact e grava o link com `hades minos link <saída> <url>` (`reference/minos.md`) |
| "lista o que o Minos já publicou" · "abre a página publicada" | `hades minos list` · `hades minos open <saída>` (`reference/minos.md`) |
| "evolui a skill com agentes" · "abre uma unidade da skill" · "limpa as unidades antigas" · "quem está rodando" | `hades agent skill-new <u>` → brief → start do dono → `adopt`/`prompt` → merge → `skill-release.sh release` → `skill-clean --merged`; `hades agent list [--all]` (`reference/loop/orchestrate.md` §Evoluir a própria skill) |

## Parte II — Loop de engenharia

**Orquestrador, não implementação.** Nada aqui reescreve review, gate ou padrão de código: o fluxo
chama o que já existe (`/review-agents`, `code-review-local`, `gh-stack` e as skills de padrão
de código que o pacote do projeto indicar) e adiciona a única coisa que
faltava — **saber em que ponto do ciclo cada PR está e o que fazer a seguir**.

### Onde fica

Nada do loop entra no repositório. Tudo vive fora da árvore de trabalho, para servir qualquer clone:

| Caminho | Conteúdo |
|---|---|
| `~/.claude/skills/hades/reference/loop/` | as referências do loop (mapa abaixo) |
| `~/.claude/commands/hades.md` | o slash-command `/hades` (parsing dos parâmetros) |
| `hades pr-loop-state` | coletor de estado (read-only) |
| `hades review-anchors` · `hades review-record` | âncoras de achado e registro de review |
| `hades gate-lock` (`kit/gate/gate-lock.sh`) | fila de admissão de gate (lint/build/teste), a mesma dos builds do ambiente |
| `hades guard` | hook de toda sessão: barra test/lint/build fora da fila e polling (PreToolUse) e aplica o teto de contexto por papel (PostToolUse) |
| `hades wait` | esperas que notificam (CI, gate, fila, merge, review, resposta, agente), sempre em segundo plano |
| `hades usage` · `hades models` | consumo de tokens por papel/agente/dia (painel → Consumo) e modelo dos subagentes de review |
| `~/.claude/hades/work/<owner>__<repo>/` | estado, locks, checklists e relatórios (outra raiz: `HADES_WORK_ROOT` ou uma linha em `~/.claude/hades/work-root`) |
| painel → páginas **Loop** e **Fila de gates** | escalações, entregas, ações, PRs, agentes, locks e a fila ao vivo |

Mapa de `reference/loop/`:

| Arquivo | Quando ler | Quem lê |
|---|---|---|
| `deliver.md` · `inbox.md` · `review.md` · `cascade.md` · `consolidate.md` · `ops.md` | ao rodar o modo do mesmo nome (`ops.md`: `locks`, `answer`, `ready`, `watch`, `resume`) | a sessão do loop |
| `gates.md` · `collector.md` · `report.md` | antes de qualquer modo que escreva (lista abaixo) | a sessão do loop e o agente alocado |
| `tokens.md` | ao escolher modelo, esforço, teto de contexto e espera | todos |
| `orchestrate.md` · `plan-template.md` · `brief-template.md` · `brief-skill-template.md` | ao orquestrar: plano, brief de agente, brief de unidade da skill | o orquestrador |
| `roles/<papel>.md` | cartão curto de cada papel (spec, impl, consolidate, review, orchestrator): o agente lê o cartão, não a skill inteira | o agente alocado |
| `skill-dev-contract.md` | ao evoluir a própria skill numa unidade | a unidade da skill |

**O estado é por repositório, não por clone.** Dois clones do mesmo repo compartilham o mesmo diretório
de estado — uma thread triada num clone não se repete no outro. As contrapartidas são três, todas em `reference/loop/gates.md`: o
**lock por PR** (§3.1), que impede duas sessões de trabalhar a mesma PR; a **fila de admissão de
gate** (§3.2), que impede as sessões de somar mais memória do que a máquina tem — uma fila FIFO
global, orçamento de 8 GB, **um** gate pesado (teste unitário ou de integração) por vez e teto de
memória por gate; e o **estado shardado por PR** (§4),
que impede uma sessão de sobrescrever o registro da outra.

Se algo de estado, lock, checklist ou relatório de execução precisar ser escrito dentro do repo, é
bug: reporte em vez de escrever.

### Projeto ativo
O projeto ativo é o repo do diretório atual: `remote.origin.url` → perfil em `~/.claude/hades/packs/<projeto>/profile.json`
(`hades project resolve`). O coletor, o `hades agent` e o hook leem dele base, CI, bot, códigos de
regra, card e conta do gh. Sem perfil o loop recusa e aponta `/hades project init`; o hook aplica só as regras da
máquina (fila de gates, polling, teto de contexto). Formatos, resolvedor e o que o pacote contém: `reference/projects.md`.

**Regras do projeto.** O núcleo descreve princípios; o texto específico (fluxo de entrega, gates, invariantes,
vocabulário de severidade, spec) mora no pacote e o perfil o declara em `refs`. Antes de agir, leia o que o perfil tem:
`hades project ref invariants|deliver|gates|review|spec` (sai 3 se o perfil não declara; então vale só o núcleo).
O texto do pacote vence o esqueleto do núcleo onde divergir, e nunca os invariantes de segurança abaixo. Nos references
do loop, `ref <nome>` abrevia `hades project ref <nome>`.

### Pré-condições (verificar antes de qualquer ação)

1. `gh --version` responde. Sem isso, pare e instrua https://cli.github.com/.
2. `hades project resolve` → o perfil do repo alvo (`identity.repo`). Sem perfil, pare e aponte
   `/hades project init`.
3. Raiz via `git rev-parse --show-toplevel`. **Nunca** assumir caminho de thread — resolver sempre.
4. Toda leitura de `gh` usa `--json` / `--jq`. A saída textual é reescrita pelo hook `rtk` e perde
   campos (medido: `gh pr checks` volta como resumo agregado, sem nome de check nem URL).
5. Coletor com `exit != 0` **aborta o tick**. Erro não é resultado vazio: sem coleta válida, o loop
   não sabe o que está acionável e não deve escrever nada (`reference/loop/collector.md` §"Falhas").

### Modos

Modos, invocações e flags: a tabela canônica em [Comando `/hades`](#comando-hades).

Sem modo explícito, o default é **`inbox` primeiro**; `deliver` só entra **se o inbox não encontrou
nada acionável** neste tick. Review recebido tem prioridade sobre trabalho novo, e um tick escreve em
uma PR só. Um pedido que nomeia o modo vale mais que o default.

Leia antes de rodar qualquer modo que escreva algo:

- **`reference/loop/gates.md`** — contrato de gate, guarda de push, locks (por PR e por recurso), esquema
  de estado, commits, ondas de correção e ritmo sob `/loop`.
- **`reference/loop/collector.md`** — flags, saída, avisos de truncamento e semântica de falha do
  `hades pr-loop-state`.
- **`reference/loop/report.md`** — o formato único de relatório que todos os modos usam.

### Máquina de estados por PR

Produzida por `hades pr-loop-state` (`--json` para consumir). Um estado por
PR, na ordem de prioridade abaixo — **o primeiro que casa vence, e esta ordem é a mesma implementada
no coletor (`CLASSIFIERS`)**. Divergência entre esta tabela e o código é defeito, não documentação
velha.

| Estado            | Condição                                                         | Ação                                                                |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ci-red`          | algum check falhando                                             | Consertar o CI antes de qualquer outra coisa                        |
| `conflict`        | `mergeStateStatus: DIRTY` / `mergeable: CONFLICTING`             | Cascata #2; conflito não trivial **escala ao dono**                 |
| `needs-response`  | achado vivo, comentário top-level humano, ou review não visto    | Modo inbox                                                          |
| `needs-triage`    | só achados a triar (outdated, não resolvidos)                    | Fase 0 do inbox                                                     |
| `stale-base`      | `mergeStateStatus: BEHIND`                                       | Cascata #2 (merge da base)                                          |
| `draft`           | `isDraft`                                                        | Nenhum job de CI roda: reportar e sugerir `ready_for_review`        |
| `ci-running`      | check pendente                                                   | Observar (`watch`), não reprocessar                                 |
| `awaiting-review` | sem review posterior ao último push                              | Provoca o bot do perfil se a base é a do CI; senão publica o review local |
| `no-ci`           | nenhum check existe (base fora das do CI, ou CI nunca disparou)  | Só o gate local responde — **nunca reportar como pronta**           |
| `done-pending`    | `unresolved == 0` + review posterior ao push + checks **verdes** | **Para e reporta** — merge é manual                                 |
| `needs-attention` | sobra: pendência que só o humano destrava                        | Reportar o que espera resposta e parar                              |

Os predicados que sustentam a tabela, e por que são assim:

- **achado vivo** = `isResolved=false AND isOutdated=false AND` veredito não terminal. Em repo onde
  ninguém resolve thread (`resolvedBy: null` em praticamente tudo), então `isResolved` sozinho faria
  o loop reprocessar o que já foi corrigido. `isOutdated` é o sinal que converge.
- **achado a triar** = `isResolved=false AND isOutdated=true`. O código mudou naquelas linhas depois
  do comentário; se ainda vale, só a verificação contra o código atual diz.
- **esperando reviewer** = thread com veredito `rebutted` ou `indeterminate`. Conta como pendente
  (bloqueia `done-pending`, porque quem fecha refutação é o humano) e **não** volta para a fila de
  ação, senão o loop repergunta a cada tick. Resposta do reviewer posterior ao veredito reabre.
- **comentário top-level** = o único lugar onde vive o resumo do bot do perfil (que posta com
  `gh pr comment`) e todo achado fora de hunk. Comentário de humano é acionável; o resumo do bot é
  informativo e sai em `ciReviewSummary`.
- **review não visto** = review com `submittedAt` maior que o `committedDate` do `headRefOid` **e**
  maior que o `lastSeenReviewAt` do estado. Sem a segunda metade, um approve sem comentário deixa a
  PR acionável para sempre. `pushedDate` foi depreciado e volta `null`.
- **check verde** = existe check e nenhum falhando nem pendente. **Ausência de check não é verde**: o
  CI do perfil (`flow.ci`) só dispara nas bases que ele declara e não roda em draft.

**`reviewDecision` não é gate de conclusão.** PR `APPROVED` com thread aberta é comum aqui. O gate é
`unresolved == 0` + review posterior ao push + check verde de verdade.

### Invariantes de segurança (não destraváveis)

Não cedem a pedido na invocação. Se o dono pedir um destes, responda o que a regra protege e o que
dá para fazer no lugar; se ele reafirmar, ele executa a ação, não o loop.

- **Nunca faz merge.** O fluxo para em `done-pending` e reporta. Merge é decisão do dono.
- **Nunca pusha sem conferir `git rev-parse --abbrev-ref @{upstream}` contra o `headRefName` da PR.**
  Há branches locais rastreando a branch errada; push cego escreve na PR de outra pessoa.
- **Nunca pular hook do repo** (`--no-verify` e equivalentes), nunca `--force`/`--force-with-lease` em branch sob
  review. O que o hook pula e o que o push não compensa estão em `reference/loop/gates.md` §2.
- **Nunca enfraquecer teste para passar**: sem `skip`/`xit`, sem asserção removida, sem budget
  elevado.
- **Nunca declarar como verde um gate que não rodou.** Inclui a saída `75` do `gate-lock.sh`, que é
  gate **enfileirado**, não gate aprovado (`reference/loop/gates.md` §3.2).
- **Nunca resolver thread** cujo achado foi refutado ou cuja verificação ficou indeterminada.
- **Nunca `gh pr review --approve` / `--request-changes`.** Publicação de review sai como
  `event: COMMENT`.
- **Nunca editar à mão arquivo gerado** nem rodar comando destrutivo de banco: a lista do projeto vem de
  `refs.invariants`.
- **Nunca commitar com trailer de co-author.**
- **Card é obrigatório quando o perfil o exige** (`card.required`): toda unidade nova tem card **antes** de a
  branch existir. Card indisponível é **escalação**, não fallback: sem card, o tick não cria branch nem commit.
  Perfil sem `card.provider` trabalha sem card (`reference/loop/deliver.md`).
- **Nunca escrever estado, lock, checklist ou relatório de execução dentro do repositório.**

### Defaults (destraváveis por pedido explícito na invocação)

Valem sempre, mas cedem a um pedido explícito — que **deve aparecer no relatório** como decisão do
dono, com a consequência declarada:

- **Tokens** (Configurações → Modelos por papel, Contexto e espera; `reference/loop/tokens.md`): modelo e esforço por
  papel; sessão nova por fase; teto de contexto por papel aplicado por hook; nenhuma espera por polling (o hook barra;
  esperas pelo `hades wait` em segundo plano); estacionar com `handoff.md` antes de esperar longe.
- **Modo orquestrado** (`--orchestrated`): o agente só roda a checagem de tipos, e o gate roda uma vez, no ponto de
  consolidação ou no topo da stack, só com o que o diff afeta (`reference/loop/gates.md` §1.0). As faixas do projeto
  valem fora dele.
- **Lint, build e teste rodam em sequência**, um projeto e um comando por vez. Nunca em paralelo
  dentro da sessão.
- **Todo comando de gate passa por `gate-lock.sh run`** (`reference/loop/gates.md` §3.2) — inclusive checagem
  "rápida" que chama o gerenciador de build por baixo (um script de lint pode ser um teste). Rodar fora do wrapper fura
  a fila **e** a conta de memória das outras sessões: o que a máquina tem de RAM não escalona como
  CPU, e o excesso vira travamento, não lentidão. Gate de vários passos vai numa concessão
  `run gate`. Só faz sentido destravar quando o dono afirma que não há outra sessão rodando.
- **Regras de código e de comentário do projeto** (`refs.invariants`/`rules.docs`): o loop não gera o ruído que ele
  existe para eliminar e não narra o próprio fix.
- **Uma PR por tick** nos modos que escrevem.
- Subagentes só em quatro lugares: fan-out pré-PR (`/review-agents`), ondas de correção por arquivos
  disjuntos, o re-review único do inbox, e o paralelo do modo review. Em nenhum outro ponto.

#### Overrides declarados

Skill de review avulsa que diga "push nunca" ou mande publicar com `--approve`/`--request-changes` **perde para esta
no seu escopo**, por decisão explícita do dono: push na branch de trabalho é autorizado, e publicação de review sai
sempre como comentário (`event: COMMENT`), nunca aprovando nem rejeitando. Merge segue manual. Overrides de skill de
card (criar sem confirmar) vivem no pacote (`refs.invariants`).

### Precedência de regras

Do mais forte ao mais fraco. Em conflito, o de cima ganha:

1. Os invariantes de segurança acima (os do núcleo e os de `refs.invariants`).
2. Pedido explícito do dono na invocação — sobrepõe os defaults, nunca os invariantes.
3. As regras do projeto, na ordem de `rules.docs` do perfil (vocabulário de severidade e formato de saída primeiro).
4. O padrão do arquivo vizinho — **o mais fraco de todos**. Regra documentada vence código existente;
   um mau exemplo no contexto não autoriza reproduzi-lo.

### Quando parar e perguntar (regra de escalonamento)

Traga ao dono, com o problema claro e alternativas descritas, antes de implementar:

- Impacto de performance, carga, concorrência ou volume de dados.
- Pedido de review que **contraria** regra documentada, ou que exige mudar contrato/spec aprovada.
- Conflito de merge não trivial, ou dois reviewers pedindo coisas incompatíveis.
- Quebra de contrato público sem caminho aditivo, migration com lock pesado ou qualquer coisa que peça janela de
  deploy (os casos do projeto estão em `refs.invariants`).

O resto do trabalho continua enquanto a pergunta espera: o que não depende da resposta é entregue.
A escalação vira registro em `escalations` e volta em todo relatório até ser respondida — a resposta
se registra com o modo `answer` (`reference/loop/ops.md`), para não reperguntar no tick seguinte.
