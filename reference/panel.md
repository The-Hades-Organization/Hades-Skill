# Painel do Hades (`panel/`, unit `hds-panel`)

Tela do dono para **monitorar e operar** o Hades em tempo real: http://127.0.0.1:21220 (`HADES_PANEL_PORT`; uma instância
a mais ganha outra porta livre). Os nomes de unit, slice, projeto compose e túnel citados aqui são os da instância original; numa instância com `HADES_ID`
o prefixo vira `hds_<id>` e o slice/projeto `hades_<id>` (`reference/projects.md` §Várias instâncias).

```bash
$D/panel.sh start|stop|restart|status|url|autostart     # o run-hades já sobe o painel (passo 10)
```

O painel tem três partes:
- **Servidor:** `src/panel/` em TypeScript (`hades panel serve`, `Bun.serve`; a unit sobe `$D/hades-ts.sh panel serve --port <porta>`, e a CLI vem da skill, `HADES_SKILL_DIR`). Amostra o ambiente a cada 3 s e guarda 1 h de histórico.
- **Tela:** `kit/panel/ui/`, em React + htm + lucide-react + Tailwind (navegador), no estilo do shadcn/ui. As bibliotecas e as fontes (Figtree no texto, Marcellus no h1 da página e na marca, Geist Mono no código e nos caminhos) ficam em `ui/vendor/`, então não há build nem node.
- **Fila de gates:** `src/panel/gatewatch.ts`, o amostrador da fila (ver §Fila de gates).

A unit fica **fora** do slice `hades` (~40 MB): não conta no teto e segue no ar com o ambiente pausado. Log em `$D/logs/panel.log`; a porta vem de `HADES_PANEL_PORT` (Configurações → Painel).

## Índice

**Usar o painel:** §Início automático · §Páginas (§Navegação lateral, §Topo) · §Ações · §Visão geral (§Versão nova, §Disco, §Serviços sob demanda) · §Seletor de PRs · §Loop · §Orquestração · §Revisões · §Fila de gates · §Consumo · §Claude · §Herdr · §Notificações · §Acesso remoto · §Cerberus · §Thanatos · §Tour por página · §Caronte · §Onboarding · §Página Plugins · §Instalar como app (PWA)

**APIs e contratos:** §API do diário · §API do Argos · §Terminal · §Widget Android (§Baixar o APK) · §Plugin: páginas, rotas e ações (§Host do plugin) · §Segurança local

**Desenvolver a tela:** §Estrutura da tela · §Tema e ícone · §Layout no celular (390 px) · §Tipografia · §Linguagem de componentes · §Select · §Componentes do painel (fx) · §Armadilhas

## Início automático

`HADES_PANEL_AUTOSTART` (Configurações → Painel → "Iniciar o painel automaticamente"; aplicar é na hora):

| Valor | Efeito |
|---|---|
| `off` (padrão) | o painel só sobe com o `run-hades` (passo 10) ou o `panel.sh start` |
| `login` | `systemctl --user enable hds-panel`: sobe quando o usuário entra na sessão |
| `boot` | `enable` + `loginctl enable-linger $USER`: o systemd do usuário sobe com a máquina, sem login. No macOS não existe linger: `boot` sobe no login, como `login` (o doctor avisa) |

- A unit é persistente (`~/.config/systemd/user/hds-panel.service`, `WantedBy=default.target`), regravada pelo `panel.sh start`/`autostart` com a porta, o `PATH` do shell que aplicou (docker, gh, node do nvm) e os caminhos de `$W`/`$D`. Mudou a porta ou o node: reinicie o painel para regravar.
- **macOS (launchd):** `panel.sh` é um wrapper de `hades panel service <verbo>`. O serviço é `com.hades.hds.panel`; o plist fica em `~/Library/LaunchAgents` quando o início automático é `login` ou `boot` (sobe no login, `RunAtLoad`) e em `~/.claude/hades/launchd` quando é `off`. `panel.sh status` diz "no login do usuário" ou "desligado"; sem `/proc`, o amostrador lê `sysctl` e `ps` (`src/panel/system.ts`).
- O linger é do `linger.sh sync`, só do painel: liga se `HADES_PANEL_AUTOSTART=boot`, e só desliga se foi o Hades que ligou (marca `$D/linger.mine`, antes `panel-linger.mine`) e o painel não o pede mais; linger já ligado por outro motivo fica.
- No boot só o painel sobe sozinho; o resto do Hades (infra, serviços) continua parado até alguém pedir pelo painel.
- `panel.sh status` mostra o modo efetivo ("desligado", "no login do usuário", "com a máquina (linger)").

## Páginas

| Página | O que mostra | O que faz |
|---|---|---|
| Visão geral (§Visão geral) | a frase de estado com o número que importa; leituras de serviços, memória do slice, infra e erros; **Agora** (o que está rodando: execuções, gates e agentes, com o fio de cada um); **Atenção**; **Última hora** (memória ou saúde); **Ambiente** em gavetas: endereços, diagnóstico e disco | subir (`run-hades`), retomar ou atualizar (a ação primária muda com o estado), pausar, dados, STATUS; gaveta **Diagnóstico**: "Rodar" (`doctor.sh --json`, `reference/doctor.md`) |
| Branch e PRs (§Seletor de PRs) | a base remota (commits novos, último fetch), branch atual, PRs aplicadas | fetch; escolher só a base ou a base + PRs |
| Loop | escalações, entregas, ações em 24 h, PRs, agentes e locks (`reference/loop/`) | só leitura |
| Orquestração (§Orquestração) | agentes do orquestrador, perguntas ao dono, relatórios, PRs de consolidação e as decisões autônomas | ver a seção; Abrir terminal por agente (shell na worktree dele) |
| Revisões (§Revisões) | a frase de estado (rodando, publicadas, custo), as revisões em curso, seletor de PRs, histórico das 20 últimas: PR, comando, modelo · esforço, estado, veredito 🔴/🟡/in-line, publicado, custo e duração | revisar até 6 PRs com `/review-pr` ou `/review-agents`, Opus/Sonnet, esforço low/medium/high, publicar ou não; abrir relatório e execução |
| Fila de gates (§Fila de gates) | a fila do gate-lock em detalhe | — |
| Consumo (§Consumo) | tokens por papel, agente e dia, a linha de base e o Estimado × real | ver a seção |
| Claude (§Claude) | conversa com o Claude Code no clone principal, em streaming | enviar, parar, nova sessão, apagar do registro; ligada por padrão (`HADES_CHAT`) |
| Herdr (§Herdr) | terminal de verdade no navegador (abas, lado a lado; §Terminal) e workspaces e agentes do herdr da máquina inteira, de qualquer sessão, dentro ou fora do Hades | abrir/fechar sessões de terminal, prompt, texto, teclas, renomear agente, parar/apagar sessão, criar/renomear/fechar workspace, aba e painel, dividir painel, iniciar agente |
| Execuções | ações do painel, com log ao vivo (§Ações) | interromper; Abrir terminal (shell na pasta da execução, só dentro das raízes do terminal) |
| Logs | serviços, builds e ciclos, processos (units), containers, documentos | filtrar, seguir, copiar; log de serviço parado que ainda não existe oferece Subir; tour de seis passos sem prévia (`ui/pages/logs.tour.tsx`) |
| Notificações (§Notificações) | o vigia `hds-notify` e as 50 últimas notificações | ver a seção |
| Acesso remoto (§Acesso remoto) | túnel do painel, chave de acesso e token do widget Android (§Widget Android) | publicar, parar, reler URL, trocar a chave, gerar/revogar o token do widget |
| Argos (`reference/argos.md` §A página) | grafo dos agentes (permissão pendente, parados), detalhe do nó ao vivo e ações; funciona no celular; API em §API do Argos; tour (`ui/pages/argos.tour.tsx`, abre pelo "Tour desta página" da paleta, sem prévia) | prompt, retomar, fase, responder, escalar, aprovar/negar permissão, encerrar (com o nome); estacionar os selecionados em lote (confirma antes); botão direito no nó com as ações, mensagem pelo balão no nó, aprovar/negar na caixa sob o nó e minimapa |
| Cerberus (§Cerberus) | as três cabeças com o modo e as guardas, o que cada guarda barrou, exceções e o histórico de vereditos | abrir exceção (só pelo painel local) |
| Thanatos (§Thanatos) | os post-mortems do projeto, com leitura do `.md` | só leitura |
| Caronte (§Caronte) | planos de `~/.claude/hades/plans` com os agentes e a prontidão para o pack (estacionado, encerrado ou trabalhando, e o comando que falta), prévia do `pack --dry-run`, pacotes em `HADES_CARONTE_OUT_DIR`, prompt de retomada e os comandos `pack`/`unpack` | **Estacionar** por agente (`hades agent park`), copiar prompt e comandos; nada de pack nem unpack, a senha fica no terminal |
| Onboarding (§Onboarding) | os recursos a preparar, com o estado e o comando de cada passo; tour da página (`onboard.tour.tsx`, sem prévia) | escolher/pular recurso, executar passo da Hades, marcar manual, verificar de novo |
| Plugins (§Página Plugins) | um card por pacote de plugin; tour com prévia de dois pacotes de exemplo (`plugins.tour.tsx`) | adicionar, atualizar, ligar/desligar, remover (só localmente) |
| Qualidade (`reference/quality.md`) | catálogo global de regras de qualidade por grupo, com o estado de cada uma e os conflitos com o projeto; tour sem prévia (`quality.tour.tsx`) | ligar/desligar regra, grupo ou tudo, voltar ao padrão (grava `~/.claude/hades/quality/choices.tsv`); cartão Pacotes: interruptor por pacote, selo Ligado/Desligado/Parcial e filtro por pacote |
| Configurações (`reference/config.md`) | todo parâmetro do `config.tsv`, por grupo, com o padrão e o modo de aplicar; tour sem prévia (`config.tour.tsx`) | salvar no `config.env`; aplicar teto no slice, reiniciar serviços ou painel, o modo que o plugin declarar (`panel.applies`), aplicar início automático (painel) e subida automática (`boot.sh apply`, só pelo painel local); **Exportar** e **Importar** (prévia do diff em diálogo, grava pelo mesmo `POST /api/config`); busca fixa no topo com `/` e filtros (`#/config?q=…&f=alt,falta`) |
| Documentação | esta skill inteira: SKILL.md, referências, changelog, com subabas e tópicos; leitura em medida de 68ch, documento longo em seções que só pintam perto da tela, botão Copiar nos blocos de código (design em `DESIGN.md`); tour sem prévia (`docs.tour.tsx`) | — |

- **Páginas do plugin** entram na sidebar do grupo que declaram e não têm linha fixa aqui: §Plugin: páginas, rotas e ações
  (as do ambiente instalado: `ref env-extensions`; o que o ambiente do projeto acrescenta, em `reference/projects.md`).
- **Ctrl K** abre a busca de ações (navegação, ciclo, reiniciar e logs por serviço). O grupo "Ir para" lista todas as
  páginas mesmo antes do primeiro snapshot (só Ambiente e Serviços esperam por ele). A busca casa todos os termos em
  grupo, nome e `desc` da página, sem acento (`cfgNorm`): "post-mortem" acha o Thanatos, "tunel" acha o Acesso remoto.
- **No Argos** o Ctrl K abre a paleta da página, com as mesmas páginas no grupo "Painel" e a mesma busca pela descrição.

### Navegação lateral
- **Grupos** (`CORE_GROUPS`; cabeçalho clicável, `aria-expanded`, Enter/Espaço): Ambiente (Visão geral, Branch e PRs, e as páginas do plugin que pedirem esse grupo), Loop (Loop, Orquestração, Revisões, Fila de gates, Consumo), Operação (Claude, Herdr, Execuções, Logs, Notificações, Acesso remoto), Hades (Argos, Cerberus, Thanatos, Caronte) e Sistema (Onboarding, Plugins, Qualidade, Configurações, Documentação). Argos, Cerberus, Thanatos, Caronte e Herdr levam um subtítulo de função sob o nome (campo `sub` do `CORE_NAV`). A lista plana `CORE_NAV` segue valendo para rota e paleta de comandos.
- **Hades:** grupo logo depois de Operação, com Argos, Cerberus, Thanatos e Caronte, nessa ordem (o grupo Fronteiras deixou de existir; plugin que declare `group: 'fronteiras'` cai num grupo novo antes de Sistema). Argos e Caronte têm ícone próprio em SVG `currentColor` (os seis olhos e o anel com a meia-lua), usado na sidebar, no trilho e na paleta Ctrl+K.
- **O rio:** uma linha fina desce pelo trilho, atrás dos ícones, com uma correnteza de metal (parada com movimento
  reduzido). O **óbolo** (moeda de metal) marca a página aberta e desliza até a nova na troca. Onde há atividade, um
  **ponto vivo** (`--vivo`) desce do topo do rio até o item e fica pulsando; um ponto âmbar marca o que espera o dono.
- Grupo fechado com atividade (fila com gates, execução rodando) mostra um ponto no cabeçalho. O grupo da página aberta reabre sozinho ao navegar.
- **Rolagem:** marca no topo e card do slice no rodapé ficam fixos; só a área dos grupos rola.
- **Trilho:** o botão do topo da sidebar ou **Ctrl B** minimiza para 64 px (só ícones, nome no tooltip, ponto no lugar do badge, barra vertical do slice). Só no desktop (`md:`); a gaveta do celular é sempre expandida.
- **Páginas stage** (`registerPage(..., { stage: true })`, hoje a Argos): sem cabeçalho nem padding, trilho forçado em 64 px sem gravar `panel-sidebar-min`, fio global sobreposto e `h1` só para leitor de tela. No celular a gaveta de navegação segue normal (`openNav` no contexto da página).
- O estado (trilho e grupos fechados) fica no `localStorage` do navegador: `panel-sidebar-min` e `panel-sidebar-closed`. Não vai para o servidor nem para outro navegador.

### Topo
Uma frase de estado (ponto + "Parcial · 3 rodando · 1 na fila · 1 espera por você", `StateLine`) e, colado embaixo do
topo, o **fio global** (`FioGlobal`): um fio por coisa viva, cada um link para a página dela. A fonte das duas é
`liveThreads(d)` (execuções rodando ou que falharam nos últimos 10 min, gates, agentes do herdr trabalhando); a Visão
geral lê a mesma lista. Nada vivo: um fio parado de 1 px.

## Ações

Cada botão chama o **script do kit instalado** como unit transitória `hds-pjob-<id>`, fora do slice. O log e o código de saída ficam em `$D/logs/panel-jobs/`. A unit sobrevive a um restart do painel; "Interromper" faz `systemctl --user stop`.

**Ambiente que o job herda:** a unit transitória (e a do chat) começa de um ambiente vazio e o gerenciador de serviço lhe daria o
`HOME` dele, não o do painel. Por isso o painel passa o próprio `HOME`, o `PATH`, `HADES_WT`, `HADES_DATA` e as variáveis de
instância que o `env.sh` exporta (`HADES_ID` e o que o `config.sh` deriva dele: `HU`, `HSLICE`, `HPROJ`). Numa instância com outro
`HOME` o job lê e grava o dela, nunca o `~` real; na original os valores são os de sempre. `hades svc run` leva o `HOME` de quem o
rodou (um `--env HOME=…` vence). Código: `src/lib/systemd-run-env.ts`.

**No macOS (launchd):**
- **Job:** um plist por job em `~/.claude/hades/launchd` (`com.hades.<HU>.pjob-<id>`, `StandardOutPath` no mesmo log, sem
  `KeepAlive`), carregado com `launchctl bootstrap`. "Interromper" faz `bootout` e apaga o plist.
- **Recolher:** o launchd não recolhe sozinho: quem terminou deixa o plist e o serviço carregado, e a listagem do painel
  (a cada 3 s) e o `clean.sh run` os recolhem (`collectFinished`, só plist com mais de 10 s).
- **Chat:** igual, com `StandardInPath` no arquivo `.in` da mensagem.
- **Amostrador:** lê as units por `launchctl list/print` e a memória e a CPU somando a árvore de processos do `ps`
  (`src/lib/service-manager-launchd-stats.ts`). Não há slice: o painel mostra a soma da memória das units ativas, sem teto.
- **Log:** o de uma unit (`unit:<nome>`) é o arquivo que o plist declara, não o journal.

Ações de ciclo não rodam em paralelo: o servidor recusa com 409 se outra estiver rodando, ou se houver um script da skill
vivo vindo de outro lugar (terminal, agente), detectado no `/proc`.
- **São de ciclo:** subir, atualizar, pausar, retomar, dados, infra, ligar serviço, seleção de PRs e fetch.
- **Não é de ciclo:** `doctor` (card Diagnóstico): roda `doctor.sh --json` e grava `$D/doctor.json`.

Tour da página Execuções (§Tour por página): oito passos (a página, resumo, histórico, a execução escolhida, abrir terminal, interromper, o fio e o
log); sem prévia, porque o log é lido de uma execução real por id; os passos que dependem de execução ou de tela larga levam
`fallback`. Código: `ui/pages/jobs.tour.tsx`.

## Visão geral

Página **Visão geral** (grupo Ambiente): o que ela mostra e faz está na linha da tabela de §Páginas. Os cards abaixo são dela.

