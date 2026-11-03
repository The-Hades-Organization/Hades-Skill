# Branch `hades/local`

`hades/local` = a base (SHA fixado a cada reconstrução; `hades_base`: `branch.base` do perfil > `origin/<flow.base>` >
`origin/develop` sem perfil) + **merge** de cada PR do **conjunto**, em ordem
topológica (PR cuja base é outra PR do conjunto entra depois da base; entre irmãs, por número). Local e só local.

## Conjunto de PRs (`hades pr-set`, lido do `$D/prs.list`)

Sem `prs.list` (ou vazio) = `@me`: abertas não-draft do dono do `gh`. Com lista, cada linha é um número (inclui,
mesmo draft ou de outro autor), `@me` / `author:<login>` (abertas não-draft do autor) ou `-<n>` (exclui; vence).
`#` inicia comentário. Gerir com `prs.sh show|set|add|remove|reset`. Avisos do resolvedor (em `logs/pr-set.warn`):
PR não-aberta fica fora; PR empilhada sobre uma base que não está no conjunto entra, e o merge traz os commits da
base junto (ela não aparece como PR própria no STATUS). O `watch.sh` compara os heads do mesmo conjunto.

## `rebuild-branch.sh`

1. `git fetch`; `hades pr-set` → `prs.tsv` (ordem aplicada).
2. `git reset --hard <base>` (confere antes que a branch atual é `hades/local`).
3. Para cada PR: `git fetch origin pull/<n>/head:refs/hades/pr-<n>` e merge `--no-ff`.
   - **Stack desalinhada** (a base foi rebaseada e a PR de cima ainda está sobre o histórico antigo): detectada por
     `git merge-base --is-ancestor pr-<base> pr-<n>` falso → tenta primeiro o merge direto (entra limpo quando a PR
     já absorveu por merge a base ou outra PR do conjunto — #5277 sobre #5283 com a #5276 dentro, 29/09: o
     cherry-pick reaplicava os commits da #5276 e conflitava nos docs). Conflito no merge direto → aborta e aplica só
     os commits próprios com
     `git rev-list --no-merges --right-only --cherry-pick pr-<base>...pr-<n>` + `cherry-pick -x`. Em 28/09 a #4959
     sobre a #4937 dava 25 conflitos no merge direto e 3 pequenos no cherry-pick.
   - Conflito que o **rerere** resolve sozinho → commit automático (`rerere.autoupdate=true`).
   - Conflito novo → `CONFLITO-NOVO` no `rebuild.report` e para.
4. `fixups.sh` (quebras silenciosas) e `last-build.heads` / `last-build.develop` (o sha da base; o nome do arquivo ficou).

## PR que absorve outras do conjunto

Quando uma PR aberta absorve outras abertas (mesmo trabalho em fatias + a consolidada), as duas versões juntas
conflitam em dezenas de arquivos. Conferir que nenhum commit da fatia fica de fora:
`git rev-list --no-merges --right-only --cherry-pick refs/hades/pr-<consolidada>...refs/hades/pr-<fatia> | wc -l`
= 0 para cada fatia → `prs.list` com `@me` e `-<fatia>` para cada uma, e avisar o dono (ele pode preferir o contrário).

## Resolver conflito novo

- Pelo **conteúdo**, para as duas funcionalidades conviverem: nem "ganha a mais nova", nem "ganha a base".
  `hades keep-both <arquivos>` resolve os casos "duas adições no mesmo ponto" (barrels, índices, docs, construtores).
  Quando as duas adições são blocos abertos (`test("A", () => {`) e o git deixou o fechamento (`  });`) comum logo depois do
  conflito, o fechamento vale para cada lado: o primeiro bloco não fica sem fechar. Confira o resultado no fim do arquivo.
- Commitar, e anotar em `$D/conflicts.log` uma linha por par: `#A x #B: arquivos — como resolveu`.
- **Todo conflito é sinal de conflito no merge real** → a linha vai para o STATUS; ação sugerida vai em `notes.md`.
- Migration conflitante (duas PRs no mesmo serviço, ordem de timestamp, schema divergente) ou contrato sem resolução
  equilibrada: **não inventar** — tirar a PR mais nova do Hades, anotar e avisar.

## Quebra silenciosa (o git não acusa, o build quebra)

O rerere só reaplica hunks **em conflito**. Uma correção numa linha sem conflito (ex.: a #4968 moveu `isRefusal`
para `RegistryNamesAnswer` e a #4937 acrescentou uma chamada a `CamerasHttpClient.isRefusal`) precisa ir para o
`fixups.sh`, idempotente e guardado por condição, que commita `Hades: fixups`. Descobre-se pelo build.

## Ordem de migration

PR com migration de timestamp **anterior** à última da base aplica em ordem léxica em banco novo, mas fora de
ordem em banco existente. Não quebra o Hades; anotar em `notes.md`.
