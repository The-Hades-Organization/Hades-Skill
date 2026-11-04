# Projetos, plugin e instâncias: perfil, stack, catálogo, plugin do Hades e várias instâncias

O núcleo da Hades não cita projeto: o que muda de um repositório para outro vem de um **perfil de projeto**, dos
**pacotes de stack** que ele usa e do **catálogo de qualidade** da máquina. Este arquivo é o contrato desses formatos e
de como o núcleo os lê.
Regra de fundo: o núcleo vale para qualquer projeto e só lê o que o perfil e o plugin declaram.

Índice (a ordem do arquivo):
- **Formatos e resolução:** §Onde ficam · §Por que JSON · §Perfil de projeto · §Pacote de stack · §Catálogo de qualidade · §Resolvedor do projeto ativo · §Criar o perfil · §O que o núcleo lê do perfil · §Guarda de nome e regressão · §Exemplo.
- **Plugin do Hades** (o pacote do projeto): §Plugin do Hades, com §Conteúdo do pacote de projeto, §Gerir pela página Plugins e pelo `plugins.sh`, §Pontos de extensão do ambiente (`env/`) e §Legado (núcleo < 5).
- **Instâncias e serviços:** §Várias instâncias · §Serviços de apoio no macOS: `hades svc`.

## Onde ficam

| O quê | Caminho | Raiz configurável |
|---|---|---|
| Perfil de projeto | `<packs>/<projeto>/profile.json` (o pacote é o **plugin do Hades** do projeto: um repositório git próprio, §Plugin do Hades) | `HADES_PACKS_ROOT` > `~/.claude/hades/packs-root` (uma linha) > `~/.claude/hades/packs` |
| Pacote de stack | `<stacks>/<stack>/stack.json`, depois `<skill>/stacks/<stack>/stack.json` | `HADES_STACKS_ROOT` > `~/.claude/hades/stacks-root` > `~/.claude/hades/stacks` |
| Catálogo de qualidade | `~/.claude/hades/quality/*.json` | — |
| Escolhas do usuário | `~/.claude/hades/quality/choices.tsv` | — |
| Esquemas | `loop/schema/{profile,stack,quality}.schema.json` | — |

Um pacote de projeto pode ter testes `test/*.test.ts` (`bun test`): prova que o perfil
reproduz o comportamento gravado. O `skill-release.sh check` roda o de cada pacote instalado.

## Por que JSON

Bash (`jq`, já exigido pelo loop) e TypeScript (`JSON.parse`) leem sem dependência nova. TSV não representa
listas e objetos aninhados (vocabulário de severidade, marcadores do bot, etapas da stack); YAML e TOML exigiriam
parser novo em bash. TSV fica onde a estrutura é plana e o usuário edita à mão: `choices.tsv`.

Regex nos arquivos é **ERE comum** (`x-regex: ere` no esquema): tem de valer igual em `grep -E`, `re` e `RegExp`. O
validador reprova `\d`, `\D`, `(?…)`, quantificador preguiçoso, `\p{…}` e `[[:classe:]]` (não existe no `RegExp` do Bun).
`\b` e `\s` fora de colchete valem nos três.

## Perfil de projeto (`hades.profile/1`)

Obrigatórios: `schema`, `name` (igual à pasta), `identity`, `flow`. Exemplo mínimo:

```json
{
  "schema": "hades.profile/1",
  "name": "exemplo",
  "identity": { "repo": "dono/exemplo", "gh": { "tokenEnv": "EXEMPLO_GH_TOKEN" } },
  "flow": { "kind": "pr", "base": "main", "ci": { "workflow": "ci.yml", "bases": ["main"], "draft": false } }
}
```

| Campo | O quê | Ausente |
|---|---|---|
| `identity.repo` | `owner/name` do `remote.origin.url` (sem caixa): é a chave do resolvedor | — |
| `identity.gh.user` · `.tokenEnv` | conta do gh do projeto: `tokenEnv` (variável com o token) vence `user` (`gh auth token --user`); `GH_TOKEN`/`GITHUB_TOKEN` do ambiente vencem os dois. Não troca a conta ativa | conta ativa |
| `identity.aliases` | outros nomes do projeto (só para a guarda de nome; achados em qualquer posição e sem caixa: `nome_x`, `WEB_NOME`) | — |
| `identity.vocabulary` | ERE de nomes que só existem naquele projeto (serviços, scripts do ambiente), só para a guarda de nome | — |
| `core` | faixa de versões do núcleo que o plugin suporta (semver simples: `>=5`, `>=5.1 <6`, `5.1.x`; §Plugin do Hades; o contrato atual exige uma faixa que não admita núcleo anterior ao 5). O `install.sh` recusa núcleo fora dela | sem faixa: tudo vale, com aviso no `validate` |
| `domainTerms` | arquivo do pacote (relativo a ele, ex.: `domain-terms.txt`) com o vocabulário de domínio que o núcleo não cita: um termo ou ERE por linha (sem caixa), `#` comenta, `@allow <glob>` declara arquivo do núcleo ainda acoplado (dívida aberta, relativo à raiz da skill). Só para a guarda de domínio (§Guarda de nome e regressão, item Guarda de domínio) | sem guarda de domínio |
| `flow.kind` · `.base` | `pr` (PR contra `base`) ou `trunk` | — |
| `flow.ci.workflow` · `.bases` · `.draft` | workflow de CI de PR, bases em que roda, se roda em draft | `CI`, `[base]`, `false` |
| `flow.reviewRequired` | `false`: review humano não é pré-condição de `done-pending`; `awaiting-review` só com review pedido (`reviewRequests`) ainda não feito | `true` (sem review depois do push = `awaiting-review`) |
| `flow.bot.mention` · `.bases` · `.selfMarkers` | bot de review por menção, bases em que roda, marcadores dos comentários dele (`{pattern, multiline}`) | sem bot |
| `work.sources` | `spec` · `plan` · `queue` · `card` | — |
| `work.specsDir` · `.specIdPattern` | pasta das specs e regex dos IDs | sem spec |
| `rules.docs` | regras do projeto (caminhos, glob ok) | — |
| `rules.severity.codePattern` · `.vocabulary` | regex do código de regra no começo do comentário e `[{prefix, level, meaning, doc}]` | sem código |
| `commit.format` · `.regex` · `.footer` · `.coAuthor` | formato de commit | — |
| `branch.format` · `.regex` · `.base` | formato da branch (texto para o uso), regex, ref de base do worktree | `origin/<flow.base>` |
| `card.provider` · `.required` · `.idPattern` · `.newIdPattern` · `.example` | `clickup` · `github` · `none`; card obrigatório; regex dos IDs aceitos e do ID que nasce na branch; exemplo do uso | sem card |
| `card.create` | script do pacote (relativo a ele) que cria o card: `card-create.sh <título> <tags> <descrição>` imprime o ID; é o que `hades agent new --new-card` roda | `--new-card` recusa |
| `thanatos.fixBranchPattern` · `.fixLabels` | ERE (sem caixa) da branch de fix de produção e labels da PR que a marcam; o `hades watch` sugere o post-mortem ao ver essa PR mergeada (`reference/thanatos.md`) | não sugere |
| `pr.labels` | labels que a consolidação e o orquestrador aplicam à PR | nenhuma |
| `refs` | nome → arquivo do pacote com o texto específico do projeto: `invariants`, `deliver`, `gates`, `review`, `spec` (abre com `hades project ref <nome>`); o plugin com `env/` também declara refs `env-*` (ex.: `env-extensions`, o `env/reference/extensions.md`, §Pontos de extensão do ambiente) | só o núcleo |
| `stacks` | nomes de pacotes de stack | — |
| `reviewAgents.command` · `.dir` | agentes de review do repositório | — |
| `env.pack` | pacote de ambiente local (pasta relativa ao pacote) | sem ambiente |