Tour da página (§Tour por página): onze passos (o cabeçalho, espera por você, estado e ações, leituras, Agora, Atenção, Última hora e as gavetas Endereços, Diagnóstico e Disco), na tela real, sem prévia (a página sempre tem o snapshot). Código: `ui/pages/overview.tour.tsx`.

### Versão nova

Quando a `VERSION` do branch padrão do repo da skill (`HADES_VERSION_CHECK_REPO`, lida por GET anônimo e, de reserva, pelo `gh api`) é maior que a
instalada, o painel mostra um selo discreto no pé da sidebar (ícone no trilho) e o card **Versão X disponível** no topo da
Visão geral, com o comando de atualizar e botão de copiar. Sem botão que atualize, sem download e sem `notify.sh`. Vem em
`snapshot.versionCheck` (`enabled`, `access`, `local`, `remote`, `update`, `command`): lê só o cache e, vencido o
intervalo, a consulta corre numa thread, nunca na amostragem. Sem acesso ao repo, com a checagem desligada ou em dia,
nada aparece; o motivo vai só ao log do painel (`repositório não encontrado ou privado (HTTP 404)`, `sem rede para o GitHub`, `timeout`,
`gh ausente`…). O repo da skill é público: a consulta não precisa de `gh` nem de login (GET em `raw.githubusercontent.com`). O `gh` só
entra de reserva (conta ativa) ou, sozinho, com a conta de `HADES_VERSION_CHECK_GH_USER` preenchida; nunca `HADES_GH_USER`, que é a conta do projeto.

### Disco

Card **Disco** na Visão geral (`GET /api/disk`, `clean.sh status --tsv`, cache de 60 s): uso por categoria e o que libera. **Rotacionar agora** e **Limpar (seguro)** (`action: clean`, `op: rotate|run`) e **Apagar…** em imagens, pacotes de release e worktrees de agente (`op: yes`, `cat`, só no painel local). Todos abrem a confirmação com a prévia de `GET /api/disk/preview` (o `clean.sh` em simulação). Configurações → Limpeza tem a política e o botão **Aplicar o timer de limpeza** (`config-apply` `op: logrotate`). Detalhes em `reference/limpeza.md`.

### Serviços sob demanda

- **Catálogo:** `services.tsv` do ambiente do projeto (`<pacote>/env/`), uma linha por serviço; o `svc.sh` e o painel leem dele.
- **Ligados:** `$D/services.enabled` (persistido). Tudo começa desligado, menos os de `$D/services.required` (o painel não deixa desligar). Na primeira chamada, o `svc.sh` migra o `services.disabled` antigo.
- **Ligar / desligar:** ações `svc-enable` do núcleo, que chamam `svc-enable.sh [--disable] <serviço>` do ambiente do projeto. O que ele prepara (Redis, banco, `.env`, migrations, build pela fila, rota, `/health/ready`) é do ambiente: `ref env-extensions` §Serviços sob demanda (`reference/projects.md`).
- **Listas fixas:** quem reinicia uma lista fixa de serviços (passo do túnel, `after-build.sh`) passa por `svc.sh enabled-only`, para não ligar um serviço desligado.

## Seletor de PRs

O seletor da página **Branch e PRs**.

- **Busca:** `gh api search/issues` com `repo:… is:pr is:open`, filtro por autor (`@me`, todas, login, autores recentes), texto no título e drafts. Pagina no próprio GitHub (15 por página).
- **Cache:** 5 min, em memória e em `$D/logs/panel-cache/github.json`. Trocar de página ou de autor e voltar não gasta requisição. "Recarregar do GitHub" ignora o cache. Se o GitHub falhar, o painel mostra o último resultado, marcado como vencido.
- **Salvar:** grava o `prs.list`. "Só a base" grava `-0`, como o `run-hades develop`; com PRs, chama `prs.sh set <números>`, e a seleção substitui as entradas `@me`/`author:` que houver. "Salvar e atualizar" roda o `update.sh` em seguida. Uma PR empilhada traz a stack abaixo dela (`hades pr-set`).
- **Fetch:** abastece o cache de credencial do git com o token do `gh` (como o passo 1 do `run-hades`) e roda `git fetch origin --prune`. Mostra quantos commits a base remota tem a mais que a branch atual.

Tour da página (§Tour por página): a página, a seleção, hades/local, a trança, os documentos, Salvar e a base, na tela real, sem prévia (a base e a hades/local sempre aparecem). Código: `ui/pages/code.tour.tsx`.

## Loop

Página **Loop** (grupo Loop): a linha da tabela de §Páginas descreve os cards (`GET /api/gates`).

Tour da página (§Tour por página): escalações, PRs com atividade, ações em 24 h, sessões vivas e locks, com prévia de exemplo (uma escalação, duas PRs, uma sessão, dois locks, todos com o selo). Código: `ui/pages/loop.tour.tsx`.

## Orquestração

Página **Orquestração** (grupo Loop): agentes do orquestrador, perguntas ao dono, relatórios e PRs de consolidação (`reference/loop/orchestrate.md`).

**Publicar (Minos):** o card "Acompanhamento publicável" tem o botão *Publicar*, que chama `POST /api/orchestration/publish`: o servidor lê o plano aprovado (`plan.json`), gera a página offline em `$D/minos/offline/orquestracao.html` (a mesma do `hades minos publish --html`, pelo Cerberus antes de gravar) e a resposta traz o arquivo e o comando `hades minos publish orquestracao <plano>` para a sessão do Claude publicar no Artifact. Sem plano aprovado responde `ok: false` com a mensagem, sem erro; o Cerberus barrando devolve os motivos (sem o trecho achado). O painel não publica e não grava link. `reference/minos.md`.

Tour da página (§Tour por página): publicar, perguntas, agentes e o cartão deles, consolidações, decisões autônomas e encerrados, com prévia de quatro agentes de exemplo (nenhum com pane, e abrir arquivo ou terminal fica desligado). Código: `ui/pages/orchestration.tour.tsx`.

### Autonomia do orquestrador (Configurações e Orquestração)

Configurações → grupo Orquestração: **Auto-alocação** (`HADES_ORCH_AUTO_START`, interruptor) e **Autonomia**
(`HADES_ORCH_AUTONOMY`, controle deslizante 0–3 com o rótulo do nível: Pergunta tudo, Operacional, Execução, Totalmente autônomo). O
controle deslizante é o `<input type="range">` do `CfgControl` para a chave `int:0:3` do `config.tsv` (sem tipo novo no catálogo). Salvar
`HADES_ORCH_AUTO_START` grava ou remove a regra allow `Bash(herdr agent start:*)` do `settings.json` na hora. As duas
chaves só mudam pelo painel local: `POST /api/config` pelo acesso remoto responde 400 (`remoteConfigRefusal`).

### Resumidores do rtk (Configurações)

Configurações → grupo **Resumidores (rtk)** (`reference/rtk.md`): `HADES_RTK_FILTERS` (`auto`/`off`), **Stacks sem resumidor**
(`HADES_RTK_OFF_STACKS`) e **Filtros desligados** (`HADES_RTK_OFF_FILTERS`), as duas listas com o controle de tags do `CfgControl`
(um valor por tag: `node-nx`, `pnpm-next`, `rust-cargo`, `tauri`; nomes de filtro da tabela de `reference/rtk.md`). Aplicar é `next`:
vale na próxima instalação ou criação de agente, ou na hora com `hades rtk apply`. As três chaves só mudam pelo painel local:
`POST /api/config` pelo acesso remoto responde 400 (`remoteConfigRefusal`). O estado (rtk presente, filtros ativos, confiança, saída
inteira) está no grupo *Resumidores (rtk)* do `doctor` e em `hades rtk status [--json]`.

Página Orquestração: card **Decisões autônomas** (as 20 mais recentes do diário `kind: decision`, mais novas primeiro: nível,
pergunta, opção tomada, alternativas). `GET /api/orchestration` ganha `autonomy: {level, label}` e `decisions: [{ts, level,
needed, question, chosen, alternatives}]` (`reference/autonomia.md`).

## Revisões

Cada PR escolhida vira um job `hds-pjob-*` que roda `hades review`:

1. `gh pr view` (título, autor, base, head) e `git fetch origin +pull/<n>/head:refs/hades-review/<id>` + a base, no
   repositório do worktree do Hades, com o `gh` como credencial.
2. `git worktree add --detach <pai do W>/wt-review-<n>-<xxxx>`: worktree descartável no head da PR. O working tree do
   dono e o do Hades ficam intocados. Ele sai no fim (`finally`, inclusive quando o job é interrompido).
3. `claude -p "/review-pr <n>"` (ou `/review-agents <base>`) com `--model claude-opus-5-5|claude-sonnet-5-5`,
   `--effort`, `--permission-mode auto` e `stream-json`. O log do job mostra as ferramentas chamadas.
   - O prompt fixa as regras: review só de leitura, sem build/teste (o guard barraria fora da fila), sem perguntas.
   - Com **Postar comentários nas PRs**: publica como em `loop/review.md` §4 (um review `COMMENT`, in-line validados
     contra os hunks, nunca aprova nem pede mudanças) e grava o shard com `hades review-record`.
   - Sem publicar: `gh pr review`/`gh pr comment` ficam proibidos na sessão.
4. A sessão termina com `HADES-REVIEW: verdict=… blocking=… important=… inline=… posted=… reviewId=…`.
   O executor grava `~/.claude/hades/reviews/<id>.json` com essa linha, o custo, os tokens e a duração do resultado do
   `claude -p` (tokens pelo `modelUsage`, que inclui os subagentes, com o detalhe em `tokensByModel`), e `<id>.md` com o
   relatório.

**Fila e fases.** O `hades review` entra num semáforo por arquivo de lock (`~/.claude/hades/reviews/slots/slot-<i>.lock`,
`flock` não bloqueante, solto pelo kernel se o processo morrer) com teto em `HADES_REVIEW_MAX_PARALLEL` (padrão 4), valendo
para o painel e para o terminal. Quem passa do teto espera em `fila`, sem prazo e sem falhar; os prazos do git (`GIT_TIMEOUT_MS`)
só correm depois da admissão. Cada job expõe a fase (`fila`, `fetch`, `checkout`, `revisão`, `publicação`): a linha
`[fase] <nome>` no log, o campo `fase`/`faseDesde` do registro em `reviews/<id>.json` (card **Em curso** de Revisões) e o
arquivo `logs/panel-jobs/<job>.phase` que a página **Execuções** lê enquanto o job roda.

Para testar o preparo sem gastar tokens nem publicar: `hades review … --dry-run` faz o fetch, cria e remove o
worktree e mostra o prompt.

O padrão de modelo e esforço da página vem de Configurações → `HADES_MODEL_REVIEW`/`HADES_EFFORT_REVIEW`. No
`/review-agents`, os subagentes usam o modelo de `HADES_REVIEW_SUBAGENT_MODELS`, não o da página.

Tour da página (§Tour por página): PRs, Como revisar, Em curso, Histórico e uma linha de revisão, com prévia de três revisões de exemplo no histórico (o formulário segue real e Revisar fica desligado enquanto o exemplo está na tela). Código: `ui/pages/reviews.tour.tsx`.

## Fila de gates

A fila é uma só na máquina: `kit/gate/gate-lock.sh` admite os builds do ambiente e os gates do loop (lint, build,
teste) de todos os clones, nos tickets de `~/.claude/hades/work/<owner__repo>/locks` e, para quem não tem `origin` ou
roda com `HADES_GATE_SCOPE=maquina`, de `~/.claude/hades/work/_maquina/locks` (`reference/loop/gates.md` §3.2).
O loop chama a cópia da skill; o `install.sh` copia a mesma para `$D/gate/`, para onde o `env.sh` aponta.

A página usa `src/panel/gatewatch.ts`, o amostrador do estado da fila e do loop. Ela mostra:
- cartões de cada gate: estado, memória e CPU do scope, passo atual e % da mediana do mesmo passo;
- medidor de memória da máquina, com a reserva da fila;
- gráficos de gates simultâneos e de memória;
- journal (entrou, admitido, terminou com rc e duração);
- resumos dos gates recentes;
- processos pesados fora da fila;
- locks do loop (página **Loop** para escalações, entregas e PRs).

A fila da máquina (`work/_maquina`) entra somada à do projeto, na mesma página: os cartões, o journal, os recentes e a
fila crua trazem o selo **Máquina** nos itens que vieram de lá (`machine:true` na API). O mesmo `pid` aparece uma vez,
preferindo o registro que tem ticket. Um ticket da fila da máquina só é atribuído a um loop pelo ticket (sem casar por
repo), e a checagem de "repo único" do amostrador ignora o `_maquina`.

Tour da página (§Tour por página): doze passos (resumo, memória, gráficos, journal, sequências, fora da fila, locks e o amostrador
indisponível); sem prévia, porque a página sempre tem conteúdo vivo; os cards que podem faltar levam `fallback`. Código:
`ui/pages/queue.tour.tsx`.

## Consumo

Página **Consumo**: tokens por papel, agente e dia, e a linha de base; custo é equivalente em API (`reference/loop/tokens.md`).
A leitura "Reescrita depois de pausa" é o cache regravado após > 1 h parado; a reescrita de comando do rtk no auto mode (uma Bash por resposta) é outra coisa, explicada na leitura, no tour e em `tokens.md` §Reescrita do rtk.

Cartão **Janelas do plano** (sobre `GET /api/limits`, atualiza a cada 15 s): o % usado medido das janelas de 5 h e semanal, a
hora de renovação (UTC) e há quanto tempo foi medido, âmbar a partir de 80%. Sem amostras mostra só o aviso de como ligar a
coleta (`hades usage sample` no `statusLine`), nunca um número. As tabelas Por papel e Agentes ganham as colunas `~% 5 h` e
`~% semana` (estimadas, `~`; `+` = só os modelos calibrados) quando há calibração. No Argos, o painel lateral de um agente
leva a mesma medida em uma linha discreta. Fonte e regra: `reference/limites.md`.

Sessões que passaram do teto de contexto do papel: o **Máximo** do agente em tom de aviso com a linha "acima do teto de Nk" (texto, não só cor) e um cartão **Sessões acima do teto** (sessão, papel, turnos, máximo, teto) que só existe quando há alguma; `overCap` do `/api/usage` (`hades usage`, `reference/cli.md`).

Modelo real × configurado: a coluna **Modelos** da tabela Agentes mostra o modelo que cada agente rodou; quando difere do `HADES_MODEL_<PAPEL>`, fica em tom de aviso com a linha "diverge de <configurado>: +US$ N" (o custo da divergência) e, se o esforço observável também difere, "esforço X, configurado Y". Fonte: `byAgent[].divergence` do `latest.json` (regra: `reference/loop/tokens.md`). No Argos, o nó ganha o chip `model` enquanto a sessão diverge.

Tour da página (§Tour por página): nove passos (resumo, ações, janelas do plano, as quatro leituras, papel, dia, estimado × real e agentes); sem
prévia, porque a leitura depende do cálculo real dos transcripts; passos de card condicional levam `fallback`. Código:
`ui/pages/usage.tour.tsx`.

### Moirai: Estimado × real

Seção na página **Consumo** (`kit/panel/ui/pages/usage.tsx`, some se nenhum plano aprovado tem `## Estimativa`), sobre
`GET /api/moirai/plan`: por plano e unidade, a faixa p25–p75 do custo (traço = mediana), o real (marcador na cor do
limiar: verde dentro do p75, âmbar a partir de `HADES_MOIRAI_WARN_PCT`, vermelho a partir de `HADES_MOIRAI_ASK_PCT`), a
porcentagem do p75 e um selo de confiança baixa. Atualiza a cada 15 s. `GET /api/moirai/unit/<nome>[?registry=]` devolve
uma unidade (400 `invalid_unit` para nome fora do padrão, 404 `unknown_unit` se não está no registro). Contrato e regra do
teto: `reference/moirai.md`. O painel guarda o custo lido por unidade em memória, então a primeira consulta lê os
transcripts inteiros e as seguintes só o acréscimo.

## Claude

Página de chat com uma sessão do Claude Code, no navegador e no celular (PWA): mensagem, resposta em streaming, uso de
ferramenta em bloco recolhível. Ao lado do chat há o **modo terminal** (o Claude Code de verdade; abaixo). Ligada por padrão; para desligar: Configurações → **Sessão Claude** →
*Ligar a página Claude* (`HADES_CHAT=0`, só pelo painel local; a página desligada mostra o botão).

**Como roda.** Cada mensagem é um `claude -p --output-format stream-json --verbose --include-partial-messages
--permission-mode auto --model <m> --effort <e>` na pasta do **clone principal** do repositório (o primeiro do
`git worktree list` do `$W`, nunca o worktree do Hades), com `--resume <session_id>` a partir da segunda mensagem.
- **Unit transitória `hds-chat-<id>`**, fora do slice e com o `PATH` do painel: sobrevive a um restart do painel e vive só
  durante a resposta. O binário é o de `HADES_CHAT_BIN` (vazio = `claude` do `PATH`); a unit não herda o shell, então o
  painel passa `PATH`, `HADES_WT` e `HADES_DATA` explícitos.
- **A mensagem entra pelo stdin da unit** (`StandardInput=file:`), nunca no argv: um texto começando com `-` viraria opção
  do `claude`. **Sempre `--permission-mode auto`**, como os agentes; nunca `--dangerously-skip-permissions` nem
  `bypassPermissions`.
