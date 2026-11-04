# Orquestração — `/hades orchestrate`

Uma sessão faz o papel de **orquestrador**: conhece o objetivo, aloca agentes pelo herdr, escreve os briefs, acompanha,
responde ou escala dúvidas, audita as entregas e mantém estado e artifacts em dia. Quando a entrega tem várias PRs, um
agente de consolidação as junta numa só (`consolidate.md`), o merge na base é dela e o gate roda só nela.

Os dados do dono e do time (assignee, reviewers, labels, owners de spec, assignee do card, pastas) vêm das
**Configurações → Orquestração**; os scripts e o modelo de brief os leem de lá.

## 1. Papel

- **O orquestrador não implementa.** Aloca, escreve briefs, acompanha e audita. Verificação pequena (`gh`, `git`,
  leitura) é dele.
- **Decisão que só o dono toma vai como pergunta interativa** (`AskUserQuestion`, até 4 por vez, a recomendada primeiro
  e marcada "(Recommended)"). Nunca deixar pendência em texto corrido. Antes de perguntar, `hades agent decide` (§4.1):
  se o nível de autonomia do dono cobre a decisão, ela sai 0 e a recomendada vale sem pergunta.
- O dono muda uma regra a qualquer momento: repasse na hora a todos os agentes afetados (`hades agent prompt`),
  atualize os briefs e, se for regra duradoura, grave em memória.
- Mensagens ao dono curtas: o que aconteceu, o que muda, o que ele precisa fazer. Tabela quando houver várias PRs ou
  agentes.
- Nomes curtos e significativos para agentes (`exec`, `cache`, `fila-um`): o dono acompanha por eles.

## 1.1 Plano antes de alocar

`plan.md` a partir de `reference/loop/plan-template.md` (unidades e ordem, dependências e stack, specs novas com agente
de spec antes do de implementação, dono de cada arquivo compartilhado, consolidação, papel e modelo de cada agente).
Aprove com o dono por `AskUserQuestion` e registre com `hades agent plan-approve <plan.md>`. Do repo da skill (ou de um diretório sem `origin`) o `plan-approve` grava em
`<raiz de trabalho>/_skill/orchestration/plan.json`, com `escopo: "skill"`; é o plano que o `skill-release.sh` e o Cerberus usam
na release (nunca o `plan.json` mais novo de outro projeto). Com a Configuração
"Exigir plan.md aprovado" ligada, o `new` recusa alocar sem plano, ou com plano mudado depois da aprovação (a seção
"Estado atual", inclusive com sufixo no título, não conta: ela fica fora do hash, que é o mesmo no `hades agent` e no
Cerberus; fim de linha CRLF e newline final também não mudam o hash).

**Estimar antes de aprovar.** Com o plano escrito e antes do `plan-approve`, rode `hades moirai estimate <plan.md> --write`:
a seção `## Estimativa` traz custo (US$) e duração por unidade, com faixa p25–p75 e confiança, a partir das unidades
encerradas (`reference/moirai.md`). Mostre ao dono junto com o plano; confiança baixa vem escrita na seção. A seção entra
no hash: reestimar depois pede nova aprovação. O `plan-approve` avisa (sem barrar) quando ela falta. Declare o tamanho no
escopo da unidade ("~300 linhas" ou "5 arquivos"): sem isso a estimativa compara só papel e modo.

**Cabe na janela?** Antes de alocar unidades em paralelo, compare o p75 do plano com o que resta da janela de 5 h: a linha
"cabe na janela atual?" do `hades moirai estimate <plan.md>` (soma das unidades em paralelo contra 100 − % usado,
`reference/limites.md`). `NÃO cabe`: leve ao dono, por `AskUserQuestion`, a opção de escalonar (ondas, esperar a renovação
ou reduzir o escopo); `não dá para dizer` (sem coleta ou calibração) é dito como está, nunca vira número.

**Estado e histórico.** O plano guarda o estado em uma seção só, **"Estado atual"** (até ~3 KB, reescrita a cada
evento, nunca acrescentada). O histórico (eventos tratados, decisões, rodadas) vai em `<plano>.log.md`, só com append.
**Retomada** (depois de `/clear`, teto de contexto ou outra sessão): leia apenas "Estado atual" (`sed -n` da seção) e o
registro dos agentes (`hades agent list`); o `.log.md` nunca se lê inteiro — `grep -n`/`tail -n 40` para um fato
antigo. Plano antigo com histórico no corpo: `hades agent plan-trim <plan.md>`.