## Pacote de stack (`hades.stack/1`)

Os pacotes que acompanham a skill e a fila que os lê estão em `reference/stacks.md`.

```json
{
  "schema": "hades.stack/1",
  "name": "pnpm-next",
  "detect": { "files": ["pnpm-lock.yaml", "next.config.*"], "all": true },
  "steps": {
    "typecheck": { "cmd": "pnpm tsc --noEmit", "kind": "build", "costGb": 2 },
    "lint": { "cmd": "pnpm eslint {files}", "kind": "lint", "costGb": 1, "parallel": 2 }
  },
  "guard": { "patterns": ["(^|[;&|]|\\s)pnpm\\s+(next\\s+build|vitest|eslint)"] }
}
```

`steps` aceita `typecheck`, `lint`, `build`, `test`, `integration`, `affected`; cada etapa tem `cmd` (`{files}` = arquivos tocados),
`kind` (tipo da fila de gates), `costGb` (pico medido), `parallel` e `measuredAt` opcionais. `guard.patterns`: comando
cru que o hook manda para a fila (regra da máquina, vale para toda stack instalada).

## Catálogo de qualidade (`hades.quality/1`) e escolhas

Só o formato; o conteúdo e a página: `reference/quality.md`.

```json
{
  "schema": "hades.quality/1",
  "rules": [
    { "id": "ts.no-any", "group": "linguagem", "text": "Sem any implícito ou explícito em código novo.",
      "severity": "alta", "default": "on", "tags": ["typescript"], "check": { "kind": "grep", "pattern": ":\\s*any\\b", "files": "*.ts" } }
  ]
}
```

`group`: `linguagem` · `framework` · `praticas` · `estilo` · `testes` · `banco`; `severity`: `bloqueante` · `alta` ·
`media` · `baixa`; `check` opcional: `kind` `grep` (`pattern` nos `files` do diff) ou `cmd`. `choices.tsv` (uma linha
por regra mudada, `#` comenta):

```
ts.no-any	off
```

`rules` é opcional: um arquivo pode trazer só `packs` (`quality/packs.json` no base, ou do usuário):

```json
{ "schema": "hades.quality/1",
  "packs": [ { "id": "frontend", "title": "Frontend", "text": "Interface no navegador…", "rules": ["fw.acessibilidade-basica"] } ] }
```

Pacote é lista de `id` (a regra pode estar em vários); não tem estado próprio em `choices.tsv` (§Pacotes de
`reference/quality.md`).

Uso, injeção e relatório de conflito: `reference/quality.md`. O perfil cita itens do catálogo em `rules.quality[]` (`{id, severity?, contradicts?, note?}`): só sobe severidade ou declara contradição.

**Precedência**: invariantes > pedido do dono > regras do projeto > catálogo ligado > código vizinho. O perfil
pode **subir** a severidade de um item, não desliga item global ligado; conflito vai ao relatório.

## Resolvedor do projeto ativo

Projeto ativo = `remote.origin.url` do diretório atual → `owner/name` → o `profile.json` cujo `identity.repo` casa.
Uma implementação por linguagem, todas lendo os mesmos arquivos e com a mesma saída (a regressão compara as duas):

| Linguagem | Onde | Uso |
|---|---|---|
| bash | só a casca `loop/bin/lib.sh` (`hades_ts`); resolve pela CLI `hades project` | scripts do kit que ainda restam |
| TypeScript | `src/lib/project.ts`, `src/lib/profile.ts` (`resolveProject`, `loadProfile`, `profileGet`, `stackFile`) e `hades project …` | hook, painel, coletor, `check` |

```
hades project resolve [<dir>]                  {project, profile, repo, root, packs}
hades project get <campo.a.b> [<padrão>] [--dir <d>]
hades project pack [<dir>]                     pasta do pacote do projeto ativo
hades project ref <nome> [--dir <d>]           arquivo refs.<nome> do pacote (caminho absoluto; sai 1 se não declara)
hades project core-check [--dir <d>]           o `core` do perfil contra a VERSION do núcleo (§Plugin do Hades); sai 1 fora da faixa
hades project names | packs | validate [<arquivo>…]
```

