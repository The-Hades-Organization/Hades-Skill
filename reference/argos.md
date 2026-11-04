# Argos: página e servidor dos agentes (`src/panel/argos*.ts`, `src/lib/argos.ts`)

A camada de dados e ações de uma página do painel que mostra os agentes como grafo navegável e age sobre eles. A página
(§A página) só consome o que está aqui. Três rotas, mesma autenticação das demais
(`reference/panel.md`): GET pela chave do acesso remoto (ou local), POST também pelo token da sessão (`x-panel-token`) e
pelo Origin. Tudo que sobe do herdr, do `gh` ou do disco chega por leitura; nada é gravado nas rotas GET.

## `GET /api/argos/graph`

```json
{ "v": 1, "generatedAt": "2026-10-28T21:00:00.000Z", "herdr": { "available": true },
  "registries": [{ "slug": "owner__repo", "planApproved": true }, { "slug": "_skill", "planApproved": null }],
  "nodes": [ … ], "edges": [{ "from": "<id>", "to": "<id>", "kind": "stack" }] }
```

**Nós** (todos levam `id`, `type`, `label`, `role`, `state`, `lastEventTs`, `pendingPermission`; o que não se aplica é `null`):

| `type` | De onde vem | Campos próprios |
|---|---|---|
| `agent` | os dois registros: o do projeto (`<raiz>/<owner__repo>/orchestration`) e o `_skill`, pelo mesmo caminho do `hades agent list` | `registry`, `mode`, `phase`, `branch`, `base`, `worktree`, `registryState`, `herdrState` |
| `unit` | unidade do `plan.md` aprovado que ainda não tem agente | `registry`; `state` = `planned` |
| `gate` | a fila do gate-lock (`/api/gates`) | `label` = `<tipo>/<label>`, `state` (`running`/`waiting`…) |
| `pr` | `pr` do registro, entrega do estado do loop e membros de consolidação | `number`, `registry`; `state` da entrega (`open`/`merged`) ou `unknown` |

- `id` estável e sem barra (cabe na URL): `agent:<registro>:<nome>`, `unit:<registro>:<nome>`, `pr:<registro>:<n>`, `gate:<pid>`.
  `<registro>` é `_skill` ou `<owner>__<repo>` (dois registros podem ter agentes de mesmo nome).
- `state` do agente: se o registro diz `done`/`archived`, é isso; senão o `agent_status` do herdr (`working`, `idle`,
  `blocked`, `done`, `unknown`…), ou `fora` se o herdr não o vê. Os dois ficam em `registryState` e `herdrState`.
- `lastEventTs`: o último evento do diário do agente (`reference/journal.md`), UTC.
- **Corte por idade** (`HADES_ARGOS_AGENT_MAX_AGE_H`, padrão 24 no catálogo; 0 = sem corte): agente cuja **última
  atividade** passou do corte não entra no grafo. Última atividade = o maior instante `*At` do registro (`createdAt`,
  `adoptedAt`, `promptedAt`, `doneAt`…) e o último evento do diário **de atividade do próprio agente** (fontes `guard` e `gate`; `watch`, `cerberus` e `orch`
  observam e continuam escrevendo sobre agente parado, então não contam) (`lastActivityMs`); registro sem instante nenhum fica.
  Saem junto as PRs que só ele trazia e as ligações dele; a unidade do plano com o nome dele **não** volta como `unit`
  (some com ele), e a dependência para ela é omitida. A sincronia (§Sincronia ao vivo) tira o nó do canvas na próxima
  atualização. O registro e o diário não são tocados, e o detalhe do nó (`/api/argos/node/<id>`) segue respondendo.
  `createGraph` sem `agentMaxAgeHours` não corta; o painel passa o valor das Configurações (ausente ou inválido = sem corte).
- `pendingPermission`: `{ts, tool}` quando o último evento de **atividade** (fonte `guard`, fora `notification`) é o
  `permission` do `Notification`; some no próximo `tool_pre`/`tool_post`/`tool_blocked`/`stop`/`prompt`. `watch`, `gate` e
  `cerberus` chegando depois não o resolvem. `tool` pode ser `null` (o texto do aviso não trouxe a ferramenta).
  Também some quando o `hades agent done|park|skill-clean` grava `orch` `agent.end` depois do pedido (`reference/journal.md`),
  e o nó vem sempre `null` se o registro está `done`/`archived` ou o pane não está no `herdr agent list` (`herdrState: "fora"`).
- **Campos opcionais do nó `agent`** (só aparecem quando há dado; ausente nunca vira zero nem texto vazio):
  - `costUsd`: custo corrente em US$, somado dos transcripts da worktree do agente (cache incremental por arquivo; no
    máximo 16 MB de transcript novo lidos por chamada, o resto na seguinte). Sem transcript, sem campo.
  - `estimateUsd`: o p75 da unidade na seção `## Estimativa` do plano da raiz do agente (o `registry` do nó).
  - `card`: o card do registro do agente, quando tem.
  - `files`: caminhos (relativos à worktree) dos `brief.md`, `report.md`, `questions.md` e `handoff.md` que existem.
  - `openQuestions`: quantas perguntas do `questions.md` seguem sem resposta (só quando é maior que zero).
  - `gate`: `running` ou `waiting` (a fila do gate-lock é a verdade) ou `failed` (o último gate encerrado do diário
    reprovou e nada rodou depois).
  - `orchestrator`: `{session, pane}` do herdr de quem alocou o agente (`hades agent new|skill-new|review|adopt` chamado
    de um pane), do registro; ausente fora de pane ou com o par fora do formato.
  - `pr` e `ci`: o número da PR do agente e `{passing, failing, pending}` do CI, do que o `gh` já trouxe. O CI é
    atualizado em segundo plano (no máximo 4 consultas ao mesmo tempo, agente `done`/`archived` não consulta), então a
    primeira chamada pode vir sem `ci`. O nó `pr` também leva `ci` quando algum agente o tem.

**Arestas** (`from` → `to`, sem duplicar):

| `kind` | Significado |
|---|---|
| `stack` | a `base` do agente (sem `origin/`) é a branch de outro agente: `from` está empilhado sobre `to` |
| `consolidation` | agente de consolidação → PR-membro (`consolidations/<branch>.json`, campo `members`) |
| `depends_on` | unidade → unidade de que depende, pela coluna "Depende de" de `## Unidades` do `plan.md` **aprovado** |
| `agent_pr` | agente → a PR dele |
| `agent_gate` | agente → gate da fila: `--label` igual ao nome do agente, ou o clone do gate dentro da worktree do agente |
| `orchestrates` | orquestrador → agente que ele alocou pela CLI: o `orchestrator` do registro é o pane de outro agente do grafo. Quando o orquestrador é um nó `terminal` do canvas, a página liga o terminal (§Orquestrador no canvas, Agentes alocados pela CLI) |

O plano só vale se o hash dele (sem "Estado atual") for o registrado pelo `plan-approve`; mudado depois, `planApproved` é
`false` e as arestas `depends_on` somem. Sem `plan.json`, `planApproved` é `null`.

## `GET /api/argos/node/<id>`

`<id>` codificado (`encodeURIComponent`). Hoje só nó `agent` tem detalhe (gate e PR: `unknown_node`). Query: `limit`
(1 a 500, padrão 100; acima disso **400 `invalid_query`**, o teto é do servidor) e `since` (`30m`, `2h`, `1d` ou ISO com `Z`).

```json
{ "v": 1, "node": { …o nó do grafo… },
  "timeline": { "events": [<eventos do diário, em ordem de tempo>], "limit": 100, "count": 3, "stream": "/api/journal/stream?agent=<nome>" },
  "herdr": { "status": "blocked", "pane": "w2:p1", "title": "…", "cwd": "…" },
  "pr": { "number": 7, "state": "OPEN", "isDraft": true, "mergeable": "MERGEABLE", "head": "0123456789a", "url": "…", "ci": { "passing": 1, "failing": 1, "pending": 1 } },
  "files": { "brief": {"path": "…", "bytes": 1234, "head": "Brief — …"}, "report": null, "questions": {"path": "…", "bytes": 80, "head": "…", "openQuestions": ["Q1 — …"]}, "handoff": null } }
```

- A faixa **ao vivo** é o SSE que já existe, `GET /api/journal/stream?agent=<nome>` (`stream` aponta para ele); não há outro stream.
- `pr` vem de `gh pr view` (timeout de 15 s, cache de 30 s) na worktree do agente; sem `gh`, sem rede ou sem PR, `null`
  (sem PR) ou `{…, "unavailable": true}` com os campos `null`.
- `files`: caminho, tamanho e a primeira linha; nunca o arquivo inteiro (o texto é de `/api/orchestration/file`).

## `POST /api/argos/action`

Corpo: `{ "node": "<id de agente>", "action": "<nome>", "args": { … }, "confirm": "<nome do alvo>" }`. Resposta
`{ "v": 1, "ok": true, "node", "action", "output" }` (`output` = o que o comando imprimiu, até 2000 caracteres).

| `action` | `args` | Executa |
|---|---|---|
| `phase` | `phase` (até 40, `[\w .-]`), `text?` | `hades agent phase <nome> <fase> [texto]` |
| `resume` | `text?` | `hades agent resume <nome> [texto]` |
| `answer` | `question` (`Q<n>`), `reply` | `hades agent answer <nome> <Qn> <resposta>` |
| `prompt` | `text?` (sem texto, a tarefa padrão do brief) | `hades agent prompt <nome> [texto]` |
| `escalate` | `reason` (até 400) | `hades agent escalate <nome> <motivo>` |
| `park` | `reason?` (até 400) | `hades agent park <nome> [motivo]` — identifica por `node`, como as outras (§Montagem: servidor) |
| `done` | `keepPane?` | `hades agent done <nome> [--keep-pane]` — **destrutiva** |
| `free_prompt` | `text`, `session?` | prompt livre pela página Herdr (`/api/herdr/act`, `prompt`) no pane do agente |
| `text` | `text`, `session?` | texto no pane (`send-text`), pela página Herdr |
| `keys` | `keys` (lista das teclas da página Herdr), `session?` | teclas no pane (`send-keys`), pela página Herdr |
| `approve_permission`, `deny_permission` | `session?` | `Enter` / `Escape` no pane, com as três travas abaixo |
| `stop_session` | `session` (obrigatório, sem padrão) | parar a sessão do herdr (`/api/herdr/session`) — **destrutiva** |

- As ações `hades agent …` rodam o próprio comando num **subprocesso** (a mesma função de `src/commands/agent-run.ts`:
  nada reimplementado; `die` e as esperas de minutos não seguram o painel), na worktree do agente. Tempo máximo
  `HADES_ARGOS_ACTION_TIMEOUT_S` (1200 s; `answer` e `prompt` no máximo 120 s): `phase`, `resume`, `escalate` e `park` esperam o
  turno do agente, então a UI mostra "em andamento" até a resposta.
- `text` e `prompt` somam até 20 000 caracteres. O texto nunca vai ao log nem ao aviso.
- **Destrutivas** exigem `confirm` igual ao nome do agente (o `label` do nó), como a página Herdr pede o nome da sessão.
  `stop_session` ainda repassa o nome da sessão, que a página Herdr confere de novo.
