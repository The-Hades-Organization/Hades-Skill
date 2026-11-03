# Cerberus · Porta: o que sai da máquina

A Porta é a cabeça do Cerberus (`reference/cerberus.md`) que confere o que sai: destino, conteúdo e autorização. Modo
padrão `barra` (`HADES_CERBERUS_PORTA`). Cada guarda de código é um `exec` em `loop/cerberus/porta/<id>.json`, com o código em
`src/lib/cerberus-porta.ts` (`hades cerberus-check porta/<id>`), e devolve um veredito com evidência (o que conferiu e onde). Falha ao conferir (sem `gh`,
sem rede, sem perfil) nunca é `ok`: sai `aviso` ou `barra` com a evidência do que faltou.

## Contexto que as guardas leem

Chaves de `--ctx` (`reference/cerberus.md` §Avaliação conjunta). Todas opcionais; sem elas a guarda cai no que o git diz.

| Chave | Quem usa | O quê |
|---|---|---|
| `pr` | `upstream-push` | número da PR; o `headRefName` vem de `gh pr view` |
| `head` | `upstream-push`, `branch-protegida` | `headRefName` já conhecido (dispensa o `gh`) |
| `range` | `segredo-diff` | intervalo do diff que sai (`a..b`) |
| `plano` | `plano-aprovado` | caminho de um `plan.json` (vale quando o repositório não tem `origin`, como o da própria skill: `skill-release.sh` passa o da consolidação) |
| `texto` | `segredo-diff` (comentario) | arquivo com o texto do comentário que vai à PR |
| `arquivo` | `segredo-diff` (artefato) | arquivo ou pasta do artefato a publicar |
| `host` | `tunel-acesso` | host ou URL pública do túnel |
| `acesso` | `tunel-acesso` | `autenticado` ou `anonimo`, declarado por quem chama |
| `tunel` | `tunel-acesso` | id do túnel: sem `acesso`, a guarda lê `devtunnel access list <id>` |

## Guardas

| Id | Momentos | Confere | Barra quando | Aviso quando |
|---|---|---|---|---|
| `upstream-push` | push, consolidacao | `branch.<b>.merge` contra o `headRefName` da PR | upstream de outra branch; sem upstream e nome diferente da PR | sem PR no contexto; `gh pr view` falhou |
| `remote-push` | push, consolidacao | remote de push (`pushRemote`, `pushDefault`, remote do upstream) e a url de push | `no_push`; remote inexistente | nenhum remote configurado |
| `branch-protegida` | push, consolidacao | destino contra `flow.base` do perfil, nomes de tronco e `gh api …/branches/<b>` | destino é a base, nome de tronco ou protegida | `gh` falhou (a evidência diz qual chamada) |
| `conta-gh` | push, consolidacao, comentario | conta que empurra (`gh api user`, com o token de `identity.gh.tokenEnv` quando houver) contra `identity.gh.user` | conta diferente; `tokenEnv` declarado e vazio | perfil sem conta declarada; `gh` falhou |
| `segredo-diff` | push, release, consolidacao | padrões de token e chave nas linhas adicionadas do intervalo (contexto, `@{upstream}..HEAD`, última tag, base) | achado (arquivo, linha e valor mascarado); diff ilegível | nada delimita o que sai |
| `nome-dominio` | release, consolidacao | chama `kit/skill-release.sh guard` no repositório da skill | o guard reprova (nome de projeto ou termo de domínio no núcleo) | sem perfil instalado (nada a procurar) |
| `plano-aprovado` | release, consolidacao | `orchestration/plan.json` do projeto (ou `--ctx plano=`): existe, o plano existe e o hash bate | sem registro; plano mudou depois da aprovação; registro ilegível | — |
| `tunel-acesso` | tunel | host na lista `HADES_CERBERUS_PORTA_TUNEL_HOSTS` (padrões com `*`) e acesso autenticado; lista vazia barra | host fora da lista; acesso `anonimo` (declarado em `--ctx acesso=` ou lido de `devtunnel access list <id>`); lista vazia | — |

