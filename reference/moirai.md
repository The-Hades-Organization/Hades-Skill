# Moirai — estimativa de custo e duração por unidade

`hades moirai` lê o que as unidades encerradas custaram e estima o que cada unidade de um plano vai custar, antes da
aprovação. Só lê (registros dos agentes, transcripts, histórico do gate, git); a única escrita é `estimate --write`, no
plano. Regra pura em `src/lib/moirai.ts`; borda em `src/commands/moirai.ts`.

```
hades moirai history [--json]
hades moirai estimate <plan.md> [--write] [--deep] [--json] [--mode skill|projeto]
```

## Histórico (`history`)

Uma linha por unidade **encerrada** (`state` done ou archived) de qualquer raiz de trabalho
(`~/.claude/hades/work/*`, inclusive `_skill`; `_maquina` não tem agentes). Campos (também no `--json`, `{v, units[]}`):

| Campo | De onde |
|---|---|
| `role`, `mode` (`skill` ou `projeto`: tudo que não é `skill`) | registro `orchestration/agents/<nome>.json` |
| `costUsd`, `tokens` | transcripts do worktree (`~/.claude/projects/<cwd codificado>`), pelo parser do `hades usage` (mesma tabela de preço, sem duplicá-la). `tokens` = leitura de cache + escrita de cache + saída |
| `wallS` | `createdAt` (ou `adoptedAt`) até `doneAt` (ou `archivedAt`), em relógio: inclui a noite em que o agente ficou parado |
| `gateS`, `gatePeakMb` | linhas `done` do `gate-journal.tsv` (máquina e raízes) cujo label é o nome da unidade: soma de `dur=` e maior `peak=`. Unidade que usou outro label no gate fica com 0 |
| `clears`, `resumes` | `clears` e `resumes` do registro. `phase` e `resume` fazem /clear, então os dois incrementam `clears`; só o `resume` incrementa `resumes` (`afterFreshSession` em `lib/agent-registry.ts`). Registro de antes da 5.11.0 não tem o campo e fica `null` |
| `files`, `lines`, `band` | commits da própria branch (primeiro pai, sem merges) entre o início e o fim da unidade: arquivos distintos e linhas adicionadas + removidas. Funciona depois do merge; `null` se a branch já foi removida (`skill-clean`) |

Faixas de tamanho (`band`): `pequena` < `HADES_MOIRAI_SMALL_LINES` ≤ `media` < `HADES_MOIRAI_LARGE_LINES` ≤ `grande`.

**Critério de raiz real.** A unidade entra se está encerrada **e** deixou rastro de trabalho de verdade: transcript com
custo, ou worktree ainda existente. Registro de fixture de teste não tem nenhum dos dois e fica de fora; não há lista de
nomes. A mesma unidade vista em duas raízes (mesmo nome e `createdAt`) conta uma vez. A janela é
`HADES_MOIRAI_WINDOW_DAYS` (por `doneAt`; 0 = tudo).

## Estimativa (`estimate`)

Por linha da tabela `## Unidades` do plano (colunas `Unidade`, `Papel` e `Escopo` ou `Specs`; plano sem essa tabela é
erro). O **modo** do plano é `skill` se o arquivo está em `~/.claude/hades/plans/`, senão
`projeto`; `--mode` força.

1. **Tamanho declarado:** `~N linhas` no escopo, ou `N arquivos` (vale 60 linhas cada). Define a faixa.
2. **Parecidas:** histórico com o mesmo papel, o mesmo modo e (se há tamanho declarado) a mesma faixa. Com **5 ou mais**
   (`HADES_MOIRAI_MIN_SAMPLE`): mediana e quartis p25 e p75 de custo, tokens, relógio e gate (gate só entre as que
   passaram por ele). Confiança `media`; `alta` a partir de mínima × `HADES_MOIRAI_HIGH_FACTOR`. Sem tamanho declarado a
   confiança nunca passa de `media` (só papel e modo foram comparados).
3. **Menos de 5 parecidas:** confiança `baixa` e regra **só de tamanho**: taxa por linha (mediana e quartis) das unidades
   com tamanho real × linhas declaradas (`basis: tamanho`). Sem tamanho declarado: mediana de todo o histórico
   (`basis: geral`). Sem histórico: `basis: sem-historico`, confiança `nenhuma`, sem números.

A confiança baixa aparece **no texto** (linha `CONFIANÇA BAIXA em <unidade>: …` na saída e `- **Confiança baixa** em …` na
seção), não só no JSON. O **p75** de custo é o que o §Teto na execução usa como limite.

`--deep` (só a pedido; sem ele nenhum modelo é chamado) abre `claude -p` com o modelo do papel orchestrator
(`HADES_MODEL_ORCHESTRATOR`), com Read/Grep/Glob, uma vez por unidade, pedindo `{"lines": N}`. A resposta vira o tamanho
da unidade **só quando o escopo não declara um**; resposta sem JSON válido é descartada com aviso. Teto de tempo por
chamada: `HADES_MOIRAI_DEEP_TIMEOUT_S`.

## Contrato (estável: só ganha campos)

**Seção `## Estimativa`** (`--write`; substitui a existente ou entra no fim; o resto do plano fica igual byte a byte).
Está **dentro do hash** da aprovação: reestimar pede nova aprovação (`hades agent plan-approve`). O `plan-approve` avisa,
sem barrar, quando ela falta. Entra na lista de seções do plano base (o `plan-trim` não a move). Formato:

