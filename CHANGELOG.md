# Changelog — skill `hades`

Formato: uma seção por versão, a mais nova no topo. Cada entrada diz **o que mudou, por quê, e o que se descobriu no
caminho** (regra de negócio, armadilha, número medido). Versão: minor = capacidade nova; patch = correção ou armadilha;
major = quebra de contrato do kit (`env.sh`, layout de `$D`, nomes de scripts).

## 6.3.0 — 2026-11-04

Consumo em % das janelas de 5 h e semanal (issue #4) e `hades watch` por orquestrador (issue #5).

- **Limites de uso: medir.** A fonte é o `rate_limits` do JSON que o Claude Code entrega ao `statusLine`
  (`five_hour`/`seven_day`, `used_percentage` e `resets_at`; só assinantes Pro/Max, depois da primeira resposta da sessão;
  documentação oficial lida com o Claude Code 2.1.317). `hades usage sample` é o comando do statusLine: grava a amostra em
  `~/.claude/hades/limits/samples.jsonl`, sem rede, e nunca quebra o status line. Ligar é passo do dono
  (`reference/limites.md`, inclusive encadeado com um statusLine existente); o doctor e o onboarding só apontam o passo.
- **Limites de uso: converter.** Calibração tokens → % por modelo e por janela, recalculada com o uso (nada fixo no código);
  abaixo de `HADES_LIMITS_MIN_INTERVALS` diz "sem calibração". `hades usage` ganha `% 5h` e `% semana` (estimadas, `~`) por
  papel, agente e dia e o % medido com a renovação; `hades moirai estimate` mostra a faixa p25–p75 em % de cada janela e
  "cabe na janela atual?".
- **Limites de uso: mostrar e avisar.** Painel → Consumo com o cartão "Janelas do plano" (% medido, renovação, idade da
  amostra; sem amostra, só como ligar a coleta), colunas estimadas por papel e agente, rota `GET /api/limits`; linha no painel
  lateral do agente no Argos. `hades watch` emite `LIMITE <5h|semana> <pct> renova <hora>` ao passar de
  `HADES_LIMITS_WARN_FIVE_PCT` (80) / `HADES_LIMITS_WARN_SEVEN_PCT` (90), uma vez por janela e renovação, para todo
  observador. O orquestrador compara o p75 do plano com o que resta da janela de 5 h antes de alocar em paralelo.
- **`hades watch` por orquestrador** (#5). Chamado de um pane do herdr, acompanha só os agentes cujo `orchestrator` é esse
  pane (sem `orchestrator`: todos); `--agent`/`--agents`, `--orchestrator <sessão:pane>` e `--all`. O "já visto" é por
  observador (`watch/by/<observador>/`), herdando o compartilhado na primeira passada: um watch não consome mais o evento
  do outro. `hades agent reassign-orchestrator <nome>…|--all` aponta os agentes para o pane atual quando o herdr reinicia.
- Armadilhas: a renovação oscila segundos entre leituras (≤2 min é a mesma janela); `claude -p` não aciona o statusLine;
  o id de pane tem `:` (`--orchestrator default:w1:p1` divide no primeiro). Pendente: o `notify` ainda não conhece `LIMITE`.

## 6.2.1 — 2026-11-04

Correções do `hades watch` (issues #6 e #8).

- **DONE de report antigo** (#6): o `scanDone` só emite `DONE` com `mtime(report.md)` posterior ao último prompt (a mesma
  regra do `PARKED`). Antes, um `prompt`/`resume`/`phase` novo liberava o DONE do report da rodada anterior e o orquestrador
  auditava um relatório velho com o agente ainda trabalhando. `prompt`, `resume`, `answer` e `phase` avisam quando o
  `report.md` existente já começa com `STATUS: DONE` (renomear para `report-<n>.md`); só aviso.
- **DONE segurado em silêncio** (#8): report `STATUS: DONE` sem prova ou commit agora sai como
  `DONE-HELD <agente> sem-prova|sem-commit|commit-fora-da-branch`, uma vez por prompt e motivo, também no diário
  (`watch.done-held`). Quando a prova ou o commit entram, sai o `DONE`. `hades agent phase <nome> <fase> --no-commit` marca a
  fase que dispensa commit (o DONE exige só a prova).
- Cartões `roles/impl.md` e `skill-dev-contract.md`: o report precisa de uma linha de prova positiva e do commit citado na
  linha da palavra "commit". `orchestrate.md` §4: o que fazer com o `DONE-HELD` (auditar, devolver pedindo prova, aceitar).
- Armadilha: o `answer` não muda o `promptedAt`; report DONE escrito antes do `answer` continua valendo para o ciclo do
  último prompt. O mtime é em segundos: report reescrito no mesmo segundo do prompt não conta.

## 6.2.0 — 2026-11-03

Terminal completo no painel e páginas Claude e Herdr de primeira classe no celular (issue #3).

- **Servidor do terminal** (`src/panel/term.ts`, `term-ring.ts`, `term-protocol.ts`, `term-http.ts`). Sessões PTY com o PTY nativo
  do Bun (sem `node-pty`) servidas por WebSocket: `shell`, `claude` (novo ou `--resume`, sempre em auto mode) e `herdr-client`
  (`herdr --session`; o herdr 0.8.2 não anexa a um pane sozinho). Resize, anel de saída com offset absoluto para retomar sem
  perder nem repetir, uma tela por sessão (a segunda fecha a primeira com 4001), teto de sessões e inatividade. Protocolo e
  códigos de recusa em `reference/panel.md` §Terminal.
- **Segurança do terminal.** `HADES_TERMINAL` nasce desligada e as quatro chaves `HADES_TERMINAL*` só mudam pelo painel local
  (o mesmo bloqueio de `HADES_CHAT`, também no import). O upgrade do WebSocket confere host, chave remota e `Origin` (pelo túnel,
  sem `Origin` recusa); a pasta é resolvida por `realpath` e só vale dentro do clone principal, das worktrees de agente e de `$D`;
  argv em lista; o grupo de processos morre ao fechar, expirar ou parar o painel. Aviso ao dono a cada sessão aberta de fora **e**
  no primeiro anexo remoto a uma sessão aberta no local; `logs/panel-term.log` (0600) só com ação, tipo, pasta, origem e id,
  nunca o que foi digitado nem a saída. Os PTYs ficam no cgroup da unit do painel (fora do slice `hades`, como o painel).
- **Interface do terminal.** xterm.js 6.0.0 e addon-fit 0.11.0 vendorizados (integrity conferido, MIT em `THIRD_PARTY_NOTICES.md`).
  `HadesCore.PtyTerminal` (o nome `Terminal` segue sendo o visualizador de log das Execuções) reconecta com recuo e retoma pelo
  offset, trata os códigos de fechamento e as recusas pelo `code`; `HadesCore.createXterm` dá o mesmo tema ao terminal e ao Argos.
- **Página Herdr** refeita: abas de sessão (shell, Claude Code, cliente do herdr) na pasta escolhida, lado a lado na mesa, sessões
  vivas, e **gerência do herdr** pelo painel (`POST /api/herdr/admin`): criar, renomear e fechar workspace, aba e painel, dividir
  painel e iniciar agente, com argv validado e confirmação por nome nas destrutivas.
- **Argos:** o nó de agente é desenhado pelo xterm (só leitura de saída; nós distantes ficam no resumo leve). **"Abrir terminal"**
  na Orquestração, no menu do nó do Argos e nas Execuções (a meta da execução ganha `cwd`, aditivo).
- **Página Claude:** modo Terminal ao lado do Chat (Claude Code de verdade, novo ou "Continuar no terminal"); no chat, o bloqueio de
  ferramenta ganha "Abrir no terminal para aprovar" (o `claude -p` não aceita aprovação no meio da resposta) e o anexo de imagem
  ou texto vai para `$D/claude/attach/<sessão>` (`HADES_CHAT_ATTACH_MB`, 20 por conversa, apagado com a sessão).
- **Celular:** Claude e Herdr mostram uma coisa por vez e o voltar do sistema desce um nível; barra de teclas acima do teclado
  virtual (Esc, Tab, Ctrl fixo, setas, colar, copiar e as respostas do Claude Code: 1/2/3, y/n, Shift+Tab, Ctrl+C), configurável
  por `HADES_TERMINAL_KEYS`; o terminal acompanha o `visualViewport` e tem "Ir ao fim"; o agente esperando você abre o painel dele
  com as respostas rápidas.
- Correção: `HADES_CHAT_BIN` inexistente no terminal responde 422 `term_kind_unavailable`, não 500.
- Armadilhas medidas: o xterm não lê `oklch` (tokens resolvidos em RGB); o Bun derruba o socket com quadro acima de `maxPayload`
  (o cliente vê 1006); o eco do tty vem com `\r` antes da saída; o xterm não seleciona por toque (Copiar leva a seleção ou a tela);
  `navigator.clipboard.readText` só em HTTPS/localhost; `agent start` do herdr só entra em painel de shell livre.
- Limites: Safari iOS e Chrome de celular não foram testados (só Firefox com viewport de celular); "Ir ao fim" não foi visto no
  navegador sem tela.

## 6.1.2 — 2026-11-03

- **Busca do seletor de arquivos cede o laço de eventos de verdade.** O `readdir` assíncrono do Bun pode resolver sem
  passar pelo laço; a busca agora cede a vez explicitamente a cada pasta, e o painel não trava os terminais durante uma
  busca grande. Quem achou foi o teste que já cobria isso, que falhava só no runner do CI.
- Teste do `notify restart` com ordem determinística entre o aviso do `cat` e o registro de chamadas (as duas leituras
  em sequência, não num `cat` só).

## 6.1.1 — 2026-11-03

- **Suíte portável para o CI público.** Os golden deixam de guardar dado da máquina que os gravou, e a suíte
  `loop/test/ts` volta a passar num runner limpo (o primeiro CI público teve 60 falhas em 23 testes). Agora são
  normalizados no teste o usuário do `plan.json`, o conteúdo de hooks e objects de repositório git, as frases do `sh` e
  do git e o tamanho dos worktrees do `clean`, que nascem sem modelo de hook nem compressão. A presença de `qrencode` e
  `bwrap` é fixada por stub, e o doctor completo não lê pela rede a versão publicada. O comportamento do produto não muda.
- Armadilha medida: simular o runner com `env -i HOME=<tmp>` não pega nada disso, porque as ferramentas continuam no PATH
  e o uid é o mesmo. Use um container `ubuntu:24.04` com usuário `runner`, bun e node, sem herdr, docker, systemd nem
  notify-send (`reference/evolving.md` §Golden que depende da máquina).

## 6.1.0 — 2026-11-03

- **Painel: `Select` próprio no lugar do select nativo** (issue #2). `HadesCore.Select` e `HadesPanel.Select` (para plugins):
  mesmo desenho em qualquer navegador e dispositivo, lista em portal na mesa (não é cortada por `overflow` nem por diálogo) e
  folha inferior no celular (`Sheet side="bottom"`, opções de 44 px). Grupos, contagem, ícone, dica e opção desabilitada; busca
  acima de 10 opções; teclado combobox/listbox da WAI-ARIA (setas, Home/End, PageUp/PageDown, digitar para pular, Esc fecha só a
  lista). Os 14 selects do painel migraram: `Choice` no celular, "últimas N" do visualizador de logs, Caronte, Cerberus (guarda
  agrupada por cabeça), Documentação, Configurações ("Ir para a seção"), criação de terminal, barra de leitura e ações do Argos.
  A guarda `src/panel/select-guard.ts` (no `check`) reprova select nativo novo em `kit/panel/ui/` fora de `vendor/`. Referência e
  roteiro de conversão em `reference/panel.md` §Select.
- **Teste do doctor isolado da rede.** Com o repositório da skill público, o GET anônimo da checagem de versão responde e o
  `doctor --json` do `bun-kit2` ganhava o aviso `versao-nova`; o teste agora desliga a checagem (`HADES_VERSION_CHECK_HOURS=0`).
- Armadilhas medidas: o `Dialog` tem `transform`, que prende `position: fixed` (por isso o portal no `body`); o `value`/`onChange`
  do `Select` é sempre texto (número se converte na borda); a regra de teclado e busca é pura (`ui/select-logic.tsx`,
  `window.SelectLogic`) e testada sem navegador.

## 6.0.0 — 2026-11-03

Primeiro release público, sob a licença MIT. O repositório recomeça aqui, e este arquivo também: o resumo abaixo é o que
a skill faz hoje, por área. Para instalar, `git clone` em `~/.claude/skills/hades` e `kit/install.sh` (README,
§Instalação); o pacote `hades-skill-v<versão>.tar.gz` segue como alternativa sem git. Vulnerabilidade se reporta em
privado, como diz o [`SECURITY.md`](SECURITY.md).

- **Loop de engenharia.** `deliver` leva a spec até a PR (código, gates, `/review-agents`); `inbox` faz a triagem dos reviews
  recebidos e corrige os achados vivos; `review` revisa PRs de terceiros em paralelo; `cascade` e `sweep` cascateiam a
  stack nos quatro sentidos; `orchestrate` e `consolidate` alocam agentes pelo herdr e juntam as PRs numa só, com gate
  único. Cada PR tem um estado calculado por um coletor só de leitura, e o loop **para em `done-pending`**: o merge é
  sempre do dono. Papéis com cartão próprio (implementação, revisão), brief por agente, handoff para estacionar e
  escalada de dúvida ao dono. `hades usage` mede o consumo de tokens por papel, agente e dia.
- **Fila de gates e teto de memória.** Tipos, testes e build passam um de cada vez por uma fila com orçamento de memória
  (`gate-lock`); o hook barra o gate que tenta furar a fila, e o ambiente local cede e pausa quando um gate espera
  memória. No macOS a fila mede pelo `kern.memorystatus_level`.
- **Ambiente local.** A branch `hades/local` (base do projeto mais as PRs, em ordem topológica), infra docker própria,
  serviços sob o teto de memória da slice do systemd, dados e processos de apoio do projeto, snapshot dos bancos antes
  de cada atualização, limpeza de disco e rotação de logs. `/hades env up|update|pause|resume|status|panel|config|doctor|onboard`.
- **Painel web.** Operação ao vivo em `127.0.0.1`: visão geral, branch e PRs, fila de gates, consumo, orquestração,
  revisões, loop, logs, notificações, onboarding, plugins, qualidade, Cerberus e Configurações. Tour por página, prévia
  de exemplo nas páginas vazias, PWA e uma página de chat com o Claude Code, também pelo celular.
- **Túnel.** Acesso de fora pelo devtunnel, com duas camadas obrigatórias: só a conta dona do túnel passa, e uma chave de
  acesso vira cookie `HttpOnly; Secure; SameSite=Strict`, com bloqueio de tentativas erradas por IP. Túnel anônimo só para
  o front do ambiente (com prazo, barrado pelo Cerberus até o dono aprovar) e para o widget.
- **Argos e herdr.** A página dos agentes como grafo navegável, com canvas que reage a mudanças de fora por SSE, notas,
  terminais dos agentes com histórico, seleção e colagem, e ações sobre os agentes. O diário de eventos por agente
  (`hades journal`) é a base comum do Argos e do Thanatos.
- **Cerberus.** Três cabeças guardam as fronteiras: a **Porta** (o que sai: push, comentário, artefato, túnel, release),
  o **Limiar** (o que entra: plugin, `post-install.sh`, hooks, páginas e rotas, com ensaio em sandbox quando há `bwrap`)
  e a **Vigília** (o que acontece dentro: auditoria do DONE e coerência entre plano, registro e realidade). Cada uma tem
  modo `barra` ou `avisa`; exceção e mudança de modo só o dono abre.
- **Moirai.** Estimativa de custo e duração por unidade de um plano, a partir do que as unidades encerradas custaram,
  antes da aprovação.
- **Caronte.** Empacota uma orquestração num arquivo cifrado com senha para retomá-la em outra sessão ou máquina
  (`caronte pack|unpack|brief`, `agent park`), com validação dos destinos e desfazer.
- **Thanatos.** Post-mortem de incidente ou bug em produção do projeto, montado de git, PRs, reviews e diário de eventos,
  fora do repositório.
- **Regras de qualidade.** Pacotes de regras de engenharia que o dono liga e desliga, injetados nos briefs; as do projeto
  valem por cima. Autonomia do orquestrador em dois controles que nascem desligados.
- **Perfis de projeto, stacks e plugins.** O que é de cada projeto mora num perfil (`/hades project init` gera o
  primeiro); pacotes de stack e um catálogo de checagens; plugins acrescentam ambiente, páginas e rotas, sempre com a
  prévia do commit e do que executa, avaliados pelo Limiar. Várias instâncias na mesma máquina.
- **Notificações e widget Android.** Aviso no desktop (`notify-send`) e no celular (ntfy) quando algo espera pelo dono;
  widget de tela inicial com agentes ativos, parados e perguntando, por token de leitura que só vale na rota do widget.
- **Doctor e onboarding.** `hades doctor` confere a instalação e diz o comando que corrige cada item; o onboarding
  entrega os passos que são do dono, com a mesma fonte de verdade para o comando, a página e o doctor.
- **Evolução da skill.** `hades skill-release` (`drift`, `check`, `guard`, `release`) valida o kit, roda as guardas de
  nome de projeto e de domínio e a regressão, e empacota; `hades agent skill-new` abre unidades de evolução em worktrees
  próprias; `hades contrib` devolve a melhoria ao repositório da skill.
- **Garantias que não cedem a pedido.** Nunca faz merge, nunca faz push sem conferir o upstream, nunca pula hook, nunca
  enfraquece teste, nunca declara verde um gate que não rodou e nunca escreve estado dentro do repositório do projeto
  (tudo vive em `~/.claude/hades/`).

O que mudou para abrir o repositório:

- **Licença e avisos.** `LICENSE` (MIT) e `THIRD_PARTY_NOTICES.md` com versão, origem e licença de cada biblioteca, fonte e
  componente adaptado que o painel redistribui; `kit/panel/ui/vendor/OFL.txt` com a OFL 1.1 das fontes; cabeçalho de
  licença nos bundles que não o traziam.
- **Componentes do painel reescritos.** Oito efeitos do painel (sino, cifra, botão de segurar, tinta metálica, barra de
  prompt, segmento elástico, névoa e ondas) foram reimplementados do zero, em sala limpa, a partir de uma especificação de
  comportamento, com os mesmos nomes e exports. A origem anterior tinha licença que proibia redistribuir os componentes.
- **CI público.** `.github/workflows/ci.yml` roda tipos (núcleo e UI), a suíte `loop/test/ts` e a guarda de release em
  cada PR, com actions fixadas por SHA. Os casos que exigem mais memória do que a máquina tem são pulados com o motivo no nome.
- **Checagem de versão sem login.** A VERSION mais recente é lida anonimamente do repositório público; o `gh` fica de
  reserva para fork privado ou espelho (`HADES_VERSION_CHECK_RAW_BASE`).
- **Guarda de repositório proibido.** `skill-release guard` reprova link para os repositórios listados em
  `HADES_FORBIDDEN_REPOS`, para que nada privado vaze para a árvore pública.
- **Segurança e contribuição.** `SECURITY.md` (relato privado pelo GitHub, versões suportadas, alcance) e o fluxo de
  contribuição por fork e PR no README.
