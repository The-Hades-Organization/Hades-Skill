# Modo inbox — reviews recebidos nas minhas PRs

Reconcilia o que os reviewers pediram: triagem do que já foi corrigido, correção do que vive,
resposta em toda thread tocada. Prioridade sobre trabalho novo.

Se existir `.design-sync-reports/quality.md` (`reference/quality.md`), aplique as regras ligadas ao corrigir.
Leia `gates.md` antes. **Uma PR por tick**, com lock adquirido. Relatório no formato de `reference/loop/report.md`.

## Escolher a PR

```bash
hades pr-loop-state --json            # ou --pr <n>
```

Ordem: o estado (`ci-red` → `conflict` → `needs-response` → `needs-triage` → `stale-base`) e, entre
PRs do mesmo estado, **o fundo da stack primeiro** (`stackDepth` menor). A filha vai rebasear de
qualquer forma; corrigir a mãe primeiro evita fazer o mesmo trabalho duas vezes. O coletor já entrega
ordenado.

`ci-red` e `conflict` vem antes de qualquer achado de review: PR que não builda ou não mergeia não
tem o que discutir.

Antes de agir, olhe `warnings[]` e `requestedMissing` (`collector.md`): aviso de truncamento na PR
escolhida significa que pode haver achado fora da página — trate a PR com `--pr <n>` e registre.
Coletor com `exit != 0` aborta o tick.

## Fase 0 — triagem (`isResolved=false AND isOutdated=true`)

Em repo onde ninguém resolve thread (`ref review` diz se é o caso), a maioria das threads abertas já foi corrigida por
um push posterior. Sem esta fase, o loop reprocessa trabalho feito.

Para cada thread a triar:

1. Leia o comentário e localize o alvo por `path` + `originalLine` (thread outdated tem `line: null`).
2. Confira **contra o código atual** se o achado ainda procede. Ache o commit que mudou aquilo:
   `git log -S '<trecho>' --oneline -- <path>`, ou `git log -L <linha>,<linha>:<path>`.
3. Destino:
   - **Já corrigido** → responda na thread citando o commit (`aplicado em <sha> — <o que mudou>`) e
     **resolva**. `verdict: stale-fixed`.
   - **Ainda vive**, apesar de outdated → entra na fila da Fase 1. Não responda ainda.
   - **Indeterminado** (não consegue afirmar) → responda pedindo confirmação do reviewer, **deixe
     aberta**, `verdict: indeterminate`. Nunca resolva por conveniência.

Thread com `reopened: true` — o reviewer respondeu depois do seu veredito — volta para a Fase 1
independentemente do veredito anterior. Foi justamente isso que ele contestou.

Resolver thread e mutação GraphQL (o `gh` não tem comando próprio):

```bash
gh api graphql -f query='mutation($t:ID!){ resolveReviewThread(input:{threadId:$t}){ thread{ isResolved } } }' -F t=<threadId>
```

Responder dentro da thread (mantem o encadeamento, não cria comentário solto):

```bash
gh api repos/<owner>/<repo>/pulls/<n>/comments/<commentDatabaseId>/replies -f body='<texto>'
```

## Fase 1 — achados vivos: veredito por item

**Aqui o fluxo deixa de ser um aplicador cego.** Todo achado recebe um dos três destinos, e o
critério é explícito.

### `aplicar`

O achado é válido e acionável. Entra no checklist. `verdict: applied`.

### `refutar`

O achado está errado, e você consegue mostrar por que. Responda na thread com a justificativa
concreta (regra citada, arquivo:linha, ou o trecho da spec), **não mexa no código** e **não resolva a
thread** — quem fecha é o humano. `verdict: rebutted`.

Thread refutada continua contando como pendente: ela **bloqueia `done-pending`** e aparece no
relatório como "esperando reviewer", mas não volta para a fila de ação — o loop não insiste no que
já argumentou. Se o reviewer responder, ela reabre.

Antes de aceitar qualquer achado, confira as exceções documentadas do projeto (`ref review`): há padrões que o time
**corretamente** rebateu e que reviewers reincidem em apontar.

Refutar também cabe quando o pedido **contraria regra documentada** — mas nesse caso o destino
preferencial é `escalar`, porque a divergência é entre o reviewer e o repo, não entre o reviewer e você.

### `escalar`

Vai para `## Itens para discussão` no relatório, com **problema claro e alternativas descritas**, e
entra em `escalations`. Antes de escalar, cheque `decisions`: pergunta já respondida em tick anterior
se aplica, não se repergunta. Escale quando o pedido:

- tem impacto de performance, carga, concorrência ou volume;
- contraria regra documentada do projeto (`rules.docs` do perfil, `ref review`);
- exige mudar contrato ou spec **aprovada**;
- é incompatível com o que outro reviewer pediu na mesma PR;
- pede quebra de contrato público sem caminho aditivo, migration com lock pesado ou janela de deploy (os casos do
  projeto estão em `ref review`).

O resto da PR continua sendo trabalhado enquanto a escalação espera. Não pare a PR inteira por um item.

### Promover severidade

**Pedido reincidente é bloqueante.** Se o reviewer já pediu aquilo antes na mesma PR e não foi
atendido, o item vira 🔴 mesmo que a regra o classifique como 🟡. Sinais que o coletor
entrega para detectar: `commentCount > 1` com `lastReplyAuthor` sendo o reviewer, `reopened: true`, e
thread antiga com o mesmo `ruleCode` no histórico daquela PR.

### Ler o achado

- Comentário de bot abre com o código da regra — o coletor já extrai (`ruleCode`, por `rules.severity.codePattern`
  do perfil). Código dado, aplique a regra correspondente do documento de regras do projeto (`ref review`).