- **`approve_permission` / `deny_permission`** (`session?`): mandam `Enter` (a opção "Yes" simples, nunca "não perguntar de
  novo") ou `Escape` ao pane do agente, pela página Herdr. Três travas, conferidas no servidor antes de qualquer tecla:
  há `pendingPermission` no diário; o herdr do agente está `blocked`; e a ferramenta pedida é `Bash`, `Edit`, `Write`,
  `NotebookEdit` ou MCP (`mcp__…`). Sem pedido pendente ou com o herdr não `blocked`: 409 `permission_not_pending`. Plano,
  pergunta e pedido sem ferramenta identificada: 422 `permission_not_supported` (responde-se no terminal).
  A ferramenta do pedido é a do texto do aviso ("use <Ferramenta>"); sem ela, é a do último `tool_pre` ainda sem `tool_post`
  antes do `permission` no diário do mesmo agente (`reference/journal.md`), então `Bash` sem o texto também vale. Sem `tool_pre`
  aberto, segue `null` e recusa. O diálogo do nó (`node-permission.tsx`) com os botões desabilitados mostra sempre o motivo
  (`blockedReason`) e "Para responder, vá ao terminal deste agente."; com o herdr fora de `blocked` o motivo cita o estado
  que o herdr marca. Pane que não está
  mais no `herdr agent list` (sessão encerrada): 409 `pane_gone`, antes de qualquer outra trava e sem enviar tecla.
  Evolução futura, sem mexer no diário por ora: campo aditivo `dialog` no evento `permission` (esquema v1 do diário) e
  tabela fechada diálogo → teclas.

### Erros

`{ "error": "<mensagem>", "code": "<código>" }`. O código só ganha valores; quem consome ramifica por ele.

| `code` | HTTP | Quando |
|---|---|---|
| `unknown_action` | 400 | ação fora da lista |
| `invalid_args` | 400 | `args` ou campo fora do formato/tamanho |
| `invalid_node` | 400 | `node`/`<id>` fora dos quatro formatos de id |
| `unknown_node` | 404 | id válido que não é um agente registrado (inclusive gate e PR) |
| `invalid_query` | 400 | `limit` fora de 1–500 ou `since` inválido |
| `confirm_required` | 400 | destrutiva sem o nome do alvo em `confirm` |
| `action_failed` | 422 | o comando do agente ou o herdr recusou (a mensagem é a última linha do erro) |
| `action_timeout` | 504 | passou de `HADES_ARGOS_ACTION_TIMEOUT_S` |
| `permission_not_pending` | 409 | approve/deny sem pedido pendente, ou com o herdr do agente fora de `blocked` |
| `pane_gone` | 409 | approve/deny de agente cujo pane não existe mais no herdr |
| `permission_not_supported` | 422 | approve/deny de diálogo que não é Bash/Edit/Write/NotebookEdit/MCP |

Falha interna segue o padrão do painel: 500 `internal_error`, detalhe só no log.

### Acesso remoto

Vale pelo túnel **sem trava**: executa direto, como no local. Toda ação (local e remota, inclusive as recusadas) grava uma
linha em `$D/logs/panel-argos.log`: `<UTC> quem=local|remoto[:<ip>] acao=<ação> alvo=<nó> resultado=ok|recusada:<código>|erro`
(o IP é o `cf-connecting-ip`, só informativo e só se tiver formato de IP; o acesso é decidido pela chave, nunca por
cabeçalho). Toda ação **remota** também notifica pelo `notify.sh` no evento `herdr` ("Herdr remoto", `--obj argos`), com
ação, alvo e resultado, sem aviso agrupado: uma notificação por ação. As de texto e teclas passam pela página Herdr, que
grava no log dela (`panel-herdr.log`) e avisa do seu jeito; o aviso pode vir duas vezes.

## Como a UI consome (contrato da página)

1. `GET /api/argos/graph` a cada poucos segundos (o herdr e o diário são lidos em cache curto); desenha por `type` e `kind`;
   ignora `type`/`kind`/campo desconhecido (o esquema só cresce; `v` novo = mudança de sentido).
2. Ao selecionar um nó `agent`: `GET /api/argos/node/<id>` para o histórico e `EventSource('/api/journal/stream?agent=<label>')`
   para o ao vivo (fechar ao trocar de nó).
3. Ação: `POST /api/argos/action` com o token da sessão; destrutiva pede o nome digitado e o manda em `confirm`;
   ramifica pelo `code`, nunca pelo texto.

## Provas

`loop/test/ts/argos.test.ts` (grafo, nó, ações pelo `hades agent` real com herdr e gh falsos, remoto, destrutivas).

## A página (`#/argos`, grupo Hades, primeira página)

Arquivos: `kit/panel/ui/pages/argos.tsx` (a página), `ui/argos/logic.tsx` (regra pura, `window.ArgosLogic`, testada por
`loop/test/ts/argos-ui.test.ts`), `ui/argos/parts.tsx` (canvas, lista, painel do nó, ações, paleta, ajuda e o quadro das camadas) e o motor
(`ui/argos/canvas-engine.tsx`). Menu, balão, caixa de permissão e minimapa são das camadas (§Camadas sobre o canvas na página). A regra do canvas (estado, desfazer, sincronia, gravação) é de `src/lib/canvas-store.ts`,
testada por `loop/test/ts/canvas-store.test.ts`. Sem dependência nova.

- **Vista.** Canvas infinito (motor: §Motor do canvas) com um nó por agente, unidade, PR e fila do gate, desenhados pelo
  registro de tipos (§Tipos de nó e comandos). **O dono posiciona**: arrastar grava a posição no documento
  (`PUT /api/canvas`), recarregar ou abrir em outra aba traz a mesma posição. As quatro colunas fixas saíram. A cada
  atualização do grafo (4 s, parada com a aba escondida) a sincronia (§Sincronia ao vivo) põe o nó novo perto dos vizinhos
  e tira o que sumiu; nada que já assentou se move. As **ligações do grafo** (`stack`, agente→PR, PR→gate…) são desenhadas só
  na vista, a partir do grafo; não entram no documento salvo, e todas têm o mesmo traço (o motor não distingue `kind`). A
  legenda de ligações saiu. A primeira vez que o canvas abre, a câmera enquadra os nós numa escala legível (mínimo 0,6).
  Contrato desconhecido (`v` ≠ 1) vira aviso, e `type`/`kind` desconhecidos são ignorados.
- **Palco.** A página é **stage**: `registerPage(..., { stage: true })`. O app tira o cabeçalho e o padding, força o trilho em
  64 px sem gravar a preferência (Ctrl+B e o botão do trilho ficam desligados nela), sobrepõe o fio global e deixa o `h1` só
  para leitor de tela (`sr-only`). O canvas ocupa tudo; congelado ou sem dados aparece um aviso (`StageNotice`). Sobre ele
  fica o **HUD**: ilha de estado, ilha de leitura (busca de verdade, que filtra e enquadra; popovers de **Filtros** e **Vista**,
  chips dos filtros ativos), lista de nós (`l`), toolbar vertical (44 px), grupo da câmera com desfazer e refazer, e a
  gaveta do nó. A vista é sempre o canvas; a lista é um painel sobre ele. `Ctrl+K` abre a paleta única (canvas e Painel, com
  o grupo "Painel", que traz "Tour desta página" quando a página tem tour); **F6** e **Shift+F6** andam entre as regiões. Esconder controles: §Esconder controles.
- **Filtros só escondem.** O filtro de estado, registro e papel tira o nó da vista, não do documento: a posição dele fica
  guardada e volta quando o filtro some. PR e gate aparecem enquanto ligados a um agente visível.
- **Gravação.** Cada gesto vira uma operação do histórico e agenda a gravação com debounce de 600 ms (`SAVE_DELAY_MS`).
  Falha de rede ou do servidor mostra um aviso e tenta de novo a cada 5 s. Revisão velha (`409`): **o servidor vence**; a
  página relê o documento, zera a pilha de desfazer e avisa por toast ("outra aba gravou antes"). Ao sair da aba
  (`pagehide`, aba escondida, desmontar a página) grava o que estiver na fila, com `keepalive` quando o corpo cabe nos 64 KiB.
  Se o documento não carrega, o canvas mostra o erro com "Tentar de novo" e a vista Lista continua.
- **Desfazer e refazer.** `Ctrl+Z` e `Ctrl+Shift+Z` (também na paleta e no menu do fundo, com condição). Valem para mover,
  redimensionar e as demais operações do `canvas-history`; o passo que aponta para um nó que já saiu do grafo é descartado.
  Dentro de campo de texto o `Ctrl+Z` é do campo (`inEditable: false`).
- **Menus.** Botão direito (ou Enter, tecla de menu, Shift+F10 com o nó em foco) abre o menu das camadas: no nó, as ações do
  agente e os comandos do tipo; no fundo, os comandos do canvas. Os comandos são os mesmos registrados que alimentam a paleta
  e a ajuda `?`.
- **Seleção.** Vários nós podem ser selecionados; o painel lateral e as ações só valem com **exatamente um** nó.
- **Destaque.** Borda âmbar pulsante = pede você (`pendingPermission` ou herdr `blocked`); borda vermelha = **parado**
  (herdr `working`, mas sem evento no diário há mais de 10 min). Os dois cartões do topo filtram por isso com um toque.
- **Estados e textos (erros e vazio).** Todo erro mostrado ao dono passa por `ArgosLogic.errorText`/`graphErrorText`: o
  código estável (`graph_failed`, `http_403`, `canvas_save_unreachable`…) vira frase e nunca aparece cru; código sem tradução
  cai numa frase de reserva ("a gravação foi recusada"), e o código fica só no `title`.
  - **Erro do grafo.** Sem grafo nenhum: "Não deu para carregar os agentes." com a causa em palavras, "Tento de novo a cada 4 s"
    e o botão **Tentar agora**. Com o último grafo já na tela: faixa "Sem atualizar desde HH:MM" dentro do canvas, com o mesmo
    botão; o canvas continua desenhado. Versão do grafo diferente: "Esta página não entende os dados do Argos."
  - **Erro de gravação.** Selo pequeno dentro do canvas (ícone + "Sem salvar", código e "suas mudanças seguem na tela" no
    `title`) e **Tentar agora** (`flush` do gravador). Só depois de 3 falhas seguidas (`SAVE_LOUD_AFTER`) vira texto vermelho
    ("Não deu para gravar o canvas: …"); gravar com sucesso zera a contagem.
  - **Canvas vazio.** O canvas segue montado, com as ferramentas (Nota, Terminal, Conexão, Papéis) e a mensagem no centro:
    sem nenhum agente, "Os agentes aparecem aqui assim que você criar o primeiro: hades agent new" com **Copiar o comando**
    (e os filtros ficam escondidos, pois só teriam zeros); com filtro, "Nenhum nó com esse filtro." e **Limpar os filtros**;
    padrão "Ativos" sem nada, "Nenhum agente em andamento." e **Mostrar todos (N concluídos)**. Nó do usuário (nota, texto…)
    à vista conta como canvas não vazio.
  - **Falha de ação.** O aviso é "Não deu para <verbo>" (`ACTIONS[].verb`), nunca "<ação>: não deu"; a causa vai na descrição.
    Nome de exceção do navegador não vira mensagem.
- **Filtros.** Estado (Todos · Ativos · Esperam por você · Trabalhando · Sem sinal · Ociosos ou sem terminal · Concluídos), registro (projeto ou `_skill`) e
  papel. PR e gate aparecem enquanto ligados a um agente visível.
- **Painel do nó** (só agente): estado, fase, branch e base; PR e CI (`passing/failing/pending`); brief, report, questions
  e handoff (abrem em texto puro numa folha); **faixa do tempo** = histórico do `GET /api/argos/node/<id>` + o SSE do
  diário (`EventSource` fechado ao trocar de nó), sem duplicar e com no máximo 300 eventos; o resultado das ações da sessão.
- **Estimado × real** (painel do nó, só agente com linha na `## Estimativa` do plano): custo real contra a faixa p25–p75,
  duração real e estimada e a confiança, de `GET /api/moirai/unit/<nome>?registry=<raiz>` (`reference/moirai.md`; a
  mesma atualização do detalhe). Selo âmbar "passou do estimado" ao passar de `HADES_MOIRAI_WARN_PCT` do p75 e vermelho ao
  passar de `HADES_MOIRAI_ASK_PCT`; sem estimativa, a seção e o selo não aparecem.
- **Ações** (`POST /api/argos/action`, por agente): aprovar/negar permissão (só com pedido pendente), prompt, retomar,
  mudar de fase, responder pergunta (só com `Q<n>` aberta), escalar, estacionar (menu do nó e lote), prompt livre, texto e tecla
  no terminal. As que esperam o turno do agente (`phase`, `resume`, `escalate`, `park`) ficam "em andamento" no painel até a resposta. **Só `done`
  (encerrar) pede o nome do agente digitado**, como a página Herdr; as demais executam direto. `stop_session` existe no
  servidor mas a página não a oferece (é da página Herdr). Erro: a mensagem sai do `code` estável.
- **Paleta** (Ctrl+K ou Cmd+K, ou `/`): lista os comandos do registro (agir no nó selecionado, filtrar por estado, trocar a vista, enquadrar, desfazer e refazer) mais "Ir para o nó". Na
  página o Ctrl+K da Argos vence o da base; fora dela volta a busca geral. Atalhos: §Atalhos.
- **Celular.** Abaixo de 768 px a vista inicial é a **lista** (quem pede você vem primeiro); o canvas segue disponível, com
  pinça e arrasto. Escolher um nó troca a tela por uma pilha (botão Voltar, painel, barra de ações com alvos de 44 px).
  Pelo acesso remoto vale o mesmo que no local: sem trava, com log e aviso do servidor (§Acesso remoto).
- Links diretos: `#/argos?node=<id>` abre com o nó selecionado.

### Atalhos

Vêm do registro de comandos (a ajuda `?` lista todos; `ArgosLogic.ACTION_GROUP` é o grupo das ações do nó).

| Atalho | Faz |
|---|---|
| `Ctrl+K` · `/` | paleta |
| `j` · `k` | próximo · anterior nó (ordem de leitura do canvas: de cima para baixo, da esquerda para a direita) |
| `Enter` · `Esc` | abrir o painel · fechar/limpar seleção |
| `a` · `x` | aprovar · negar a permissão pendente do nó |
| `p` · `r` | prompt · retomar |
| `f` · `l` · `?` | enquadrar · lista de nós · atalhos |
| `Shift+F` | esconder · mostrar controles |
| `v` | abre o popover Filtros |
| `F6` · `Shift+F6` | próxima · anterior região do HUD |
| `Ctrl+Z` · `Ctrl+Shift+Z` | desfazer · refazer |
| `Shift+H` | ocultar do canvas a seleção (§Ocultar e podar o canvas) |

Atalhos de uma tecla não valem dentro de campo de texto. Com o foco no canvas, as teclas do motor (Tab, setas, Enter, Esc,
Espaço, `+` `-` `0`, tecla de menu) são dele (§Teclado e leitor de tela) e a página só trata as demais (`j`, `k`, `f`, `?`, `Ctrl+…`).

## Documento do canvas

O canvas livre do Argos guarda o que o dono desenha e posiciona num documento JSON por instância. Esta camada é só o
modelo: formato, validação, migração, mescla com o grafo, a rota que grava e a pilha de desfazer. Desenho, câmera,
seleção e layout usam estes módulos e não fazem parte dela. Os dois módulos de lógica (`src/lib/canvas-doc.ts`,
`src/lib/canvas-history.ts`) não importam nada do Node: rodam no servidor e no navegador do painel.

### Formato (`v: 1`)

```json
{ "v": 1, "rev": 3,
  "nodes": [{ "id": "agent:proj:impl-a", "type": "agent", "x": 120, "y": 40, "w": 220, "h": 90, "z": 0, "data": {}, "locked": false, "blurred": false },
            { "id": "n1", "type": "note", "x": 0, "y": 0, "w": 160, "h": 80, "z": 1, "data": { "text": "…" }, "locked": false, "blurred": false }],
  "edges": [{ "id": "e1", "from": "agent:proj:impl-a", "to": "n1", "kind": "link" }],
  "groups": [{ "id": "g1", "label": "…", "members": ["agent:proj:impl-a", "n1"] }] }
```

- `rev` é a revisão da gravação (inteiro ≥ 0; o vazio nasce com 0). Quem escreve devolve a que leu.
- **Nó vivo** (`type` ∈ `agent`, `unit`, `pr`, `gate`, os tipos de `GET /api/argos/graph`): o `id` é o do grafo
  (`<type>:…`) e o documento guarda só posição e estado visual (`x`, `y`, `w`, `h`, `z`, `locked`, `blurred`); `data` é
  sempre `{}`. O conteúdo vem sempre do grafo. Os demais `type` (`[a-z][a-z0-9_-]{0,39}`) são livres: o registro de tipos
  vem depois e `data` é JSON puro de até 8 níveis.
- Aresta: `id`, `from`, `to` (ids de nós do documento), `kind` (mesmo padrão de `type`). Grupo: `id`, `label` (até 200),
  `members` (ids de nós do documento, sem repetir, ao menos um). Id: `[\w.:-]{1,200}`, único dentro da própria lista.
- Campo desconhecido é recusado (o formato só muda subindo `v`).
- Limites: 2000 nós, 5000 arestas, 500 grupos, corpo de 1 MiB (conta bytes); `x`/`y` até ±10 milhões, `w`/`h` de 1 a 1 milhão,
  `z` inteiro até ±1 milhão. Todos em `CANVAS_LIMITS`.

### Versão e migração

`v` é a versão do formato. A leitura (corpo do `PUT` e arquivo em disco) passa por `migrateCanvasDoc`, que aplica os passos
`v → v+1` da tabela `CANVAS_MIGRATIONS` até a versão atual (hoje só existe a v1, tabela vazia, caminho coberto por teste com
uma tabela injetada). Versão mais nova que a da skill, ou sem passo na tabela, é `canvas_unsupported_version`. O arquivo só
é regravado no próximo `PUT`.

### Onde fica e a rota

Arquivo `$D/canvas.json` (pasta de dados da instância; nunca no repositório nem na worktree), gravado de forma atômica
(`canvas.json.tmp` + `rename`). Estado do dono: o `install.sh` não o envia nem o remove (o kit não tem esse arquivo).
Este documento único é o **canvas padrão** (`default`) de §Vários canvases e exportação: continua no mesmo arquivo, sem migração.

| Rota | Faz |
|---|---|
| `GET /api/canvas` | o documento gravado (migrado); sem arquivo, o vazio v1 `{v:1, rev:0, nodes:[], edges:[], groups:[]}` |
| `PUT /api/canvas` | valida o corpo (o documento inteiro) e grava com `rev + 1`; responde `{v, ok: true, rev}` |

Acesso: o mesmo das rotas de escrita do painel. `GET` pela chave (acesso remoto) ou local; `PUT` também com o token da
sessão (`x-panel-token`), `Content-Type: application/json` e Origin conferido; o acesso remoto segue a regra existente (a chave
do túnel), sem trava extra. Cada gravação registra uma linha estruturada no log do painel (`canvas gravado`: `rev`, contagens,
`remote`; nunca o conteúdo).

**Conflito (409).** O `PUT` só grava se o `rev` do corpo for igual ao do arquivo; senão `409 canvas_stale_revision` com
`rev` (o atual) no corpo, sem gravar. O cliente relê, refaz a mudança e tenta de novo. Leitura, conferência e gravação
acontecem sem `await` no meio, então dois `PUT` simultâneos com o mesmo `rev` dão um 200 e um 409.

### Erros

`{ "error": "<mensagem genérica>", "code": "<código>" }`, sem caminho nem detalhe interno. O código só ganha valores.

| `code` | HTTP | Quando |
|---|---|---|
| `canvas_invalid_json` | 400 | corpo vazio ou que não é JSON |
| `canvas_too_large` | 400 | corpo acima de 1 MiB (pelo `Content-Length` ou, sem ele, pelo fluxo) |
| `canvas_invalid_shape` | 400 | raiz fora do formato, campo desconhecido, `rev`/listas inválidos |
| `canvas_unsupported_version` | 400 | `v` ausente, desconhecido, mais novo que a skill ou sem passo de migração |
| `canvas_invalid_node` / `canvas_invalid_edge` / `canvas_invalid_group` | 400 | item fora da forma (inclui nó vivo com conteúdo) |
| `canvas_duplicate_id` | 400 | id repetido na mesma lista |
| `canvas_dangling_reference` | 400 | aresta ou grupo aponta para nó que não está no documento |
| `canvas_limit_exceeded` | 400 | mais nós, arestas, grupos ou membros que o limite |
| `canvas_stale_revision` | 409 | `rev` do corpo diferente do gravado (traz `rev` atual) |
| `canvas_unreadable` | 500 | `$D/canvas.json` corrompido: GET e PUT recusam e **não** apagam o arquivo (o dono o remove ou corrige) |

Fora isso valem as recusas do painel (401 sem a chave, 403 sem o token ou com Origin fora da lista).

### Gravação e conflitos

Cada gravação leva a `rev` que a aba leu; se o servidor já passou dela, responde `409 canvas_stale_revision` com a `rev` dele.
**Toda recusa do `PUT` vai para o log** (`canvas recusado`, nível `warn`: `canvas`, `code`, `sent`, `rev`, `remote`); antes só
a gravação com sucesso deixava linha, então um 409 era invisível no `panel.log`.

O defeito que isto corrige: depois de outra aba (ou dispositivo) gravar, a aba que ficou na `rev` velha tinha a próxima edição
recusada com 409, o gravador **descartava** a edição na fila e a página relia o servidor com um aviso. A edição sumia (foi assim
que o terminal criado e a ligação com a nota se perderam). Agora:

- `createDocSaver` recebe `fetchServer()` (lê o documento atual) e `onRebased(doc)`. No 409 ele relê o servidor, reaplica a
  edição da aba com `rebaseDoc(base, mine, theirs)` e reenvia, até `MAX_REBASES` (3) vezes seguidas; passou disso, ou se o
  `fetchServer` falha, o estado é `error` com `canvas_save_conflict` e há nova tentativa a cada 5 s com o que está na fila.
- `rebaseDoc` é três vias por id (nó, aresta, grupo, oculto): o que só a aba mexeu fica como ela deixou; o que só o servidor
  mexeu (inclusive criou ou apagou) segue o servidor; mexido pelos dois, vence a aba; apagado pela aba mas mexido pelo servidor, fica
  (nada se perde). A base é o documento passado em `setRev(rev, doc)` ou o último gravado pela aba; sem base nada do servidor
  se apaga. Aresta ou membro de grupo cujo nó o servidor apagou cai (senão o documento inteiro seria recusado).
- Sem `fetchServer` o gravador mantém o contrato antigo (`onStale(rev, lost)`), mas agora entrega o documento descartado em
  `lost`, para o chamador avisar e oferecer recuperá-lo.

### Releitura do documento (mudança por fora)

A tela relê o documento quando alguém o grava por fora dela (a CLI `hades canvas`, um agente, outra aba). Antes só uma
conferência de 4 s olhava a `rev` de `GET /api/canvases`, e ela pulava em silêncio quando o gravador não estava ocioso, então a
mudança só aparecia com F5.

- **Empurrão.** `GET /api/canvas/stream` (SSE, `src/panel/canvas-stream.ts`, até 16 páginas; o excedente leva `429` com
  `Retry-After`) avisa `event: canvas` com `{ id, rev }` a cada gravação em disco (`PUT` do documento, criar, importar, renomear;
  a CLI também passa pelo `PUT`, então toda gravação avisa) e `event: registry` quando `argos/terminals.json` muda. O aviso não
  leva o documento: a tela relê pela rota de sempre. Gravação recusada (409) não avisa. O polling de 4 s (`POLL_MS`) e a volta
  da aba (`visibilitychange`) são a reserva; o `open` do stream também confere o que passou enquanto ele estava fora.
- **Regra** (`NT.createCanvasWatch`, `node-terminal.tsx`). `observe({ serverRev, hidden })` relê se a `rev` do servidor passou da
  conhecida, a aba está visível e o gravador ocioso e sem edição na fila (`externalRevReload`). Senão pula e registra o motivo no
  console (`canvas: releitura pulada`): `hidden`, `busy: <estado>` (`saving`, `error`, `fila`) ou `rev igual`, uma vez por mudança de
  motivo. Passados `EXTERNAL_STALE_MS` (10 s) atrás do servidor sem poder reler, a tela mostra "O canvas mudou por fora" com o botão
  Recarregar (grava o que está na fila e relê; com o gravador em erro só avisa, porque reler jogaria a edição fora).
- **Depois do envio.** Quando o gravador volta a `idle` com a tela atrás do servidor, `settled` relê na hora. Isso fecha o caso
  silencioso: no 409 com edição na fila a tela não recebe o documento reconciliado, mas a `rev` gravada avançava a `rev` conhecida
  e a conferência nunca mais via diferença. Agora esse caso marca a tela como atrás (`diverged`) e a `rev` gravada não vale como
  em dia. O eco da própria gravação (chega antes da resposta do `PUT`) não relê.
- **Leitura descartada.** `loadCanvas` descarta o documento lido se uma edição entrou na fila (ou o gravador ocupou) enquanto a
  leitura ia: aplicá-lo jogaria fora a edição da tela e o nó que ela acabou de criar.
- **O que não anda sozinho.** Registro de agentes (`<orch>/agents/*.json`) é escrito pela CLI direto em disco, sem passar pelo
  painel: continua chegando pelo polling do grafo (4 s). `argos/terminals.json` é do painel e empurra `registry` (a tela relê o grafo).
  Edição à mão do `canvas.json` que não incrementa `rev` não é vista por nenhum dos caminhos.

### Mescla com o grafo

`mergeWithGraph(doc, graphNodes)` (`src/lib/canvas-doc.ts`) recebe o documento salvo e os `{id, type}` dos nós de
`GET /api/argos/graph` e devolve `{doc, unplaced, removed}`:

- nó vivo do documento que não está mais no grafo sai (em `removed`), com as arestas que o tocavam, o membro nos grupos e o
  grupo que ficou sem membros;
- nó vivo do grafo que o documento não tem vai em `unplaced` (na ordem do grafo). A mescla **não escolhe posição**: o layout
  dá `x`, `y`, `w`, `h` e cria o nó pela operação `create`;
- nó que não é vivo nunca é tocado; tipo de grafo desconhecido é ignorado; o documento de entrada não muda.

### Desfazer e refazer (`src/lib/canvas-history.ts`)

Funções puras e imutáveis (documento e pilha de entrada nunca mudam). Uma operação é um dado com tudo que o inverso precisa:
`move`, `resize`, `create`, `delete`, `group`, `ungroup` e o lote (`batch`, vários passos que desfazem juntos).
`invert(op)` dá o inverso exato (`applyOp(applyOp(doc, op), invert(op))` é igual a `doc`, até na ordem das listas): `delete`
guarda o nó, as arestas que o tocavam e o estado anterior dos grupos que perderam membro. Os construtores (`opMove`,
`opResize`, `opMoveMany`, `opCreate`, `opDelete`, `opGroup`, `opUngroup`, `opBatch`) leem o documento para montá-las; os ids
novos vêm de quem chama. O lote é tudo ou nada.

A pilha (`createHistory(limit)`, padrão 100, máximo 1000, em passos: um lote conta um) guarda `past` e `future`. `perform`
aplica e registra; `record` só registra o que o chamador já aplicou (arrastar mostra ao vivo e registra ao soltar); `undo` e
`redo` devolvem `{doc, history}` ou `undefined` sem passo. Operação nova limpa o refazer; passar do limite derruba o passo
mais antigo. Erros: `HistoryError` com `history_invalid_op`, `history_missing_target`, `history_duplicate_target`,
`history_dangling_reference`, `history_limit_exceeded` e `history_empty_batch`. Bloquear mover nó `locked` é da seleção
(motor de desenho), não deste módulo.

Provas: `loop/test/ts/canvas-doc.test.ts`, `canvas-history.test.ts`, `canvas-route.test.ts`.

### Terminal fora do canvas

Terminal criado pela tela chegava ao herdr e ao `argos/terminals.json`, mas o nó podia não entrar no `canvas.json` (409 do `PUT`
sem aviso): o terminal ficava vivo e invisível.

- **Criação só termina com o nó gravado.** `NT.ensureNodeSaved` (`node-terminal.tsx`) aplica a inclusão do nó, grava, confere o
  documento do servidor e, se o nó não está lá, relê e reaplica, até 3 tentativas como a CLI `hades canvas`. A inclusão é
  idempotente por par `session`/`pane` (tentativa que já gravou não cria outro nó). Esgotadas, o toast diz "Terminal criado, mas o
  nó não foi gravado" (código `terminal_node_unsaved` no console) e o terminal aparece como órfão.
- **Recusa no log.** O `PUT /api/canvas` recusado (409) grava `canvas recusado` em `$D/logs/panel.log` com a `rev` do corpo, a `rev`
  atual e `remote`.
- **Órfãos.** `GET /api/argos/terminals/orphans` devolve `{ orphans, checked }`: terminal registrado, com pane vivo no herdr e sem
  nó em canvas nenhum (cada `canvases/*.json` conta; documento ilegível não conta). `checked: false` quando o herdr não respondeu
  ou o painel não tem a lista de panes: nunca se chama de órfão o que não foi conferido, e a tela não mostra nada. O servidor
  registra `terminal fora do canvas` (warn).
- **Tela.** Banner "N terminal(is) vivo(s) fora do canvas: <nomes>" com a ação "Trazer para o canvas" (cria os nós no centro da
  vista, com nome, agente, modelo, esforço, papel e orquestrador do registro, e grava). A lista é lida na montagem, no evento
  `registry` do stream e depois de cada releitura do documento; um toast avisa uma vez por órfão novo.
- **Fora desta entrega.** Guardar revisões anteriores do documento (item 4 da issue).

## Vários canvases e exportação

O dono pode ter vários canvases por instância. O **padrão** (`default`) é o documento único de antes: o mesmo
`$D/canvas.json`, lido e gravado por `GET/PUT /api/canvas` como sempre (e também por `/api/canvases/default`). Os demais
ficam em `$D/canvases/<id>.json`, um arquivo por canvas (`{ "name": "…", "doc": <documento v1> }`), gravados de forma atômica.
Estado do dono: a pasta `canvases/` nunca é tocada pelo `install.sh`, igual a `canvas.json`.

Código: `src/lib/canvas-store.ts` (id, nome e códigos, puros), `src/lib/canvas-export.ts` (exportar e importar, puro) e
`src/panel/canvas.ts` (disco e rotas). O documento (`canvas-doc.ts`) não mudou.

**Id:** `[a-z0-9][a-z0-9_-]*`, 1 a 64 caracteres (lista fechada: sem ponto, barra nem maiúscula, então `..` nunca passa); o
caminho resolvido é conferido dentro de `$D/canvases/` mesmo assim. `default` é reservado ao padrão. **Nome:** 1 a 200
caracteres, sem controle. **Teto:** 100 canvases além do padrão.

| Rota | Corpo | Faz |
|---|---|---|
| `GET /api/canvases` | | `{default, canvases: [{id, name, rev, nodes, edges, updatedAt}]}`, padrão primeiro, o resto por id; `updatedAt` em UTC (`null` se o padrão nunca foi gravado); arquivo ilegível aparece como `{id, unreadable: true}` |
| `POST /api/canvases` | `{name, id?}` | cria vazio (rev 0); sem `id`, derivado do nome (`meu-mapa`, `meu-mapa-2`…); `201 {id, name, rev}` |
| `GET /api/canvases/<id>` | | o documento (o do padrão sem arquivo é o vazio v1) |
| `PUT /api/canvases/<id>` | documento inteiro | valida e grava com `rev + 1`, **mesma regra e mesmos limites de `PUT /api/canvas`** (1 MiB, `409 canvas_stale_revision` com `rev`); o canvas precisa existir (criar é `POST`) |
| `POST /api/canvases/<id>/rename` | `{name}` | muda só o nome; documento e `rev` intactos; `200 {ok, id, name}` |
| `POST /api/canvases/<id>/delete` | `{}` | apaga o arquivo; `200 {ok, id}` |
| `GET /api/canvases/<id>/export` | | o arquivo de exportação (abaixo) |
| `POST /api/canvases/import` | arquivo de exportação | importa (abaixo); query `id` e `overwrite` |

Apagar e renomear são `POST` porque o servidor do painel só aceita GET, POST e PUT. O padrão não se renomeia nem se apaga.
Acesso: o mesmo de `PUT /api/canvas` (chave no túnel, token da sessão `x-panel-token`, `Content-Type: application/json`, Origin
conferido); cada escrita registra uma linha estruturada no log (`canvas gravado|criado|renomeado|apagado|importado`, com `canvas`
e `remote`, nunca o conteúdo).

### Formato de exportação

```json
{ "format": "hades-canvas", "exportVersion": 1, "name": "Meu mapa", "exportedAt": "2026-11-02T12:00:00.000Z",
  "doc": { "v": 1, "rev": 3, "nodes": [], "edges": [], "groups": [] } }
```

Importar valida tudo antes de gravar: tamanho (texto até 1 MiB + 4 KiB de envelope; o `doc` até 1 MiB), `format`,
`exportVersion` e o `doc` inteiro pelo validador do documento (`readCanvasDoc`, com migração por `v`). **Nó vivo volta só como
posição:** o `data` que o arquivo trouxer nele é descartado (o conteúdo vem do grafo). A `rev` do arquivo é ignorada.

- Sem `id`: o canvas nasce com id derivado do nome, `rev: 0`; `201 {id, name, rev, replaced: false}`.
- Com `id` livre: cria nele (`201`).
- Com `id` que já existe: `409 canvas_exists`, a menos que venha `overwrite=true` (confirmação explícita); então substitui, a
  `rev` vira a do canvas substituído + 1 (quem tinha o canvas aberto leva `409 canvas_stale_revision` e relê) e responde
  `200 {…, replaced: true}`. No padrão o nome continua `Padrão`.

### Erros

Mesmo envelope de §Erros: `{error, code}`; a importação acrescenta `reason` (a mensagem do validador, sem caminho). Os códigos
de §Erros valem aqui (`canvas_invalid_json`, `canvas_too_large`, `canvas_invalid_*`, `canvas_stale_revision`,
`canvas_unreadable` etc.) e a família ganhou:

| `code` | HTTP | Quando |
|---|---|---|
| `canvas_invalid_id` | 400 | id fora da lista fechada (em rota, corpo ou query) |
| `canvas_invalid_name` | 400 | nome vazio, grande demais ou com caractere de controle (também no `name` do arquivo importado) |
| `canvas_default_protected` | 400 | renomear ou apagar o padrão |
| `canvas_not_found` | 404 | o id não existe (ler, gravar, renomear, apagar, exportar) |
| `canvas_exists` | 409 | criar ou importar em id que já existe sem `overwrite=true` |
| `canvas_limit_reached` | 409 | já são 100 canvases |
| `canvas_export_invalid_format` | 400 | o arquivo não é uma exportação de canvas (`format`) |
| `canvas_export_unsupported_version` | 400 | `exportVersion` diferente da conhecida |

O pacote do Caronte fica fora desta camada.

Provas: `loop/test/ts/canvas-store.test.ts`, `canvas-route.test.ts`, `canvas-export.test.ts`.

## Tipos de nó e comandos

Dois registros, em `src/lib/canvas-types.ts` e `src/lib/canvas-commands.ts` (sem Node, rodam no navegador). O Argos de hoje
usa as mesmas funções de registro que um plugin usaria (`src/lib/canvas-argos.ts`, `createArgosRegistries`). **Carregar tipo
ou comando de plugin fica fora desta parte**: o ponto de extensão é só `register` e a validação.

### Tipo de nó

`createNodeTypeRegistry().register(def)`. Todo campo é obrigatório:

| Campo | O que é |
|---|---|
| `type` | `[a-z][a-z0-9_-]{0,39}`, o mesmo `type` do documento |
| `label` | nome para a tela (até 80) |
| `icon` | nome do ícone do painel (`HadesCore.I`), ex. `Bot` |
| `defaultSize` | `{w, h}` inteiros de 1 a 1 milhão (o nó novo nasce com ele) |
| `draw` | `{surface: "canvas" \| "html", render(input)}`: desenhado no canvas (SVG) ou como HTML por cima |
| `menu` | ids de comando do botão direito do nó, em ordem |
| `actions` | ids das ações do servidor (`POST /api/argos/action`) que o tipo oferece |
| `live` | vem de `/api/argos/graph`; **só `agent`, `unit`, `pr`, `gate` são vivos** (regra do documento), então `live` tem de bater com isso |

Erros (`RegistryError.code`, estáveis, só ganham valores): `registry_invalid_type`, `registry_missing_field` (com o campo),
`registry_invalid_field`, `registry_duplicate`, `registry_live_mismatch`, `registry_unknown_type` (só `sizeOf`),
`registry_invalid_shortcut`, `registry_shortcut_conflict`, `registry_unknown_reference`. A declaração é copiada e congelada: mudar o
objeto original depois não altera o registro. Quatro tipos do Argos estão registrados (unidade, agente, PR, fila do gate),
todos vivos, 200×66, desenhados no canvas; só o agente tem ações e menu.

### Comando

`createCommandRegistry<Ctx>().register(def)`, declarado uma vez:

- `id` (`[\w.:-]{1,200}`), `label` (texto ou `(ctx) => texto`), `hint?`, `group`, `run(ctx)`.
- `shortcut?`: um acorde ou lista (`"mod+k"`, `"j"`, `"?"`, `"Escape"`, `"mod+shift+z"`). `mod` = Ctrl ou Cmd. Letra em minúscula
  (maiúscula é `shift+k`); em pontuação o caractere já traz o shift (`?`, não `shift+?`). Dois comandos com o mesmo acorde, ou o
  mesmo acorde repetido, é `registry_shortcut_conflict` **no registro**: o segundo não entra.
- `surfaces`: onde aparece, entre `palette` (Ctrl+K), `node-menu` (botão direito no nó) e `canvas-menu` (botão direito no
  fundo). A ajuda `?` não é superfície: lista todo comando que tem atalho, valha ou não agora. Comando sem superfície e sem
  atalho é recusado (ninguém o alcança).
- `when?(ctx)`: condição. Falsa, o comando some da paleta e dos menus e o atalho não dispara (ex.: aprovar permissão só com
  pedido pendente). Sem ela, vale sempre.
- `inEditable?`: vale com o foco num campo de texto. Acorde com `mod` sempre vale; os demais só com `inEditable` (o `Esc`).

Listas: `palette(ctx)`, `canvasMenu(ctx)`, `nodeMenu(type, ctx)` (os ids que o tipo declara em `menu`, na ordem dele; id que não
existe ou sem a superfície `node-menu` é `registry_unknown_reference`), `help(ctx)`. O teclado passa por
`resolveKey(event, {editable, ctx})`, que devolve o comando ou `null`. `chordLabel("mod+k")` escreve `Ctrl+K` para a tela.

**Comandos do Argos já migrados** (mesmos ids que o mapa de atalhos antigo): `palette` (`Ctrl+K`, `/`), `next` (`j`), `prev` (`k`),
`open` (`Enter`), `close` (`Esc`), `fit` (`f`), `toggle-view` (`l`), `help` (`?`), `action:<id>` (uma por ação do servidor;
`a` aprovar, `x` negar, `p` prompt, `r` retomar), `filter:<estado>` (os filtros de estado da paleta), `view:graph`, `view:list`.
O contexto (`ArgosCommandCtx`) leva o nome do nó selecionado, os ids das ações oferecidas agora e os ganchos da página
(`handlers`).

## Layout

`src/lib/canvas-layout.ts`. Um layout decide **onde entra o nó que ainda não tem posição no documento**; ninguém mais é
movido por ele. A interface, `CanvasLayout`:

- `id`, `label`;
- `place({doc, entering, neighbors})`: uma posição `{id, x, y}` por nó de `entering` (tamanho já definido), sem tocar em
  `doc`. `neighbors` mapeia cada id aos ids com aresta no grafo (pode citar nó que também está entrando). Determinística: mesma
  entrada, mesma saída, em qualquer ordem;
- `arrange?({doc, neighbors})`: opcional, reorganiza o documento inteiro. É o gancho do **layout de forças** (§Layout de forças);
  o livre não tem.

`createLayoutRegistry()` guarda layouts (`register` valida id, rótulo e `place`; id repetido é `registry_duplicate`);
`defaultLayoutRegistry()` já traz o livre. Não há modo alternável: o canvas usa o livre.

**Layout livre** (`FREE_LAYOUT`, id `free`): a posição é do dono, guardada no documento (`x`, `y` de cada nó, gravadas pelo
`PUT /api/canvas`). As **quatro colunas fixas saem**. Só o nó novo recebe posição, assim: o nó com mais vizinhos já assentados
vai primeiro (depois o de mais ligações, depois o id), então uma cadeia nasce encadeada; o ponto de partida é o centro dos
vizinhos assentados (sem vizinho: abaixo de todo o conteúdo, ou na origem num documento vazio); a posição é a mais próxima, em
passos do tamanho do nó, que não encosta em nenhum nó do documento (folga de `LAYOUT_GAP` = 24), preferindo a **direita** (o
fluxo vai da esquerda para a direita). Se nenhuma posição couber em 60 anéis, cai para baixo de todo o conteúdo. Um índice por
grade evita varrer todos os nós a cada candidato.

## Layout de forças

`src/lib/canvas-force.ts` (id `force`, rótulo "Forças") e `src/lib/canvas-quadtree.ts`. Lógica pura, sem Node, testada em
`loop/test/ts/canvas-force.test.ts` e `canvas-quadtree.test.ts`. **Ligada à página `#/argos`** (§Leitura do grafo na página): o
seletor da barra troca entre o layout livre (o padrão) e este.

**O que faz.** Cada nó é um corpo no centro do seu retângulo. A cada passo: repulsão entre todo par (`repulsão / d²`,
aproximada por Barnes–Hut numa quadtree reconstruída a cada passo), mola em cada par ligado em `neighbors`
(`rigidez × (d − repouso)`), gravidade fraca ao centro de massa do início, e colisão entre círculos da meia diagonal + metade da
folga. A velocidade é amortecida (`damping`) e limitada (`maxSpeed`); as forças, menos a colisão, esfriam a cada passo
(`cooling`). A simulação **para** quando a média de velocidade² por nó móvel cai abaixo de `energyThreshold`, ou no teto de
passos; o resultado diz `steps`, `settled` e `energy`.

**Entradas.**

- `forcePlace({doc, entering, neighbors}, opts)`: só os nós de `entering` se mexem, a partir do lugar que o layout livre daria;
  o documento fica parado. Garantia igual à do livre: nó novo não encosta em ninguém (folga `LAYOUT_GAP`); quem ainda encostar
  no fim volta ao lugar do livre. Uma posição por nó novo.
- `forceArrange({doc, neighbors}, opts)`: o documento inteiro se reorganiza a partir das posições atuais. Uma posição por nó
  (o fixado volta exatamente onde estava). A colisão é macia: sem sobreposição na prática, não garantida (medido: 1 par a 2000
  nós).
- `forceReheat({doc, neighbors, from, hops}, opts)`: **reaquecer local** depois de arrastar `from`. Ele fica onde o dono o
  soltou; só os nós a até `hops` arestas dele (padrão 2, teto 8) voltam a mexer; o resto empurra e puxa, mas não sai do lugar.
  Devolve a posição só de quem podia mexer.
- **Em passos**: `startArrange(...)` e `startReheat(...)` (mesmos argumentos) devolvem uma simulação com `step(n)` (avança até
  `n` passos, inteiro de 1 a 5000, e devolve `{steps, settled, energy, done}`) e `placements()` (posições atuais, no formato da
  função de uma vez). Avançar em fatias dá exatamente o mesmo resultado que de uma vez; depois de `done`, `step` não faz nada.
  É o caminho da página: fatias de ~8 ms por quadro (a página mede o tempo e escolhe `n`; a lógica não lê relógio), arranjo
  animado e cancelável parando de chamar. Worker só se a fatia não bastar.
- `createForceLayout({pinned, params})`: o layout como `CanvasLayout` (`place` e `arrange` devolvem só as posições); os
  parâmetros são conferidos na criação. `FORCE_LAYOUT` é o de padrões. Entra no registro como qualquer layout
  (`registry.register(FORCE_LAYOUT)`); o `defaultLayoutRegistry()` continua só com o livre.

**Pin.** Fica fixo o nó com `locked` no documento ou com o id em `pinned` (conjunto passado nas opções; id que não está no
pedido é ignorado). `pinNode(pins, id)` e `releaseNode(pins, id)` (soltar) devolvem um conjunto novo. Soltar não destrava o
`locked` do documento: isso é um comando sobre o documento. Depois de soltar, `forceReheat` a partir do nó o deixa assentar.

**Determinismo.** Corpos e molas em ordem de id, perturbação inicial de até meio pixel por hash do id com `seed` (quebra
simetria exata, como cadeia em linha reta ou nós no mesmo ponto), direção de separação de corpos coincidentes por hash do par.
Sem `Math.random` nem relógio: a mesma entrada, em qualquer ordem de nós e de arestas, dá a mesma saída. Outra `seed`, outro
arranjo igualmente válido.

**Parâmetros** (`FORCE_DEFAULTS`; `params` aceita qualquer subconjunto, e chave desconhecida ou valor fora da faixa é erro):

| Parâmetro | Padrão | Faixa | O que é |
|---|---|---|---|
| `springLength` | 280 | 1..100000 | repouso da mola, entre centros (px) |
| `springStrength` | 0.04 | 0..1 | rigidez da mola |
| `repulsion` | 500000 | 0..1e12 | repulsão entre todo par |
| `gravity` | 0.0002 | 0..1 | puxão ao centro de massa |
| `collision` | 0.8 | 0..1 | fração da sobreposição que vira velocidade de afastamento |
| `gap` | 24 | 0..10000 | folga mínima entre nós (px) |
| `damping` | 0.6 | [0, 1) | velocidade que sobra a cada passo |
| `cooling` | 0.015 | [0, 1) | esfriamento das forças por passo (0 desliga) |
| `theta` | 0.8 | 0..2 | abertura de Barnes–Hut (0 é exato e quadrático) |
| `maxSpeed` | 60 | (0, 100000] | deslocamento máximo por passo (px) |
| `energyThreshold` | 0.25 | (0, 1e12] | limiar de assentamento (px²/passo²) |
| `maxSteps` | 1500 | 1..5000 | teto de passos |
| `seed` | 1 | inteiro 0..2³²−1 | semente da perturbação inicial |

**Limites e erros.** `ForceError` com `code` estável (`FORCE_ERRORS`) e `subject` (parâmetro ou id), no mesmo molde do
`RegistryError`:

| Código | Quando |
|---|---|
| `force_too_many_nodes` | mais de 2000 nós (documento + entrando), antes de simular |
| `force_too_many_springs` | mais de 10000 pares ligados distintos |
| `force_too_many_steps` | `maxSteps` acima de 5000 |
| `force_invalid_param` | parâmetro desconhecido, não finito, fora da faixa; `hops` fora de 0..8 |
| `force_invalid_input` | nó com posição ou tamanho inválido, id repetido, nó entrando que já está no documento, `from` fora do documento |
| `force_diverged` | posição final fora da faixa do documento (±10.000.000): falha, nunca trunca |

Vizinho que cita id fora do pedido e laço no próprio nó são ignorados (como no livre).

**Medido** (Bun, grafo sintético com ~1,5 aresta por nó partindo de grade encostada): 1000 nós assentam em 500 passos,
~1,2 s (~2,3 ms/passo); 2000 nós em 815 passos, ~4,2 s (~5,1 ms/passo). `forcePlace` de 20 nós sobre 1000 assentados: ~96
passos, ~25 ms. Por passo, a repulsão é ~2/3 do custo e a colisão o resto. Armadilhas medidas: sem esfriamento, o ruído do
Barnes–Hut e o modo lento da gravidade seguram a energia acima do limiar por milhares de passos; colisão como correção de
posição fora da velocidade deixa nós encostados tremendo ~1 px e dobra os passos; repulsão fraca demais deixa a gravidade e as
molas espremerem o grafo grande, e a colisão passa a carregar o assentamento. Rodar na thread da página trava a interface pelo
tempo acima: a integração decide entre worker e passos em fatias.

## Sincronia ao vivo

`syncWithGraph(doc, graph, {layout, sizeOf})` em `src/lib/canvas-sync.ts`: função pura sobre o documento atual e o grafo
novo (`{nodes: {id, type}[], edges: {from, to}[]}`), que devolve `{doc, added, removed, skipped, changed}`.

- **Nó novo** (nó vivo do grafo que não está no documento): entra pelo layout, perto dos vizinhos com quem tem aresta, sem
  sobrepor ninguém; tamanho do tipo (`sizeOf`, o `defaultSize` do registro), `data: {}`, camada acima das existentes.
- **Nó que sumiu** do grafo: sai do documento, com suas arestas e a participação em grupos (grupo que fica vazio some). É a
  `mergeWithGraph`, sem mudança.
- **Posição definida pelo dono sempre vence e nada que já assentou se move:** todo nó que já está no documento volta igual,
  campo a campo (nota, trava, camada). Nó do usuário (tipo não vivo) nunca é removido nem tocado.
- Determinística (mesmo documento e grafo dão o mesmo resultado, em qualquer ordem de nós e de arestas) e idempotente (sincronizar
  de novo com o mesmo grafo devolve o mesmo objeto, `changed: false`).
- **As arestas do grafo não entram no documento**: a página as desenha direto do grafo a cada atualização; só as arestas do
  usuário vivem no documento. Assim um grafo que muda a cada 4 s não regrava o documento.
- `rev` não muda (é do servidor). Teto de 2000 nós: o que não couber fica em `skipped`, nunca se descarta nó do dono. Layout que
  devolve posição faltando, repetida ou de nó de fora é `sync_invalid_layout`; posição fora da faixa do documento falha na
  validação final (`canvas_invalid_node`).

## Motor do canvas

O motor desenha o documento do canvas e trata a interação direta: câmera, camadas, seleção, mover e redimensionar, teclado
e leitor de tela. Ele não grava nada e não guarda o histórico: cada gesto terminado sai como **uma** operação do
`canvas-history` (arrasto de vários nós = um lote), e quem usa o motor aplica, registra e persiste. A página `#/argos`
usa o motor com os registros, o layout livre, a sincronia e a gravação (§A página).

Arquivos: lógica pura em `src/lib/canvas-camera.ts` e `src/lib/canvas-selection.ts` (sem Node, testadas pelo `bun test`);
o componente em `kit/panel/ui/argos/canvas-engine.tsx` só liga eventos, desenha e cuida do foco.

### Como a UI carrega os módulos do modelo

A UI do painel são scripts clássicos sem bundler; os módulos do modelo vivem em `src/lib`. Para haver uma fonte só, o
servidor empacota na hora do pedido (Bun.build, formato iife, cache pelo mtime dos arquivos) a lista permitida
`CANVAS_UI_MODULES` de `src/panel/ui-transpile.ts` e serve o pacote em `GET /ui/lib/canvas-model.js`, que registra
`window.CanvasModel = { doc, history, camera, selection, types, commands, layout, sync, store, argos }` (congelado).

- Um pacote só, e não um arquivo por módulo: `canvas-history` importa `canvas-doc`, e pacotes separados duplicariam as
  classes de erro (o `instanceof` falharia) e as constantes.
- Nome pedido fora da lista (`/ui/lib/canvas-doc.js`, `/ui/lib/argos.js`, subpasta, `..` cru ou codificado): 404, sem
  ler disco. Cada arquivo da lista tem o caminho real conferido dentro de `src/lib` (link para fora é recusado), e o
  empacotamento falha se algum módulo importar arquivo fora da lista (inclui `node:*`): o pacote nunca puxa outro código.
  Falha de empacotamento: 500 `ui_module_build_failed`, detalhe só no log do painel.
- Mesmo acesso das demais leituras do painel (local, ou a chave no acesso remoto).

Ordem dos scripts para quem usa o motor (`index.html` já a segue): React, `/ui/lib/canvas-model.js`, `/ui/argos/canvas-engine.js`, depois a página.

### Camadas e quadros

Quatro `<canvas>` 2D empilhados (grade, arestas, nós, sobreposição do retângulo de seleção) e, por cima, a camada HTML
dos nós ricos (conteúdo React posicionado pela câmera; o cabeçalho fica no canvas). Cada camada só é redesenhada quando
algo que ela mostra muda (pan e zoom sujam todas; arrastar suja arestas e nós; o retângulo só a sobreposição). Não há
laço contínuo: o quadro é pedido por `requestAnimationFrame` quando algo muda, e parado o motor não desenha. Os canvas
seguem o `devicePixelRatio` (e trocam de tamanho com ele e com o `ResizeObserver`). As cores vêm das variáveis do tema
(`--background`, `--card`, `--border`, `--ring`, `--chart-1..5`), relidas ao trocar claro/escuro.

Só entra no quadro o que cruza a tela (recorte por retângulo, linear: 2000 nós custam bem menos de 1 ms; índice espacial
fica para quando a medição pedir). Arestas são cortadas pela caixa das duas pontas.

### Câmera

`{x, y, k}`: `x`/`y` é o ponto do mundo no canto superior esquerdo, `k` a escala. Zoom de 0,05 a 4 (`CAMERA_LIMITS`),
sempre ancorado (o ponto sob o cursor ou sob o meio da pinça não anda). Roda: aproxima e afasta no cursor (linha e página
convertidas em pixels). Pinça: escala pela razão dos dedos e arrasta junto. Enquadrar (`fitRect`, `fitAll`) usa folga de
48 px; revelar o nó focado faz o menor pan possível. Animação de câmera (enquadrar, revelar) dura 220 ms e some com
`prefers-reduced-motion`.

### Nível de detalhe

| Escala | Nó |
|---|---|
| `k < 0,25` | bloco de cor (agrupado por cor), anel na seleção |
| `0,25 ≤ k < 0,6` | bloco com faixa de cor e rótulo curto em fonte fixa de tela |
| `k ≥ 0,6` | nó completo: cabeçalho colorido com rótulo, tipo no corpo, conteúdo HTML se o nó for rico, alça na seleção |

O 0,6 é o padrão do nó completo. Em **Vista → Conteúdo dos nós** o dono escolhe 60%, 45%, 30% ou 20% de zoom
(`FULL_DETAIL_CHOICES`), um limite só para todos os tipos (terminal, nota, agente, PR…), guardado no navegador
(`hades.argos.fullDetail`; valor fora da lista volta ao padrão, `fullDetailScale`). O motor recebe a escolha em
`fullDetail` e todo `detailFor` dele a usa: desenho, conteúdo HTML, alça e clique mudam juntos. O bloco nunca começa depois
do nó completo (com 20%, abaixo dela é bloco de cor). A abertura e o "Focar no nó" seguem em 0,6. Limite menor monta mais
nós ricos de uma vez, o que pesa mais com muitos terminais e notas à vista.

Nó `locked` tem borda tracejada; `blurred` sai esmaecido.

**Abertura.** Sem câmera salva, a câmera abre com tudo à vista se couber em escala ≥ 0,6; senão, em 0,6 a partir do canto
superior esquerdo do conteúdo (centrado se couber na largura). A regra é uma só (`openingCamera`, em `canvas-camera.ts`):
vale para a câmera da página e para o enquadramento inicial do motor.

**Cor no canvas.** O fill do nó trabalhando é o `--vivo` diluído a 55% no cartão, e o de concluído ou em repouso é o
`--muted-foreground` a 40%. O `--vivo` cheio fica para o que pede ação, e o `--ring` só marca seleção e foco: a seleção nunca
usa a cor de um estado. De longe, o nome do nó selecionado aparece abaixo da forma. O rótulo do nó nunca passa de 11 px de
tela para baixo, na família de `--font-sans` (o primeiro desenho espera `document.fonts.ready`). A grade mostra só a linha
maior, em `--border`, e some abaixo de 16 px de tela.

**Elevação.** Tudo que flutua sobre o canvas (dock, supervisor, composer, legenda, ferramentas, câmera, minimapa, balão,
menus da nota) usa `elev-float`: borda `--border` e sombra curta `--elev`. A gaveta do nó, presa à borda, usa `elev-shadow`.
Não há `shadow-*` solto.

**Pulso.** Só o que pede você (severidade `attention`) pulsa, e só sob `prefers-reduced-motion: no-preference`; nó
trabalhando é estático.

**Papéis de tipo.** Título de nó: `t-body-strong`. Estado no corpo do nó: `t-meta-em`; papel e fase: `t-micro` muted.
Cabeçalho de seção da legenda: `t-micro` caixa-alta; itens `t-label`. Controle: `t-control` (13 px/500/32 px; 44 px no
toque). Texto longo corta por largura (`truncate`) com `title` do texto inteiro, nunca por contagem de caracteres.

### Gestos

| Gesto | Faz |
|---|---|
| clique no nó | seleciona só ele (já selecionado com outros: mantém o grupo para arrastar; sem arrasto, fica só ele) |
| Shift+clique | soma ou tira o nó |
| clique no vazio | limpa (com Shift, mantém) |
| arrastar o fundo | pan (padrão, `backgroundDrag: "pan"`); com `"select"`, retângulo |
| Shift+arrastar no vazio | retângulo de seleção, somando à seleção (pega o que ele toca) |
| botão do meio | pan, sempre |
| arrastar pelo cabeçalho | move o nó, ou a seleção inteira se ele estiver nela; ao soltar, o nó pego encaixa na grade de 20 e os outros andam o mesmo delta |
| arrastar o corpo (detalhe completo) | pan (o corpo é do conteúdo); longe, o nó inteiro vale como cabeçalho |
| alça (canto inferior direito, nó selecionado) | redimensiona; ao soltar, as bordas direita e de baixo encaixam na grade; lado mínimo 40 |
| dois dedos | pinça (zoom e pan) |

Nó `locked` não move nem redimensiona: pegá-lo não move ninguém, e no meio de uma seleção ele fica parado. Movimento
abaixo de 3 px ainda é clique.

### Teclado e leitor de tela

O canvas é uma parada do Tab (`role="application"`, nome acessível com as instruções). Ao entrar, o foco vai ao primeiro
nó (ou ao último, vindo de trás com Shift+Tab); Tab e Shift+Tab percorrem os nós na ordem de leitura (de cima para baixo,
da esquerda para a direita, desempate pelo id) e saem do canvas nas pontas. O nó focado ganha um botão por cima, com foco
visível e nome acessível (rótulo, "selecionado", "bloqueado"), e a câmera o revela.

| Tecla | Faz |
|---|---|
| Enter, tecla de menu, Shift+F10 | pede o menu do nó (`onNodeMenu`; o menu é da página) |
| Espaço / Shift+Espaço | seleciona só o focado / alterna |
| setas (Shift: 5 grades) | movem o nó focado pela grade (e a seleção, se ele estiver nela): o equivalente ao arrasto |
| setas sem nó focado | pan |
| `+` `-` `0` | aproxima, afasta, enquadra todos |
| Esc | cancela o gesto; senão limpa a seleção; senão tira o foco do nó |

Recusas (nó bloqueado) e mudanças de seleção pelo teclado são anunciadas numa região `aria-live`. Atalhos com Ctrl, Alt
ou Meta passam direto para a página.

### API do motor para a página

`window.ArgosCanvas.CanvasView` (React) ou `createCanvasEngine(parts, options)` (sem React). As props/opções:

```ts
doc: CanvasDoc                                   // documento atual (fonte da verdade é a página)
selection: readonly string[]                     // seleção controlada
onSelectionChange(ids: readonly string[]): void
onOp(op: CanvasOp, next: CanvasDoc): void        // gesto terminado: aplicar (next), history = record(history, op), gravar
onNodeMenu?(req: { id: string; screen: { x: number; y: number } }): void
onCameraChange?(cam: Camera): void
describeNode?(node): string                      // rótulo e nome acessível; padrão "tipo id"
nodeColor?(node): string                         // padrão: paleta por tipo
isRich?(node): boolean; renderNode?(node): ReactNode   // conteúdo HTML do nó (só os visíveis no detalhe completo montam)
backgroundDrag?: "pan" | "select"                // padrão "pan"
initialCamera?: Camera                           // sem ela, enquadra todos no primeiro quadro
label?: string                                   // nome da área
onReady?(api: CanvasEngineApi): void
```

`CanvasEngineApi`: `getCamera()`, `setCamera(cam, animate?)`, `fitAll(animate?)`, `fitRect(rect, animate?)`,
`zoomBy(factor, anchor?)`, `focusNode(id)`, `revealNode(id, animate?)`, `viewport()`, `onFrame(listener)` (devolve o
cancelamento; cada quadro traz o custo em ms, quantos nós à vista e o nível de detalhe). Funções que retornam callbacks
precisam de identidade estável (`useCallback`): trocar `describeNode` ou `nodeColor` refaz os rótulos e redesenha.

### Harness de escala e como medir

`/dev/canvas` (fora da navegação do dono; mesmo acesso das leituras) carrega só React, o pacote do modelo e os scripts
do motor, e desenha um documento sintético determinístico (`kit/panel/ui/argos/canvas-synth.tsx`: `?n=100|500|1000|2000`,
padrão 1000). A barra mostra quadros desenhados no último segundo (0 parado é o esperado), custo do quadro p50/p95, nós à
vista, nível de detalhe e o tempo até o primeiro quadro (desde o início do script do harness e desde a navegação).

**Medir** (botão, ou `?bench=1` ao abrir) roda quatro fases de 3 s com eventos sintéticos pelo mesmo caminho do gesto
real: pan com tudo à vista, pan em `k=0,4` (rótulos), zoom pela roda varrendo os três níveis, e arrasto de 50 nós
selecionados em `k=0,7`. Para cada fase: fps do navegador, quadros desenhados, custo p50/p95/máx e intervalos acima de
25 ms. Com `?bench=1` o resultado fica em `window.__canvasBench` e o título da aba vira `bench:done`, para um navegador
remoto (Marionette ou WebDriver) ler. Meta: ≥ 50 fps no pan e no zoom com 1000 nós num navegador de desktop. Headless
sem GPU mede um limite inferior.

Provas: `loop/test/ts/canvas-camera.test.ts`, `canvas-selection.test.ts`, `canvas-modules.test.ts`.

## Navegação

Gestos, atalhos e controles de câmera do canvas. Esta seção vale sobre as linhas de roda e de pinça de §Câmera e §Gestos
(que descrevem a roda só como zoom): a roda comum agora distingue mouse de trackpad. Regra pura em `src/lib/canvas-camera.ts`
(testada em `loop/test/ts/canvas-camera.test.ts`); eventos em `kit/panel/ui/argos/canvas-engine.tsx`; botões em
`kit/panel/ui/argos/canvas-controls.tsx` (`loop/test/ts/canvas-controls.test.ts`).

### Gestos

| Gesto | Faz |
|---|---|
| dois dedos no trackpad (rolar) | pan; o conteúdo acompanha os dedos |
| pinça no trackpad, ou duas pontas na tela de toque | zoom ancorado no meio dos dedos (a pinça também arrasta) |
| roda de mouse (entalhe de 100 px, ou em linhas) | zoom ancorado no cursor |
| Alt + roda | zoom ancorado no cursor, em qualquer aparelho (a saída para quem tem trackpad que se confunde com mouse) |
| Ctrl + roda | zoom (com delta pequeno é a pinça do trackpad, mais sensível) |
| botão do meio + arrastar | pan, sobre qualquer coisa |
| Espaço (segurado) + arrastar | pan, sobre qualquer coisa, inclusive o conteúdo de um nó rico; o cursor vira mão |
| arrastar o fundo | pan (§Gestos) |

O navegador não diz se a roda é de mouse ou de trackpad: o critério é o passo. Um entalhe de mouse chega como delta inteiro de
50 px ou mais, sem componente horizontal (ou em linhas); o que sai disso (pixels fracionários, deltas pequenos, componente
horizontal) é tratado como dois dedos. Mouse que entrega passos pequenos pode cair em pan: Alt + roda dá o zoom sempre.
A pinça do Safari (que não usa roda com Ctrl) não é coberta.

**A rolagem dos campos não é roubada.** A roda comum sobre um campo de texto ou uma lista que rola dentro de um nó rico é do
elemento enquanto ele tem curso na direção da roda; no fim do curso ela volta para o canvas. Ctrl e Alt são sempre do canvas.
Espaço, setas e Ctrl+= dentro do conteúdo de um nó rico também não chegam ao motor.

`prefers-reduced-motion: reduce` desliga as animações de câmera (enquadrar, focar, passos de zoom, revelar o nó focado): a
câmera salta ao destino. Ligar a preferência no meio de uma animação leva a câmera ao destino na hora.

### Atalhos

Com o canvas focado (o motor os trata; Ctrl+= e Ctrl+- vencem o zoom da página):

| Atalho | Faz |
|---|---|
| `+` · `=` · `-` | aproxima · afasta um passo (×1,25), em torno do centro da tela |
| `Ctrl+=` · `Ctrl++` · `Ctrl+-` | o mesmo |
| `Ctrl+0` | zoom 100% |
| `0` | enquadra todos |
| setas sem nó focado | pan |
| Espaço (solto sem arrastar) | seleciona o nó focado, como antes; segurado e arrastando vira pan e não seleciona |

Pela página (registro de comandos, em qualquer lugar fora de campo de texto; `Ctrl+=`, `Ctrl+-` e `Ctrl+0` nem tentam dentro
de um campo, onde o zoom é do navegador):

| Comando (id) | Atalho | Onde aparece |
|---|---|---|
| Aproximar (`zoom-in`) | `Ctrl+=` · `Ctrl++` | Ctrl+K, botão direito no fundo, `?` |
| Afastar (`zoom-out`) | `Ctrl+-` | idem |
| Zoom 100% (`zoom-reset`) | `Ctrl+0` | idem |
| Zoom na seleção (`zoom-selection`) | `z` | idem, só com nó selecionado |
| Focar em <nó> (`focus-node`) | `c` | idem, só com nó selecionado |
| Enquadrar o canvas (`fit`, já existia) | `f` | idem |

Os cinco comandos novos nascem de `cameraCommandDefs()` em `canvas-camera.ts` e entram no registro da página por
`ArgosCanvasControls.registerCameraCommands(commands)` (idempotente): o módulo do registro (`canvas-commands.ts`) não muda. Quem
os executa é `cameraHandlers(getApi, getPrimary)`, que a página mistura ao `handlers` do contexto dos comandos.

### Câmera: focar, seleção e enquadrar

- **Enquadrar tudo** (`fitAll`): a caixa de todos os nós, com folga de 48 px e zoom entre 0,05 e 4.
- **Zoom na seleção** (`fitSelectionCamera`): a caixa dos selecionados, com a mesma folga, mas o zoom para em `focusZoomMax`
  (1,5): um nó sozinho não enche a tela. Sem seleção, o motor cai em enquadrar tudo.
- **Focar um nó** (`focusNodeCamera`): centraliza o nó e sobe a escala até o detalhe completo (0,6) se estiver mais longe;
  quem já está perto não é afastado. Nó maior que a tela vira enquadrar. Não move o foco do teclado (`focusNode` do motor é
  outro comando: leva o foco e revela).
- **100%** (`zoomReset`): escala 1 em torno do centro da tela.

`CanvasEngineApi` ganhou, de forma aditiva: `zoomIn`, `zoomOut`, `zoomReset`, `fitSelection`, `centerNode(id)`,
`onCamera(listener)` (cada mudança de câmera, também durante animação; devolve o cancelamento) e o terceiro argumento
`animate` de `zoomBy` (padrão `false`, como antes). Nenhuma prop existente mudou.

### Controles do canvas (`canvas-controls.tsx`)

Grupo (`role="group"`, nome "Controles de câmera do canvas") com quatro botões nativos, alcançáveis por Tab, cada um com nome
acessível e dica com o atalho: **Afastar**, **nível de zoom** (a porcentagem; ativar volta a 100%), **Aproximar** e
**Enquadrar tudo**. Aproximar e Afastar desligam (`disabled`) no limite de zoom. Uma região `role="status"` fora da tela
anuncia "Zoom N%" só quando o zoom fica parado por 500 ms (pinça e roda mudam a cada quadro).

```tsx
<ArgosCanvasControls.CanvasControls api={engineApi} className="absolute right-2 bottom-2 ..." />
```

`api` é o `CanvasEngineApi` que o `onReady` do motor entrega (`null` antes: nada é desenhado); sem `className`, o grupo vai
para o canto inferior direito do contêiner posicionado mais próximo. Com `HadesCore` na página usa o `Button` e os ícones
dele; sem ele (harness), botão nativo com glifo. O ouvinte de câmera e o temporizador do anúncio saem juntos ao desmontar.

Provas: `loop/test/ts/canvas-camera.test.ts`, `loop/test/ts/canvas-controls.test.ts`.

## Leitura do grafo (modelos puros)

Quatro modelos sem Node e sem DOM em `src/lib/` (`canvas-neighbors.ts`, `canvas-filters.ts`, `canvas-search.ts`,
`canvas-urlstate.ts`), testados por `loop/test/ts/canvas-<nome>.test.ts`. Estão no pacote `/ui/lib/canvas-model.js`
(`CANVAS_UI_MODULES`) e ligados à página `#/argos` (§Leitura do grafo na página). Todos leem os nós como o
`GET /api/argos/graph` os entrega (campo a mais é ignorado) e nenhum altera o que recebe. Medido sobre 2000 nós e 5000
arestas sintéticos (Bun, p50): filtrar ~2 ms, barra de chips ~3 ms, buscar com índice pronto ~0,2 ms.

### Vizinhança

`neighborhood(selection, edges, nodeIds)` devolve `levels[0..2]` (0 = os nós selecionados, 1 = vizinhos diretos, 2 =
segundo salto), `dimmed` (o resto, para esmaecer), `unknown` (ids da seleção que não existem) e `active`.

- A aresta vale nos dois sentidos. Quem já está num nível menor não repete em outro; com vários nós selecionados todos
  são nível 0 e a expansão parte de todos. A ordem dentro de cada lista é a de `nodeIds`.
- Sem foco (seleção vazia ou só de ids que não existem) `active` é `false` e **nada esmaece**.
- Laço, aresta repetida e aresta para id que não está em `nodeIds` são ignorados. Custo linear em nós + arestas; o
  alcance é fixo em 2 saltos (`NEIGHBOR_DEPTH`).

### Filtros

`buildFilterBar(nodes, edges, selection, nowMs)` monta os chips por dimensão; `applyFilters(...)` devolve `visible` (ids)
e as arestas com as duas pontas visíveis. Dimensões (`FILTER_DIMS`): **estado**, **tipo de nó**, **tipo de ligação**,
**papel**, **raiz** (o `registry` do nó), **idade** e **custo**.

- `selection` é `{ dimensão: [valores] }`. Dentro de uma dimensão os valores marcados valem como "ou"; entre dimensões, "e".
  Ausente ou lista vazia = sem filtro. `toggleFilter` liga e desliga um valor sem mudar a seleção recebida.
- **Contagem facetada.** O número de cada chip conta os nós que passam pelos filtros das **outras** dimensões, nunca o da
  própria; assim dá para ver o que marcar a mais traria. Tipo de nó, tipo de ligação, idade e custo mostram sempre todos
  os chips (inclusive com 0); estado, papel e raiz mostram o que existe, por contagem. Valor marcado que sumiu do grafo
  continua com contagem 0 para poder ser desmarcado.
- Tipo de ligação vale por **qualquer ponta** da aresta e o nó é contado uma vez por tipo. Sem papel, sem raiz ou sem
  ligação é o valor `UNSET` (`"-"`).
- **Faixas.** Idade, do `lastEventTs` até o relógio: `m15` (até 15 min), `d1` (até 1 dia), `d7` (até 7 dias), `older`, e
  `none` (sem evento, ou texto sem fuso explícito, que não é lido como hora local). Evento no futuro conta como recente.
  Custo (`costUsd`, em dólares): `low` (< 1), `mid` (< 10), `high`, e `none` (ausente, negativo ou não finito).
- **Relógio por parâmetro** (`nowMs`): relógio não finito lança `FilterError` (`filters_invalid_clock`). Os nós do grafo de
  hoje não trazem `costUsd`; o campo é opcional e a integração é quem o fornece (sem ele o nó fica em `none`).

### Busca

`createSearchIndex(items)` normaliza os campos uma vez; `index.search(termo)` (ou `searchNodes(items, termo)`, sem índice)
devolve `{ ids, box, term, problem? }`: os ids na ordem dos nós e o menor retângulo que contém os nós achados (para
`fitRect`/`revealRect` da câmera; `undefined` sem resultado).

- Casa **nome** (`label`: agente, unidade), **card**, **PR**, **branch** e **arquivo** (`files`, caminho inteiro) por trecho,
  sem acento e sem caixa. `#123` casa só a PR de número 123; `123` casa PR cujo número começa por 123 **e** qualquer texto
  que o contenha (um card `QTO-123`). Termo vazio não acha nada.
- **Sem regex montada com a entrada**: a comparação é de texto (`includes`), então `(a+)+$` ou `.*` são só caracteres.
- **Teto do termo**: 100 caracteres depois de aparar e juntar espaços (`SEARCH_LIMITS.termChars`); texto cru acima de 400
  é recusado antes de normalizar. Acima do teto a busca **não trunca**: devolve vazio com `problem: "search_term_too_long"`.
  O campo de busca da página deve ter `maxLength` igual a `termChars`.
- `card` e `files` não existem no grafo de hoje; são campos opcionais do item. Sem eles, só nome, PR e branch casam.

### Estado na URL

`serializeUrlState(state)` e `parseUrlState(hash)`: a câmera, os filtros, a busca e o nó aberto vão no hash e voltam
**exatos** (números pelo texto mais curto que os reproduz; só o sinal do zero negativo se perde).

```
#/argos?node=agent:p:a1&cx=12.5&cy=-300&ck=0.7&f.state=working&f.state=idle&f.cost=high&q=%23123&v=1
```

- Estado padrão (`defaultUrlState()`: sem câmera, sem filtro, sem busca, sem nó) é só `#/argos`. Qualquer outro leva
  `v=1`; `node` é o link direto que já existe. O link antigo sem versão (`#/argos?node=<id>`, e só ele) segue valendo.
- **Ler nunca lança.** Hash de outra rota, sem `v`, com chave desconhecida ou repetida, dimensão de filtro desconhecida,
  câmera incompleta, não finita ou fora dos limites (`k` de 0,05 a 4, centro dentro de ±10⁷), valor vazio ou acima de
  200 caracteres, mais de 50 valores numa dimensão, busca acima do teto ou id de nó fora de `[\w.:-]+` voltam ao estado
  padrão com `warning`: `urlstate_invalid`, `urlstate_unsupported_version` (`v` de outro número, antes de olhar o resto) ou
  `urlstate_too_long` (hash acima de 4096 caracteres). Nada é "corrigido" em silêncio (a câmera não é clampada).
- `serializeUrlState` lança `UrlStateError` (mesmos códigos) para estado que não caberia numa URL válida.
- **Vistas salvas** (modelo puro; onde guardar é da página): `addView`, `renameView` e `removeView` devolvem
  `{ ok: true, views }` ou `{ ok: false, code }` sem alterar a lista. Nome aparado e com espaços juntados, até 60
  caracteres, **único sem diferenciar a caixa**, no máximo 50 vistas; renomear só a caixa do próprio nome vale.
  Códigos: `view_name_empty`, `view_name_too_long`, `view_name_taken`, `view_not_found`, `view_limit`,
  `view_invalid_camera`. `readViews(raw)` lê o que veio do armazenamento do navegador e fica só com o que passa pelas mesmas
  regras, contando `dropped`.

## Ações (modelos puros)

Três modelos sem Node e sem DOM em `src/lib/` (`canvas-actions.ts`, `canvas-batch.ts`, `canvas-next.ts`), testados por
`loop/test/ts/canvas-<nome>.test.ts`. Estão no pacote `/ui/lib/canvas-model.js` (`actions`, `batch`, `next` em `CANVAS_UI_MODULES`) e ligados à
página `#/argos`: o menu das camadas lê `canvas-actions` (§Menu, balão e permissão no nó), e o lote e o próximo que pede o
dono são comandos de `commands-canvas.tsx` (§Comandos de organização). Nenhum dispara requisição: quem chama faz o `POST /api/argos/action` e lê a resposta.
O servidor continua sendo o controle (permissão pendente, `confirm`, argumentos): desabilitar item aqui é só tela.
`canvas-actions.ts` e `canvas-batch.ts` importam **só o tipo** `ActionName` de `src/panel/argos-actions.ts` (apagado na
transpilação): ação nova na rota quebra a compilação até ganhar a linha na tabela.

### Menu do nó (`canvas-actions.ts`)

`actionsFor(node, ctx?)` devolve os itens do menu de um nó: `{ key, label, hint, dangerous, available, reason?, fields }`.
`node` é o nó do grafo (`id`, `type`, `label`, `state`, `registryState`, `herdrState`, `pendingPermission`) mais
`openQuestions` opcional, que vem do detalhe do nó (`files.questions.openQuestions`); o grafo não o traz. `ctx.herdrAvailable`
é o `herdr.available` do grafo (ausente = não bloqueia).

- Só `agent` recebe ação: gate, PR, unidade e tipo desconhecido devolvem lista vazia. Para agente vêm sempre todos os
  itens de `MENU_ACTIONS`, na ordem; o que não vale agora traz `available: false` e `reason: { code, message }` para a
  tela mostrar desabilitado. Códigos (`ACTION_REASONS`, só ganham valores): `action_not_agent`, `action_agent_closed`,
  `action_no_pending_permission`, `action_permission_not_supported`, `action_no_open_question`, `action_herdr_unavailable`,
  `action_herdr_not_seeing`.
- `fields` diz o que a tela coleta: `{ name, required, kind }` (`text`, `phase`, `question`, `session`); em `question`,
  `choices` traz os `Q<n>` abertos (título que não começa com `Q<n>` é ignorado).
- `isDangerousAction(key)` espelha as destrutivas da rota (`done`, `stop_session`): o servidor exige `confirm` igual ao
  nome do agente (`node.label`). `actionRequest(node, key, args?, confirm?)` monta o corpo do POST e repassa `confirm`
  como veio.
- Ficam fora do menu `text` e `keys` (terminal cru, do compositor e do teclado). "Abrir PR" e "copiar nome" não são
  ações da rota, então não aparecem aqui.
- `isSimplePermissionTool` (`src/lib/argos.ts`) lê o diário e não roda no navegador; a regra está espelhada no módulo e o
  teste confere a paridade ferramenta a ferramenta.

| Ação | `fields` | Vale quando | Destrutiva |
|---|---|---|---|
| `approve_permission`, `deny_permission` | — | `pendingPermission` + herdr `blocked` + ferramenta `Bash`/`Edit`/`Write`/`NotebookEdit`/`mcp__…` | não |
| `answer` | `question` (dos abertos), `reply` | agente aberto com pergunta `Q<n>` aberta | não |
| `prompt`, `resume` | `text?` | agente aberto | não |
| `phase` | `phase`, `text?` | agente aberto | não |
| `escalate` | `reason` | agente aberto | não |
| `park` | `reason?` | agente aberto | não |
| `free_prompt` | `text`, `session?` | herdr vê o agente | não |
| `done` | — | agente aberto | **sim** |
| `stop_session` | `session` | herdr vê o agente | **sim** |

"Agente aberto" = nem `state` nem `registryState` em `done`/`archived`. Todos os itens valem só para nó `agent`.

### Lote (`canvas-batch.ts`)

`planBatch(selection, action, args?, ctx?)` devolve `{ action, args, targets, excluded, dangerous, effect, confirmPhrase?,
problem? }`. Cada nó da seleção (ordem de entrada, id repetido conta uma vez) é alvo se a ação vale para ele agora
(`actionsFor`); senão vai para `excluded` com `{ id, label, code, reason }` (os códigos de `ACTION_REASONS`).

- **Ações de lote** (`BATCH_ACTIONS`): `resume`, `prompt`, `phase`, `park`, `approve_permission`, `deny_permission`, `done`. As que
  pedem algo por agente (`answer`, `escalate`, `stop_session`, `free_prompt`, `text`, `keys`) são `batch_action_not_supported`.
  Os mesmos `args` valem para todos os alvos; a rota ainda valida o formato por agente.
- **Teto** `BATCH_MAX_TARGETS` = 50: acima disso o lote é recusado inteiro (`batch_too_large`), nunca truncado.
- `problem` (`BATCH_ERRORS`, só ganham valores) impede qualquer pedido: `batch_action_not_supported`,
  `batch_empty_selection`, `batch_too_large`, `batch_missing_args` (campo obrigatório vazio, ex. `phase`),
  `batch_no_valid_targets`. `targets` e `excluded` seguem preenchidos para a tela explicar.
- `effect`: texto da confirmação, ex. `Retomar 2 agentes: a1, a2. 1 nó fica de fora.` (até 10 nomes, depois "e mais N").
  O texto de um prompt nunca entra: só o tamanho.
- `batchRequests(plan, typed?)` devolve `{ ok: true, requests }` (um pedido por alvo, na ordem do plano) ou
  `{ ok: false, code }`. Lote com `problem` não gera nada. Lote **destrutivo** (`done`) só gera depois de `typed` (aparado)
  ser igual a `plan.confirmPhrase`, a quantidade de alvos; cada pedido leva o `confirm` do próprio agente, que o servidor
  confere por alvo. Os pedidos saem do modelo, mas quem os envia é o chamador (um POST por agente; `resume` e `phase`
  esperam o turno do agente, até `HADES_ARGOS_ACTION_TIMEOUT_S`).
- `summarizeBatch(plan, responses)` com `responses = [{ id, status, body? }]` (`status: 0` = sem resposta) devolve
  `{ items, excluded, totals, finished }`. Por agente: `ok` (2xx com `ok: true`), `refused` (4xx com `code`: argumento,
  confirmação, permissão, comando ou herdr que recusou), `error` (5xx, `status: 0` → `batch_no_response`, corpo que não é
  o da rota → `batch_unexpected_response`) e `pending` (sem resposta ainda, para mostrar o andamento). `code` e `message`
  (até 300 caracteres) vêm da rota. Resposta de id que não é alvo é ignorada; duas respostas ao mesmo alvo valem pela
  última.

### Próximo que precisa do dono (`canvas-next.ts`)

`ownerQueue(nodes)` devolve `[{ id, reason, since }]`; `cycleOwner(queue, currentId, "next" | "previous")` anda nela.

- **Razões** (`OWNER_REASONS`, da mais urgente): `permission` (`pendingPermission`, inclusive de ferramenta que a rota não
  aprova: se responde no terminal), `question` (`openQuestions` não vazio) e `gate` (nó `gate` com `state: "failed"` ou
  agente com `gateFailed: true`). Agente `done`/`archived` nunca entra; PR e unidade também não. Nó com mais de uma razão
  vale pela mais urgente, uma vez só.
- **Ordem estável**: prioridade da razão, depois o que espera há mais tempo (`since`: o `ts` da permissão, senão o
  `lastEventTs` do nó), sem instante por último, e no empate o id (comparação por código, sem locale). A ordem de entrada
  dos nós não muda o resultado. Só instante ISO com fuso conta; texto sem fuso não é lido como hora local e fica como
  `since: null`.
- **Ciclo**: do último volta ao primeiro e do primeiro, no "anterior", ao último. Sem `currentId` na fila (nada selecionado,
  ou o nó já foi atendido e saiu), "próximo" vai ao primeiro e "anterior" ao último. Fila vazia: `undefined`; com um
  item só, devolve esse item.
- **O grafo de hoje não traz** perguntas abertas (só o detalhe do nó, `openQuestions`) nem o resultado de um gate (a fila
  do gate só tem `running`/`waiting`): quem integra preenche `openQuestions` e `gateFailed` (ou entrega um nó `gate` com
  `state: "failed"`). Sem eles, só a permissão pendente entra na fila.

Provas: `loop/test/ts/canvas-actions.test.ts` (inclui o contrato com `createActions`: destrutivas e campos obrigatórios
batem com a rota), `canvas-batch.test.ts`, `canvas-next.test.ts`.

## Organização (modelos puros)

Cinco modelos sem Node e sem DOM em `src/lib/` (`canvas-groups.ts`, `canvas-align.ts`, `canvas-snap.ts`,
`canvas-clipboard.ts`, `canvas-walk.ts`), testados por `loop/test/ts/canvas-<nome>.test.ts`. Quatro estão no pacote
`/ui/lib/canvas-model.js` (`groups`, `align`, `clipboard`, `walk`) e ligados à página pelos comandos de organização
(§Comandos de organização). **`canvas-snap.ts` não está no pacote** e a página não passa a porta `snap`: o encaixe
magnético (`snap:toggle`) não está ligado. O documento (`canvas-doc`) e
a pilha (`canvas-history`) **não mudam**: tudo aqui só monta operações com os construtores que já existem.

**Convenções comuns.**
- Cada função lê o documento e devolve uma `CanvasOp` (o chamador aplica com `perform`/`applyOp`; `undo` volta ao
  documento anterior **igual, até na ordem das listas**) ou `undefined` quando não há o que mudar: seleção vazia ou curta
  demais, tudo travado, posição já certa. Passo vazio nunca vai para a pilha. Vários passos saem em um `batch`, que é um
  passo só do desfazer.
- O documento recebido nunca é alterado. Operações da seleção leem os nós numa passada pelo documento e o resto custa pelo
  tamanho da seleção; id repetido na seleção conta uma vez.
- **Nó travado** (`locked`) nunca se move, mas conta como referência (alinhar), âncora (distribuir) e vizinho (encaixe).
  **Nó vivo** (`agent`, `unit`, `pr`, `gate`) pode ser agrupado, alinhado e movido (o documento guarda só a posição dele);
  não é copiado, duplicado nem excluído.
- Erro é `OrgError` com `code` de `ORG_ERRORS` (só ganha valores): `org_unknown_node`, `org_unknown_group`,
  `org_invalid_label`, `org_invalid_id`, `org_invalid_number` (deslocamento, zoom, grade ou limiar que não é finito, ou
  coordenada fora do documento), `org_invalid_mode`, `org_duplicate_id`, `org_limit_exceeded`, `org_invalid_clip`. Id que
  o documento não tem é erro (a página poda a seleção de ids que saíram do grafo antes de chamar), nunca é ignorado.
- Ids novos vêm de quem chama (como em `opGroup`/`opCreate`).

### Grupos (`canvas-groups.ts`)

Usa o campo `groups` do documento (`{ id, label, members }`), sem campo novo.

- `createGroup(doc, { id, label, members })`: nome aparado, 1 a 200 caracteres. **Um nó fica em no máximo um grupo**: quem
  já estava em outro sai dele, e o grupo antigo que fica com menos de dois membros se desfaz (`GROUP_MIN_MEMBERS`); o grupo
  novo entra no fim da lista. Menos de dois nós distintos: `undefined` (o grupo de um membro não existe).
- `ungroup(doc, groupId)`: os nós ficam onde estão. `renameGroup(doc, groupId, label)`: mantém a posição do grupo na
  lista (sai como `ungroup` + `group` no mesmo índice, então o desfazer é exato); mesmo nome: `undefined`.
- `moveGroup(doc, groupId, dx, dy)`: move os membros que não estão travados, em um passo só.
- `groupBox(doc, groupId, { padding?, header? })`: o menor retângulo que contém os membros mais a folga (`GROUP_BOX_PADDING`,
  16) e, se pedido, a altura do cabeçalho em cima. Lê os membros a cada chamada, então acompanha o que se move; grupo
  inexistente: `undefined`.
- `dissolveSmallGroups(working, candidates)`: passos que desfazem, entre os grupos `candidates`, os que ficaram com menos
  de dois membros (o grupo pequeno que a operação não tocou fica). É o que `deleteNodes` usa.
- Apoio: `groupIndex(doc)` (nó → grupo), `pickNodes(doc, ids)`.

### Alinhar e distribuir (`canvas-align.ts`)

- `alignNodes(doc, ids, modo)`, modo em `ALIGN_MODES` (`left`, `center`, `right`, `top`, `middle`, `bottom`): alinha à
  caixa que envolve a seleção (travados entram na caixa). Menos de dois nós: `undefined`.
- `distributeNodes(doc, ids, eixo)`, eixo `horizontal` ou `vertical`: vãos iguais. Os nós de menor e de maior centro e os
  travados são **âncoras** e ficam parados; entre duas âncoras seguidas, os livres dividem o espaço em vãos iguais.
  Ordena pelo centro (empate: ordem de `ids`). Menos de três nós: `undefined`.
- `snapNodesToGrid(doc, ids, grade = GRID_SIZE)`: encaixa o canto de cada nó livre na grade de 20 (arredonda para o mais
  perto; nunca grava `-0`).

### Encaixe do arrasto (`canvas-snap.ts`)

`snapFrame(proposto, vizinhos, { zoom, thresholdPx? })` recebe o quadro já na posição do arrasto e os quadros que **não**
estão sendo arrastados. O limiar é em pixels de **tela** (`SNAP_THRESHOLD_PX`, 6): vale `px / zoom` no mundo. Cada eixo é
decidido sozinho; fora do limiar o ajuste é 0 e não há guia. Devolve `{ dx, dy, frame, guides }`, em que `dx`/`dy` é o que
somar ao quadro proposto.

- Candidatos: lado com lado (inclusive o oposto, que cola um no outro) e centro com centro; vãos iguais (no meio de dois
  vizinhos que se sobrepõem ao quadro na faixa cruzada, ou repetindo o vão que dois vizinhos seguidos já têm, de cada
  lado). Vence o mais perto; empate fica com parede e centro.
- Guias: `{ kind: "edge" | "center", axis, at, from, to }` (com `axis: "x"`, linha vertical em `x = at` de `from` a `to`
  em y; toda parede ou centro que ficou no mesmo lugar acende, juntas por coordenada) e `{ kind: "gap", axis, segments:
  [{ from, to, cross }] }` (os vãos iguais, medidos no eixo e desenhados em `cross`).
- `snapSelectionMove(doc, ids, { dx, dy }, opções)` faz o arrasto de uma seleção do documento: o quadro é a caixa dos nós
  livres, tudo que não está nele é vizinho (travados e vivos inclusive), e `op` já traz o deslocamento bruto mais o
  ajuste (`opMoveMany`). O arrasto ao vivo usa o resultado; só ao soltar a página faz `record`/`perform` do `op`.
- Custo: linear nos vizinhos (≈ 1 ms com 2000 vizinhos, Bun).

### Duplicar, copiar, colar e excluir (`canvas-clipboard.ts`)

- `copyNodes(doc, ids)` → `{ clip, skipped }`: `clip` é `{ nodes, edges, groups }`, cópias profundas na ordem do
  documento, **só nós do usuário**; `skipped` são os vivos pedidos. Entram as conexões com as duas pontas copiadas (as
  externas e as com nó vivo não vão) e os grupos cujos membros foram **todos** copiados.
- `pasteClip(doc, clip, newId, deslocamento = PASTE_OFFSET)` → `{ op, nodeIds }`: ids novos (`newId(tipo)`, tipo `node`,
  `edge` ou `group`, tem de devolver um id válido e livre), nós deslocados (padrão uma grade, 20), mesma camada `z`,
  conexões e grupos refeitos entre os nós novos; `nodeIds` é a seleção depois de colar. `duplicateNodes(doc, ids, newId,
  deslocamento)` é copiar e colar de uma vez, com `skipped`. `sequentialIds(doc, prefixo = "c")` é o gerador
  determinístico (`c-node-1`, `c-edge-1`...), que pula o que o documento já usa; peça outro a cada colagem, a partir do
  documento atual.
- `deleteNodes(doc, ids)` → `{ op, skipped }`: exclui os nós do usuário com as conexões que os tocavam, e o grupo que ficou
  com menos de dois membros se desfaz no mesmo passo. Nó vivo fica (só sai do documento quando sai do grafo). Nó travado
  **pode** ser excluído: travar impede mover, não apagar.
- `readClip(raw)` valida um clipe que veio de fora (texto colado, armazenamento) com as regras do documento e recusa nó vivo
  ou referência solta (`org_invalid_clip`).
- Limites: colar que passaria de 2000 nós, 5000 conexões ou 500 grupos, ou que levaria uma coordenada para fora de
  ±10⁷, é recusado (`org_limit_exceeded`, `org_invalid_number`).

### Andar pelas conexões (`canvas-walk.ts`)

- `walkOrder({ nodes, edges })` → ids na ordem de passeio: cada componente é percorrido em profundidade, descendo pelo
  sentido `from → to`, então o próximo de um nó é, sempre que ele tem saída, um nó ligado a ele. Começa pelos nós sem
  ligação de entrada; ciclos sem raiz começam pelo primeiro na ordem de posição. Filhos e inícios ordenam por `y`, `x` e
  `id` (comparação de código, não de idioma): o mesmo grafo dá a mesma ordem, qualquer que seja a ordem das listas. Laço,
  ligação repetida e ligação para nó que não existe são ignorados. Iterativo (sem recursão), ≈ 3 ms com 2000 nós.
- `walkStep(ordem, atual, "next" | "previous")` → id ou `undefined` (nó fora da ordem, ou nenhum outro nó); dá a volta nas
  pontas. A página calcula a ordem uma vez por mudança do documento e dá o passo a cada atalho.

Provas: `loop/test/ts/canvas-groups.test.ts`, `canvas-align.test.ts`, `canvas-snap.test.ts`, `canvas-clipboard.test.ts`,
`canvas-walk.test.ts`.

## Compor e criar (`canvas-compose.ts`, `canvas-create.ts`)

Lógica pura, sem Node e sem operação sobre o documento (nada entra na pilha de desfazer). Erros têm código estável em
`error.code`; a mensagem não é contrato.

### Compor mensagem (`canvas-compose.ts`)

- Rascunhos são um mapa `agente → texto`, nunca mudado no lugar. `setDraft(drafts, agente, texto)` devolve o mapa novo (texto
  vazio ou só espaço apaga), `getDraft` (`""` sem rascunho), `clearDraft` (depois de enviar), `draftAgents` (ordem
  alfabética). Nome de agente segue a regra do `hades agent` (`^[a-z0-9][a-z0-9-]{0,30}$`).
- `findReferences(texto)` → `{ start, end, id }[]`: `@id` no começo ou depois de espaço/pontuação (e-mail não conta);
  ponto, dois-pontos ou hífen no fim do id são pontuação; `@@` é um `@` literal. Varredura linear.
- `composeMessage(texto, { nodes })` → `{ text, references }`: nota (`type: "note"`) vira `[nota id: texto]`, outro nó vira
  `[nó id (tipo) "rótulo"]` (rótulo de `data.label|title|name`, quando há). `references` lista cada id uma vez.
  **Referência inexistente é erro** (`compose_unknown_reference`, todos os ids que faltam em `subjects`), nunca some.
- Limites (`COMPOSE_LIMITS`): texto 20 000 caracteres, 200 rascunhos, 50 referências, nota inserida até 2000 (acima é
  `compose_reference_too_long`, sem truncar), mensagem resolvida 60 000. Códigos: `compose_invalid_agent`,
  `compose_invalid_text`, `compose_too_long`, `compose_too_many_drafts`, `compose_too_many_references`,
  `compose_unknown_reference`, `compose_reference_too_long`, `compose_empty_message`.

### Criar unidade (`canvas-create.ts`)

- `designUnit(esboço)` → `{ commands, text }`. Esboço: `{ kind: "project" | "skill", name, role?, base?, ... }`. Projeto:
  `branch` obrigatório, `card` ou `newCard { title, tags, desc? }`, `specs?`; gera `hades agent new <nome> --role … --branch …`.
  Skill: `port?` (1–65535), papel `impl|consolidate`; gera `hades agent skill-new <nome> …`. O segundo comando é sempre
  `hades agent start-cmd <nome>`: quem roda é o dono. **Nada é executado**; todo argumento sai entre aspas simples
  (`shellQuote`).
- Nome: mesma regra do `hades agent` (`UNIT_NAME_PATTERN`). Ref (`branch`, `base`) não começa com `-`, sem `..`, sem
  espaço. Texto livre sem quebra de linha (a descrição aceita). Campo que não cabe no tipo da unidade é erro.
- `readUnitSketch(nó)` lê o esboço do `data` de um nó do usuário de `type: "unit-sketch"` (`UNIT_SKETCH_TYPE`) e valida
  com `designUnit`. Códigos: `create_invalid_name`, `create_invalid_field`, `create_missing_field`, `create_invalid_sketch`.

Provas: `loop/test/ts/canvas-compose.test.ts`, `canvas-create.test.ts`.

### Desenho livre (`canvas-draw.ts`)

- Nós do usuário com `type` `draw-rect`, `draw-ellipse`, `draw-arrow` e `draw-stroke`; o `data` leva `style` (`stroke` e
  `fill` em `#rgb`/`#rrggbb`/`#rrggbbaa`, `width` de 0,5 a 64, padrão 2). Seta (`from`, `to`) e traço (`points`) guardam
  pares `[x, y]` **normalizados (0..1) dentro da caixa do nó**: `opMove` e `opResize` da pilha de desfazer levam o desenho
  junto, sem op nova.
- `createShape(doc, id, "rect" | "ellipse", a, b, estilo?)`, `createArrow(doc, id, from, to, estilo?)` e
  `createStroke(doc, id, pontos, estilo?, tolerância?)` → `{ node, op }`; `op` é um `create` (inverso exato, `z` acima de
  todos). Caixa mínima 1×1. Erros (`DrawError`, `draw_*`): ponto não finito ou fora de ±10⁷, cor ou espessura inválida, id
  inválido ou em uso, documento com 2000 nós, traço vazio.
- `simplifyStroke(pontos, tolerância = 1,5)`: recusa mais de 20 000 pontos de entrada antes de calcular, tira repetidos
  consecutivos, simplifica (Ramer–Douglas–Peucker iterativo, mantém as pontas) e, passando de 500, reamostra por igual.
  ≈ dezenas de ms no teto de entrada.
- `drawBounds(nó)` e `drawingsBounds(nós)` (caixa de todos os desenhos, `undefined` sem nenhum); `drawPoints(nó)` devolve os
  pontos da seta ou do traço em coordenadas do canvas (dado corrompido no `data` → `[]`).
- `hitDrawing(nó, ponto, tolerância = 4)`: forma sem preenchimento acerta só a borda, com `fill` acerta o interior; seta e
  traço acertam perto da linha. `drawingAt(doc, ponto, tolerância)` devolve o desenho do topo (maior `z`).
- Prova: `loop/test/ts/canvas-draw.test.ts`.

### Estilo e arestas manuais (`canvas-edges.ts`)

- `edgeStyle(kind)` → `{ tone, dash, width, arrow, label, known }` para `stack`, `consolidation`, `depends_on`, `agent_pr`,
  `agent_gate`, `orchestrates` e `manual`; o tom é semântico (`accent`, `info`, `warn`, `ok`, `muted`), o painel escolhe a cor do tema. Kind
  desconhecido recebe o estilo neutro com `known: false`. `edgeLegend()` lista os conhecidos em ordem fixa.
- Aresta manual é `{ kind: "manual" }` no documento. `opCreateManualEdge(doc, id, from, to)` recusa nó inexistente
  (`edges_dangling_node`), laço, par manual repetido, id inválido ou em uso e o teto de 5000; `opRemoveManualEdge(doc, id)`
  recusa aresta de outro kind (`edges_not_manual`: a do grafo voltaria na próxima mescla).
- As duas devolvem `AtomicOp` da pilha de desfazer (`edge-create` / `edge-delete`, com o índice de origem), aplicada por
  `applyOp` e desfeita por `invert` (ver "Operações do desfazer"). Excluir nó leva a aresta manual junto, como qualquer outra.
- Prova: `loop/test/ts/canvas-edges.test.ts`.

### Minimapa e toque (`canvas-minimap.ts`, `canvas-touch.ts`, `canvas-minimap.tsx`)

Módulos puros, sem Node e sem DOM. Não mexem no documento (não há operação nem desfazer aqui); só leem a câmera por
import de `canvas-camera.ts`. Na página: `minimap` e `touch` estão em `CANVAS_UI_MODULES` (`src/panel/ui-transpile.ts`),
`argos/canvas-minimap.js` é carregado no `index.html` e `ArgosCanvasMinimap.CanvasMinimap` é montado pelas camadas
(§Camadas sobre o canvas na página). **O reconhecedor de toque não é usado pela página**: o motor já faz pan e pinça, e
ligar os dois dobraria o gesto (o toque longo abrindo o menu ficou de fora por isso).

- `minimapView(rects, cam, view, size)` → `{ projection, nodes, viewport }`. `rects` são os nós no mundo, `view` a tela do
  canvas e `size` o quadro do minimapa, ambos em pixels. `nodes` tem um retângulo por entrada, na mesma ordem, em pixels
  do minimapa, com lado mínimo `MINIMAP_LIMITS.minNodePx` (nó minúsculo não some). `viewport` é o que a tela mostra, no
  mesmo espaço. O mundo do quadro é conteúdo ∪ viewport com folga de 10 %, centralizado: tudo cabe no quadro, e sem nós
  o quadro mostra só o viewport.
- `projectMinimap(...)` é só a `projection` (`scale`, `world`, `offset`, `size`); `worldToMinimap` e `minimapToWorld` são
  inversas uma da outra.
- `minimapCamera(projection, ponto, cam, view)` → câmera que centraliza o viewport no ponto clicado (pixels do minimapa),
  com o mesmo zoom. Ponto fora do quadro é levado à borda. Serve ao clique e ao arrasto (chame a cada `pointermove`).
- Limites: mais de `MINIMAP_LIMITS.maxNodes` (2000) nós, tamanho ou viewport não positivos, câmera inválida, nó com
  número não finito ou lado negativo e ponto não finito levantam `RangeError` (o componente captura e não desenha o quadro).
- `createTouchRecognizer(now)` → `{ down, move, up, tick, cancel }`; `now` é o relógio injetado (ms monotônicos). Cada
  método devolve a lista de eventos:
  - `tap` `{ at }`: dedo sobe em até `TOUCH_LIMITS.tapMaxMs` (300) sem passar da folga (`slopPx`, 8 px).
  - `longpress` `{ at }`: dedo parado `longPressMs` (500); sai no `tick()` (o componente chama por timer, e cancela o
    timer ao desmontar), uma vez por gesto; depois dele soltar não vira tap nem arrasto.
  - `pan` `{ dx, dy }`: um dedo que passou da folga; incremental (some os eventos para o total) e compatível com `panBy`.
  - `pinch` `{ startA, startB, a, b }`: dois dedos; é exatamente o que `pinchCamera` consome (`{ cam, a, b }` do início
    mais os pontos atuais; o componente guarda a câmera do primeiro `pinch`).
  - `end`: todos os dedos saíram depois de arrasto, pinça ou toque longo. Tirar um dos dois dedos da pinça não vira
    arrasto do que sobrou (evita salto); o gesto novo só começa quando todos saem.
  - Terceiro dedo e ids desconhecidos são ignorados; ponto não finito levanta `RangeError`; `cancel()` zera sem emitir.

Provas: `loop/test/ts/canvas-minimap.test.ts`, `canvas-touch.test.ts`.

## Organização avançada: bandas, desfocar, elevar e acoplar

Três módulos puros (`canvas-bands.ts`, `canvas-blur.ts`, `canvas-dock.ts`, os três no pacote da UI). Bandas e desfocar estão
ligados à página (tipo `band` e comandos `blur:*`); elevar e acoplar não, porque a página não passa a porta `dock` (os
comandos `dock:*` não registram). Erros são `OrgError` com os códigos de `ORG_ERRORS` (`canvas-groups.ts`),
que só ganha valores. Nenhum muda o documento: as operações devolvem `CanvasOp` da pilha de desfazer (`undefined` quando
não há o que mudar) e desfazer volta exatamente ao anterior.

### Trocar nó pela pilha (`replaceNodes`, em `canvas-blur.ts`)

- Para trocar só um campo ou uma conexão, prefira `patch`, `update`, `edge-delete` e `unlink` (ver "Operações do
  desfazer"). `replaceNodes(doc, ids, { change, keepEdge,
  addEdges })` devolve um lote `delete` + `create` dos mesmos nós, no mesmo índice, com as conexões e os grupos que eles
  tinham restaurados. `change` devolve o nó novo (mesmo id), `keepEdge` filtra as conexões que tocam os nós, `addEdges`
  acrescenta conexões novas (devem tocar um dos nós). Teto de 2000 ids (`org_limit_exceeded`); `org_unknown_node`.

### Desfocar (`canvas-blur.ts`)

- `blurNodes(doc, ids, blurred = true)`: muda só `blurred` dos nós que ainda não estão no estado pedido (travado e vivo
  também; é visual), pela operação `patch` (um nó) ou um `batch` de `patch` (vários); o desfazer troca só o campo. Todos já no
  estado, ou lista vazia → `undefined`. `toggleBlur(doc, ids)`: se todos estão desfocados,
  revela; senão desfoca todos.
- `blurView(node)` → `{ blurred, showHeader: true, showName: true, showBody, title }`: cabeçalho e nome ficam sempre, o
  corpo some. `nodeTitle(node)`: primeiro texto de `data.title|name|label`, ou o id. `visibleNodeIds(doc, ids?)` e
  `blurredNodeIds(doc)` listam, na ordem do documento, o que continua visível e o que está desfocado.

### Bandas (`canvas-bands.ts`)

- Banda é o grupo com 2+ membros, todos nós `agent`: `isBand`, `bandsOf(doc)`. Grupo misto não é banda
  (`org_invalid_mode` nas funções que recebem o id; `org_unknown_group` se não existe).
- `bandStatus(doc, groupId, live)` → `{ groupId, label, members: [{ id, state, waitingOwner, rank }], counts }`. `live` é o
  que a página já sabe do grafo (`Map` ou objeto de id → `{ state, waitingOwner }`); o documento não guarda estado de
  agente. `rank`: `waiting` (espera o dono), `working` (`working|running|busy`) ou `other`; a lista sai nessa ordem, e na
  ordem do grupo dentro de cada faixa. Agente sem informação é `unknown`/`other`. `waitingAcrossBands(doc, live)`: quem
  espera o dono em qualquer banda, sem repetir.
- `stepBand(status, current, "next" | "previous")`: troca de agente com um clique, dando a volta; `current` ausente ou
  fora da banda começa pelas pontas.
- `linkBand(doc, groupId, noteId)`: uma conexão `band` (`BAND_LINK_KIND`) de cada agente para a nota, id
  `band:<grupo>:<agente>:<nota>`; só o que falta é criado, e banda toda ligada → `undefined`. A nota é qualquer nó que não
  seja agente. `unlinkBand` remove só essas conexões; `bandNotes(doc, groupId)` lista as notas ligadas. Erros:
  `org_unknown_node`, `org_invalid_mode`, `org_invalid_id` (id de conexão acima de 200), `org_duplicate_id`,
  `org_limit_exceeded` (5000 conexões).

### Elevar e acoplar (`canvas-dock.ts`)

- Estado de tela, **não do documento**: fora da pilha de desfazer. `DockState = { elevated: string | null, columns:
  [{ id, edge: "left" | "right", width }] }`, imutável. `emptyDock`, `elevate`, `release`, `toggleElevated` (duplo clique no
  cabeçalho), `dockNode(state, doc, id, edge, width?)`, `undock`, `resizeColumn`, `reconcileDock(state, doc)` (descarta o
  que o documento perdeu). Um nó está elevado **ou** acoplado, nunca os dois (o último gesto vence).
- Limites (`DOCK_LIMITS`): 3 colunas por borda (`org_limit_exceeded`), largura 160 a 640 (`org_invalid_number`, nunca
  truncada), borda só `left`/`right` (`org_invalid_mode`).
- `dockEdgeAt(ponto, tela, faixa = 48)`: borda em que soltar acopla (coordenadas da tela); fora da tela ou fora da faixa →
  `undefined`.
- `layoutDock(state, tela)` → `{ columns: [{ id, edge, frame }], canvas, elevated }`: colunas empilham da borda para o
  centro, ocupam no máximo 60% da largura (a última é recortada, ou omitida se sobrar menos que a largura mínima; a
  largura guardada não muda); `canvas` é o que sobra para a câmera; `elevated` é 80% da área do canvas, centralizado.
- `parseDock(raw, doc)`: valida estado guardado (`org_invalid_mode` para formato errado, e os erros acima para nó,
  largura ou borda inválidos). Nó em `elevated` e em `columns` ao mesmo tempo fica só elevado.

Provas: `loop/test/ts/canvas-bands.test.ts`, `canvas-blur.test.ts`, `canvas-dock.test.ts`.

### Terminal, conversa e arquivos do agente no nó (`node-terminal.tsx`, `canvas-conversation.ts`, `canvas-agent-files.ts`)

Três peças que a página monta pelos tipos vivos `terminal`, `conversation` e `agent-file` (§Tipos de nó vivos).

**`kit/panel/ui/argos/node-terminal.tsx`** (`window.ArgosNodeTerminal = { NodeTerminal, usePaneOutput, KEYS }`). Componente
sobre as rotas do herdr que o painel já tem, sem rota nova: `GET /api/herdr/read` (saída, 200 linhas, e o processo em
primeiro plano) e `POST /api/herdr/act` (`prompt`, `text`, `keys`).

- Props: `session` e `pane` (o painel no herdr), `hasAgent` (liga "Enviar prompt"), `conversation` (retorno de
  `conversationFromEvents`/`conversationFromJsonl`), `files` (lista `AgentFileEntry`), `onOpenFile({ path, role })`,
  `live` (leitura periódica; padrão `true`), `pollMs` (padrão 3000) e `initialTab` (`terminal`, `conversation`, `files`).
- Abas com `role="tablist"` e setas esquerda/direita; o terminal rola sozinho até o fim e para de acompanhar quando o
  dono sobe (botão "Ir para o fim"); texto com Ctrl+Enter; as teclas são as que o servidor aceita, e Esc e Ctrl+C pedem
  confirmação antes de ir.
- Ciclo de vida: o timer, o ouvinte de `visibilitychange` e o recarregamento depois de enviar nascem e morrem com o
  componente; só há uma leitura em voo por vez, a leitura pausa com a aba do navegador escondida, e resposta atrasada de
  um painel anterior é descartada. O erro de leitura aparece na tela (sem atualizar), não some.

**`src/lib/canvas-conversation.ts`**. Conversa a partir do diário (`reference/journal.md`).

- `conversationFromEvents(eventos, opções?)` e `conversationFromJsonl(texto, opções?)` → `{ entries, omitted, invalid,
  unscanned }`. `entries` é cronológica (empate de instante mantém a ordem de entrada), cada uma `{ ts (UTC, Z), role
  ("user" | "agent" | "system"), kind, label, text, truncated }`: `prompt` é o dono, `tool_post` e `stop` são o agente,
  `permission`, `tool_blocked`, `notification`, `decision` (pergunta → escolhido) e os demais eventos são do sistema.
  `tool_pre` só entra com `toolStarts: true`.
- Opções: `maxEntries` (padrão 200, máximo 1000: ficam as mais recentes; as que sobram vão em `omitted`), `maxChars`
  (padrão 400, máximo 4000: o texto vira uma linha e termina em `…`, sem partir um par substituto), `toolStarts`.
- Limites de leitura: só os 20 000 eventos (ou linhas) mais recentes são olhados (o resto vai em `unscanned`); linha de
  JSONL com mais de 16 384 caracteres ou quebrada, e evento sem `ts` válido, `kind` ou `summary`, são pulados e contados em
  `invalid`. Nunca altera a entrada.
- Erros (`ConversationError.code`): `conversation_invalid_input` (não é lista / não é texto) e
  `conversation_invalid_option` (opção fora do intervalo).

**`src/lib/canvas-agent-files.ts`**. Nós de usuário e ligações para os arquivos do agente; operações compatíveis com a pilha
de desfazer (`CanvasOp`; `undefined` quando não há o que mudar).

- Entrada esperada do campo `files` do nó do agente no grafo (declarada aqui, sem importar de `argos-graph.ts`; a
  consolidação liga os dois): `AgentFileEntry = { path, role }`, `role` em `AGENT_FILE_ROLES` (`brief`, `report`,
  `questions`, `handoff`) e `path` relativo à worktree do agente. `normalizeAgentFilePath` recusa vazio, absoluto, `..`,
  barra invertida, unidade, caracteres de controle e mais de 500 caracteres; o nó guarda só o caminho, e quem o abre confere
  de novo contra a worktree no servidor. `checkAgentFiles(lista)` valida na fronteira (até 20 arquivos por agente) e separa
  repetidos (o primeiro vale).
- `addAgentFiles(doc, { agentId, files }, newId)` → `{ op, nodeIds, edgeIds, existing, duplicates }`: um nó
  `type: "agent-file"` por arquivo, `data: { path, role, agent, label }` (240×60, na camada `z` do agente), empilhados à
  direita do agente na ordem dos papéis, e uma ligação `kind: "agent-file"` do agente a cada um. Idempotente: caminho que
  já tem nó fica como está (vai em `existing`), inclusive sem a ligação que o dono apagou. Um passo só no desfazer. `newId`
  é o mesmo `IdSource` do clipboard (`sequentialIds`).
- `agentFileNodes(doc, agentId)` lista os nós de arquivo do agente; `removeAgentFiles(doc, agentId)` → `{ op, nodeIds }`
  exclui esses nós com as ligações (e desfaz o grupo que ficar com menos de dois membros), sem tocar o agente.
- Erros (`AgentFilesError.code`): `agent_files_unknown_agent`, `agent_files_not_agent`, `agent_files_invalid_file`,
  `agent_files_invalid_id`, `agent_files_duplicate_id`, `agent_files_limit_exceeded` (arquivos do agente, nós ou ligações do
  documento) e `agent_files_invalid_number` (coordenada fora de ±10⁷). Nada é gravado em erro.

Provas: `loop/test/ts/canvas-conversation.test.ts`, `canvas-agent-files.test.ts`.

## Conteúdo de agente e de plano (rotas e parser)

Só leitura. A página as lê pelos tipos vivos `tree` e `plan` (§Tipos de nó vivos). As três rotas passam pelo mesmo
regime das vizinhas `/api/argos/*`: host conferido, chave do túnel para quem vem de fora (sem ela, 401), e nunca
devolvem conteúdo de arquivo da worktree, só nomes, tipos e tamanhos. Respostas de erro levam `{ error, code }` com
mensagem fixa por código (sem caminho, sem texto do sistema); o código é estável e só ganha valores.

### Árvore da worktree de um agente (`src/panel/canvas-content.ts`)

`GET /api/canvas-content/tree?agent=<nome>[&registry=<slug>][&path=<relativo>][&depth=<1..4>]`

- `agent`: nome de um agente do **registro** do orquestrador (o do projeto e o `_skill`); `registry` restringe a um deles.
  A worktree é a do registro, nunca um caminho vindo do cliente.
- `path`: pasta relativa à raiz da worktree (padrão: a raiz). Recusado (400 `invalid_path`) se tem `..`, barra invertida,
  NUL, começa com `/`, passa de 1024 caracteres ou de 32 segmentos. Cada segmento é descido sem passar por symlink e o
  resultado é conferido dentro da worktree; fora disso, inexistente, `.git` ou abaixo dele: 404 `path_not_found` (fora do
  escopo responde como inexistente). Arquivo no lugar de pasta: 400 `not_a_directory`.
- `depth`: níveis abaixo de `path` (padrão 1, máximo 4).
- 200: `{ agent, registry, path, depth, entries, truncated, changes }`.
  - `entries`: `{ path, name, type: "dir" | "file" | "symlink" | "other", size, change, changedBelow }`, caminho relativo à raiz
    com `/`, pastas antes de arquivos e depois por nome (comparação de código). `symlink` nunca é seguido. `.git` não
    aparece. Teto de 2000 entradas por pedido: passando disso a lista corta e `truncated` vem `true`.
  - `changes`: `{ base, available, files, truncated }` (+ `reason` quando `available` é `false`). `files` é
    `{ path, status }` de `git diff --name-status base...HEAD` (só o commitado na branch; `A`, `M`, `D`, `T`; sem
    detecção de renome), no máximo 2000. Com `available: true`, cada entrada leva `change` (a letra ou `null`) e cada pasta
    leva `changedBelow` (quantos mudados há abaixo). O arquivo apagado só consta em `changes.files` (não está em disco).
    `available: false` não derruba a árvore, só tira as marcas: `reason` é `no_base` (o registro não tem base, ou ela não
    é uma referência simples), `git_failed` ou `git_timeout` (8 s).
- Erros: 400 `invalid_agent` (nome fora do formato), 404 `unknown_agent`, 404 `worktree_missing` (sem `worktree` no
  registro, ou a pasta não existe mais), 400 `invalid_path`, 404 `path_not_found`, 400 `not_a_directory`, 400
  `invalid_depth`.

### Planos (`src/panel/canvas-content.ts`)

- `GET /api/canvas-content/plans` → `{ plans: [{ name, modifiedAt }] }`: os `.md` de `~/.claude/hades/plans/` (sem os
  `.log.md`), nome `[A-Za-z0-9][A-Za-z0-9._-]{0,99}` sem a extensão, do mais novo ao mais antigo, até 100.
- `GET /api/canvas-content/plan/<nome>` → `{ name, title, state, sections, units, skippedRows, truncated }`. O nome só vale
  se está na lista acima, e o arquivo real (depois de symlink) tem de ficar dentro da pasta de planos. Erros: 400
  `invalid_plan` (nome fora do formato ou escape malformado), 404 `unknown_plan`, 413 `plan_too_large` (acima de 512 KB,
  conferido antes de ler).
- `units` já vem ligado aos agentes: cada unidade leva `agent: { name, registry, state } | null`.

### Parser do plano (`src/lib/canvas-plan.ts`, puro)

- `parsePlan(texto)` → `{ title, state, sections, units, skippedRows, truncated }`. `title` é o primeiro `# `;
  `sections` são as `## ` fora de bloco de código, `{ title, body, clipped }` (corpo até o próximo `##`, cortado em 8000
  caracteres); `state` é a seção "Estado atual" (a mesma de `sections`, com teto de 20 000). `units` vem da tabela de
  `## Unidades` (colunas achadas pelo cabeçalho: `Unidade`, `Papel` (padrão `impl`), `Base`, `Depende de`; as demais
  ficam em `cells`, pelo cabeçalho em minúsculas, 400 caracteres por célula). Linha com mais células que o cabeçalho
  devolve o excesso à última coluna (código com `|`). Nome de unidade fora de `[\w.-]{1,80}` não vira unidade: conta em
  `skippedRows`. Tetos: 200 seções e 200 unidades (`truncated.sections`/`truncated.units`), texto de até 512 KB.
  Recusas: `PlanError` com `code` `plan_too_large` ou `plan_invalid_text`. Sem estado, sem disco, sem relógio.
- `linkUnitsToAgents(units, agents)` → as unidades com `agent` (o agente de mesmo nome; se dois registros têm o nome,
  vence o primeiro da lista, que vem com o do projeto antes do `_skill`) ou `null`. Não muda a entrada.
- Nada disso mexe no documento do canvas: o nó de árvore e o de plano são nós de usuário (`type` próprio, `data`) que a
  página monta sobre estas respostas, então não há operação de desfazer nesta peça.

Provas: `loop/test/ts/canvas-plan.test.ts`, `canvas-content-route.test.ts`.

## Notas e texto livre (modelos puros e rota das notas)

Dois tipos de nó de usuário do documento (`type` próprio e `data` livre; o formato do documento não muda): `note`, uma nota
em Markdown guardada num arquivo `.md` (o nó só aponta para ele), e `text`, um rótulo ou título que vive no próprio
`data`. A página monta os dois tipos (§Tipos de nó do usuário).

### Modelo dos nós (`src/lib/canvas-note.ts`)

Puro, sem Node: roda no painel e no navegador. Erro é `NoteError` com `code` estável (só ganham valores):
`note_invalid_name`, `note_invalid_data`, `note_invalid_agent`, `note_invalid_node`, `note_invalid_token`,
`note_too_large`, `note_duplicate_id`, `note_limit_exceeded`. Limites em `NOTE_LIMITS`.

- **`data` de `note`:** `{ note: string, agent?: string }`. `note` é o nome do arquivo **sem** a extensão: começa por letra
  ou número e segue com letras, números, `-` e `_`, até 64 caracteres (sem ponto nem barra, então sem `..` nem separador;
  `isNoteName`, `requireNoteName`). `agent` é o id de um nó de agente (`agent:<registro>:<nome>`, até 200 caracteres,
  `requireAgentId`): a ligação vive aqui, no documento. `readNoteData(raw)` valida (campo desconhecido é recusado) e devolve
  cópia.
- **`data` de `text`:** `{ text: string, style: "title" | "label" }`; texto de 1 a 2000 caracteres e não só espaço
  (`readTextData`; 2001 é `note_too_large`). A página só cria o nó quando há texto e o apaga se o texto for esvaziado.
- **Conferir:** `checkAnnotationNode(node)` e `checkAnnotations(doc)` validam o `data` dos nós `note` e `text` (outros tipos
  passam). O servidor do documento não os chama: quem monta a página (ou a importação) decide onde conferir.
- **Texto livre:** `textTitle(data, maxChars = 80)` é a primeira linha com conteúdo, aparada e cortada com `…` (por
  caractere, não por código); `""` sem texto. `textFrame(data)` → `{ w, h }` é a estimativa da área do nó (largura pelo trecho
  mais comprido entre o mínimo e o máximo do estilo, altura pelas linhas já quebradas): serve para o nó nascer do tamanho
  certo, quem desenha mede de verdade.
- **Quem escreve:** `canWriteNote(doc, nodeId, writer)` com `writer` `OWNER` (`{ kind: "owner" }`, sempre pode) ou
  `{ kind: "agent", id }` (só se `data.agent` do nó `note` com esse id é o mesmo; nó que não existe, que não é nota ou de
  `data` inválido nega). Também: `findNoteNode(doc, nodeId)`, `noteFileOf(doc, nodeId)` (nome do arquivo ou `undefined`) e
  `notesOfAgent(doc, agentId)` (ids dos nós, ordem do documento).
- **Criar (operações da pilha de desfazer):** `createNoteNode(doc, { id, x, y, note, agent?, w?, h?, z? })` e
  `createTextNode(doc, { id, x, y, text, style = "label", z? })` → `{ op, node }`, em que `op` é um `create` de
  `canvas-history` (`applyOp`, `perform`, `invert`, desfazer e refazer funcionam; desfazer tira o nó e **não** apaga o
  arquivo `.md`). O nó é conferido com as regras do documento (id, caixa, `data`), o id não pode repetir e o documento não pode
  estar nos 2000 nós. Tamanho padrão da nota: 280 × 200. `freshNoteName(doc, token)` devolve `nota-<token>` livre no
  documento; `token()` (minúsculas e números, 6 a 32) vem de fora para o teste ser determinístico; peça um nome novo por nota,
  porque a pasta é compartilhada por todos os canvases.
- **Editar o `data`** de um nó existente (trocar o texto, ligar ou desligar o agente) é a operação `update` da pilha de
  desfazer (`opEditText`, `opSetNoteAgent`; §Operações do desfazer).

### Rota das notas (`src/panel/canvas-notes.ts`)

`createCanvasNotesRoutes(dir, { loadDoc })` → `{ get(path), write(path, req, caller) }`, ambos `undefined` se o caminho não é de
`/api/canvas-notes/`. `loadDoc(canvasId)` devolve o documento do canvas (ou `undefined`); o `server.ts` o lê pela própria
rota do canvas. As notas ficam em `$D/canvas-notes/<nome>.md` (fora do repositório; pasta criada na primeira gravação, arquivo
com modo 0600). Mesmo regime de acesso das rotas vizinhas: com a chave pelo túnel, e o `PUT` exige também o token da sessão
(`x-panel-token`), `Content-Type: application/json` e origem conferida.

- **`GET /api/canvas-notes/<nome>`** → `200 { name, text, rev, updatedAt }` (`updatedAt` ISO 8601 UTC).
- **`PUT /api/canvas-notes/<nome>`**, corpo `{ text: string, rev: string | null, as?: { agent, canvas, node } }` →
  `200 { ok: true, name, rev, bytes }`. `rev` é a revisão que o cliente leu; `null` cria (nota que ainda não existe).
  Revisão velha, `null` sobre nota que existe ou `rev` sobre nota que não existe: `409` com `{ code, rev }` (a atual, ou
  `null`), e nada é gravado. A revisão é o hash do conteúdo (16 caracteres hexadecimais): mudança do arquivo por fora também a
  muda.
- **Quem escreve:** sem `as`, é o dono (local ou pelo túnel). Com `as`, é o agente: vale só se o nó `node` do canvas `canvas`
  é uma nota com esse arquivo e liga esse `agent`; qualquer outro caso (canvas, nó ou ligação que não bate) responde `404
  note_not_found`, como se a nota não existisse. Pelo túnel o agente é recusado (`403 note_agent_local_only`): não há
  credencial por agente, então a identidade declarada só vale na máquina do painel.
- **Limites:** texto até 262 144 bytes UTF-8 (inclusivo; conta bytes, não caracteres); corpo da requisição até 524 288 bytes
  (teto próprio, maior que o dos demais POST); nota vazia é válida. Arquivo acima do teto, que não é UTF-8 ou que é link
  simbólico nunca é lido como vazio.
- **Códigos de erro** (`{ error, code }`, mensagem genérica, nunca caminho nem detalhe interno): `400 note_invalid_name`
  (nome fora da lista fechada, na leitura e na escrita), `400 note_invalid_body` (corpo que não é objeto JSON com `text` texto
  e `rev` texto ou `null`, ou `as` malformado), `403 note_agent_local_only`, `404 note_not_found`, `404 not found` (método
  diferente de `PUT`), `409 note_stale_revision`, `413 note_too_large`, `500 note_unreadable`.
- **Gravação atômica:** arquivo temporário na mesma pasta e `rename`; leitura, conferência da revisão e gravação sem `await`
  no meio. Não há rota para listar nem apagar notas.

Provas: `loop/test/ts/canvas-note.test.ts`, `loop/test/ts/canvas-notes-route.test.ts`.

## Canvas por worktree ou rodada e filtros salvos

Dois módulos novos para a rodada que ligar na página; nenhum está montado em `#/argos`. O documento (`canvas-doc.ts`), os
filtros (`canvas-filters.ts`) e o servidor (`server.ts`) não mudaram: as rotas novas moram em `/api/canvases/_scope` e
`/api/canvases/_filters`, que o despacho de `/api/canvases/*` já entrega a `canvas.ts`. `_` não abre um id de canvas válido,
então os dois caminhos nunca colidem com um canvas.

### Canvas por escopo (`canvas-store.ts` e `src/panel/canvas.ts`)

Um **escopo** é `{ kind: "worktree" | "round", key }`: a worktree que a Hades criou ou a rodada de orquestração. A chave é
um texto opaco (1 a 128 caracteres, sem controle, aparada); o servidor não confere se a worktree existe. O canvas do escopo é um
canvas por id como os de §Vários canvases e exportação (mesmo arquivo `$D/canvases/<id>.json`, mesmo teto de 100 e mesmas
rotas de gravar, renomear, exportar e apagar), com um campo a mais no arquivo, `scope`, e o mesmo campo na lista.

- `scopedCanvasId(escopo)` → `wt-<trecho legível>-<hash de 14 hex>` (worktree) ou `rd-…` (rodada). Puro e determinístico: a
  página calcula o id sem perguntar ao servidor e usa as rotas de sempre. O trecho legível (até 40 caracteres) é só para
  humanos; o hash cobre tipo e chave inteiros, então `p4` e `P4`, ou `p/4` e `p.4`, dão ids diferentes. O id sempre passa por
  `isValidCanvasId` e a chave nunca forma caminho.
- `requireCanvasScope(bruto)` → `CanvasScope` aparado; lança `canvas_invalid_scope`. `scopedCanvasName(escopo)` → nome padrão
  (`Worktree: p-org`, `Rodada: p4`). `sameScope(a, b)`. `slugify(texto, máximo)` foi extraída de `freshCanvasId`, que se comporta
  como antes.
- **Compatibilidade:** o canvas padrão (`canvas.json`) e os canvases por id continuam iguais; arquivo sem `scope` é um canvas
  comum. `scope` sobrevive a gravar, renomear e importar com `overwrite`. O arquivo cujo `scope` não bate com o id do nome do
  arquivo (copiado à mão) é ilegível (`500 canvas_unreadable`), nunca o canvas de outra worktree.

| Rota | Corpo | Respostas |
|---|---|---|
| `POST /api/canvases/_scope` | `{kind, key, name?}` (até 4 KiB) | **abre ou cria**, idempotente: `201 {id, name, rev: 0, scope, created: true}` na primeira vez; `200 {id, name, rev, scope, created: false}` depois (sem tocar no arquivo). `name` só vale na criação (padrão `scopedCanvasName`) |

Erros (`{error, code}`, mensagem genérica): `400 canvas_invalid_scope` (tipo fora da lista, chave vazia, longa ou com controle),
`400 canvas_invalid_name`, `400 canvas_invalid_shape` (corpo que não é objeto JSON, ou acima de 4 KiB), `409 canvas_exists` (já
existe arquivo nesse id que não é deste escopo, por exemplo importado à mão com `id` igual), `409 canvas_limit_reached` (já há
100 canvases; abrir um que existe continua valendo), `500 canvas_unreadable`. Apagar o canvas do escopo é o `POST …/delete` de
sempre; abrir de novo cria um vazio. Acesso e log: os de `PUT /api/canvas` (`canvas de escopo criado`, com `canvas`, `kind`
e `remote`, nunca a chave nem o conteúdo).

### Filtros salvos (`canvas-saved-filters.ts` e `src/panel/canvas.ts`)

Lista de seleções da barra de filtros (`FilterSelection` de `canvas-filters.ts`) com nome, e no máximo uma como **padrão da
instância**. É estado da instância (vale para todos os canvases), gravado em `$D/canvas-filters.json` de forma atômica, e não do
documento: não entra na pilha de desfazer, e cada operação é uma função pura sobre o conjunto, que devolve o conjunto novo.
Estado do dono: `canvas-filters.json` é dado do usuário, como `canvas.json` (nenhuma atualização o recria ou apaga).

Forma: `{ v: 1, rev, defaultId: string | null, filters: [{ id, name, selection }] }`. Limites: 50 filtros; nome de 1 a 80
caracteres, sem controle, único sem distinguir caixa; até 50 valores por dimensão, de 1 a 100 caracteres cada; id gerado do
nome (`Só agentes` → `so-agentes`, `so-agentes-2`…) e imutável (renomear não o muda).

- `readSavedFilters(bruto)` → `SavedFilterSet`: estrito (campo, dimensão ou valor desconhecido, versão, `rev`, ids e nomes
  repetidos, padrão que não existe: tudo é erro, nada é descartado em silêncio). `readSelection(bruto)`: uma seleção
  válida (dimensões de `FILTER_DIMS`), cópia sem valores repetidos e sem lista vazia. `emptySavedFilters()`.
- `addSavedFilter(conjunto, nome, seleção)` → `{set, id}` (no fim da lista; seleção vazia não se salva).
  `updateSavedFilter(conjunto, id, {name?, selection?})` (o que falta não muda; sem mudança devolve o mesmo conjunto).
  `removeSavedFilter(conjunto, id)` (se era o padrão, a instância fica sem padrão). `setDefaultSavedFilter(conjunto, id | null)`.
  `defaultSelection(conjunto)` → cópia da seleção padrão ou `undefined`: a página a aplica ao abrir quando a URL não traz filtro.
  Nenhuma altera o `rev`; quem grava o incrementa.
- Códigos (só ganham valores): `saved_filters_invalid_shape`, `_unsupported_version`, `_invalid_name`, `_invalid_selection`,
  `_duplicate_name`, `_duplicate_id`, `_not_found`, `_limit_reached`.

| Rota | Corpo | Respostas |
|---|---|---|
| `GET /api/canvases/_filters` | | `200` o conjunto gravado; sem arquivo, o vazio `{v:1, rev:0, defaultId:null, filters:[]}` (nada é gravado) |
| `PUT /api/canvases/_filters` | o conjunto inteiro (até 64 KiB) | grava com `rev + 1`: `200 {v, ok: true, rev}` |

Mesma regra de revisão do documento: o `PUT` só grava se o `rev` do corpo for igual ao do arquivo, senão `409
saved_filters_stale_revision` com `rev` (o atual), sem gravar; leitura, conferência e gravação sem `await` no meio. Erros: `400`
com o código do módulo (mais `reason`, a frase do problema na entrada do dono), `400 canvas_invalid_json`, `400 canvas_too_large`,
`500 saved_filters_unreadable` (arquivo corrompido: `GET` e `PUT` recusam e **não** o apagam). Acesso e log: os de `PUT /api/canvas`
(`filtros salvos gravados`, com `rev`, contagem e `remote`).

Provas: `loop/test/ts/canvas-store.test.ts` (escopo), `canvas-saved-filters.test.ts`, `canvas-route.test.ts` (rotas em
processo e pelo painel real, com chave e token).

## Indicadores no nó

O nó do canvas diz o estado sem abrir o painel. As tabelas vivem em `src/lib/canvas-argos.ts` (modelo puro, sem DOM) e
são as mesmas para o corpo do nó, a lista e a legenda; `kit/panel/ui/argos/parts.tsx` só desenha e
`kit/panel/ui/argos/canvas-legend.tsx` mostra a legenda.

**Cor e forma, nunca só cor.** A cor diz o **estado** (`stateLook`: tom, ícone e palavra por estado; `attention` e
`stalled` vencem o estado). O **tipo** é forma e ícone neutros (`typeLook`): unidade = quadrado, agente = círculo, PR =
losango, fila do gate = hexágono. Dois estados do mesmo tom nunca têm o mesmo ícone, e o nó leva a palavra do estado no
rótulo falado. Os tons são tokens dos dois temas (`TONE_VAR`); texto passa em 4,5:1 e ícone em 3:1 contra `--card` e
`--background` (`loop/test/ts/canvas-legend.test.ts` lê os tokens do `index.html` e calcula). O `vivo` sozinho dá 4,08 no
escuro, por isso o texto dele usa a cor de primeiro plano.

**Chips de indicador** (`nodeIndicators`, só de perto; longe o nó é só cor), na ordem de importância:

| Chip | Aparece quando | Tom |
|---|---|---|
| permissão | `pendingPermission` | warn |
| pergunta | `openQuestions` > 0 (o número) | warn |
| gate | `gate`: rodando, na fila, falhou | vivo, info, bad |
| CI | `ci`: passou, rodando, falhou (falha vence pendente) | muted, warn, bad |
| PR | `pr` (`#n`) | muted |
| custo | `costUsd`; com `estimateUsd`, `$gasto/estimado` | warn a partir de 100% do estimado, bad a partir de 150% |
| herdr | `herdrState` **difere** do estado do nó (senão repetiria a palavra do estado) | o do estado no herdr |

Os limites 100% e 150% são os padrões da Moirai (`HADES_MOIRAI_WARN_PCT`, `HADES_MOIRAI_ASK_PCT`); o navegador não lê a
configuração, então a cópia está em `COST_WARN_PCT` e `COST_BAD_PCT` e muda junto. O percentual não é arredondado antes
de comparar. `fitIndicators` mostra os que cabem na linha (nó de 200 px) e o resto vira `+n`; o rótulo falado do nó leva
todos. Nó sem dado não ganha chip.

**Legenda.** O botão "Legenda", no canto do canvas, abre um painel com tipo (forma), estado (cor e ícone) e indicadores,
vindo de `legendModel()`; fecha com Esc e devolve o foco ao botão. É montada dentro do `CanvasPane`.

**Forma longe do zoom.** O motor desenha o nó longe como retângulo da cor do estado. `shapePoints(shape, x, y, w, h)` e
`typeLook(type).shape` entregam os vértices, e o gancho opcional `nodeShape?(node): Shape` do motor os usa
(`drawDots`/`drawBlocks` preenchem o polígono em vez de `fillRect`; §Controles de câmera e forma do nó no motor).

Dois trechos de "Leitura do grafo" ficam superados por estes campos: o grafo **traz** `costUsd` (filtro de custo) e `card`/`files`
(busca).

Provas: `loop/test/ts/canvas-argos.test.ts`, `argos.test.ts` e `canvas-legend.test.ts`.

## Portal web (modelo puro e rota)

Nó `portal`: uma página web embutida no canvas (um quadro por cima do documento). O documento guarda só `data.url`. Página
que proíbe ser embutida fica como link. Está no pacote `/ui/lib/canvas-model.js` e ligado à página `#/argos` pelo tipo vivo `portal`
(§Tipos de nó vivos). O documento (`canvas-doc`) e a pilha (`canvas-history`) não mudam.

### Regras puras (`src/lib/canvas-portal.ts`)

Sem Node e sem DOM. Erro é `PortalError` com `code` de `PORTAL_ERRORS` (só ganha valores): `portal_invalid_url`,
`portal_url_too_long`, `portal_scheme`, `portal_credentials`, `portal_host_not_allowed`, `portal_invalid_node`.

- `buildPortalPolicy({ hadesHosts?, extraHosts? })` → `PortalPolicy { exact, suffixes, ignored }`: sempre `localhost`,
  `127.0.0.1` e `[::1]` (em qualquer porta), mais os hosts do Hades que não são loopback (o do túnel do painel) e os da chave
  `HADES_CANVAS_PORTAL_HOSTS` (hosts por vírgula; `*.exemplo.com` vale para os subdomínios, não para o domínio nu; coringa
  com menos de dois rótulos de sufixo, como `*.com`, não vale). Entrada de formato inválido ou acima de 100 entradas vai
  para `ignored` (a rota registra só a contagem), nunca vira permissão. A porta nunca restringe: a lista é de host.
- `checkPortalUrl(raw, policy)` → `URL` normalizada. Só `http:`/`https:`, sem usuário nem senha, sem espaço nem caractere de
  controle, até 2048 caracteres, host na lista. A conferência vale pelo host que o navegador entende (`http://2130706433/` é
  `127.0.0.1`; `http://localhost\@outro/` é `localhost`). Não resolve DNS.
- `resolveRedirect(from, location, policy)` → `URL | undefined`: o destino de um `Location` (relativo ou absoluto) só se ele
  passa por `checkPortalUrl`; quem segue redirecionamento só segue o que volta daqui.
- `judgeFraming({ frameOptions, csp }, { pageOrigin, ancestorOrigin })` → `PortalBlock | undefined` (o motivo de não poder
  embutir). `frame-ancestors` da CSP, quando existe, vale e o `X-Frame-Options` é ignorado, como no navegador; toda política
  do cabeçalho precisa permitir; `'none'`, lista vazia, `'self'` (outra origem) e fonte que não casa com o painel bloqueiam.
  `X-Frame-Options`: `DENY` bloqueia, `SAMEORIGIN` só passa na mesma origem, e valor que não se entende (`ALLOW-FROM`)
  bloqueia. `ancestorOrigin` desconhecido só passa com `*`.
- `judgeEnvironment(url, { remote, ancestorOrigin })` → `PortalBlock | undefined`: pelo acesso remoto, loopback vira link
  (`remote_loopback`: `localhost` seria a máquina de quem olha), e `http` dentro de painel `https` é `mixed_content`.
- `PORTAL_BLOCKS` (só ganha valores): `frame_options_deny`, `frame_options_sameorigin`, `frame_options_unknown`,
  `csp_frame_ancestors`, `redirect_outside`, `redirect_limit`, `mixed_content`, `remote_loopback`, `unreachable`, `timeout`.
- `portalNodeData(raw, policy)` → `{ url }` normalizada. `buildPortalNode(doc, { id, x, y, url, w?, h?, z? }, policy)` → nó
  `portal` (padrão 640×420, camada acima das existentes; id repetido ou documento nos 2000 nós é `portal_invalid_node`).
  `opCreatePortal(doc, entrada, policy)` → `AtomicOp` de criação: um passo na pilha, e desfazer deixa o documento igual ao
  anterior. Trocar a URL de um portal existente não tem operação própria (a pilha não tem "alterar `data`"): é apagar e criar.
- `portalViewOf(node, policy)` → `{ state: "ready", url } | { state: "blocked", code }`: o que a UI desenha. O documento pode
  vir de uma importação, então a URL é conferida de novo contra a política **de agora** antes de virar o `src` do quadro.
- Quem desenha o quadro deve usar `sandbox` e `referrerpolicy="no-referrer"` e só embutir se `portalViewOf` deu `ready` **e**
  a rota abaixo respondeu `embeddable: true`; o navegador é quem barra o quadro de fato, a rota só evita um quadro em branco.

### Rota (`src/panel/canvas-portal.ts`)

`POST /api/canvas/portal/check`, corpo JSON `{ "url": "<http(s)://…>" }`. Mesmo regime das demais rotas de escrita do painel:
pelo túnel exige o cookie da sessão (401 sem ele), `Origin` fora da lista e `Host` do túnel errado dão 403, e `X-Panel-Token`
mais `Content-Type: application/json` são obrigatórios (403). Corpo acima de 64 KiB é cortado; objeto que não é JSON, 400.

- **200** `{ ok, url, finalUrl, embeddable, reason, status, checkedAt }`: `url` é a normalizada; `finalUrl` a depois dos
  redirecionamentos; `reason` é `null` ou um `PORTAL_BLOCKS`; `status` é o HTTP da última resposta (`null` se nenhuma veio);
  `checkedAt` em UTC (ISO 8601 com `Z`). Página fora do ar, sem resposta no prazo ou que sai da lista **também é 200**, com
  `embeddable: false` e o motivo: o nó vira link, e isso não é erro do pedido.
- **400** `{ error, code }` com `portal_invalid_url` (sem `url`, não texto, vazio, mal formada), `portal_url_too_long`,
  `portal_scheme`, `portal_credentials`. **403** `portal_host_not_allowed` (nenhum pedido sai). **429**
  `portal_rate_limited` com `Retry-After` (em segundos): no máximo 30 conferências por minuto e 4 ao mesmo tempo.
- Só cabeçalhos: `HEAD` (e `GET` se a página recusa o `HEAD` com 405 ou 501), `redirect: manual`, corpo nunca lido (é
  cancelado). Até 3 redirecionamentos, cada um conferido pela lista antes de o pedido sair; fora da lista é
  `redirect_outside`, e passar de 3 é `redirect_limit`. Cada pedido tem teto de 5 s (`timeout`); falha de rede é `unreachable`.
- Pelo acesso remoto, URL de loopback responde `remote_loopback` **sem fazer pedido nenhum**, e `http` dentro do painel
  `https` responde `mixed_content`. `ancestorOrigin` (a origem do painel que o navegador vê) vem do `Host` já validado pelo
  servidor (local) ou do host do túnel (remoto), nunca de `Origin` ou `Referer` do corpo.
- Resposta guardada por 30 s por (URL, origem, local/remoto); fora do ar e timeout não ficam guardados. O log leva só o host
  e o motivo, nunca a URL inteira.
- Lido a cada pedido: `HADES_CANVAS_PORTAL_HOSTS` (`reference/config.md`) e o host do túnel do painel.
- O servidor da página é tratado como não confiável para o que ela devolve (só cabeçalhos entram) mas o DNS dos hosts extras
  é o do sistema: host extra que passa a apontar para um endereço interno responde como o dono configurou. Não coloque na
  lista host que você não controla.

Provas: `loop/test/ts/canvas-portal.test.ts`, `canvas-portal-route.test.ts`.

## Leitura do grafo na página

Os modelos da seção anterior e o layout de forças (§Layout de forças) estão ligados à página `#/argos`. Eles entram no pacote `/ui/lib/canvas-model.js`
(`CANVAS_UI_MODULES`: `force`, `neighbors`, `filters`, `search`, `urlstate`). A regra da página fica em
`kit/panel/ui/argos/logic.tsx` (`window.ArgosLogic`, testável sem DOM). A barra fica em `kit/panel/ui/argos/reading-bar.tsx`
(`window.ArgosReading`: `FilterBar`, `SearchBox`, `ViewsBar`, `LayoutSwitch`, `focusSearch`). O executor das forças fica em
`kit/panel/ui/argos/reading-runner.tsx` (`window.ArgosReadingRunner`, sem DOM nem React). Os dois scripts carregam no
`index.html` depois de `argos/parts.js`. Tudo vale só na vista **canvas**; a vista Lista não muda.

- **Layout: livre ou automático** (o segmentado diz "Automático"; "forças" é o nome técnico da simulação, só nesta seção). O seletor da barra, ou `Shift+L`, troca o layout. A escolha fica no navegador
  (`hades.argos.layout`). Com forças, o executor avança `startArrange`/`step(n)` em fatias de ~8 ms por quadro
  (`requestAnimationFrame`). O tamanho da fatia vem do custo medido do passo (`sliceSteps`, teto de 200 passos). Cada
  quadro mostra as posições com `showDoc`, sem gravar nada. O documento só é gravado no fim, como uma operação de mover
  (`move`/`batch`), e entra no desfazer. As forças não rodam sozinhas ao abrir a página. Elas rodam ao ligar o layout,
  pelo comando **Reorganizar automaticamente**, depois de um arrasto, e quando a sincronia traz um nó novo (os outros ficam
  fixos e só o novo se acomoda).
- **A posição do dono vence.** Um gesto do dono no canvas, a troca de layout, a vista Lista, a sincronia e a saída da
  página param a rodada no ponto em que está. O parcial é gravado. **Parar o layout** faz o mesmo. Desfazer volta para
  antes da rodada. Arrastar um nó com forças ligadas fixa o nó onde ele foi solto. Depois `startReheat` reaquece só a
  vizinhança dele (até 2 saltos). Os vizinhos se mexem ao soltar, não durante o arrasto.
- **Fixar e soltar (pin).** **Fixar o nó** / **Soltar o nó** (`Shift+P`, também no menu de botão direito de qualquer nó)
  vale para as forças. Os pins ficam no navegador (`hades.argos.pins`, até 2000 ids). Nó `locked` do documento já é fixo.
- **Destaque de vizinhança.** Selecionar um nó mostra até 2 saltos (`canvas-neighbors` sobre as ligações visíveis). O nó
  e o 1º salto ficam inteiros, o 2º salto fica com opacidade 0,55 e o resto com 0,15 (`setEmphasis`). Limpar a seleção
  volta tudo. Passar o mouse por cima não destaca.
- **Filtros (chips).** O botão **Filtros** (`aria-expanded`) abre uma linha de chips por dimensão: estado, tipo de nó,
  tipo de ligação, papel, raiz, idade e custo. Cada chip mostra a contagem e tem `aria-pressed`. Chip com contagem 0 só
  aparece se estiver marcado. Os chips substituem os antigos seletores Raiz/Papel. O preset **Estado** (`active` ao
  abrir) continua e se combina com os chips. Nó filtrado sai do desenho, da ordem do Tab e de `j`/`k`. Ligação com uma
  ponta filtrada também sai.
- **Busca.** O campo **Buscar no canvas** (`b` foca o campo) procura no nome, card, PR, branch e arquivos do nó (até 200
  arquivos por nó), com espera de 250 ms entre teclas. O texto tem o teto de `canvas-search`, e acima dele aparece
  `search_term_too_long`. Os resultados acendem e o resto fica a 0,15 (a busca vence o destaque de vizinhança). A câmera
  enquadra a caixa dos resultados (`fitRect`). `Enter` reenquadra, `Esc` limpa, e o número de resultados é anunciado
  (`aria-live`). Dentro do campo, `Esc` e `Enter` são dele (`data-own-keys`).
- **Vista no endereço.** Câmera, chips, busca e nó aberto vão para o hash por `canvas-urlstate`, e recarregar a página
  mantém tudo. Mudança de câmera e de busca usa `replaceState` (não enche o histórico). Mudança de chips e de nó usa
  `pushState`, então Voltar desfaz o filtro. Na abertura, a página lê o hash. Se o hash for inválido, ela abre no
  estado padrão com um aviso (`urlstate_*`). A câmera do hash entra depois do primeiro quadro. Um hash com nó e sem
  câmera leva a câmera até o nó, tanto na abertura quanto ao navegar. O preset **Estado** não
  vai para o hash (o modelo recusa chave desconhecida), então ao recarregar ele volta a `active`.
- **Vistas salvas.** O seletor **Vistas salvas** com **Salvar a vista atual**, Renomear e Excluir grava em
  `hades.argos.views`, com as regras e os códigos `view_*` do modelo. Elas também aparecem na paleta.

Comandos novos, no grupo **Leitura do grafo** do registro (paleta `Ctrl+K`, menu de botão direito e ajuda `?`):

| Atalho | Comando |
|---|---|
| `Shift+L` | Ligar o layout automático · Voltar ao layout livre |
| `Shift+P` | Fixar o nó · Soltar o nó (também no menu do nó) |
| `b` | Buscar no canvas |
| — | Reorganizar automaticamente · Parar o layout · Limpar a busca · Limpar os filtros · Salvar a vista atual |

**Acréscimos à API do motor** (§API do motor para a página): `showDoc(doc)` mostra um documento provisório sem passar
pelas props (os quadros de um layout animado); o próximo `doc` das props vence. `setEmphasis(alpha | null)` define a
opacidade por nó, multiplicada pela do `blurred`.

**Escala** (1000 nós sintéticos, harness `/dev/canvas` com o executor da página, Firefox headless sem GPU, 1600×814):
assentar sem gesto ~2,0 s (233 passos, 1,97–1,99 s em 3 rodadas), 60 fps sem quadro acima de 25 ms
nesse tempo, 60 fps no pan e no zoom com as forças rodando, 60 fps no arrasto de um nó, e reaquecer a vizinhança em
54–71 ms. Roteiro: `.design-sync-reports/evidence/force-bench.ts` da rodada de integração.

Provas: `loop/test/ts/argos-ui.test.ts` (blocos "leitura do grafo") e `canvas-integra-reading.test.ts` (registro real dos
comandos, vizinhança, busca, filtros, e o executor sobre `startArrange`, que dá o mesmo resultado de `forceArrange`).

## Chave `preset` no hash e `files` do agente

O hash do canvas ganha a chave `preset` (`#/argos?preset=<valor>&v=1`), aditiva: `active`, `attention`, `stalled`, `done`
ou `all` (`URLSTATE_PRESETS` em `src/lib/canvas-urlstate.ts`). Sem a chave, `UrlState.preset` fica ausente e o hash
antigo segue valendo; valor desconhecido, vazio ou repetido recusa o hash inteiro (`urlstate_invalid`), como as outras
chaves. **A página ainda não a usa**: não lê `preset` ao abrir nem o grava no hash (o preset de estado volta a `active` ao recarregar).

`addAgentFiles` aceita no `files` o tipo exportado por `src/panel/argos-graph.ts` (`AgentNodeFiles`, só caminhos): o papel
sai do nome do arquivo (`brief.md`, `report.md`, `questions.md`, `handoff.md`); as entradas `{ path, role }` seguem valendo.
A reinstalação nunca toca em `$D/canvases/`, ao lado de `$D/canvas.json`.

## Operações do desfazer (`canvas-history.ts`)

A pilha de desfazer é o único formato de operação do documento: toda mudança sai como `AtomicOp` (ou `batch` deles), com
o inverso exato, e `applyOp`/`invert`/`undo`/`redo` servem a todas. Erros são `HistoryError` com os códigos de
`HISTORY_ERRORS` (só ganham valores). Aplicar lança sem alterar nada; o lote é tudo ou nada.

| `kind` | Muda | Inverso | Construtor |
|---|---|---|---|
| `move`, `resize` | posição, ou posição e tamanho | o mesmo com `from`/`to` trocados | `opMove`, `opResize`, `opMoveMany` |
| `create`, `delete` | nós (com as arestas e os grupos que os tocam) | um ao outro | `opCreate`, `opDelete` |
| `group`, `ungroup` | o grupo inteiro | um ao outro | `opGroup`, `opUngroup` |
| `update` | o `data` de um nó (troca inteira, `from`/`to`) | `update` com os lados trocados | `opUpdate` |
| `edge-create`, `edge-delete` | uma aresta solta, sem nó junto (`edge: { at, item }`) | um ao outro, no mesmo índice | `opEdgeCreate`, `opEdgeDelete`, `opEdgesCreate`, `opEdgesDelete` |
| `patch` | `z`, `locked`, `blurred` de um nó, no lugar | `patch` com os lados trocados | `opPatch` |
| `link`, `unlink` | um nó na lista de membros de um grupo (`member: { at, item }`) | um ao outro | `opLink`, `opUnlink` |

- `update` confere o `data` com as regras do documento (JSON puro, profundidade, nó vivo sem conteúdo) na construção e na
  aplicação; erro é `history_invalid_op`. A troca da URL do portal é um `update`.
- `patch` troca só as chaves informadas (`from` guarda o valor delas antes); outro campo, camada fora do intervalo ou valor
  que não é booleano é `history_invalid_op`. O nó não é recriado: arestas, grupos e índices seguem.
- `unlink` recusa o último membro (grupo vazio não existe; use `opUngroup`). `edge-create` recusa id em uso
  (`history_duplicate_target`), ponta inexistente (`history_dangling_reference`), forma inválida e o teto de 5000.
- `opEdgesCreate` / `opEdgesDelete` montam o lote de várias arestas em um passo (uma só vira o passo simples). As remoções
  saem do maior índice para o menor, por isso o inverso, em ordem reversa, devolve cada aresta ao lugar de origem.

**Quem devolve o quê** (assinaturas exportadas iguais; muda só o tipo da operação):

- `canvas-edges.ts`: `opCreateManualEdge` e `opRemoveManualEdge` devolvem `AtomicOp` (`edge-create` / `edge-delete`),
  com os mesmos `EdgeError` de antes. **Saiu:** o tipo `EdgeOp` e o par `applyEdgeOp`/`invertEdgeOp`; use `applyOp(doc, op)`
  e `invert(op)` (ou `perform`/`undo`/`redo`). A ressalva de que `canvas-history` não desfazia aresta solta não vale mais.
- `canvas-bands.ts`: `linkBand` devolve lote de `edge-create` e `unlinkBand` lote de `edge-delete` (a nota não é mais
  recriada). Novos: `addToBand(doc, groupId, agentId)` (`link`) e `removeFromBand` (`unlink`; a banda segue com dois ou mais
  agentes, `BAND_MIN_MEMBERS`); `undefined` quando já está assim.
- `canvas-portal.ts`: `opSetPortalUrl(doc, id, url, policy)` → `update` do `data`, com a conferência da criação;
  `undefined` se a URL normalizada é a mesma. `portal_invalid_node` para nó ausente ou de outro tipo.
- `canvas-note.ts`: `opSetNoteAgent(doc, id, agent | undefined)` e `opEditText(doc, id, text, style?)` → `update` do
  `data`; o tamanho do nó não muda; `undefined` quando nada muda. Criar nó segue sendo `create`.
- `canvas-dock.ts`: sem mudança. O acoplamento é estado de tela, nunca operação do documento.
- `canvas-blur.ts`: `blurNodes` e `toggleBlur` geram `patch` do campo `blurred` (um `batch` de `patch` para vários); só
  `replaceNodes` segue como `delete` + `create`, para quem troca outros campos.

Prova: `loop/test/ts/canvas-history.test.ts`, `canvas-edges.test.ts`, `canvas-bands.test.ts`, `canvas-portal.test.ts`,
`canvas-note.test.ts` (ida e volta pelo desfazer de cada tipo, lote misto, limites e erros).

## Controles de câmera e forma do nó no motor

**Onde ficam os controles.** Aproximar, afastar, o nível de zoom (clicar volta a 100%) e enquadrar tudo são só do
`canvas-controls.tsx` (`ArgosCanvasControls.CanvasControls`), no canto inferior direito em `right-2 bottom-2`. A barra
de `parts.tsx` (`CanvasPane`) ficou só com Desfazer e Refazer (grupo "Histórico do canvas") e subiu para `bottom-14`,
acima dos controles de câmera, para os dois grupos não se cobrirem no mesmo canto.

**Gancho `nodeShape`.** Prop opcional do motor (`createCanvasEngine` e `CanvasView`): `nodeShape?(node): Shape`
(`"square" | "circle" | "diamond" | "hexagon"`, de `canvas-argos.ts`). O desenho de longe (ponto) e o bloco
usam os vértices de `shapePoints`; sem a prop, ou devolvendo `square`, o desenho é o retângulo de sempre (`fillRect`,
nenhum caminho montado).

- Bloco de forma própria: fundo do cartão, contorno na cor do nó (no lugar da faixa lateral) e o rótulo centrado, com a
  largura reduzida pela forma (a corda horizontal que cabe).
- No detalhe completo, nó com conteúdo HTML (`isRich`) volta ao retângulo, porque a camada HTML por cima é retangular;
  nó simples mantém a forma.
- Acerto do clique, seleção, anel e alça de redimensionar seguem o retângulo do nó, qualquer que seja a forma.
- Forma fora do contrato vira `square` com um `console.warn` por valor; o quadro não cai.
- Trocar a função de `nodeShape` redesenha no próximo quadro; passar a mesma função não. A página passa uma função de
  módulo (`M.argos.typeLook(n.type).shape`) para a identidade não mudar a cada render.

`ArgosCanvas.shapePaint` (`fillShape`, `strokeShape`, `sanitizeShape`, `LABEL_FIT`) expõe o desenho por forma sem DOM, para
teste. `minimap` e `touch` entram em `CANVAS_UI_MODULES` (saem em `window.CanvasModel.minimap` e `.touch`), e o
`index.html` carrega `canvas-minimap.js`. O minimapa é montado pelas camadas; o reconhecedor de toque não é usado pela página
(§Camadas sobre o canvas na página).

Provas: `loop/test/ts/canvas-engine-shape.test.ts` (motor com DOM falso e contexto que registra as chamadas) e os blocos
"canvas: onde ficam os controles" e "canvas: minimapa e toque chegam ao navegador" de `argos-ui.test.ts`.

## Menu, balão e permissão no nó (`canvas-menu.tsx`, `node-balloon.tsx`, `node-permission.tsx`)

Três componentes em `kit/panel/ui/argos/`, montados na página `#/argos` pelas camadas (§Camadas sobre o canvas e §Camadas sobre
o canvas na página). Scripts clássicos como os vizinhos: publicam `window.ArgosCanvasMenu`, `window.ArgosNodeBalloon` e
`window.ArgosNodePermission`, e leem os modelos de `window.CanvasModel` (as chaves `actions`, `compose` e `commands` estão em
`CANVAS_UI_MODULES`). `node-permission` carrega antes do balão, e os quatro scripts (com `canvas-overlays`) estão no
`kit/panel/ui/index.html` nessa ordem, antes de `pages/argos.js`. Montados, o menu de contexto antigo da página saiu, e a ação
Prompt do menu abre o balão (que usa o `createActionSender` de `node-permission` quando recebe `fetch` em vez de `send`).
Cada arquivo separa o modelo puro (testável sem DOM) da árvore de elementos (`render*`, sem hooks) e do componente (estado, efeitos, ciclo de vida).

Regras comuns: o servidor é o controle (item desabilitado é só tela; o POST é conferido de novo), todo `fetch` é injetado e
tem timeout, e todo pedido em voo, ouvinte e foco têm o dono do componente (saem juntos na desmontagem). Nenhum deles
mexe no documento do canvas, então nada entra na pilha de desfazer.

### Envio (`createActionSender`, em `node-permission.tsx`)

`createActionSender({ fetch, timeoutMs?, timers?, getToken?, onToken? })` devolve `send(request, { signal?, timeoutMs? })`,
que faz o `POST /api/argos/action` com o corpo de `actionRequest` e **nunca lança**: devolve `{ ok: true, output }` ou
`{ ok: false, code, message, status }`. O código da rota chega como veio; as falhas do cliente têm código próprio
(`SEND_ERRORS`, só ganham valores): `send_timeout`, `send_network`, `send_aborted`, `send_unexpected_response`,
`send_not_available`. Erro 5xx sem código vira `internal_error`. Mensagem do servidor é cortada em 300 caracteres. O
cabeçalho `X-Panel-Token` vem de `getToken`; com `403 token` o envio pede `/api/token` e repete uma vez (sem laço se o
painel devolver o mesmo token). O timeout padrão é 15 s; o balão usa 130 s, porque `prompt` espera o turno do agente
(até 120 s no servidor).

### Menu de contexto (`canvas-menu.tsx`)

`<CanvasMenu target at view registry commandCtx actionCtx? onAction onClose onError? />`. `target` é `{ kind: "node", node,
nodeType? }` ou `{ kind: "canvas" }`.

- **Itens** (`menuItems`): no nó, as ações de `actionsFor` (grupo "Agente", na ordem de `MENU_ACTIONS`; as que não valem
  agora ficam desabilitadas com o motivo, as destrutivas marcadas) e depois os comandos que o `menu` do tipo declara
  (`registry.nodeMenu`, só os que valem agora). No vazio, os comandos de `registry.canvasMenu`. Nó que não é agente e sem
  tipo: lista vazia, e o menu mostra "Nenhuma ação aqui". Se o `menu` do tipo cita comando inexistente, `menuItems` lança
  `RegistryError`; o componente usa `safeItems` (só as ações) e avisa por `onError`.
- **O que chama**: ação do agente → `onAction(item, node)` (a página abre o formulário e a confirmação pelo nome e faz o
  POST; o menu não faz `fetch`). Comando → `registry.get(id).run(commandCtx)`, depois de reconferir `when`; falha ou
  condição que deixou de valer vai a `onError`. Depois de qualquer escolha o menu fecha (`onClose`).
- **Teclado** (`menuKey`): `↑`/`↓` andam e dão a volta, `Home`/`End`, `Enter` ou `Espaço` ativam o item atual (desabilitado
  não ativa, mas continua alcançável para o leitor de tela ler o motivo), `Esc` e `Tab` fecham. Papel `menu` com
  `aria-activedescendant`; clique fora fecha; ao fechar o foco volta a quem abriu.
- **Posição** (`placeMenu`, `menuSize`): abre no ponto do clique, vira para a esquerda ou para cima sem espaço e fica sempre
  dentro da tela; passando da altura da tela, rola.

### Balão de mensagem (`node-balloon.tsx`)

`<NodeBalloon node drafts onDrafts doc anchor view send|fetch onClose onSent? />`. Duas formas de enviar, as duas pelo
`POST /api/argos/action`: **Prompt** (`prompt`, `hades agent prompt`) e **Texto** (`text`, digita no terminal sem Enter).
`balloonModes` diz qual vale: `prompt` pela regra da ação `prompt` (agente aberto) e `text` pela trava do herdr (a de
`free_prompt`). O que não vale fica desligado com o motivo.

- **Rascunho por agente**: o mapa `drafts` é da página (`Drafts` de `canvas-compose.ts`); o balão lê com `getDraft`,
  devolve o mapa novo por `onDrafts` (`setDraft`, `clearDraft`) e nunca o muda no lugar. Erro do compose aparece pelo código
  (`compose_too_many_drafts` com 200 rascunhos guardados, por exemplo) e o texto não é gravado.
- **Envio** (`Ctrl+Enter` ou botão): `prepareSend` resolve as referências `@nota` e `@nó` contra `doc` (`composeMessage`);
  mensagem vazia, referência que não existe, nota longa demais ou texto acima do teto param antes do POST e o rascunho fica
  como está. Aceito: o rascunho do agente é apagado e `onSent(modo, resultado)` avisa; recusado ou sem resposta: o rascunho
  fica, o código do erro vira alerta (`ArgosLogic.errorText`, quando a página o tem) e dá para tentar de novo. Um envio por
  vez. Trocar de agente ou fechar o balão aborta o envio em voo e a resposta tardia não mexe em nada.
- **Posição** (`placeBalloon`): à direita do nó, senão à esquerda, abaixo ou acima, sempre dentro da tela. `Esc` fecha e o foco
  volta a quem abriu.

### Permissão pendente no nó (`node-permission.tsx`)

`<NodePermission node ctx? send|fetch timeoutMs? errorText? onResult? />` desenha o pedido de `node.pendingPermission`
(ferramenta pedida) com **Aprovar** (`approve_permission`, Enter no diálogo) e **Negar** (`deny_permission`, Escape). Sem
pedido, não desenha nada.

- **Vale quando** (`permissionView`, a conta de `actionsFor`): pedido pendente, herdr `blocked` e ferramenta `Bash`, `Edit`,
  `Write`, `NotebookEdit` ou `mcp__…`. Plano, pergunta ou ferramenta desconhecida só se responde no terminal: os dois botões
  ficam desligados com o motivo. `answerPermission` repete a conferência e, se a ação não vale, não envia nada (o código da
  falha é o do motivo, `action_*`).
- **Estados** (`permissionReducer`): `idle` → `sending` (botão ocupado, os dois desligados, "Enviando…") → `confirmed`
  ("Aprovada…" / "Negada…") ou `error` (alerta com o texto do código, botões ligados para tentar de novo). A confirmação
  fica na tela mesmo depois de o grafo limpar o pedido, e some quando chega outro (`ts` novo) ou o componente passa a outro
  agente. `onResult(ação, resultado)` avisa a página, que atualiza o grafo.

Provas: `loop/test/ts/canvas-menu.test.ts`, `node-balloon.test.ts` e `node-permission.test.ts` (React mínimo, `fetch` e
temporizadores falsos, sem DOM nem rede).

## Comandos de organização (`commands-canvas.tsx`)

`kit/panel/ui/argos/commands-canvas.tsx` registra os comandos de organização do canvas no registro de comandos
(`registerCanvasCommands(registry, api)`; paleta `Ctrl+K`, botão direito e ajuda `?`). Cada comando liga um modelo puro de
`src/lib` a uma porta da página: a regra mora no modelo, e toda mudança no documento chega a `api.doc.commit` como uma
`CanvasOp` (um passo só no desfazer, que volta exatamente ao anterior). **Montado na página** (§Montagem na página): ela
passa o `api`, carrega o arquivo e as chaves abaixo estão em `CANVAS_UI_MODULES` (`src/panel/ui-transpile.ts`). Ficam sem
registrar os comandos das portas `snap`, `dock` e `workspace`, que a página não passa (§Interface `api` que a página fornece).

Script clássico: publica `window.ArgosCanvasCommands = { registerCanvasCommands, canvasCommandRows }`. Lê
`window.CanvasModel` e exige as chaves `history`, `groups`, `align`, `clipboard`, `walk`, `next`, `batch`, `blur`, `dock`,
`store` e `export` (arquivos `canvas-<chave>.ts`); sem alguma, falha na hora com o nome da que falta.
`registerCanvasCommands` devolve `{ registered, refused }`: atalho já tomado (`registry_shortcut_conflict`) recusa só aquele
comando. Chamar de novo não repete nem lança.

| Comando (id) | Atalho | Feature |
|---|---|---|
| `group:create` Agrupar a seleção | `Ctrl+G` | O1 |
| `group:ungroup` Desfazer o grupo | `Ctrl+Shift+G` | O1 |
| `group:rename` Renomear o grupo | — | O1 |
| `align:left` · `align:right` · `align:top` · `align:bottom` | `Alt+Shift+` ←, →, ↑, ↓ | O2 |
| `align:center` · `align:middle` | `Alt+Shift+H` · `Alt+Shift+V` | O2 |
| `distribute:horizontal` · `distribute:vertical` | `Ctrl+Alt+Shift+→` · `Ctrl+Alt+Shift+↓` | O2 |
| `grid:snap` Organizar na grade | `Shift+G` | O2 |
| `snap:toggle` Ligar/desligar o encaixe magnético | `Shift+M` | O3 |
| `clip:copy` · `clip:paste` · `clip:duplicate` | `Ctrl+C` · `Ctrl+V` · `Ctrl+D` | O5 |
| `clip:delete` Excluir | `Delete` · `Backspace` | O5 |
| `walk:next` · `walk:previous` | `Ctrl+Alt+→`/`↓` · `Ctrl+Alt+←`/`↑` | N4 |
| `owner:next` · `owner:previous` | `N` · `Shift+N` | N5 |
| `batch:select-filtered` Selecionar o filtrado | `Ctrl+Alt+A` | A4 |
| `batch:resume` · `batch:approve` · `batch:deny` | `Shift+R` · `Shift+A` · `Shift+X` | A4 |
| `blur:toggle` Desfocar/revelar o conteúdo | `Shift+B` | O6 |
| `dock:elevate` · `dock:undock` | `E` · `Shift+E` | O7 |
| `dock:left` · `dock:right` | `[` · `]` | O7 |
| `canvas:new` · `canvas:switch` · `canvas:rename` · `canvas:delete` | — | W1 |
| `canvas:next` · `canvas:previous` | `Ctrl+Alt+]` · `Ctrl+Alt+[` | W1 |
| `canvas:export` · `canvas:import` | — | W3 |

Nenhum atalho repete os que a página já registra (câmera, vista, ações do agente, leitura do grafo). Os de Delete e
`Ctrl` com letra não valem com o foco num campo de texto. Letras com `Alt` dependem do teclado (no macOS o `Alt` troca o
caractere): todo comando tem entrada na paleta.

Comportamento que o `api` não vê:

- **Seleção.** Id que o documento não tem é ignorado; a `when` de cada comando lê a seleção na hora. Agrupar e alinhar
  exigem 2 nós, distribuir 3; elevar e acoplar, um só.
- **Nó vivo** (`agent`, `unit`, `pr`, `gate`) não se copia, duplica nem exclui: o comando avisa quantos ficaram de fora.
  Desfocar vale para qualquer nó.
- **Colar** guarda a última cópia na memória da página; cada colagem seguinte anda mais um `PASTE_OFFSET`.
- **Lote.** O plano (`planBatch`) lista alvos e excluídos, a página confirma com o dono (ação destrutiva exige digitar
  `plan.confirmPhrase`), faz um POST por pedido e mostra `summarizeBatch`. Acima de `BATCH_MAX_TARGETS` o lote é recusado.
  Entram no lote as ações de `BATCH_ACTIONS`; a página liga `resume`, `park` ("Estacionar os selecionados"), aprovar e negar a
  permissão.
- **Importar** sempre cria um canvas novo (`freshCanvasId`) e troca para ele; nada é sobrescrito. **Excluir** o canvas
  pede confirmação, volta ao `default` e só então apaga; o `default` não se renomeia nem se exclui.
- **Erro de modelo** (código estável: `org_*`, `canvas_*`, `batch_*`) vira `notify({ level: "error", code, text })`.
  Defeito sem código sobe como exceção; falha inesperada de uma promessa vira `canvas_command_failed` e vai ao console.

### Interface `api` que a página fornece

`CanvasCommandsApi` (tipos exportados no próprio arquivo). Só `doc` e `dialogs` são obrigatórios; sem uma porta opcional, os
comandos dela não são registrados.

| Porta | Métodos | Comandos |
|---|---|---|
| `doc` | `doc()` o documento atual, `selection()`, `select(ids)`, `commit(op)`, `reveal(id)`, `notify({ level, code?, text })` | todos |
| `dialogs` | `askText({ title, initial? })`, `choose({ title, options })`, `confirm({ title, text })`; `null`/`false` = cancelou | renomear, canvases |
| `snap?` | `enabled()`, `setEnabled(on)` | `snap:toggle` |
| `dock?` | `state()`, `set(next)` (estado de tela, fora do desfazer) | `dock:*` |
| `owner?` | `nodes()` os `NextNode` do grafo | `owner:*` |
| `batch?` | `nodes(ids)`, `context()`, `filteredIds()`, `confirm(plan)`, `send(requests)`, `show(result)` | `batch:*` |
| `workspace?` | `current()`, `list()`, `create({ id, name, doc? })`, `switchTo(id)`, `rename`, `remove`, `saveFile({ filename, text })`, `pickFile()`, `now?()` | `canvas:*` |

`doc()` deve devolver o documento que o dono edita (o de exportar é o mesmo); o filtro da vista entra em `selection()`.

Prova: `loop/test/ts/canvas-commands-canvas.test.ts` (registro e colisão, cada comando com `api` falso e os modelos reais, ida e
volta pelo desfazer).

## Tipos de nó do usuário (`kit/panel/ui/argos/types-user.tsx`)

Um arquivo só declara no registro de tipos (`canvas-types.ts`, sem mudança) os nós do usuário: `note`, `text`, os quatro
`draw-*` (`draw-rect`, `draw-ellipse`, `draw-arrow`, `draw-stroke`: são os `type` que `canvas-draw.ts` grava), `unit-sketch` e
`band`. Script clássico (`window.ArgosTypesUser`), sem JSX e sem importar nada em tempo de execução: os modelos puros
(`note`, `draw`, `create`, `bands` de `src/lib`) chegam por `deps.model` ou por `window.CanvasModel`. **Os quatro estão
em `CANVAS_UI_MODULES`** e o arquivo está no `index.html`, montado pela página (§Montagem na página). Sem eles,
`registerUserTypes` falha na hora com uma mensagem que os nomeia.

`registerUserTypes(types, deps)` → as declarações que registrou. Tipo já registrado é pulado (chamar duas vezes, como o modo
estrito do React faz, não lança). Todos: `draw.surface = "html"` (o desenho é um `<svg>` dentro do HTML do nó), `live: false`
(a marca de nó do usuário, que o registro confere), `actions: []` (ação de servidor é só do agente vivo) e `menu` com ids de
comando de nó (`MENU`: `user:edit`, `user:duplicate`, `user:blur`, `user:remove`, `user:copy-commands`, `user:link-note`):
o registro de comandos da página tem de defini-los com a superfície `node-menu`, senão `checkTypeMenu` recusa.

`deps`: `fetch` (a página o entrega com o token da sessão; a rota exige `Content-Type: application/json`) e `now`
(relógio em ms) são obrigatórios; opcionais: `model`, `schedule(fn, ms)` → cancela (padrão `setTimeout`), `copy(text)`,
`onTextChange(nodeId, data)`, `onRemove(nodeId)`, `timeoutMs` (padrão 10 s) e `band` (`{ doc(), live(), focus(id) }`).
O arquivo **nunca monta operação**: trocar o `data` do texto e apagar o nó são callbacks do host, que os faz como
operação da pilha de desfazer (hoje `canvas-history` não tem operação de atualizar `data`: a c-historia a traz).

| Tipo | `data` | Tamanho | Comportamento |
|---|---|---|---|
| `note` | `{ note, agent? }` (`readNoteData`) | 280×200 | `<textarea>` sobre o arquivo `.md`: lê por `GET /api/canvas-notes/<nome>` e grava por `PUT` com a revisão lida; nota sem arquivo abre vazia e grava com `rev: null` |
| `text` | `{ text, style }` (`readTextData`) | 160×36 | duplo clique ou Enter edita no lugar; Ctrl+Enter ou sair do campo termina, Esc cancela; vazio pede `onRemove`; acima de 2000 caracteres mostra `note_too_large` e segue editando; sem `onTextChange` é só leitura |
| `draw-*` | `{ style: { stroke?, fill?, width }, from/to \| points }` | 160×100 (retângulo, elipse), 120×80 (seta, traço) | só exibição; cor fora de `#rgb/#rrggbb/#rrggbbaa` volta ao tom do tema, espessura limita a 0,5–64, dado corrompido não desenha |
| `unit-sketch` | o esboço de `canvas-create.ts` (`kind`, `name`, …) | 320×220 | mostra os comandos de `designUnit` num `<pre>` e (com `copy`) o botão "Copiar comandos"; **nada é executado**; esboço inválido mostra o código `create_*` |
| `band` | `{ group }` (id do grupo do documento) | 260×180 | lista de status de `bandStatus` (quem espera o dono primeiro, estado em palavra) e Anterior/Próximo por `stepBand`, que chamam `band.focus(id)` |

**Como a nota grava.** O cliente da rota nunca rejeita: falha de rede, tempo esgotado (`timeoutMs`, com `AbortController`) e
resposta fora do contrato viram um código (`note_network`, `note_timeout`, `note_bad_response`, só do cliente); os demais
vêm da rota (`note_not_found`, `note_stale_revision`, `note_too_large`, `note_invalid_name`, `note_unreadable`).
Nome fora da lista fechada e texto acima de 262 144 **bytes** nem chegam à rede. A revisão é a lida; a gravação em voo guarda
o texto enviado, então a base passa a ser esse texto mesmo que o rascunho tenha seguido mudando. **Conflito**
(`409 note_stale_revision`): o rascunho do dono fica intacto, aparece um alerta com a causa e duas saídas, "Gravar o meu
por cima" (regrava com a revisão atual que o `409` devolveu) e "Recarregar e descartar o meu"; nada é sobrescrito sem o
dono escolher. Resposta que chega depois de o nó desmontar é descartada. O texto da nota é plano (sem prévia de Markdown,
que pediria sanitização).

Provas: `loop/test/ts/canvas-types-user.test.ts` (registro real, cliente com `fetch` e agendador falsos, o editor da nota
e o componente sobre um React mínimo, texto, desenho, esboço e banda).

## Tipos de nó vivos (`kit/panel/ui/argos/types-live.tsx`)

Seis tipos de nó **de usuário** (`live: false` no registro: o "vivo" do grafo continua sendo só `agent`, `unit`, `pr` e `gate`)
cujo conteúdo vem de uma rota de leitura. O documento guarda poucos campos em `data`; nada aqui edita o canvas, então não há
`AtomicOp` nem desfazer. Montado em `#/argos`: a página chama `registerLiveTypes` (§Montagem na página), e o arquivo está no
`kit/panel/ui/index.html`.

`window.ArgosTypesLive.registerLiveTypes(types, deps)` registra os seis (menu e ações vazios, desenho em HTML) e devolve as
definições; chamar de novo não repete nem lança. `deps`:

- `fetch(url, { method, headers, body?, signal, cache })` → `{ ok, status, json() }` e `now()` (milissegundos, UTC): o
  teste injeta os dois; `setTimeout`/`clearTimeout` também podem ser injetados.
- `model`: `{ portal, conversation, agentFiles }` com os módulos de `src/lib` (`canvas-portal`, `canvas-conversation`,
  `canvas-agent-files`). Sem ele vale `window.CanvasModel`, onde os três estão (`CANVAS_UI_MODULES`).
- `portalPolicy` (política do portal no navegador; sem ela, só loopback; a página passa a do servidor, vazia até responder), `panelToken()` (padrão `window.__TOKEN`, vai em
  `X-Panel-Token` na conferência do portal), `timeoutMs` (padrão 8 s), `pollMs` (conversa de nó selecionado, padrão 5 s; 0
  desliga) e `onOpen({ kind: "file", agent, path, role? })`, chamado ao clicar num arquivo.

| Tipo (`type`) | `data` do nó | De onde lê | Tamanho |
|---|---|---|---|
| `portal` | `{ url }` | `portalViewOf` (política) e `POST /api/canvas/portal/check` | 640×420 |
| `terminal` | `{ session, pane, hasAgent? }` | `node-terminal.tsx` (rotas do herdr, sem mudá-lo) | 640×400 |
| `tree` | `{ agent, registry?, path?, depth? }` | `GET /api/canvas-content/tree` | 320×400 |
| `plan` | `{ name? }` | `GET /api/canvas-content/plan/<nome>` (sem nome: `GET …/plans` para escolher) | 420×400 |
| `agent-file` | `{ path, role, agent, label }` | `GET /api/canvas-content/tree` da pasta do arquivo (só diz se existe) | 240×60 |
| `conversation` | `{ agent, limit? }` | `GET /api/journal?agent=&limit=` e `conversationFromEvents` | 420×400 |

`agent` aceita o id do nó (`agent:<registro>:<nome>`, que também dá o `registry`) ou o nome puro. Dado inválido no `data`
(nome fora do formato, caminho com `..` ou absoluto, papel desconhecido, URL fora da política) **não gera pedido**: o nó
mostra "dados inválidos" e o motivo. Nenhuma rota devolve conteúdo de arquivo da worktree, então `agent-file` e os arquivos
da árvore são só nomes: clicar chama `onOpen` (sem o handler o botão fica desabilitado).

### Portal: quadro ou link

A URL do documento é conferida de novo pela política (`portalViewOf`) a cada desenho; só se passa, a rota de conferência é
chamada (cabeçalhos, sem ler corpo). Com `embeddable: true` o nó vira um `<iframe>` com `sandbox="allow-scripts allow-forms"`
(sem `allow-same-origin`: a página embutida não alcança o painel nem seus cookies), `referrerpolicy="no-referrer"` e
`loading="lazy"`. Quando a página não deixa embutir (`X-Frame-Options`, `frame-ancestors`, redirecionamento para fora, http em
painel https, endereço local pelo túnel, fora do ar, prazo), o nó mostra o motivo em texto e um link `target="_blank"
rel="noopener noreferrer"` para a mesma URL, mais "Atualizar" para conferir de novo. Se a rota **recusa** o endereço (400/403:
URL inválida, esquema, credenciais, host fora da lista), não há quadro nem link; falha de rede, prazo ou limite de taxa (429)
ainda deixam o link. A política do navegador é a mais estreita por padrão (só loopback); a rota é quem decide de verdade com a
lista do servidor, então um host extra permitido só embute quando a política que a página leu do servidor (`GET /api/canvas/portal/policy`) o
listar; até ela responder, ou se falhar, a política é vazia e nem o loopback embute.

### Ciclo de vida, erro e custo

- Toda busca passa por `deps.fetch` com timeout; o pedido, o temporizador de prazo e o de releitura têm o mesmo dono e saem
  juntos na desmontagem, na troca do dado do nó (outra URL, outro agente, outro caminho) e no cancelamento. Resposta que chega
  depois do cancelamento é descartada, mesmo de um `fetch` que ignorou o sinal.
- Erro da rota aparece **no nó** com o texto fixo dela e o código estável (`unknown_agent`, `plan_too_large`,
  `portal_rate_limited`…); sem resposta: `live_timeout`, `live_network`, `live_bad_body` (só ganham valores). O último dado bom
  fica na tela durante a atualização e depois de um erro.
- Só a conversa de um nó **selecionado** relê sozinha (depois de cada leitura terminar: nunca duas em voo); os demais leem
  ao aparecer, ao trocar o dado e por "Atualizar". O terminal só lê ao vivo com o nó selecionado (`live: selected`); as
  buscas internas dele são as do `node-terminal.tsx`, não passam por `deps.fetch`.
- Tetos de desenho: 200 linhas na árvore (o resto é contado), 40 unidades e 1200 caracteres de estado no plano, 200 entradas
  na conversa. A navegação por pastas é estado local do nó, não do documento.

Prova: `loop/test/ts/canvas-types-live.test.ts` (registro, timeout, cancelamento, resposta tardia, erro da rota, cada nó
montado sobre `fetch` e relógio falsos).

## Montagem: servidor

Três pendências de servidor que a montagem do canvas pede. Nada muda para quem já usa as rotas: tudo é aditivo.

### Ação `park`

`POST /api/argos/action` com `{ "node": "<id do agente>", "action": "park", "args": { "reason"?: "…" } }` (o `node` é o
mesmo id das demais ações, `agent:<registro>:<nome>`). Não é destrutiva: não pede `confirm`.

- Roda o próprio `hades agent park <nome> [motivo]` num subprocesso, na worktree do agente: a função `park` de
  `src/commands/agent-run.ts`. A regra (mandar o prompt de handoff, esperar o turno acabar, conferir que o `handoff.md` começa
  com `STATUS: PARKED` e é mais novo que o prompt, só então gravar `state: parked`) é a do CLI; a rota não a duplica.
- `args.reason` é opcional, de 1 a 400 caracteres; fora disso `400 invalid_args`, antes de rodar qualquer coisa.
- Resposta de sucesso, igual à das outras ações: `{ "v": 1, "ok": true, "node", "action": "park", "output" }`. `output` é o que
  o comando imprimiu (`<nome> estacionado (handoff.md em dia); …`). Agente já estacionado ou encerrado, e agente registrado sem
  sessão no herdr, também voltam `200` com o texto do CLI dizendo que não há o que fazer.
- Erros, os mesmos das outras ações: `unknown_node` (404) e `invalid_node` (400) para o id; `invalid_args` (400); `action_failed`
  (422, com a última linha do CLI) quando o agente não gravou o `STATUS: PARKED` fresco a tempo (o CLI pede para rodar de novo)
  ou o herdr recusou; `action_timeout` (504) no teto `HADES_ARGOS_ACTION_TIMEOUT_S` (1200 s; a espera do CLI é de 10 min).
- `park` é ação do menu do nó (`MENU_ACTIONS`, vale com agente aberto, campo `reason`) e entra em `BATCH_ACTIONS`: o lote manda
  um `park` por agente, os mesmos `args` para todos, sem frase de confirmação.

### `GET /api/canvas/portal/policy`

Os hosts que o nó portal aceita, para a página filtrar o endereço antes de perguntar ao `POST /api/canvas/portal/check`. Mesma
autenticação das demais rotas GET do canvas (verificação de Host, chave no acesso remoto).

```json
{ "exact": ["127.0.0.1", "[::1]", "localhost", "wiki.example.com"], "suffixes": ["lab.example.com"] }
```

- `exact` são hosts inteiros; `suffixes` são os domínios de um `*.sufixo` (valem para os subdomínios, não para o domínio nu).
  Ambos ordenados. É a mesma política que o `check` usa a cada pedido: loopback, o host do túnel do painel e
  `HADES_CANVAS_PORTAL_HOSTS` (`reference/config.md`). Configuração vazia é "só o que o `check` já libera", não lista vazia.
- **Não expõe** o valor cru de `HADES_CANVAS_PORTAL_HOSTS` (nem a ordem, nem os espaços) nem as entradas que a política
  descartou (coringa largo como `*.com`, URL, texto que não é host): ficam só no log do painel, como contagem.
- **Falha fechada.** Se a configuração não se lê ou não tem a forma esperada, a resposta é `200` com
  `{ "exact": [], "suffixes": [] }` (nenhum host liberado) e o motivo vai ao log. Quem consome trata qualquer erro (rede, 401,
  corpo estranho) do mesmo jeito: a política mais estreita. O servidor continua decidindo de verdade no `check`.
- Só `GET`: `POST` na rota é `404`. `Cache-Control: no-store`; a política vale para o próximo pedido, como a configuração.

### `canvas-blur` por `patch`

`blurNodes` e `toggleBlur` (`src/lib/canvas-blur.ts`) agora geram a operação `patch` de `canvas-history` com o campo `blurred`
no lugar do par `delete` + `create` de antes: um nó vira um `patch`; vários, um `batch` de `patch`, na ordem da seleção, sem os
nós que já estão no estado pedido (`undefined` se nenhum muda). O desfazer troca só o campo (`from` guarda o valor anterior):
conexões, grupos, posição na lista e `data` nem são tocados, e desfazer/refazer voltam exatamente ao documento. Nomes e
assinaturas exportados não mudaram; `replaceNodes` segue disponível para quem troca outros campos.

Prova: `loop/test/ts/argos-park.test.ts`, `loop/test/ts/canvas-portal-policy.test.ts`, `loop/test/ts/canvas-blur.test.ts`.

## Camadas sobre o canvas (`canvas-overlays.tsx`)

`kit/panel/ui/argos/canvas-overlays.tsx` compõe, sobre o motor do canvas, as camadas que já existem como componentes: o menu
de contexto, o balão do nó, a permissão pendente no nó, o minimapa e os gestos de toque. É montado pela página (§Camadas sobre o canvas na página; a camada de toque não é
passada). O componente só compõe e encaminha: não busca dado, não faz `fetch`, não lê estado global
(os componentes e modelos entram por `makeCanvasOverlays(deps)`; o registro da página os lê dos globais uma vez, no
carregamento) e não decide regra. Cada camada liga quando a prop dela vem e some quando não vem.

Script clássico: publica `window.ArgosCanvasOverlays = { CanvasOverlays, makeCanvasOverlays, … }`. **Exige**
(1) no pacote `canvas-model.js`, as chaves `actions`, `compose`, `camera`, `touch`, `commands` e `minimap`
(`CANVAS_UI_MODULES`, todas presentes); (2) no `kit/panel/ui/index.html`, nesta ordem, `argos/node-permission.js`,
`argos/node-balloon.js`, `argos/canvas-menu.js` (`argos/canvas-minimap.js` carrega antes) e por último
`argos/canvas-overlays.js` (também já é assim). Faltando algo, o carregamento lança dizendo o que carregar.

### Props de `<CanvasOverlays camera view nodes … />`

| Prop | Tipo | Obrig. | O que liga |
|---|---|---|---|
| `camera` | `Camera` | sim | leva os retângulos do mundo à tela (balão, permissões) e é a base do minimapa e do toque |
| `view` | `Viewport` | sim | tamanho da tela do canvas, em pixels; vai ao menu, ao balão e ao minimapa |
| `nodes` | `{ node: ActionNode, rect: Rect }[]` | sim | **só os nós visíveis**: `rect` no mundo; dele saem o minimapa, o âncora do balão e as permissões |
| `menu` | `Omit<CanvasMenuProps, "view">` | não | **menu**: abre quando a prop vem (`target`, `at`, `registry`, `commandCtx`, `actionCtx?`, `onAction`, `onClose`, `onError?`) |
| `balloon` | `{ nodeId, drafts, onDrafts, doc, ctx?, send?, fetch?, timeoutMs?, onClose, onSent? }` | não | **balão** no nó `nodeId`, que tem de estar em `nodes` (senão nada é desenhado); o resto vai ao `NodeBalloon` |
| `permission` | `{ ctx?, send?, fetch?, timeoutMs?, errorText?, onResult? }` | não | **permissão** em cada nó visível com `pendingPermission`; o resto vai ao `NodePermission` |
| `minimap` | `{ onCamera, size?, label? }` | não | **minimapa** no canto inferior direito, com os `rect` de `nodes`; `onCamera` recebe a câmera nova do clique ou arrasto |
| `touch` | `{ surface, onCamera, onTap?, onLongPress?, onError? }` | não | **toque** no elemento `surface` (o quadro do canvas; `null` desliga): pan e pinça viram câmera, tap e toque longo vão à página em pixels do `surface` |

- **Encaminhamento**: o menu entrega a ação do agente a `menu.onAction(item, node)` e roda comando pelo registro, como o
  próprio menu faz; o `fetch`/`send` do balão e da permissão vêm da página. O componente não envolve nem transforma nada
  disso. Ação que muda o documento sai da página como `AtomicOp` de `canvas-history.ts` pelo `commandCtx` que ela monta
  (as camadas não alteram o documento; nenhuma delas empurra o desfazer).
- **Câmera**: `onCamera` (minimapa e toque) pede a câmera nova; quem aplica, e se anima ou não, é a página. Dois eventos de
  toque antes de a página redesenhar partem da câmera que o primeiro acabou de pedir (sem perder deslocamento).
- **Toque** (`gestureCamera`, o gesto em câmera): `pan` → `panBy`; `pinch` → `pinchCamera` contra a câmera do primeiro
  `pinch` do gesto (guardada até o `end`); `tap`, `longpress` não mexem na câmera. Só `pointerType === "touch"`: o mouse é do
  motor. A camada põe `touch-action: none` no `surface` e devolve o valor ao sair; o timer do toque longo (`TOUCH_TICK_MS`,
  100 ms) existe só com dedo na tela. Ponto inválido cancela o gesto e vai a `touch.onError` (ou ao console).
- **Permissões** (`permissionSlots`): caixa embaixo do nó, na largura dele (mínimo 224 px), dentro da tela na horizontal; nó
  fora da tela não ganha caixa; no máximo `MAX_PERMISSION_BOXES` (24) ao mesmo tempo. O nó que já pediu segue montado
  enquanto estiver em `nodes`, para a confirmação ("Aprovada…") sobreviver ao grafo que limpou o pedido; sai de `nodes` e a
  caixa é esquecida.

### Ordem de empilhamento (de baixo para cima)

1. Minimapa e caixas de permissão (`z-10`), canto inferior direito e embaixo dos nós.
2. Balão (`z-20`), ao lado do nó.
3. Menu de contexto (`z-30`), cobre todos.

O toque não desenha nada. O quadro das camadas é `absolute inset-0 pointer-events-none`: só as caixas de cada camada
(`pointer-events-auto`) recebem ponteiro, então o motor por baixo segue recebendo arrasto, roda e clique. A página monta o
quadro dentro do contêiner posicionado do canvas, depois do motor (mesma ordem de pintura).

Prova: `loop/test/ts/canvas-overlays.test.ts` (React mínimo, componentes falsos, `surface` e temporizadores falsos).

## Montagem na página

O que a página `#/argos` (`kit/panel/ui/pages/argos.tsx`) passou a montar no registro de tipos e comandos dela, uma vez por
abertura, por `ArgosLogic.mountCanvasRegistries` (`kit/panel/ui/argos/logic.tsx`). Os scripts `node-terminal.js`,
`commands-canvas.js`, `types-user.js` e `types-live.js` entram no `index.html` depois de `reading-bar.js` e antes de
`pages/argos.js`; os módulos do modelo que eles leem (`groups`, `align`, `clipboard`, `walk`, `next`, `batch`, `blur`, `dock`,
`export`, `note`, `draw`, `create`, `bands`, `portal`, `conversation`, `agentFiles`, `actions`, `compose`) estão em
`CANVAS_UI_MODULES` (`src/panel/ui-transpile.ts`).

Ordem da montagem: os `user:*` (só na superfície `node-menu`), os comandos de organização (`registerCanvasCommands`), os
tipos do usuário (`registerUserTypes`, com o `menu` de cada tipo conferido contra os comandos por `checkTypeMenu`) e os tipos
vivos (`registerLiveTypes`). Comando ou tipo recusado fica de fora, vai ao console com o código e o resto segue; montar de
novo sobre os mesmos registros não repete nem lança.

| O que | Como a página liga |
|---|---|
| `user:edit`, `user:duplicate`, `user:blur`, `user:remove`, `user:copy-commands`, `user:link-note` | ids de `ArgosTypesUser.MENU`, definidos pela montagem só em `node-menu`; o comando chama `handlers.userMenu(tipo, nó)`. Editar pergunta o texto (diálogo da página); duplicar, desfocar e excluir rodam `clip:duplicate`, `blur:toggle` e `clip:delete` sobre o nó; copiar comandos usa `unitSketchView`; ligar nota pergunta qual nota e aplica `bands.linkBand` |
| Texto dos nós do usuário | `onTextChange` → `note.opEditText` = operação `update` (um passo do desfazer, que volta exatamente ao anterior; texto e estilo iguais não entram na pilha); `onRemove` e o texto esvaziado → `opDelete`. Recusa com código vira aviso, sem entrar na pilha |
| Nós do usuário na vista | não passam pelos filtros do grafo (ficam sempre visíveis); o menu de contexto acha o nó no documento quando ele não é do grafo |
| Política do portal | `GET /api/canvas/portal/policy` com o token da sessão e prazo de 8 s, lido uma vez na abertura; até responder, em erro, sem resposta ou com corpo fora da forma `{ exact: string[], suffixes: string[] }`, vale a política vazia (falha fechada) |
| Lote | `batch.send` faz um `POST /api/argos/action` por agente, em sequência, com o corpo de `actionRequest`; o pedido sem resposta conta como status 0. A confirmação é o diálogo da página com a frase do plano quando ele a pede |
| `batch:park` | "Estacionar os selecionados": linha nova do lote (paleta e menu do fundo, com ≥1 selecionado, sem atalho), ação `park` |
| Diálogos | `api.dialogs` (`askText`, `choose`, `confirm` com frase digitada) abre `ArgosParts.AskDialog`; uma pergunta por vez (a nova cancela a aberta) e o teclado do canvas fica parado enquanto ela está aberta |
| Arquivo do agente | `onOpen` abre o leitor de arquivo só para os papéis `brief`, `report`, `questions` e `handoff`; outro arquivo: aviso |

Os pedidos da página (política, lote) têm um `AbortController` só, que sai na desmontagem. Ainda **fora** da montagem: as
portas `snap`, `dock` e `workspace` da `api` (então `snap:toggle`, `dock:*` e `canvas:*` não registram).

### Camadas sobre o canvas na página

`ArgosParts.CanvasLayers` (`parts.tsx`) põe `CanvasOverlays` dentro do quadro posicionado do canvas, depois do motor. A câmera
e o tamanho da tela vêm do motor (`getCamera`, `viewport`, lidos a cada quadro por `onFrame`); o componente só redesenha
quando um dos dois muda, então o pan não redesenha a página. Os scripts `node-permission.js`, `node-balloon.js`,
`canvas-menu.js` e por último `canvas-overlays.js` entram no `index.html` antes de `pages/argos.js`.

| Prop | O que a página passa |
|---|---|
| `nodes` | os nós da vista (`viewDoc`, já filtrada), por `ArgosLogic.overlayNodes`: o do grafo com o dado das ações, o do usuário só com id, tipo e rótulo |
| `menu` | o menu de contexto das camadas no lugar do antigo da página. O ponto do botão direito (ou Enter no nó) é convertido para pixels do quadro. No nó: as ações do agente e o `menu` do tipo por `overlayMenuType` (sem os `action:*`, que o próprio menu já lista; com fixar/soltar no fim); no fundo, os comandos de `canvas-menu`. `commandCtx` é o contexto dos comandos da página; `actionCtx`, o `herdr.available` do grafo (`actionContextOf`) |
| `balloon` | aberto pela ação **Prompt** do menu, no agente escolhido: rascunhos por agente guardados na página, `doc` do canvas para as referências `@`, envio pelo `fetch` com o token da sessão. Fecha com Esc, pelo botão ou quando o agente sai do grafo; aberto, os atalhos da página ficam parados |
| `permission` | sempre: caixa de aprovar/negar sob cada nó visível com permissão pendente, com o mesmo `fetch` e o `errorText` da página |
| `minimap` | sempre, no canto inferior direito; o clique ou arrasto leva a câmera sem animação. Os controles de câmera e a barra do histórico subiram acima dele |
| `touch` | **não** passa: o motor já faz pan e pinça com o dedo, e as duas coisas juntas dobrariam o gesto |

Ação escolhida no menu (`overlayActionRoute`): **Prompt** abre o balão; as que o diálogo de ações da página conhece abrem o
diálogo (campos e frase de confirmação como antes); **Estacionar** pergunta o motivo (opcional) e vai direto à rota; ação
cujo campo pede escolha que só o painel do nó tem (a sessão de **Parar a sessão do herdr**) avisa para usar o painel.

Prova: `loop/test/ts/argos-ui.test.ts`, "montagem do canvas na página" (registros montados, `user:*` no `node-menu`, tipos
vivos, `onTextChange` com desfazer exato, política vazia em erro e sem resposta, `batch:park` confirmado no lote) e "camadas
sobre o canvas na página" (rota de cada ação do menu, tipo do menu, nós das camadas, contexto das ações, scripts na ordem do
`index.html`, props passadas a `CanvasOverlays`).

## Painel no canvas (`canvas-focus.tsx`)

No `#/argos`, o painel do nó é uma **gaveta dentro do canvas**, ancorada à direita do palco na mesa e uma folha embaixo no
celular (`sheet`, até `SHEET_MAX` da altura), sem seleção automática. `kit/panel/ui/argos/canvas-focus.tsx` é só o componente (desenha e encaminha): a seleção, o
nó primário e o "aberto" são da página, que monta o `FocusPanel` ao lado do motor, com o `SidePanel` do primário como
`children`. O script registra `window.ArgosFocus = { FocusPanel, FOCUS_PANEL_WIDTH }` e entra no `index.html` depois de
`parts.js` (usa `ArgosParts.Forma`, `Icon`, `TONE_ICON`, `TONE_TEXT` e `CanvasModel.argos` para forma e estado).

| Prop | O que é |
|---|---|
| `open` | aberto ou recolhido |
| `nodes` | os selecionados visíveis, na ordem da seleção: `{ id, label, type, shape?, state? }`. `shape` ausente vem do tipo (`typeLook`); `state` ausente some da faixa |
| `primaryId` | qual deles o `children` mostra; o chip dele leva `aria-current="true"` |
| `onPrimary(id)` | clique ou Enter num chip da faixa |
| `onToggle(open)` | recolher (botão do topo, Esc) ou expandir (alça); a página guarda o valor |
| `children` | o `SidePanel` do primário |

**Quantos selecionados**

- **Nenhum**: não desenha nada (nem a alça: não há o que expandir). A página não precisa desmontar o componente.
- **Um**: só os `children`, sob uma barra fina com o botão de recolher.
- **Vários**: acima dos `children`, uma faixa compacta (lista `Selecionados`) com um botão por nó: forma, rótulo e estado
  (palavra, ícone e tom da tabela de estados, os mesmos do canvas). A faixa quebra em linhas; o primário fica com borda
  forte. Os botões são nativos, então Enter e Espaço escolhem como o clique.

**Recolhido** (`open=false`): só uma alça rotulada ("Expandir painel do nó") na borda direita, no meio da altura; com vários
selecionados ela mostra quantos são. Aberto, o botão "Recolher painel do nó" fica no topo, fixo ao rolar.

**Esc** com o foco dentro do painel chama `onToggle(false)` e **não propaga** para o canvas (que limparia a seleção). Um filho
que já tratou o Esc (`preventDefault`, como um campo que cancela a edição) mantém o painel aberto, e o Esc de um diálogo em
portal (fora do DOM do painel, mas dentro da árvore do React) não é do painel. O foco acompanha só o que o próprio painel
fez: recolher leva o foco à alça, expandir leva à região; troca vinda da página (um atalho) não mexe no foco.

**Isolamento do canvas**: ponteiro (`pointerdown/move/up/cancel`), roda, duplo clique e botão direito dentro do painel e da alça
não chegam ao canvas (não arrastam, não dão zoom, não limpam a seleção). O bloqueio é do React (`stopPropagation`), então o
painel precisa ficar **ao lado** do elemento que o motor escuta, não dentro dele; os ouvintes nativos de um ancestral
disparam antes.

**Layout**: região `role="complementary"` (`aria-label="Painel do nó"`), `absolute inset-y-0 right-0 z-20` (acima do minimapa e
dos controles, abaixo do menu de contexto, z-30), `overflow-y-auto scrollbar-thin`, `bg-card`, borda à esquerda, sem cor
nova (tokens e utilitários de `parts.tsx`; alvos de toque com `max-md:min-h-11`; anel de foco `focus-visible`).

**`FOCUS_PANEL_WIDTH`** é a largura do painel aberto, a string CSS `clamp(20rem, 32%, 28rem)`. A página usa a mesma string para
deslocar o HUD, o minimapa e os controles de câmera para a esquerda enquanto o painel está aberto, sem repetir o número.

Prova: `loop/test/ts/argos-ui.test.ts`, "painel do nó no canvas (ArgosFocus)" (transpila isolado e expõe a API, 0/1/3
selecionados, `aria-current`, `onPrimary`, só a alça fechado, recolher, Esc, isolamento de ponteiro e roda, foco).

## Esconder controles

O comando `canvas:focus` (antes "Modo foco") esconde tudo o que não é canvas: as ilhas do HUD, o grupo da câmera, a toolbar, a
lista de nós e a gaveta do nó. Sobra o canvas e um botão discreto **Mostrar controles** no canto superior direito
(`aria-keyshortcuts="Shift+F"`). Vale na mesa e no celular.

| Por onde | O quê |
|---|---|
| Comando `canvas:focus` | "Esconder controles" / "Mostrar controles", grupo Vista, na paleta (`Ctrl+K`) e no menu do fundo do canvas (porta `focus` da `api` de `commands-canvas.tsx`: `enabled()`, `available()`, `setEnabled(on)`) |
| Tecla `Shift+F` | o `f` sozinho segue sendo **Enquadrar** (`fit`); não é tecla do motor, então vale com o foco no canvas, e não vale num campo de texto |
| Endereço `focus=1` | escalar de `canvas-urlstate.ts` (`#/argos?focus=1&v=1`), aditivo: ausente = desligado; o parse não mudou |

A preferência fica em `hades.argos.focus`: liga ao abrir se o endereço traz `focus=1` **ou** se ela está ligada. Ligar e
desligar grava a preferência e abre uma entrada nova no histórico; Voltar e Avançar restauram o estado sem mexer nela.

Não existe mais botão **Foco** nem altura própria do card (`FOCUS_CANVAS_H` saiu): o canvas já ocupa a página inteira
(§A página, "Palco").

Prova: `loop/test/ts/canvas-urlstate.test.ts` ("foco") e `loop/test/ts/argos-ui.test.ts` ("esconder controles: comando
canvas:focus" e "esconder controles na página").

## Terminal do nó (renderização)

O herdr entrega o terminal de um agente como **quadro pronto** (`pane.read source=visible format=ansi`), não como fluxo de bytes;
por isso o nó **escreve cada quadro como tela inteira numa instância do xterm.js** (decisão nova: antes o nó usava um renderizador
ANSI próprio, sem biblioteca de terminal). `kit/panel/ui/argos/node-tty.tsx` (`window.ArgosNodeTty`) cria o xterm por
`HadesCore.createXterm` (`term.tsx`: o mesmo tema do painel, claro e escuro, que o `PtyTerminal` usa), só leitura e sem scrollback
(o histórico continua sendo a janela do `/api/herdr/scrollback`), e coleta a entrada, que segue por `POST /api/herdr/input`.
`screenOf(ansi, cursor?)` monta a tela: atributos zerados, cursor ao canto, tela limpa, linhas por CRLF, sem quebra no fim;
cada quadro redesenha tudo, então não sobra scrollback falso. O xterm não consome tecla nenhuma (o nó as traduz e as globais
sobem ao canvas). **Só o nó legível tem xterm**: com o zoom baixo ou o nó pequeno (`headerOnly`, `ttyDrawing`) fica o resumo leve
(cabeçalho) e o xterm é descartado; com muitos nós, só os ampliados o bastante para ler pagam o custo. `src/lib/term-ansi.ts`
deixou de ser usado pelo nó (só os limites de tamanho do quadro); o conversor segue testado em `term-ansi.test.ts`. Esta
unidade não pede resize: a grade do xterm é a do quadro (`term.resize(cols, linhas)`), escalada por transform.

**O que o conversor suporta** (`parseAnsi(ansi)` → `TermLine[]`, cada linha uma lista de `{ text, style }`)

| Entrada | Resultado |
|---|---|
| SGR `0`/vazio, `1`, `3`, `4`, `7` e `22`, `23`, `24`, `27` | reset, negrito, itálico, sublinhado, inverso e os pares que desligam |
| `30–37`, `40–47`, `90–97`, `100–107`, `39`, `49` | 16 cores (índices 0–15) de frente e de fundo; `39`/`49` voltam ao padrão |
| `38;5;n`, `48;5;n` (e `38:5:n`) | 256 cores: índice da paleta (`colorCss` resolve 16, cubo 6×6×6 e rampa de cinza) |
| `38;2;r;g;b`, `48;2;r;g;b` (e `38:2:r:g:b`, `38:2:cs:r:g:b`) | truecolor |
| outras sequências (cursor, limpeza, OSC, DCS, charset, ESC solto, CSI privado `ESC[?…m`) | descartadas sem quebrar o resto |

Valor impossível (índice acima de 255, canal acima de 255, parâmetro faltando) **não vira cor nem zero**: o atributo é ignorado
e o resto da sequência vale; modo estendido desconhecido (`38;9;…`) descarta o resto daquela sequência. O estilo passa de uma
linha para a próxima, como no terminal; spans vizinhos de mesmo estilo se fundem; `\r` some, `\t` anda até a parada de 8
colunas e os demais controles são descartados. Um par substituto (emoji) é uma célula.

**Teto da entrada** (`TERM_LIMITS`): 1 MiB em bytes UTF-8 e 500 linhas por quadro. Acima disso `parseAnsi` lança `TermAnsiError`
com o código estável `term_ansi_too_many_bytes` ou `term_ansi_too_many_lines`; nada é truncado em silêncio. O componente mostra
o aviso "grande demais" e não desenha.

**Contrato do componente**

`window.ArgosNodeTty.NodeTty({ frame, focused, onFocus, onBlur, onInput({ text?, keys? }), scale?, headerOnly? })`, com
`frame = { pane, revision, cols, rows, ansi }` (`cols` 1–1000, `rows` 1–500; grade inválida não desenha e avisa). Exporta também
`TTY_GLOBAL_KEYS`, `minSize(frame)` e, para teste e para quem integra, `translateKey`, `fitScale` e `spanStyle`.

- **Escala.** A célula mede `0,6 em` × 17 px na escala 1 (Geist Mono a 13 px). `scale` fixa a escala (1 = natural); sem ele o
  quadro se ajusta ao espaço de desenho do nó (`ResizeObserver`, que sai com a desmontagem), entre 0,2 e 2. `minSize(frame)` é
  o tamanho mínimo do nó na escala 1: cabeçalho mais ~20×6 células (menos, se o quadro for menor).
- **Foco.** `focused` é do dono. Clicar dentro chama `onFocus` (uma vez; já focado, não repete); clicar fora enquanto focado
  chama `onBlur`. O ouvinte de documento só existe enquanto `focused` e sai ao desfocar ou desmontar. Ao ganhar o foco, o elemento
  recebe o foco do navegador (sem rolar). Sem o foco nenhuma tecla é consumida.
- **Teclado.** Com o foco, `keydown` vira `{ text }` (caractere imprimível, inclusive AltGr) ou `{ keys: [nome] }` e é consumido
  (`preventDefault` e `stopPropagation`). Nomes: `Enter`, `Escape`, `Tab`, `Shift+Tab`, `Up`, `Down`, `Left`, `Right`, `Home`,
  `End`, `PageUp`, `PageDown`, `Backspace`, `Delete`, `Ctrl+A`…`Ctrl+Z`. O servidor (`herdr-page.ts`) ainda só aceita parte
  dessa lista em `keys`: quem liga o canal alarga a tabela de lá.
- **Colagem.** O evento `paste` vira `{ text }` (texto puro, até 20 000 caracteres, o mesmo teto do envio do servidor; acima
  disso não envia e avisa). Por isso `Ctrl+V` **não** é traduzido para `Ctrl+V`: ele fica com o navegador e chega como `paste`.
- **Ctrl+Shift+V / Ctrl+Shift+C** (`clipboardAction`, pelo `code`, vale em qualquer layout). Colar lê a área de
  transferência pela Clipboard API (o navegador só solta `paste` em campo editável) e envia como `{ text }`, com o mesmo
  teto; recusada, avisa para usar Ctrl+V. Copiar leva o texto selecionado com o mouse dentro do terminal; sem seleção,
  só avisa. Nenhum dos dois vai ao agente; `Ctrl+C` sem Shift segue sendo a interrupção.
- **Linhas.** A altura do pane acompanha o `layout_updated` do herdr como a largura (antes era lida uma vez só, e o pane
  que crescia perdia as linhas de baixo, onde fica o campo de digitação do agente). Texto com mais linhas que o quadro
  anuncia mostra todas (`rowsToShow`). A escala mede o tamanho de layout da área (`clientWidth`/`clientHeight`), não o da
  tela, que já vem multiplicado pelo zoom do canvas.
- **O que passa ao canvas.** As teclas de `TTY_GLOBAL_KEYS` (`Ctrl+Shift+A`, `Alt+1`…`Alt+9`, `Alt` sozinho e `Ctrl+]`) não são
  consumidas: sobem como se o foco não estivesse no terminal. `Alt+dígito` é reconhecido pelo `code` (`Digit1`…), porque a tecla
  muda com o layout. Também ficam com o navegador, sem consumo: modificador sozinho, `Meta+…`, composição de IME, teclas
  que o contrato não nomeia (`F1`…, setas com `Ctrl`/`Alt`, `Alt+letra`).
- **`headerOnly`.** Só o cabeçalho (painel, `cols×rows`, "teclado no terminal" quando focado): o texto do quadro não é nem
  convertido.
- **Acessibilidade.** A raiz é `role="region"` com `aria-label="Terminal <pane>"` e `tabIndex=0`; avisos (quadro grande demais,
  colagem grande demais) saem em `role="status"`.

**Limites conhecidos** (o nó desenha com o xterm.js desde a term-argos): o quadro do herdr não traz
posição de cursor, então não há cursor desenhado; caracteres largos (CJK) e combinantes contam como uma célula e o navegador
decide a largura real; a largura da célula é a constante `0,6 em`, o que difere de fonte mono que não a cumpra.

Prova: `loop/test/ts/term-ansi.test.ts` (cada atributo, 256 e truecolor, reset, sequência desconhecida, teto) e
`loop/test/ts/argos-ui.test.ts` ("terminal do nó (ArgosNodeTty)": quadro, foco, teclas globais não consumidas, colagem).

### Terminal do nó: medida, acentuação, seleção e roda

Acréscimos ao contrato acima; onde divergem das linhas anteriores, estes valem. Prova em `loop/test/ts/argos-tty-input.test.ts`.

- **Medida (limite do herdr 0.8.2).** O herdr não tem API que fixe cols×rows de um pane (`pane.resize` só move a divisória
  entre panes), então o componente nunca pede resize: o tamanho do nó só muda a **escala** do quadro (`fitScale`, 0,2 a 2) e a
  proporção do nó decide a sobra ou o corte. A área é medida por `clientWidth/clientHeight` menos o respiro (`areaBox`), que é
  tamanho de layout, em unidades do mundo e sem o zoom do canvas; `getBoundingClientRect` incluía o `transform` que a camada
  HTML já aplica e a escala saía multiplicada pelo zoom. O nó monta e desmonta com o nível de detalhe e ganha o tamanho
  depois do primeiro desenho, por isso a medida também é refeita no quadro seguinte à montagem. `fitForNode({ w, h }, frame)` é
  a mesma conta a partir do tamanho do nó na escala 1.
- **Acentuação e IME.** Com o foco do teclado, a entrada vai a um `textarea` escondido dentro do nó (como o xterm.js). Tecla
  morta e composição de IME são do campo: `createTextInput` entrega o texto montado **uma vez** como `{ text }` (no
  `compositionend`, ou no `input` quando o teclado digita `é` direto; o eco que alguns navegadores disparam depois do fim da
  composição encontra o campo já zerado). Teclas nomeadas e imprimíveis seguem pelo `keydown`. No compositor do canvas
  (`canvas-composer.tsx`), Enter, Esc, Tab e as setas de uma composição em curso não enviam, não fecham nem escolhem.
- **Seleção e cópia.** O arrasto dentro do nó é do navegador: o canvas só toma o gesto no cabeçalho (o conteúdo do nó rico
  não propaga o `pointerdown` ao motor). Com texto selecionado na grade, `Ctrl+C` copia e **não** vai ao pane; sem seleção
  segue como `Ctrl+C` do agente. `Ctrl+Shift+C` sempre copia; `Ctrl+Shift+V` e `Ctrl+V` colam pelo evento `paste`. O menu
  Copiar do navegador usa o texto da grade. O foco do campo escondido espera o ponteiro soltar e não desfaz uma seleção
  existente. A grade é escalada por `transform`, então a seleção pode ficar imprecisa em escalas muito baixas. A nota em modo
  leitura (formatada) tem seleção e `Ctrl+C` nativos.
- **Tecla morta.** `´`+`a` chega ao pane como `á`, uma vez: enquanto a composição do campo escondido está aberta
  (`compositionstart` até `compositionend`, `createTextInput.busy()`), os `keydown` da letra base não viram tecla, e o texto
  composto sai pelo `input`/`compositionend`.
- **Roda e histórico.** A roda comum sobre o terminal legível é consumida por ele (`data-tty-wheel`, ouvinte nativo não passivo) e o
  motor do canvas a ignora; `Ctrl`/`Alt`+roda seguem como zoom e pan. O nó distante (só cabeçalho) ou com problema no quadro não
  leva `data-tty-wheel` nem segura a roda: o canvas dá zoom sobre ele. A roda é proporcional: linhas e páginas valem o que
  dizem e pixels (trackpad) somam num resto, dividido pela altura de linha na tela (escala do quadro e zoom do canvas), então
  evento miúdo não vale uma linha. O estado da rolagem fica em ref: rajada de giros antes de o histórico chegar soma os passos. Para cima, o nó busca o histórico em
  `GET /api/herdr/scrollback?pane=&lines=[&session=]` (`pane read --source recent --format ansi`, que devolve linhas acima do
  quadro: medido 306 linhas contra 39 visíveis) e passa a mostrar uma janela dele, presa ao topo e ao fim; a roda para baixo volta (no fim, ao vivo), e o botão
  "↓ ir ao fim" (`data-tty-to-end`) ou qualquer tecla enviada ao pane retorna ao quadro ao vivo. `lines` vai de 1 a 2000
  (fora disso a rota recusa, não trunca; padrão 500; o nó pede 1000); erro de leitura responde genérico. O `NodeTty` usa
  `frame.session` e, sem ele, a sessão padrão.

### Abrir terminal a partir do nó

O menu do nó de agente (botão direito) tem **Abrir terminal na worktree** (`agent:open-terminal`, só com `worktree` absoluta) e
**Abrir cliente do herdr** (`agent:open-herdr-client`, só com a sessão do herdr conhecida e de nome seguro). Os dois abrem a
sessão (`POST /api/term/open`, `kind: shell` com `cwd`, ou `herdr-client` com `session`), põem o id na mesa da página Herdr
(`sessionStorage`) e levam a ela (`HadesCore.TermOpen.openAndGo`). Com `HADES_TERMINAL` desligada o servidor recusa com
`term_disabled` e o aviso diz como ligar; pasta fora das raízes volta `term_forbidden_cwd` (a decisão é do servidor, esconder o
botão não é controle). Prova: `argos-abrir-terminal.test.ts`.

## Fluxo do terminal (servidor)

O nó de agente mostra o pane do herdr ao vivo. O servidor (`src/panel/herdr-stream.ts`) manda quadros prontos do herdr;
a grade é a do herdr (o painel nunca manda resize ao PTY: `pane.resize` move divisão). UI e renderização de ANSI são do
componente do nó.

**`GET /api/herdr/stream?session=<s>&panes=<p1,p2>`** (SSE; autenticação das outras rotas GET). `session` padrão
`default`; `session` e cada pane validados no formato (`SESSION_NAME`/`PANE_ID` de `herdr-page.ts`), até
`STREAM_PANES_MAX` (12) panes por conexão e `STREAMS_MAX` (20) fluxos abertos (acima: 429 com `Retry-After`). Os panes
são conferidos contra a listagem atual do herdr (`pane.list`): pane fora dela recebe um evento `error`; todos fora → 400.

| Evento | Dados |
|---|---|
| `frame` | `{ pane, revision, cols, rows, ansi }`: a tela visível (`pane.read source=visible format=ansi`) |
| `status` | `{ pane, agentStatus }`: `idle`, `working`, `blocked`, `done` ou `unknown` |
| `exited` | `{ pane }`: o pane saiu ou fechou; o servidor para de lê-lo |
| `error` | `{ pane?, message, code }`; `code` de `STREAM_ERRORS` (`pane_unknown`, `read_failed`, `subscription_failed`, `session_down`…) |

- **Assinatura única:** um socket `events.subscribe` por sessão do herdr para todos os clientes (`pane.exited`,
  `pane.closed`, `pane.updated`, `layout.updated` e `pane.agent_status_changed` por pane). Pane novo refaz a assinatura
  (abre a nova antes de fechar a velha); o último cliente saindo a fecha.
- **Coalescência e teto:** por pane, um leitor relê no máximo a cada `FRAME_INTERVAL_MS` (100 ms, ~10 quadros/s), e
  só manda `frame` quando a tela ou a grade mudou. Aviso do herdr ou entrada direta volta o ritmo ao máximo; sem
  mudança, o intervalo dobra até `IDLE_POLL_MAX_MS` (1 s). Medido com 10 panes: parados, 0 quadros/s e 10 `pane.read`/s;
  escrevendo ~50 linhas/s cada, 90 quadros/s e 90 `pane.read`/s, uma assinatura, 0,5–1,3% de CPU.
- **`revision`:** cresce sempre e é ancorada no relógio; não volta atrás quando o pane é solto e vigiado de novo nem num
  restart do painel.
- **Reconexão:** `retry: 3000`. O `EventSource` que religa recebe na hora o quadro e o estado guardados, sem esperar
  mudança. Assinatura recusada ou caída → `error` sem `pane` e o fluxo fecha; o `EventSource` religa e tenta de novo.
- **Cliente lento:** acima de 2 MiB na fila do cliente o quadro intermediário é descartado; o mais novo de cada pane
  sai quando a fila esvazia.
- **Queda para polling:** sem fluxo (erro persistente, sessão fora), o cliente lê `GET /api/herdr/read` como antes.

**`POST /api/herdr/input`** `{ session, pane, text?, keys?: string[] }` → `{ ok: true }` sobre `pane.send_input` (o
herdr manda o texto e depois as teclas). Mesma autenticação, token e aviso de acesso remoto do `/api/herdr/act`; o
texto nunca vai a log nem a notificação (`panel-herdr.log`: hora, `acao=input`, alvo). `text` até `MAX_TEXT`, até
`MAX_KEYS` teclas da lista fechada `KEYS`; tecla fora dela, corpo vazio ou pane fora da listagem → 400. A entrada acorda
o leitor do pane, e o eco aparece no próximo quadro.

Teclas aceitas (nome da tela → nome do herdr): Enter, Escape, Ctrl+C (`C-c`), Tab, Up, Down, Left, Right, y, n,
Backspace, Shift+Tab (`shift+tab`), Ctrl+A..Ctrl+Z (`ctrl+a`..`ctrl+z`). Home, End, PageUp, PageDown e Delete ficam
fora até o herdr ter esses nomes.

**Armadilhas medidas (herdr 0.8.2):**
- O herdr não deixa assinar mudança de saída: `pane_output_changed` existe no enum de eventos, mas `events.subscribe`
  o recusa (`unknown variant`) e `events.wait` também. `pane.updated` só dispara com título ou info do pane, e a
  `revision` do `pane.read` vem sempre 0. Por isso o leitor relê sozinho; quando o herdr assinar saída, o aviso só
  passa a acordar o leitor.
- A API de socket (o `socket_path` da `session list`) responde uma requisição por conexão; `events.subscribe` segura a
  conexão e repete o histórico recente ao abrir (o tratamento é idempotente).
- `pane.agent_status_changed` exige `pane_id`; `pane.updated` não traz a mudança de estado do agente.
- Home, End, PageUp, PageDown e Delete respondem `invalid_key` em qualquer grafia; mandar a sequência de escape como
  `text` não serve, porque o herdr embrulha o texto em colagem entre colchetes quando o programa ligou esse modo.
- As colunas do PTY não vêm em nenhuma resposta: `cols` é a largura do pane no layout (`pane.layout`/`layout.updated`),
  `rows` é `scroll.viewport_rows`.

Prova: `loop/test/ts/herdr-stream.test.ts` (herdr falso por socket: assinatura única, rajada dentro do teto, último
cliente fecha, pane fora da listagem, reconexão, saída, assinatura recusada, entrada com tecla nova/desconhecida e
texto fora do log e do aviso).

## Peças ligadas na página

Peças do canvas que já tinham lib e teste e agora chegam ao motor (`canvas-engine.tsx`), à página (`pages/argos.tsx`), à
paleta (`Ctrl+K`) e ao menu do fundo (`commands-canvas.tsx`). Tudo aditivo: sem usar, a página se comporta como antes.

| Peça | Como usar | Onde mora |
|---|---|---|
| Encaixe magnético | Segure `Ctrl` (ou `Cmd`) ao arrastar: o nó encaixa nas paredes e vãos dos vizinhos, com as guias desenhadas. `Shift+M` (**Ligar o encaixe magnético**) deixa ligado sem a tecla; a preferência fica em `hades.argos.snap`. Sem guia acesa, vale a grade de sempre | `canvas-snap.ts` (`snapSelectionMove`) no mapa de libs; porta `snap` do motor (`enabled`, `move`) |
| Elevar e acoplar | Duplo clique no **cabeçalho** do nó o eleva ao painel central (de novo, baixa). Arrastar um nó só até a faixa da borda esquerda ou direita (`DOCK_LIMITS.edgeZone`, desenhada durante o arrasto) o acopla numa coluna fixa. Os botões **Soltar** e **Baixar** da camada desfazem; os comandos `e`, `[`, `]` e `Shift+E` fazem o mesmo pelo teclado | `canvas-dock.ts`; porta `dock` do motor (`toggleElevated`, `edgeAt`, `edgeZone`, `dock`); `DockLayer` em `parts.tsx` |
| Canvas por worktree ou rodada | Seletor **Canvas aberto** na barra do card (vista Canvas): canvas padrão, uma entrada por worktree de agente do grafo e **Rodada…** (pede a chave). Também pelos comandos **Abrir o canvas de uma worktree ou rodada** e **Voltar ao canvas padrão**. A primeira abertura cria o canvas pelo `POST /api/canvases/_scope`; a gravação passa a ir para o canvas aberto | `src/panel/canvas.ts`; `canvasUrl(id)` na página |
| Filtros salvos | Comandos do grupo **Filtros**: salvar os chips atuais com um nome, aplicar, apagar e marcar o padrão (ou **Nenhum**). O padrão é aplicado ao abrir só quando o link não traz filtro e os chips estão vazios | `GET/PUT /api/canvases/_filters`; `canvas-saved-filters.ts` no mapa de libs |
| `preset` no link | O filtro de estado vai ao endereço (`#/argos?preset=attention&v=1`) quando não é o padrão (`active`); Voltar e Avançar o restauram. Valores: `active`, `attention`, `stalled`, `done`, `all`, `working`, `idle` | `canvas-urlstate.ts` (`URLSTATE_PRESETS`) |
| Toque longo | No celular, segurar o dedo parado num nó (ou no fundo) abre o mesmo menu de contexto do clique direito | `canvas-touch.ts` (`createTouchRecognizer`, evento `longpress`); `CanvasPane` em `parts.tsx` |
| Esboço de unidade | Comando **Novo esboço de unidade** (grupo **Criar**): escolha projeto ou skill, o nome curto (e a branch, se projeto). O nó `unit-sketch` nasce no centro da tela, selecionado, e mostra os comandos `hades agent new`/`skill-new` e `start-cmd` com o botão de copiar. Nada é executado: o dono cola e roda | `canvas-create.ts` (`designUnit`); tipo `unit-sketch` em `types-user.tsx` |

**Armadilhas**

- A chave de worktree é `<registro>:<nome do agente>`: o campo `worktree` do grafo é caminho absoluto e não vai para nome
  nem log. O grafo não traz id de rodada, por isso **Rodada…** pede a chave em texto.
- Trocar de canvas grava o atual antes; se a gravação pendente falha, a troca é recusada (`canvas_switch_unsaved`), senão
  ela iria para o canvas novo.
- Filtros salvos com revisão velha (`saved_filters_stale_revision`, outra aba gravou antes): a página relê o conjunto e
  avisa; o dono repete a ação sobre o conjunto atual.
- O toque longo não usa os gestos das camadas: pan e pinça já são do motor. Com dedo na tela, o `contextmenu` que o
  navegador manda é ignorado (o menu já veio do toque longo). O tique de 100 ms só roda com dedo na tela e para na
  desmontagem.
- O canvas não encolhe sob as colunas acopladas: a camada fica por cima.

Prova: `loop/test/ts/argos-ui.test.ts` ("peças ligadas: comandos de filtros, escopo e esboço" e "peças ligadas na página")
e `loop/test/ts/canvas-urlstate-preset.test.ts`.

## Nó de agente como terminal

O nó `agent` cujo pane do herdr é conhecido desenha o terminal ao vivo (`NodeTty`, §Terminal do nó (renderização)); as
vistas **Conversa** e **Arquivos** ficam nos botões do cabeçalho do nó. Sem pane conhecido, o nó segue com o desenho de
antes. O código mora no fim de `kit/panel/ui/argos/node-terminal.tsx` (`AgentTtyNode`, `createTtyHost` e a regra pura) e é
ligado em `pages/argos.tsx`; as vistas Conversa/Arquivos são `ArgosTypesLive.agentView`.

**Qual pane.** Com nó de agente no canvas, a página lê `GET /api/herdr` a cada 15 s (`TTY_TARGETS_MS`) e casa o agente
pelo nome do pane (`name` ou `hades.name`) ou pela pasta (`fcwd`/`cwd` igual à `worktree` do grafo). Vale só a sessão que
essa visão lê (a padrão do herdr): agente em outra sessão fica com o desenho de antes. Visão indisponível: os alvos de antes
continuam.

**Uma conexão por página.** O host abre um `EventSource` em `GET /api/herdr/stream` (§Fluxo do terminal (servidor)) com os
panes dos nós **montados**, isto é, no detalhe completo e visíveis (a camada HTML só monta esses). A lista muda com
debounce de 250 ms e a conexão é refeita; sem nó montado, ela fecha. Acima de 12 panes (o teto do servidor), os demais leem
por polling. Conexão recusada (`readyState` fechado) ou três erros seguidos sem mensagem: todos os nós caem no polling de
`GET /api/herdr/read` (texto sem cor, as últimas 40 linhas), e o fluxo é tentado de novo depois de 60 s ou quando a lista
de panes muda. A entrada vai por `POST /api/herdr/input` `{ session, pane, text?, keys? }`, em fila por pane (um envio
por vez, textos seguidos juntos, até 200 itens na fila); recusa do servidor aparece no nó.

**Foco e teclado.** Clicar no corpo do terminal dá o teclado a ele (`data-tty-focused="true"`). Com o foco no terminal,
toda tecla é dele, Esc inclusive, e os atalhos do canvas não disparam, salvo os comandos `tty:*` (as teclas de
`TTY_GLOBAL_KEYS`, que o `NodeTty` não consome). O teclado volta ao canvas com clique fora do terminal, `Ctrl+]` ou ao
trocar para Conversa/Arquivos.

| Comando | Atalho | O quê |
|---|---|---|
| `tty:attention-next` | `Ctrl+Shift+A` | Próximo terminal que espera por você (ordem do id, dá a volta); leva a câmera até ele |
| `tty:jump-1` … `tty:jump-9` | `Alt+1` … `Alt+9` | Foca o terminal com esse número (segure `Alt` para ver os números) |
| `tty:release` | `Ctrl+]` | Devolve o teclado ao canvas (só com um terminal focado) |

`Ctrl+Shift+A` passou a ser do terminal; **Selecionar o filtrado** (`batch:select-filtered`) foi para `Ctrl+Alt+A`. O
`Alt+<n>` é lido pelo `code` da tecla (`Digit1`…), porque com `Alt` o layout troca o caractere.

**Atenção e salto.** O cabeçalho do nó mostra o número de salto (só com `Alt` segurado), o nome, o estado e o ponto
vermelho de atenção. O ponto acende quando o evento `status` diz `idle` ou `blocked` e o nó não está focado; focar apaga,
e ele só volta quando o agente sai desses estados e entra de novo. Sem fluxo, vale o estado do grafo. Os números de salto
vão de 1 a 9 nos nós montados, na ordem de leitura (de cima para baixo, da esquerda para a direita).

**Tamanho e zoom.** O mínimo do nó é `minSize(frame)` do `NodeTty` (cabeçalho e ~20×6 células) mais o cabeçalho do canvas e
o do nó; a alça de redimensionar não encolhe abaixo dele (`canvasApi.setMinSize`, encaixando na grade). Nó já menor que o
mínimo mostra só o cabeçalho e o botão **Ampliar para o terminal** (um passo do desfazer). Redimensionar muda a escala do
quadro (`fitScale`), nunca o PTY. Com o zoom do canvas em que o texto ficaria abaixo de 45% do tamanho natural, o nó desenha
só o cabeçalho, sem converter o quadro.

**Armadilhas**

- O herdr 0.8.2 recusa (`invalid_key`, 400) Home, End, PageUp, PageDown e Delete: o nó as filtra antes do envio
  (`filterTtyInput`), e elas ficam desligadas até o herdr aceitar.
- Sem cursor no quadro: o herdr não o entrega na leitura usada.
- O ouvinte de teclado da página é de captura: ele roda antes do terminal, por isso confere se o alvo está dentro de
  `[data-tty-focused="true"]` antes de resolver o atalho.

Prova: `loop/test/ts/argos-ui.test.ts` ("nó de agente como terminal").

## Terminais criados no canvas

Servidor dos terminais que o canvas cria: abre um pane do herdr com um agente, fecha, troca o papel reiniciando só o
processo, e guarda papéis e predefinições. A UI (ferramenta Terminal, modal, tela de papéis) consome só estas rotas. Código:
`src/panel/argos-terminals.ts` (rotas, registro dos terminais, herdr), `src/lib/argos-roles.ts` (papel, validação comum,
descoberta) e `src/lib/argos-presets.ts` (predefinições).

### Dados

| O quê | Onde | Formato |
|---|---|---|
| Papel | `$D/argos/roles/<slug>.json` | `role.json` portátil: `{ name, color, instructions, agent?, model?, effort? }`, sem o slug dentro |
| Predefinição | `$D/argos/presets.json` | `{ presets: [{ name, agent, model?, effort?, icon?, color?, theme?, font?, role?, slug }] }` |
| Terminais criados | `$D/argos/terminals.json` | `{ terminals: [{ session, pane, name, agent, model?, effort?, role?, cwd, createdAt }] }` (UTC) |

- **Slug** sai do nome: minúsculas sem acento, `a-z0-9-`, até 48; colisão ganha `-2`, `-3`. Atualizar mantém o slug.
- **Validação:** nome de 1 a 60 sem quebra de linha; `color` `#rgb`/`#rrggbb` (gravada em minúsculas); `agent` da lista
  fechada `AGENT_KINDS` (`claude`, `codex`, `gemini`); `effort` em `low|medium|high|xhigh|max`; instruções até 20 000;
  `theme` é identificador de até 32; `icon` até 32 e `font` até 64. Tetos: 200 papéis, 100 predefinições, 64 terminais.
- `presets.json` ou `terminals.json` ilegível é erro alto (500 genérico, detalhe no log), nunca lista vazia que a próxima
  gravação apagaria. Papel ilegível na pasta é pulado na lista e registrado.

### Rotas

Erro: `{ error, code }` com `code` `invalid` (400), `not-found` (404), `confirm-required` (403), `herdr-failed` (502) ou
`rate-limited` (429, com `Retry-After` em segundos); falha do herdr leva mensagem genérica e o detalhe só no log.

| Rota | Corpo | Resposta |
|---|---|---|
| `GET /api/argos/presets` | — | `{ presets }` |
| `POST /api/argos/presets` | `{ preset, slug? }` (com slug atualiza) | `{ preset }` |
| `POST /api/argos/presets/delete` | `{ slug }` | `{ ok: true }` |
| `GET /api/argos/roles` | — | `{ roles }` |
| `POST /api/argos/roles` | `{ role, slug? }` | `{ role }` |
| `POST /api/argos/roles/delete` | `{ slug, confirm }` (`confirm === slug`, senão `confirm-required`) | `{ ok: true }` |
| `POST /api/argos/roles/discover` | `{ cwd }` | `{ found: [{ path, slug, role, exists }] }` |
| `POST /api/argos/roles/import` | `{ paths }` (só caminhos que o discover devolveu) | `{ imported, skipped: [{ path, reason }] }` |
| `POST /api/argos/terminals` | `{ name, cwd?, preset?, agent?, model?, effort?, role?, confirm? }` | `{ herdr: { session, pane }, agent, model?, effort?, role? }` |
| `POST /api/argos/terminals/close` | `{ session, pane, name, confirm? }` | `{ ok: true }` |
| `POST /api/argos/terminals/role` | `{ session, pane, name, role: slug \| null, confirm? }` | `{ herdr: { session, pane } }` |

- **Acesso remoto (D1):** as três rotas de terminal exigem `confirm === name`, conferido antes de ler qualquer recurso,
  senão `403 confirm-required`; com ele, executam e mandam o aviso ao dono (`notify.sh send herdr warn`, só ação e nome),
  como o `/api/herdr/session`. Local, só o token do painel. Papéis e predefinições não pedem confirmação pelo túnel, salvo
  o apagar papel, que sempre pede.
- **Limite de taxa:** criar e fechar terminal aceitam até 10 tentativas por minuto cada (`TERMINAL_RATE`), por origem
  (local e remoto contam à parte), em janela deslizante; a tentativa recusada por validação também conta. Acima disso,
  `429 rate-limited` com `Retry-After` até a mais antiga sair da janela, conferido antes do `confirm` e sem tocar no
  herdr. Papéis, predefinições e trocar papel ficam fora do limite.
- **Escolha (D4):** campo mandado vence; ausente segue a predefinição, depois o papel, depois o padrão global (agente
  `claude`, modelo e esforço da própria CLI). A resposta devolve só o que ficou escolhido.
- **Diretório:** `cwd` ausente é o clone do projeto (`W` do `env.sh`); mandado, é resolvido (links seguidos) e tem de ficar
  dentro do clone ou da worktree de um agente registrado e não encerrado (as worktrees que o canvas abre por escopo).
  Fora, `..` que escapa ou link para fora: `invalid`.
- **Criar:** `herdr workspace create --cwd <cwd> --label <nome> --no-focus` e `herdr agent start <nome> --kind <agente>
  --pane <pane> --timeout 55000 -- [--model] [--effort] [--append-system-prompt-file <arquivo>]` (a mesma via do
  `hades agent`). O papel (com as instruções próprias e as de gerente) é gravado antes em
  `$D/argos/terminal-prompts/<sessão>-<pane>.md` (pasta 700, arquivo 600, troca atômica); só o caminho viaja. Flag que o agente não aceita (papel em `codex`) é `invalid` antes de abrir pane. Se o `agent start`
  falha, o pane é fechado e nada fica registrado. Nome repetido de terminal vivo é `invalid`; entrada de pane que já
  sumiu do herdr sai do registro na criação seguinte.
- **Fechar e trocar papel** só valem para o par `session`/`pane` que o canvas criou e com o mesmo nome; o resto é
  `not-found`. Fechar um pane que já sumiu só limpa o registro. Trocar papel manda SIGTERM aos processos do primeiro
  plano do pane que não são o shell, espera até 5 s que saiam (`herdr-failed` se não saem) e sobe o agente de novo no
  mesmo pane, com o agente, o modelo e o esforço do registro e o papel novo (`null` tira o papel). O arquivo do papel é
  regravado na troca, e apagado ao tirar o papel, ao fechar o terminal, quando o `agent start` falha e quando a entrada
  de um pane que sumiu sai do registro.
- **Recusa antes do herdr:** nenhum argumento depois do `--` pode ter quebra de linha ou byte nulo. Se algum tiver, a
  rota responde 400 `unsafe-argument` (mensagem própria), sem abrir pane. Agente sem flag de arquivo (`AGENT_KINDS`
  só com `systemPrompt`) aceita papel de uma linha pelo argumento; de várias linhas é recusado, nunca achatado.
- **Descoberta:** `role.json` no `cwd` (contido como acima) e até 3 níveis abaixo; não segue link simbólico, pula pastas
  ocultas, `node_modules`, `vendor`, `target`, `dist` e `build`; tetos de 2000 pastas e 100 achados; arquivo inválido ou
  acima de 64 KiB é pulado e registrado. `slug` é o que o nome daria e `exists` diz se esse slug já existe.
- **Importação:** só caminhos devolvidos pela descoberta nos últimos 15 min (`not-discovered`); o arquivo é relido e
  revalidado (`invalid`, também se a pasta virou link para fora); slug que já existe é pulado (`exists`), nunca sobrescrito.
- **Sigilo:** o texto do papel nunca vai a log nem ao aviso; o log (`terminal do canvas`) leva ação, nome, pane e origem.

**Armadilhas**

- O `herdr agent start` exige o pane parado no prompt do shell: por isso a troca de papel espera o processo antigo sair
  antes de subir o novo. Não medido num herdr de verdade: se o herdr guardar o nome do agente depois que o processo sai,
  o segundo `agent start` com o mesmo nome pode ser recusado (`herdr-failed`).
- O herdr 0.8.2 recusa (`invalid_agent_argument`, "agent arguments cannot be encoded safely for the target shell")
  qualquer argumento depois do `--` com quebra de linha; aspas, crase, `$`, acentos e apóstrofo passam. Por isso o papel
  vai por arquivo (`--append-system-prompt-file`): o texto não aparece na lista de processos (só o caminho), mas o
  arquivo fica em `$D/argos/terminal-prompts/` (600) enquanto o terminal existir. Medido: com o caminho do arquivo o
  `agent start` sobe o Claude (`argv: claude --append-system-prompt-file <caminho>`).
- O registro de terminais é deste painel: pane criado por fora (`hades agent`, herdr à mão) não se fecha por estas rotas.

Prova: `loop/test/ts/argos-terminals.test.ts` (herdr falso), `argos-roles.test.ts` e `argos-presets.test.ts`.
## Compositor

Prompt para o terminal em foco sem digitar dentro dele (`kit/panel/ui/argos/canvas-composer.tsx`, modelo em
`src/lib/canvas-compose.ts`, rotas em `src/panel/canvas-files.ts`). Não mexe no documento do canvas: nada entra na pilha
de desfazer.

**Abrir e seguir.** `mod+alt+p` (Ctrl+Alt+P, ⌘⌥P no macOS) com um terminal em foco abre e fecha (comando `tty:composer`,
que passa mesmo com o teclado no terminal: o `NodeTty` não consome Ctrl+Shift+<letra>). Ele flutua sobre a parte de baixo
do terminal (`placeComposer`, sempre dentro da tela) e, aberto, segue o foco (`followTarget`: terminal novo com foco vira o
alvo; sem foco em terminal, fica no que estava). `CanvasComposerLayer` recebe o `canvasApi` e o retângulo do nó no mundo e
acompanha pan e zoom pelo `onFrame`.

**Teclas.**

| Tecla | Efeito |
|---|---|
| Return | envia (texto e Enter pelo `ttyHost.input`) e limpa o rascunho; com pílula sob o cursor, abre a pílula |
| Shift+Return | quebra a linha |
| Esc | fecha o menu aberto; sem menu, fecha o compositor guardando o rascunho |
| ↑ ↓, Return, Tab no menu | escolhem a opção |
| Backspace/Delete encostado na pílula | apaga a pílula inteira |
| campo vazio: setas, Return, Tab, Shift+Tab | vão direto ao terminal (responder aprovação sem fechar) |
| campo vazio: `/` | vai ao terminal e o teclado passa a ele (comandos de barra da CLI) |

Texto de várias linhas vai em colagem com envelope (`ESC[200~ … ESC[201~`) e Enter no fim: sem ele, cada `\n` chegaria
à CLI como Enter.

**Menções `@`.** `@` no começo ou depois de espaço abre o menu (`mentionAt`, `mentionOptions`), filtrado sem acento nem
caixa, nesta ordem: terminais ligados por aresta a este (`connectedIds`; entra `@<nome>`), notas (entra `@<id>`, que no
envio vira o texto da nota, a regra do `composeMessage`), **Arquivo…** (vira `@#` e abre o seletor), `@orquestrador` (só
com o papel ligado no terminal) e `@Nova nota`. Menção a terminal, `@orquestrador` e `@Nova nota` vão como texto; o
comportamento deles é da onda 2. `@@` envia um `@`.

**`#` e o seletor de arquivos.** `@#` no início da menção abre o seletor do diretório de trabalho do terminal; o texto depois
do `#` busca pelo nome, vazio lista a pasta. Pasta escolhida entra nela (`..` volta); arquivo escolhido troca a menção pelo
caminho relativo. Fora de menção, `#` é texto comum.

```
GET /api/argos/terminal-files?session=<s>&pane=<p>[&path=<relativo>][&q=<busca>]
→ { path, query, entries: [{ path, name, type: "dir"|"file" }], truncated }
```

A raiz é o diretório do processo em primeiro plano do pane (senão o do pane), lido no retrato atual do herdr
(`paneCwdOf`), nunca da tela. O caminho pedido passa por `parseRelPath` (sem `..`, absoluto, NUL ou `\`) e o caminho real
tem de ficar dentro da raiz; link simbólico para fora some da listagem e, pedido como pasta, responde 404
`files_path_not_found`. A busca é em largura, não segue link para pasta e não desce em pastas ocultas, `node_modules`, `dist`, `build`, `target` nem `vendor`. Ela lê as pastas sem segurar o laço de eventos do
painel, e a busca nova de um terminal encerra a anterior dele (que volta com `truncated`). Nenhum conteúdo de arquivo é lido.

**Anexos.** Colar uma captura, arrastar e soltar, ou o botão de clipe: o arquivo vai a
`POST /api/argos/compose/attachment` (`{ name, type, data }` em base64), é gravado em `$D/canvas-compose/<AAAA-MM-DD>-<aleatório>.<ext>`
e o caminho absoluto entra no cursor. Imagem e os outros tipos entram do mesmo jeito, como caminho. O nome vindo do navegador
nunca entra no caminho; o log registra só tipo, tamanho e se foi remoto.

**Colagens grandes.** Mais de 800 caracteres ou mais de 2 linhas (`isLargePaste`) viram a pílula
`⟦colagem N · L linhas⟧`; o conteúdo fica no mapa `pastes` do rascunho e vai sem alteração, na posição da pílula. Clicar
nela, ou Return com ela sob o cursor, abre para edição (`expandPill`). Como o número vive no texto do marcador e o conteúdo
só sai no envio, recortar, colar e desfazer não perdem a numeração; colagem nova pega o maior número usado mais um.

**Rascunho.** Um por terminal (`ComposerDrafts`, pelo id do nó), guardado pela página: Esc e a troca de canvas preservam
texto e pílulas; só o envio limpa (e só se o rascunho não mudou durante o envio).

**Limites e códigos.**

| Limite | Valor |
|---|---|
| rascunhos guardados | 200 |
| pílulas por rascunho / tamanho de cada | 50 / 20 000 caracteres |
| mensagem final | 19 980 caracteres (teto de 20 000 do `POST /api/herdr/input` menos o envelope) |
| seletor: entradas / profundidade da busca / pastas e entradas olhadas | 200 / 8 / 20 000 e 100 000 |
| anexo / retenção | 8 MiB, tipos png, jpg, gif, webp, pdf, txt, md, csv, json / 7 dias e 500 arquivos (a gravação poda) |

Códigos do modelo: `COMPOSER_ERRORS` (`composer_invalid_terminal`, `composer_too_many_pastes`, `composer_paste_too_long`)
ao lado dos `COMPOSE_ERRORS`. Das rotas: `FILES_ERRORS` (`files_invalid_target`, `files_unknown_pane`, `files_no_cwd`,
`files_invalid_path`, `files_path_not_found`, `files_not_directory`, `files_invalid_query`, `attachment_invalid`,
`attachment_type` 415, `attachment_too_large` 413, `attachment_failed` 500), com mensagem fixa e sem caminho.

Prova: `loop/test/ts/canvas-compose.test.ts` ("compositor"), `loop/test/ts/canvas-files-route.test.ts`,
`loop/test/ts/argos-ui.test.ts` ("compositor flutuante").
## Notas

A nota do canvas é um arquivo Markdown de verdade, que o dono e os agentes leem e escrevem. O nó `note` guarda só o nome
(§Notas e texto livre); bloqueio, nome fixado e local do arquivo moram num índice do servidor, nunca no documento do canvas,
então nada disso entra no desfazer. Peças: `src/lib/canvas-note.ts` (regra pura), `src/panel/canvas-notes.ts` (rotas),
`kit/panel/ui/argos/node-note.tsx` (`window.ArgosNodeNote`: corpo, cabeçalho e menu) e o cliente em `types-user.tsx`
(`createNoteClient`).

**Modos.** *Raw* é o `<textarea>` sobre o Markdown; *Formatada* passa o texto pelo `marked` de `vendor/`. A nota vazia abre
em Raw, a que tem texto abre Formatada, e a escolha fica lembrada por nota enquanto a página estiver aberta (`rememberMode`),
fora do documento. Na Formatada, HTML cru do texto sai escapado; link só `http(s)`, `mailto` ou âncora; imagem só `https`
ou da pasta da própria nota. Grava sozinha 1,2 s depois da última tecla e relê o arquivo a cada 4 s enquanto está na tela
com a aba visível, para o texto que um agente escreveu aparecer.

**Cabeçalho.** O nome é o fixado pelo dono ou, sem ele, a primeira linha com conteúdo sem as marcas de Markdown
(`noteTitle`). Duplo clique renomeia; nome vazio volta ao automático. O cadeado indica nota bloqueada: o conteúdo não
muda (PUT e imagem respondem `423 note_locked`), mas o agente ligado continua lendo.

**Tabelas.** Cada tabela é marcada (`data-note-table`). "Copiar como tabela" põe HTML, RTF e TSV na área de transferência
de uma vez, para colar em planilha ou editor de texto; há também "Copiar Markdown" e "Copiar célula".

**Diagramas (mermaid sob demanda).** `vendor/mermaid.js` (mermaid 12.2.0, MIT; ~5,5 MB, ~1,6 MB com gzip) entra por um
único `<script>`, só quando uma nota Formatada tem um bloco ` ```mermaid ` fechado. Bloco ainda aberto mostra o código, sem
desenhar. O tema segue o do painel. Cada diagrama tem o botão "Copiar" (código) no hover e, no menu, "Copiar como imagem"
(PNG em 2x). Rótulos saem em SVG puro, sem `foreignObject`, porque isso impediria copiar como imagem. O service worker não
pré-carrega o mermaid: ele entra no cache de `/ui/*` só quando a primeira nota com diagrama abre.

**Imagem colada.** Colar uma imagem no corpo envia os bytes em base64 (`POST …/images`); o tipo vem dos bytes (PNG, JPEG,
GIF, WebP; SVG é recusado). O arquivo é `<hash16>.<ext>` em `<pasta do arquivo>/<nome do arquivo>.assets/`, e o texto ganha
`![imagem](<nome>.assets/<arquivo>)`, o mesmo caminho relativo que um agente lendo o `.md` resolve. Tetos: 5 MiB por
imagem, 200 por nota.

**Ferramenta Nota, arrastar de fora e fechar** (a página monta; regras em `canvas-note.ts`):

- `createNoteFromRect(doc, { id, rect, token })` → `{ op, node, note }`: retângulo menor que 160×100 nasce no tamanho
  padrão; o arquivo nasce na primeira gravação.
- `noteDropPaths(uriList)` → caminhos locais `.md/.markdown/.txt` de `text/uri-list`; cada um vira `POST /link` e um nó.
  A nota aponta para o arquivo, sem movê-lo.
- `closeNotePlan(doc, id)` → `{ op, note }`: o `delete` do nó e o nome que a página manda apagar.

**Onde ficam os arquivos.** Na pasta padrão `$D/canvas-notes/<nome>.md`, com as imagens em `<nome>.assets/`. "Mover para…"
leva arquivo e imagens para um caminho absoluto (extensão `.md`, `.markdown` ou `.txt`), reescreve as referências
`](<base>.assets/` se o nome do arquivo mudou e grava o local no índice `$D/canvas-notes/.index.json`
(`{ v: 1, notes: { <nome>: { path?, locked?, title? } } }`, criado na primeira ação que precisa dele). A pasta de destino
(caminho real, sem link simbólico para fora) precisa estar dentro de uma das raízes (padrão: a pasta pessoal) e nunca
dentro da pasta padrão. O caminho guardado é conferido de novo a cada uso.

**O que fechar apaga.** Fechar a nota apaga de verdade o arquivo e as imagens da pasta padrão. Desfazer devolve o nó, não o
arquivo. Nota em local personalizado ou apontada de fora: o arquivo fica onde está, e só a entrada do índice sai.

**Rotas** (mesma autorização do resto do painel; corpo JSON):

| Rota | Faz | Recusa |
|---|---|---|
| `GET /api/canvas-notes?limit=&after=` | `{ notes: [{ name, title, titleFixed, locked, location, path, exists, bytes, updatedAt }], next }`, por nome; `limit` 1–200 (padrão 50) | acima do teto, ou `after` inválido: `400 note_invalid_query` |
| `GET /api/canvas-notes/<n>` | o de antes, mais `locked, title, location, path, base` | |
| `GET /api/canvas-notes/<n>/assets/<hash16>.<ext>` | a imagem, com o tipo dos bytes, `nosniff` e cache imutável | nome fora do formato: `400`; conteúdo que não é imagem: `404` |
| `POST …/<n>/lock` `{ locked }` | bloqueia ou desbloqueia | |
| `POST …/<n>/rename` `{ title }` | fixa o nome (`null` ou vazio volta ao automático) | `400 note_invalid_title` |
| `POST …/<n>/move` `{ to: caminho \| null }` | move; `null` volta para a pasta padrão | remoto: `403 note_local_only`; caminho: `400 note_invalid_path`; destino ocupado: `409 note_exists` |
| `POST …/<n>/images` `{ data }` | grava a imagem e devolve `{ file, markdown }` | `400 note_invalid_image`, `413`, `409 note_too_many_images`, `423` |
| `POST …/<n>/delete` | `{ deleted }` (o arquivo saiu?) | |
| `POST /api/canvas-notes/link` `{ path }` | `{ name, created }`; o mesmo arquivo devolve a mesma nota | remoto: `403 note_local_only`; não existe: `404` |

Os códigos novos se somam a `NOTE_ROUTE_ERRORS`. Mover e apontar são só locais porque mexem em caminhos da máquina do
painel. Toda ação registra no log `nota alterada` (ação, nota, remoto).

Provas: `loop/test/ts/canvas-note.test.ts` ("nota de verdade"), `loop/test/ts/canvas-notes-route.test.ts` ("ações da
nota de verdade"), `loop/test/ts/argos-ui.test.ts` ("nota do canvas: node-note").

## Conexões

Conexão é a aresta `link` do documento do canvas, desenhada pelo dono entre dois nós. Regras puras em
`src/lib/canvas-links.ts` (no pacote do modelo como `CanvasModel.links`), desenho e gestos no motor (`canvas-engine.tsx`),
popover em `kit/panel/ui/argos/canvas-links.tsx` (`window.ArgosLinks`).

**O que a conexão significa, por par de nós.** A conexão não tem sentido (a↔b é uma só, e o par repetido é recusado).

| Par | Significado (`linkMeaning`) | O que dá |
|---|---|---|
| terminal ↔ nota | `note-access` | o agente do terminal lê e escreve a nota pela CLI do painel |
| nota ↔ nota | `chain` | nota encadeada: quem lê a nota de entrada percorre a cadeia |
| terminal ↔ terminal | — | recusado (`links_no_reader`): nesta versão não há leitor dessa conexão |
| outro tipo de nó | — | recusado (`links_no_reader`) |

Terminal é o nó `agent` ou o nó `terminal` (o que a ferramenta Terminal da barra cria); nota é o nó `note`. Os códigos
de erro (`LINK_ERRORS`, prefixo `links_`) só ganham valores; o texto ao dono sai de `LINK_ERROR_TEXT`.

**Forma no documento (aditiva).** `CanvasEdge` ganhou dois campos opcionais, aceitos só quando `kind` é `link`:
`style` (`rope` ou `circuit`; ausente vale `rope`, e corda não é gravada) e `clamps` (`[{ id, t }]`, `t` em (0, 1), ids
únicos na aresta, no máximo `CANVAS_LIMITS.edgeClamps` = 8; lista vazia não existe, o campo some). Documento antigo abre
igual; `style`/`clamps` em outra aresta, estilo desconhecido ou `t` fora do intervalo são `canvas_invalid_edge`.

**Estilos.**

- **Corda** (padrão): cabo com folga e física leve (Verlet, `ROPE`), de borda a borda dos nós. Só anda a corda à vista e só
  enquanto balança: parada, o motor não pede quadro; fora do viewport não anda e, ao voltar, assume a forma de repouso.
  Com movimento reduzido, vai direto ao repouso.
- **Assentar das cordas.** A corda anda em passos fixos de `ROPE.step` (1/60 s) com acumulador (`advanceRope`): o tempo do
  quadro (limitado a `ROPE.maxDt`) vira zero ou mais passos, e o resto fica na corda. Passo variável no Verlet injeta
  energia (medido: com `dt` entre 8 e 33 ms a corda de pontas paradas seguia com deslocamento de ~2,4 por passo depois de
  1500 passos, e alternando 60/30 Hz nunca dormia). Dorme quando o deslocamento médio dos últimos `ROPE.sleepWindow`
  passos fica abaixo de `ROPE.sleep` (`ropeEnergy`; corda nova não dorme antes da janela encher), e então `ropesAwake`
  fica falso e o motor não pede quadro. Perto do repouso o amortecimento sobe (`ROPE.restDamping`) e a restrição de
  distância só puxa (trecho folgado não é empurrado). Pontas paradas assentam em cerca de 1 s; ponta que anda acorda a corda.
- **Circuito**: trilhos nos eixos com no máximo duas curvas de 90° arredondadas (`circuitRoute`), sem física. Para canvas
  denso.

**Abraçadeiras** (só visuais: não mudam quem está ligado a quem). Segurar Alt e arrastar um traço curto por cima das
cordas prende cada corda cruzada naquele ponto (`opClampLinks`); a corda converge na abraçadeira e se abre dos dois lados,
mantendo a física. Clicar seleciona a abraçadeira (limpa a seleção de nós), arrastar a escorrega ao longo das cordas
(`opMoveClamp`), Delete ou Backspace solta (`opReleaseClamp`). O equivalente por teclado é o botão **Soltar abraçadeira**
do popover. A abraçadeira mora em `clamps` de cada aresta presa; circuito guarda o dado mas não a desenha.

**Ferramenta Conexão (motor).** `api.startLink(from?)` arma a partir de `from` (padrão: o único selecionado, senão o nó
focado) e devolve `false` se a ponta não conecta; uma linha segue o cursor, com anel no destino que aceita. Clique (ou
Enter no nó focado) num terminal ou nota completa; Esc, clique no vazio ou botão direito cancelam (`api.cancelLink()`).
Com a conexão armada, o clique é dela até sobre o conteúdo HTML de um nó. `onLinkState(from | undefined)` avisa a página
para acender a ferramenta na barra. `FrameInfo.ropes = { visible, stepped }` diz quantas cordas estavam à vista e quantas
andaram no quadro. Sem `CanvasModel.links`, a aresta `link` sai reta como as outras e a ferramenta não arma.

**Popover** (`<ArgosLinks.LinksPopover doc nodeId at view describe onOp onJump onClose onError? />`). `doc` é o documento
salvo, não o de vista. Uma linha por conexão: destino (rótulo de `describe`, ou o id), Terminal/Nota e o significado.
Clicar na linha chama `onJump(id)` (a página centraliza e seleciona) e fecha; **Corda**/**Circuito** trocam o estilo
(`opSetLinkStyle`, apaga e recria no mesmo índice); **Soltar abraçadeira** solta; **×** remove (`opRemoveLink`) sem
fechar. Toda mudança sai como operação do desfazer em `onOp`. Diálogo: foco na primeira linha, Esc e clique fora fecham e
devolvem o foco a quem abriu; operação recusada (documento mudou por baixo) vai a `onError` com o texto do código.

