# Modo deliver — da spec a PR aberta

Leve **uma** unidade de trabalho até PR aberta, com gate limpo e fan-out de review aplicado. Uma unidade = uma PR é o
default. Le `gates.md` antes: contrato de gate, guarda de push, lock, estado, commits, ondas. O formato do relatório
final está em `reference/loop/report.md`.

Este arquivo é o **esqueleto** do fluxo. O que depende do projeto (fonte da fila, onde mora a spec, formato de branch e
título, card, regras de código, faixas de gate, corpo da PR, como provocar o review) está no roteiro do pacote:
`hades project ref deliver`, mais `ref gates` e `ref invariants`. **Se o perfil tem, leia: vence o esqueleto.**
Perfil sem `refs.deliver` segue só o esqueleto, com os campos do perfil (`flow`, `branch`, `commit`, `card`, `work`).

Se existir `.design-sync-reports/quality.md` (regras de qualidade ligadas, `reference/quality.md`), aplique-as ao
escrever; conflito com regra do projeto vai ao relatório (seção "Conflitos de qualidade").

## Passo 1 — escolher a unidade

Fonte da fila, em ordem:

1. **O que o dono nomeou** na invocação (ID de spec, caminho ou card). Vence tudo.
2. **Item pronto sem PR**, nas fontes de `work.sources` do perfil (spec aprovada em `work.specsDir`, plano, card),
   cruzado com os IDs (`work.specIdPattern`) de **todas as PRs abertas**, não só das minhas:

   ```bash
   hades pr-loop-state --json          # minhas PRs -> specIds
   hades pr-loop-state --others --json # PRs de terceiros -> specIds
   ```

   Cruzar só com as minhas reimplementa o que outro dev já tem aberto. Cheque também `deliveries` no estado: entrada
   `in-progress` é trabalho de outra sessão (ou de um tick que morreu — aí o modo é `resume`, não `deliver`).
3. **Item ainda em revisão**: **somente** com `--allow-in-review` explícito. Sem a flag, o contrato ainda não fechou.

Ordem entre candidatas: respeite o plano de fases do item pai; não deixe uma fase a meio caminho. **Não agrupe**
unidades salvo se o projeto o permitir (`ref deliver`); mais de ~10-15 arquivos de código numa PR é grande demais.

## Passo 2 — ler antes de escrever

Antes de mexer, rode `hades thanatos cited --base <base>`: arquivo citado em post-mortem anterior vem com aviso, e vale ler o post-mortem (`hades thanatos show <id>`). Só avisa, não barra.

Integralmente, do específico ao geral: o item (o _que_), o pai, o contrato do serviço/módulo, a fonte das regras de
negócio e as regras do projeto (`rules.docs` do perfil). Item incompleto (`TBD`, critério não observável, contrato
vago) **não** se resolve inventando: aponte o gap e pergunte. Cheque `decisions` no estado antes de escalar uma
dúvida: pergunta já respondida não se repergunta.

## Passo 3 — card, branch e registro

**Card.** Se o perfil tem `card.provider`, a unidade nova nasce com card **antes** da branch, e o card da branch/titulo
e o do perfil (`card.idPattern`; exemplo em `card.example`). Se `card.required`, sem card o tick não cria branch nem
commit: **escale**. Sem `card.provider`, não há card: a chave da entrega é o slug da branch.

1. **Procurar antes de criar**, parando no primeiro acerto: `deliveries[<chave>].card` no estado (compartilhado por
   repositório, cobre o outro clone); `cardIds` do coletor nas PRs abertas; a busca do provedor (`ref deliver`). Card
   achado é **reutilizado**; mais de um casando é anomalia: reporte e **escale**. Busca que **falha** é aviso no
   relatório, não bloqueio; a escalação é sobre **criar** o card.
2. **Criar** com o script do perfil (`card.create`; `hades agent new --new-card`), com as respostas derivadas da
   spec, sem perguntar ao dono. A criação do card **da unidade em trabalho** já está autorizada pela invocação;
   card de terceiro, sprint e outras escritas externas pedem confirmação.
3. **Trabalho sem spec** (follow-up de review, dívida do `sweep`): também leva card (quando o perfil usa); muda só a
   origem das respostas, e a chave de dedup passa a ser o slug da branch.