- Comentário **humano** frequentemente não tem código e vale igual ou mais: leia inteiro, incluindo as
  respostas da thread (`commentCount > 1` avisa que há mais do que o primeiro comentário). Separe bot
  de humano por `fromBot`.
- Achado sobre comentário de código exige a regra de comentário do projeto citada (`ref review`). Sem regra aplicável,
  **não há achado** — e se o pedido for remover referência de rastreabilidade, isso é `refutar` quando o projeto a
  exige: apagar a âncora e regressão.

### Comentário top-level (fora de thread)

`topLevelLive` e `ciReviewSummary` existem porque nem todo pedido vira thread:

- **Humano** (`topLevelLive`) — pedido solto no corpo da PR. Vale como achado, e recebe o mesmo
  veredito dos três destinos. Não tem `path`/`line` nem `isOutdated`: a única memória é
  `comments[<databaseId>]` no estado — sem gravar o veredito, o pedido é eterno. Responda com
  `gh pr comment` referenciando o que mudou e em qual commit.
- **Bot** (`ciReviewSummary`) — o resumo do bot do perfil, postado com `gh pr comment` (por isso não é
  review nem thread). **Leia sempre**: é onde estão o veredito e todo achado que caiu fora de hunk e
  por regra foi para o corpo. Ele não dirige estado; os achados dele entram na fila como qualquer
  outro.

## Fase 2 — corrigir

1. Checklist priorizado em `<work>/checklist-pr-<n>.md`, com ondas por dependência, arquivos-alvo e
   validação por etapa.
2. Ondas conforme `gates.md` §6 — paralelo só para arquivos disjuntos, agente não commita, agente não
   introduz comentário, e cada onda fecha na validação granular (`ref gates` diz o comando; `gates.md` §6,
   item 5), não na suite completa. Teto de ondas por `--max-iters` (padrão 3), contado em
   `reviewRounds`, que **persiste entre ticks**: retomar uma PR não zera a contagem.
3. Gate das Faixas 0, A e B (`gates.md` §1) **uma vez**, no fim: Faixa 0 (varredura barata), Faixa A (completa nos
   projetos tocados), Faixa B (ripple). Cada comando sob `gate-lock.sh run`, integração imediatamente
   antes do push. `75` = enfileirado: cede o tick sem push, mantendo o lock da PR.
4. Commit por etapa: `fix: aplica os achados do review da <spec/PR>` com footer `Spec:`/`Fixes:`.

Sem fan-out de `/review-agents` aqui. A re-verificação é um **único** subagente de re-review com
contexto limpo, ou revisão inline — salvo se o dono pedir o fan-out explicitamente.

## Fase 3 — push e resposta

Todo texto postado nesta fase (itens 3 a 7) passa antes pelo Cerberus (`reference/cerberus.md`): corpo exato num
arquivo e `hades cerberus avaliar comentario --ctx pr=<n> --ctx texto=<arquivo>`; saída 1 = não poste.

1. Guarda de push (`gates.md` §2). Upstream que não casa com o `headRefName` da PR = **recusa**.
2. Push.
3. Em **cada** thread aplicada: responda o que mudou e em qual commit, e **resolve**.
4. Threads refutadas: resposta com justificativa, **sem** resolver.
5. Threads indeterminadas: pergunta, **sem** resolver.
6. Comentários top-level humanos tratados: resposta com o commit, e veredito gravado em `comments`.
7. Se a base é coberta pelo bot (`flow.bot.bases`) e o head mudou materialmente desde o último gatilho: comente
   `flow.bot.mention <foco>` (um por push). Se a PR é empilhada, o bot não roda e a tentativa deixa ruido — não tente
   (`deliver.md` Passo 10).
8. Grave o shard da PR (`gates.md` §4): `threads`, `comments`, `lastClaudeTrigger`, `reviewRounds` e
   **`lastSeenReviewAt`** — este último sempre, mesmo quando não havia nada a fazer, senão um approve
   sem comentário deixa a PR acionável para sempre.
9. Libere o lock.

## Casos especiais

**`ci-red`** — leia a falha real (`gh pr checks <n> --json name,state,bucket,link` e o log do job),
não adivinhe. Falha de validador de artefato gerado normalmente é artefato fora de sync, não código: regenere pelo
script do projeto em vez de editar a mão (`ref review` lista os validadores).

**`ci-running`** — não reprocesse: o resultado muda em minutos. Modo `watch` (`ops.md`).

**`conflict` e `stale-base`** — procedimento único na cascata #2 (`cascade.md`): merge da base na
branch, nunca rebase. Conflito que exige decidir semântica **escala**.

**`draft`** — nenhum job de CI roda em draft. Reporte e sugira `ready_for_review`; não tire do draft
por conta própria (pode haver razão).

**`no-ci`** — PR empilhada (ou que nunca disparou CI) não tem evidência de CI nenhuma. O gate local é
a única que existe: rode-o, registre no relatório de onde saiu, e **nunca** reporte a PR como pronta
por ausência de check.

**PR sem branch local** — várias PRs vivem em outro clone. Busque de `origin`
(`git fetch origin <headRefName>` + checkout local ou `gh pr checkout <n>`), nunca assuma que a branch
local existe ou está atualizada. Worktree sem dependências não roda gate (`gates.md` §1).

## Relatório

Formato único em `reference/loop/report.md`. O bloco deste modo carrega: estado antes → depois, aplicados,
refutados, triados, esperando reviewer, gates com o resultado real, avisos do coletor, e as
escalações — as desta passada e as que continuam abertas de passadas anteriores.