**Leitor: `hades canvas note`.** Quem lê a conexão `note-access` é o agente que roda no terminal, pela CLI
(`src/commands/canvas.ts`). O nó dele se resolve pelo pane do herdr do processo (`HERDR_PANE_ID` e a sessão do socket):
o nó `terminal` pelo `data.herdr`, o nó `agent` pelo par que o grafo vivo dá. `note list` mostra as notas diretas e as
encadeadas; `note read <nota>` devolve a nota e a cadeia nota↔nota a partir dela (cada nota uma vez, sem laço; `--only`
só ela); `note write <nota> [--append] [texto]` grava só na nota ligada direto (a cadeia só se lê:
`canvas_note_write_direct_only`). O vínculo antigo da nota com um agente (`data.agent`) conta como conexão direta, na
leitura e na escrita. Sem conexão, ou nota que não existe, a recusa é a mesma (`canvas_note_no_access`,
saída 1). A escrita é conferida de novo no servidor (`as: { canvas, node, agent }` no `PUT` da nota, com o id do terminal
aceito ao lado do `agent:…`); a regra mora em `canvas-note.ts` (`directNotesOf`, `noteChainFrom`, `readableNotesOf`,
`hasNoteAccess`). Detalhes da CLI em §Orquestrador no canvas.

**Armadilhas**

