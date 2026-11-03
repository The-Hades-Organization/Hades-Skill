# Cerberus · Vigília: o que acontece dentro

A cabeça **Vigília** do Cerberus (`reference/cerberus.md`, o contrato) confere duas coisas:

1. **Auditoria do DONE:** o `report.md` do agente confrontado com a evidência. Report diz que o gate passou, que a
   captura existe, que o commit está na branch; a guarda confere cada afirmação onde ela pode ser provada.
2. **Coerência entre plano, registro e realidade:** o "Estado atual" do plano e o registro de agentes
   (`hades agent`) contra o git, o herdr e o GitHub.

Por quê: o DONE e o registro são o que o orquestrador e o dono leem para decidir. Report que afirma gate verde sem
registro na fila, agente `working` cuja sessão perdeu o nome no herdr, DONE com pergunta aberta: todos foram medidos
numa orquestração real e todos passaram calados até alguém abrir o arquivo.

Modo padrão `avisa` (`HADES_CERBERUS_VIGILIA`): o `barra` de cada guarda vira aviso enquanto a cabeça está em calibração.

## Onde vive

| Peça | Caminho |
|---|---|
| guardas (`exec`) | `loop/cerberus/vigilia/<id>.json` |
| auditoria do DONE | `hades cerberus-check vigilia/auditoria <status\|gates\|capturas\|commits\|escopo\|perguntas>` |
| coerência | `hades cerberus-check vigilia/coerencia <registro\|plano>` |
| o que as duas dividem | `src/lib/cerberus-vigilia.ts` e `src/lib/cerberus-check.ts` (contexto, alvos, leitura com tempo, veredito) |
| bloco da página | `kit/panel/ui/cerberus/vigilia.tsx` |
| regressão | `loop/test/ts/cerberus-vigilia.test.ts` (`bun test`) |

## Quem é conferido

Todas as guardas rodam em `done` e `consolidacao`.

- **`done`** (`hades agent done` chama `avaliar done --ctx agente=<nome>`): o agente do contexto, achado em
  `<work>/*/orchestration/agents/<nome>.json`. Com o mesmo nome em dois repositórios, vale o do repositório do `--dir`.
- **`consolidacao`**: os membros de `<work>/<repo>/orchestration/consolidations/<branch>.json` (casados pela `pr` do
  registro), com `branch` no contexto; sem esse arquivo, todos os agentes não arquivados do repositório do `--dir`.

O report é `<worktree>/<HADES_ORCH_REPORTS_DIR>/report.md` (padrão `.design-sync-reports`).

## Guardas

| Id | O que confere | `barra` | `aviso` | Evidência (`onde`) |
|---|---|---|---|---|
| `done-status` | primeira linha do `report.md` | não começa com `STATUS: DONE`; report ausente | — | caminho do report |
| `done-gates` | cada bloco do report que cita a fila como verde | sem registro `done` da worktree no `gate-journal.tsv` desde o `createdAt` do agente, com o kind e o label citados; ou o último que casa saiu `rc≠0` | — | `gate-journal.tsv` e `report.md:<linha>` |
| `done-capturas` | imagem citada em bloco que fala de captura | arquivo não existe; existe e está vazio | caminho cuja pasta não existe em lugar nenhum conferido | caminho resolvido e `report.md:<linha>` |
| `done-commits` | hex de 7–40 em linha que fala de commit, branch, base ou head (hex de outra linha do bloco só avisa) | não existe no repositório, ou não é ancestral de HEAD | o mesmo, quando o bloco cita outra ref ou um caminho fora da worktree | `report.md:<linha>` e `git -C <worktree>` |
| `done-escopo` | `git diff --name-only <merge-base>..HEAD` contra o brief | arquivo em "não toque"; fora de "Arquivos seus" sem registro no report | fora de "Arquivos seus" e citado no report (acréscimo registrado); base que não resolve | `git diff` e `brief.md` |
| `done-perguntas` | `questions.md` com o report em DONE | `## Q<n>` sem `(respondida)` nem `## Resposta do dono` depois | — | `questions.md` |
| `registro-realidade` | registro do agente contra git, herdr e GitHub | worktree ausente; branch diferente; base em sha que não é ancestral de HEAD; sessão do painel ou da worktree viva no herdr sem o nome; PR do registro diferente da do GitHub, fechada sem merge, ou registrada e inexistente | sem sessão no herdr; painel diferente do registro; PR mergeada com registro ativo; nenhuma PR e nenhuma no registro; base em ref que não existe | `git -C`, `herdr agent list`, `gh pr list --head <branch> --state all` |
| `plano-registro` | o trecho do agente no "## Estado atual" do plano aprovado (`orchestration/plan.json`) | — | agente ativo fora do Estado atual; painel, porta ou PR citados diferentes do registro; commit citado que não existe; plano sem a seção; `plan.json` apontando arquivo que não existe | `<plano> §Estado atual` |