- Uma resposta por vez em cada sessão (409 se ainda responde) e no máximo `HADES_CHAT_MAX` sessões respondendo ao mesmo
  tempo (409). O hook `hades guard` vale como numa sessão interativa; o aviso do teto de contexto aparece no chat se vier
  na saída.
- A saída crua do `claude`, mais os marcadores `hds_user` e `hds_end` que o painel grava, fica em
  `$D/claude/<id>.jsonl` (600, pasta 700); o registro (título = primeira mensagem cortada, data, custo, tokens, id da
  sessão do Claude Code) em `$D/claude/sessions.json`. O registro é reconciliado da própria saída, então fecha mesmo com a
  tela fechada. **Apagar** tira só o registro e essa saída; o transcript do Claude Code (`~/.claude/projects`) fica.
  O texto das mensagens fica nesses arquivos, nunca no log.

**API** (token do painel em `POST`; `GET` pela chave do acesso remoto, como o resto):
`GET /api/claude` (sessões, limites, modelo, esforço), `GET /api/claude/stream?id=<id>&offset=<bytes>` (SSE),
`POST /api/claude/send {id?, text}` (sem `id` cria a sessão), `/stop {id}` (`systemctl --user stop` da unit) e `/delete {id}`.
O stream é retomável por offset (`id:` de cada evento = byte seguinte; o `EventSource` religa sozinho com `Last-Event-ID`
quando a rede do celular cai) e termina com `event: done`. Eventos: `user`, `init`, `delta` (texto parcial), `text`,
`tool`, `tool_result`, `warn`, `stderr`, `result` (custo, tokens, duração, recusas do auto mode), `end`. Deltas só vão
da mensagem em curso; o histórico vem pelos eventos de texto completos. Link direto: `#/claude?s=<id>`.

**Tela.** Coluna de sessões (no celular, uma gaveta); resposta em markdown **sanitizada** (HTML cru vira texto, imagem vira
o alt, link só `http(s)`/`mailto`, e uma segunda passada no DOM inerte só deixa passar tags de uma lista); ferramenta em bloco
recolhível (nome, entrada resumida, resultado cortado em 2000 caracteres); recusa do auto mode em destaque (vermelho);
rodapé de cada resposta com custo, tokens e duração. Enter envia, Shift+Enter quebra a linha, **Parar** interrompe.
Parar mantém o texto que já chegou. O `post()` com retry do token velho (restart do painel) vale aqui também.

**Segurança do acesso remoto.** Pelo túnel a página vale com as mesmas duas camadas do painel (conta dona do devtunnel +
chave de acesso), e quem passa por elas tem um Claude Code em auto mode no clone principal: trate a chave como tal.
- `HADES_CHAT` e `HADES_CHAT_BIN` (o binário que a unit executa) **só se mudam pelo painel local**, inclusive no import.
- **Sessão remota avisa o dono:** a primeira mensagem remota de cada sessão dispara o evento `chat` do `notify.sh`
  (desktop e celular, `HADES_NOTIFY_EV_CHAT`) com a hora e "sessão remota", nunca o texto. Só sai com `HADES_NOTIFY=1`; a
  página lembra disso quando as notificações estão desligadas.
- Registro em `$D/logs/claude-chat.log`: hora, sessão, `local`/`remoto`, custo. Sem o texto.
- Fora do escopo: aprovar ferramenta na própria tela do chat (o terminal é o caminho) e escolher a pasta do chat (o modo terminal escolhe).

**Modo terminal.** O seletor *Chat | Terminal* do cabeçalho troca a mesa. O modo terminal abre o `claude` num `PtyTerminal`
(`kind: "claude"` do §Terminal: sempre `--permission-mode auto`), numa pasta entre as `roots` de `GET /api/term` (padrão: o
clone principal), novo ou retomando uma sessão (`resume`) escolhida na lista de conversas que a página já conhece. O overview
`GET /api/claude` passa a trazer `claudeSession` (o id do Claude Code; aditivo) em cada sessão, e o botão **Continuar no
terminal** do cabeçalho abre a conversa atual com esse id (desligado enquanto ela responde: a mesma sessão em dois
processos se pisaria). A sessão do terminal sobrevive à troca de aba (`sessionStorage` `hades-claude-term`) e **Encerrar**
a fecha (`POST /api/term/close`). Com `HADES_TERMINAL` desligada o modo mostra o aviso de como ligar (pelo `code`
`term_disabled`, texto do `TermLogic.refusal`) e o chat segue como sempre. Pelo acesso remoto valem as regras do §Terminal
(aviso ao dono, 12 aberturas por minuto).

**Aprovar ferramenta: o terminal é o caminho.** O `claude -p` em stream-json só avisa do bloqueio (`tool_result` com
`is_error` e o `permission_denials` do `result`); não há pergunta no meio da resposta. O `--permission-prompt-tool` exigiria
um servidor MCP próprio do Hades que decidisse em nome do dono e devolvesse a resposta ao processo em curso: um segundo canal
de aprovação por fora do hook `hades guard`, sem como provar aqui que ele não abre mais do que o auto mode fecha. Por isso o
chat **não simula aprovação**: o aviso de recusa ganha **Abrir no terminal para aprovar**, que retoma a mesma sessão no modo
terminal, onde a aprovação é a nativa do Claude Code.

**Anexar arquivo.** O clipe do compositor escolhe imagens (png, jpg, gif, webp, conferidas pela assinatura) ou texto (lista
de extensões, sem byte nulo) e manda `POST /api/claude/attach {id?, name, data}` (JSON, `data` em base64, mesmo token e mesma
autenticação do resto, remoto incluído). Vai para `$D/claude/attach/<sessão>/<4 hex>-<nome saneado>` (700/600), **nunca dentro
do repositório do projeto**; o nome perde pasta, `..` e tudo fora de `[A-Za-z0-9._-]`, o caminho resolvido é conferido dentro
da pasta da sessão. Limite por arquivo `HADES_CHAT_ATTACH_MB` (5; o corpo da requisição tem o teto próprio de 4/3 disso) e 20
arquivos por conversa. Sem `id`, nasce um **rascunho** (8 hex) que o primeiro `send {draft, files}` promove a id da sessão;
rascunho sem dono por 24 h é varrido no anexo seguinte. O `send {files}` aceita só nomes que existem na pasta da sessão e
acrescenta à mensagem `Arquivos anexados (leia pelo caminho):` com os caminhos absolutos, que é como o Claude Code lê arquivo.
Recusas `{error, code}` com `attach_disabled` 403 · `attach_bad_request` 400 · `attach_too_large` 413 · `attach_bad_type`
415 · `attach_too_many` 429 · `attach_unknown_session` 404. O log registra só nome, tamanho e tipo. Apagar a sessão apaga
a pasta dos anexos.

**Testar sem gastar sessão.** Aponte `HADES_CHAT_BIN` para um script que lê o prompt do stdin e imprime o stream-json
(system/init, assistant, user/tool_result, result) e use `HADES_CHAT_UNIT=skilldev-chat` no ambiente do painel de teste, para
as units não se misturarem com as reais (`hds-chat-*`). Uma prova real custa centavos com `HADES_MODEL_CHAT=claude-haiku-5-5`
e `HADES_EFFORT_CHAT=low`.

Tour da página (§Tour por página): oito passos (a página, a conversa ligada ou desligada, a lista de conversas, o cabeçalho, o seletor Chat|Terminal, a
introdução, a conversa e o envio); sem prévia, porque a conversa é um fluxo ao vivo com gasto real; passos de card condicional
levam `fallback`. Código: `ui/pages/claude.tour.tsx`.


### Claude no celular
Lista de conversas em tela cheia (com "Claude Code no terminal" no topo); tocar numa conversa, em "Nova" ou nesse botão abre o detalhe, que cobre a tela e acompanha o `visualViewport` (o campo de mensagem sobe com o teclado). No modo Terminal a **barra de teclas** (abaixo) fica colada no teclado com as respostas rápidas na frente (1/2/3, y/n, Shift+Tab, Ctrl+C), porque o que o Claude Code pede quase sempre é uma delas.

## Herdr

Página **Herdr** (grupo Operação, depois de Claude): acompanha e **gerencia** o herdr ativo na máquina (decisão do dono:
o painel cria, renomeia e fecha a estrutura do herdr, não só observa), não só os agentes do Hades. Funciona igual pelo acesso remoto. Ícone de terminal e badge na sidebar: nº de agentes `working` da sessão
`default` e um ponto quando algum está `blocked` (esperando o dono).

- **Árvore** sessão → workspace → aba → painel, vinda de um único `herdr api snapshot` (cache de 3 s; a tela atualiza a
  cada 4 s). Cada painel mostra o agente (nome, tipo, `agent_status`), o título, `foreground_cwd` (ou `cwd`) e a branch
  (`git` no cwd, cache de 30 s); o workspace mostra o repositório/worktree que o herdr informa. "Há quanto tempo no
  estado" é contado **desde que o painel viu o estado** (o herdr não guarda a hora), então some a cada restart do painel.
  Filtro por texto (nome, caminho, branch, ID) e por estado. Com mais de uma sessão aparece o seletor de sessão; a
  gaveta **Sessões** lista todas.
- **Painel escolhido:** o **terminal ao vivo** do painel (`ui/herdr-term.tsx`): o quadro que o herdr entrega por
  `GET /api/herdr/stream` (SSE, um pane) é desenhado pelo `NodeTty` do Argos (`argos/node-tty.tsx`, importado como está,
  cores e cursor estimado) e o teclado escreve direto nele, por `POST /api/herdr/input` (fila de um envio por vez; as
  teclas que o herdr 0.8.2 recusa saem antes). **Tamanho:** o quadro só ganha escala (`fitScale`); a página não anexa
  cliente herdr nem manda resize, porque o tamanho de um pane é da sessão inteira e vence quem mexeu por último. Ao
  redor do terminal ficam os metadados (nome, estado, `cwd`, branch, processo em primeiro plano por `pane process-info`)
  e as ações (prompt, teclas, dividir, renomear, fechar). A **saída em texto** (`pane read --source recent-unwrapped`,
  200 linhas, ANSI removido) virou uma alternativa recolhida (copiar, leitor de tela), com atualização manual e
  automática (3 s aberta, 10 s fechada, só para o processo); com o fluxo caído (3 erros seguidos, ou a rota recusada) ela
  abre sozinha e o terminal oferece **Reconectar**. Pane que saiu mostra o aviso no lugar do quadro.
- **Hades:** agente registrado em `$ORCH/agents/*.json` ganha o selo "Hades" (link para a Orquestração); na Orquestração,
  cada agente tem o atalho "Abrir no Herdr" (`#/herdr?pane=<id>`). `#/herdr?session=<s>&pane=<id>&sessions=1` abre direto
  numa sessão, num painel ou na gaveta de sessões.
- **Falar:** *Enviar prompt* (`agent prompt`, só em painel com agente), *Digitar sem Enter* (`pane send-text`, sem Enter) e
  teclas (`pane send-keys`): Enter, Esc, Ctrl+C, Tab, setas, y, n. Esc e Ctrl+C pedem confirmação. *Renomear* troca o
  nome do agente (vazio remove).
- **Sessões:** `session stop` e `session delete` (só de sessão parada) pedem para **digitar o nome**; o aviso mostra
  quantos agentes estão trabalhando e destaca a sessão `default` (a Orquestração e o loop vivem nela) e a sessão onde o
  próprio painel roda (`HERDR_SOCKET_PATH`). O servidor também exige o nome na requisição.
- **Terminais (xterm.js):** a página abre na visão **Terminais** quando `HADES_TERMINAL` está ligada (alternador *Terminais /
  Workspaces do herdr*; `#/herdr?pane|state|session|sessions=` abre direto nos workspaces). Abas de sessão (**Novo terminal**:
  shell, Claude Code novo ou com `--resume <id>`, cliente do herdr numa sessão; pasta entre as `roots` de `GET /api/term`),
  **Lado a lado** (só na mesa, ≥ 1024 px; a segunda sessão se escolhe no cabeçalho dela), **Soltar** (tira da mesa, a
  sessão segue) e **Fechar** (confirmação; mata o grupo de processos). **Sessões (n)** lista todas as sessões vivas do
  servidor, inclusive as abertas em outra tela ou pelo acesso remoto, com *Anexar aqui* (tira a sessão da outra tela) e
  *Fechar sessão*. A mesa fica em `sessionStorage` (`hades-herdr-term`, só ids de 32 hex): recarregar anexa de novo e
  retoma pelo offset; id que sumiu do servidor sai da mesa. A lista vem de `GET /api/term` a cada 4 s. Só as sessões
  visíveis têm socket (trocar de aba reanexa e reenvia o anel). Os workspaces ganham **Abrir cliente no terminal**.
  A 390 px a mesa é uma coluna (sem lado a lado; teclado virtual e barra de teclas são da fase do celular).
- **Chave desligada:** a página abre nos workspaces, com o aviso de como ligar (só no painel local) e o link para as
  Configurações; a lista e todas as ações do herdr seguem. Código: `ui/pages/herdr.tsx` (`Herdr` > `TermDesk`/`HerdrManage`),
  contrato do componente em §Terminal › Interface.
- **Estado vazio:** sem o binário `herdr` ou com o servidor da sessão fora do ar a página explica, sem erro 500.
- **Terminal ao vivo (nó de agente do Argos):** `GET /api/herdr/stream?session=&panes=` (SSE com `frame`, `status`,
  `exited`, `error`; uma assinatura do herdr por sessão, ~10 quadros/s por pane no máximo) e `POST /api/herdr/input`
  `{ session, pane, text?, keys? }` (`pane.send_input`; teclas de hoje mais Backspace, Shift+Tab e Ctrl+A..Ctrl+Z).
  Detalhe e armadilhas em `reference/argos.md` §Fluxo do terminal (servidor).
  **Tamanho e rolagem do nó:** o nó só escala o quadro (o tamanho do herdr é da sessão inteira e vence o último a mexer, então o
  painel não dita cols×rows); a roda e o arrasto de dedo rolam o histórico, Ctrl/Alt+roda é do canvas (`reference/argos.md` §Tamanho
  do terminal do nó e §Rolagem do terminal do nó).
- **Gerenciar** (`POST /api/herdr/admin`, corpo `{ session?, action, ...alvo }`; a tela usa um `Dialog` por ação e o `Select`
  para direção e tipo de agente). O alvo (`workspace`, `tab`, `pane`) só vale se existir no retrato atual da sessão; o ID
  que a tela mandou nunca é confiado. Cada ação roda o `herdr` com argv em lista (sem `--focus`: nada rouba o foco do dono):

  | `action` | campos | CLI |
  |---|---|---|
  | `workspace-create` | `label?`, `cwd?` (absoluto, existente, dentro do `$HOME`) | `workspace create --no-focus [--label] [--cwd]` |
  | `workspace-rename` / `-close` | `workspace`, `label` / `confirm` | `workspace rename <id> <label>` / `workspace close <id>` |
  | `tab-create` | `workspace`, `label?` | `tab create --workspace <id> --no-focus [--label]` |
  | `tab-rename` / `-close` | `tab`, `label` / `confirm` | `tab rename <id> <label>` / `tab close <id>` |
  | `pane-split` | `pane`, `direction` (`right`\|`down`) | `pane split <id> --direction <d> --no-focus` |
  | `pane-rename` / `-close` | `pane`, `label` / `confirm` | `pane rename <id> <label>` / `pane close <id>` |
  | `agent-start` | `pane` (shell sem agente), `name`, `kind`, `args?` | `agent start <nome> --kind <k> --pane <id> [-- <args>]` |

  `name` segue `[a-z][a-z0-9_-]{0,31}` e não pode já existir; `kind` vem de `AGENT_KINDS` (`claude`, `codex`, `gemini`);
  `args` é lista de até 16 tokens (`[\w@%+=:,./[\]-]`, até 200 caracteres, sem espaço, aspas nem quebra de linha) e vai depois
  do `--`; o `agent start` espera o agente ficar pronto (teto de 60 s aqui). `label` tem 1 a 64 caracteres, uma linha e não
  começa por `-` (a CLI leria como opção).
- **Destrutivas:** `workspace-close`, `tab-close` e `pane-close` (sempre, não só com agente vivo) exigem `confirm` igual
  ao nome do alvo, que **o servidor calcula** do retrato (rótulo do workspace/aba; nome do agente ou ID do painel; o ID
  quando não há rótulo): na tela o diálogo pede digitar o nome e segurar 1,2 s. **Parar a sessão** continua em
  `POST /api/herdr/session` (`stop`/`delete`, `confirm` = nome da sessão), na gaveta Sessões.
- **O que a CLI do herdr 0.8.2 não permite:** limpar o rótulo de um painel (`pane rename` sem rótulo ou com `--clear` não
  é documentado, então a ação exige nome); `agent start` só entra em painel de shell livre (não cria nem divide: por isso
  *Dividir* e *Iniciar agente* são botões separados); não há "mover" nem "reordenar" nesta fase.

**Escrita e remoto.** Toda escrita é POST com o token do painel (`post()` com retry). O `herdr` roda sempre com argumentos
em lista (nunca shell); o painel/pane vem validado contra a listagem atual e as teclas contra uma lista fechada.
- Pelo acesso remoto cada ação dispara o evento `herdr` do notify (`HADES_NOTIFY_EV_HERDR`): hora, ação e alvo (painel
  ou sessão), nunca o texto; um aviso por ação e alvo a cada 60 s. Só sai com `HADES_NOTIFY=1`.