- O motor monta as operações sobre o documento de vista: com um filtro escondendo arestas, o índice da troca no lugar pode
  diferir do salvo (o conteúdo fica certo, a ordem da lista pode mudar).
- Copiar e colar nós leva a aresta só com `id`/`from`/`to`/`kind`: a conexão colada perde estilo e abraçadeiras.
- Alt segurado também mostra os números de salto dos terminais; alguns gerenciadores de janela no Linux tomam Alt+arrastar.

Prova: `loop/test/ts/canvas-links.test.ts`, `canvas-engine-shape.test.ts` ("conexões fora da tela") e `argos-ui.test.ts`
("popover de conexões").

## Criar e fechar terminal pelo canvas

Nó do tipo `terminal` (`live: false`, desenho `html`): o processo é um pane do herdr que a página cria pelo servidor
(`POST /api/argos/terminals`, rotas da seção do servidor dos terminais) e o par `herdr { session, pane }` fica no `data` do
nó, junto com nome e aparência. O nó reusa o terminal do nó `agent` (fluxo, foco, atenção, salto por `Alt+<n>`, tamanho
mínimo, zoom); o alvo vem do documento (`ttyTargetsOfDoc`), não do grafo. Os três scripts novos (`canvas-toolbar`,
`terminal-create`, `terminal-roles`) carregam sob demanda na primeira vista Canvas (`loadTerminalScripts`, lista fechada
em `pages/argos.tsx`); o `index.html` não muda. Antes de carregar, os comandos avisam "ainda estão carregando".

