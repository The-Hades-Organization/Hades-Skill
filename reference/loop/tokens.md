# Tokens: o que custa e como a Hades controla

Medido em 2026-10-23 (7 dias, transcripts locais, `hades usage`): ~US$ 314/dia equivalentes. Agentes do herdr = 63%;
deles, 58% é **reler contexto** (contexto médio de 226–295 mil tokens por turno, sessões de 260–420 turnos) e 16% é
**polling**. A leitura de cache custa US$ 0,20/MTok no Opus 5.5 e no Sonnet 5.5: trocar de modelo corta escrita e
output, não o componente dominante. O que corta é **contexto curto** e **menos turnos**.

## As sete regras (todas configuráveis no painel)

1. **Modelo e esforço por papel** (Configurações → Modelos por papel). Orquestrador Opus high; spec Opus medium;
   implementação e consolidação Sonnet medium; revisão Opus medium; subagentes de review por mapa. Escalada (conflito
   não trivial, quebra de contrato, gate falhando depois de N ondas) abre sessão de escalada com o modelo de escalada —
   **nunca `/model`**, que grava o modelo como padrão global de todas as sessões da máquina.
   **Padrão herdado.** Quem sobe sem `--model`/`--effort` (sessões interativas, agentes sem flags) roda no `model` e
   `effortLevel` do `~/.claude/settings.json`, e os subagentes herdam o modelo da sessão pai. Configurações → Modelos por
   papel mostra esse padrão numa linha (só leitura) e o `hades doctor` (`settings-padrao`) avisa quando ele é caro:
   `effortLevel` `xhigh`/`max`, `model` com `[1m]` (os tetos viram só aviso), chave do `modelSettings` que não casa com
   o modelo em uso, ou padrão acima de todos os papéis. A Hades só avisa; o `settings.json` é do dono.
2. **Sessão por fase.** Spec, implementação e cada rodada de review começam limpas (`hades agent phase`, que manda
   `/clear` pelo herdr); a continuidade é o `handoff.md` e o estado do loop, não o histórico.
3. **Teto de contexto por papel**, aplicado pelo `hades guard` (PostToolUse) em toda sessão. Agente orquestrado:
   grava `handoff.md` com `STATUS: PARKED — teto de contexto` e para; o orquestrador `resume`. Orquestrador e sessão
   interativa: só o aviso para atualizar o estado e pedir `/clear` ao dono — nunca param sozinhos. O papel vem do registro cuja
   worktree é a **mais específica** da pasta da sessão (fronteira de diretório) e vale também depois de o agente encerrar; o
   registro recusa (`WORKTREE_CONTAINS_AGENTS`) uma worktree que contém outras. Recruta do canvas sem registro: o teto da chave
   do papel do Argos, senão `HADES_CTX_CAP_RECRUIT` (`reference/config.md`).
4. **Zero polling.** O `hades guard` (PreToolUse) barra `sleep` de espera, laço com `sleep`, `tail -f`, `--watch` e
   `herdr wait` em primeiro plano e a mesma checagem repetida dentro da janela. Toda espera é um comando em segundo
   plano que acorda a sessão: `hades wait` (agentes) e `hades watch --next` (orquestrador). Para esperar um processo
   pelo nome, `hades wait proc <padrão>` (padrão do `pgrep -f`). Laço com `sleep` em segundo plano não é barrado, mas
   o guard avisa com o `hades wait` equivalente (`HADES_POLL_GUARD=0` desliga o aviso também).
5. **Leitura sob medida.** O `hades guard` avisa (sem barrar) quando uma sessão lê inteiro um arquivo acima de
   `HADES_READ_WARN_KB` (padrão 20; 0 desliga): `Read` sem `limit`/`offset`, `cat <arquivo>`, `sed -n` com faixa de mais
   de 400 linhas, `head`/`tail -n` grande sobre arquivo (não sobre pipe), inclusive saída persistida em `tool-results/`.
   Procure com `grep -n` e leia o trecho com `sed -n 'A,Bp'`; o que entra no contexto é relido a cada turno.
