---
name: hades
description: Hades: o conjunto de trabalho do dev, por projeto, global (~/.claude) e acionado por /hades. (1) Loop de engenharia: leva spec até a PR, reconcilia os reviews recebidos nas minhas PRs, revisa PRs de terceiros em paralelo, cascateia stacks, orquestra agentes pelo herdr com PR de consolidação e gate único, e cuida de locks e da fila de gates. (2) Ambiente local: branch hades/local (base do projeto + PRs), infra docker própria, serviços sob teto de memória, dados e processos de apoio do projeto, painel web (com chat com o Claude, também pelo celular) e túnel (/hades env up|update|pause|resume|status|panel|config|doctor|onboard). Use para "leva a spec X até a PR", "aplica os reviews das minhas PRs", "continua as PRs em voo", "revisa N PRs do autor Y", "cascateia a stack", "orquestra agentes", "consolida as PRs", "libera os locks presos", "sobe o Hades", "atualiza o Hades", "abre o painel", "prepara as features", "o que falta configurar", e quando o dev pedir algo que a Hades ainda não cobre (ela se estende). Não é review pontual de branch (/review-agents).
argument-hint: '[deliver|inbox|review|cascade|sweep|status|locks|answer|ready|watch|resume|orchestrate|consolidate|usage|env <acao|onboard>|project init] [--orchestrated] [--max N] [--author L] [--pr N] [--deep] [--loop [--every 30m] [--until H] [--rounds N] [--no-post] [--note N]] [--dry-run] [--allow-in-review] [--no-integration] [--max-iters N] [--pattern P]'
---

# Hades

O conjunto de trabalho do dono no projeto ativo (o perfil em `~/.claude/hades/packs/`), numa skill só e num comando só (`/hades`):

- **Parte I — Ambiente local:** roda o estado mais recente das PRs de um autor para validação manual, com infra,
  dados, processos de apoio do projeto, painel e túnel (`kit/` da máquina + `env/` do pacote do projeto, instalados em `<worktree>-data`).
- **Parte II — Loop de engenharia:** leva a PR do começo ao fim e reconcilia os reviews, sem nunca fazer merge
  (`reference/loop/`, `loop/bin/`).