**Ferramenta.** A barra no canto superior esquerdo do canvas (`CanvasToolbar`) tem Selecionar, as ferramentas registradas
(Terminal vem de fábrica), um botão por predefinição (início rápido) e Papéis. Com a ferramenta armada, a camada
`ToolDragLayer` desenha o retângulo do arrasto; clique (arrasto abaixo de `CLICK_PX`, 8 px) usa o tamanho padrão do tipo
(`TERMINAL_SIZE`, 640×420) centrado no ponto; `Enter` usa o centro da vista; `Esc` desarma. O retângulo nunca fica menor que
o mínimo do terminal (`rectToWorld`, com `ttyMinNodeSize`). O comando `term:tool` (paleta e menu do canvas) arma a ferramenta.

**Modal** (`TerminalDialog`, abas **Detalhes** e **Aparência**). Detalhes: predefinição, nome (até 80), papel e, na criação, agente,
modelo, esforço e diretório. Aparência: ícone (lista fechada `TERMINAL_ICONS`), cor do cabeçalho, tema (Sistema, Escuro,
Claro, Personalizado com fundo e texto) e fonte (Geist Mono, mono do sistema, Courier), com prévia. Campo não escolhido não
entra no `data` e segue o padrão global; `readTerminalData` só devolve campos válidos (o resto some, sem padrão inventado).
Criar sobe o processo e só então põe o nó (um passo do desfazer, nó selecionado e na tela); editar é `opUpdate` do `data`.
**Salvar como predefinição** (na criação) guarda agente, modelo, esforço, papel e aparência (`presetOf`).