Códigos: **0** com perfil · **3** repo sem perfil (mensagem aponta `/hades project init`) · **4** fora de repo com
`remote.origin.url`. **Sem perfil o loop recusa**: o coletor, o `hades agent new|adopt|review` e o `hades consolidate`
saem com 3 e a mensagem (`project_need` no bash); `get` só devolve o padrão que o chamador passou. O hook segue só com as
regras da máquina. Criar o perfil é o `/hades project init` (abaixo).

## Criar o perfil: `/hades project init`

Repo sem perfil (código 3) ou perfil a atualizar: o agente lê o repo, monta o rascunho com a evidência de cada campo,
mapeia as regras do projeto ao catálogo (`rules.quality[]`), aponta as stacks e só grava com o ok do dono. Num repo com
perfil mostra o diff e nunca sobrescreve calado. Fluxo completo, heurísticas e limites: `reference/project-init.md`.

## O que o núcleo lê do perfil

- **Coletor** (`hades pr-loop-state`): base, bases e draft do CI, nome do workflow, bot (menção, bases, marcadores),
  código de regra, IDs de spec e de card, conta do gh. O relatório ganha `project` e `profile`.
- **hades agent**: base do worktree (`branch.base`), formato da branch no uso, exemplo de card, ID do card a partir da
  branch (`card.newIdPattern`); card só se `card.provider` ≠ `none` (sem card no perfil = sem card, a chave da entrega é o
  slug da branch); `--new-card` roda o `card.create` do pacote; labels de `pr.labels`; o brief ganha `{{TITULO}}` e a linha
  `Regras do projeto: {{REFS}}` (apagada se o perfil não tem `refs`).
- **hades consolidate**: base (`flow.base`) e labels (`pr.labels`).
- **Papéis e references do loop**: `SKILL.md` e `reference/loop/*.md` descrevem princípios e esqueletos; o texto do projeto
  é o `refs.*` do perfil, aberto por `hades project ref <nome>` e que vence o esqueleto onde divergir.
- **Hook** (`hades guard`):
  - **regras da máquina** (valem em toda sessão, com ou sem perfil): fila de gates (comandos fixos + `guard.patterns`
    das stacks instaladas), polling, checagem repetida, teto de contexto de agente e de sessão interativa. A fila é
    única na máquina: um build de qualquer projeto disputa a mesma memória;
  - **regras de projeto** (só num repo com perfil): o clone principal é sessão de orquestrador (teto e aviso do
    orquestrador). Fora de perfil, a sessão é interativa.
- **skill-new/skill-clean**: o git da skill pode ter remote; push nunca é automático (`branch.skill/<u>.pushRemote=no_push`).

## Guarda de nome e regressão

- **Guarda de nome** (`skill-release.sh check`): os termos vêm dos perfis instalados (`hades project names`: nome,
  repo, owner, aliases com 3+ letras, achados em qualquer posição e sem caixa, sem fronteira de palavra; mais o
  `identity.vocabulary`, ERE: `hades project patterns`), nunca de lista no código; `kit/skill-release.sh guard [<dir>]`
  roda só a guarda, sem precisar do `$D`; varre o núcleo fora de `.git`, `assets`,
  `.design-sync-reports` e `loop/test`. `HADES_NAME_GUARD=strict` (padrão) reprova; `report` só lista arquivo e
  contagem.
- **Guarda de domínio** (`skill-release.sh guard|check`): o núcleo também não cita o domínio de um projeto (equipamentos,
  eventos, serviços nomeados, portas e bancos dele). Os termos vêm do arquivo que o
  perfil declara em `domainTerms` (`hades project domain`), nunca de lista no código. Formato do arquivo: um termo ou
  ERE por linha, sem caixa, `#` comenta, linha em branco ignorada; `@allow <glob>` (relativo à raiz da skill, `*` casa
  `/`) tira da contagem um arquivo do núcleo que ainda depende do ambiente do projeto por código (chave de
  configuração, página do painel): é dívida declarada no pacote, e some da lista quando o arquivo é limpo. Mesmo modo
  da guarda de nome: `HADES_DOMAIN_GUARD=strict|report` (padrão: o de `HADES_NAME_GUARD`, `strict` se nenhum); `strict`
  reprova o `check` e o `release`. Sem `domainTerms` em nenhum perfil, a guarda passa em silêncio. `project init` não
  gera o arquivo: o vocabulário é do dono do projeto.
- **Regressão** (`bun test loop/test/ts --parallel=8`, pela fila de gates): HOME, raízes e PATH isolados (gh, herdr e npx
  falsos em `stubs/`), sem rede, um rig por arquivo.
  - Saídas de referência em `loop/test/golden/` (e `golden/legado/` para o que os originais, removidos na 5.0.0, produziam).
  - JSON compara por subconjunto (campo novo passa).
  - Regrave um golden só quando a mudança de saída é intencional e conferida à mão.

O núcleo nunca cita o projeto: o `check` reprova (`HADES_NAME_GUARD=strict`, padrão) qualquer ocorrência do nome, repo,
owner ou alias de um perfil instalado fora de `loop/test` e dos relatórios (o `CHANGELOG.md` também é varrido: o histórico anterior à 4.0.0 mora no pacote do projeto).

## Exemplo: projeto com várias stacks e sem tracker

Piloto real (repo pessoal do dono): app Next/pnpm + `rust-server` + `src-tauri`, `main` protegida e tudo por PR, fila de
trabalho em `docs/plano-execucao.md`, sem tracker, sem subagente de review. O perfil vem do `project init` e foi
corrigido à mão onde a inferência errou; o que o núcleo não sabe fica no pacote, não no núcleo:

