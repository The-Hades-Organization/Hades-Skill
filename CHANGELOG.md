# Changelog — skill `hades`

Formato: uma seção por versão, a mais nova no topo. Cada entrada diz **o que mudou, por quê, e o que se descobriu no
caminho** (regra de negócio, armadilha, número medido). Versão: minor = capacidade nova; patch = correção ou armadilha;
major = quebra de contrato do kit (`env.sh`, layout de `$D`, nomes de scripts).

## 6.11.0 — 2026-11-04

Modo de loop de revisão (issue #26); rolagem do terminal do nó do Argos e limite medido do resize (issue #33).

- **`hades review --loop`** (`[--every 30m] [--author <login> | --pr N…] [--max N] [--deep] [--until <hora>|--rounds N]
  [--note <nota>]`): processo próprio que, a cada rodada, revisa só as PRs do escopo de head novo ou nunca revisadas. O estado
  por PR (último head, data, link, achados abertos) fica na raiz de trabalho da Hades, e achado já reportado e ainda aberto
  não é postado de novo (identidade = código|arquivo). Duas rodadas nunca se sobrepõem (`flock` do processo), a PR com lock
  de outra sessão é pulada com motivo e as revisões passam pela fila de reviews (`HADES_REVIEW_MAX_PARALLEL`). Pausa e avisa
  uma vez quando a janela de 5 h ou a semanal passa do limiar (`HADES_REVIEW_LOOP_*`). Para por `--until`/`--rounds`, por
  `hades review loop stop` e sozinho com escopo vazio. Revisores entram no canvas ligados ao orquestrador do loop, e o
  resumo da rodada vai a uma nota; `notify` só com bloqueante novo. Painel: `GET /api/reviews/loop` e card "Loop de
  revisão" com status e % das janelas por rodada. Armadilhas: o serializador do painel imprime `undefined` literal (o
  status passa por normalização); o loop não retira do GitHub achado já postado; o revisor é um `claude -p` filho, então
  o nó dele aparece "fora do herdr".
- **Rolagem do nó do Argos**: o xterm do nó (sem scrollback) convertia a roda em setas e cancelava o evento, e nem o nó nem
  o canvas a recebiam. Agora a roda e o arrasto de um dedo rolam o histórico por `/api/herdr/scrollback`, Ctrl/Alt+roda
  volta ao canvas e, em tela alternativa, o nó avisa que não há histórico em vez de mandar setas ao agente.
- **Resize do nó, fechado como limite medido**: um cliente herdr anexado muda cols×rows de todos os panes da sessão (não
  há tamanho por pane), vence o último que anexou ou redimensionou, e o terminal criado no canvas também é pane do herdr.
  Os nós seguem só com escala. O cursor do nó segue estimado: o herdr 0.8.2 não entrega a posição, e o Claude Code usa
  o cursor real do terminal, sem vídeo reverso.
- **Teste instável do rig** (`plugin.test.ts`, prazo de cada processo): falhou na CI da 6.9.0 e da 6.11.0 com "o neto não
  ficou vivo". O SIGTERM do `timeout` chega ao grupo junto com a morte do sh, mas o neto só morre quando é escalonado, e em
  CI carregada isso passava do instante em que o rc era gravado. O teste agora espera a morte do neto por até 2 s (ele viveria
  60 s), e a asserção segue exigindo que ele morra.

## 6.10.0 — 2026-11-04