```
## Estimativa
<!-- comentário -->
Gerada em AAAA-MM-DD · histórico: N unidades … · amostra mínima 5 · …

| Unidade | Custo p25 (US$) | Custo mediana (US$) | Custo p75 (US$) | Duração p25 (min) | Duração mediana (min) | Duração p75 (min) | Gate mediana (min) | Amostra | Confiança | Base |
|---|---|---|---|---|---|---|---|---|---|---|
| nome | 2.07 | 3.04 | 5.21 | 20 | 35 | 109 | 1 | 69 | media | parecidas |

- **Confiança baixa** em `nome`: <motivo>.
```

Colunas na ordem acima; ponto decimal; `—` onde não há número; `Confiança` ∈ `alta|media|baixa|nenhuma`; `Base` ∈
`parecidas|tamanho|geral|sem-historico`. `parseSection(planText)` (`lib/moirai.ts`) lê a tabela de volta.

**JSON de `estimate --json`:** `{v: 1, plan, generatedAt, params: {minSample}, history: {units}, units: [UnitEstimate]}`;
`UnitEstimate` = `{unit, role, mode, declaredLines|null, band|null, basis, sample, confidence, costUsd|null, wallMin|null,
gateMin|null, tokens|null, note}`, e cada métrica é `{n, p25, median, p75}` (custo em US$, tempos em minutos, tokens
em unidades). Campo novo é aditivo; mudar o significado de um existente pede `v` novo.

## Teto na execução (`hades watch`)

O watch compara o custo **corrente** de cada agente com o **p75 de custo** da sua linha na seção `## Estimativa` do plano
da raiz do agente (`plan.json` da raiz; mesmo plano aprovado, sem exigir o hash: a linha é lida como está). Sem plano, sem
a seção, sem a linha da unidade ou sem p75, nada é emitido nem gravado. Nunca para o agente: quem decide é o dono.

| Limite (Configurações) | O que sai |
|---|---|
| `HADES_MOIRAI_WARN_PCT` (100) do p75 | linha `BUDGET <agente> <pct>` ao orquestrador (também notificação `agent`) |
| `HADES_MOIRAI_ASK_PCT` (150) do p75 | pergunta `## Q<n> — custo passou de <N>% do estimado` gravada no `questions.md` do agente (seguir, reestimar ou estacionar) e a `QUESTION <agente> <abertas>` de sempre; responde-se com `hades agent answer`. Sai uma vez por agente e fase: a marca fica em `<orquestração>/budget-ask/<agente>.<fase>`, não no visto do watch nem no `questions.md`, então relançar o watch ou reescrever o arquivo não a repete; outra fase pergunta de novo |

- **Um aviso por limite por fase:** a chave de cada limite leva a fase do registro (`phase`, ou o papel). Mesma fase, mesmo
  limite, nada de repetir a cada evento; mudar de fase (`hades agent phase`) rearma. Passar dos dois de uma vez emite os dois.
  A pergunta do limite já gravada no `questions.md` para a fase (aberta ou respondida) vale: a resposta do dono não se
  repete mesmo que o "visto" do watch se perca. Uma unidade com o mesmo nome nas duas raízes (projeto e `_skill`) gera
  um evento só: o watch varre cada nome uma vez, e a primeira raiz vence.
- **Custo corrente:** soma do `usage` dos transcripts do worktree (`~/.claude/projects/<cwd codificado>`), mesma tabela de
  preço do `hades usage` e mesma regra de pedido (um `requestId` conta uma vez). Cache incremental por arquivo em
  `<estado do watch>/<agente>.cost.json` (`{offset, costUsd, ids}`): cada ciclo lê só os bytes novos, até a última linha
  completa; arquivo que encolheu recomeça do zero; entrada corrompida é descartada e relida.
- Valor inválido nas chaves de limite avisa no stderr e usa o padrão.

## Janelas (% dos limites de uso)

`hades moirai estimate` mostra a faixa p25–p75 do plano também em % das janelas de 5 h e semanal e se ela cabe no que
resta da janela atual (p75 contra o restante). O % vem do US$ estimado × a taxa de US$ por % calibrada com o uso real; a
fonte do % medido (JSON do status line, Claude Code 2.1.317), o formato, a calibração e o "sem calibração" estão em
`reference/limites.md`. A seção `## Estimativa` do plano não leva essas colunas (ela está no hash da aprovação).

## Estimado × real no painel

`GET /api/moirai/plan` (por raiz com plano aprovado: `path`, `approved`, e por unidade da seção `## Estimativa` a linha
estimada, o real `{costUsd, wallMin, state, phase}`, `pct` do p75 e `level` ∈ `ok|warn|ask`) e
`GET /api/moirai/unit/<nome>[?registry=<raiz>]` (uma unidade). Só leitura, mesma autenticação das outras rotas GET. O nome
tem de casar `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` (senão **400 `invalid_unit`**) e ser achado, por igualdade, nos registros
dos agentes (senão **404 `unknown_unit`**): ele nunca vira caminho. A resposta leva `warnPct` e `askPct` vigentes. Telas:
`reference/panel.md` (Consumo) e `reference/argos.md` (painel do nó).

## Armadilhas medidas

- Relógio (`wallS`) inclui a noite parada: a mediana aguenta, a média não; por isso só há quantis.
- A maioria das unidades antigas perdeu a branch (`skill-clean`): sem `lines`, não entram na regra de tamanho.
- Plano fora de `~/.claude/hades/plans/` é `projeto` por padrão: a cópia de um plano da skill precisa de `--mode skill`.