## 2. Ciclo de um agente

Tudo pelo `hades agent`, de dentro de um clone. A **pasta de relatórios** é `.design-sync-reports/` na worktree do agente
(o nome fica por compatibilidade): guarda `brief.md`, `report.md`, `questions.md`, `handoff.md` e `review-<PR>.md`. Abaixo,
`<pasta>` é ela.

| Passo | Comando | O que faz |
|---|---|---|
| alocar | `new <nome> --role spec\|impl\|consolidate --branch <branch no formato do perfil> --new-card "[Módulo] Título" --tags <tags do perfil>` | card pelo `card.create` do perfil (só se o perfil tem card; assignee das Configurações; procura antes de repetir se a API falhar), worktree pelo herdr, dependências por symlink, hooks do repo, sem upstream, pasta de relatórios excluída do git, lock, entrega `in-progress` no estado, `brief.md` do modelo e registro |
| | `--card <card>` | card já existente (só com `card.provider` no perfil); `--base origin/<branch de baixo>` para empilhar; `--for inbox --pr N` para tratar review; `--for consolidate` para a consolidação |
| | `--resume <worktree>` | retoma PR cuja sessão fechou (`herdr workspace create --cwd`) |
| revisar PR alheia | `review <nome> --pr N` | worktree em HEAD destacado; achados em `review-*.md`, nada vai ao GitHub |
| adotar | `adopt <nome>` | registra um agente que já roda no herdr (alocado à mão) |
| brief | editar `<worktree>/<pasta>/brief.md` | completar **Item** e **Contexto** (§3); o resto já vem preenchido |
| iniciar | o **dono** roda o `! herdr agent start ... --model <m> --effort <e>` que o `new` imprime (modelo e esforço do papel, das Configurações; `start-cmd <nome>` reimprime; se o pane do registro não existe mais no `herdr pane list`, p.ex. depois de reiniciar o herdr, cria um workspace novo na worktree como o `skill-new` e grava o pane novo no registro) | o classificador recusa quando é o orquestrador |
| fase | `phase <nome> <fase>` | `/clear` na sessão do agente e prompt da fase (cartão + brief + handoff): sessão nova por fase sem o dono reiniciar nada |
| retomar | `resume <nome> ["<texto>"]` | depois de `PARKED` ou `CONTEXT`: sessão limpa continuando do `handoff.md`; o prompt manda conferir `hades gate-lock status` e esperar o check que já está na fila, sem reenfileirar |
| estacionar | `park <nome> ["<motivo>"]` | pede o `handoff.md` (`STATUS: PARKED`) e que o agente pare, sem matar a sessão nem fechar o pane; o registro vira `parked` e o `watch` já emite `PARKED`. Já estacionado ou encerrado: avisa e sai 0. É o passo que o `hades caronte pack` exige antes de empacotar (`reference/caronte.md`) |
| abrir o pacote | `hades caronte unpack <arq> [--dry-run]` (fora do `hades agent`) | na outra máquina, com o clone do projeto: refaz plano, worktrees (bundle + patch) e registros com os agentes `parked` e sem `pane`, e imprime por agente o start do herdr e `adopt <n> && resume <n>`; recusa sem tocar em nada se algo já existe, desfaz se falha no meio (`reference/caronte.md`) |
| escalar | `escalate <nome> "<motivo>"` | o agente estaciona; pane novo do herdr na mesma worktree; o dono inicia a sessão de escalada (modelo de escalada); depois `resume`. Nunca `/model` (vira o padrão global da máquina) |
| tarefa | `prompt <nome> ["<texto>"]` | manda "leia o brief e execute" com caminhos absolutos e confere o `foreground_cwd` (sessão aberta no clone principal = aviso) |
| dúvida | `answer <nome> Q<n> "<resposta>"` | grava em `questions.md` (marca "(respondida)" e a seção "Resposta do dono", com a linha de não citar) e avisa o agente |
| listar | `list [--all] [--json]` | rápido e offline: só o registro + um `herdr agent list` (nada de GitHub). Colunas: nome, papel, modo, registro (`ativo`/`encerrado`/`arquivado`), estado no herdr, branch, worktree. Sem `--all`, só os não encerrados |
| acompanhar | `status` · `hades watch --next` em segundo plano | §4 (o `status` consulta a PR de cada agente: é o lento) |
| encerrar | `done <nome>` | audita: `<pasta>/report.md` com `STATUS: DONE`, git limpo, nada sem push, PR aberta; libera o lock, entrega `open`/`merged` no estado, fecha o pane. A worktree fica enquanto a PR estiver aberta |