| Campo | Valor | Por quê |
|---|---|---|
| `flow` | `pr`, base `main`, CI `ci.yml` (roda em qualquer base e em draft), `reviewRequired: false`, `bot.selfMarkers` só com o marcador do loop do repo (sem `mention`) | mantenedor único, sem bot de review |
| `work.sources` | `["queue"]` e `refs.deliver` dizendo qual arquivo é a fila | sem specs nem card |
| `card` | `provider: none` | o `ClickUp` do repo é plano de produto, não tracker (o init o inferiu errado) |
| `commit` / `branch` | `<type>: …` sem footer, `coAuthor:false`; branch com a área opcional (`<tipo>/<slug>` ou `<área>/<tipo>/<slug>`) | o doc diz uma coisa, o histórico faz outra: a regex aceita as duas |
| `rules.quality` | só os 4 ids que a nota arquivo:linha confirma | casa por palavra solta é evidência, não prova |
| `stacks` | `pnpm-next`, `rust-cargo`, `tauri` | `detect` casou os três |

`project init` grava só o `profile.json`: o arquivo de `refs` (aqui `loop/deliver.md`) o dono acrescenta ao pacote.
A fila de gates da skill própria do repo passa a usar a do Hades (`reference/stacks.md`).

## Plugin do Hades

O **pacote do projeto** (perfil + `env/` + plugin, `<packs>/<projeto>/`) é o **plugin do Hades** daquele projeto: um repositório git próprio, com
remote, que o núcleo lê e não contém. (Não é o plugin do Claude Code, do marketplace.) O núcleo é a CLI `hades` em
TypeScript (`reference/cli.md`); em `$D` ficam só os shims permanentes de uma linha do kit (`tunnel.sh`,
`rebuild-branch.sh`, `watch.sh`…), que o `env/` do plugin pode chamar por caminho. Perfil, invariantes, entrega,
gates, review, vocabulário de domínio, ambiente local e a regressão do perfil moram nele; o núcleo fica sem nome de projeto.

- **Instalar** (máquina nova): página **Plugins** do painel → **Adicionar por URL**, ou `$D/plugins.sh add <url>`
  (abaixo). À mão continua valendo: `git clone <url-do-plugin> ~/.claude/hades/packs/<projeto>` (a pasta tem o nome do
  projeto, igual ao `name` do perfil), `hades project validate` e, se o plugin tem `env/`,
  `HADES_WT=<worktree> <skill>/kit/install.sh`.
- **Atualizar**: página Plugins → **Atualizar**, ou `$D/plugins.sh update <nome>`: `fetch`, prévia do que muda no que
  executa e, com a confirmação, avanço só por fast-forward e reinstalação. Atualizar o núcleo é outro passo (atualizar a
  skill); o `core` do perfil diz quais versões do núcleo o plugin aceita.
- **Faixa `core`**: campo do `profile.json`, semver simples de até três números por termo, termos separados por espaço
  (todos valem): `>=4.3`, `>=4.3 <5`, `4.3.x` (= `>=4.3.0 <4.4.0`), `4.x`, `4.3.0` (igualdade); operadores `>= <= > < =`.
  O `validate` confere a sintaxe. `hades project core-check [--dir <d>] [--version <v>]` imprime
  `estado<TAB>projeto<TAB>core<TAB>núcleo<TAB>mensagem` (estado `ok`, `sem-core`, `fora`, `invalido` ou `sem-perfil`) e
  sai 0 (ok, sem-core), 1 (fora, invalido) ou 3 (sem perfil). O `kit/install.sh` roda o `core-check` do perfil do
  `HADES_WT` e, fora da faixa, **recusa** (exit 1, antes de tocar o `$D`) dizendo as duas versões e o que atualizar: o núcleo ou
  o plugin (`git -C <pacote> pull`). O `doctor.sh` mostra o item `plugin` (grupo Plugin; `reference/doctor.md`). Campo opcional:
  perfil sem `core` segue funcionando, com aviso no `validate`, no install e no doctor.
- **Onde commitar**: no repositório do plugin (`git -C ~/.claude/hades/packs/<projeto> commit`), nunca na skill nem no
  repo do projeto. O push é decisão do dono. Subiu o piso do núcleo que o plugin usa (recurso novo do núcleo)? Suba o
  `core` no mesmo commit.

### Conteúdo do pacote de projeto

`<packs>/<projeto>/` é o repositório do plugin. Além de `profile.json`:

| Caminho | Para quê |
|---|---|
| `loop/invariants.md` (`refs.invariants`) | invariantes e defaults do projeto, overrides de skills, precedência de regras (a ordem é a de `rules.docs`), quando parar e perguntar |
| `loop/deliver.md` (`refs.deliver`) | roteiro do `deliver` do projeto: fila de specs, card, branch e título, regras de código, corpo da PR, como provocar o review |
| `loop/gates.md` (`refs.gates`) | faixas e comandos do gate, versão de runtime, validadores, armadilhas de suíte, o que o hook de commit pula |
| `loop/review.md` (`refs.review`) | vocabulário de severidade, exceções documentadas, escalonamento, bot de review do CI, `ci-red`, cascata, consolidação, alocação |
| `loop/spec.md` (`refs.spec`) | papel `spec` do projeto (guia, gerador de ID, templates) |
| `README.md` | o que é o plugin, como instalar por clone, compatibilidade (`core`) e o layout |
| `domain-terms.txt` (`domainTerms`) | vocabulário de domínio do projeto, para a guarda de domínio do núcleo |
| `bin/` | scripts que o perfil aponta (`card.create`) |
| `env/` | ambiente local do projeto (infra, dados, processos de apoio), quando o perfil declara `env.pack`; o que ele entrega ao núcleo está em §Pontos de extensão do ambiente |
| `test/*.test.ts` | regressão do pacote com este perfil (`bun test`) |

### Gerir pela página Plugins e pelo `plugins.sh`

A página **Plugins** do painel (grupo Sistema) e o `$D/plugins.sh` fazem o mesmo; a página chama o script. Um plugin
por instalação: o ativo é o pacote cujo `identity.repo` casa com o remote do worktree. Os outros pacotes da pasta
aparecem como "outro projeto": dá para adicionar, atualizar e remover, não para ligar aqui.