### Momentos de publicação e túnel: `comentario`, `artefato`, `tunel`

Guardas desses momentos (`reference/cerberus.md` §Momentos): `segredo-diff` (`comentario`, `artefato`), `conta-gh`
(`comentario`: quem comenta) e `tunel-acesso` (`tunel`: host na lista `HADES_CERBERUS_PORTA_TUNEL_HOSTS`, padrões com `*`,
e acesso autenticado; lista vazia barra). Quem chama: `hades review`, `hades consolidate` e a reconciliação
(`avaliar comentario --ctx pr=<n> --ctx texto=<arquivo>`), e `kit/tunnel.sh` (`avaliar tunel --ctx tunel=front|painel
--ctx porta=<p> --ctx host=<host> --ctx acesso=<autenticado|anonimo>`: o painel é só do dono; o front, que o
`publish-cmds` abre com regra anônima, declara `anonimo` e a guarda barra). `artefato` (`avaliar artefato --ctx
arquivo=<caminho>`) ainda não tem ponto de chamada: a publicação de artefato é uma ferramenta do Claude, sem script do
núcleo no caminho.

`nome-dominio` fora do repositório da skill passa com a evidência de que a regra não se aplica. A regra em si mora no
`skill-release.sh`; a guarda só a chama.

## O que a evidência diz

- Segredo: tipo, `arquivo:linha` e o começo do valor com o tamanho; o valor inteiro nunca vai ao histórico. Valor que
  declara ser exemplo (`exemplo`, `example`, `<…>`, `${…}`) não conta. Segredo já commitado é credencial queimada:
  reescrever o commit não basta.
- Autorização: o que foi procurado (caminho do `plan.json`) e, se achou, caminho do plano, hora da aprovação e, quando o
  registro tem `by` (usuário e origem `terminal` ou `painel`), quem aprovou. Sem `by`, o `detalhe` diz que o autor não consta.

### Guardas emitidas e regras escritas

Não rodam como `exec` da Porta (`reference/cerberus.md` §Registro de guardas, tipos `emitida` e `regra`). Cada uma vive no
`loop/cerberus/porta/<id>.json`; a coluna diz de onde vem.

| Guarda | Tipo | Momentos | Origem |
|---|---|---|---|
| `dominio` | emitida | release | `kit/skill-release.sh` `domain_guard` (`reference/projects.md` §Guarda de nome e regressão, item Guarda de domínio) |
| `nome-de-projeto` | emitida | release | `kit/skill-release.sh` `name_guard` (`reference/projects.md` §Guarda de nome e regressão) |
| `review-so-comment` | regra | publicacao | `SKILL.md` §Invariantes de seguranca (nao destravaveis) |
| `sem-coautor` | regra | push | `SKILL.md` §Invariantes de seguranca (nao destravaveis) |
| `sem-force-nem-no-verify` | regra | push | `SKILL.md` §Invariantes de seguranca (nao destravaveis); `reference/loop/gates.md` §2 |
| `sem-merge` | regra | push, consolidacao | `SKILL.md` §Invariantes de seguranca (nao destravaveis) |
| `thread-so-verificada` | regra | publicacao | `SKILL.md` §Invariantes de seguranca (nao destravaveis) |

## Calibrar

- Padrões de segredo: lista `SECRET_PATTERNS` em `src/lib/cerberus-porta.ts`; falso positivo recorrente entra em `FALSE_POSITIVE` (marcador),
  não vira exceção do dono.
- Nomes de tronco: `TRONCOS` em `src/lib/cerberus-porta.ts`; a base do projeto vem do perfil, nunca do código.
- Em `avisa` o `barra` vira aviso e o histórico guarda os dois; use no começo num projeto novo.
- Exceção do dono libera um `barra` de uma guarda, uma vez (`reference/cerberus.md` §Exceção).