- `start` respondendo `agent_name_taken` com o agente rodando é só comando repetido. Pane do herdr preso a sessão morta: abra
  outro (`herdr pane split <pane> --direction right`) ou use outro nome.
- Reusar a worktree numa rodada nova: renomeie o `<pasta>/report.md` anterior (`report-1.md`) antes do `prompt`
  (`prompt`, `resume`, `phase` e `answer` avisam quando o report ainda começa com `STATUS: DONE`; o watch ignora report mais velho que o prompt).

### Evoluir a própria skill (unidades `skill`)

Mudança na skill não usa o `new` (ele exige card, `node_modules` e lock): usa uma **unidade** com worktree no git local
da skill (pode ter remote; push nunca é automático), branch `skill/<u>`, em `~/.claude/hades/skill-dev/<u>`. O agente segue
`reference/loop/skill-dev-contract.md` (sem PR, push, gate nem spec).

1. `skill-new <u> [--base <ref>] [--role impl|consolidate] [--port N] [--dry-run]`.
   - **Onde roda:** todos os `skill-*` rodam do repo da skill, de uma unidade, de um diretório fora de git ou de um clone
     de projeto. O registro é **único**: vai sempre para a raiz própria `_skill/orchestration` (como o `plan-approve`),
     e nenhum agente fica registrado em dois repositórios. Unidade `skill` que um clone antigo deixou no registro do
     projeto é movida para `_skill` no primeiro uso, com aviso em stderr.
   - **Quem aceita o nome da unidade:** `adopt`, `prompt`, `answer`, `phase`, `resume`, `escalate`, `done` e `status`,
     do repo da skill, de uma worktree de unidade ou de um clone. O `status` e o `list` (sem nome) de um clone somam as
     unidades de `_skill` aos agentes do projeto, e o `hades watch` acompanha as duas raízes.
   - **O que cria:** confere que a skill é um git e que a base (padrão `main`) existe; recusa se branch ou pasta já
     existem; cria worktree e branch, o `brief.md` a partir de `brief-skill-template.md` (brief existente é mantido), a
     próxima porta de teste livre em 21270–21289 (20 portas, chaves `HADES_SKILL_PORT_MIN/MAX`; fora dos briefs, dos
     registros ativos e do `ss`: unidade `archived` libera a porta, e faixa esgotada faz o comando falhar com mensagem,
     sem criar worktree nem brief), o workspace herdr `hd-<u>` e o registro com `mode: "skill"` (sem lock nem card).
     Imprime o comando de start do dono.
2. Preencher **Item**, **Docs** e **Prova** do brief.
3. O dono roda o start impresso; depois `adopt <u>` e `prompt <u>`. `phase`, `resume` e `status` valem para a unidade
   (o `status` não chama o GitHub). `done <u>` exige só `STATUS: DONE` e git limpo (nada de PR nem push), também quando rodado de um clone.
   O `done` (de agente ou de unidade) passa pela avaliação conjunta do momento `done` do Cerberus: barra recusa
   encerrar (`reference/cerberus.md`).
4. Auditar o report e o diff; merge da branch na `main` da skill (consolidação); reinstalar (`kit/install.sh`; o `skill-release`
   que aborta por drift só de arquivo novo do kit imprime o comando de reinstalar);
   `kit/skill-release.sh release` (`reference/evolving.md` §Passos, item 5).