As duas partes dividem a **fila de gates** (`hades gate-lock`, estado em `~/.claude/hades/work`), as **Configurações**
e o **painel** (http://127.0.0.1:21220: Loop, Fila de gates, Serviços, …). Versão em `VERSION`, histórico em
`CHANGELOG.md`; a skill evolui pelo `reference/evolving.md`.

**Termos.** **a Hades** = esta skill; **o Hades** = o ambiente local no ar (branch, infra, serviços, painel).
**Dono** = quem opera a instalação e decide (o "você" do README); **autor** = quem abriu a PR; **mantenedor da skill**
= quem publica as versões da skill. **Gate** = checagem pesada antes da PR (build, lint, testes), sempre pela fila.
**Tick** (= passada) = uma volta do loop: coletor → escolhe o alvo → age → reporta (`reference/loop/gates.md` §7). **Card** = o item
do rastreador de tarefas que o perfil exige (`card.*`). **Thread** = conversa de review numa linha da PR.
**`$D`** = a pasta de dados da instância (abaixo). **`ref <nome>`** = `hades project ref <nome>`, o texto que o pacote
do projeto declara. **Pasta de relatórios** = `.design-sync-reports/` na worktree de cada agente (brief, `report.md`
do agente, `questions.md`, `handoff.md`).

## Comando `/hades`

`~/.claude/commands/hades.md` faz o parsing; esta skill é a fonte das regras. Esta tabela é a canônica dos modos e
das flags.

| Invocação | Faz |
|---|---|
| `/hades` | loop: `inbox` e, se nada estiver acionável, `deliver` |
| `/hades deliver [<spec-id\|caminho>] [--allow-in-review] [--no-integration] [--max-iters N]` | spec → código → gates → `/review-agents` → PR (`reference/loop/deliver.md`) |
| `/hades inbox [--pr N] [--no-integration] [--max-iters N]` | triagem e achados vivos das minhas PRs (`reference/loop/inbox.md`) |
| `/hades review [--max N] [--author L] [--pr N] [--deep]` | revisa PRs de terceiros em paralelo e publica como comentário (`reference/loop/review.md`) |
| `/hades review --loop [--every 30m] [--author L \| --pr N…] [--until H] [--rounds N]` | loop: de tempos em tempos revisa só as PRs de head novo, sem repetir achado (`reference/loop/review.md` §7) |
| `/hades cascade [--pr N]` · `/hades sweep [--pattern P]` | cascata da stack nos quatro sentidos (`reference/loop/cascade.md`) |
| `/hades orchestrate [<objetivo>]` | papel de orquestrador: aloca agentes pelo herdr, escreve briefs, acompanha, audita e leva decisões ao dono (`reference/loop/orchestrate.md`) |
| `/hades consolidate <PR>...` | PR de consolidação: originais entram por merge, gate uma vez, merge único na base (`reference/loop/consolidate.md`) |
| `--orchestrated` (deliver, inbox, cascade, consolidate) | a passada é de um agente alocado: segue o cartão do papel, o brief e o gate do modo orquestrado (`reference/loop/gates.md` §1.0) |
| `--dry-run` (qualquer modo que escreve) | plano, checklist e relatório locais; nada sai de `~/.claude/hades/work` |
| `/hades status` | coletor + locks + escalações; read-only |
| `/hades locks` · `answer` · `ready` · `watch` · `resume` | manutenção do loop (`reference/loop/ops.md`) |
| `/hades usage [--days N]` | consumo de tokens (`hades usage`): por papel, agente e dia, contra a linha de base |
| `/hades project init [--dry-run]` | gera o perfil do repo atual (lê CLAUDE.md, CI, commitlint, regras; detecta stacks; mapeia regras ao catálogo) e só grava em `~/.claude/hades/packs/<projeto>/` com o ok do dono; num repo com perfil mostra o diff (`reference/project-init.md`) |
| `/hades env up [PRs…] [--no-tunnel\|--tunnel] [--no-<passo>] [--rebuild]` | `$D/run-hades.sh` (Parte I, Fases 1→7) |
| `/hades env update [--all]` · `pause` · `resume` | `$D/update.sh` · `$D/hades.sh pause\|resume` |
| `/hades env status` · `panel` · `config [K=V…]` | `run-hades.sh --status` · `panel.sh start` · `config.sh show\|set` |
| `/hades env onboard` | onboarding: pergunta quais recursos preparar agora (acesso remoto, notificações, início do painel, contas e loop), roda com o ok do dono o que é da Hades e entrega os passos do dono com o comando pronto (`$D/onboard.sh`, `reference/onboard.md`) |
| `/hades env doctor [--quick\|--json]` | `$D/doctor.sh`: pré-requisitos, máquina, instalação e painel, com o comando que corrige cada item (`reference/doctor.md`) |

CLI de apoio da orquestração (no terminal, não é modo do `/hades`):

| Comando | Faz |
|---|---|
| `hades agent plan-trim <plan.md>` | move o histórico do plano do orquestrador para `<plano>.log.md` e deixa o "Estado atual" (`reference/loop/plan-template.md`) |
| `hades agent park <agente>` | estaciona o agente (`reference/caronte.md`) |
| `hades caronte pack\|unpack\|brief` | empacota a orquestração cifrada, abre o pacote em outra máquina ou imprime o prompt de retomada (`reference/caronte.md`) |

`$D` vem de `hades instance` (do diretório atual): a instância do projeto (`~/.claude/hades/instances/<projeto>`)
ou, sem ela, a padrão (`~/.claude/hades/instance`); o `install.sh` grava as duas. O `/hades env` funciona de qualquer clone,
e vários projetos convivem na máquina, cada um na sua instância (`reference/projects.md` §Várias instâncias).

## Mapa de referências

Abra só o arquivo do assunto; o `SKILL.md` não repete o que está neles.

| Assunto ou pedido | Arquivo |
|---|---|
| "sobe tudo", fases 0–8 do ambiente, regras duras e onde fica cada coisa (Parte I) | `reference/env.md` |
| qualquer pedido do dono por tema (ambiente, painel, widget, qualidade, projeto, orquestração, evolução da skill): comando e referência | `reference/pedidos.md` |
| modo do loop (`deliver`, `inbox`, `review`, `cascade`, `consolidate`, `ops`) | `reference/loop/<modo>.md` |
| gate, push, locks, estado, ondas de correção, ritmo sob `/loop` · coletor · formato do relatório | `reference/loop/gates.md` · `collector.md` · `report.md` |
| defaults destraváveis e overrides declarados · onde fica cada peça do loop | `reference/loop/defaults.md` · `reference/loop/onde-fica.md` |
| orquestrar, briefs, planos · cartão de cada papel (o agente lê o cartão, não a skill) | `reference/loop/orchestrate.md` · `reference/loop/roles/<papel>.md` |
| tokens, modelo, teto de contexto, espera | `reference/loop/tokens.md` |
| evoluir a própria skill | `reference/evolving.md`, `reference/loop/skill-dev-contract.md` |
| perfil e pacote do projeto | `reference/projects.md` |
| painel, configurações, doctor, CLI | `reference/panel.md` · `reference/config.md` · `reference/doctor.md` · `reference/cli.md` |

## Parte I — Ambiente local

Roda a branch `hades/local` e o ambiente. Procedimento (Fases 0–8), onde fica cada coisa e o detalhe de cada regra:
`reference/env.md`. Os invariantes do ambiente:

- `hades/local` é **local**: nunca push, nunca commitar nas branches das PRs, nunca comentar/editar PR no GitHub.
- **Não é gate**: nada de suíte de teste/lint; compilar para rodar é o mínimo, pela fila do gate-lock.
- **O Hades cede, nunca um gate**: memória esperada por gate pesado > 2 min → `hades.sh pause`; só o dono suspende a regra.
- **Nada destrutivo fora do Hades**: sem `docker system prune`, `pkill -f`, volume ou container que não seja do projeto.
- **Túnel público é passo do dono**: o agente prepara e entrega os comandos `! ...` (`reference/tunnel.md`).
- Credenciais só em `$D/credenciais.md` (600); nunca em log, commit ou conversa.
- **Antes de subir qualquer coisa numa máquina nova, proponha e espere o ok** (Fase 0).
- **A skill evolui com o uso**: pedido fora do escopo → vivo, `kit/`, documentar, `kit/skill-release.sh` (`reference/evolving.md`).

## Parte II — Loop de engenharia

**Orquestrador, não implementação.** Nada aqui reescreve review, gate ou padrão de código: o fluxo
chama o que já existe (`/review-agents`, `code-review-local`, `gh-stack` e as skills de padrão
de código que o pacote do projeto indicar) e adiciona a única coisa que
faltava — **saber em que ponto do ciclo cada PR está e o que fazer a seguir**.

Nada do loop entra no repositório; estado, locks e relatórios vivem em `~/.claude/hades/work/<owner>__<repo>/`, por
repositório (não por clone). Onde fica cada peça (CLI, hook, painel, estado) e os três mecanismos de concorrência:
`reference/loop/onde-fica.md`.

### Projeto ativo
O projeto ativo é o repo do diretório atual: `remote.origin.url` → perfil em `~/.claude/hades/packs/<projeto>/profile.json`
(`hades project resolve`). O coletor, o `hades agent` e o hook leem dele base, CI, bot, códigos de
regra, card e conta do gh. Sem perfil o loop recusa e aponta `/hades project init`; o hook aplica só as regras da
máquina (fila de gates, polling, teto de contexto). Formatos, resolvedor e o que o pacote contém: `reference/projects.md`.

**Regras do projeto.** O núcleo descreve princípios; o texto específico (fluxo de entrega, gates, invariantes,
vocabulário de severidade, spec) mora no pacote e o perfil o declara em `refs`. Antes de agir, leia o que o perfil tem:
`hades project ref invariants|deliver|gates|review|spec` (sai 3 se o perfil não declara; então vale só o núcleo).
O texto do pacote vence o esqueleto do núcleo onde divergir, e nunca os invariantes de segurança abaixo. Nos references
do loop, `ref <nome>` abrevia `hades project ref <nome>`.

### Pré-condições (verificar antes de qualquer ação)

1. `gh --version` responde. Sem isso, pare e instrua https://cli.github.com/.
2. `hades project resolve` → o perfil do repo alvo (`identity.repo`). Sem perfil, pare e aponte
   `/hades project init`.
3. Raiz via `git rev-parse --show-toplevel`. **Nunca** assumir caminho de thread — resolver sempre.
4. Toda leitura de `gh` usa `--json` / `--jq`. A saída textual é reescrita pelo hook `rtk` e perde
   campos (medido: `gh pr checks` volta como resumo agregado, sem nome de check nem URL).
5. Coletor com `exit != 0` **aborta o tick**. Erro não é resultado vazio: sem coleta válida, o loop
   não sabe o que está acionável e não deve escrever nada (`reference/loop/collector.md` §"Falhas").

### Modos

Modos, invocações e flags: a tabela canônica em [Comando `/hades`](#comando-hades).

Sem modo explícito, o default é **`inbox` primeiro**; `deliver` só entra **se o inbox não encontrou
nada acionável** neste tick. Review recebido tem prioridade sobre trabalho novo, e um tick escreve em
uma PR só. Um pedido que nomeia o modo vale mais que o default.

Leia antes de rodar qualquer modo que escreva algo:

- **`reference/loop/gates.md`** — contrato de gate, guarda de push, locks (por PR e por recurso), esquema
  de estado, commits, ondas de correção e ritmo sob `/loop`.
- **`reference/loop/collector.md`** — flags, saída, avisos de truncamento e semântica de falha do
  `hades pr-loop-state`.
- **`reference/loop/report.md`** — o formato único de relatório que todos os modos usam.

### Máquina de estados por PR

Produzida por `hades pr-loop-state` (`--json` para consumir). Um estado por
PR, na ordem de prioridade abaixo — **o primeiro que casa vence, e esta ordem é a mesma implementada
no coletor (`CLASSIFIERS`)**. Divergência entre esta tabela e o código é defeito, não documentação
velha.

| Estado            | Condição                                                         | Ação                                                                |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ci-red`          | algum check falhando                                             | Consertar o CI antes de qualquer outra coisa                        |
| `conflict`        | `mergeStateStatus: DIRTY` / `mergeable: CONFLICTING`             | Cascata #2; conflito não trivial **escala ao dono**                 |
| `needs-response`  | achado vivo, comentário top-level humano, ou review não visto    | Modo inbox                                                          |
| `needs-triage`    | só achados a triar (outdated, não resolvidos)                    | Fase 0 do inbox                                                     |
| `stale-base`      | `mergeStateStatus: BEHIND`                                       | Cascata #2 (merge da base)                                          |
| `draft`           | `isDraft`                                                        | Nenhum job de CI roda: reportar e sugerir `ready_for_review`        |
| `ci-running`      | check pendente                                                   | Observar (`watch`), não reprocessar                                 |
| `awaiting-review` | sem review posterior ao último push                              | Provoca o bot do perfil se a base é a do CI; senão publica o review local |
| `no-ci`           | nenhum check existe (base fora das do CI, ou CI nunca disparou)  | Só o gate local responde — **nunca reportar como pronta**           |
| `done-pending`    | `unresolved == 0` + review posterior ao push + checks **verdes** | **Para e reporta** — merge é manual                                 |
| `needs-attention` | sobra: pendência que só o humano destrava                        | Reportar o que espera resposta e parar                              |


Os predicados que sustentam a tabela (achado vivo, a triar, esperando reviewer, comentário top-level, review não visto, check verde) e `reviewDecision` não ser gate de conclusão: `reference/loop/collector.md` §Predicados da máquina de estados.

### Invariantes de segurança (não destraváveis)

Não cedem a pedido na invocação. Se o dono pedir um destes, responda o que a regra protege e o que
dá para fazer no lugar; se ele reafirmar, ele executa a ação, não o loop.

- **Nunca faz merge.** O fluxo para em `done-pending` e reporta. Merge é decisão do dono.
- **Nunca pusha sem conferir `git rev-parse --abbrev-ref @{upstream}` contra o `headRefName` da PR.**
  Há branches locais rastreando a branch errada; push cego escreve na PR de outra pessoa.
- **Nunca pular hook do repo** (`--no-verify` e equivalentes), nunca `--force`/`--force-with-lease` em branch sob
  review. O que o hook pula e o que o push não compensa estão em `reference/loop/gates.md` §2.
- **Nunca enfraquecer teste para passar**: sem `skip`/`xit`, sem asserção removida, sem budget
  elevado.
- **Nunca declarar como verde um gate que não rodou.** Inclui a saída `75` do `gate-lock.sh`, que é
  gate **enfileirado**, não gate aprovado (`reference/loop/gates.md` §3.2).
- **Nunca resolver thread** cujo achado foi refutado ou cuja verificação ficou indeterminada.
- **Nunca `gh pr review --approve` / `--request-changes`.** Publicação de review sai como
  `event: COMMENT`.
- **Nunca editar à mão arquivo gerado** nem rodar comando destrutivo de banco: a lista do projeto vem de
  `refs.invariants`.
- **Nunca commitar com trailer de co-author.**
- **Card é obrigatório quando o perfil o exige** (`card.required`): toda unidade nova tem card **antes** de a
  branch existir. Card indisponível é **escalação**, não fallback: sem card, o tick não cria branch nem commit.
  Perfil sem `card.provider` trabalha sem card (`reference/loop/deliver.md`).
- **Nunca escrever estado, lock, checklist ou relatório de execução dentro do repositório.**


### Defaults e overrides

Valem sempre e cedem só a pedido explícito do dono na invocação (que entra no relatório com a consequência): tokens, modo orquestrado, gate em sequência e sempre pela fila (`gate-lock.sh run`), regras de código do projeto, uma PR por tick, subagentes só em quatro lugares. Skill de review avulsa que diga "push nunca" ou mande `--approve`/`--request-changes` perde para esta: push na branch de trabalho é autorizado e review sai sempre como `event: COMMENT`. Texto completo: `reference/loop/defaults.md`.

### Precedência de regras

Do mais forte ao mais fraco. Em conflito, o de cima ganha:

1. Os invariantes de segurança acima (os do núcleo e os de `refs.invariants`).
2. Pedido explícito do dono na invocação — sobrepõe os defaults, nunca os invariantes.
3. As regras do projeto, na ordem de `rules.docs` do perfil (vocabulário de severidade e formato de saída primeiro).
4. O padrão do arquivo vizinho — **o mais fraco de todos**. Regra documentada vence código existente;
   um mau exemplo no contexto não autoriza reproduzi-lo.

### Quando parar e perguntar (regra de escalonamento)

Traga ao dono, com o problema claro e alternativas descritas, antes de implementar:

- Impacto de performance, carga, concorrência ou volume de dados.
- Pedido de review que **contraria** regra documentada, ou que exige mudar contrato/spec aprovada.
- Conflito de merge não trivial, ou dois reviewers pedindo coisas incompatíveis.
- Quebra de contrato público sem caminho aditivo, migration com lock pesado ou qualquer coisa que peça janela de
  deploy (os casos do projeto estão em `refs.invariants`).

O resto do trabalho continua enquanto a pergunta espera: o que não depende da resposta é entregue.
A escalação vira registro em `escalations` e volta em todo relatório até ser respondida — a resposta
se registra com o modo `answer` (`reference/loop/ops.md`), para não reperguntar no tick seguinte.

