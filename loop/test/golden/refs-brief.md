# Brief — impl-r

Papel **impl**: siga `<SKILL>/reference/loop/roles/impl.md` (processo, espera, handoff, escalada, proibido). Trabalhe só em
`<T>/agents/impl-r`, nunca no clone principal. Este brief é o contrato do item; o que ele não disser, pergunte em
`.design-sync-reports/questions.md`.

## Item

<!-- O orquestrador preenche: o que entregar, specs a ler (caminhos), o que está fora do escopo e as decisões do dono já
tomadas, sem citar que foram perguntas. Confira nomes de eventos e contratos contra a spec antes de prescrever. -->

<!-- Escopo (a Vigília confere no DONE, `reference/cerberus/vigilia.md` §Regras de leitura): dois parágrafos, cada um começando pelo rótulo em negrito "Arquivos seus (e só estes):" e "Em voo junto com você, não toque:", com os caminhos entre crases (`dir/` é prefixo, `<x>` é curinga). Sem eles o escopo fica sem conferência. -->

## Contexto que evita retrabalho

<!-- PRs abertas de outras pessoas nos mesmos arquivos ("mudança aditiva, registre no report"), revisões ou achados
anteriores (com caminho), memórias úteis e o dono de cada arquivo compartilhado (do plan.md). -->

## Empilhamento

<!-- Só se houver: branch de base, trazer mudanças por merge no início de cada sessão e antes do review, trocar a base
com gh pr edit <n> --base <nova> quando a de baixo entrar, nunca commitar na branch de outra pessoa (registre em
.design-sync-reports/handoff.md o que acrescentou nos arquivos dela). -->

## Infra

- Modo `deliver` · card `SOFTWARE-777` · specs `—` · PR `—`
- Branch `svc/feat/SOFTWARE-777-x`, base `origin/develop` em `2af6177`
- Regras do projeto: `<T>/packs-refs/example-monorepo/loop/invariants.md`, `<T>/packs-refs/example-monorepo/loop/review.md`
- Lock `deliver-SOFTWARE-777.lock` (do orquestrador; não libere)
- Título da PR: `SOFTWARE-777 - [Módulo] Título`. Pronta: assignee `dono-x`, labels `backend,extra`, reviewers
  `rev-b,rev-c`, depois `gh pr ready`.
- Specs novas: owner `dono@example.invalid`, reviewers `rev-b`.
- Limites desta máquina: escalar depois de 2 ondas de gate falhando; estacionar se a fila do gate
  passar de 20 min.