- Registro em `$D/logs/panel-herdr.log`: hora, ação, alvo, sessão, `local`/`remoto` e `ok`/`erro`. Sem o texto. Na
  gerência o alvo é o ID do herdr (o do que acabou de nascer, nas criações); nome digitado, pasta, argumentos e `confirm`
  nunca entram no log nem no aviso.
- **Armadilhas medidas (herdr 0.8.2):** `agent prompt` não aceita `--` e trata texto iniciado em `-` como opção (o painel
  antepõe um espaço); `pane send-text` aceita `-x` direto e entrega `--` **literal** ao terminal; `agent prompt` recusa
  com `agent_not_ready` se o agente não é mais o processo em primeiro plano; `pane read --source recent*` vem vazio num
  painel novo; o erro do CLI sai em JSON no stderr; `session delete` de um nome inexistente responde "deleted".
- **Testar sem tocar nada real:** `herdr --session skilldev-herdr server` sobe uma sessão descartável; crie um workspace
  com um shell (`--session skilldev-herdr workspace create --cwd /tmp`), registre-o como agente com `pane report-agent`
  (e `exec -a claude cat` para o `agent prompt` achar o processo), prove a escrita pelo painel de teste (`?session=`) e
  termine com `session stop` + `session delete` pela própria página.

Tour da página (§Tour por página): doze passos (a página, o aviso de herdr fora do ar, resumo, sessões, filtros, workspaces, terminal, saída, envio, teclas e
renomear); sem prévia, porque a página espelha terminais vivos e um exemplo seria enganoso; os passos do terminal escolhido
levam `fallback`. Código: `ui/pages/herdr.tour.tsx`.


### Herdr no celular
- **Aba Terminais:** lista das sessões abertas; tocar em uma abre o terminal em tela cheia com a barra de teclas.
- **Aba Workspaces:** lista de painéis; tocar abre o **mesmo terminal** em tela cheia (`MobileTermScreen`), com a barra
  de teclas de `mobile-term.tsx` colada ao teclado virtual (Esc, Tab, Ctrl fixo, setas, 1/2/3, y/n, Ctrl+C…; a barra
  fala por `apiRef` em bytes e `bytesToInput` os traduz para o contrato do `/api/herdr/input`). Tocar no terminal
  abre o teclado (o foco do campo escondido acontece dentro do clique, o gesto que o iOS exige) e tocar na barra ou no
  cabeçalho não o tira dele. O botão de ajustes do cabeçalho abre a gaveta com metadados, saída em texto, prompt e ações.
  Limite: com a largura do celular, um pane de ~94 colunas fica a ~0,5× (sem resize, por decisão); o texto se lê melhor
  na saída em texto.
- **Agente pedindo você** (selo "espera por você" do herdr, Orquestração, Argos): o toque leva a `#/herdr?pane=<id>`, que
  no celular abre direto o painel dele. Com o agente em `blocked`, a barra de teclas do terminal põe as respostas **1 / 2 / 3 / y /
  n** primeiro e em destaque (`attention`); na gaveta de detalhes, a primeira linha são as mesmas respostas (texto sem Enter pelo `herdr pane send-text`).
- **"Abrir o cliente do herdr" e "Abrir terminal na pasta"** (só dentro das raízes permitidas): abrem a sessão PTY na hora
  e levam ao terminal em tela cheia. Com `HADES_TERMINAL` desligado, o aviso diz como ligar.

## Terminal

Terminal de verdade no painel: sessões PTY (o PTY nativo do Bun, sem `node-pty`) servidas por WebSocket. Esta seção é o
**contrato da interface** (xterm.js, unidade term-ui): rotas, mensagens, códigos de recusa, retomada por offset e limites.
Código: `src/panel/term.ts` (sessões), `term-ring.ts` (anel), `term-http.ts` (rotas e socket), `term-protocol.ts`
(constantes e códigos: a interface importa daqui, não repete número).

### Tipos de sessão
| `kind` | comando (argv em lista, nunca string de shell) | extras |
|---|---|---|
| `shell` | o `$SHELL` do painel (absoluto e executável; senão `/bin/sh`) | — |
| `claude` | `HADES_CHAT_BIN` ou o `claude` do `PATH`, sempre com `--permission-mode auto` | `resume`: id da sessão do claude (`--resume <id>`), `[A-Za-z0-9_-]{1,64}` |
| `herdr-client` | `herdr --session <session>` (o herdr 0.8.2 anexa à sessão inteira, não a um pane) | `session` (padrão `default`) |

### Rotas HTTP
Mesma autenticação das demais rotas (host, chave remota por cookie); os POST levam `x-panel-token` e JSON, como sempre.
| Rota | Corpo / resposta |
|---|---|
| `GET /api/term` | `{enabled, max, idleMin, scrollbackKb, active, roots[], sessions[]}`. Sessão: `{id, kind, cwd, startedAt, lastUsedAt, origin: local\|remote, state: running\|exited, cols, rows, attached}`. Nunca conteúdo. Responde também com a chave desligada (`enabled:false`). |
| `POST /api/term/open` | `{kind, cwd?, cols?, rows?, resume?, session?}` → a sessão (acima). `cwd` ausente = o clone principal. |
| `POST /api/term/close` | `{id}` → `{ok:true}`. Mata o grupo de processos. |

Recusa: `{error, code}` com o status de `TERM_STATUS`. **Ramifique pelo `code`**, nunca pelo texto (só ganham valores):
`term_disabled` 403 (chave desligada; a mensagem diz como ligar) · `term_bad_request` 400 · `term_forbidden_cwd` 403 ·
`term_kind_unavailable` 422 (binário do tipo não instalado) · `term_max_sessions` 429 · `term_rate_limited` 429 (com
`Retry-After`; só pedidos de fora) · `term_unknown_session` 404 · `term_origin` 403 · `term_spawn_failed` 500 (detalhe só
no log do painel). No upgrade do WebSocket a recusa é a resposta HTTP (antes de trocar de protocolo): 401 (sem cookie
pelo túnel), 403 `host`, e os de cima.

### WebSocket `GET /api/term/ws?id=<id>[&offset=<n>]`
Protocolo v1. O `id` (32 hex, 128 bits) só existe depois do `open`; sem Origin permitido, sem upgrade.
- **Cliente → servidor.** Quadro **binário** = entrada crua do terminal (teclas, colar, UTF-8 partido entre quadros: os
  bytes vão como vieram). Quadro **texto** = controle JSON: `{"t":"resize","cols":C,"rows":R}`, `{"t":"close"}`,
  `{"t":"ping"}`. Texto que não é JSON de objeto, tipo desconhecido ou resize fora dos limites vira `warn`
  `term_bad_message` e a sessão segue.
- **Servidor → cliente.** Quadro **binário** = saída crua (até 32 KiB por quadro). Quadro **texto** = JSON:
  `{"t":"hello","v":1,id,kind,cwd,cols,rows,offset,start,end,state}` (sempre o primeiro),
  `{"t":"warn",code,message,offset?,requested?,lost?}`, `{"t":"exit",code,signal}` (depois da última saída; em seguida o
  servidor fecha com 1000), `{"t":"pong"}`.
- **Retomada por offset.** A saída tem um offset absoluto em bytes. `hello.offset` é o offset do primeiro byte binário que
  vem a seguir; o cliente soma os bytes binários recebidos e guarda `offset = hello.offset + recebidos`. Reconectando com
  `&offset=<esse valor>` recebe só o que faltava, sem perder nem repetir. Sem `offset`: tudo o que o anel guarda
  (`hello.start` até `hello.end`). Offset antes do anel: `warn term_offset_truncated` (`requested`, `offset` novo, `lost`)
  e segue do mais antigo guardado; offset à frente do fim: `warn term_offset_ahead` e segue do fim. Um `warn` com
  `offset` (também `term_output_truncated`, quando um cliente lento deixa o anel passar por ele) **zera a contagem**: o
  próximo byte binário está nesse offset.
- **Uma tela por sessão.** Um segundo cliente anexado fecha o primeiro com **4001**. Sair do socket não mata a sessão: ela
  segue (e o anel guarda a saída) até fechar, expirar ou o processo sair. Processo que sai sozinho: a sessão fica listada
  como `exited` por 60 s e dá para anexar e ler o fim.
- **Códigos de fechamento:** 1000 processo saiu · 4001 trocado por outro cliente · 4002 fechada (`close`/rota) · 4003
  expirou por inatividade · 4004 painel parando · 1009 quadro de entrada acima de 64 KiB (o Bun derruba o socket).
- **Contrapressão.** Com mais de 1 MiB na fila do socket o servidor para de empurrar e retoma no `drain`, lendo do anel.

### Limites
Entrada ≤ 64 KiB por quadro; controle ≤ 4 KiB; `cols` 20–500 (80), `rows` 5–200 (24); anel `HADES_TERMINAL_SCROLLBACK_KB`
(256); `HADES_TERMINAL_MAX` sessões vivas (4); 12 aberturas por minuto pelo acesso remoto; inatividade
`HADES_TERMINAL_IDLE_MIN` (30; 0 = sem limite) conta **entrada, resize e conexão do cliente**, não saída nem ping. Chave
desligada fecha as sessões abertas (o vigia passa a cada 15 s). Parar o painel fecha todas.

### Modelo de segurança
O terminal executa comando como o dono; é o maior risco do painel. Por isso:
- **`HADES_TERMINAL` desligada por padrão**, e as quatro chaves (`HADES_TERMINAL*`) **só mudam pelo painel local**, pelo
  mesmo mecanismo de `HADES_CHAT`/`HADES_CHAT_BIN` (`remoteConfigRefusal` e `CONFIG_LOCAL_ONLY` em `routes-core.ts`,
  que também barra o import). Ligada, quem tem a chave de acesso remoto abre um shell nesta máquina: ligue sabendo disso.
- **Camadas do WebSocket:** o upgrade passa por `hostOk` e `authed` (pelo túnel valem a conta dona do devtunnel e o
  cookie da chave) e confere `Origin`: só o próprio painel (`http://127.0.0.1:<porta>`, `localhost`) ou, pelo túnel,
  `https://<host do túnel>`. Pelo túnel Origin ausente é recusado; no painel local um cliente de script sem Origin passa
  (mesmo grau de confiança de quem lê `/api/token`). Outro site no navegador sempre manda Origin e cai em `term_origin`.
  Token não viaja na query: o `id` aleatório de 128 bits (só dado pelo `open`, que exige o token do painel) é o segredo
  da sessão.
- **Pasta:** `cwd` só vale dentro das raízes permitidas (o clone principal, as worktrees de agente registradas e `$D`),
  depois de `realpath` (`..` e symlink não escapam); relativa é `term_bad_request`.
- **Aviso:** toda sessão aberta pelo acesso remoto dispara o `notify` (tipo, pasta e hora; nunca conteúdo). A sessão
  aberta no local e anexada pelo acesso remoto avisa também, no primeiro anexo remoto (uma vez por sessão; a aberta de
  fora já avisou ao abrir): o anexo dá o mesmo shell.
- **`$D/logs/panel-term.log`** (0600), uma linha JSON por evento: `t` (UTC), `action` (`abrir`/`anexar`/`fechar`/
  `expirar`/`recusar`; `anexar` leva a origem de cada anexo, local ou remota), `kind`, `cwd`, `origin`, `id` e, nas recusas, `code`. Nunca o que foi digitado nem a saída (teste em
  `painel-term.test.ts`).
- **Processos:** argv em lista, sem `eval` nem shell montado. Cada PTY é líder de sessão e de grupo; ao fechar, expirar,
  sair ou parar o painel o grupo recebe SIGTERM e, 1,5 s depois, SIGKILL (sem órfão, nem job em segundo plano).
- **Slice:** a unit do painel fica **fora** do slice `hades` (§Início automático), então o PTY não está nele: está no
  cgroup da própria unit `hds-panel` (provado: `/proc/<pid>/cgroup` do filho = o do painel; `KillMode` padrão, o
  `systemctl stop` leva as sessões junto). Não conta no teto de memória do Hades.

### Interface
Código: `kit/panel/ui/term.tsx` (componente), `term-logic.tsx` (regra pura, `window.TermLogic`, testada em
`painel-term-ui.test.ts`), `vendor/xterm.js` + `xterm.css` + `xterm-addon-fit.js` (xterm.js 6.0.0 e fit 0.11.0, UMD sem
bundler; versões, sha256 e licença MIT em `THIRD_PARTY_NOTICES.md`). O `index.html` carrega css, xterm, addon e
`term-logic.js` antes do `app.js`, e o `term.js` logo depois dele (as páginas vêm por último).

**"Abrir terminal"** (Orquestração por agente, menu do nó no Argos, Execuções): `HadesCore.OpenTerminalButton` (`term.tsx`) abre
um shell em `cwd` (`POST /api/term/open`), acrescenta a sessão à mesa que a página Herdr guarda em `sessionStorage`
(`hades-herdr-term`) e navega para `#/herdr`. Em Execuções o `cwd` é o campo aditivo `cwd` da execução (`jobs.ts`) e o botão só
aparece com a pasta dentro das `roots` de `GET /api/term`; nas outras a recusa `term_forbidden_cwd` vira aviso. Com a chave
desligada o botão não some: o clique mostra o aviso de `term_disabled` (como ligar).
`HadesCore.createXterm(el, {fontSize, scrollback, readOnly, lineHeight})` é o mínimo comum (tema do painel, fit, links) que o
`PtyTerminal` e o nó do Argos usam. `readOnly` só desliga a entrada do xterm; o cursor é o mesmo nos dois: pisca com o foco e vira
contorno sem ele (`cursorBlink`, `cursorInactiveStyle: 'outline'`; cor do texto sobre o fundo do tema, nos dois temas).

**Cursor e eco no nó do Argos** (o nó desenha quadros do herdr, não bytes de PTY).
- *Cursor.* O herdr 0.8.2 não entrega o cursor (`pane.read` traz só texto e revisão) e o `screenOf` abre com `?25l`: sem o campo,
  o cursor nunca aparecia. `TermLogic.guessCursor` o estima pelo texto (última linha com conteúdo, logo depois do último
  caractere; um espaço além se a linha termina em prompt, porque o herdr apara o espaço do fim). Quadro com vídeo inverso
  (SGR 7) é de um programa que desenha o próprio cursor (Claude Code, editores): nada é estimado. `frame.cursor`, se o produtor
  um dia o entregar, vence a estimativa (`frameCursor`). É estimativa: um programa que move o cursor sem texto novo não é seguido.
- *Foco.* O xterm só mostra o cursor «com foco» quando o textarea dele recebe o evento de foco, mas o teclado do nó fica no
  textarea escondido do próprio nó (composição e colagem). O nó dispara `focus`/`blur` no textarea do xterm conforme `focused`
  (`setTermFocus`), sem roubar o foco do teclado.
- *Eco.* `POST /api/herdr/input` volta antes de o herdr processar a tecla; a leitura imediata do `nudge` via o quadro velho, o
  intervalo dobrava e o caractere chegava 100–200 ms depois. Agora, depois do `nudge`, o leitor do pane faz até duas releituras
  curtas (`ECHO_RETRY_MS` = 15 e 30 ms), o teto de 100 ms cede ao primeiro passo e o intervalo não dobra, só no pane que recebeu
  entrada e só até o quadro mudar. Medido (herdr 0.8.2, bash): eco no SSE p50 5 → 3 ms, p90 96 → 10 ms com 1 pane, p90 102 → 4 ms
  com 8; página Terminal (PTY por WebSocket) p50 0,4 ms. O que sobra é o intervalo de leitura do herdr, que não dá fluxo de bytes.
- *Armadilha.* O painel serve o kit **instalado**, não a worktree: depois de mexer em `kit/panel/ui/`, reinstale (`kit/install.sh`)
  antes de conferir a tela; `src/panel/` só vale depois de reiniciar o painel.

**Componente `PtyTerminal`**, em `HadesCore` e `HadesPanel` (o nome `Terminal` já é o visualizador de log das Execuções;
o do terminal de verdade é `PtyTerminal`).
| Prop | Efeito |
|---|---|
| `id` | anexa a uma sessão já aberta (`GET /api/term`) |
| `open` | `{kind, cwd?, resume?, session?}`: abre (`POST /api/term/open`, com `cols`/`rows` medidos) e anexa. Sem `id`; a abertura acontece uma vez por montagem (reconectar não abre outra) |
| `onOpened(sessão)` | depois do `open` (a sessão do servidor; guarde o `id` para anexar depois) |
| `onExit({code, signal})` | o processo saiu (a sessão fica listada como `exited` por 60 s) |
| `onState({kind, ...})` | cada mudança de fase: `opening`, `connecting`, `live`, `reconnecting` (`attempt`, `inMs`), `gaveup`, `ended` (`reason`: `exited`/`replaced`/`closed`/`expired`/`shutdown`/`protocol`), `refused` (`refusal`) |
| `className`, `fontSize` | classes do contêiner (precisa de altura definida: o terminal preenche) e tamanho da fonte (13) |
O contêiner expõe `data-term-phase` e `data-term-reason` (para teste). Ao desmontar, o componente encerra socket, timers e
observadores e descarta o terminal; a sessão **não** é fechada (para isso, `POST /api/term/close`).