**Predefinições e início rápido.** O botão da predefinição na barra cria o terminal no centro da vista, sem modal, com o
nome da predefinição; nome repetido ganha sufixo (` 2`, ` 3`: `nextTerminalName`), porque fechar confirma pelo nome. A
aba Predefinições da tela de papéis lista e apaga.

**Papéis** (`RolesDialog`, botão Papéis ou `term:roles`). Lista, cria e edita (nome até 60, cor, instruções até 20.000
caracteres, agente, modelo, esforço opcionais); **Descobrir** procura `role.json` num diretório (a worktree do canvas
aberto vem sugerida), mostra a prévia e importa em lote (já existentes vêm desmarcados); apagar pede o slug digitado. No
nó, `term:role` troca ou tira o papel: o servidor reinicia só o processo e devolve o par novo do herdr, gravado no nó.

**Menu do nó** (`TERMINAL_MENU`): Editar, Papel, Aparência, Conexões (escolhe a outra ponta de uma aresta e leva a câmera
até ela; o cabeçalho mostra o número de conexões) e Fechar. O alvo é o terminal com o teclado, senão o nó `terminal`
selecionado sozinho (`terminals.target()` da porta `api.terminals`, `CanvasTerminalPort`).

**Fechar** (`tty:close`, `Ctrl+Alt+W` / `⌘⌥W`, também no menu do nó e na paleta): sempre o diálogo com o nome do nó
digitado; o nome vai como `confirm` à rota, que encerra o pane e só então o nó sai do documento (`opDelete`). Desfazer
devolve só o nó, sem o processo (o nó mostra "Sem pane do herdr"). Nó sem pane só sai do documento. `Delete` segue só
editando o documento: tira o nó e deixa o processo vivo. A tecla vale com o teclado no terminal porque está em
`TTY_CANVAS_KEYS` (o `NodeTty` não a consome, e `Ctrl+W` é do navegador); a ajuda `?` a lista, como todo comando com atalho.