```
plugins.sh list                                     nome, URL, branch@commit, estado, faixa core, o que acrescenta
plugins.sh add <url>                                clona e valida; imprime a prévia e o id dela
plugins.sh add --apply <id> --commit <sha>          ativa a prévia confirmada
plugins.sh update <nome> [--apply --commit <sha>]   prévia do que muda; aplica o commit da prévia
plugins.sh enable <nome> | disable <nome>           liga ou desliga o plugin desta instalação
plugins.sh remove <nome> --confirm <nome>           desliga e apaga o pacote
  --json   saída JSON; recusa = exit 1 e {"ok": false, "code", "error"}      --check   só confere, não muda nada
```

- **Adicionar.** Só `https://<host>/<caminho>` ou `git@<host>:<caminho>`, sem credencial embutida (`url_credentials`). O
  clone vai para `$D/plugins-staging/<id>/`, fora da pasta de pacotes (o resolvedor nunca o vê), com
  `core.hooksPath=/dev/null`, sem submódulos e sem pedir senha (`GIT_TERMINAL_PROMPT=0`, ssh em `BatchMode`); o teto é
  `HADES_PLUGIN_GIT_TIMEOUT`. Valida (`validate`, faixa `core`, nome e `identity.repo` sem repetir) e mostra a **prévia**:
  commit fixado, o que vai executar (`post-install.sh`, `panel/api.ts`, `panel/ui/*.js`, `doctor.sh`, `checks/*.sh`, com
  o texto e o sha256) e o que o pacote acrescenta (chaves, passos, checagens, páginas, rotas, ações, lidos do `env/`, sem
  executar nada). Nada roda antes do `--apply` com o mesmo commit (`commit_mismatch`); prévia sem confirmação expira em
  1 h (`preview_expired`). Pacote inválido (`invalid_pack`) ou fora da faixa (`core_out_of_range`) não ativa.
- **Atualizar.** Recusa mudança local (`local_changes`), branch sem upstream (`no_upstream`) e histórico que não avança
  (`not_fast_forward`). A prévia traz os commits, o `--stat` e o diff do que executa; o commit novo passa pelo mesmo
  `validate` e `core` antes de aplicar.
- **Ligar e desligar.** Só o pacote desta instalação (`other_project` para os outros). Desligar grava o nome em
  `$D/plugins.disabled` e reinstala: sai o `$D/plugin/` e, do que o `env/` pôs no `$D`, o arquivo idêntico ao do pacote
  e ausente do kit (estado gerado e arquivo mexido ficam). O pacote fica, e as chaves gravadas no `config.env` também:
  voltam a valer ao religar. Um `install.sh` nunca religa. Desligar é do ambiente e do painel; o loop segue lendo o perfil.
- **Cerberus.** `add --apply`, `update --apply` e `enable` passam pelo momento `plugin` antes de ativar (no `add`, antes
  de mover o clone em prévia): barra recusa com `cerberus_barred`; registro ou modo inválido, com `cerberus_invalid`
  (`reference/cerberus.md` §Momentos).
- **Remover.** Com o nome digitado (`name_mismatch`). Recusa mudança local, stash (`local_changes`) e commit que nenhum
  remote tem (`unpublished_commits`); desliga antes de apagar.
- Depois de mudar o plugin ativo, o script reinstala o kit e reinicia o painel (`<HU>-panel`; páginas e rotas do plugin são lidas
  na subida). Um por vez (`$D/plugins.lock`); cada operação vai para `$D/logs/plugins.log` (UTC, operação, pacote,
  commit, origem `painel` ou `terminal`).
- **Pelo painel:** `GET /api/plugins` lê (também pelo acesso remoto). `POST /api/plugins` só no painel local e com o
  token do painel (`plugins_local_only` pelo remoto): `preview-add` e `preview-update` respondem na hora; `add`,
  `update`, `enable`, `disable` e `remove` conferem com `--check` e rodam como execução exclusiva. **Configurar** leva às
  chaves do plugin em Configurações (busca pelo grupo), sem editor próprio.

### Pontos de extensão do ambiente (`env/`)

O núcleo não conhece o ambiente de nenhum projeto: tudo o que é dele chega pelo `env/` do plugin, por arquivos que o
núcleo **soma** ao seu (ou lê, nos arquivos de dados da tabela). O `install.sh` copia esses arquivos para `$D/plugin/`, espelhados (o que o plugin tirou some do
`$D`; sem `env.pack`, `$D/plugin/` é removido), e não para a raiz do `$D`. Sem plugin, ou com um plugin que não traz
nenhum deles, o núcleo funciona sozinho e nada de projeto aparece. Precedência geral: **o núcleo vence** em id
repetido; o plugin só acrescenta, exceto o padrão de uma chave de configuração.