**Comportamento (decisões em `term-logic.tsx`, nunca pelo texto do servidor).**
- *Entrada:* teclas e colar vão como quadro binário; entrada acima de 64 KiB é partida em quadros de no máximo 64 KiB
  (o servidor derruba o socket com 1009 acima disso). *Resize:* `addon-fit` + `ResizeObserver` (debounce de 80 ms),
  `{"t":"resize"}` só quando o tamanho (preso a 20–500 × 5–200) muda; reenviado a cada `hello`. Ping a cada 25 s.
- *Retomada:* guarda `hello.offset` e soma os bytes binários; um `warn` com `offset` zera a contagem. Fechamento fora da
  lista abaixo (rede, 1005/1006, 1009) reconecta com `&offset=<n>` e recuo exponencial (500 ms, dobra, teto 15 s, ±25% de
  jitter), até 8 tentativas, e então mostra "Reconectar". Volta na hora com o evento `online` ou ao voltar à aba. Queda
  antes do `hello` confere `GET /api/term`: chave desligada ou sessão que sumiu viram recusa em vez de laço. Perda de saída
  (`term_offset_truncated`, `term_output_truncated`) escreve uma linha apagada no terminal com quanto se perdeu.
- *Fechamento:* 1000 (processo saiu, linha "processo terminou com código N") e 4002/4003/4004/4005 param e mostram o motivo
  numa barra sob o terminal; **4001** (aberta em outra tela) para sem reconectar e mostra "Esta sessão foi aberta em outra
  tela" com **Trazer para cá** (anexa de novo; a outra tela perde a sessão do mesmo jeito).
- *Recusas pelo `code`* (só o código decide; sem `code` conhecido vale a recusa genérica com o status): `term_disabled`
  mostra como ligar (Configurações → Terminal, só no painel local), `term_max_sessions`, `term_rate_limited` (com o
  `Retry-After` em segundos), `term_forbidden_cwd`, `term_kind_unavailable`, `term_unknown_session`, `term_origin`,
  `term_spawn_failed`.
- *Aparência:* cores lidas dos tokens do painel (`--term`, `--term-foreground`, `--term-bad`, `--term-warn`, resolvidos
  para RGB porque o xterm não lê `oklch`), refeitas quando o tema claro/escuro muda; fonte Geist Mono (a mesma do painel),
  contraste mínimo 4,5. Copiar: seleção + Ctrl/Cmd+C (sem seleção, Ctrl+C segue como interrupção) ou Ctrl+Shift+C. Colar:
  Ctrl/Cmd+V ou Ctrl+Shift+V (o xterm cuida do colar entre aspas). Link clicável **só `http(s)`** (também OSC 8): `javascript:`,
  `data:`, `file:` nunca abrem; abre com `noopener`.
- *Tecla morta (´ ~ ^ + letra):* o Firefox manda a letra base como `keydown` durante a composição (`isComposing`
  verdadeiro) e o xterm a toma por tecla, o que somava ao texto composto (`aaá`). O `PtyTerminal` liga `composeGate`
  (`term-logic.tsx`) na captura do elemento do xterm: ele segura os `keydown`, `compositionupdate` e `input` da composição e
  entrega o caractere composto uma vez (`term.input`). Composição de IME (CJK) não passa por ele: fica com o xterm.
- *Roda:* o xterm anda pelo histórico dele em buffer normal. Em tela alternativa:
  - **`herdr-client`** (a sessão PTY mostra um pane): a roda anda pelo histórico do pane, o mesmo `/api/herdr/scrollback` do nó
    do Argos, com a mesma regra (`wheelStep`, `wheelScroll`, `historyLoaded` e a janela, hoje em `term-logic.tsx`, que o nó
    importa). O servidor diz a sessão do herdr do cliente (`herdrSession` em `/api/term`); a página lê `/api/herdr` e usa o
    pane em foco (workspace, aba e pane focados) e desenha a janela do histórico num xterm só de leitura por cima do terminal.
    Volta ao vivo ao descer até o fim, ao digitar, ao sair da tela alternativa, ao mudar o tamanho ou em "Ir ao fim". Ctrl, Alt e
    Meta com a roda seguem ao navegador (zoom).
  - **Sem pane conhecido** (`claude`, `shell`): a roda continua indo ao programa e a página mostra uma dica (PageUp/PageDown ou o
    atalho de rolagem do programa) na primeira vez em tela alternativa, uma vez por carga da página.
  - *Como a sessão sabe o pane:* ela não sabe, e o ambiente não ajuda: o PTY herda o ambiente do painel, então um
    `HERDR_PANE_ID` ali seria o do pane do próprio painel. Só o `herdr-client` mostra o herdr, e o pane é o que está em foco na
    sessão dele (o foco é do servidor do herdr: com dois clientes na mesma sessão, o foco é o mesmo para os dois).
- *Armadilhas medidas:* o `post()` da base não repassa o `Retry-After`, então o componente chama `open` com `fetch` próprio
  (mesmo token e mesma renovação); o xterm 6 não traz o addon de links (o componente registra o seu provedor, uma linha
  por vez, sem URL partida entre linhas); aba oculta mede 0 colunas e não manda resize.

### Testar
`SHELL=<script>` troca o shell; `HADES_CHAT_BIN` o claude. Use `cat`/bash falso (`stty raw -echo; exec cat` devolve os
bytes idênticos). Nunca o claude nem o herdr reais. Painel de teste: `HADES_DATA=<D de teste> bun src/cli.ts panel serve
--port <porta>`; ligue a chave pelo painel local (`POST /api/config {"values":{"HADES_TERMINAL":"1"}}`).


#### Celular: barra de teclas, teclado virtual, seguir o fim
- **Barra de teclas** (`TermKeyBar`) acima do teclado virtual, só com um terminal em tela cheia no celular. Lista e ordem vêm de `HADES_TERMINAL_KEYS` (`reference/config.md`; lida de `/api/config` uma vez por carga; id desconhecido derruba a lista inteira para o padrão e a tela avisa). Cada tecla manda os bytes pelo `apiRef` do `PtyTerminal` (`send`, `paste`, `focus`, `toBottom`, `appCursor`, `copyable`): Esc `1b`, Tab `09`, Enter `0d`, setas `1b [ A..D` (`1b O A..D` se o programa ligou o modo de cursor de aplicação), Shift+Tab `1b [ Z`, Ctrl+C `03`. **Ctrl** é fixo de um toque: a próxima tecla de um caractere (da barra ou do teclado do sistema, via `apiRef.filter`) vira o byte de controle (`a-z`, `@[\\]^_` → `& 1f`, espaço → `00`, `?` → `7f`). O toque usa `mousedown.preventDefault`, então o terminal mantém o foco e o teclado não fecha.
- **Teclado virtual:** o terminal em tela cheia é `position: fixed` na caixa do `visualViewport` (`viewBox`: altura útil e deslocamento; no iOS o teclado desloca em vez de encolher a janela), a página trava a rolagem enquanto ele está aberto e o `ResizeObserver` do terminal refaz o fit e manda o tamanho novo ao servidor.
- **Seguir o fim:** o xterm segue a saída enquanto a janela está na última linha; rolando para cima ele para (`isFollowing`) e aparece **Ir ao fim** (também na mesa); tocar volta a seguir.
- **Colar e copiar no toque:** "Colar" lê `navigator.clipboard.readText()` (exige contexto seguro: o túnel é HTTPS, o `localhost` vale; sem permissão, aviso) e usa `term.paste` (respeita o bracketed paste, parte acima de 64 KiB). **Limite medido:** o xterm.js não seleciona por toque; "Copiar" leva a seleção (se houver, de mouse ou teclado) ou o texto visível na tela. Toque e segure no terminal para colar pelo menu do sistema depende do navegador. Safari/iOS real não foi testado.

## Notificações

Página **Notificações**: estado do vigia `hds-notify` (ativo, canais, silêncio, último ciclo, fonte com erro) e as 50 últimas
notificações com o resultado por canal. No grupo **Notificações** das Configurações: botões *Testar notificação* e
*Trocar tópico* (ação `notify`), e o endereço/QR do tópico do ntfy, **só no painel local** (`/api/notify` omite o
tópico e `/api/notify/qr` e a troca recusam acesso remoto). Salvar `HADES_NOTIFY` liga/desliga a unit na hora. QR exige
`qrencode`; sem ele fica o endereço. Detalhes em `reference/notify.md`.

Tour da página (§Tour por página): dez passos (resumo, canais, vigia, desktop, celular, silêncio, checagem com erro, Configurar e o histórico); sem prévia, porque os canais sempre aparecem e o histórico vazio tem `fallback`. Código: `ui/pages/notify.tour.tsx`.

## Acesso remoto

O túnel `hades-panel` (`hades-panel-<id>` com `HADES_ID`; porta do painel, 30 dias) é separado do túnel do front:

```bash
$D/tunnel.sh panel-start | panel-url | panel-stop | panel-status   # ou a página Acesso remoto
```

São duas camadas de proteção, as duas obrigatórias:
1. **Só a conta dona do devtunnel.** O `panel-start` roda `devtunnel access reset`, que remove qualquer regra anônima ou de org. Quem abre a URL sem login vai para o login do GitHub, e só a conta dona do túnel passa.
2. **Chave de acesso.** `$D/panel/remote.key` (600) só aparece no painel local. A primeira visita remota pede a chave; acertando, o painel grava um cookie `HttpOnly; Secure; SameSite=Strict` por 30 dias, derivado da chave. Trocar a chave derruba todas as sessões. Oito chaves erradas em 10 min bloqueiam novas tentativas.

Outras regras do acesso remoto:
- O servidor reconhece o remoto pelos cabeçalhos `X-Forwarded-*`, que o devtunnel acrescenta e o navegador local nunca manda, ou pelo host público.
- No remoto, o `Origin` precisa ser o host do túnel.
- Publicar, parar e trocar a chave **só funcionam no painel local**.

Tour da página (§Tour por página): onze passos (túnel, endereço, ações, as três travas, chave e as três peças do widget Android); sem prévia, porque a página sempre tem conteúdo, e todo passo leva `fallback` para quem a abre pelo acesso remoto, onde ela só mostra um aviso. Código: `ui/pages/remote.tour.tsx`.

## Cerberus

Página **Cerberus** (grupo Hades), sobre `GET /api/cerberus` (o `estado` do `hades cerberus` mais `blocos` e
`ttlH`; contrato em `reference/cerberus.md`):

- **Cabeças:** Porta, Limiar e Vigília, cada uma com o modo (muda em Configurações → Cerberus), o total de guardas, o
  último veredito e a lista das guardas (tipo, momentos, origem; `regra` aparece como "só regra escrita", com o dono
  quando é outra cabeça). Cabeça sem guarda aparece igual, com a lista vazia.
- **Blocos das cabeças:** cada `ui/cerberus/<cabeça>.tsx` presente entra depois dos cartões, registrado por
  `HadesCerberus.registerBlock(cabeça, Componente)`; bloco com erro de tela some sozinho, o resto da página segue.
- **O que cada guarda barrou:** vereditos com efeito `barra`, por guarda, com a evidência do último.
- **Exceções:** abertas, usadas e expiradas, com motivo e origem. **Abrir exceção** (guarda, momento, alvo opcional
  `k=v`, motivo de 10 a 500 caracteres) faz `POST /api/cerberus {action: "excecao", …}`; o acesso remoto recebe 400 e
  vê o botão desligado.
- **Histórico:** os 500 vereditos mais novos, filtráveis por cabeça e por efeito; a linha abre a evidência, o contexto e
  a exceção que liberou.

Tour da página (§Tour por página): treze passos (resumo, registro com erro, as cabeças, modo, traços, guardas, o que barrou, exceções, histórico e filtros) e prévia com as três cabeças, quatro guardas e cinco vereditos de exemplo; durante o tour **Abrir exceção** fica desligado e os blocos das cabeças não são montados. Código: `ui/pages/cerberus.tour.tsx`.

## Thanatos

Página **Thanatos** (grupo Hades): à esquerda a lista dos post-mortems do projeto (filtro por id ou título, tempo até a correção, lacunas),
à direita a leitura do `.md`, renderizado sem HTML cru e com só links `http(s)`. `GET /api/thanatos` devolve `{items: [...]}`
(do mais novo ao mais antigo); `GET /api/thanatos/:id` devolve `{id, markdown, postmortem}`, 404 se não existe e 400 se o id
foge de `^[A-Za-z0-9][\w.-]{0,79}$`. Só leitura, mesma autenticação das outras rotas GET (`reference/thanatos.md`).

Tour da página (§Tour por página): abre pelo `[ ? ]` do cabeçalho, `Shift+?` ou "Ver como funciona" do estado vazio; oito passos
(a página, a lista, o filtro, a linha do tempo, causa, correção, lacunas e o comando `hades thanatos new`) e prévia com dois
post-mortems de exemplo. Código: `ui/pages/thanatos.tour.tsx`.

## Tour por página

Cada página tem o seu tour, aberto pelo botão **[ ? ]** (ícone de ajuda, dica "Tour desta página") no cabeçalho da página, no
mesmo lugar para o núcleo e para o plugin (`app.tsx`, um ponto só). O botão não aparece em página sem tour. Um ponto no botão
marca o tour que ainda não foi visto nem pulado. Outras entradas: **`Shift+?`** fora de campo de texto e sem diálogo aberto; o item
**"Tour desta página"** na paleta Ctrl+K (grupo Painel) e na paleta do Argos (`panelItems`, recebe da página se há tour); e o link
**"Ver como funciona"** do `Empty` compartilhado (`<Empty tour={false}>` o tira onde o vazio é só um filtro sem resultado). O
teclado não distingue `?` de `Shift+?`: no Argos, onde `?` abre os atalhos dele, a página trata o evento em captura e o marca
(`preventDefault`), então o atalho do painel não abre e o tour se abre pela paleta. A página Argos (`stage`, sem cabeçalho) não
tem o `[ ? ]`.

**Contrato do tour** (`ui/tour-logic.tsx`, registro; `ui/tour.tsx`, o desenho). Núcleo: o arquivo `ui/pages/<id>.tour.tsx`, script
clássico como as páginas, chama `HadesCore.registerTour('<id>', { steps, preview? })`. O servidor injeta um `<script>` por
`*.tour.tsx` no marcador `<!-- page-tours -->` do `index.html` (`src/panel/ui-tours.ts`), então página nova não mexe em lista;
o `install` copia a pasta inteira. Plugin: `registerPage(id, Comp, { tour })` com o mesmo objeto; um plugin que troca uma página
do núcleo sem trazer o tour dela perde o tour do núcleo. O registro valida na entrada e falha com a página no texto.

| Campo do passo | Obrigatório | O que é |
|---|---|---|
| `id` | sim | alvo: palavra de `data-tour-step-id` no card (vários elementos com o mesmo id são destacados juntos). `tour-<página>` é o cabeçalho, que sempre existe |
| `title`, `body` | sim | texto em pt-BR, sem JSX nem HTML (cada string é uma chave de tradução em potencial) |
| `command` | não | equivalente de terminal, em mono, com copiar |
| `ref` | não | seção da referência (ex.: `panel.md › Thanatos`); o link leva à página Documentação |
| `fallback` | não | quando o alvo não existe na tela, o popover fica centralizado e mostra isto: o que falta para o card aparecer e como ligar |
| `side` | não | lado preferido do popover (`top`, `bottom`, `left`, `right`) |

**Prévia de exemplo.** `preview: () => dados` devolve os dados fictícios da página, só em página que pode aparecer vazia (as que
sempre têm conteúdo apontam para a tela real). Enquanto o tour da página roda, `HadesCore.useTourPreview('<id>')` devolve esses
dados (ou `null` fora do tour) e a página os lê no lugar dos reais; a faixa "Exemplo" no topo vem do `App` e o selo
`HadesCore.ExampleSeal` marca cada bloco de exemplo. O `post` do painel recusa com `code: 'tour_preview'` sem tocar na rede
(GET segue, a página só não o usa). Sair do tour (Concluir, Pular, ✕, Esc ou trocar de página) desliga a prévia sem recarregar.
Prévia que lança deixa o tour rodar sem exemplo.

**Progresso.** Visto (`seen`) e pulado (`skip`) por página ficam no `localStorage` do navegador (`hades-tour-pages`), só para
tirar o ponto do botão; o botão sempre reabre. Decisão: não vai ao servidor (`/api/onboard` op `tour` é um valor global do
`onboard.sh`, e um estado por página pediria arquivo novo em `$D` para uma dica de interface); nesse navegador o ponto volta se
o armazenamento for limpo.

**Celular.** O popover cabe em 390 px (largura `min(384, tela − 24)`, altura limitada à tela, com rolagem), o alvo é rolado para
a vista e arrastar o popover para a esquerda avança, para a direita volta (setas e botões de 44 px seguem valendo).