| Comando | Atalho | O quê |
|---|---|---|
| `term:tool` | — | Arma a ferramenta Terminal |
| `term:edit` / `term:appearance` | — | Abre o modal na aba Detalhes / Aparência |
| `term:role` | — | Troca ou tira o papel (reinicia só o processo) |
| `term:connections` | — | Vai até a outra ponta de uma conexão |
| `term:roles` | — | Abre a tela de papéis |
| `tty:close` | `Ctrl+Alt+W` | Fecha o terminal (diálogo com o nome) |

**Erros.** O cliente (`createTerminalClient`, prazo de 20 s) devolve `{ ok, code, message }` com código estável
(`TERMINAL_ERRORS`: `invalid`, `not-found`, `confirm-required`, `herdr-failed`, `rate-limited` e os do cliente
`terminal_network`, `terminal_timeout`, `terminal_bad_response`); a tela ramifica pelo código. `confirm-required` (acesso
remoto) pede o nome e repete uma vez; `rate-limited` (429) aparece como erro genérico com a mensagem do servidor.

**Ponto de extensão.** `window.ArgosCanvasToolbar.registerTool({ id, label, icon, hint?, order? })` acrescenta uma
ferramenta de retângulo (`id` `[a-z][a-z0-9-]*`; repetido ou inválido lança `tool_duplicate` / `tool_invalid`), num bloco
próprio no fim de `canvas-toolbar.tsx`; a página decide o que o retângulo solto faz numa entrada `toolRect[<id>] =
(rectTela, câmera) => …` em `pages/argos.tsx`.