6. **Plano curto.** O plano do orquestrador tem uma seção "Estado atual" (~3 KB, reescrita) e o histórico em
   `<plano>.log.md` (append); a retomada lê só a seção (`reference/loop/orchestrate.md` §1.1).
7. **Estacionar antes de esperar longe** (resposta do dono, fila do gate além do limite): handoff + `PARKED`, para não
   pagar a reescrita do contexto inteiro quando o cache expira (> 1 h parado).

## Medir

- `hades usage [--days N]` (ou painel → **Consumo**): custo por papel, agente e dia; contexto médio e máximo;
  polling; reescritas; comparação com a linha de base (`--baseline` grava a janela atual).
- **Polling** = turno com espera **em primeiro plano**, pela definição do `hades guard` (`FG_POLL`: `sleep` ≥ 10 s,
  laço com `sleep`, `tail -f`, `watch`, `gh run watch`, `herdr … wait`, `hades wait`) mais as checagens que o hook só
  barra na repetição (`gh pr checks`, `gh run view`, `herdr agent|pane read|list`, `gate-lock.sh status`). Não conta
  `| tail -N` (corta saída), `sleep` curto esperando processo subir, `Monitor` nem nada em segundo plano. Medido em
  2026-10-26 (3 dias): a regex antiga marcava US$ 42, a definição acima, US$ 4.
- O `hades watch` avisa `CTX-OVER` (agente que passou do teto do papel e seguiu trabalhando; o orquestrador estaciona com `hades agent park`) e `PARKED`; o painel mostra agente com contexto médio acima de 200 mil em destaque.
- O `hades watch` avisa `MODEL-MISMATCH <agente> <real> <configurado>` no primeiro turno da sessão que rodou fora do `HADES_MODEL_<PAPEL>` (uma vez por sessão).
- **Modelo real × configurado.** `hades usage` e a página Consumo leem o `message.model` das transcrições de cada agente registrado e comparam com o `HADES_MODEL_<PAPEL>` do papel (apelido de família, como `sonnet`, vale como a versão mais nova da tabela de preço). A coluna "modelo" mostra o real; a divergência vem destacada com o custo que representou: custo real menos o custo dos mesmos tokens no modelo configurado (escrita de cache contada como a de 5 min). Só a sessão principal entra; subagente tem modelo próprio. O esforço entra só quando a transcrição o registra (`effort`); não observável não é divergência, e a divergência de esforço não leva custo. **Exceção:** sessão aberta depois do `escalatedAt` que `hades agent escalate` grava no registro não conta. Papel sem modelo configurado, ou com modelo fora da tabela de preço, não é comparado. Tabela única de preço e de ordem de custo: `src/lib/price.ts`.
- **Acompanhamento × decisão (orquestrador).** `hades usage` e a página Consumo separam, no papel `orchestrator`, os turnos de acompanhamento dos de decisão/escrita, com turnos, contexto médio e custo por grupo (`byRole[].followup` no JSON). Regra (`src/lib/turn-class.ts`, função pura sobre o turno do transcript): **acompanhamento** é o turno em que todo `tool_use` é `Monitor`/`ScheduleWakeup` ou Bash só de `hades wait|watch`, `hades agent list|status`, `hades gate-lock status`, `herdr pane|agent read|list|get`, ou `cat|tail|head` da saída de tarefa em segundo plano (`…/tasks/<id>.output`), sem redirecionamento que grave arquivo; um turno sem tool também conta quando responde direto a um aviso `<task-notification>` (o despertar do wait). **Decisão** é todo o resto (escrever, recrutar, `agent prompt`, ler arquivo, responder o dono), e qualquer dúvida cai em decisão: a medida subestima o acompanhamento, nunca o infla. Cada despertar relê o contexto inteiro, por isso o custo do acompanhamento é turnos × contexto médio, não o tamanho da resposta.
- Consumo (`hades usage` e a página) destaca as sessões cujo contexto máximo passou do teto do papel (`ctxMax` > `ctxCap`; igual ao teto não conta). Subagente não entra: o teto é da sessão principal.
- Meta da mudança de 2026-10-23: custo por entrega concluída ~45% menor que a linha de base, sem aumentar as rodadas de
  review por PR. Julgue por entrega, não por requisição.