| Arquivo (`env/`) | Formato | Somado a | Regras |
|---|---|---|---|
| `config.tsv` | 7 colunas TAB, igual ao `kit/config.tsv` | catálogo das Configurações | chave nova com grupo, rótulo e descrição do plugin; chave do núcleo: só o padrão do plugin vale. Valor gravado no `config.env` continua valendo (`reference/config.md` §Chaves do plugin) |
| `onboard.tsv` | igual ao `kit/onboard.tsv` (`@feature`, passos) | catálogo do onboarding | passo com id do núcleo é ignorado; recurso (`@feature`) com id do núcleo recebe os passos do plugin. O `check` sem `check_<nome>` no `onboard.sh` é medido por `$D/checks/<check>.sh` (mesma saída: `feito`, `pendente`, `na` + nota) |
| `doctor.sh` | trecho bash lido com `source` | `doctor.sh`, grupo `Projeto` | usa `ok`/`warn`/`err`/`have`, `$G`, `$D`, `$W`, `$QUICK` e o `lib-checks.sh`; só diagnostica (`reference/doctor.md` §Projeto) |
| `plugin.json` | JSON (abaixo) | slice, `skill-release.sh`, painel | campo ausente = nada |
| `panel/api.ts`, `panel/ui/*.js` | TypeScript e JS do painel | host do painel e `app.tsx` (servida como `app.js`) | abaixo |
| `post-install.sh` | bash, roda no fim do `install.sh` | — | recebe `HADES_WT`, `HADES_DATA` e o ambiente do `install.sh` (variáveis próprias do plugin, como o caminho de um asset); não vai para o `$D` |
| `services.required` | texto: serviços que nunca se desligam | painel (Serviços) | — |
| `post-tunnel.sh` | bash, roda ao publicar o front pelo painel | túnel | — |
| `tunnel-after.txt` | texto | mensagem do `tunnel.sh url` | anexado ao fim |
| `config.defaults` | `K=V` sugeridos | `config.env` | o `install.sh` só grava onde o dono ainda não escolheu |
| `web.paths`, `services.paths` | pastas | selo de rebuild da página Branch e PRs | pastas cujo diff desde o último build pede rebuild do front e dos serviços; sem `services.paths`, `apps/` e `libs/` se o worktree as tem; sem nenhuma, a página não mostra o selo |
| `checks/<passo>.sh`, `<passo>.sh` | bash, um por passo do `onboard.tsv` que o ambiente atende | onboarding | sem o script a checagem diz "não se aplica" |
| (scripts dos processos de apoio) | bash | ambiente do projeto | — |
| `renamed.tsv` | `antigo<TAB>novo`, um par por linha | `install.sh` | só scripts soltos de `$D`: remove o antigo do `$D` quando o novo já está lá e o antigo não existe mais no pacote nem no kit (estado e segredos não são tocados; idempotente). O nome do script fica no pacote porque o núcleo não cita o projeto |

**`plugin.json`** (todos os campos opcionais):
- `name`; `slice`: o que o slice da instância (`$HSLICE.slice`, §Várias instâncias) abriga (vai na `Description` da unit; sem ele, texto genérico);
  `installed`: scripts que o `skill-release.sh check` confere na instalação descartável; `generated`: arquivos que o
  ambiente gera no `$D` (o `diff` não os acusa como "novo").
- `commands[]`: `{name, script, tokenKey?}`, aditivo. `name: "thanatos-source"` declara a fonte externa do post-mortem (logs e
  métricas por JSON; contrato em `reference/thanatos.md` §Fonte externa); `script` é relativo ao `env/` (`commands/*` entra na
  prévia do `plugins add|update` e no Limiar do Cerberus); `tokenKey`, chave de `credenciais.md`. Nome desconhecido é ignorado.
- `ensaio.rede[]`: `{item, motivo}`, aditivo (o contrato `core >=5` não muda). Declara que o `item` (caminho relativo ao `env/`:
  `post-install.sh`, `checks/x.sh`) precisa de rede no ensaio do Cerberus (`reference/cerberus/limiar.md` §plugin-ensaio-isolado)
  e por quê. Sem a declaração, o ensaio roda sem rede e rede não declarada barra; a liberação fica no histórico do Cerberus.
- `ensaio.escrita[]`: `{item, caminho, motivo}`, aditivo. Declara que o `item` grava em `caminho`, uma pasta existente do
  worktree (relativa a ele, sem `..`); o ensaio a monta como cópia descartável gravável só para aquele item. Sem a
  declaração, escrever no worktree barra; a liberação fica no histórico do Cerberus.
- `panel.pages[]`: `{id, label, icon, group, after, script, desc}`; `panel.scripts[]`: scripts avulsos (diálogos).
  Nome de script `^[\w-]+\.js$`, servido de `$D/plugin/panel/ui/`.
- `panel.routes[]`: `{path, method, fn, local}`, `path` `^[a-z0-9-]{1,40}$`, `method` GET ou POST, `fn` uma função do
  `api.ts`; vira `/api/plugin/<path>` com a autenticação do painel (`reference/panel.md` §Plugin: páginas, rotas e ações).
- `panel.actions[]`: nomes de ação que o `api.ts → action` trata; `panel.units[]` (`<HU>-*`, §Várias instâncias): units do plugin que a
  página Logs lista; `panel.cycleScripts[]` (`*.sh`): scripts do plugin que tornam o ambiente "ocupado" quando vivos.
- `panel.endpoints[]`: `{name, label, icon, url | addr, probe}` na Visão geral (sonda só em `http://127.0.0.1:`).
- `panel.runFlags[]`: `{key, label, hint, config}`, passos opcionais do `run-hades` no diálogo Subir (`--<key>` e
  `--no-<key>`; o padrão vem da chave `config`).
- `panel.applies{}`: modo de aplicar novo das Configurações → `{label, button, icon, action}`; `panel.configGroups{}`:
  grupo → ícone; `panel.commands[]`: itens da paleta Ctrl K (`action` [+`confirm`], `url` http(s), `page` ou `dialog`).
- `panel.health{}`: serviço → caminho de saúde (`^/…`) que o painel e o vigia de notificações sondam em
  `http://127.0.0.1:<porta><caminho>`; serviço fora do mapa: `/health/ready`.
- `panel.optionalContainers[]`: containers que não contam como fora do ar; `panel.infraDaemons[]`: processos de infra
  que o plugin roda no host (o amostrador do painel os soma à infra); `panel.memLabel`: rótulo da série "extra" do gráfico de
  memória.

Entrada inválida no manifesto é descartada com aviso no log do painel, nunca vira rota nem ação. O manifesto é lido uma
vez na subida do painel: reinstalou, reinicie o painel.

**`panel/api.ts`** (núcleo >=5), carregado uma vez pelo host do painel (`src/panel/plugin-host-child.ts`,
processo à parte: o plugin é código de terceiros e fica fora do processo do painel, sem o token dele, com tempo esgotado
por chamada). Falha ao carregar = painel sem as rotas e ações do plugin, o resto sobe. Funções exportadas, todas opcionais
(tipos em `src/panel/plugin-api.ts`, importados com `import type`):
- `action(nome, corpo, ctx) -> [título, script bash, exclusiva]` (pode ser `async`): para as ações de `panel.actions`;
  `ctx.pick(valor, lista)` e `ctx.refuse(mensagem)` recusam o pedido (400, a mensagem vai ao cliente). Exclusiva = ação de ciclo.