**Grafo e nó `agent`.** O grafo traz, aditivos, `herdr { session, pane }` no nó `agent` quando o herdr conhece o agente
(o nó vale antes de casar por nome ou pasta), `shortId` (`<repo>/<agente>`, mostrado no seletor de canvas) e a rodada do
registro (`round`, plano aprovado com hash de 7 dígitos). Nó `agent` novo nasce com `AGENT_NODE_SIZE` (480×320, cabe ~80×24
células). O quadro desenha o cursor quando o produtor entrega `frame.cursor = { row, col, visible? }` (`cursorOf`); o
herdr 0.8.2 não o expõe, então hoje nada é desenhado.

Prova: `loop/test/ts/argos-terminal-ui.test.ts`.

## Barra e atalhos do canvas montados

O que as seções Compositor, Notas e Conexões descrevem aparece no `#/argos` por esta montagem (`pages/argos.tsx`,
`commands-canvas.tsx`, `canvas-toolbar.tsx`, `node-tty.tsx`, `index.html`). Os módulos não mudaram.

**Barra** (canto de cima à esquerda do palco): Selecionar, **Terminal** e **Nota** (ferramentas de retângulo:
`registerTool`, a nota com `order: 20`), **Conexão** (botão de ação) e, separados, os inícios rápidos e Papéis.
- Nota: o retângulo solto vira o nó `note` (`createNoteFromRect`, `toolRect.note`), um passo do desfazer, selecionado e
  aberto em modo Raw para escrever. O arquivo nasce na primeira gravação; o clique sem arrasto usa o tamanho padrão do tipo.
- Conexão é prop do `CanvasToolbar` (`link={{ active, onClick }}`), não ferramenta: `registerTool` é contrato de retângulo
  e armar mostraria a camada de arrasto. O clique arma a linha a partir do terminal focado ou do nó selecionado sozinho
  (o mesmo que `mod+l`); aceso, o clique cancela. O botão acende enquanto o motor avisa origem pelo `onLinkState`
  (repassado pelo `CanvasPane`). Armar uma ferramenta de retângulo cancela a conexão armada.

**Atalhos** (todos na paleta e na ajuda `?`; `mod` = Ctrl, ou ⌘ no Mac). Os três valem com o teclado no terminal: estão em
`TTY_CANVAS_KEYS`, que o `NodeTty` não manda ao agente.

| Comando | Atalho | O quê |
|---|---|---|
| `tty:composer` | `mod+alt+p` | Abre o compositor sobre o terminal focado; aberto, fecha. Segue o foco entre terminais |
| `tty:link` | `mod+l` | Arma a conexão (também no menu do nó); sem terminal ou nota de origem, avisa o que selecionar |
| `tty:close` | `mod+alt+w` | Decide pelo nó: terminal (focado ou selecionado) → diálogo com o nome e fecha o processo; nota selecionada sozinha → confirma, tira o nó e apaga o arquivo se ele está na pasta padrão |
| `term:connections` | — | Abre o popover de conexões do terminal ou da nota (pular até a outra ponta, corda ou circuito, remover) |

Com a conexão armada pelo teclado do terminal, o foco sai do terminal para o canvas (onde ficam o Esc que cancela e o
Enter que completa). `Ctrl+L` deixa de limpar a tela do agente pelo painel.

**Atalhos e o navegador.** O registro recusa acorde que o navegador ou o sistema tomam antes da página
(`BROWSER_RESERVED_CHORDS`: `mod+n`, `mod+t`, `mod+w`, `mod+q`, `mod+h`, `mod+m`, `mod+Tab`, `mod+PageUp`/`PageDown`
e as variantes com Shift de `n`, `t`, `w`, `p`, `q`): o compositor saiu de `mod+shift+p`, que no Firefox abre a janela
privativa, para `mod+alt+p`. Acorde com Ctrl, Cmd ou Alt que é de um comando do canvas não chega ao navegador mesmo quando
o comando não vale agora (`claimedKey`): Ctrl+D sem seleção não vira favorito, Alt+3 sem o terminal 3 não troca a aba,
Ctrl+Shift+A sem terminal esperando não abre extensões. Copiar, colar e recortar sem comando valendo ficam com o navegador.

**Menu do nó**: o terminal ganha Conectar; a nota ganha Conexões…, Conectar e Fechar nota, depois dos itens do tipo.
O badge de conexões do terminal conta as arestas `link` e abre o mesmo popover, no canto de cima à direita do nó; o
popover fecha com Esc, clique fora ou quando o nó sai do documento, e as teclas da página ficam paradas enquanto ele está
aberto.

**Fechar nota**: confirmação ("Fechar a nota?"), o nó sai (um passo do desfazer, que devolve o nó e não o arquivo) e então
`client.remove`; a rota só apaga o arquivo da pasta padrão das notas. Falha na remoção do arquivo avisa que a nota saiu
mas o arquivo ficou, com o código do erro.

**Soltar arquivo de fora**: `.md`, `.markdown` ou `.txt` soltos no palco viram notas que apontam para o arquivo sem movê-lo
(`noteDropPaths` → `client.link` → `createNoteNode`), em escada a partir do ponto do soltar, uma por passo do desfazer.
O caminho vem do `text/uri-list` (`file://`); navegador que só entrega o arquivo sem caminho recebe o aviso "O navegador
não informou o caminho do arquivo" (crie pela ferramenta Nota). O que o compositor ou o cartão da nota já trataram
(anexo, imagem) não vira nota.

Prova: `loop/test/ts/argos-montagem-ui.test.ts`.

## Orquestrador no canvas

Um terminal criado no canvas pode gerir uma equipe de outros terminais, os recrutas, pela CLI `hades canvas`. Regra pura em
`src/lib/canvas-recruit.ts`; CLI em `src/commands/canvas.ts`; instruções de gerente em `kit/panel/argos/orchestrator-role.md`
(instaladas em `$D/panel/argos/`).

### Caixa Orquestrador

Na aba Detalhes do modal do terminal (criar e editar), a caixa **Orquestrador**. Ligada, o corpo de
`POST /api/argos/terminals` leva `orchestrator: true` e o servidor soma as instruções de gerente ao arquivo do papel
(`--append-system-prompt-file`, ver Terminais criados no canvas), depois das do papel e das instruções próprias (`instructions`, até `TERMINAL_INSTRUCTIONS_BYTES`). Arquivo
ausente ou vazio é recusa (400), não terminal sem instruções. A resposta só traz `orchestrator: true` quando as instruções
entraram, e só então o nó grava `data.orchestrator` (o cabeçalho do nó mostra o selo "Orquestrador"). Mudar a caixa na
edição passa por `POST /api/argos/terminals/role` com `orchestrator` booleano: reinicia só o processo, com ou sem as
instruções; ausente no corpo mantém o que o terminal tinha. O registro `terminals.json` ganhou `orchestrator` e
`instructions` (opcionais). Escrever `@orquestrador` no compositor de um terminal orquestrador lembra o agente de reler as
instruções.

### Subcomandos

O processo que chama se identifica pelo pane do herdr (como em §Conexões); fora de um pane é `canvas_no_caller`, pane que
não é nó de canvas nenhum é `recruit_not_in_canvas`, e terminal em mais de um canvas pede `--canvas <id>`
(`canvas_many_canvases`). Na procura, canvas que o painel recusa servir é pulado com aviso; com `--canvas` só ele se lê. Recusa sai 1 com o código entre parênteses; uso errado sai 2. Toda mudança no documento sai como
`CanvasOp` sobre a revisão lida (desfazer volta exatamente ao anterior); se outra escrita entrou no meio (409), a CLI relê
e refaz o plano até 3 vezes (`canvas_doc_conflict`).

| Subcomando | Quem pode | O que faz | Recusas |
|---|---|---|---|
| `note list\|read\|write` | qualquer terminal | §Conexões | `canvas_note_no_access`, `canvas_note_write_direct_only`, `canvas_note_conflict` |
| `recruit [--name] [--role\|--no-role] [--preset] [--agent] [--model] [--effort] [--cwd] [--instructions] [--note]… [--prompt]` | orquestrador | cria o terminal pela rota de criar (a mesma do modal: local direto, pelo acesso remoto `confirm` e aviso), põe o nó abaixo do orquestrador com aresta `recruit` e as conexões às `--note` pedidas, e manda a identidade no primeiro prompt | `recruit_not_orchestrator`, `recruit_note_not_shared`, `recruit_missing_note` |
| `connect <recruta> <nota>` | orquestrador, sobre recruta seu | liga o recruta a uma nota já ligada ao orquestrador (repetir não duplica) | `recruit_not_yours`, `recruit_note_not_shared` |
| `reassign <recruta> [--role r\|--no-role] [--instructions t\|--no-instructions]` | orquestrador, sobre recruta seu | grava o papel no nó e depois troca papel ou instruções pela rota de papel, que reinicia só o processo (reinício recusado devolve o papel de antes ao nó); posição, nome e conexões ficam; a identidade sai de novo | `recruit_not_yours` |
| `dismiss <recruta>` | orquestrador, sobre recruta seu | fecha o pane pela rota de fechar e tira o nó com as arestas dele | `recruit_not_yours` |
| `notify <texto>` | qualquer terminal | `notify.sh send agent info <texto> --obj <nome do terminal>` da instalação | `canvas_notify_failed` |

Recruta é o nó `terminal` com `data.recruiter` = id do orquestrador que o criou; só esse orquestrador o comanda.
Terminal sem a caixa (recruta incluído) que chama `recruit|connect|reassign|dismiss` é recusado
(`recruit_not_orchestrator`). `<recruta>` aceita o id do nó ou o nome, procurado só entre os recrutas de quem chama
(terminal alheio com o mesmo id ou nome é `recruit_not_yours`); `<nota>` aceita o id do nó ou o nome do arquivo (`data.note`).
Nome repetido pede o id (`recruit_ambiguous`). A mesma nota pedida duas vezes em `--note` vira uma conexão só.

**Predefinição e papel do recruta.** Sem `--role`, `--no-role`, `--preset` nem `--agent`, o recruta copia do orquestrador
agente, modelo, esforço, papel e predefinição, e nunca a caixa Orquestrador (as instruções de gerente não passam adiante).
A aparência (ícone, cor, tema, fonte) vem sempre do orquestrador. Nome padrão `<nome do orquestrador> <n>`, com a base
encurtada para caber em `TERMINAL_NAME_MAX` (40) da rota de terminais.

**Auto-layout.** Só no recrutamento: os recrutas daquele orquestrador ficam em fileiras de até `RECRUIT_LAYOUT.perRow`
(4), centradas abaixo dele, com passo uniforme (maior largura + `gapX` 48; maior altura + `gapY` 96), na ordem em que
foram criados (`recruitSlots`). O nó novo, a aresta, as conexões e o reposicionamento dos outros saem num lote só: um
desfazer tira o recruta e devolve as posições. `connect`, `reassign` e `dismiss` não mexem em posição.

**Identidade do recruta** (`identityPrompt`): o primeiro prompt diz o nome, o papel, o orquestrador a quem responde, as
notas ligadas e como lê-las e escrevê-las, e que ele não recruta nem dispensa ninguém; a tarefa de `--prompt` vem depois.

**Página.** O documento muda por fora da página quando a CLI grava. Com a aba visível e o gravador parado, a cada
`POLL_MS` a página compara a `rev` de `GET /api/canvases` com a que conhece e, passou dela, relê o documento (a pilha do
desfazer recomeça, como em toda releitura). Com edição do dono agendada ou a caminho não relê: o envio dela volta `stale`
e o caminho de sempre do gravador avisa e relê (`NT.externalRevReload`); reler antes faria o envio pendente sobrescrever o
que a CLI gravou.

**Permissões e onde são conferidas.** O processo local já tem o token do painel e as rotas de terminal servem o dono:
quem é orquestrador e de quem é o recruta é conferido na CLI, pelo documento, como guarda de comportamento dos agentes.
A escrita na nota é conferida também no servidor (`writerOf`). Se a gravação do nó falha depois de o pane abrir, `recruit` o
fecha pela rota de fechar (não conseguindo, avisa para fechar pelo herdr).

### Agentes alocados pela CLI

O orquestrador que aloca agentes com `hades agent new|skill-new|review|adopt` (fora do `hades canvas recruit`) também
fica ligado a eles, sem passo manual:

- a CLI grava no registro do agente `orchestrator: {session, pane}`, o pane do herdr de quem chamou (`HERDR_PANE_ID`;
  sessão de `HADES_HERDR_SESSION`, do socket do ambiente pelo `herdr session list`, ou `default`, como o `hades canvas`).
  Fora de pane, ou chamada do próprio pane do agente, o campo não entra e nada muda. O `adopt` sem pane mantém o que havia.
- o grafo leva o campo no nó (`GET /api/argos/graph`) e emite `orchestrates` agente → agente quando o pane é o de outro
  agente; o nó `terminal` do canvas naquele pane (`data.herdr`) é ligado pela página (`orchestrationEdges`), com o mesmo
  kind, que entra no filtro por tipo de ligação e na legenda. A aresta do terminal fica enquanto o agente estiver visível.
- o agente que entra no canvas pela sincronia vai para a fileira abaixo do terminal (`recruitSlots`, depois dos recrutas
  e dos agentes que ele já tem); ninguém que já está no documento se move.
- agente `done`/`archived` mantém a ligação enquanto ficar no grafo; o registro carrega o campo pelo `caronte pack/unpack`
  (o pane só volta a casar se o orquestrador estiver no mesmo pane do herdr).

Fora desta versão: várias contas, andares, outro workspace, worktree isolado por recruta, nó conector.

Prova: `loop/test/ts/canvas-recruit.test.ts` (regra), `canvas-cli.test.ts` (CLI contra as rotas reais e herdr falso,
e a caixa na rota de terminais) e `argos-ui.test.ts` ("orquestrador no modal e no nó terminal").

## Supervisor

Painel flutuante, separado do canvas, que acompanha os terminais sem precisar de interação: quando um agente termina ou
para esperando o dono, mostra um cartão com o que aconteceu; sob demanda, responde "o que o revisor está fazendo?",
resume as notas conectadas e anota decisões numa nota própria. Abre e fecha por `mod+shift+o` (comando `tty:supervisor`,
também na paleta; vale com o foco dentro de um terminal, que deixa a tecla subir pelo `TTY_CANVAS_KEYS`; no Firefox, se o
navegador reservar a tecla, pela paleta). Com o painel fechado, um aviso no canto
conta os cartões novos. Arquivos: `src/lib/canvas-supervisor.ts` (heurística, pura), `src/panel/argos-supervisor.ts`
(rotas), `kit/panel/ui/argos/supervisor.tsx` (`window.ArgosSupervisor`: `SupervisorLayer`, monitor, cliente, nota).

**O que observa.** O monitor assina o host dos terminais da página (o mesmo fluxo de estado que o canvas já consome) e lê
só `statusOf`, `exitedOf` e `target`. Gera cartão quando um terminal passa de `working` a `idle` ou `blocked` (pausa),
a `done` ou quando o pane sai (fim). O estado inicial só é registrado; um pedido de cartão por terminal de cada vez.

**Cartão (local).** `GET /api/argos/supervisor/peek?session&pane&status[&exited=1]` lê o pane (a mesma leitura do
`/api/herdr/read`, 120 linhas) e passa por `buildCard`: tira ANSI, moldura, rodapé de atalhos e caixa de entrada vazia;
classifica (permissão vence; depois fim, ou erro se a última linha é de erro; pergunta terminada em `?`; erro; `blocked`
sem pergunta visível é "Espera uma resposta"; o resto é "Parou de trabalhar"). O cartão traz o título, uma frase de
resumo, a pergunta ou a permissão detectada (com o comando logo acima do pedido), os últimos passos (linhas `⏺`),
as últimas linhas, a prévia do quadro (14 linhas) e sugestões. As sugestões só agem na tela do supervisor: ir ao
terminal, preparar uma consulta, anotar, resumir as notas. Nada disso sai da máquina; o cartão leva o selo `local`.

**Consulta e resumo (`claude -p`).** O campo do painel entende "anota que …" (anotação), "resume as notas" (resumo) e o
resto como pergunta; o terminal vem do nome citado na pergunta (sem acento nem caixa, o nome mais longo vence), da lista
ou do único terminal do canvas.
- `POST /api/argos/supervisor/ask {session, pane, name, question}`: manda a pergunta e as últimas linhas do terminal alvo
  (até 80 linhas e 12 000 caracteres, já limpas), e mais nada.
- `POST /api/argos/supervisor/notes {canvas}`: manda título e texto das notas ligadas por conexão a algum nó (até 20
  notas, 6 000 caracteres cada, 24 000 no total).

As duas usam o binário da página Claude (`HADES_CHAT_BIN` ou o `claude` do PATH) e o modelo dela (`HADES_MODEL_CHAT`):
`claude -p --output-format text --tools "" --strict-mcp-config --no-session-persistence --model … --effort low`, prompt
pelo stdin, cwd `$D/supervisor/` (pasta vazia), prazo de 120 s. A resposta aparece com o selo "saiu da máquina ·
claude -p" e a contagem do que foi enviado (linhas ou notas e caracteres). O log registra ação, alvo, código de saída e
contagens; nunca a pergunta, as linhas, as notas nem a resposta. Tetos: 6 chamadas por minuto por origem (local e remoto
à parte; `429 rate-limited` com `Retry-After`) e 2 ao mesmo tempo no painel (`429 busy`), vaga ocupada do portão até a
resposta.

**Chave.** `HADES_SUPERVISOR_CLAUDE` (padrão 1; Configurações → Painel → "Canvas: supervisor usa o claude -p"). Em 0,
consulta e resumo respondem `403 supervisor-claude-off` sem ler pane nem nota, e o painel desliga Perguntar e Resumir
notas; cartões e anotações seguem locais. `GET /api/argos/supervisor` devolve `{claude}`.

**Acesso remoto (D1).** Pelo túnel, consulta e resumo pedem `confirm` igual ao nome do terminal (ou `notas` no resumo)
antes de ler qualquer coisa (`403 confirm-required` com `phrase`; o painel mostra a confirmação inline) e avisam o dono
pelo `notify.sh` (ação e alvo, uma vez por minuto por alvo). O cartão local não muda pelo remoto.

**Notas do supervisor.** A primeira anotação cria o arquivo `nota-supervisor` (pela rota das notas, com `# Notas do
supervisor` no topo) e o nó `supervisor-notas` no centro da vista, por `createNoteNode` como operação do desfazer; as
seguintes acrescentam uma linha datada (`- AAAA-MM-DD HH:MM — texto`, hora local) sempre nessa nota. A gravação usa a
revisão da rota (uma nova tentativa se outro escreveu no meio, sem perder a entrada alheia). Desfazer tira só o nó; a
próxima anotação recria o nó apontando para o mesmo arquivo. "Anotar este cartão" acrescenta o resumo do cartão.

**O que nunca faz.** Não manda texto, tecla nem comando a agente: as rotas recebem só leitura do pane, do canvas e das
notas, e o monitor não toca `input` do host. Não grava no canvas além do nó da própria nota.

Erros (`code`): `invalid`, `not-found`, `confirm-required`, `supervisor-claude-off`, `claude-missing`, `claude-failed`,
`herdr-failed`, `busy`, `rate-limited`.

Prova: `loop/test/ts/canvas-supervisor.test.ts` (três quadros: fim, pergunta, permissão; limpeza; contexto e tetos),
`loop/test/ts/argos-supervisor-route.test.ts` (peek, ask e notes com claude falso, chave, remoto, taxa, simultâneos e a
varredura de que nenhuma rota escreve em pane) e o bloco "supervisor do canvas" de `loop/test/ts/argos-ui.test.ts`.

## Ocultar e podar o canvas

O canvas tira da vista o que o dono não usa sem apagar nada: registro, worktree e branch ficam como estão.

- **Por que apareciam centenas.** O preset de abertura (`active`) já tirava encerrados e arquivados, mas bastava sair dele
  ("Todos", "Concluídos", o "Ver os concluídos e arquivados" do estado vazio) para os arquivados voltarem todos, e o preset
  ficava no endereço (`preset=all`). Agora os arquivados saem de qualquer preset até o dono pedir.
- **Ocultar em lote.** "Ocultar do canvas" (`canvas:hide`, `Shift+H`; paleta e menu do nó de qualquer tipo) tira o nó do
  desenho. Com seleção múltipla, o alvo é a seleção inteira quando ela contém o nó do menu (senão só o nó). O nó segue no
  documento com a posição; o grafo não o devolve ao atualizar. É um passo do desfazer (`Ctrl+Z` volta exatamente ao anterior).
- **Lista de ocultos.** O botão "Ocultos do canvas (N)" da barra (e "Lista de ocultos…" na paleta e no menu do fundo) abre a lista: uma
  linha por oculto, com caixa para marcar; "Reexibir" na linha, "Reexibir N" para os marcados e "Reexibir todos" (também
  `canvas:unhide-all` na paleta). Cada reexibição é um passo do desfazer. Foco na primeira linha ao abrir, Esc e clique fora
  fecham e devolvem o foco ao botão.
- **Mostrar arquivados.** Botão da barra (`aria-pressed`), desligado por padrão. Desligado, o agente arquivado sai de qualquer
  preset, inclusive "Todos" e "Concluídos", e o PR ou gate ligado só a agentes que saíram por isso (ou por estarem ocultos)
  sai junto. Vai na seleção de filtros como `archived=show` (endereço `f.archived=show` e filtros salvos).
- **Última atividade.** Seletor ao lado de Estado: qualquer data (padrão, a ausência da dimensão) · 24 h · 7 dias · 30 dias.
  O agente passa se o último evento (`lastEventTs`, com fuso) cabe na janela, pela mesma leitura de idade de `ageBand`; sem
  evento conhecido não cabe em nenhuma. Com janela escolhida, unidade e PR soltos saem, como em papel e estado. Vai na seleção
  como `activity=<d1|d7|d30>`.
- **Contagens.** Desenho, lista, minimapa, Tab e as contagens do seletor de Estado seguem o mesmo conjunto: oculto, arquivado
  sem o toggle e agente fora da janela não contam. "Limpar" da barra de chips não mexe em "Mostrar arquivados" nem na janela;
  "Limpar os filtros" do estado vazio tira a janela e mantém o toggle. A linha de estado do topo (quantos esperam, parados,
  total de agentes) segue global.
- **Dimensões do agente** (`src/lib/canvas-filters.ts`): `AGENT_DIMS` (`archived`, `activity`) fazem parte de `FILTER_DIMS`
  (endereço e filtros salvos as levam), mas a barra de chips usa `CHIP_DIMS`; quem as aplica é o preset de estado, por
  `passesAgentDims(node, selection, nowMs)` (relógio por parâmetro). `ACTIVITY_WINDOWS`, `ACTIVITY_ANY`, `SHOW_ARCHIVED`,
  `setShowArchived`, `setActivity`, `activityOf`, `clearChips`.
- **Campo do documento.** `hidden?: string[]` no documento `v: 1` (aditivo; documento sem o campo segue válido, e lista vazia
  não se grava: o campo sai). Cada id aponta para um nó do documento, sem repetir, até `CANVAS_LIMITS.hidden` (2000). Lista
  vazia ou que não é lista: `canvas_invalid_shape`; id repetido: `canvas_duplicate_id`; id sem nó: `canvas_dangling_reference`;
  acima do teto: `canvas_limit_exceeded`. Na mescla com o grafo, oculto vivo que saiu do grafo sai da lista com o nó; excluir
  um nó oculto o tira da lista (desfazer o devolve oculto, no mesmo índice).
- **Operações** (`src/lib/canvas-history.ts`): `AtomicOp` `hide` e `unhide` com `ids: Placed<string>[]`, inversos um do
  outro. `opHide(doc, ids)` ignora id repetido ou já oculto e recusa id sem nó (`history_missing_target`); `opUnhide(doc, ids)`
  e `opUnhideAll(doc)`; os três dão `undefined` quando nada muda.
- **Módulo da tela** (`kit/panel/ui/argos/canvas-hidden.tsx`, `window.ArgosCanvasHidden`): `hiddenCommandDefs(port)`,
  `hideTargets(selection, nodeId)`, `HiddenMenu` e a árvore pura `renderHiddenMenu`. Só exibe e encaminha; a página monta e
  aplica a operação.

Prova: `loop/test/ts/canvas-doc.test.ts`, `canvas-history.test.ts`, `canvas-filters.test.ts`, `canvas-hidden.test.ts` e o
bloco "filtros: ocultos e dimensões do agente no preset" de `argos-ui.test.ts`.
