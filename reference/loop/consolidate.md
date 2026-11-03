# Consolidação e stacks — `/hades consolidate`

Uma entrega com várias PRs abertas vira **uma PR de consolidação**: o conteúdo das originais entra nela por merge, o gate
roda uma vez nela e o dono mergeia só ela na base. Feita por um agente de consolidação (alocado com
`hades agent new <nome> --for consolidate --card <card> ...`), que roda `/hades consolidate <PR>... --orchestrated`.

Scripts: `hades consolidate`, de dentro da worktree da consolidação.

## Fluxo

| Passo | Comando |
|---|---|
| 1. ver o que entra, bases e empilhamento | `plan <PR>...` |
| 2. trazer cada original por merge | `merge <PR>...` (a de baixo antes da empilhada; conflito para: resolva pelo conteúdo, commite e rode de novo, o que já entrou é pulado) |
| 3. conferir antes de cada push | `verify <PR>...` (`merge-base --is-ancestor` do head de cada uma contra o HEAD) |
| 4. abrir a PR em draft | `gh pr create --draft --base <base>` com o título no formato do projeto (`ref deliver`) e a lista das originais no body |
| 5. avisar as originais | `comment <N> <PR>... --post` |
| 6. gate, uma vez, depois de **todas** as correções | `gates.md` §1.0 |
| 7. pronta | `ready <N> --post` (assignee e labels das Configurações, `gh pr ready`, **sem reviewers**) |
| 8. depois do merge pelo dono | `after-merge <N> <PR>... --post` (empilhadas: head na base e "conteúdo integrado pela #N") |

Sem `--post`, `comment`, `ready` e `after-merge` só mostram o que fariam.

## Regras

- **Conteúdo só por `git merge origin/<branch>`**, nunca cherry-pick, rebase ou squash: é o que faz as originais
  fecharem como *Merged*.
- `verify` passa para todas antes de cada push e no relatório.
- As originais não fecham e não mudam de base; cada uma recebe o comentário apontando para a consolidação.
- Review nas originais é corrigido **na original** (pelo agente dela) e espelhado na consolidação por `merge` de novo.
- Correção de falha de gate vai na PR dona do código e é propagada por merge. Só o que nasce da combinação das PRs ou do
  conflito com a base se corrige na consolidação. Depois, rode de novo só o que falhou.
- A consolidação **não pede review**: as originais já foram revisadas.
- O merge da consolidação **tem de ser "Create a merge commit"**: avise o dono sempre (o `ready` lembra).
- PR empilhada (base ≠ base do fluxo) fecha como *Closed*, não *Merged*: confira que o head dela está na base e comente
  (`after-merge`).
- Os bodies registram o gate: as originais dizem "gate na #N"; a consolidação traz o resultado.

## Stack sem consolidação

- Corrija e propague de baixo para cima, por merge.
- O gate roda no topo (`gates.md` §1.0).
- O dono mergeia em sequência; quando a base de uma PR entrar na base do fluxo, troque a base dela (`gh pr edit <n> --base <base>`).

## Mudança vinda de PR de outra pessoa

- Se a PR dela mergear antes, a sua passa a ter a base do fluxo.
- Conflito previsto com PR alheia vai no `handoff.md` e se resolve na consolidação, ou na hora se a outra já entrou.
