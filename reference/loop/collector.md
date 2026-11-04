# Coletor — `hades pr-loop-state`

Fonte única do "em que ponto do ciclo cada PR está". **Read-only por contrato**: lê do GitHub e do
estado local, nunca escreve. Quem escreve é a sessão do loop.

```bash
hades pr-loop-state --help
```

## Flags

| Flag                    | Modos                         | Efeito                                                                                                             |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| _(nenhuma)_             | inbox, deliver, ready         | PRs abertas do usuário autenticado                                                                                 |
| `--author <login>`      | review                        | PRs abertas desse autor                                                                                            |
| `--others`              | review, deliver               | PRs abertas de qualquer autor exceto o dono                                                                     |
| `--pr <n>`              | inbox, review, cascade, watch | Restringe a PRs específicas; repetível                                                                             |
| `--repo <owner>/<name>` | todos                         | Alvo explícito, para rodar fora de um clone                                                                        |
| `--state <file\|dir>`   | todos                         | Diretório shardado (novo) ou `state.json` (legado). Default: `<work>/state/` com fallback para `<work>/state.json` |
| `--limit <n>`           | todos                         | Teto de PRs buscadas (default 60). Corte vira `warnings[]`                                                         |
| `--json`                | todos                         | Saida JSON completa (default: tabela compacta)                                                                     |

O default do `--state` já aponta para o diretório de trabalho do repo resolvido — **não passe
`--state` a mão** salvo para inspecionar um estado alternativo.

## Falhas, vazio e truncamento

Três coisas diferentes que o loop não pode confundir:

- **`exit 1`** — falha (sem `gh`, sem rede, GraphQL com erro, timeout de 90 s). A mensagem vai para
  stderr e **não há JSON**. Aborte o tick: coleta inválida não autoriza escrita.
- **`exit 3`** — o repo não tem perfil de projeto (`4`: fora de repo com origin). O coletor recusa e a mensagem aponta
  `/hades project init`; não há valores legados.
- **`exit 0` com `prs: []`** — coleta válida e vazia. Nada acionável nesse escopo.
- **`exit 0` com `warnings[]` não vazio** — houve dado cortado ou indisponível. **Vazio depois de um
  aviso não significa "nada a fazer".** Se o aviso afeta o alvo (ou pode esconder um), reporte e
  resolva antes de agir.

Tipos de aviso:

| `kind`                | Significa                                                        | O que fazer                                   |
| --------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| `search-truncated`    | há mais PRs no escopo do que o teto coletou                      | Suba `--limit` ou estreite o escopo           |
| `threads-truncated`   | PR com mais threads do que a página (100)                        | Trate a PR com `--pr <n>` e diga no relatório |
| `reviews-truncated`   | mais reviews do que a página (40): `lastReviewAt` subestimado    | Não confie em `awaiting-review` nessa PR      |
| `checks-truncated`    | mais checks do que a página (40): check falhando pode estar fora | Confirme com `gh pr checks <n> --json ...`    |
| `comments-truncated`  | mais comentários top-level do que a página (30)                  | Leia a PR direto antes de fechar              |
| `merge-state-missing` | PR fora do teto de 200 abertas: sem `mergeStateStatus`           | `conflict`/`stale-base` indetectáveis ali     |
| `state-unreadable`    | shard ou monolito ilegível                                       | **Pare**: idempotência perdida                |
| `state-version`       | estado escrito por versão mais nova                              | **Não escreva**; atualize o coletor           |

Por que os tetos existem: `search` + `reviewThreads` com `--paginate` foi **medido** estourando o
timeout de 120 s. O preço da página única é o corte — o que o coletor garante e que o corte nunca é
silencioso.

## Saida

Campos por PR que o fluxo consome (`--json`):

- **Identidade**: `number`, `title`, `url`, `author`, `isDraft`, `baseRefName`, `headRefName`,
  `headRefOid`, `labels`, `stacked`, `claudeEligible` (base em `flow.bot.bases`), `ciEligible` (base em
  `flow.ci.bases` e, se `flow.ci.draft` for falso, não-draft).
- **Estado**: `state` (ver `SKILL.md` §"Máquina de estados"), `mergeable`, `mergeStateStatus`,
  `reviewDecision` (informativo, **não** é gate), `stackParent`, `stackDepth`.
- **Achados**: `live` (acionável), `triage` (outdated), `awaitingReviewer` (refutado/indeterminado),
  `topLevel` + `topLevelLive` (comentário solto humano), `ciReviewSummary` (o resumo do bot do perfil),
  `threads` (todas), `unresolved`, `threadTotal`.
- **Thread**: `path`, `line` (cai para `originalLine` quando outdated), `ruleCode`, `excerpt`,
  `author`, `fromBot`, `commentId`, `verdict`/`verdictAt`, `reopened`, `commentCount`, `lastReplyAt`,
  `lastReplyAuthor`, `lastReplyFromMe`.
- **Tempo**: `lastPushAt` (`committedDate` do head — `pushedDate` foi depreciado), `lastReviewAt`,
  `lastSeenReviewAt`, `reviewedSincePush`, `unseenReviewSincePush`.
- **CI**: `checks.verdict` (`green|red|pending|none`), `checks.failing[]`, `checks.pending[]`,
  `checks.passing`, `checks.state`.
- **Rastreabilidade**: `specIds` (do body, por `work.specIdPattern`), `cardIds` (do título e da
  branch, por `card.idPattern`), `lastClaudeTrigger`.

No topo: `repo`, `login`, `scope`, `workDir`, `stateSources`, `stateVersion`, `totals`,
`requestedMissing` e `warnings`.

`requestedMissing` lista as PRs pedidas com `--pr` que não estão no escopo aberto (mergeada, fechada,
ou de outro autor). Ela sai **no JSON**, não apenas em stderr: PR pedida que volta vazia seria lida
como "nada a fazer" naquela PR.

## Consumo por modo

```bash
# inbox / default: minhas PRs, ordenadas por estado e por fundo da stack
hades pr-loop-state --json

# inbox de uma PR especifica
hades pr-loop-state --json --pr 1689

# review: candidatas de terceiros (dedup por cardIds do proprio coletor)
hades pr-loop-state --others --json

# status/ready: leitura humana
hades pr-loop-state
```

A ordenação já vem pronta: estado (na ordem de prioridade), depois `stackDepth` crescente (fundo da
stack primeiro), depois número. Não reordene sem motivo declarado.

## Reuso e limites

Serve qualquer clone e qualquer repo (`--repo`), mas as **regras** que o fluxo aplica são do
projeto (`ref invariants`). O coletor não sabe nada de gate, spec ou lock: quem cruza `specIds` com a fila de specs,
quem trava a PR e quem decide o que fazer com um estado é a skill. Se algo do coletor precisar de
regra de negócio, o lugar é a skill, não o script.
