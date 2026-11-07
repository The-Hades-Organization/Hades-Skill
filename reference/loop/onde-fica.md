# Onde fica o loop

Nada do loop entra no repositório. Tudo vive fora da árvore de trabalho, para servir qualquer clone:

| Caminho | Conteúdo |
|---|---|
| `~/.claude/skills/hades/reference/loop/` | as referências do loop (mapa abaixo) |
| `~/.claude/commands/hades.md` | o slash-command `/hades` (parsing dos parâmetros) |
| `hades pr-loop-state` | coletor de estado (read-only) |
| `hades review-anchors` · `hades review-record` | âncoras de achado e registro de review |
| `hades gate-lock` (`kit/gate/gate-lock.sh`) | fila de admissão de gate (lint/build/teste), a mesma dos builds do ambiente |
| `hades guard` | hook de toda sessão: barra test/lint/build fora da fila e polling (PreToolUse) e aplica o teto de contexto por papel (PostToolUse) |
| `hades wait` | esperas que notificam (CI, gate, fila, merge, review, resposta, agente), sempre em segundo plano |
| `hades usage` · `hades models` | consumo de tokens por papel/agente/dia (painel → Consumo) e modelo dos subagentes de review |
| `~/.claude/hades/work/<owner>__<repo>/` | estado, locks, checklists e relatórios (outra raiz: `HADES_WORK_ROOT` ou uma linha em `~/.claude/hades/work-root`) |
| painel → páginas **Loop** e **Fila de gates** | escalações, entregas, ações, PRs, agentes, locks e a fila ao vivo |

Mapa de `reference/loop/`:

| Arquivo | Quando ler | Quem lê |
|---|---|---|
| `deliver.md` · `inbox.md` · `review.md` · `cascade.md` · `consolidate.md` · `ops.md` | ao rodar o modo do mesmo nome (`ops.md`: `locks`, `answer`, `ready`, `watch`, `resume`) | a sessão do loop |
| `gates.md` · `collector.md` · `report.md` | antes de qualquer modo que escreva (lista abaixo) | a sessão do loop e o agente alocado |
| `tokens.md` | ao escolher modelo, esforço, teto de contexto e espera | todos |
| `orchestrate.md` · `plan-template.md` · `brief-template.md` · `brief-skill-template.md` | ao orquestrar: plano, brief de agente, brief de unidade da skill | o orquestrador |
| `roles/<papel>.md` | cartão curto de cada papel (spec, impl, consolidate, review, orchestrator): o agente lê o cartão, não a skill inteira | o agente alocado |
| `skill-dev-contract.md` | ao evoluir a própria skill numa unidade | a unidade da skill |

**O estado é por repositório, não por clone.** Dois clones do mesmo repo compartilham o mesmo diretório
de estado — uma thread triada num clone não se repete no outro. As contrapartidas são três, todas em `reference/loop/gates.md`: o
**lock por PR** (§3.1), que impede duas sessões de trabalhar a mesma PR; a **fila de admissão de
gate** (§3.2), que impede as sessões de somar mais memória do que a máquina tem — uma fila FIFO
global, orçamento de 8 GB, **um** gate pesado (teste unitário ou de integração) por vez e teto de
memória por gate; e o **estado shardado por PR** (§4),
que impede uma sessão de sobrescrever o registro da outra.

Se algo de estado, lock, checklist ou relatório de execução precisar ser escrito dentro do repo, é
bug: reporte em vez de escrever.