Aba Workspaces do Herdr com terminal de verdade, no desktop e em tela cheia no celular (issue #32).

- **Terminal na aba Workspaces**: o pane escolhido aparece num xterm com cores, cursor e teclado direto, pelo mesmo caminho do
  nó do Argos (`NodeTty` reaproveitado sem mudança, quadro por `/api/herdr/stream`, entrada por `/api/herdr/input` numa fila de
  um envio por vez). Metadados e ações ficam ao redor. A saída de 200 linhas virou alternativa recolhida (copiar, leitor de
  tela), que abre sozinha quando o fluxo cai e só faz polling de 3 s aberta. Fluxo caído ou pane encerrado: aviso e
  **Reconectar**. O tamanho do pane não muda (só escala): no herdr o tamanho é da sessão inteira.
- **Celular**: tela cheia com a barra de teclas, o teclado virtual e a acentuação do terminal; metadados, prompt e ações numa
  gaveta. Defeitos registrados antes da correção: sem barra de teclas (a página não passava `apiRef`), digitação só pelo
  campo de texto, rolagem aninhada. Armadilha: o `NodeTty` tirava o foco quando o toque caía na barra de teclas e só focava
  fora do gesto (o iOS não abre o teclado assim); agora o toque foca dentro do gesto e a barra não rouba o foco. Toque e
  teclado virtual foram verificados por código e teste, não num aparelho.

## 6.9.1 — 2026-11-04

Tipos de notificação com nome claro e CI separado de review (issue #28); câmera do Argos só se move por gesto ou seleção do
dono (issue #31).

- **Tipos de notificação**: `gate` passa a se chamar "Gate, build ou teste falhou" e cobre os três; `test` (o botão de envio)
  sai da lista desligável. CI vermelho ganha o tipo `ci` (`HADES_NOTIFY_EV_CI`), cujo padrão segue o canal de `pr`, então um
  `HADES_NOTIFY_EV_PR=off` existente continua silenciando o CI sem migração. `prProblems()` vira função pura e a fonte `prs`
  só roda com `pr` ou `ci` ligado. `status --json` ganha `events[{event,label,channels,pinnedByEnv}]` e a tela de
  Configurações mostra como fixo o tipo exportado no ambiente. Um teste varre `src/` e exige que todo emissor use evento do
  catálogo. Armadilha: o `env.sh` exporta o `config.env` em todo processo, então só conta como fixo o export com valor
  diferente do `config.env`.
- **Câmera do Argos**: segurar o Espaço arma o pan, e soltá-lo sem arrastar selecionava o nó focado, levando a câmera até
  ele. Só o arrasto com ponteiro marcava o Espaço como usado; zoom por roda e teclas de câmera, não. Agora esses gestos
  também consomem o Espaço. A seleção ganha origem (`pointer`/`key`/`command`/`sync`, e `sync` nunca move a câmera), e
  `localStorage["argos.cameraDebug"]` registra a origem de cada movimento. A causa foi medida no motor com DOM falso, sem
  reprodução em navegador: se a câmera ainda saltar sem o Espaço, ligar `argos.cameraDebug` e ler o console.

## 6.9.0 — 2026-11-04

Preferências para desligar as travas de confirmação (issue #22); Reviews sem teto de PRs selecionadas (issue #27).

- **Travas de confirmação** (`HADES_CONFIRM_HOLD`, `HADES_CONFIRM_TYPED`, padrão ligadas, grupo Painel): desligam o "segurar
  para confirmar" e o "digitar o nome para confirmar" das ações destrutivas, sem recarregar. A checagem do nome é do servidor,
  lida do `config.env` a cada ação, e valor ausente ou inválido mantém a trava. Pelo acesso remoto as duas chaves não mudam
  (`remoteConfigRefusal`): quem entra pelo túnel não desliga a trava que o protege. Armadilha: com digitar desligado o Argos
  ainda envia `confirm` vazio, e o servidor só o ignora com a preferência desligada.
- **Reviews sem teto**: o painel marca quantas PRs se quiser, com "marcar todas" (página visível do seletor) e "limpar", e
  mostra "N selecionadas · até P em paralelo"; `--max` não tem máximo. O único limite é `HADES_REVIEW_MAX_PARALLEL`, e as
  excedentes esperam na fila. `/api/reviews` ganha `maxParallel`.
- **Armadilha de golden**: mudança em `kit/panel/ui` ou numa rota lida pelo legado exige regravar só o golden do painel
  (`LEGADO_REGRAVA=1 bun test ./painel-legado.test.ts`). Sem o caminho, o filtro casa outros arquivos e regrava goldens alheios.

## 6.8.0 — 2026-11-04

`hades canvas join` e `leave` (issue #25); cursor do terminal do Argos (issue #20); eco da digitação no Argos (issue #21).

- **`hades canvas join` e `leave`**: trazem para o Argos um pane do herdr criado fora dele, e tiram de volta, sem reiniciar o
  processo. Identidade por `paneKey`: pane que já é nó não duplica, e nó `agent` do mesmo pane é fundido. Terminal do registro volta
  com nome, agente, modelo, esforço, papel e orquestrador, e `recruit` funciona em seguida. Fora do herdr recusa com instrução
  (`canvas_join_outside_herdr`). Armadilha: orquestrador órfão só volta como orquestrador se estiver em `terminals.json`.
- **Remoção em massa**: a confirmação do gesto de apagar vale até o servidor aceitar (`createSaveMeta`), inclusive em retry depois de
  409. O 422 `canvas_mass_removal` tem texto próprio na tela e não gera reenvio a cada `SAVE_RETRY_MS`.
- **Cursor no nó do Argos**: com foco, bloco piscando; sem foco, contorno, como no `PtyTerminal`. O herdr 0.8.2 não entrega o cursor
  no quadro e `screenOf` abre com `?25l`, então a posição é **estimada** pelo fim do texto (`guessCursor`).
- **Eco da entrada**: `herdr-stream.ts` abre uma janela de releituras curtas (15 e 30 ms) depois do `nudge`, só no pane que recebeu
  a tecla, e quadro igual não dobra o intervalo nessa janela. Medido do POST ao quadro no SSE: p90 de 96 para 10 ms com 1 pane e de
  102 para 4 ms com 8 panes. O navegador não era o gargalo (tecla até o POST 0–1 ms, `term.write` 0–2 ms). A página Terminal segue
  mais rápida (0,4 ms), por usar PTY por WebSocket: o herdr não dá fluxo de bytes.

## 6.7.1 — 2026-11-04

Nós do canvas não somem mais sem ação do dono (issue #23) e um pane do herdr é um nó só (issue #24).

- **Remoção com guarda**: `mergeWithGraph` só tira nó vivo com grafo confiável, e `createAbsenceTracker` exige duas leituras
  seguidas sem o nó; grafo vazio ou parcial não remove nada. Gravação que levaria notas ou terminais em massa (5 ou mais, e mais
  da metade dos nós do usuário) é recusada com 422 `canvas_mass_removal`, salvo pelo gesto de apagar, que manda
  `X-Canvas-Confirm-Removal: 1`.
- **Rastro**: cada remoção vai ao `panel.log` (`canvas remoção`) com causa, tamanho do grafo, versão sobrescrita e ids, e a versão
  sobrescrita fica em `$D/canvas-trash/` (20 por canvas). O evento fica no `panel.log`, e não no diário por agente, porque não
  tem agente.
- **Um pane, um nó** (`paneKey`, `claimed`/`duplicates`): grafo lido no meio da criação do terminal, `agent adopt` de pane que já
  é nó e `reassign` mantêm o mesmo nó.
- **Armadilha medida**: `note` e `terminal` não são tipos vivos, então `mergeWithGraph` não explica a perda deles. Numa instalação
  real, notas, terminais e arestas saíram num único `PUT` do cliente com a `rev` certa (30 → 22 nós, 10 → 0 arestas), sem 409. A
  causa exata desse cliente segue sem prova, por falta de cópia do documento; o `canvas-trash/` e o `panel.log` fecham a causa se
  acontecer de novo.
- **Suíte**: `cerberus-vigilia-legado` falhou uma vez na regressão completa (`sem valor gravado para '27:auditoria ["capturas"]'`)
  e passou sozinho 3 de 3 e na rodada seguinte: a chave do golden usa um contador sequencial, sensível à ordem.

## 6.7.0 — 2026-11-04

Minos, o publicador do acompanhamento da orquestração (issue #15); fila de revisões com teto (issue #14); permissão do
Argos respondível quando o aviso não nomeia a ferramenta (issue #16); roda em tela alternativa na página Terminal (issue #18).

- **Minos** (`reference/minos.md`): `hades minos list|publish|link|open`. O modelo `orquestracao` declara um contrato JSON
  (validado na fronteira) montado do plano, dos agentes, das PRs, das escalações e do consumo do Moirai; a página é
  estática, gerada no servidor com tudo escapado, nos temas claro e escuro, e a mesma serve ao `--html` offline. Publicar
  num Artifact é da sessão do Claude: o `publish` prepara a página e os dados e o `link` grava o endereço estável
  (só `https://claude.ai/.../artifact/<id>`). O Cerberus roda antes de gerar qualquer saída (varredura em memória e o
  momento `artefato`); recusa sai 1 sem gravar nada. Botão **Publicar** na página Orquestração
  (`POST /api/orchestration/publish`). A **Página do time** é recurso opcional próprio no onboarding (`@minos`,
  `HADES_MINOS_TEAM=0` por padrão): como passo de "Contas e loop" ela deixaria a feature pendente para sempre.
- **Fila de revisões** (`reference/loop/review.md` §6): `hades review`, do painel ou do terminal, respeita
  `HADES_REVIEW_MAX_PARALLEL` (padrão 4) por um semáforo de `flock(2)` em `reviews/slots/slot-<i>.lock`, sem processo
  central; o kernel solta a vaga se a revisão morrer. O excedente espera em `fila` sem falhar, e o prazo de 300 s do
  `fetch` e do `worktree add` só corre depois da admissão. Cada job mostra a fase (fila, fetch, checkout, revisão,
  publicação) no log, em Revisões › Em curso e na página de jobs. Motivo: 25 revisões disparadas juntas derrubaram 23 por
  prazo de checkout (load 62, 8 GB de swap). Medido e não adotado: checkout sparse ou `--no-checkout` pelo diff (108 ms
  contra 7–22 ms num repo pequeno) tira do review o código vizinho que ele lê.
- **Permissão no Argos:** quando o aviso do Claude Code não traz "use <Ferramenta>", o pedido chegava com `tool: null` e
  Aprovar/Negar ficavam desabilitados. A ferramenta agora vem do último `tool_pre` sem `tool_post` antes do pedido (zera em
  `stop`, `prompt` e no fim do agente); o texto "use X" continua vencendo. Com os botões desabilitados, o diálogo sempre
  diz o motivo e manda ao terminal do agente; herdr fora de `blocked` cita o estado.
- **Roda na página Terminal:** com o `herdr-client` em tela alternativa, a roda anda pelo histórico do pane em foco da
  sessão (`/api/herdr/scrollback`, mesma regra e mesma volta ao vivo do nó do Argos, agora uma só em `term-logic.tsx`);
  sem pane (`claude`, shell), a roda segue ao programa e uma dica de PageUp/PageDown aparece uma vez. `/api/term` ganha
  `herdrSession`.
- Armadilhas: o ambiente do PTY é o do painel, então `HERDR_PANE_ID` ali não identifica pane (o pane vem do foco da sessão
  do herdr; dois clientes na mesma sessão veem o mesmo); o `Notification` do hook não traz a ferramenta em campo
  estruturado; o ResizeObserver dispara sem mudança de tamanho, por isso o refit só descarta o histórico com cols/rows
  novos; `readonly x` no construtor quebra o `erasableSyntaxOnly`; registro com hora real (`faseDesde`) precisa sair da
  comparação dos goldens, como `started`; a Vigília lê todo caminho do parágrafo "não toque" do brief como proibido, então
  arquivo compartilhado liberado para acréscimo vai em parágrafo próprio.
- Consolidação: as quatro unidades rodaram em paralelo pelo `skill-new`; gate único no fim com o mesmo roteiro do CI
  (`tsc` dos dois configs, guarda e suíte: 5952 passam). Os 4 testes de `notify-lock` falham igual na 6.6.0 nesta máquina
  (causa ainda não investigada): anterior, não regressão.

## 6.6.0 — 2026-11-04

Resumidores por stack entregues pelo rtk (issue #10) e terminais do painel com acentuação e rolagem corretas (issues #12 e #13).

- **Resumidores do rtk** (`reference/rtk.md`): `stacks/{node-nx,pnpm-next,rust-cargo,tauri}/rtk-filters.toml` mais os
  filtros do plugin (`rtk.filters` no perfil, validado no `project validate`) viram `.rtk/filters.toml` em cada worktree
  (install, `agent new`, `skill-new`), no `.git/info/exclude`; nunca tocam `~/.config/rtk/*`. `HADES_RTK_FILTERS=auto|off`,
  `HADES_RTK_OFF_STACKS` e `HADES_RTK_OFF_FILTERS` no grupo "Resumidores (rtk)" das Configurações; `hades rtk status|apply`.
  O rtk entra como `warn` no registro de dependências; o `doctor` mostra estado, confiança e recomenda política (sem gravar).
- **Corte sempre anunciado:** os filtros entregues só descartam por mecanismo que o rtk anuncia (`head_lines`/`tail_lines`,
  `... (N lines omitted)` e a saída inteira no `rtk recall`); `strip_lines_matching` só tira linha em branco. Teste na
  regressão das stacks barra corte sem anúncio. `env.sh` aponta `RTK_RECALL_DB`/`RTK_TEE_DIR` para `$D/rtk/` (rotação pelo `clean`).
- **Só o dono muda a política:** o guard barra `HADES_RTK_*=`, `config set` dessas chaves e `rtk trust` vindos das
  ferramentas do agente; o painel remoto recusa as chaves. O agente vê mais com `rtk proxy <cmd>`. O install e a criação
  de agente rodam `rtk trust --yes` no worktree que geram (confia no conteúdo do plugin do projeto).
- **Terminal e Herdr:** tecla morta (`´ ~ ^` + letra) no Firefox chegava duplicada (`aaá`): o navegador manda keydown da
  letra base com a composição aberta e o xterm a tomava por tecla. `composeGate` segura a composição e entrega o
  caractere composto uma vez (`c3 a1` = `á`). O nó do Argos também ignora tecla com composição aberta.
- **Roda no nó de terminal do Argos:** pixels do trackpad somam pela altura de linha na tela (antes cada evento valia uma
  linha), rajadas não perdem passos, topo e fim presos, volta ao vivo; nó distante deixa a roda para o zoom do canvas.
- Armadilhas: rtk 1.x trocou o `[tee]` por `[retriever]`/`rtk recall`; filtro de projeto só vale depois de `rtk trust`
  (SHA-256 do arquivo); o TOML do rtk é só o fallback de comando sem handler próprio; o painel de teste serve a cópia
  instalada (reinstale para provar); Firefox sem monitor não pinta (prova por bytes do WebSocket).
- Pendente: medição de tokens com e sem filtros numa rodada real de gate (rtk ausente na máquina de desenvolvimento); roda
  em tela alternativa na página Terminal.

## 6.5.0 — 2026-11-04

Espera por processo no `hades wait` (issue #11), `agent resume` sem rótulo de papel (issue #9), Argos sem permissão
pendente de agente encerrado (issue #7) e a suíte estável na CI pública.

- **`hades wait proc <padrão>`**: espera até nenhum processo casar com o padrão (`pgrep -f`) e notifica `PROC <padrão>
  terminou`; o próprio wait e os seus ancestrais não contam; padrão vazio ou que casa com o próprio wait é recusado.
  Intervalo e prazo pelos `HADES_WAIT_EVERY`/`HADES_WAIT_MAX` de sempre.
- **Guard:** laço com `sleep` num comando em segundo plano passa a receber aviso (sem barrar) com o `hades wait`
  equivalente (`proc` para `pgrep`, `queue`, `ci`, `agent`); `HADES_POLL_GUARD=0` desliga também o aviso. A linha HOW cita
  o alvo novo.
- **`agent resume`** usa a fase do registro ou do cabeçalho `# Handoff — <u>, fase \`<f>\`` do `handoff.md`; sem ela, o
  prompt não cita fase e o registro não ganha `phase` (antes rotulava pelo papel, "fase impl"). `agent prompt --phase <f>`
  registra a fase desde o primeiro prompt.
- **Argos:** `agent done`, `park` e `skill-clean` gravam `orch agent.end` no diário, que encerra a pendência; registro
  `done`/`archived` ou pane fora do `herdr agent list` não mostra `pendingPermission`; aprovar ou negar sem pane responde
  409 `pane_gone`.
- **CI pública:** o teste do rig "morre com os netos" falhava no runner porque, em contêiner sem init que colha órfãos, o
  neto morto fica zumbi e `kill(pid, 0)` ainda responde; a checagem ignora o estado `Z` de `/proc/<pid>/stat`
  (reproduzido com `unshare -rpf --mount-proc`).
- Armadilhas: o golden `bun-loop2.json` guarda o texto do `resume`; mensagem de commit ou de merge com "hades wait …" é
  barrada pelo guard como espera em primeiro plano.

## 6.4.0 — 2026-11-04

Documentação revista com o Impeccable (critique, clarify, distill, typeset, quieter, polish, optimize, delight, document).

- **Página Documentação** do painel: linha 1.7, código inline com folga curta, código em título sem bloco cinza, 1ª coluna
  de tabela sem quebrar no meio da palavra; índice de documentos com rolagem própria (os tópicos ficam à vista) e, no
  celular, "Tópicos" mostrando o atual e o caminho escondido. Documento cortado em seções por `## ` com
  `content-visibility:auto` (o de 3.249 linhas não pinta tudo de uma vez); o salto ao tópico respeita
  `prefers-reduced-motion` e corrige a posição depois que as seções adiadas pintam. Botão "Copiar" nos blocos de código.
  `DESIGN.md` novo, com o sistema de design do painel.
- **Textos públicos:** README com os recursos no topo e menos ênfase (462 → 398 linhas); requisitos corrigidos (`rsync`
  saiu, o install copia em TypeScript; entram `bwrap` e `launchctl`); `CONTRIBUTING.md` novo, com o caminho único de
  contribuição; SECURITY e modelos de issue mais enxutos.
- **`reference/`** inteira: parágrafos densos e células longas viram listas, sem vocabulário de domínio nem número de PR
  de projeto, acentos corrigidos. Nenhuma seção renomeada; regras, comandos, chaves e caminhos conferidos token a token
  contra a versão anterior. O cartão do orquestrador mantém a lista do que nunca cede.
- Armadilhas: um agente commitou o relatório da própria pasta `.design-sync-reports/` (saiu no merge); a faixa de portas
  de teste das unidades (21270–21289) esgota com worktrees não limpas (`skill-clean`, ou `skill-new --port N`); o guard não
  barra um laço `while pgrep …; do sleep 5; done`.

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