O veredito é o pior item; a evidência traz os piores primeiro, cada um marcado `[barra]`/`[aviso]`, até o limite do
corpo (20). O `detalhe` é o primeiro problema.

### Guardas emitidas e regras escritas

Não rodam como `exec` da Vigília (`reference/cerberus.md` §Registro de guardas, tipos `emitida` e `regra`).

| Guarda | Tipo | Momentos | Origem |
|---|---|---|---|
| `auditoria-done` | emitida | done | `hades agent done` |
| `excecao-so-dono` | emitida | continuo | `hades guard` (PreToolUse); `reference/cerberus.md` §Exceção |
| `gate-lock-admissao` | emitida | continuo | `kit/gate/gate-lock.sh` (saída 75); `SKILL.md` §Invariantes de seguranca (nao destravaveis) |
| `hook-fila-e-polling` | emitida | continuo | `hades guard` (PreToolUse Bash) |
| `card-obrigatorio` | regra | done | `SKILL.md` §Invariantes de seguranca (nao destravaveis) (`card.required`) |
| `estado-fora-do-repo` | regra | done | `SKILL.md` §Invariantes de seguranca (nao destravaveis) |
| `gerado-e-banco` | regra | done | `SKILL.md` §Invariantes de seguranca (nao destravaveis) (lista do projeto em `refs.invariants`) |
| `teste-nao-enfraquecido` | regra | done | `SKILL.md` §Invariantes de seguranca (nao destravaveis) |

### Regras de leitura do report

- **Bloco** é o parágrafo, a linha de tabela, o título ou o item de lista de primeiro nível com continuação e subitens.
  Conteúdo entre cercas de código não conta: é saída citada, não afirmação.
- **Gate alegado** (`done-gates`): o bloco cita a fila (`gate-lock`, "pela fila", "(fila", `queue`, `kind <x>`), tem
  marca positiva (`ok`, `passou`, `verde`, `rc=0`, `✓`) e nenhuma negativa (`falhou`, `rc=1`, `✗` que não seja `0 ✗`).
  Título que cita a fila soma o bloco seguinte. `run <kind>`/`kind <kind>` e `--label <x>` filtram o registro; `test`
  casa `test:integration`. O gate-journal é o de todo repositório em `<work>/*/locks/`, com o clone igual à worktree.
- **Captura**: só em bloco que fala de captura ("captur", "screenshot", "shot"). Nome com molde (`<pagina>`, `{a,b}`, `*`,
  `…`) não é conferido. Nome solto é procurado na pasta do relatório, nas pastas das outras capturas já achadas, em
  `<worktree>/../_data/<agente>` (instalação descartável das unidades da skill) e na worktree, até 20 000 arquivos.
