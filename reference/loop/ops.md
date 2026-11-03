# Modos operacionais — manutenção do próprio loop

Seis modos curtos que existem porque o fluxo tem estado: lock, escalação pendente, tick
interrompido, CI em voo, PR que chegou ao fim e a visão geral de tudo isso. Sem eles, cada um desses vira intervenção manual no
`~/.claude` ou pergunta repetida ao dono.

Nenhum deles roda gate, e nenhum toca código de produção.

**Não confunda com as formas qualificadas** (outro comando, outro dono): `/hades resume` (tick do loop) × `hades agent
resume` (agente orquestrado) × `/hades env resume` (ambiente local); `/hades watch --pr` (run de CI) × `hades watch
--next` (acordar o orquestrador) × `watch.sh` (eventos do ambiente); `/hades answer` (escalação do loop) × `hades agent
answer` (agente); `/hades ready` (PRs esperando merge) × `hades consolidate ready`. Nas outras docs do loop, escreva
sempre a forma qualificada.

## `status` — visão geral

`/hades status`

Coletor, locks ativos e escalações abertas, num só relato. Read-only puro: não grava `global.json`, não libera lock,
não responde escalação (para isso, `locks` e `answer`).

## `locks` — inventário e liberação

`/hades locks [--pr N]`

Inventário dos dois tipos de lock, com o critério de `gates.md` §3.3 — que é diferente para cada um,
porque o `pid` gravado nem sempre pertence a um processo que vive junto com o lock.

**Lock de PR** (`<work>/locks/pr-<n>.lock/owner`, e `deliver-<chave>.lock`): liste `clone`, `host`,
`pid`, `since` e `mode`, e classifique:

- **ativo** — há sessão viva apontando para aquele `clone`/assunto. Não toque; só relate.
- **suspeito** — nenhuma sessão viva aparente, ou `since` > 2 h. **Pergunte** antes de liberar,
  mostrando o `owner` inteiro.

O sinal de liveness **não é o pid**: ali ele é de shell efêmero, que morre logo depois do `mkdir`, e
`kill -0` diria "morto" sempre — furando lock de sessão viva. Cruze `clone=` e `since=` com
`herdr agent list` (workspace, `cwd`, título, `agent_status`) e com `ListAgents` (ferramenta do Claude Code que lista os agentes em execução). Tempo sozinho nunca
autoriza remover: sessão lenta e sessão morta se parecem por fora.

**Fila de gate** (`<work>/locks/gate-queue/*.t`): leia com `gate-lock.sh status` (fila, orçamento,
`MemAvailable`). Ticket cujo wrapper **e** filho morreram e órfão de verdade, e o próprio
`gate-lock.sh` remove na próxima avaliação — não remova a mão. O histórico de espera e duração está
em `<work>/locks/gate-journal.tsv`. Slots v1 (`gate-<recurso>.slot-<n>`) só aparecem durante a
transição e seguem o critério antigo (`runner=wrapper` + pid morto).

Libere sempre por lock, nunca com um `rm -rf locks/*` genérico.

## `answer` — fechar escalação

`/hades answer [<id>]`

O loop pergunta e segue trabalhando; a resposta chega depois, na conversa, e se perde se ninguém
gravar. Este modo grava:

1. Liste as escalações com `answeredAt: null` de `global.json`, cada uma com PR, pergunta e data.
2. Para a que o dono respondeu, preencha `answeredAt` e `answer`, e crie a entrada
   correspondente em `decisions` com `appliesTo` (specs/PRs que a decisão alcança).
3. Se a resposta destrava trabalho, diga qual PR volta a ser acionável — e pare. Aplicar a decisão é
   trabalho do modo dono daquela PR, no próximo tick.

Escalação respondida some do bloco "Escalações abertas"; `decisions` é consultado **antes** de
escalar de novo, para não reperguntar o que já foi decidido.

## `ready` — o que está esperando merge

`/hades ready`

O fluxo nunca faz merge, então `done-pending` é o estado terminal e merece uma leitura própria. Para
cada PR em `done-pending`, relate: número, título, spec, base, quantos reviews, `headRefOid`, e o que
o dono precisa fazer (merge, ou merge da mãe antes, quando há stack).

Duas coisas que este modo não faz: merge, e transformar `no-ci` em "pronta". PR sem check não entra
nesta lista — ausência de CI não é CI verde.

## `watch` — observar um run de CI

`/hades watch --pr N`

Para PR em `ci-running`, e só enquanto ela estiver: consulte `gh pr checks <n> --json
name,state,bucket,link` até concluir.

- Ritmo ~480 s, e **só** para o run específico que acabou de ser disparado (`gates.md` §7).
- Terminou verde → devolva a PR ao modo dono dela e encerre o watch.
- Terminou vermelho → vira `ci-red`, que tem prioridade sobre qualquer achado de review.
- Não use `watch` como poll genérico: o que notifica sozinho não se observa em loop curto.

## `resume` — retomar tick interrompido

`/hades resume`

Sessão que morre no meio deixa rastro: lock próprio órfão, working tree sujo, checklist com etapa
parcial, `deliveries` em `in-progress` sem PR. Ordem de recuperação:

1. **Diagnostique antes de mexer**: `git status --porcelain`, `git log --oneline origin/<base>..HEAD`,
   `<work>/checklist-pr-<n>.md`, `deliveries` com `status: in-progress`, locks órfãos.
2. **Relate o que achou** e o que pretende fazer, antes de escrever.
3. Retome do **início da etapa** interrompida, nunca do meio: se a etapa tinha commit parcial, ou
   complete a etapa e commite, ou reverta o parcial. Nunca deixe etapa meio-commitada.
4. Rode o gate (Faixas 0, A e B) de novo (`gates.md` §1) — verde anterior a interrupção não vale.
5. Libere os locks órfãos com o critério do modo `locks`.

Se o rastro não permitir reconstruir com segurança o que a sessão morta já tinha feito (por exemplo,
push feito mas thread não respondida), **pergunte** em vez de refazer: resposta duplicada em thread e
barulho que o reviewer paga.
