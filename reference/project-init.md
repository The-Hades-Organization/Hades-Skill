# `/hades project init` — gerar o perfil de um repositório

Um repo sem perfil é recusado pelo loop (`reference/projects.md`, código 3). O `project init` cria o perfil
(`hades.profile/1`) a partir do que o repo já diz sobre si, **pergunta ao dono o que não dá para saber** e só grava com o
ok dele. O agente conduz; `hades project-init` faz a leitura e a gravação.

```
/hades project init [--dry-run]
hades project-init draft <repo> [--name N] [--slug dono/repo] [--gh-user U] [--stage DIR] [--dry-run]
hades project-init save <rascunho-dir> <repo> --confirmed [--force]
```

## Fluxo (o que o agente faz)

1. **Pré-condição.** Repo git com `remote.origin.url` (sem ele: `--slug dono/repo`). Se `hades project resolve` já
   devolve 0, é um **re-run** (passo 6).
2. **Rascunho.** `hades project-init draft <repo>` escreve `~/.claude/hades/packs-draft/<n>/profile.json` (com `--dry-run`:
   uma pasta descartável, nada fica) e imprime JSON: `profile`, `evidence` (campo → arquivo:linha), `uncertain`
   (campo e o porquê), `stacks`, `quality` (`mapped`, `conflicts`), `valid`/`errors` e, num re-run, `diff` e `preserved`.
3. **Stacks.** `stacks.detected` vem do `detect` de cada pacote instalado (`hades project detect`) e entra em
   `stacks`. Nenhuma casou e há manifest: `stacks.offer` manda para o fluxo do `/hades stack add` (`reference/stacks.md`):
   **não se reimplementa aqui**; depois do `stack add` rode o `draft` de novo.
4. **Pergunta.** Uma `AskUserQuestion` por bloco, nesta ordem, sempre mostrando o valor inferido e **de onde veio**
   (`evidence`): identidade e conta do gh (`identity.gh` nunca é inferido: pergunte `user` ou `tokenEnv`) · fluxo e CI ·
   fonte de trabalho · commit, branch e card · regras (`rules.docs`, vocabulário de severidade) · mapeamento ao catálogo
   (cada id com a nota arquivo:linha; contradições em separado) · agentes de review. Cada item de `uncertain` vira
   pergunta explícita. Opções por bloco: aceitar, ajustar, descartar o bloco. Ajuste = edite o `profile.json` do rascunho
   e rode `hades project validate <rascunho>`.
5. **Gravar.** Só com o ok: `hades project-init save <rascunho-dir> <repo> --confirmed`. Valida contra
   `loop/schema/profile.schema.json`, grava `<packs>/<n>/profile.json`, faz `git init` + commit local no pacote e confere
   que o resolvedor devolve **0** nesse repo (a saída diz o código). Sem `--confirmed` recusa (saída 2); perfil inválido
   não grava nada (saída 1).
6. **Re-run.** Num repo com perfil o `draft` parte do perfil atual: o que o init **não infere** (`refs`, `env`, `pr`,
   `card.create`, `identity.gh|vocabulary`…) é preservado (`preserved`), o que ele infere sobrescreve o rascunho e o `diff`
   mostra a diferença. Mostre o diff ao dono; `save` de perfil que difere exige `--confirmed --force` (a saída repete o
   diff). Perfil idêntico: nada a gravar. Nunca sobrescreve calado.

## O que é inferido e de onde

| Campo | Fonte | Observação |
|---|---|---|
| `name`, `identity.repo`, `aliases` | `remote.origin.url`; dono e primeiro termo do nome | `aliases` só alimenta a guarda de nome; `vocabulary` e `gh` não se inferem |
| `flow.kind/base/ci` | workflow com `pull_request` (`branches`, filtro de draft); sem ele, `trunk` na branch padrão | sem CI de PR o `kind` fica incerto |
| `flow.bot` | workflow que reage a comentário com `@nome` (`startsWith`/`contains` no corpo) | `selfMarkers` lidos do texto que o workflow posta (`X_PROCESSED:`, linha com ⏳) |
| `work` | pasta de specs (a com mais `.md`: `docs/specs`, `specs`…), prefixos de ID dos nomes de arquivo e do guia; planos; fila | `specIdPattern` é lista de prefixos: confira |
| `commit` | commitlint/husky; `Conventional Commits` no texto; `footer` e `Co-Authored-By` lidos do CLAUDE.md/CONTRIBUTING | |
| `branch` | linha de documento com `branch` e um formato `` `<a>/<b>/<c>` `` | a `regex` é **gerada** do formato: sempre incerta |
| `card` | só com tracker suportado citado (`ClickUp`); IDs de linhas que falam de card/task-id/ticket | sem sinal: sem `card` (desligado) |
| `rules.docs` | regras de review (`.github/*rules*.md`), `CLAUDE.md`, aninhados (glob pelo pai), arquitetura, guias | a ordem é a de precedência |
| `rules.severity` | títulos `##…#### <PREFIXO><n>` (B1, RB-01…) com 3+ números por prefixo; nível pela seção (bloqueante/importante…) ou emoji | prefixo sem nível no texto: `media`, incerto |
| `stacks` | `detect` dos pacotes instalados | |
| `reviewAgents` | `.claude/agents/*.md`, `.claude/commands/*review*agents*` | |
| `env`, `refs`, `pr.labels` | — | ficam fora; o dono acrescenta (ou o pacote do projeto) |

## Regras e catálogo

Cada linha dos documentos de regra que casa com uma regra do catálogo vira entrada em `rules.quality[]` com o `id` de
`hades quality list --json`. A casa é por palavra-chave (tabela `QMAP` no script: um ERE por id), então é **evidência,
não prova**: a nota guarda o arquivo:linha para o dono conferir.

- **Só sobe severidade.** Nível da linha (palavra, emoji ou seção) maior que o do catálogo → `severity`; igual ou menor →
  entrada sem `severity`.
- **Contradição.** Linha com permissão (`permitido`, `pode usar`, `allowed`…) sem negação sobre um item do catálogo →
  `contradicts: true`. O rascunho é tratado como pacote (`HADES_PACKS_ROOT=<stage>`) e a seção **Conflitos de qualidade**
  vem do `hades quality conflicts`, a mesma do relatório da passada.
- **Sem par** no catálogo: a regra fica só nas regras do projeto (`rules.docs`).

## Limites

- Leitura de CI é por linhas, sem YAML completo: workflow com `on:` incomum cai em `trunk` e vira pergunta.
- Não conhece trackers além de ClickUp e GitHub; outro (Jira…) desliga o `card` e avisa.
- Não cria `refs`, `card.create`, `env` nem `vocabulary`: são do pacote e do dono.
- Nada é escrito no repo lido. Só `packs-draft/` e, com o ok, `<packs>/<n>/`.

## Prova de ida e volta

O init em `--dry-run` sobre uma cópia de um projeto real (sem `.git` nem `node_modules`, com `origin` ajustado) reproduziu
o perfil escrito à mão: identidade, `flow` (base, CI, bot e marcadores), `commit`, `stacks`, `reviewAgents`,
`work.specsDir`, `rules.docs` e `rules.severity` (prefixos, níveis e `codePattern`). O que difere fica de propósito:
`card` (o tracker não está no repo), `vocabulary`, `refs`, `env`, `pr.labels` e `description` (só o dono sabe),
`rules.quality` (o perfil escrito à mão não tem) e listas um pouco mais largas (`rules.docs`, prefixos de spec). Regressão:
`bun test loop/test/ts/init.test.ts` (fixtures `loop/test/fixtures/init/{nx,node}`).