- `sample(ctx) -> objeto`: a cada amostra; chega à UI em `d.plugin`. Chaves que o núcleo usa: `extras`, `mem` (série "extra"),
  `logUnits`. Exceção vira `d.plugin = {error: 'plugin_sample'}`.
- `<fn>(ctx, dados)` de cada rota: devolve o JSON da resposta. Exceção = 500 `plugin_error`, detalhe só no log.
- `ctx`: `D`, `W`, `NODE_BIN`, `q(...args)`, `sh(script, ...args)`, `pick`, `refuse`, `run(argv, timeoutS?)`,
  `httpStatus(url, timeoutS?)` (assíncrono), `config()`, `snapshot()`, `containers()`; no `sample`, também `units` e
  `unitView(nome)`. Nada de handler HTTP nem de segredo do painel.

**`panel/ui/*.js`**: scripts comuns (sem módulo nem build), que leem `window.HadesPanel`: `React`, `html` (htm), `I`
(ícones lucide), as primitivas da UI do núcleo (`Button`, `Card`, `Table`, `Dialog`, `Svc`, `TunnelCard`, `Kpi`…), os
formatadores (`mb`, `dur`, `pct`…), `getJSON`, `post`, os ganchos `useApp` e `useActions`, e
`registerPage(id, Componente, {badge})` / `registerDialog(id, Componente)` (`run` e `update` são do núcleo). A página
recebe `{d}` (o snapshot); o diálogo, `{d, open, onClose}`. A lista exata está no fim da base, `kit/panel/ui/app.tsx` (servida como `/ui/app.js`; as páginas do núcleo ficam em `kit/panel/ui/pages/`).

Um plugin que traz pontos de extensão documenta o que pluga em `env/reference/extensions.md` (`ref env-extensions`):
as chaves, os passos, as checagens e as páginas que ele soma.

### Legado (núcleo < 5)

**Contrato `core >=5`: só `panel/api.ts`.** O painel não lê mais `panel/api.py` nem aceita plugin cuja faixa `core` admita
núcleo anterior ao 5: o `hades plugins add|update` recusa o pacote com `legacy_api_py` (traz `panel/api.py`) ou
`core_out_of_range`, e o `validate`/`core-check` dão estado `fora` com a mensagem de migração (`legacyCoreMessage`,
`src/lib/profile.ts`).

**Migrar `api.py` para `api.ts`:**
1. crie `panel/api.ts` exportando as mesmas funções (`action`, `sample` e uma por rota de `panel.routes[].fn`), com a mesma
   assinatura e o mesmo `ctx` (`D`, `W`, `NODE_BIN`, `q`, `sh`, `pick`, `run`, `config()`, `snapshot()`, `containers()`;
   no `sample`, `units`); funções podem ser `async`;
2. `ValueError` (recusar pedido fora da lista fechada, 400) vira `throw new PluginRefused(msg)` (ou `ctx.refuse(msg)`);
   tuplas Python viram arrays (`action` devolve `[título, script, exclusiva]`); `dict` vira objeto;
3. `ctx.unit_view(nome)` vira `ctx.unitView(nome)` e `ctx.http_status(url)` vira `await ctx.httpStatus(url)` (assíncrono);
   os tipos estão em `src/panel/plugin-api.ts` (`import type`);
4. apague o `api.py`, ponha `"core": ">=5"` no `profile.json` e reinstale o plugin (`hades plugins update`).

## Várias instâncias

Uma instância = um `$D` com o seu worktree, o seu painel, as suas units, o seu slice e o seu projeto compose. Vários
projetos (cada um com o seu plugin) convivem na mesma máquina, cada um na sua instância; a primeira instância segue com
os nomes de sempre.

- **`HADES_ID`** (linha do `env.sh`, `^[a-z0-9_]{0,24}$`): vazio = a instância original. O `install.sh` o grava só na
  primeira instalação: o `HADES_ID` do ambiente; sem ele e havendo outra instância registrada, o nome do pacote do
  projeto (sem pacote, o do repo) em minúsculas, com o que não é `[a-z0-9]` virando `_` (anuncia o id escolhido); senão
  vazio. `env.sh` anterior à 4.7.0 ganha `HADES_ID=""` antes da linha que carrega o `config.sh`. Depois disso o `env.sh`
  manda: reinstalar com outro `HADES_ID` recusa (exit 1), e um id já usado por outra instância registrada recusa antes
  de tocar o `$D` (sem systemd, `SKIP_SYSTEMD=1`, só avisa).
- **Nomes derivados** (`kit/config.sh`, função `_hades_instance`, exportados a todo script que carrega o `env.sh`;
  lê o `HADES_ID` do ambiente ou da linha do `$D/env.sh`):

  | | original (`HADES_ID` vazio) | `HADES_ID=app2` |
  |---|---|---|
  | `HU`, prefixo das units | `hds` → `hds-panel`, `hds-notify`, `hds-logrotate`, `hds-devtunnel`, `hds-panel-tunnel`, `hds-pjob-*`, `hds-chat-*`, `hds-<serviço>` | `hds_app2` → `hds_app2-panel`… |
  | `HSLICE`, slice | `hades.slice` | `hades_app2.slice` (sem `-`: hífen em slice é hierarquia, `hades-x` seria filho de `hades`) |
  | `HPROJ`, projeto compose | `hades` | `hades_app2` |
  | túneis devtunnel | `hades` (front), `hades-panel` | `hades-app2`, `hades-panel-app2` (o devtunnel não aceita `_`) |
  | cookie do painel remoto | `hds_panel` | `hds_app2_panel` (o cookie não distingue porta) |

  `HADES_BOOT_UNIT`, `CLEAN_UNIT`, `HADES_NOTIFY_UNIT`, `HADES_JOB_UNIT` e `HADES_CHAT_UNIT` seguem trocando o nome (testes);
  o padrão vem de `HU`. `hds-*` não casa `hds_<id>-*`: cada painel lista e lê só as units da sua instância, e as
  `panel.units[]` do plugin precisam começar por `<HU>-`. As units persistentes (`panel.sh`, `notify.sh`, `clean.sh`)
  levam `HADES_ID` no `Environment`; o snapshot do painel leva `unitPrefix` e `instance` (`id`, `slice`, `project`,
  `tunnel`, `panelTunnel`) para a UI.