**Guarda** (`src/panel/tour-guard.ts`, testada em `loop/test/ts/painel-tour.test.ts`, que o `skill-release.sh check` já roda
na regressão): falha se uma página do núcleo não tem `pages/<id>.tour.tsx`, se o arquivo não registra o tour da própria
página, ou se um passo aponta para `data-tour-step-id` que não existe no fonte da página (o arquivo, mais a pasta `<id>/` se houver) e não
tem `fallback`. O alvo conta se o id está entre aspas na mesma linha do `data-tour-step-id`. `TOUR_PENDING` (no mesmo arquivo) lista
as páginas que ainda não têm tour, uma por linha; cada lote tira as suas ao entregar, e a consolidação exige a lista vazia
(`TOUR_REQUIRE_EMPTY=1 bun test loop/test/ts/painel-tour.test.ts`). Página fora da lista sem tour, ou na lista já com tour, falha.

**Um tour por vez.** Enquanto o tour de uma página roda, o card "Tour de 1 minuto" (o tour geral do onboarding, `Gate` em
`ui/tour.tsx`) fica escondido (`TourLogic.offerVisible`) e volta ao terminar, se a oferta ainda valia (não foi pulada nem aceita).
A guarda lê cada `.tour.tsx` transpilando o fonte e avaliando-o num escopo próprio a cada chamada (como o script clássico do
navegador), sem `import()`: o import do bun guarda o módulo por caminho e ignora `?query`, então uma segunda chamada no mesmo
processo não via o registro. Pode ser chamada várias vezes no mesmo processo (teste em `painel-tour.test.ts`).

**Roteiro para escrever o tour de uma página**
1. Leia a página e a seção dela nesta referência. Um passo por card ou funcionalidade, na ordem da tela; o primeiro é `tour-<id>`
   (para que serve a página). Texto curto: o que mostra, de onde vem o dado, o que cada ação faz.
2. Ponha `data-tour-step-id="<id>-<card>"` no card, no fonte da página (`pages/<id>.tsx`, ou na pasta `<id>/`). Id novo em
   JSX dinâmico (`{...}`) só vale se o id literal estiver na mesma linha.
3. Dê `command` quando há equivalente de terminal (`hades …`) e `ref` com a seção da referência. Dê `fallback` em todo passo cujo
   card some com a feature desligada, sem dados ou no celular: diga o que falta e como ligar.
4. Prévia só se a página pode aparecer vazia (lista, histórico, grafo, plano). A função devolve dados de exemplo no formato da
   API; marque tudo como exemplo (títulos "Exemplo: …"), sem nome de projeto, de pessoa ou de PR reais. Na página, leia
   `const exemplo = HadesCore.useTourPreview('<id>')`, use `exemplo ?? real`, ponha `<HadesCore.ExampleSeal />` nos blocos e
   não dispare `post` a partir do exemplo (ele recusa, mas desabilite o botão). Veja `thanatos.tsx` e `thanatos.tour.tsx`.
5. Tire a página de `TOUR_PENDING` (só a sua linha). `bun test loop/test/ts/painel-tour.test.ts` valida; `bunx tsc --noEmit`
   não pode ganhar erro novo. Capture o primeiro passo, um passo com prévia e um com `fallback`, na mesa e em 390 px.

## Caronte

Página do grupo Hades para levar uma orquestração a outra sessão ou máquina (`reference/caronte.md`). Código:
`src/panel/caronte.ts` (rotas), `kit/panel/ui/pages/caronte.tsx` (UI), sobre `planAgents` e `previewPack` de
`src/lib/caronte.ts`, que são a mesma regra de "agentes do plano" e "estacionado" do `hades caronte pack`.

- `GET /api/caronte`: os planos (agentes, prontidão, comando que falta, comando do pack) e os pacotes (nome, tamanho,
  data, comando do unpack). Planos são os `.md` de `~/.claude/hades/plans` sem os `.log.md`; até 100, do mais novo ao
  mais antigo. Pacotes são os `.caronte` de `HADES_CARONTE_OUT_DIR` (padrão `~/.claude/hades/caronte`); a página só
  lista, o conteúdo é cifrado e nunca é lido.
- `GET /api/caronte/plan/<nome>`: prontidão, **prévia** (partes, tamanho antes do gzip e da cifra, worktrees e o que a
  guarda de segredo barraria, só caminho e regra, nunca o valor), o prompt de retomada (`caronte brief`) e os comandos.
  Com agente trabalhando não há prévia: o pack recusaria, e a resposta nomeia o agente (`previewError.code = not_ready`).
  A prévia roda `git` de forma síncrona nas worktrees, por isso fica em cache por 30 s e é descartada depois de um park.
- `POST /api/caronte/park` `{plan, agent}`: roda `hades agent park <agente>` na worktree do agente (espera o handoff, até
  `HADES_ARGOS_ACTION_TIMEOUT_S`). Agente já estacionado ou encerrado responde `already` sem subprocesso; o mesmo agente
  duas vezes ao mesmo tempo responde 409 `busy`.
- **Validação:** nome de plano e de agente só chegam ao disco ou ao comando depois de passar pelo formato (400
  `invalid_plan`/`invalid_agent`) e de serem achados na lista (404 `unknown_plan`/`unknown_agent`); o caminho do plano é
  conferido contra o prefixo da pasta de planos. Mesma autenticação das outras rotas (GET pela chave; POST também pelo
  token e pelo Origin).
- **Acesso remoto:** a regra do Argos (`reference/argos.md`): o park executa, avisa o dono (evento `herdr` do notify) e
  grava em `$D/logs/panel-argos.log` (`acao=caronte-park alvo=<plano>/<agente>`), nunca com texto vindo do navegador.
- **A senha nunca passa pelo navegador:** nenhuma rota faz pack nem unpack. Os dois comandos aparecem prontos para copiar
  (`! hades caronte pack <plano>`, `! hades caronte unpack <arq>`) e a senha é digitada no terminal do dono.

Tour da página (§Tour por página): doze passos (resumo, planos, travessia, estacionar, o botão de segurar, empacotar, prévia, comando do pack, retomar, pacotes e prompt) e prévia com dois planos, um pacote e os detalhes de exemplo, já que sem plano a página é só um aviso; durante o tour o **Estacionar** fica desligado. Código: `ui/pages/caronte.tour.tsx`.

## Onboarding

Página **Onboarding** (menu e gaveta do celular): um card por feature (Acesso remoto, Notificações, Início automático, Contas e
loop) com o estado de cada passo (feito · pendente · não se aplica), o comando com botão de copiar, o link para a página do
painel onde o passo se faz, **Executar (Hades)** nos passos da Hades (confirmação antes; só no painel local), **Marcar como
feito** nos manuais e **Escolher** / **Pular**, que gravam o mesmo `$D/onboard.json` do `onboard.sh select|skip`.
*Verificar de novo* mede tudo na hora. `GET /api/onboard` e `POST /api/onboard` (token do painel; pelo acesso remoto valem
select, skip, done e undone, nunca executar). Nenhum segredo aparece: o estado é só feito/pendente. Catálogo e como acrescentar
um passo em `reference/onboard.md`. Tour da página (§Tour por página): nove passos (intro, escolher só marca, "Fazer o tour", resumo, recurso, fio, passo, comando e ações), sem prévia; o "Fazer o tour" é o tour de boas-vindas do painel, outro caminho. Código: `ui/pages/onboard.tour.tsx`.

**Primeira etapa:** enquanto o onboarding não está completo (`GET /api/onboard?quick=1`, campo `complete`), abrir o painel na
visão geral leva a esta página, uma vez por sessão do navegador (`sessionStorage`), e oferece o **tour** (`ui/tour.tsx`, porte
do `tonghohin/tour` em TSX próprio, sem dependência: alvo por `data-tour-step-id`, destaque, popover, Próximo/Voltar/Pular,
progresso, Esc fecha, ←/→ navegam, foco preso no popover). Pular, Esc e ✕ gravam `skipped`, Concluir grava `seen`
(`POST /api/onboard {op: "tour", value}`, também pelo acesso remoto); o botão *Fazer o tour* reabre quando quiser e `reset`
esquece. O topo da página lista o que falta ("Falta: …"). Hash vazio e `#/overview` redirecionam igual; qualquer outro hash não é redirecionado. A marca `hades-onboard-redirect` só é gravada quando o redirect acontece (abrir antes outra página não gasta o redirect da aba).

## Página Plugins

Página **Plugins** (grupo Sistema): um card por pacote da pasta de pacotes, com nome, URL do remote, branch@commit,
estado (ativo, desligado, outro projeto), faixa `core`, avisos (mudança local, commit não publicado, commits a
atualizar, perfil inválido) e o que ele acrescenta. Ações: **Adicionar por URL** (prévia com o código do que executa e
"Instalar e ativar <sha>", "Instalar desligado <sha>" ou "Guardar o pacote <sha>", conforme a prévia), **Atualizar** (commits, stat e diff do que executa), switch de ligar/desligar no pacote desta
instalação, **Remover** (digitar o nome) e **Configurar** (vai a Configurações filtrado pelo grupo das chaves do
plugin). Chama o `$D/plugins.sh`; regras, códigos e o que o desligar tira em `reference/projects.md` §Plugin do Hades.

Tour da página (§Tour por página): nove passos e prévia com dois pacotes de exemplo (selo "Exemplo", ações travadas); os passos que dependem de pacote têm `fallback`. Código: `ui/pages/plugins.tour.tsx`.

- **Acesso remoto:** só leitura, com aviso na página; o `POST /api/plugins` responde 403 `plugins_local_only`.
- **Execução:** o que muda roda como execução exclusiva (409 com outra de ciclo em curso). Ao terminar, a lista é relida
  e um aviso oferece recarregar a página (o painel reiniciou com as páginas e rotas novas do plugin).
- **Unit dos jobs:** `HADES_JOB_UNIT` no ambiente do painel troca o prefixo `hds-pjob` (instalação de teste de uma
  unidade da skill: `skilldev-<unidade>-job`), como o `HADES_CHAT_UNIT` do chat.

## Instalar como app (PWA)

O painel é um PWA: abre em tela cheia, com ícone próprio, a partir do acesso remoto.

1. No celular, abra a URL do túnel (`$D/tunnel.sh panel-url`), entre com a conta do devtunnel e cole a chave de acesso.
2. Android/Chrome: menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial"). iOS/Safari: Compartilhar → **Adicionar à Tela de Início**.
3. Abra pelo ícone. O Hades recarrega os dados sozinho; a chave vale 30 dias (cookie), depois pede de novo.

Como funciona (`ui/manifest.webmanifest`, `ui/sw.js`, ícones em `ui/brand/`):
- O service worker só guarda a **casca estática** (`/ui/*`: app, bibliotecas, ícones), com rede primeiro e o cache como reserva. **Nunca** `/api/*`, nunca `/` (o `index.html` leva o token do painel) e nunca resposta que não seja 200. Sem rede, a navegação mostra "Sem conexão com o Hades" (`ui/offline.html`).
- O servidor serve o `sw.js` também em `/sw.js` (escopo `/`) e troca `__UI_HASH__` por um hash dos arquivos da UI: editou a UI, o cache antigo é descartado sozinho na próxima abertura.
- Pelo túnel, manifest, `sw.js` e `/ui/*` só saem com o cookie da sessão (sem ele, 401). Por isso o `<link rel=manifest>` leva `crossorigin="use-credentials"`: o padrão buscaria o manifest sem cookie.
- Service worker exige HTTPS ou `localhost`: o túnel serve, o `http://<ip-da-lan>` não. No `127.0.0.1` dá para testar.
- No celular (`max-width: 767px` ou ponteiro grosso) o CSS de `index.html` garante alvos de toque de 40 px e a navegação lateral vira gaveta (botão ☰). Notificação push não existe: o canal do celular é o ntfy.

## API do diário

Sem página própria (os eventos aparecem no detalhe do nó do Argos, `#/argos`). `GET /api/journal?agent=&since=&kind=&limit=` devolve `{events: [...]}` do diário
(`reference/journal.md`), os mais recentes em ordem de tempo; `limit` de 1 a 500 (padrão 100), acima disso 400 (o teto é do
servidor); `since` é duração (`30m`, `2h`, `1d`) ou ISO. `GET /api/journal/stream?agent=` (`agent` obrigatório) é SSE da faixa ao vivo: um
`data:` por evento, `id:` = offset no arquivo (`Last-Event-ID` retoma), até 20 streams (acima, 429 com `Retry-After`).
Mesma autenticação das outras rotas GET, inclusive pelo túnel; só leitura.

## API do Argos

A página é `#/argos` (`reference/argos.md` §A página). O servidor expõe `GET /api/argos/graph` (nós e arestas dos agentes, unidades, gates e PRs),
`GET /api/argos/node/<id>?since=&limit=` (detalhe: faixa do diário, herdr, PR, brief/report/questions) e
`POST /api/argos/action` (`{node, action, args, confirm?}`, lista fechada). Contrato, esquema versionado, códigos de erro
e a regra do acesso remoto (sem trava: executa, notifica e grava em `$D/logs/panel-argos.log`): `reference/argos.md`.
Mesma autenticação das outras rotas: GET pela chave, POST também pelo token do painel e pelo Origin.
O documento do canvas tem rota própria: `GET`/`PUT /api/canvas` (`reference/argos.md` §Documento do canvas); o `PUT` segue a regra do POST (chave, token e Origin).
Terminais criados no canvas, papéis e predefinições: `GET /api/argos/presets|roles` e os `POST /api/argos/terminals*`,
`/api/argos/roles*` e `/api/argos/presets*` (`reference/argos.md` §Terminais criados no canvas); pelo acesso remoto as três
rotas de terminal exigem `confirm` com o nome do nó e avisam o dono.
`GET /api/argos/terminals/orphans` lista terminais vivos sem nó em canvas nenhum; a tela oferece "Trazer para o canvas" (`reference/argos.md` §Terminal fora do canvas).

## Widget Android

O painel serve a API que o widget de tela inicial lê e declara atalhos no PWA. Aqui fica só o contrato HTTP; o código Android, a instalação do APK e o primeiro uso (token, URL) estão em `reference/android-widget.md` §Instalar e configurar.

**Rota:** `GET /api/widget`, só leitura, com `Authorization: Bearer <token do widget>`. O token **nunca** vai na query
string. Atende no painel local, no host do túnel do painel (sem o cookie da chave de acesso; o login do devtunnel ainda
vale lá) e no **listener do widget** (§Passagem pela internet), o caminho do celular. Respostas: `200` o JSON;
`404 widget_off` sem token configurado (a rota fecha); `401 widget_token` token ausente ou errado; `429
widget_rate_limited` com `Retry-After` (segundos até o IP poder tentar de novo, no máximo 600) depois de 8 tokens
errados em 10 min **do mesmo IP** (o contador é por IP, nas duas portas). Erros levam `code` estável, que só ganha valores.

**Token do widget:** `hdw_…` (256 bits), só leitura e **só nessa rota**: em qualquer outra (GET ou POST, local ou
remota) o servidor responde `403 widget_token_scope`, mesmo com o token certo. Criar e revogar só pelo painel local
(página Acesso remoto → *Token do widget Android*; `POST /api/widget/token` `{op: create|revoke}` com o token do
painel). Pelo acesso remoto, `403 widget_local_only`. O disco guarda só o **hash** (SHA-256) e a data, em
`$D/panel/widget-token.json` (600, fora do que o `install.sh` toca); o token aparece uma vez, ao gerar, e a
comparação é em tempo constante (`timingSafeEqual`). Gerar de novo invalida o anterior. Criação e revogação vão
para `$D/logs/panel-widget.log` (hora UTC e fato, nunca o token). `GET /api/widget/token` devolve só
`{configured, createdAt}`.

**Contrato do JSON (versão 1; campos só se acrescentam, nunca mudam de significado nem somem):**

| Campo | Tipo | Significado |
|---|---|---|
| `version` | int | versão do contrato (1) |
| `updatedAt` | string ISO 8601 UTC (`…Z`) | instante em que o servidor montou a resposta |
| `available` | bool | `false` se este projeto não tem orquestração (sem agentes nem eventos) |
| `counts` | `{active, stopped, asking}` de int | quantos agentes em cada estado |
| `agents[]` | objetos | agentes **não encerrados** (`done`/`archived` saem), na ordem do registro |
| `agents[].name` | string | nome do agente |
| `agents[].role` | string \| null | papel (`impl`, `review`…) |
| `agents[].state` | `active` \| `stopped` \| `asking` | `asking`: pergunta aberta ao dono ou agente esperando o dono; `active`: trabalhando; `stopped`: ocioso ou fora do herdr. O cliente trata valor desconhecido como `stopped` |
| `agents[].since` | string UTC \| null | último prompt, ou adoção, ou criação (o primeiro que existir) |
| `agents[].ageSeconds` | int \| null | segundos desde `since` (≥ 0) |
| `agents[].openQuestions` | int | perguntas abertas em `questions.md` |
| `events[]` | objetos | os mais novos primeiro, no máximo `HADES_WIDGET_EVENTS` (8) |
| `events[].at` | string UTC | instante do evento |
| `events[].type` | `allocated` \| `adopted` \| `prompted` \| `escalated` \| `done` \| `archived` | marca do registro do agente; o cliente ignora tipo desconhecido |
| `events[].agent`, `events[].role` | string, string \| null | agente do evento |
| `system` | objeto | seção do widget Sistema (acrescentada depois; painel antigo não a manda). Cada parte pode ser `null` quando a fonte não existe |
| `system.memory` | `{totalBytes, usedBytes, availableBytes}` \| null | memória da máquina (`MemTotal`/`MemAvailable`; usado = total − disponível) |
| `system.infra.services` | `{enabled, up, required, requiredUp, down[]}` | serviços **ligados** (`services.enabled`) de pé e prontos (`/health/ready`), contra os obrigatórios; `down` traz só os nomes dos ligados que não estão de pé |
| `system.infra.containers` | `{total, up, down[]}` | containers de longa duração do compose (fora os `-init` e os opcionais do plugin); `down` = nome do serviço |
| `system.queue` | `{running, waiting}` | fila de builds: `running` = `{label, ageSeconds, rssBytes}` do gate ativo (ou `null`), `waiting` = quantos esperam |
| `prs` | objeto | seção do widget PRs: as **minhas** PRs abertas **fora de draft** (as mesmas do loop) |
| `prs.available` | bool | `false` até a primeira coleta terminar (ou se ela falhou sem nunca ter dado certo); `items` vem vazio |
| `prs.fetchedAt`, `prs.ageSeconds` | string UTC \| null, int \| null | instante da última coleta **boa** e a idade dela na resposta; o widget mostra a idade |
| `prs.error` | string \| null | `collector_failed` quando a última coleta falhou (o `items` é o último dado bom); o código só ganha valores, o detalhe fica só no `panel.log`, não no log de auditoria do widget |
| `prs.items[]` | objetos, no máximo 20 | na ordem do coletor (as que pedem ação primeiro) |
| `prs.items[].number`, `.title` | int, string | número e título (até 120 caracteres) |
| `prs.items[].reviewPending` | bool | há o que olhar: thread aberta, comentário vivo ou review novo não visto |
| `prs.items[].ci` | `green` \| `failing` \| `running` \| `none` | **só o CI do GitHub** (rollup de checks; o gate local não entra); `none` = sem CI ou sem check. O cliente trata valor desconhecido como `none` |

