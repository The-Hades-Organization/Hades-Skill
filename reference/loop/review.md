# Modo review — revisar PRs de terceiros em paralelo

`/hades review [--max N] [--author <login>] [--pr N] [--deep] [--dry-run]`

Revisa até N PRs **em paralelo** e publica o resultado no GitHub. (Não é o `hades agent review`: aquele roda numa
worktree em HEAD destacado, com `/review-agents`, não publica nada e grava `.design-sync-reports/review-<PR>.md`; ver
`roles/review.md`.) É o único modo que não roda gate e
não toca o working tree — por isso conviver com o modo `deliver` é seguro.

Se existir `.design-sync-reports/quality.md` (`reference/quality.md`), confira o diff contra as regras ligadas e cite o
id no achado.

Relatório no formato de `reference/loop/report.md`. Com `--pr N` (repetível) o lote é exatamente essas PRs, sem
seleção nem dedup — é o "revisa essa PR aqui".

## Invariantes deste modo

- **Não roda lint, build, teste unitário nem de integração.** Nunca. É review de leitura.
- **Não faz checkout.** Le por `gh pr diff` e `gh pr view --json`. Nada de `gh pr checkout`, nada de
  worktree — o working tree da sessão fica intocado.
- **Não aprova nem rejeita.** Publicação sai como `event: COMMENT`. `--approve` e
  `--request-changes` são decisão humana.
- **Não revisa PR minha.** PR própria é assunto do modo `inbox`.
- **Não republica no mesmo head.** `review.headOid` no shard da PR (`gates.md` §4) responde "já
  revisei esta PR neste head?". Igual → pule e diga por que. Push novo depois da publicação autoriza
  re-review.
- **Lock por PR, como todo modo.** Adquira o lock de cada PR do lote (`gates.md` §3.1), siga com as que
  conseguiu, e relate as que ficaram de fora por lock de outra sessão. O lote não espera a PR travada.

## 1. Selecionar o lote

```bash
# autor dado
hades pr-loop-state --author <login> --json

# sem autor: primeiro o que pediram para mim
gh pr list --repo <slug> --search "review-requested:@me" --state open --limit 100 \
  --json number,title,author,headRefName,baseRefName,isDraft,reviewDecision,updatedAt
# fallback: qualquer autor exceto eu
hades pr-loop-state --others --json
```

`--max` default **3**, teto **6**. Acima disso o custo explode e a qualidade cai.

Cheque `warnings[]` antes de fechar o lote: `search-truncated` significa que há candidata fora da
coleta — suba `--limit` ou estreite o escopo, e diga no relatório quantas ficaram fora.

### Dedup obrigatório antes de escolher

Agrupe as candidatas pelo `cardIds` que o coletor já extrai do título e da branch (`card.idPattern` do
perfil — não reimplemente a regex). Há autores com o mesmo
trabalho aberto em duas formas (uma PR original e o par refatorado que a divide em duas). Revisar as
duas versões do mesmo trabalho é desperdício: escolha a mais recente do grupo e mencione no relatório
que a irmã foi preterida, com o número.

Depois do dedup, ordene por: pediram review para mim > sem nenhum review ainda > mais antiga sem
atividade. Prefira PR não-draft; draft entra só se o dono pedir, e o relatório diz que é draft.

Anuncie o lote escolhido (números, autores, o que foi deduplicado) **antes** de disparar.

## 2. Revisar em paralelo

**Um agente por PR**, todos numa única mensagem. Se a PR toca arquivo citado em post-mortem anterior (`hades thanatos cited --pr <n>`), o agente leva o aviso e lê o post-mortem. Cada agente:

- Recebe: número da PR, `slug` do repo, base, o ID de spec do body, e a instrução de carregar
  os documentos de regras do projeto (`rules.docs` do perfil) **integralmente** antes de olhar código.
- Executa o procedimento do `/review-pr` / skill `code-review-local`, na ordem de prioridade que o projeto declara
  (`ref review`).
- Le a spec referenciada **antes** do código, e a fonte das regras de negócio do projeto.
- Confere as exceções documentadas do projeto antes de emitir achado — não reportar falso-positivo conhecido é parte
  da qualidade.
- Devolve os achados no formato de saída das regras do projeto, cada um com `arquivo:linha` e o código da regra.

Com **`--deep`**: em vez de um agente por PR, monte a matriz PR × escopos roteados
(o mapa de escopos por tipo de diff do projeto, `ref review`) e despache os subagentes `review-*`
correspondentes, com teto de ~16 concorrentes no total. Use só quando o dono pedir profundidade —
`--deep` com `--max 4` já passa de 20 agentes.

## 3. Consolidar

Um relatório **por PR**, no formato das regras de review do projeto (`ref review`), salvo em `<work>/report-pr-<n>.md`:

```markdown
## 🔍 Resumo do review

**Veredito:** 🔴 bloquear / 🟡 ajustes / ✅ aprovado
**Spec:** [<ID>](caminho) — ✅ aderente / 🟡 divergente / 🔴 ausente
**Achados:** 🔴 N · 🟡 N · in-line M

### 🔴 Bloqueantes

1. `<codigo>` `arquivo:linha` — <ajuste concreto no imperativo>

### 🟡 Ajustes

**`caminho/arquivo.ts`**

1. `<codigo>` L<linha> — <ajuste concreto no imperativo>

### ✅ Pontos positivos

- (opcional, max 2 bullets; omitir se aprovado limpo)
```

Regras do resumo que valem literalmente: um achado = **uma linha**; listas numeradas por prioridade;
seção com ~4+ achados subagrupa por arquivo; seção vazia = `nenhum`; mesmo defeito em N locais = N
in-line + **uma** entrada no resumo com a contagem; veredito 🔴 se qualquer achado bloqueante.

Padrão do in-line, uma linha: `<codigo> — <o que está errado> → <fix concreto>`. Sem `arquivo:linha`
(o anchor localiza). Proibido preâmbulo, elogio, reexplicação e hedging ("considere", "talvez").
Dúvida genuína vira `[❓]` + a pergunta em uma linha.

Resolva sobreposição entre escopos pela tabela de fronteiras de escopos do projeto (`ref review`) — não
publicar o mesmo achado duas vezes por ter vindo de dois ângulos.

## 4. Publicar

Com `--dry-run`, para aqui: mostra o relatório local e não publica nada.

Publicação normal é **uma** chamada por PR, atômica:

```bash
gh api repos/<owner>/<repo>/pulls/<n>/reviews -X POST --input <payload.json>
```

```json
{
  "commit_id": "<headRefOid da PR>",
  "event": "COMMENT",
  "body": "<o resumo em markdown>",
  "comments": [{ "path": "apps/<app>/src/a.ts", "line": 42, "side": "RIGHT", "body": "<codigo> — <erro> → <fix>" }]
}
```

**Valide cada linha contra os hunks `RIGHT` do diff antes de montar o payload.** O GitHub rejeita a
chamada inteira se um único comentário cai fora de hunk — é uma rejeição derruba o review todo.
Achado fora do diff **não se descarta**: vai para o corpo do resumo com `arquivo:linha` explícito.

Para range use `start_line` + `line`. `commit_id` é sempre o head atual: se a PR recebeu push durante
a revisão, recolete o head e revalide as linhas antes de publicar.

Depois de publicar, grave `review` no shard da PR (`gates.md` §4) com `headOid`, `reviewId`, `event`,
veredito e as contagens (`blocking`, `important`, `inline`, `outOfHunk`). É esse `headOid` que impede
republicar o mesmo review na próxima passada — e que autoriza re-review quando a PR recebe push.

## 5. Relatar ao dono

Formato em `reference/loop/report.md`. Por PR: número, autor, veredito, contagem 🔴/🟡, quantos in-line foram
publicados, quantos achados foram para o resumo por caírem fora de hunk, e o caminho do relatório
local. Mais o que foi deduplicado, o que ficou de fora do lote por `--max`, e o que ficou de fora por
lock ou por `review.headOid` igual.

Se um agente não teve nada a reportar, diga "sem achados" — omitir o agente esconde cobertura.

## 6. Revisão pelo painel e `hades review`: fila e fases

Isto vale para a revisão disparada pela página Revisões (units `hds-pjob-*`) e para o `hades review` no terminal, não
para o lote deste modo.

- **Teto.** No máximo `HADES_REVIEW_MAX_PARALLEL` revisões (padrão 4, Configurações → Modelos por papel) rodam juntas na
  máquina: um semáforo por arquivo de lock (`~/.claude/hades/reviews/slots/slot-<i>.lock`, `flock` não bloqueante, sem
  processo central; o kernel solta a vaga se o processo morrer). A revisão que excede o teto espera em `fila`, sem falhar
  e sem prazo; 25 disparos juntos viram 4 rodando e 21 esperando. O que o dono não deve fazer: contornar com `xargs -P`.
- **Prazo.** `GIT_TIMEOUT_MS` (300 s) do `fetch` e do `worktree add` só começa a correr depois da admissão: esperar na fila
  não consome o prazo.
- **Fases.** `fila` → `fetch` → `checkout` → `revisão` → `publicação` (esta só com `--post`, quando a sessão chama
  `gh api` ou `hades review-record`). Aparecem como linha `[fase] <nome>` no log, em **Em curso** (Revisões) e na
  página Execuções.
- **Checkout leve (medido, não adotado).** `--no-checkout` ou sparse com os caminhos do diff tiram do worktree o código
  vizinho que o `/review-pr` e os subagentes leem (chamadores, testes, contratos); o prazo deixa de estourar, mas o
  review perde contexto. Com a fila, o checkout completo de ~4 por vez cabe no prazo. Medição no relatório da unidade.