- **O plugin usa os nomes, nunca o literal**: os scripts do `env/` sobem os serviços como `$HU-<svc>` com
  `--slice=$HSLICE` e a infra com `docker compose -p $HPROJ`; a rede do compose não fixa uma sub-rede que outra instância
  possa já usar (o `doctor.sh` acusa outra rede na sub-rede `HADES_DOCTOR_SUBNET` que não seja a `${HPROJ}_default`;
  o plugin dá o padrão da chave, vazio = sem sub-rede fixa e sem checagem; `HADES_DOCTOR_NODE_BINS` idem para os
  executáveis que dão o `node_modules` por completo). Portas próprias
  por projeto (as do `services.tsv`, `HADES_PORT_RANGE`, `HADES_TUNNEL_PORT`) vêm do plugin.
- **Porta do painel**: instância com `HADES_ID` e sem `HADES_PANEL_PORT` escolhido (nem no `config.env`, que o
  `config.defaults` do plugin já preencheu, nem no `config.tsv` do plugin) recebe a primeira porta a partir de 21220 que
  nenhuma outra instância registrada usa (o valor efetivo dela) e que ninguém escuta (provado por tentativa de bind, v4 e v6, sem `ss`).
- **Porta do widget**: o mesmo para `HADES_WIDGET_PORT`, a partir de 21221, fora das portas de painel e de widget das
  outras instâncias e da deste painel.
- **Registro**: o `install.sh` grava o `$D` em `~/.claude/hades/instances/<projeto>` (nome do pacote ativo, `default`
  sem pacote; um registro de outra instalação válida do mesmo projeto fica, com aviso) e em `~/.claude/hades/instance`
  (a instância **padrão**) só se ausente, apontando para pasta sem `env.sh` ou já igual a este `$D`. Com
  `SKIP_WORKTREE=1` não registra.
  ```
  hades instance [--dir <d>]   $D da instância do projeto do diretório; sem registro dele, a padrão (sai 1 sem nenhuma)
  hades instance list          projeto<TAB>$D<TAB>HADES_ID (a padrão sem registro de projeto entra pelo projeto do worktree dela)
  ```
  O `/hades env` resolve o `$D` pelo `hades instance` (do diretório atual). O `doctor.sh` aceita a instância que
  `instances/<projeto>` aponta mesmo quando a padrão é outra. O que é **da máquina** segue lendo a instância padrão:
  `hades config` (Configurações do loop: `HADES_ORCH_*`, modelos), `gate-lock.sh` (a fila de gates é uma só),
  `hades guard`, `hades models` e o `skill-release.sh` (que aceita `HADES_DATA` para outra).
- **Base da `hades/local`**: `hades_base [<dir>]` (`kit/config.sh`) = `branch.base` do perfil > `origin/<flow.base>` >
  `origin/develop` (o padrão sem perfil; o nome vem do perfil, "base" na prosa). Usam: o `install.sh` ao criar o worktree, o `rebuild-branch.sh` (reset), o `hades pr-set`
  (fim da stack; `HADES_BASE_BRANCH` quando o chamador já sabe) e a página Branch e PRs. O `last-build.develop` e o campo
  `develop` do snapshot guardam a base e mantêm o nome antigo; no `prs.list`, `develop` (ou `-0`) segue querendo dizer
  "só a base".
- **Instalar uma instância a mais**: `HADES_ID=<id> HADES_WT=<worktree> <skill>/kit/install.sh` (worktree e `$D`
  próprios). Nada nela toca as units, o slice, o projeto compose nem os túneis da outra.

## Serviços de apoio no macOS: `hades svc`

No Linux o `env/svc.sh` do pacote sobe cada serviço com `systemd-run --user --unit=$HU-<svc> --slice=$HSLICE.slice` e
nada muda. No macOS (launchd, sem `systemd-run` nem slice) o mesmo script delega ao núcleo, que não conhece o projeto:

```
hades svc run <nome> [--workdir <dir>] [--env K=V]... [--log <arquivo>] [--slice <slice>] -- <cmd...>
hades svc stop <nome>          derruba e recolhe; sai 0 também se não estava no ar
hades svc status <nome>        active | activating | failed | inactive; sai 0 só se active, 3 senão
hades svc list                 nomes dos serviços do pacote no ar, um por linha
hades svc is-active|is-enabled <unit-completa>   sai 0 = sim, 1 = não (as checagens do kit, `chk_unit_*`)
```

- `<nome>` vira a unit `<HU>-<nome>` (`hds-api`, `hds_app2-api`), o mesmo nome que o painel espera em `panel.units[]`;
  o `list` não mostra as units do próprio Hades (painel, vigia, limpeza, túneis, `pjob-*`, `chat-*`).
- No launchd cada serviço é um plist privado (`~/.claude/hades/launchd`, ADR 0002), sem reinício automático e sem
  início no login. `run` de um nome que já está no ar o troca. O launchd não resolve o executável pelo PATH: `hades svc`
  o transforma em caminho absoluto (comando que não existe sai 127) e passa o PATH de quem chamou ao serviço.
- `--slice` só avisa: no macOS não há slice, o teto de serviço é recomendação (ADR 0003) e o painel mostra a soma de RSS.
- Log padrão `$D/logs/<unit>.log`, em modo append.
- Escolha do gerenciador: `HADES_SERVICE_MANAGER=systemd|launchd` força (ADR 0001); o `svc.sh` do pacote usa o mesmo teste
  que o kit (`uname` = Darwin, ou a variável) para escolher o ramo.