**Cache das PRs (seção `prs`):** o `gh` **nunca** roda na leitura do widget. O painel guarda a última coleta em memória e,
vencido o TTL (`HADES_WIDGET_PRS_TTL`, padrão e mínimo 300 s = `GH_TTL`), dispara **uma** thread com o coletor do loop
(`node hades pr-loop-state --json`, só pela linha de comando, no clone do projeto). A leitura devolve na hora o que
há; a primeira, antes da coleta terminar, traz `prs.available: false`. Falha do coletor mantém o último dado bom (com
`prs.error`) e conta como tentativa: não repete antes do próximo TTL. A seção `system` sai só de dados que o painel já
mantém (fila e amostrador), sem custo novo. O listener anônimo do widget passa a expor títulos de PR e nomes de serviço,
sempre atrás do token (`401`, `403 widget_token_scope`, `429 widget_rate_limited` como antes).

Exemplo: `{"version":1,"updatedAt":"2026-10-26T07:33:20Z","available":true,"counts":{"active":1,"stopped":0,"asking":1},
"agents":[{"name":"impl-a","role":"impl","state":"active","since":"2026-10-26T06:00:00Z","ageSeconds":5600,
"openQuestions":0}],"events":[{"at":"2026-10-26T06:00:00Z","type":"prompted","agent":"impl-a","role":"impl"}]}`.

**Atalhos do PWA:** `shortcuts` no `ui/manifest.webmanifest`: *Orquestração* (`/#/orchestration`, nome curto *Loop*),
*Herdr* (`/#/herdr`) e *Claude* (`/#/claude`). O Android lê o manifest na instalação; para ver atalhos novos num app
já instalado, reinstale-o (o Chrome só reatualiza o manifest de tempos em tempos).

**Passagem pela internet (listener e túnel dedicados):** o devtunnel exige login GitHub e o connect token (`devtunnel
token --scopes connect`, header `X-Tunnel-Authorization`) vale ~24 h e o celular não o renova; por isso o widget tem
um **túnel anônimo só dele**, com o token do widget como única autenticação.
- **Listener próprio** no servidor, em `127.0.0.1:HADES_WIDGET_PORT` (padrão 21221; instância extra ganha a primeira
  porta livre no install, fora das portas de painel e de widget das outras). Responde **só** `GET /api/widget`, com a
  mesma lógica e o mesmo contrato v1; outro método ou caminho → `404 not_found`. Sem cookie, sem chave de acesso, sem token
  do painel. Sobe mesmo sem token (responde `404 widget_off`). Porta ocupada, inválida ou igual à do painel: o painel
  sobe sem o listener e o aviso vai ao `panel.log` (o widget não derruba o painel).
- **Bloqueio por IP:** `X-Forwarded-For` (conta o primeiro e o último valor: o do cliente e o que a borda anexou; um
  IP bloqueado em qualquer dos dois barra; sem o header, o endereço do socket), 8 tokens errados em
  10 min → `429` com `Retry-After`. A tabela de IPs tem teto (1024; expira a janela e descarta os mais antigos).
  Quem não manda token (401 sem Bearer) não conta, só token errado.
- **Túnel** `hades-widget` (porta `HADES_WIDGET_PORT`, unit `hds-widget-tunnel`): `tunnel.sh widget-*`
  (`reference/tunnel.md` §Túnel do widget). O túnel do painel **não** ganha regra anônima. Publicar e renovar são do dono;
  o Cerberus (guarda `tunel-acesso`) vê `acesso=anonimo` e só deixa passar com exceção do dono.
- **Card do Acesso remoto → Token do widget:** mostra a URL do túnel do widget (`…/api/widget`, copiável), o estado
  (no ar / fora do ar / acesso vencido) e quando o acesso expira (`$D/widget-tunnel.expires`, gravado por
  `tunnel.sh widget-stamp`). A data de criação do token usa o formato de data do resto do painel.

**Armadilhas:** o `Authorization` do cliente passa pelo devtunnel (ele usa `X-Tunnel-Authorization`); o token do
widget não substitui o login do túnel do painel (no túnel do widget não há login, só o token). Trocar a porta ou o host
do painel não muda o token. `X-Forwarded-For` é o que o devtunnel acrescenta; o cliente escolhe os valores à esquerda, por isso o bloqueio
conta também o último. O token de 256 bits é a barreira; o bloqueio limita o ruído. Trocar `HADES_WIDGET_PORT` exige reiniciar o painel e refazer `widget-create` (a porta do
túnel é outra).

### Baixar o APK

O painel entrega o APK do widget (`$D/android/hades-widget.apk`, gerado por `kit/android/build.sh`) para o dono
instalar pelo celular, no navegador ou no PWA, pelo acesso remoto.
- **Rotas** (só no painel, com a mesma autorização do resto: local, ou remoto com o cookie da chave de acesso; sem ele
  `401`): `GET /api/widget/apk/download` serve o arquivo com `Content-Type: application/vnd.android.package-archive`,
  `Content-Disposition: attachment; filename="hades-widget-<versionName>.apk"` (sem versão confiável, `hades-widget.apk`)
  e `Cache-Control: no-store`; `HEAD` na mesma rota devolve só os cabeçalhos. Sem APK: `404 apk_missing` com a mensagem
  "use Gerar APK" e nenhum caminho no corpo. `GET /api/widget/apk` devolve os metadados em JSON.
- **Nunca** pelo listener do widget (porta `HADES_WIDGET_PORT`, só `GET /api/widget`: o resto é `404`) nem pelo token do
  widget (`403 widget_token_scope`, como em toda rota fora de `/api/widget`).
- **Metadados:** `exists`, `size`, `sha256` (do arquivo, cacheado por mtime e tamanho), `versionName`, `versionCode`,
  `builtAt` (UTC), `certSha256` (impressão SHA-256 do certificado de assinatura), `kitVersion` e `outdated`. Versão, data
  e certificado vêm do sidecar `hades-widget.apk.json`, gravado pelo `build.sh` ao fim do build; só valem se o `sha256`
  dele é o do arquivo (um APK trocado à mão não herda a versão). `outdated` é verdadeiro quando o hash dos fontes do
  widget instalado (`$D/android/widget`, sem `build/` e `.gradle`, a mesma conta do `sources_sha` do `build.sh`) difere
  do que o sidecar guardou, ou quando não há sidecar: o kit mudou depois do build, gere de novo.
- **Card "App do widget"** (Visão geral, logo abaixo dos indicadores, e Acesso remoto, abaixo do token; um componente só,
  `ui/widget-apk.tsx`, exposto em `HadesCore.WidgetApk`): versão, data, tamanho, SHA-256 e certificado curtos (cópia
  do completo), aviso de desatualizado, **Baixar APK** (link direto, `download`) e **Gerar APK**
  (`POST /api/action {action: "widget-apk"}` com o token do painel → `android/build.sh build`, pela fila de builds,
  como as outras ações: aviso de execução iniciada, log e aviso ao terminar; o card relê ao começar e ao terminar).
  Traz o resumo da instalação (passo a passo em `reference/android-widget.md` §Instalar e configurar).
- **Armadilhas:** gerar exige Docker na máquina do painel; o APK serve o que está em `$D/android/`, nunca a pasta de
  outra instância (a keystore de lá é a identidade do app do celular do dono).

## Plugin: páginas, rotas e ações

O plugin do projeto declara páginas em `plugin.json → panel.pages` (id, rótulo, ícone lucide, grupo, `after`, script)
e as registra no script dele (`window.HadesPanel.registerPage`); diálogos avulsos vêm de `panel.scripts`
(`registerDialog`). O contrato inteiro (manifesto, `HadesPanel`, `panel/api.ts`, rotas) está em `reference/projects.md`
§Plugin do Hades. O que a UI do núcleo garante:

- **Boot:** `GET /api/plugin` (manifesto público, sem caminho nem código), depois cada script de `/plugin/ui/<nome>.js`
  (só `^[\w-]+\.js$`, um por vez, 10 s de teto; script que falha ou demora fica de fora, o resto sobe), e só então o
  primeiro render. Sem plugin, o painel é o do núcleo.
- **Sidebar:** só entra página declarada **e** registrada; id do núcleo vence; grupo pelo id ou rótulo, grupo novo antes
  de Sistema; `after` posiciona dentro do grupo. Contador da página vem do `badge` do `registerPage`, dentro de `try`.
- **Isolamento:** cada página e diálogo do plugin roda dentro de um error boundary.
- **Rotas** `/api/plugin/<rota>` (GET e POST) passam pela mesma chave do acesso remoto e, no POST, pelo mesmo token das
  ações; rota com `local: true` responde 403 (`plugin_local_only`) pelo acesso remoto. Erro do plugin vira 500 com
  `code: plugin_error` e o detalhe fica só no `panel.log`, não no log de auditoria do widget; rota desconhecida, 404 `plugin_not_found`.
- **Ações** do plugin (`panel.actions`) entram pelo mesmo `POST /api/action`: o `panel/api.ts` valida e devolve título,
  script e se é de ciclo; pedido fora da lista dele é 400.

### Host do plugin (`panel/api.ts`)

O painel em TypeScript fala com o plugin por um processo auxiliar, uma chamada por vez, em JSON de linha: `api.ts` →
`src/panel/plugin-host-child.ts` (Bun). Plugin com `api.py` ou `core` que aceita `<5` é recusado (`legacy_api_py`, `core_out_of_range`).
Auxiliar que não sobe ou que estoura o tempo (30 s) é morto e relançado na chamada seguinte; o painel segue.

## Segurança local

O painel só escuta em `127.0.0.1` e confere o `Host` (contra DNS rebinding) e o `Origin`. Toda ação é `POST` JSON com o token do painel (`X-Panel-Token`), embutido na página e ilegível para outra origem.

Argumentos vêm de listas fechadas: serviços do catálogo, containers do projeto, PRs numéricas, autor `[A-Za-z0-9-]`. Logs só são servidos por nome validado. Nada no painel lê ou mostra `root.env`, `credenciais.md` ou tokens.

## Estrutura da tela

Para editar a tela, mexa no arquivo `.tsx` da página e recarregue o navegador: o servidor transpila `/ui/<x>.js` a partir de `<x>.tsx` (Bun, JSX clássico, cache por mtime), sem etapa de build. Com `<x>.js` e `<x>.tsx` lado a lado, o `.tsx` vence (um `.js` de instalação antiga não sombreia a UI atual); `.js` sem `.tsx` (vendor, `sw.js`) sai como está. O install também remove esses `.js` sombreados (`reference/cli.md`, linha `install`). Só o servidor (`src/panel/`) exige `panel.sh restart`. Os tipos base ficam em `ui/globals.d.ts` (`bun x tsc -p tsconfig.ui.json`); as páginas ainda não são checadas por tipos. Para conferir a tela em headless, veja §Armadilhas.

- **Uma página:** `ui/pages/<id>.tsx`, o id da rota (`#/<id>`): os 22 itens de `CORE_NAV` (§Páginas). O arquivo traz a página e o que só ela usa (diálogos, folhas, tabelas de rótulo), pega da base o resto pelo `window.HadesCore` (a desestruturação na linha 3 diz o quê) e termina em `HadesCore.registerPage('<id>', Componente)`, o mesmo `registerPage` das páginas do plugin: um registro só, e a página do plugin com o mesmo id substitui a do núcleo.
- **A base:** `ui/app.tsx`: primitivas (`Button`, `Card`, `Dialog`, `Sheet`…), formatadores, `post`/`getJSON`, o que duas ou mais páginas usam (gráfico, seletor de PRs, terminal, visor de log, markdown, `Segmented`), `CORE_NAV` e grupos da sidebar, `route()`, o `App` (snapshot, toasts, diálogos, atalhos, paleta de comandos) e o `window.HadesPanel` dos plugins. Componente que uma segunda página passa a usar sobe para a base e entra no `HadesCore`.
- **Página nova:** item em `CORE_NAV`/`CORE_GROUPS`, arquivo em `ui/pages/` e a tag `<script>` no `index.html`, depois do `app.js` (a ordem entre as páginas não importa). O `App` só renderiza no `DOMContentLoaded`, quando todas já rodaram.

## Tema e ícone

Dois temas desenhados: **Érebo** (escuro, o principal) e **Marfim** (claro). Tudo mora no `<style>` do `ui/index.html`:
os tokens em `:root` (claro) e `.dark` (escuro) e o mapeamento `@theme inline` (`--color-*`, `--radius-*`, `--font-*`).
Os nomes são os do shadcn, com o sentido do Hades:

- `--primary` é o vinho `#391a2c` no claro e o metal `#ffc6df` no escuro; `--accent` é só o fundo de hover, não cor de marca.
- `--vivo` (o rosa `oklch(0.586 0.253 17.585)` no escuro) é **só o que está vivo**: fio fiando, ponto que pulsa, foco
  (`--ring`). Nada estático usa rosa.
- `--metal` (`#ffc6df`) é o metal da abertura: marca, óbolo, brilho do fio fiando. `--metal-ink` é o metal legível sobre o
  marfim (série de gráfico, traço e nós do fio fiando; no escuro é o próprio metal).
- `--border-strong` (contorno de controle), `--rail-muted` (rótulo no trilho), `--term*` (o terminal é escuro nos dois
  temas: erro e aviso dele usam `--term-bad`/`--term-warn`), `--ok`/`--warn`/`--bad`/`--info` para estado.
- `--chart-1..5` = vivo, info, warn, ok, metal-ink; `--s1..s4` são apelidos deles.
- **Raio 0 em tudo** (`--radius: 0`). Redondo só de propósito: `rounded-full` em ponto de estado, ponto vivo e óbolo; o switch é quadrado.

- **Cor sai do token, nunca de classe fixa.** Nada de `zinc-*`, `emerald-*`, hex ou `oklch` literal em
  `app.tsx`/`pages/`; use `bg-primary`, `text-ok`, `text-chart-2`. Tracejado em CSS sempre por `mask` (gradiente com
  `oklch` e `transparent` não pinta no Firefox).
- **Sidebar** nos tokens `sidebar-*` e `--rail-muted`: o trilho é vinho `#391a2c` com tinta marfim nos dois temas.
- **Card do slice** minimizável (botão com `aria-expanded`): estado em `localStorage` (`panel-sidebar-slice-min`), como o
  trilho e os grupos; sem chave no `config.tsv`. No trilho continua só o % e a barra.
- **Claude e Herdr, uma coisa por vez** (`mobile-term.tsx`, `HadesCore.Mobile`): abaixo de 768 px a página tem dois níveis, **lista** (conversas; terminais abertos; workspaces) e **detalhe** (conversa, terminal ou painel de agente em tela cheia). Entrar no detalhe empilha uma entrada no histórico (`history.pushState`, mesma URL); o voltar do sistema e a seta do cabeçalho voltam à lista sem sair da página. O lado a lado da mesa não existe no celular (uma sessão por vez; trocar é voltar e escolher). Regra pura em `term-logic.tsx` (`navStep`, `isMobileWidth`). Limite: ao sair da página com o detalhe aberto sobra uma entrada de histórico (um voltar sem efeito).
- **Ícone:** `ui/brand/hades.svg` (fundo quadrado incluso, serve aos dois temas) é favicon (`type="image/svg+xml"`),
  marca da sidebar e do trilho. Os PNG (`icon-192`, `icon-512`, `icon-maskable-512` com o glifo a 80% para a zona
  segura, `apple-touch-icon`, `favicon-32`) saem do SVG com `rsvg-convert -w <n> -h <n>`. `theme_color` e
  `background_color` do manifest, e a `theme-color` escura do `index.html`, são o `--background` escuro.