5. `skill-clean [<u>…|--merged] [--force-data] [--dry-run]`: por unidade, **recusa** se a branch não está contida em `main`, se a
   worktree tem mudança rastreada (ou arquivo novo fora do git: a recusa lista os arquivos), se o agente está ativo no herdr (`working`/`idle`) ou se
   `_data/<u>` tem algo além dos artefatos das provas (`data/`, `data-rt/`, `install.log`, `check.log`, `install<N>.log`, `check<N>.log` das provas repetidas, `panel.log`, `wt`, `clone`: a
   instalação descartável e o `hades skill-release check`; a lista é `DISPOSABLE_DATA` em `src/commands/agent-skill.ts`). Export, patch
   e captura ali se perderiam: a recusa lista só o que não é conhecido, e `--force-data` apaga mesmo assim, depois de você conferir, **só das unidades
   nomeadas** na linha (as que o `--merged` pega são conferidas como sempre, com ou sem a opção).
   Senão: fecha o workspace herdr cujo único cwd é a worktree, arquiva `brief.md`, `report*.md`, `questions.md`,
   `handoff.md`, qualquer outro `*.md` avulso, capturas e `*.patch`, `*.diff`, `*.tsv`, `*.json`, `*.txt` (<2 MB) em `~/.claude/hades/skill-dev/_arquivo/<pasta>/`, remove a worktree, a branch e
   `_data/<u>`, e marca o registro `archived`. A unidade é o sufixo da branch; o nome da pasta pode diferir
   (`_onda1` ↔ `skill/onda1`), os dois valem como argumento. `--merged` pega todas as `skill/*` já na `main`, exceto as
   com agente ativo e as recém-criadas (registro que não é `done`/`archived` e branch sem commit próprio: estar "contida na
   `main`" ali não é entrega); essas só saem pelo nome. Idempotente. Workspaces herdr que não casam pelo cwd ficam: feche à mão.

## 3. Brief

`reference/loop/brief-template.md` é o modelo; o `new` preenche Infra, Processo, Gate e Proibido. O orquestrador escreve:
- **Item:** o que entregar, specs a ler, fora do escopo, decisões do dono já tomadas (sem citar que foram perguntas).
- **Contexto:** PRs de outras pessoas nos mesmos arquivos ("mudança aditiva, registre no report"), revisões e achados
  anteriores, memórias úteis, dono de cada arquivo compartilhado entre agentes paralelos.
- **Empilhamento**, quando houver.

Confira contra a spec antes de prescrever nomes de eventos e contratos: brief que inventa nome é retrabalho.
Brief com comando de teste ou lint se escreve com a ferramenta de escrita de arquivo, não com heredoc no Bash: o hook
da fila barra o texto do comando.

## 4. Acompanhamento

`hades watch --next` em segundo plano (run_in_background), de dentro de um clone:
sai no primeiro evento novo e acorda o orquestrador, que trata e relança. Sem `Monitor`, sem religar a cada 30 min.
**Escopo:** chamado de um pane do herdr (`HERDR_PANE_ID`), o watch acompanha só os agentes cujo `orchestrator` do registro
é esse pane (gravado por `agent new|skill-new|review|adopt`); agente sem `orchestrator` segue visto por todos. Cada
observador (pane ou filtro) tem o seu "já visto" em `watch/by/<observador>/`, então um watch nunca consome o evento do
outro; o observador novo herda o "já visto" compartilhado na primeira passada (sem reemitir o que já saiu). Flags:
`--agent <nome>` (repetível) e `--agents a,b,c` (só esses), `--orchestrator <sessão:pane>` (os agentes daquele pane, útil
depois do `caronte unpack`), `--all` (todos, no "já visto" compartilhado: o painel e quem quer tudo). Fora de pane e sem
flag, o comportamento é o de sempre (todos). Herdr reiniciou e os panes mudaram: `hades agent adopt <nome>` (agente
vivo) ou `hades agent reassign-orchestrator <nome>…|--all` apontam o registro para o pane de quem chama.

Eventos: `QUESTION`, `PR-OPEN`, `DONE`, `DONE-HELD`, `REVIEW`, `MERGED`/`CLOSED`, `PARKED`, `CONTEXT`, `STALLED`, `BUDGET`, `LIMITE`.
- **`LIMITE <5h|semana> <pct> renova <hora>`**: a janela do plano passou de `HADES_LIMITS_WARN_FIVE_PCT` (80) ou
  `HADES_LIMITS_WARN_SEVEN_PCT` (90). É da máquina, não de um agente: sai para todo observador (o filtro de dono não vale),
  uma vez por janela e por renovação, e de novo só depois que ela renova. Só aviso: diga ao dono e pese antes de alocar
  mais em paralelo (`reference/limites.md`). Sem coleta ligada, nada sai.
- **`BUDGET <agente> <pct>`** (Moirai): o custo corrente passou de `HADES_MOIRAI_WARN_PCT` (100) do p75 da estimativa do
  plano. É só aviso: o agente segue. Diga ao dono, sem agir; ao passar de `HADES_MOIRAI_ASK_PCT` (150) o watch grava a
  pergunta no `questions.md` do agente (seguir, reestimar ou estacionar) e emite a `QUESTION` de sempre: leve ao dono e
  `hades agent answer`. Um aviso por limiar por fase; sem estimativa no plano nada sai (`reference/moirai.md`).
- **`DONE <agente>`**: `report.md` começando com `STATUS: DONE`, **escrito depois do último prompt** do agente (o report
  da rodada anterior continua no disco e não vale), **uma vez por prompt** (reescrever o report no mesmo prompt não
  reemite; um `agent prompt`/`phase`/`resume` novo abre outro DONE) e **só com commit e prova**: o report cita um commit
  (em linha que fala de commit) que é ancestral do HEAD da worktree, e traz uma linha de prova (`passou`, `ok`, `rc=0`…
  junto de `test`, `gate`, `tsc`…; `falhou` não vale). Fase que não faz commit: `hades agent phase <nome> <fase>
  --no-commit` e o DONE exige só a prova.
- **`DONE-HELD <agente> sem-prova|sem-commit|commit-fora-da-branch`**: o agente se declarou pronto (`STATUS: DONE`,
  report novo) mas falta prova ou commit; o vigia segurou o DONE e diz por quê (uma vez por prompt e motivo; também no
  diário do agente). Não espere calado: audite o report e o `git log` da worktree, e então (a) devolva o report pedindo a
  linha de prova ou o commit citado (`hades agent prompt`), (b) aceite à mão (`hades agent done`, se a entrega está de
  fato pronta, ex.: relatório de teste que falhou de propósito) ou (c) se a fase nunca comita, relance-a com `--no-commit`.
- **`PARKED`** (agente estacionou com o handoff) e **`CONTEXT`** (passou do teto do papel): `resume <nome>`, ou
  `phase` se a fase mudou. Não saem: `PARKED` de handoff mais velho que o último prompt (o `resume` não apaga o arquivo,
  e a sessão retomada já o leu) e nenhum evento de unidade `archived` ou `done` (vale também quando o mesmo nome ficou em outra raiz do registro, resto de um clone antigo).
- **Review novo** vai ao agente daquela PR. Agente já encerrado: repasse a um agente ativo da mesma área como segunda
  tarefa, ou `new --resume <worktree>` e peça ao dono o `start`.
- **`STALLED`** só depois de Configurações → "Agente parado depois de" (padrão 25 min): o agente fica idle esperando
  o próprio gate. Unidade registrada que nunca recebeu prompt não conta (a sessão está esperando o dono). Leia o terminal (`herdr agent read <nome> --lines 120`) antes de concluir.
- Mais de 2 h sem evento: pare de religar e diga ao dono que o acompanhamento está suspenso até ele voltar.
- O painel mostra tudo isso na página **Orquestração**.

## 4.1 Autonomia: decidir sozinho ou perguntar

Configurações → Orquestração → **Autonomia** (`HADES_ORCH_AUTONOMY`, 0 a 3; só o dono muda: painel local ou `!`). Regra
única: **antes de cada `AskUserQuestion` (e antes de agir sozinho em qualquer ponto da tabela), chame**

```
hades agent decide <plano> --level-needed N --question "<o que perguntaria>" --chosen "<a opção recomendada>" [--alternatives "a; b"]
```

Saiu 0: o nível cobre; a opção recomendada vale, o rastro já foi gravado (linha no `<plano>.log.md`, evento `decision` no
diário, notificação se ligada): aja e siga. Saiu 3: é pergunta ao dono, pergunte como sempre. Nível 0 (padrão) devolve 3
para tudo: nada muda para quem não ligou.

| Ponto de decisão | Nível mínimo |
|---|---|
| `resume` / `phase` depois de `PARKED`, `CONTEXT` ou fim de fase | 1 |
| Retry de gate, de CI ou de comando que falhou por causa externa | 1 |
| Reestimar o plano (`hades moirai estimate --write`) | 1 |
| `STALLED`: ler o terminal e cutucar o agente | 1 |
| `BUDGET` até o p75 (aviso: o agente segue) | 1 |
| Responder a `QUESTION` de agente pela opção recomendada | 2 |
| Corrigir defeito dentro do plano (card ou unidade já prevista) | 2 |
| Replanejar (unidades, ordem, dono de arquivo) e reaprovar o plano | 3 |
| Release da skill (`skill-release release`) | 3 |

**Nunca cedem, em nenhum nível** (`decide` sai 3 mesmo com nível 3): os invariantes da skill; merge de PR de projeto;
push público do snapshot da skill; passar de 150% do estimado (a `QUESTION` do Moirai, `HADES_MOIRAI_ASK_PCT`); mudar o
próprio nível ou o toggle de auto-alocação. Decisão dessas classes vai ao dono com `--class
invariante|merge|push-publico|estouro|autonivel` ou, mais simples, direto por `AskUserQuestion`. O que o `decide` não
reconhece como classe e não está na tabela é decisão do dono: pergunte.

**Auto-alocação** (`HADES_ORCH_AUTO_START`, `hades agent auto-start on|off|status`): ligada, e com a regra allow
`Bash(herdr agent start:*)` presente no `settings.json` do usuário, `new` e `skill-new` imprimem o `herdr agent start`
sem o `! `: **você o roda como Bash** (a regra allow o cobre; o hades não o executa). Sem as duas coisas, imprimem o
`! herdr agent start` do dono como sempre. Se o classificador barrar mesmo assim, não insista: desligue o toggle e
escale ao dono. Detalhes em `reference/autonomia.md`.

## 5. Auditoria antes de repassar ao dono

- Estado da PR (`gh pr view --json state,mergeable,reviewDecision`), threads abertas (GraphQL), `git status` limpo e
  `rev-list @{upstream}..HEAD` = 0 na worktree (o `done` confere), `--is-ancestor` em consolidações
  (`hades consolidate verify`).
- Spec escrita por agente: leia, na própria sessão, em três passadas (conformidade com as regras de spec do projeto,
  `ref spec`; contra o código; regra inventada ou forma proibida).
- Levantamento amplo: leitura na própria sessão, sem subagentes; grave a evidência de cada achado em arquivo.

## 6. Artifacts de acompanhamento

- Capability `db`; dados numa coleção, página lendo com `onSnapshot`; atualização por `ArtifactData` em `batch`, sempre
  com `if_version`, texto breve, sem código, sem citar decisões ou códigos de pergunta; `meta/summary.updatedAt` com a
  hora real (`date -u`).
- Atualize a cada PR aberta, review recebido, correção feita ou merge.
- Um artifact pessoal do dono (privado, `owner`) e um compartilhado com o time (leitura `view`, escrita `owner`)
  convivem coerentes. Antes de publicar ou alterar a página, carregue `artifact-capabilities`.

## 7. Memória

Toda regra nova do dono e toda lição não óbvia vira memória (um arquivo por fato, `**Why:**` e `**How to apply:**`,
uma linha no `MEMORY.md`).

## 8. Erros que já aconteceram

| Situação | O que fazer |
|---|---|
| O dono mergeou a PR enquanto o agente corrigia o review | Pare o agente: nada de push na branch mergeada. As correções vão numa PR nova a partir da base, com card próprio; responda nas threads antigas com o link |
| Sessão do agente abriu no clone principal | O `prompt` avisa e leva caminhos absolutos; monitore se o clone principal ganhou mudanças |
| GitHub mostra CONFLICTING numa PR empilhada com a base já contida | Confira com `merge-base --is-ancestor` e `merge-tree`; costuma ser cache e recalcula no próximo push |
| Gate esperando memória por muito tempo | Mostre a fila e os maiores consumidores ao dono (`gate-lock.sh status`, painel → Fila de gates); não derrube processo alheio |
| Card criado e depois descartado | Avise o dono para apagar no provedor do card |
| Agente terminou com commit sem push | O `done` recusa encerrar; confira com o agente |
| Review chega numa PR cujo agente já fechou | §4 |
