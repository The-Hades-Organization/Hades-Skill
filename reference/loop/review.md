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

`--max` default **3** (só na chamada sem escopo explícito), **sem máximo**: com `--max N`, `--pr` repetido ou `--author` o lote é o que foi pedido
(ou todo o escopo). Lote grande custa proporcionalmente mais; quem limita a máquina é a fila (§6, `HADES_REVIEW_MAX_PARALLEL`), e as
excedentes esperam vaga.

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

## 7. Loop de revisão — `hades review --loop`

`/hades review --loop [--every 30m] [--author <login> | --pr N…] [--max N] [--deep] [--until <HH:MM|ISO>] [--rounds N] [--no-post] [--note <nota>]`

Mantém as PRs revisadas ao longo do dia: de `--every` em `--every` (padrão `HADES_REVIEW_LOOP_EVERY_MIN`, 30 min; piso 1 min) uma
**rodada** busca as PRs do escopo e revisa só as de **head novo** ou **nunca revisadas**. É um processo próprio, longo: o
`/hades review --loop` o inicia em segundo plano (`run_in_background`) e o relato de cada rodada sai no log dele. Cada
revisão é um `hades review --post` filho (§6): a fila de vagas (`HADES_REVIEW_MAX_PARALLEL`) e as fases são as de sempre, sem
segundo caminho. O modo não roda gate, então não há vaga de gate a esperar. Publicação sempre `event: COMMENT`; nunca
aprova nem pede mudanças. `--no-post` só guarda os relatórios locais.

- **Escopo** (mesmo filtro da §1, sem o dedup por card): `--pr N` (repetível, rascunho entra), `--author` ou
  `review-requested:@me`. Sem o fallback "qualquer autor", senão o escopo nunca esvaziaria. PR minha é pulada. `--max N` limita as
  revisões por rodada; o excedente fica para a seguinte (motivo `adiada`).
- **Estado** em `~/.claude/hades/work/<owner>__<repo>/review-loop/`, nunca no repo: `pr-<n>.json` (último head revisado, data,
  link do review, achados abertos), `rounds.jsonl` (uma linha por rodada, com custo, tokens e o % de cada janela de uso antes e
  depois), `status.json`, `loop.flock` e `stop`. Só uma revisão **concluída** avança o estado; a que falha é refeita na rodada
  seguinte. Head igual ao último revisado não gera revisão.
- **Achado repetido.** O prompt da revisão leva os achados que o review anterior deixou abertos (`código|arquivo` é a
  identidade; a linha anda entre heads) e manda não os publicar de novo: sem achado novo e com abertos, nada é publicado
  (`posted=no`). A sessão fecha o relatório com uma linha `HADES-ACHADO: <red|yellow>|<aberto|novo>|<codigo>|<arquivo>|<linha>` por
  achado em pé; elas viram o estado da PR (`achados` no registro da revisão). O loop não consegue retirar o que a sessão já
  postou: o que garante é o contexto, e o aviso só sai para bloqueante cujo `código|arquivo` não estava aberto.
- **Concorrência.** Duas rodadas nunca se sobrepõem: o loop segura um `flock` por repositório e o segundo `--loop` recusa. Cada PR
  revisada leva o lock de PR (`gates.md` §3.1, `mode=review-loop`); PR com lock de outra sessão é pulada, com o dono do lock no
  motivo.
- **Canvas.** Cada revisor da rodada é registrado como agente (`mode: review-loop`, `orchestrator` = o pane de quem roda o loop,
  como em `hades agent new`) e fecha como `done` no fim da rodada. Com `--note <nota>` o resumo da rodada é anexado à nota
  (`hades canvas note write --append`; o terminal do loop precisa estar ligado a ela). Fora de pane do herdr, nada disso é
  feito. `notify` (evento `pr`) só com achado bloqueante novo.
- **Parada.** `--rounds N`, `--until` (`HH:MM` no fuso do dono, já passada vale amanhã; ou instante ISO com fuso), `hades review
  loop stop` (o loop acorda em até ~2 s, e a revisão em curso termina antes) e sozinho com escopo vazio (nenhuma PR aberta).
  `hades review loop status` mostra o estado. Rodada pausada ou com falha na busca não conta em `--rounds`.
- **Custo.** Antes de cada rodada mede as janelas (`reference/limites.md`): passou de `HADES_REVIEW_LOOP_PAUSE_FIVE_PCT` (85) ou
  `HADES_REVIEW_LOOP_PAUSE_SEVEN_PCT` (90), o loop pausa, avisa uma vez por janela e renovação (`notify` evento `agent`) e confere
  de novo a cada `--every`, retomando sozinho. Sem coleta ligada, não pausa. O painel (Revisões → Loop de revisão) mostra o
  estado e, por rodada, o custo, os tokens e o % das janelas.
- **`--dry-run`** imprime o plano da rodada (`#7 revisar (head novo …) · #8 pular: head igual …`) e sai: sem lock, estado, canvas
  nem revisão.
