# Pedidos típicos do dono

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
| "no verdict" · "hook changed this call" · "Bash voltou no auto mode" · "o rtk reescreveu o comando" | uma chamada Bash por resposta ou `rtk <cmd>` já reescrito (`reference/loop/tokens.md` §Reescrita do rtk) |
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