- **Commit**: só em bloco que fala de commit, branch, base, head, sha ou "sobre"; o hex tem de ter letra e dígito.
  A **linha** do hash também tem de falar disso: hash em outra linha do mesmo bloco (continuação de item, parágrafo
  longo) vira `aviso` (`em linha que não fala de commit`), nunca `barra`. Objeto que existe e não é commit é ignorado.
- **Escopo**: o parágrafo cujo rótulo em negrito contém "Arquivos seus" e o que contém "não toque", até a linha em
  branco. Entram os caminhos entre crases: `<x>` vira curinga, `dir/` é prefixo. Em "Arquivos seus" só caminho com
  barra; em "não toque" também nome com extensão (`run.sh`), casado pelo nome do arquivo. Brief sem nenhum dos dois dá
  `ok` com "escopo não declarado".

Para o `done-escopo` valer, o brief tem de trazer os dois parágrafos assim:

```markdown
**Arquivos seus (e só estes):** `loop/x/<id>.json`, `loop/x/checks/`, `reference/x.md`.

**Em voo junto com você, não toque:** `src/panel/`, `app.js`, `kit/config.tsv`.
```

## Falha ao conferir

Cada leitura fora do processo (`git`, `gh pr list`, `herdr agent list`) tem o tempo `HADES_CERBERUS_VIGILIA_IO_S`
(padrão 8 s; a guarda inteira ainda respeita o `timeoutS` dela). Comando ausente, tempo esgotado, saída ilegível,
registro ilegível ou contexto sem agente viram `aviso` com `não conferido: <o que faltou>` e onde. Nunca `ok`.
Report, brief, perguntas e plano são lidos até 1 MiB; o gate-journal, nos últimos 4 MiB.

## Calibrar

Medido rodando as guardas só em leitura contra 13 agentes reais de uma orquestração. Falsos positivos achados e
corrigidos:

| Guarda | Falso positivo | Correção |
|---|---|---|
| `done-commits` | hash de `VERSION` do service worker lido como commit | só hex em bloco que fala de commit, branch, base, head, sha ou "sobre" |
| `done-commits` | commit do pacote do plugin (outro git) | `aviso`, não `barra`, quando o bloco cita outra ref ou caminho fora da worktree |
| `registro-realidade` | base `main` (ref que anda) acusada de não ancestral em 6 unidades da skill | ancestralidade só para base em sha; ref só confere ancestral comum |
| `done-capturas` | `hades-dark/light.png`, abreviação de dois nomes | caminho cuja pasta não existe vira `aviso` |
| `registro-realidade` | "nenhuma PR" em unidades sem PR por decisão | `aviso`; `barra` só quando o registro tem `pr` e o GitHub diverge (o DONE sem PR já é barrado pela `auditoria-done` do corpo) |

Verdadeiros que ficaram: report citando heads que foram reescritos depois (`barra`); agentes registrados numa branch
com a worktree em outra (`barra`); cinco agentes `working` sem sessão no herdr (`aviso`); PR mergeada com registro
`working` (`aviso`); plano sem "Estado atual" (`aviso`).

Para passar a cabeça para `barra`: na página Cerberus, o bloco da Vigília mostra por guarda quantos vereditos deram
`ok`, `aviso` e `barra` e o último problema com a evidência. Confira cada `barra` do histórico
(`hades cerberus historico --cabeca vigilia --efeito aviso`): falso positivo vira correção na guarda e linha nova na
tabela acima. Sem falso positivo num ciclo inteiro de orquestração, troque o modo pelo painel local. Uma guarda que
ainda erra pode ficar de fora sem desligar a cabeça: exceção do dono para ela, ou ajuste no checker.

## Relação com as guardas do corpo

- `done-gates` dá corpo à regra `vigilia/gate-verde-de-verdade` (a regra foi removida na consolidação: `done-gates` a substitui).
- `done-status` cobre parte da `auditoria-done` emitida pelo `hades agent done`, sem substituí-la: aquela também
  confere worktree limpa, push e PR.
