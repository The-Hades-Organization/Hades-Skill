---
description: Hades — loop de engenharia por projeto (entrega de PRs, reconciliacao de reviews, review de terceiros, cascata, orquestracao, consolidacao) e ambiente local (/hades env)
argument-hint: '[deliver|inbox|review|cascade|sweep|status|locks|answer|ready|watch|resume|orchestrate|consolidate|usage|env <acao|onboard>|project init] [--orchestrated] [--max N] [--author L] [--pr N] [--deep] [--dry-run] [--allow-in-review] [--no-integration] [--max-iters N]'
---

Invoque a skill `hades` e execute o modo pedido em `$ARGUMENTS`.

As regras, os invariantes e a precedencia vivem na skill — **este arquivo nao os repete**, para nao
existir uma segunda fonte de verdade que divirja da primeira. Leia
`~/.claude/skills/hades/SKILL.md` e o reference do modo (`~/.claude/skills/hades/reference/loop/<modo>.md`;
agente orquestrado: o cartao `reference/loop/roles/<papel>.md`) antes de agir. A ferramenta e
local-only: skill, comando, coletor e `hades gate-lock` vivem em `~/.claude`, e nada dela entra no repo.

## Parsing

- **Modo** = primeira palavra de `$ARGUMENTS`: `deliver` | `inbox` | `review` | `cascade` | `sweep` |
  `status` | `locks` | `answer` | `ready` | `watch` | `resume` | `orchestrate` | `consolidate` | `usage` | `env` | `project`.
  Ausente → antes de tudo, rode `hades onboard status --line --quick`: se imprimir uma linha, mostre-a ao dono como primeira linha da resposta (onboarding incompleto; não bloqueia nada) e siga. Depois rode **`inbox`**, e **`deliver` so se o inbox nao achou nada acionavel** neste tick.
  Se `$ARGUMENTS` traz um ID de spec ou caminho de arquivo sem nomear modo, o modo e `deliver`.
- **`env <acao>`** — Parte I do `SKILL.md` (`up|update|pause|resume|status|panel|config|doctor|onboard`; `doctor [--quick|--json]` → `hades doctor`); `onboard` → pergunta com `AskUserQuestion` (multiSelect) quais features preparar (remoto, notificacoes, automatico, contas), grava com `hades onboard select|skip`, roda com o ok do dono só os passos da Hades (`hades onboard run <passo>`) e entrega os passos do dono com o comando pronto, prefixo `! ` nos interativos; detalhes em `reference/onboard.md`.   `hades instance` (do diretorio atual: a instancia do projeto ou, sem ela, a padrao); saida 1 → o ambiente nao foi instalado (Fase 1): avise e pare, sem instalar.
- **`project init [--dry-run]`** — gera o perfil do repo atual (`reference/project-init.md`): `hades project-init draft <repo>` monta o rascunho com a evidencia de cada campo, pergunta ao dono (`AskUserQuestion`) o que ficou incerto e **so grava com o ok**, via `save --confirmed`; repo com perfil mostra o diff e pede ok (`--force`), nunca sobrescreve calado. Stack sem pacote: oferece `/hades stack add`. `--dry-run` nao grava nada. Nao exige perfil nem o ambiente (`$D`).
- **`orchestrate [<objetivo>]`** — papel de orquestrador (`reference/loop/orchestrate.md`).
- **`consolidate <PR>...`** — PR de consolidacao (`reference/loop/consolidate.md`).
- **`usage [--days N]`** — `hades usage`.
- **`--orchestrated`** (deliver, inbox, cascade, consolidate) — passada de agente alocado: cartao do papel,
  brief e gate do modo orquestrado (`gates.md` §1.0).
- **`--max N`** (review) — teto de PRs no lote. Default 3, maximo 6.
- **`--author <login>`** (review) — restringe ao autor. Ausente → `review-requested:@me`, com fallback
  para PRs abertas de outros autores.
- **`--pr N`** (inbox, review, cascade, watch, locks) — restringe a essa PR; repetivel.
- **`--deep`** (review) — matriz PR × escopos roteados em vez de um agente por PR. Caro: anuncie a
  contagem de agentes antes de disparar.
- **`--dry-run`** (todos os modos que escrevem) — produz o plano, o checklist e o relatorio locais e
  **nao escreve nada** fora de `~/.claude/hades/work`: sem commit, sem push, sem comentario, sem mutacao no
  GitHub e **sem criar card no ClickUp** — o relatorio diz qual card *seria* criado (`deliver.md` §3.2).
- **`--allow-in-review`** (deliver) — autoriza implementar spec em `status: in-review`. Sem a flag, so
  `approved` entra na fila.
- **`--no-integration`** (deliver, inbox) — declara que o gate de integracao fica de fora nesta
  passada (sem Docker, por exemplo). O relatorio registra o gate como **nao rodado**, com o motivo.
- **`--max-iters N`** (deliver, inbox) — teto de ondas de correcao. Default 3 (`gates.md` §6).

## Antes de agir (modos do loop)

1. Pre-condicoes do `SKILL.md` §"Pre-condicoes" (`gh`, perfil do repo ativo via `hades project resolve`, raiz via
   `git rev-parse --show-toplevel`, `gh` sempre com `--json`/`--jq`).
2. Rodar o coletor (`reference/loop/collector.md`) e **anunciar o alvo** (PR ou spec escolhida, e por que)
   antes de escrever qualquer coisa. `exit != 0` ou aviso de truncamento que afete o alvo → reporte e
   pare; coleta invalida nao autoriza escrita.
3. Adquirir o lock da PR (`reference/loop/gates.md` §3.1). Lock de outra sessao nao se rouba.
4. Todo comando de gate vai por `hades gate-lock run` (§3.2);
   `hades gate-lock status` mostra a fila antes de comecar. Esperas sempre em segundo plano
   (`hades wait`), nunca por polling — o hook da Hades barra.

## Autorizacoes desta invocacao

Autorizado sem perguntar a cada vez: **commit e push na branch de trabalho**, **abrir e atualizar a
PR**, **responder e resolver threads de review**, **publicar review** no modo `review` (sempre como
comentario) e **mexer no card do ClickUp da unidade em trabalho** — localizar, **criar** quando nao
existe, e mover status pelo `clickup-sync`.

A criacao do card e **autonoma**: as respostas da `/clickup-create` saem da spec (`deliver.md` §3.2), sem
confirmacao, porque um tick de `/loop` desassistido nao tem quem confirme. E o card e **pre-condicao da
branch** — `NO-CARD` nao existe neste fluxo e **nenhuma flag desliga isso**: e invariante
(`SKILL.md` §"Invariantes de seguranca"), nao default. Card indisponivel para a unidade em trabalho =
escalacao, e o tick para sem criar branch nem commit.

Fora dessa lista, escrita em servico externo pede confirmacao — inclusive card de terceiro, alteracao
de sprint e qualquer coisa que nao seja o card daquela unidade. Nunca merge.

O que nunca e autorizado esta em `SKILL.md` §"Invariantes de seguranca".

## Saida

O formato unico esta em `reference/loop/report.md`. Em pt-BR, com o alvo, o que mudou, os gates que
rodaram **com o resultado real** (gate que nao rodou se declara como nao rodado, com o motivo), os
achados aplicados/refutados/escalados, os avisos do coletor e o que ficou pendente. Escalacao aberta
de passagens anteriores volta no relatorio ate ser respondida.

Sob `/loop`: uma passada por tick, `noop` quando nada mudou, e encerrar quando so restarem escalacoes
esperando o usuario.