4. **Branch e registro.** Formato e regex em `branch.format`/`branch.regex`; a base em `branch.base` (ou a branch da PR
   da qual a unidade depende — aí é **stack**, leia a cascata #1 em `cascade.md`). Branch criada da base nasce
   rastreando a base: `git branch --unset-upstream` na hora. Assim que a branch existe, grave
   `deliveries[<chave>] = { status: 'in-progress', branch, card, startedAt }` e troque o lock `deliver-<chave>`
   (`gates.md` §3.1). Registro só no fim deixa branch órfã quando a sessão morre — e, sem o `card` gravado, o tick
   seguinte cria um segundo card.

## Passo 4 — spec, se faltar

Item sem spec/contrato que o projeto exige: crie o mínimo antes do código, no formato e com o gerador de ID do projeto
(`ref spec`). Nunca escolha número olhando a base local: PRs abertas reservam números. Sem `TBD`/placeholder no texto.

## Passo 5 — implementar

Roteie pela stack e **leia a fonte de verdade**, não o resumo (`ref deliver`, `rules.docs`). Não negociável: as
regras de código e de comentário do projeto (`ref invariants`). O status do item avança aqui, junto do código que ele
descreve, não depois do push: mudança de status com a PR aberta custa um commit extra e um segundo run de CI.

## Passo 6 — testes

Obrigatórios, cobrindo **caminho feliz, caminhos de erro e edge cases**: unitário para cada ramo de lógica (entrada
inválida, dependência que falha, timeout e race, estado corrompido) e integração onde há SQL real, pipeline HTTP real
ou transação. Teste sem asserção de comportamento não conta. Nunca enfraquecer teste para passar.

## Passo 7 — gate

As faixas do projeto (`gates.md` §1 e `ref gates`), nesta ordem — a barata primeiro, a cara por último —, cada comando
sob `gate-lock.sh run` (§3.2). Falhou → conserta o **lado certo** (spec desatualizada vs bug real), nunca enfraquece o
teste, e reinicia a sequência daquele projeto. Voltou `75` → gate **enfileirado**: encerre a passada com o lock da PR
na mão e retome no próximo tick. Gate que não rodou (sem Docker, `--no-integration`) fica de fora **declaradamente**.

## Passo 8 — `/review-agents` (o único fan-out do fluxo)

Antes de abrir a PR, rode `/review-agents` sobre a branch, com target na base (ou na branch pai, se empilhada). É o
**único** ponto do loop onde a frota roda; iteração de inbox não re-dispara fan-out salvo pedido explícito. Depois do
relatório:

1. Classifique cada achado em `aplicar` / `refutar` / `escalar` (critérios de `inbox.md` (Fase 1), inclusive as exceções
   documentadas do projeto, `ref review`, antes de aceitar um achado).
2. Corrija em ondas (`gates.md` §6), commitando por etapa; valide cada onda no granular e rode a Faixa A completa uma vez,
   no fim, antes do push.
3. **Re-review dirigido**: os agentes que reportaram achado, mais os cujo escopo a correção passou a tocar. Fan-out
   inteiro só por pedido.
4. Repita até veredito limpo, `--max-iters` (padrão 3, contado em `reviewRounds`), ou ausência de progresso.

Guarde o relatório final em `<work>/review-agents-<branch>.md` — o passo 10 publica.

## Passo 9 — push e PR

Guarda de push de `gates.md` §2, e então `gh pr create --base <base> --head <branch> --title "<titulo>" --body-file
<arquivo>`. O titulo segue `commit.format`/`card` do perfil; o corpo carrega o que a PR entrega, a spec/ID de origem
(`commit.footer`), os testes e o gate que rodaram e as notas de rollout (`ref deliver` tem o modelo do projeto). PR
com mudança visual leva screenshot ou video.

## Passo 10 — provocar review

Depende da base (`flow.bot`, `flow.ci`):

- **Base coberta pelo bot** (`flow.bot.bases`) → comente `flow.bot.mention <foco>` na PR. Registre `lastClaudeTrigger`
  com o `headOid`: **um gatilho por push**, e só se o head mudou **materialmente** (OID diferente e diff fora de
  docs/markdown — `gates.md` §4).
- **Fora das bases do bot (PR empilhada)** → o bot não roda e a tentativa deixa ruido. **Não tente.** Publique o
  relatório do `/review-agents` como comentário na PR, marcado como review local automatizado.
- **Fora das bases do CI** (`flow.ci.bases`) → sem CI: o gate local é a única evidência, diga isso no corpo da PR. Se o
  CI não roda em draft (`flow.ci.draft`), não marque a PR como draft se quer CI.

## Passo 11 — fechar o ciclo

- `deliveries[<chave>]` de `in-progress` para `{ status: 'open', pr, branch, at }`.
- Card (quando o perfil usa): já existe desde o Passo 3; só muda de status, e `deliveries[<chave>].card` continua gravado.
- Libere o lock da PR — o ticket de gate o `gate-lock` já removeu sozinho.
- Relate no formato de `reference/loop/report.md`: PR aberta, gates que rodaram com o resultado real, achados aplicados/refutados/
  escalados, avisos do coletor e o que ficou pendente. Se algo do escopo ficou de fora, diga **o que** e **por que**.
- A PR passa a ser responsabilidade do modo `inbox`. Concluir o item é depois do merge, que é manual.
