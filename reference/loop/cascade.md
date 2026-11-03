# Cascata — os quatro sentidos

`/hades cascade [--pr N]`. Também roda embutida no `inbox` e no `deliver` quando o estado pede. O
sentido #3 tem superfície própria: `/hades sweep`.

## #1 — Stack de PRs dependentes

A maioria das PRs vive empilhada (base != a base do fluxo), então corrigir uma PR do meio propaga para as
filhas. Use a skill/extensao **`gh-stack`**, e respeite as regras que a tornam automatizável:

- **Tudo non-interactive.** Prompt pendura a sessão indefinidamente.
- `gh stack view` **sempre com `--json`** — sem isso abre TUI.
- `gh stack submit` **sempre com `--auto`**.
- `init`/`add`/`checkout` sempre com o nome da branch como argumento posicional.
- Mudança em camada inferior: `gh stack down`/`checkout` → commit → `git merge` da camada de baixo em cada
  camada acima, de baixo para cima (nunca rebase: as branches estão sob review, §#2) → voltar ao topo.
- **`gh pr merge` não funciona em stack.** Merge seria `gh stack merge --yes` — e **este fluxo não
  faz merge**, então isso é informação para o dono, não ação do loop.
- Branch compartilhada entre stacks devolve **exit 6**: pare e reporte.

Ordem de trabalho: **fundo da stack primeiro** (`stackDepth` menor no coletor). A filha recebe o
merge de qualquer forma.

Depois de propagar, **cada** PR filha afetada precisa do gate das faixas do projeto (`gates.md` §1), sob a fila
de gate (`gates.md` §3.2) e uma filha por vez — nunca duas em teste. Não herde o verde da mãe. Se
a propagação gerar conflito, resolva os triviais e **escale** o resto.

## #2 — Base defasada (`stale-base` / `conflict`)

Este é o procedimento **canônico** para os dois estados; `inbox.md` (Fase 3) aponta para cá em vez de
repetir.

**Merge da base na branch, nunca rebase.** A branch está sob review: rebase reescreve o que os
reviewers ancoraram, invalida threads e apaga a correspondência entre comentário e linha. A prática e
merge da base na branch (`ref review`).

```bash
git fetch origin <base>
git merge origin/<base>         # nunca rebase, nunca --force depois
```

Depois do merge: gate das faixas do projeto (`gates.md` §1), e só então push. Conflito trivial e mecânico resolve-se aqui;
conflito que exige decidir semântica **escala**.

Meca o drift antes de decidir, em vez de estimar:

```bash
git rev-list --count HEAD..origin/<base>      # commits que a base andou
git diff --shortstat HEAD...origin/<base>     # tamanho do que vem no merge
```

Acima de **200 commits** de drift, ou diff de merge maior que a própria PR, **avise o dono antes de
mergear**: o merge vai ser grande, o review vai ficar ilegível, e talvez a PR precise ser refeita em
vez de reconciliada. Abaixo disso, siga.

## #3 — Achado sistêmico em PRs irmãs (modo `sweep`)

`/hades sweep [--pattern <descricao>]`

Um achado que revela **padrão**, não caso isolado, vale para as outras PRs abertas que compartilham o
padrão. Sinais de que é sistêmico: o mesmo erro sem i18n em vários serviços, o mesmo handler
sem idempotência, a mesma coluna com tipo errado, o mesmo comentário proibido copiado da spec (exemplos do projeto em
`ref review`).

Procedimento:

1. Localize as PRs irmãs afetadas (busca pelo padrão no diff de cada uma).
2. **Não aplique em silêncio.** Registre em `cascades[<slug-do-padrao>]` = `{ pattern, found[],
queued[], reportedAt }` (`gates.md` §4) e relate ao dono. O registro é o que faz o achado
   sobreviver ao fim do tick — sem ele, cada passada redescobre o mesmo padrão e nada é feito.
3. O item enfileirado entra no checklist da PR dona **quando aquela PR for o alvo do tick**, junto dos
   achados de review dela. `sweep` enfileira; quem aplica é o `inbox`.
4. Nunca mexa numa PR que já está em `done-pending` (sem pendência e CI verde) sem perguntar: reabrir
   ciclo de review numa PR pronta é custo que o dono tem de escolher pagar.
5. Se o padrão está na base e não no diff, é dívida técnica: proponha PR própria, não contrabandeie
   a correção numa PR de feature. Essa PR nasce pelo `deliver`, e **com card** quando o perfil usa — pelo caminho de
   `deliver.md` Passo 3 (trabalho sem spec).

## #4 — Próxima PR atômica da mesma fase

Fechada a PR atômica atual (a menor entrega do plano; PR aberta e entregue ao `inbox`), o modo `deliver` puxa a próxima PR atômica da **mesma
fase** do plano de fases do item pai.

Uma fase não deve ficar a meio caminho entre PRs por muito tempo: se a Fase 1 previa 3 PRs, as 3 vão
antes de começar a Fase 2, senão o plano de fases perde significado. Quando a fase fecha, reporte ao
dono e pergunte antes de entrar na fase seguinte — mudança de fase é ponto natural de decisão.