- **Ícone do Cerberus:** `ui/brand/cerberus.svg` (só a figura, `currentColor`, polilinha simplificada) é o `I.Cerberus` do
  `app.tsx` (sidebar e grupo em Configurações); `cerberus-color.svg` (fundo `#4e131b` + figura) fica para uso futuro.

## Layout no celular (390 px)

A tela é conferida a **390 px** (celular) e a **1440 px** (desktop); abaixo de 768 px (`md:`) a sidebar vira gaveta. Regras para página nova:
- **Sem rolagem horizontal da página.** Fila de botões usa `flex-wrap`; item de grid já encolhe (`:where(.grid) > *`); texto longo leva `truncate` ou `min-w-0`.
- **Tabela larga:** `Table` já rola dentro do próprio card (`overflow-x-auto`); lista densa vira cartão empilhado (`grid` de uma coluna no celular, colunas só de `sm:` para cima).
- **Alvo de toque:** `Button`, `Input` e o `Select` têm 44 px no celular (`max-md:h-11`); botão cru, `select`, link da navegação e link externo ganham piso de 40 px pela regra `@media (max-width: 767px), (pointer: coarse)` do `index.html`. Chave, caixa e fechar mantêm o desenho e só ampliam a área (`::after`).
- **Diálogo** limita a altura a `100dvh − 2rem` e rola por dentro; a busca Ctrl K gruda no topo no celular, para o teclado não cobri-la.
- **Cabeçalho:** o estado geral vira só o ponto; o texto fica para `sm:` (leitor de tela e tooltip mantêm).

## Tipografia

Tamanho e peso saem de um papel, nunca de `text-xs`, `text-sm`, `text-[13px]` ou de um par
`text-* font-*` solto. Os papéis são `@utility t-*` em `ui/index.html` sobre tokens `--fs-*` em rem: `t-page-title` (h1),
`t-section-lg` e `t-section` (títulos), `t-body-strong`, `t-body` (texto e descrição), `t-label` (nav, aba, botão, nome
de campo; 13px em 500), `t-meta` e `t-meta-em` (hora, contagem, caminho, selo), `t-micro` (eixo, Kbd), `t-data` (número,
tempo, id em mono tabular), `t-kpi` (número grande), `t-code` e `t-code-doc` (log, comando, `<pre>`), `t-prose` (Docs,
Thanatos, chat). Um papel por elemento (dois brigam pela ordem do CSS); `leading-*`, `font-*` e `truncate` soltos vencem o
papel e servem de exceção. CSS de efeito em `fx/` lê `var(--fs-label)` e afins em vez de px. Títulos levam
`text-wrap: balance` e texto `pretty` (já vêm no papel e na base do `index.html`). Prosa de leitura: medida de até 68ch.
Famílias (Figtree, Marcellus só no `h1` e na marca, Geist Mono para dado e código) não se trocam por página.

## Linguagem de componentes (`app.tsx`, no `HadesCore`)
Uma página nova usa estes, na ordem em que a leitura pede: estado primeiro, depois o que vive, depois a lista.
- **Seções no chão:** `Card` é título + filete (`CardHeader`: `title`, `summary` na linha do título, `action`, `as`),
  sem fundo nem borda. `Card variant="object"` (fundo e borda) só para um objeto que existe: gate, agente, guarda, PR,
  unit (`Svc`). `CardContent` não tem padding. A página não repete o h1, que o app desenha (Marcellus).
- **Estado:** `LinhaDeEstado` (o número que importa e os vizinhos apagados, numa frase) no lugar de faixa de KPIs;
  `Regua` + `Leitura` (`value`, `unit`, `detail`, `format`, `decimals`, `onClick`) quando há 2 a 4 leituras com forma;
  `Tracos` (um traço por unidade, `ok|warn|bad|idle`, a altura diz a gravidade); `Num` conta ao mudar.
- **Atividade:** `Fio` (`s`: `fiando` rodando, `medido` concluído com nós, `cortado` falhou no ponto da falha, `frouxo`
  esperando, `parado`; sempre com `label`). `jobFio(j, jobs)` dá o fio de uma execução: o corte fica na proporção da
  duração sobre a mediana das execuções ok da mesma ação (70% sem histórico). `JobRow` desenha o fio.
- **Linhas:** item de lista com `border-b`; selecionado com `border-l-2 border-l-foreground bg-accent/40`; o link
  estica pela linha (`after:absolute after:inset-0`) e as ações aparecem no hover/foco sem mudar a altura.
- **Controles:** `Button` (h-8, `outline` com `border-strong`, foco em contorno de 2 px `ring`), `Segmented`, e
  `Choice` (`Segmented` na mesa, `Select` no celular; a largura vem de `useWide(px)`), `Legend` com traço, `Empty` em
  uma linha com a ação que resolve, `Progress` reto. `PrPicker` (`sel`, `toggle`, `applied`, `inSet`, `onItems`
  opcional) é o seletor de PRs de qualquer página: cada PR é um checkbox, o erro do `gh` sai em palavras.
- **Escalas:** `niceTicks(max, n)` dá passos redondos até `max`; `niceTicksCovering(max, n)` passa de `max` quando a
  escala não pode cortar a maior coluna.
- **Barra presa no rodapé:** com uma execução rodando, a pílula dela fica no canto e o shell expõe `--dock`; a barra
  usa `bottom-[calc(1rem+var(--dock,0rem))]` para subir por cima dela.
- **Movimento:** com sentido (fio correndo, ponto descendo, óbolo deslizando, número contando); nada de entrada
  escalonada. Efeito decorativo só por `HadesFx.use`, respeitando `prefers-reduced-motion` e `saveData`.
- `Kpi`, `QuickAction`, `JobRow`, `Svc` e `TunnelCard` continuam exportados para plugins.

## Select
O `Select` (`app.tsx`, em `HadesCore` e `window.HadesPanel`) substitui o select nativo: gatilho e lista saem do painel, com os
tokens do tema, igual em qualquer navegador e dispositivo. Regra do teclado e da busca em `ui/select-logic.tsx` (função pura,
`window.SelectLogic`, carregada antes do `app.js`; testada em `loop/test/ts/painel-select.test.ts`).

| prop | |
|---|---|
| `value`, `onChange(value)` | sempre texto, como no nativo (número: `value={String(n)}`, `onChange={(v) => setN(+v)}`) |
| `items` | `{ value, label, count?, icon?, hint?, disabled?, group? }[]`; `count` aparece no gatilho como `rótulo (n)` |
| `label` | `aria-label` do gatilho e da lista (e título da folha no celular) |
| `size` | `sm` (h-8, toolbar) ou o padrão (h-11); abaixo de `md` (768 px) é sempre h-11 |
| `placeholder` | texto do gatilho quando `value` não casa com nenhuma opção (inclui `value=""`) |
| `disabled`, `className`, `id`, `autoFocus` | repassados ao gatilho |
| `ref` | encaminhado ao gatilho (`ref.current.focus()`) |

- **Mesa:** popover fixo no `body` (portal, não é cortado por `overflow` nem por diálogo), abre para cima se faltar espaço
  embaixo; fecha ao clicar fora, rolar a página ou redimensionar. **Celular** (< 768 px): `Sheet side="bottom"` com opções de 44 px.
- **Grupos:** `group` no item; itens do mesmo grupo ficam juntos (ordem da primeira aparição) sob um cabeçalho. Sem `group`, sem cabeçalho.
- **Busca:** campo no topo da lista quando há mais de 10 opções (`SEARCH_MIN_OPTIONS`); casa rótulo, dica e grupo sem acento nem caixa.
- **Teclado** (combobox/listbox da WAI-ARIA): no gatilho, setas/Enter/Espaço/Home/End abrem; na lista, setas andam (sem dar a
  volta, pulando as desabilitadas), Home/End/PageUp/PageDown, Enter ou Espaço escolhem, Tab escolhe e segue, Esc fecha e devolve o
  foco ao gatilho (sem fechar o diálogo em volta). Digitar pula para a opção que começa pelo texto (pausa de 700 ms zera;
  letra repetida percorre). Com busca, o texto e o Espaço vão ao campo.
- **Guarda** (`src/panel/select-guard.ts`, no `loop/test/ts/painel-select.test.ts`, que o `skill-release.sh check` já roda):
  falha se aparecer o elemento nativo em `kit/panel/ui/` fora de `vendor/`, a menos que o arquivo esteja em `SELECT_PENDING`; e
  falha se um arquivo da lista não tiver mais o nativo (a lista não mente). A migração está feita: `SELECT_PENDING` está vazia. `SELECT_REQUIRE_EMPTY=1` exige a lista vazia. É busca
  de texto (comentário e string contam): em prosa escreva "select nativo". Plugins ficam de fora; usam `HadesPanel.Select`.

**Roteiro de conversão** (guia para código novo ou vindo de fora: nativo → `Select`):
1. `options` viram `items`: `<option value="x">Rótulo</option>` → `{ value: 'x', label: 'Rótulo' }`; `disabled` da opção vai no item.
2. `onChange={(e) => f(e.target.value)}` → `onChange={f}`. `aria-label` vira `label`. `className` de altura/borda sai (o tamanho é
   `size`); fica só largura (`min-w-0`, `w-full`).
3. **`value=""` com opção "escolha…":** apague a opção vazia e passe `placeholder` ("Ir para a seção"); o `Select` mostra o placeholder
   enquanto o valor não casa e chama `onChange` com a opção escolhida (a página zera o estado depois, como já fazia).
4. **`optgroup`:** `group: 'Nome'` em cada item do grupo.
5. **`ref`/foco:** `ref={ref}` vai direto ao gatilho (`first.current?.focus()` continua valendo).
6. **Valor numérico:** converta na borda (`String(n)` / `+v`). **`disabled`:** igual; o gatilho já tem estilo.

## Componentes do painel (`panel/ui/fx/`)
Escritos para o painel em `.tsx` sobre o React do `vendor/`, um arquivo por componente, sem bundler
nem CDN. Só mudam a forma de acionar: rotas, autenticação e regra do acesso remoto são as mesmas.
- **Hold Button** (`fx/hold-button.tsx`, `HoldConfirm` no `app.tsx`): confirma segurando (mouse, toque, Espaço/Enter). Fica
  dentro do diálogo de confirmação `danger`, no lugar do botão Executar; Herdr (Parar/Apagar sessão), Caronte (Estacionar)
  e Argos usam. **Não substitui a confirmação por nome digitado**: onde ela existe o campo continua e o Hold só habilita com
  o nome correto. Sem o fx carregado, cai no botão comum: a confirmação nunca some.
- **Bell Toggle** (`fx/bell-toggle.tsx`): as chaves `HADES_NOTIFY*` booleanas em Configurações > Notificações.
- **Code Slots** (`fx/code-slots.tsx`): token do widget e chave de acesso em Acesso remoto, somente leitura (`disabled`
  aqui significa só leitura, sem esmaecer, para manter o contraste); a chave vem mascarada até "Mostrar".
- **Prompt Bar** (`fx/prompt-bar.tsx`): campo de envio do chat do Claude, do painel de agente do Herdr e da ação `prompt`
  do Argos. O rascunho é limpo ao enviar; em erro de envio só há toast.
- **Abertura** (`fx/intro.tsx`): Waves ao fundo e o ícone do Hades (`brand/hades-mark.svg`, só a figura sobre fundo transparente) em Metallic Paint (até 480 px, tinta `#ffc6df`, dispersion 0.11, angle 46°, density 1.4), **a cada carregamento da página**, F5
  incluso; a navegação entre páginas do painel não recarrega e não a repete. Pulada com `prefers-reduced-motion`, `saveData` ou sem WebGL2; os efeitos só são baixados se a
  abertura vai rodar, então não bloqueia a primeira pintura.
- **Fade Content** (`fx/fade-content.tsx`, `FadeSlot` no `app.tsx`): o cabeçalho e o conteúdo de cada página entram a cada troca de hash.
  - **Efeito:** Mist (máscara SVG `feTurbulence` + borrão decrescente, 1 s, `expo.out`, stagger de 0,1 s a partir do início sobre os filhos do bloco, descendo um nível quando o bloco tem um filho só). Sem GSAP, o progresso vai por `requestAnimationFrame`; o efeito `fade` segue disponível.
  - **Conteúdo tardio:** com `follow` (o `FadeSlot` liga), o que chega depois, como a página que troca o esqueleto `aria-busy` pelo dado do fetch ou um componente tardio, ganha máscara própria na chegada (mesma regra de alvos), enquanto houver esqueleto e por 0,3 s depois do fim da entrada; máscara de nó removido é descartada.
  - **Quando não anima:** na primeira carga (já há a abertura); com `prefers-reduced-motion`, `saveData` ou antes de o fx chegar, a entrada é instantânea, sem remontar a página.
- **Rubber Segment** (`fx/rubber-segment.tsx`, miolo do `Segmented` do `app.tsx`): todas as abas do painel (Revisões, Visão geral, Fila de gates,
  Argos, Configurações, Documentação, Branch e PRs, e `Choice` na mesa). A pílula elástica segue clique, arrasto e setas (papel `tab`, sem
  mudar assinatura nem medidas). Sem o fx carregado, com `prefers-reduced-motion` ou `saveData`, vale o miolo comum.
- **Carga sob demanda** (`fx/lazy.tsx`, `HadesFx.use(nome, enabled)`): `vendor/motion.js` e os componentes que o usam entram
  por `import()` quando a página precisa; ficam fora do pré-cache do `sw.js`.

Vendorizado (versão fixa, sem CDN):
| Arquivo | Origem | Versão | Tamanho |
|---|---|---|---|
| `vendor/motion.js` | npm `motion`, ESM minificado, React via `window.React` | 12.43.0 | 135.968 B (~44,8 KB gzip) |

## Armadilhas

- **Firewall e login do devtunnel pedem terminal.** Sem TTY, o `sudo` do firewall falha. Na primeira subida numa máquina nova, rode `run-hades` no terminal.
- **Service worker cacheia a UI velha?** Só se o `UI_HASH` não mudou. Teste no `127.0.0.1` com perfil novo do Firefox; para 390 px, `--window-size` com `--screenshot` e o proxy abaixo (o `SetWindowRect` do Marionette trava em 500 px).
- **`--screenshot` do Firefox headless não espera o `fetch`.** Ele também não espera o Tailwind compilar. Para conferir a tela, sirva a página por um proxy que segure o evento `load` com uma imagem lenta (~4 s).
- **Conexões do navegador: no máximo 6 por servidor.** O painel é HTTP/1.1 e cada `EventSource` prende uma conexão enquanto vive (o Argos abre 3: canvas, terminais e linha do tempo). Duas abas do Argos esgotam o teto e todo `fetch` da página fica na fila até o tempo esgotar, sem chegar ao servidor: o canvas não grava, a nota some no reload e o terminal nasce "fora do canvas". Fluxo novo abre por `window.PanelStream.open(url)` (`ui/stream-logic.tsx`), que solta a conexão 5 s depois de a aba esconder e religa ao voltar (o `open` da religação é o sinal para conferir o que passou), nunca por `new EventSource` direto. O Argos também pergunta antes de recarregar ou fechar com edição do canvas que o servidor ainda não tem.
- **Perfil do Firefox preso.** Uma execução headless que trava deixa o perfil com `lock`; use um perfil novo.
- **Unit do chat só vê o que você passa.** Ela não herda o shell: `PATH`, binário e variáveis vão explícitos e o texto vai
  pelo stdin. Confira `systemctl --user cat hds-chat-<id>` com uma resposta lenta antes de confiar.
- **Scroll do chat com `scroll-behavior: smooth`** dispara `scroll` durante a animação e solta o "colar no fim": não use.
- **`Array.from({length}, fn)`.** O `fn` recebe só (valor, índice); usar um terceiro argumento derrubou a tela inteira. Por isso cada página roda dentro de um "error boundary": um erro de tela fica restrito à página.
- **`<id>` solto dentro do `html` do htm vira tag.** Texto como `--pack <id>` no template abriu um elemento `id` e
  derrubou a página inteira (erro de tela, React #31). Texto com `<` ou `>` entra interpolado: `${'… <id> …'}`.
- **`[hidden]` precisa de `display: none !important`.** Card com `display: flex` ignora o atributo `hidden`.
- **Regra CSS sem camada vence utilitário do Tailwind.** O `@media` de toque do `index.html` está fora de `@layer`; um `position: relative` ali desfez o `absolute` do botão fechar e jogou o X para o pé do diálogo. Nessa regra, só `min-height`; posição vai em classe no markup.
- **Keyframe com `transform` manda no posicionamento.** O diálogo se centra pelo `translate(-50%, -50%)` do `zoom-in` (`fill both`): para mudar o `top` ou o eixo Y, desligue a animação (`max-md:animate-none`) e dê o `transform` à mão.
- **Painel no ar durante o install serve a UI nova com o servidor antigo.** O processo fica em memória; a UI vem do disco. O `install.sh` reinicia o painel só se a unit `$HU-panel` está ativa (e diz `painel <unit> reiniciado`); parado, segue parado. Mesmo assim, página que lê campo novo da resposta trata a ausência (`x.erros ?? []`): campo ausente vira vazio ou oculto, nunca exceção (`loop/test/ts/lib/page-render.cjs` renderiza a página com `{}`).
