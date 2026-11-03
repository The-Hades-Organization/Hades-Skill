# Gates, estado e concorrência

Base compartilhada pelos modos `deliver`, `inbox`, `cascade`/`sweep` e pelos modos operacionais. O
modo `review` não usa nada daqui além do lock por PR (§3.1) — ele não roda gate, não pega slot de
gate e não escreve no working tree.

## 1. Contrato de gate (sequencial, sempre)

O gate do projeto (comandos, faixas, versão de runtime, validadores, armadilhas de suite) está no pacote:
`hades project ref gates`, e as `stacks` do perfil dizem quais comandos o hook e a fila reconhecem. **Se o perfil tem,
leia: vence este contrato onde divergir.** O que vale para qualquer projeto:

- **Faixas, da barata para a cara.** O gate separa "o diff tocou este projeto" de "o grafo de build diz que este projeto
  pode ter sido afetado". Uma faixa não substitui a outra: reduzir a A ao B esconde quebra cross-cutting, e estender a A ao
  B é gate que ninguém termina — e gate que ninguém termina vira gate declarado verde sem ter rodado.
  - **Faixa 0 — varredura barata:** mecânica, em segundos, sem slot da fila.
  - **Faixa A — projetos tocados:** lint, build, suite completa e integração.
  - **Faixa B — ripple** (afetado e não tocado): build afetado e os specs relacionados, nunca a suite completa.
- **Todo comando de gate roda dentro da fila** (§3.2): `gate-lock.sh run` espera a vez, executa sob teto de memória e
  propaga o código de saída. A sequência de um gate vai de preferência numa concessão `gate` só.
- **Um projeto por vez, um comando por vez, nunca em paralelo dentro da sessão.** Ordem: lint (barato), build (tipo),
  unit (lógica), integração (comportamento). Falhou → conserta o lado certo e reinicia a sequência daquele projeto do
  lint; durante as ondas de correção a validação e a granular de §6, e a suite completa fecha o ciclo uma vez, antes do
  push. Sequencial dentro da sessão é invariante próprio: a fila existe para as **outras** sessões da máquina.
- **Use a forma de comando que o projeto usa** (scripts do gerenciador de pacotes, não a ferramenta de build crua): os
  scripts carregam flags de ambiente que a configuração real exige (`ref gates` lista as armadilhas).
- **A versão de runtime do projeto é a asserção que vale** (`node -v` igual ao arquivo de versão do repo), não "rodei o
  gerenciador de versão": o gerenciador é função de shell e não existe em toda sessão. Major divergente gera flakiness.
- **Integração roda uma vez por ciclo**, imediatamente antes do push, não a cada onda. Sem o runtime que ela exige
  (container), registre no relatório que o gate de integração ficou de fora em vez de fingir que passou.
- **Mudança fora de qualquer projeto de build** (doc, CI, scripts) não tem suite: rode o que existe para aquele tipo de
  arquivo e registre que não há projeto tocado, em vez de inventar um verde.
- **Regressão da própria skill**: `gate-lock.sh run test --label <agente> -- bun test loop/test/ts` (suite nova em
  `bun test`). O `skill-release check` roda a mesma regressão pela fila sozinho (label `skill-release`, fila da máquina
  `work/_maquina`, `HADES_GATE_SCOPE=maquina`) e a pula quando o HEAD limpo já tem uma verde registrada
  (`reference/evolving.md` §Passos, item 5); `gate-lock.sh status` global a mostra rodando. O agente de unidade da skill
  não chama `gate-lock.sh` (`skill-dev-contract.md`): roda o `check`.
- **Worktree sem dependências não roda gate**: instale as deps ou rode no clone principal, e diga no relatório de onde o
  gate saiu. **Nunca** declare gate verde a partir de worktree sem deps.
- **Gate no push** só existe se o repo o tem (§2). Sem ele, nenhuma cobertura unitária automática separa o seu commit do
  merge, e pular a Faixa B é entregar sem unit nela.
- **Gate que não rodou nunca é verde** (§3.2, saída `75`).

### 1.0 Modo orquestrado (`--orchestrated`): gate único, só o que o diff afeta

Vale quando a passada roda com `--orchestrated` (agente alocado pela sessão do loop, ver `orchestrate.md`). Fora dele, as
faixas do projeto valem como estão.

- **O agente não roda gate.** Só a checagem de tipos do projeto, pela fila, para não entregar código que não compila. Os
  testes são escritos e não executados; o relatório declara o gate como "não rodado: modo orquestrado, gate na #N".
- **O gate roda uma vez, num ponto só:** na PR de consolidação (`consolidate.md`), no topo de uma stack que o dono vai
  mergear em sequência, ou na própria PR quando ela entra sozinha. Quem roda é o agente desse ponto, depois de todas
  as correções.
- **Escopo: só o que o diff afeta diretamente**, um comando por vez, sempre pelo `gate-lock.sh run`, com o runtime do
  projeto, **em segundo plano** (Bash com `run_in_background`, sumário em arquivo fora do `/tmp`): a sessão é acordada
  quando o gate termina e lê só o sumário. Nunca acompanhe o log nem a fila por polling (o `hades guard` barra). O guard olha só o comando executado: o texto
  entre aspas de `hades agent answer|prompt|escalate|phase|resume` não conta como gate nem como espera, e reler um sumário depois
  de rodar um gate (`gate-lock.sh run`) não é releitura repetida. Fila
  parada além do limite das Configurações: estacione (`roles/impl.md` §Estacionar) e deixe o `hades wait queue` avisar:
  - lint nos arquivos do diff;
  - unit só dos testes que cobrem os arquivos do diff;
  - integração só dos specs que cobrem esses arquivos, com poucos workers;
  - nunca a suite completa de projeto, build, ripple ou `affected` (as Faixas A e B não se aplicam).
  A máquina é compartilhada: integração com workers a 50% já derrubou o gate por memória.
- **Falha pré-existente** só é aceita provada contra a base, no mesmo spec; as que o pacote declara aceitas
  (`ref gates`) também.
- **Correção de falha** vai na PR dona do código e se propaga por merge; só o que nasce da combinação de PRs ou do
  conflito com a base se corrige no ponto de consolidação. Depois, rode de novo só o que falhou.
- Gate preso esperando memória não se derruba: reporte ao dono, que decide liberar. Worktree nova pode pedir passos de
  preparação (`ref gates`); `/tmp` cheio trava o lint.

## 2. Guarda de push (obrigatória, sem exceção)

Antes de **todo** push:

```bash
git rev-parse --abbrev-ref @{upstream}     # deve ser origin/<headRefName da PR>
git status --porcelain                     # nada inesperado
```

Se o upstream não casar com o `headRefName` que o coletor reporta para aquela PR, **recuse o push** e
reporte. Há branches locais rastreando outra branch remota; push cego escreve na PR
de outra pessoa e não há desfazer limpo.

Depois da guarda, `hades cerberus avaliar push --ctx pr=<n> --ctx branch=<b>`: exit 1 (barra) recusa o push
(`reference/cerberus.md` §Avaliação conjunta).

Branch sem upstream: `git push -u origin <branch>` **só** depois de confirmar que o nome bate com a
PR (ou que a PR ainda não existe). Branch criada com `git checkout -b <nova> origin/<base>` nasce
rastreando a base — **desfaça com `git branch --unset-upstream` antes do primeiro push**,
senão o push mira a base.

**Hooks do repo e gate no push** são do projeto (`ref gates`): o que o hook de commit/push roda, o que a pipeline de CI
cobre e o que não cobre. Pular hook (`--no-verify`, variável que o desliga) segue proibido (`SKILL.md` §Invariantes). Se o
repo não tem gate de teste no push, o gate do loop é a única cobertura unitária antes do merge.

## 3. Locks (estado global, execução local)

Dois eixos independentes de concorrência, e uma sessão costuma precisar dos dois: **quem trabalha
aquela PR** (§3.1) e **quem está usando o recurso de gate da máquina** (§3.2). Ambos usam `mkdir`,
que é atômico, sob `<work>/locks/`.

### 3.1 Lock por PR

O estado é compartilhado entre clones, então duas sessões podem enxergar a mesma PR acionável:

```bash
WORK="$HOME/.claude/hades/work/$(gh repo view --json owner,name --jq '.owner.login + "__" + .name')"
mkdir -p "$WORK/locks"
if mkdir "$WORK/locks/pr-<n>.lock" 2>/dev/null; then
  printf 'clone=%s\nhost=%s\npid=%s\nsince=%s\nmode=%s\n' \
    "$(git rev-parse --show-toplevel)" "$(hostname)" "$$" "$(date -u +%FT%TZ)" "<modo>" \
    > "$WORK/locks/pr-<n>.lock/owner"
else
  cat "$WORK/locks/pr-<n>.lock/owner"   # outra sessao tem a PR: siga para a proxima
fi
```

O `WORK` **se deriva** do `gh repo view`; nunca escreva o slug a mão — a ferramenta serve qualquer
clone e qualquer thread de conversa.

- Adquira o lock **antes** de mexer em qualquer arquivo da PR; libere (`rm -rf`) ao terminar ou ao
  abortar, inclusive quando o gate falha.
- Lock de outra sessão **não** se rouba: pule a PR e registre no relatório.
- Suspeita de lock preso: **§3.3**, e nunca `kill -0` como veredito.
- **Modo `review`** trabalha em lote: adquira o lock de cada PR do lote, siga com as que conseguiu, e
  diga no relatório quais ficaram de fora por lock de outra sessão. Nunca adie o lote inteiro por uma
  PR travada.
- **`deliver`** ainda não tem número de PR: use `deliver-<chave>.lock` (a chave é o spec-id ou, sem spec, o slug da branch) com o mesmo protocolo, e
  troque pelo `pr-<n>.lock` quando a PR abrir.

### 3.2 Fila de admissão de gate (memória primeiro)

Gate é recurso de **máquina**, não de PR. O que duas sessões disputam de fato:

| Recurso                                  | Natureza                  | Consequência do excesso                         |
| ---------------------------------------- | ------------------------- | ----------------------------------------------- |
| RAM (15 GB, swap em zram)                | **restrição dura**        | swap/zram thrash → máquina trava → reboot       |
| CPU (12 cores)                           | contendida, escalona      | gate mais lento, timeout de teste     |
| testcontainers (Postgres/Redis por run)  | isolado (porta aleatória) | nenhum conflito; só custa RAM fora do gate      |
| infra local (`container_name` fixo)      | **exclusivo**             | não é gate — nunca suba a infra num gate        |
| cache de build e código gerado           | por worktree              | sem disputa entre sessões                       |

A admissão conta **memória**, não processos por classe (a contagem por classe deixou passar 1 teste + 2 builds + 2 lints
ao mesmo tempo, muito além dos ~8 GB livres depois do desktop e dos agentes). A fila é **uma FIFO global** para todo
`kind`, com admissão por memória:

| `kind`             | Custo default | Pesado | Uso                                                 |
| ------------------ | ------------- | ------ | --------------------------------------------------- |
| `lint`             | 2 GB          | não    | lint do projeto                                     |
| `build`            | 3 GB          | não    | build do projeto (o grande do front: `--cost-gb 5`) |
| `test`             | 4 GB          | sim    | suite unitária, specs relacionados ao diff          |
| `test:integration` | 5 GB          | sim    | inclui os containers, que ficam fora do teto        |
| `gate`             | 5 GB          | sim    | concessão para a sequência inteira (abaixo)         |

- Só a **cabeça** da fila entra, e só se: soma dos custos rodando + o seu <= **8 GB**
  (`HADES_GATE_BUDGET_GB`), `MemAvailable` >= custo + **2 GB** de reserva, pressão de memória
  (`/proc/pressure/memory`) baixa, e — se o gate for pesado — nenhum outro pesado rodando. **Nunca
  dois testes na máquina** continua valendo: agora como regra de "um pesado por vez".
- **Etapa da stack (`--step <stack>:<etapa>`).** Kind, custo e paralelismo vêm do pacote de stack do projeto
  (`reference/stacks.md`); `--cost-gb` explícito vence. O hook barra o comando cru das etapas das stacks do
  perfil (sem perfil, de todas as instaladas). Sem `origin` a fila é a da máquina (`work/_maquina`).
  Prioridade, janela de horário, paralelismo por tipo e orçamento por projeto: Configurações → Fila.
- O comando roda num **scope systemd com `MemoryMax`** = custo + 3 GB: gate que estoura morre sozinho, em vez de levar
  a máquina. O estouro de teto sai com um destes códigos:

  | Saída | Significado |
  | ----- | ----------- |
  | `137` (SIGKILL) | o kernel matou o próprio comando que o wrapper esperava |
  | `143` (SIGTERM) | o kernel matou **outro** processo do scope (o oom-kill escolhe uma vítima qualquer) e o systemd derrubou o scope inteiro; os irmãos, inclusive o comando esperado, saem `143`. Ninguém mandou SIGTERM: é o mesmo estouro, visto de outro ângulo |
  | `75` | gate enfileirado: estourou o `--timeout` da fila (abaixo) |

  Com a nota `provavel estouro de memoria`, **`137` e `143` não são gate reprovado**: são _"não rodou: teto de
  memória"_, e o próximo passo é reduzir workers/heap, **não** subir o teto. O wrapper imprime a linha correspondente do
  journal para confirmar; na mão, o veredito está em `journalctl --user -b | grep -E "oom-kill|Failed with result"` —
  `constraint=CONSTRAINT_MEMCG` quer dizer estouro do **cgroup do gate**, e não falta de RAM no host (a notificação do
  desktop diz "sistema com pouca memória" nos dois casos, e por isso engana).

  **macOS (sem cgroup nem `MemoryMax`).** O teto é um **vigia de RSS da árvore** dentro do `gate-lock`
  (`src/lib/mem-watch.ts`, ADR 0003): a cada ~1 s soma o `ps -axo pid,ppid,rss` do comando e dos descendentes; passou de
  custo + `HADES_GATE_HEADROOM_GB`, ou a memória livre da máquina (`kern.memorystatus_level`, senão `vm_stat`) caiu
  abaixo de 512 MB, ele manda TERM no grupo e em cada pid da árvore, KILL 3 s depois, e o gate sai **`137`** com a
  mensagem `vigia de memoria` (sem `journalctl`). Só mata a árvore do próprio gate. O pico medido vai ao journal
  (`peak=NNNMB`) e `gate-lock.sh peak <label>` e o `stack-add measure` o leem como no Linux. `HADES_GATE_MEMCAP=0`
  desliga o vigia. `HADES_MEM_WATCH=1` liga o mesmo caminho no Linux (só os testes); `HADES_MEM_WATCH_FLOOR_MB` troca o
  piso de memória livre (só os testes). O vigia custa uma consulta de `ps` por segundo enquanto há gate rodando.
- O wrapper exporta os limites de paralelismo da stack (workers de teste, paralelismo de build) quando não definidos.
  **Não** passe número de workers a integração: vários configs pinam um worker porque os workers disputam o mesmo banco.

```bash
GL="$HOME/.claude/skills/hades/kit/gate/gate-lock.sh"
"$GL" status                                                          # fila, orcamento, MemAvailable
"$GL" run test --label <projeto> -- <comando de teste>                # entra na fila, roda, sai
"$GL" run gate --label pr-<n> --cost-gb 5 -- bash "$WORK/gate-<n>/run.sh"   # concessao (abaixo)
```

**Concessão `gate`: a sequência inteira numa entrada só.** Dentro de `run gate`, cada
`"$GL" run <kind> ...` do script roda direto, sem voltar para a fila (o wrapper reconhece o ticket
pelo `GATE_LOCK_TICKET` herdado). Prefira a concessão sempre que o gate for mais de um comando: com
um ticket por passo, cada lint/build/test da sua sequência entra atrás dos testes das outras
sessões, e todas as PRs terminam tarde (round-robin); com a concessão, a fila anda por gate inteiro
e a latencia média cai sem perder vazão. `--cost-gb` da concessão é o do passo mais caro da
sequência.

`acquire`/`release` saíram: o pid de shell efêmero não prova liveness. Vários comandos encadeados
vão em `run <kind> -- bash -c '...'` ou numa concessão `gate`.

Espera e cessão do tick:

- Não admitido → o wrapper reavalia a cada **5 s** (sem backoff: o slot livre não fica ocioso) até o
  `--timeout` (default **3600 s**) e diz o motivo (`fila: N a frente`, `orcamento`, `MemAvailable`).
- Estourou → saída **75**. Isso é **gate enfileirado, não gate reprovado**. Encerre a passada,
  **mantenha o lock da PR** (o trabalho continua seu) e retome no próximo tick **do lint**, porque a
  sequência reinicia.
- No relatório, `75` se declara como _"não rodou: `<motivo>` (fila/memoria)"_. Nunca como
  "passou", nunca como "falhou".
- **Não contorne a fila** rodando o gate direto porque "é rápido" ou "é só um projeto" — nem checagem que chama o
  gerenciador de build por baixo. O dano não é de quem furou: é da máquina inteira.
- **Não improvise admissão própria** (`waitmem` com `free -g`, `sleep` até "ter memória"): a fila já
  faz isso, com a conta de todos. Script de gate só sequência os passos.
- Uma entrada por vez por sessão. Nunca segure um ticket enquanto espera outro — é a concessão
  `gate` que resolve "preciso de vários".
- Cada entrada/saída vai para `<work>/locks/gate-journal.tsv` (`enqueue`, `admit` com a espera,
  `done` com rc e duração, `timeout`, `orphan`). É a evidência de fila.

### 3.3 Lock órfão — qual sinal vale

O `pid` gravado no lock **só** tem valor quando o processo que o gravou vive enquanto o lock existe:

- **Lock de PR** (§3.1): o `pid` é de shell efêmero, que morre logo após o `mkdir`. Pid morto
  **não** é sinal de órfão — checar `/proc/<pid>` diria "morto" sempre e levaria a furar lock de
  sessão viva. O sinal real é cruzar `clone=` e `since=` com `herdr agent list` (workspace, `cwd`,
  título, `agent_status`) e com `ListAgents` (ferramenta do Claude Code que lista os agentes em execução). `since` acima de ~2 h é suspeita, não veredito: informe
  o dono com o `owner` inteiro e **pergunte** antes de remover.
- **Ticket da fila de gate** (`locks/gate-queue/*.t`): grava o `pid` e o `starttime` do próprio
  wrapper, que vive enquanto espera e enquanto roda, e o `child` (o comando). Wrapper **e** filho
  mortos (ou pid reciclado, `starttime` diferente) **e** prova de órfão, e o `gate-lock.sh` remove o
  ticket sozinho na próxima avaliação, anunciando no stderr e no journal. Wrapper morto por `SIGKILL`
  com o gate ainda vivo **não** é órfão: o ticket fica, porque a memória continua em uso. Não há
  decisão humana nesse caso e não se remove ticket a mão.
- **Slot antigo** (`gate-<recurso>.slot-<n>`, só na transição): conta como ocupado e recicla com `runner=wrapper`, mesmo
  host, pid morto.

O inventário de uma vez, com essa classificação aplicada, e o modo `locks` (`ops.md`).

## 4. Estado: esquema shardado, versionado e idempotente

`~/.claude/hades/work/<owner>__<repo>/state/`. Sem estado, o loop reprocessa o que já fez: posta
resposta duplicada, re-dispara o bot, re-resolve thread, republica review. **Toda escrita externa
consulta o estado antes.**

O estado é **um arquivo global + um shard por PR**, não um monolito:

```
state/global.json        # o que nao pertence a uma PR so
state/pr-<n>.json        # tudo de uma PR
```

Por que shardado: o diretório é compartilhado entre clones e o lock é **por PR**. Duas sessões
trabalhando PRs diferentes escreveriam o mesmo arquivo grande e a segunda apagaria o registro da
primeira — atômico (`tmp` + `mv`) evita corrupção, não perda. Com shard, cada sessão escreve só o
arquivo da PR que ela travou.

```json
// state/global.json
{
  "version": 2,
  "repo": "<owner>/<repo>",
  "escalations": [
    {
      "id": "esc-1602-1",
      "pr": 1602,
      "thread": "PRRT_...",
      "why": "...",
      "options": ["..."],
      "askedAt": "2026-08-19T18:00:00Z",
      "answeredAt": null,
      "answer": null
    }
  ],
  "deliveries": {
    "<chave>": {
      "status": "in-progress|open|merged",
      "pr": 1801,
      "branch": "<branch>",
      "card": "<card>",
      "startedAt": "...",
      "at": "..."
    }
  },
  "cascades": {
    "handler-sem-idempotencia": { "pattern": "...", "found": [1801, 1805], "queued": [1805], "reportedAt": "..." }
  },
  "decisions": { "esc-1602-1": { "answer": "...", "at": "...", "appliesTo": ["<chave>"] } },
  "merged": { "1796": { "at": "...", "spec": "<id>" } },
  "handoff": { "note": "...", "at": "..." }
}
```

```json
// state/pr-1689.json
{
  "pr": 1689,
  "threads": {
    "PRRT_kwDO...": {
      "verdict": "applied|rebutted|indeterminate|stale-fixed",
      "commit": "9384edeb",
      "at": "2026-08-19T18:00:00Z"
    }
  },
  "comments": { "5345394926": { "verdict": "applied", "at": "..." } },
  "lastClaudeTrigger": { "commentId": 5345394926, "headOid": "3a1c3df3", "at": "..." },
  "lastSeenReviewAt": "2026-08-19T17:40:00Z",
  "review": {
    "headOid": "abba7854",
    "reviewId": 4987069998,
    "event": "COMMENT",
    "verdict": "blocked",
    "blocking": 5,
    "important": 15,
    "inline": 22,
    "outOfHunk": 0,
    "at": "..."
  },
  "reviewRounds": 2
}
```

Semântica dos campos que mais erram:

- `card` é o card da unidade (`card.idPattern` do perfil), gravado junto com a `branch` (`deliver.md` Passo 3). É o que impede
  o tick seguinte — ou a outra sessão, no outro clone, já que o estado é por repositório — de criar um
  **segundo** card para a mesma unidade: escrita externa consulta o estado antes. Unidade sem spec
  (`deliver.md` Passo 3) usa o slug da branch como chave de `deliveries`, no lugar do ID da spec.

- `threads` é a memória de "já tratei", e o **veredito decide o destino**: `applied` e `stale-fixed`
  encerram; `rebutted` e `indeterminate` continuam contando como pendentes (bloqueiam `done-pending`,
  porque quem fecha é o humano) sem voltar para a fila de ação. Resposta do reviewer posterior ao
  `at` reabre a thread — e como "aplicado que o reviewer contestou" volta a ser achado vivo.
- `comments` é o mesmo para comentário top-level, chaveado pelo `databaseId`. Sem ele, todo pedido
  top-level é eterno, porque comentário solto não tem `isOutdated` nem `isResolved`.
- `lastClaudeTrigger` guarda `headOid` junto do `commentId`: só re-dispare o bot (`flow.bot.mention`) se o head mudou
  **materialmente** — OID diferente **e** o diff `<ultimo trigger>..HEAD` tocando algo fora de docs/markdown e da
  pasta de agentes. Um gatilho por push, no máximo.
- `lastSeenReviewAt` é o que impede o loop de girar em PR aprovada sem comentário. Grave sempre que
  ler os reviews de uma PR, mesmo quando não havia nada a fazer.
- `review` é o registro de publicação do modo `review`, **chaveado por PR e com o `headOid`**: é o
  que responde "já revisei esta PR neste head?". Push novo depois da publicação autoriza re-review.
- `reviewRounds` sobrevive ao tick: o teto de ondas (`--max-iters`, padrão 3; é o contador `reviewRounds`) é por PR e por ciclo,
  não por invocação — senão o loop reinicia a contagem e insiste para sempre.
- `escalations` é o que o loop **relembra** ao dono a cada relatório, até `answeredAt` existir. A
  resposta entra por `answer` (`ops.md`) e vira `decisions`, que é consultado antes de reperguntar.
- `cascades` é a fila da cascata #3: padrão sistêmico achado numa PR, PRs irmãs afetadas, e quais
  itens já foram enfileirados. Sem isso o achado sistêmico morre no fim do tick.

Protocolo de escrita:

1. Tenha o lock da PR (ou do `deliver-<chave>`), sempre.
2. Leia o shard, aplique a mudança, grave em `pr-<n>.json.tmp` e `mv` — atômico, para não corromper
   se a sessão morrer no meio.
3. `global.json` **também** exige lock próprio (`locks/global.lock`, mesmo `mkdir`), porque toda
   sessão escreve nele. Segure o lock pelo menor tempo possível: leia, altere, `mv`, libere.
4. `version` diferente da suportada pelo coletor → **não escreva**; reporte e pare.

**Migração do `state.json` monolítico (v1)**: o coletor lê o monolito e os shards juntos, com o shard
vencendo. A migração é incremental — a primeira escrita de uma PR cria o shard dela; o monolito fica
como leitura até esvaziar. Não reescreva o monolito.

## 5. Commits

- Formato, regex e footer vem de `commit` no perfil (`commit.format`, `commit.regex`, `commit.footer`). Header até 100
  chars, subject sem ponto final, imperativo, na língua do histórico do repo.
- **Um commit por etapa do checklist**, nunca um commit-monolito no fim.
- **Nunca commite com trailer de co-author.** `commit.coAuthor` no perfil só registra o que o repo pratica.
- Nunca um commit cujo diff seja **só** comentário, nem com mais linha de comentário que de código. A mudança de
  comentário viaja no commit da etapa que a motivou. Exceção: etapa cujo escopo é exatamente limpar ruido ou reconciliar
  comentário desatualizado (regras de comentário do projeto: `ref invariants`).

## 6. Correção em ondas

Herdado de `code-review-local` §"Loop de correção", que é o padrão já praticado no repo:

1. Checklist priorizado em `<work>/checklist-pr-<n>.md`, com ondas, arquivos-alvo, validação e
   cadeias de dependência. Onda N só começa depois da N-1.
2. Agentes em paralelo **apenas** para etapas de **arquivos disjuntos**. Etapas que compartilham
   arquivo vão em sequência.
3. Cada agente corrige só os arquivos da sua etapa, valida com
   `gate-lock.sh run build --label <proj> -- <build do projeto>` até passar, e **não commita**.
   Agente não introduz comentário novo. Se o wrapper voltar `75`, o agente reporta "build enfileirado"
   à sessão do loop em vez de seguir sem validar. Os builds dos agentes entram na mesma fila global
   (§3.2): com o orçamento de 8 GB cabem ~2 builds por vez na máquina, então mais de 2 agentes de
   onda não validam mais rápido — só esperam.
4. **Agente de onda não roda `test`.** Teste é gate pesado, um por vez na máquina (§3.2): N agentes
   em paralelo serializariam na mesma fila, cada um gastando o timeout, e o resultado seria N× o wall
   clock da sessão do loop rodando uma vez. Teste fica com a sessão do loop, que valida a onda inteira e commita
   por etapa.
5. **A onda valida no granular; a suite completa fecha o ciclo.** Fechada a onda, a sessão do loop roda pela fila os
   testes relacionados ao diff (`ref gates` diz o comando), em qualquer projeto, em minutos. A **Faixa A
   completa** (§1) roda **uma vez**, no fim, antes do push, junto da integração.

   Por que não a suite completa por onda: suite grande leva de minutos a horas, e reexecuta-la a cada onda de correção
   é o maior desperdício do loop — é o que faz a passada estourar o tick e terminar sem gate. Granular na onda pega a
   regressão que a onda mesma causou; a completa, no fim, pega o resto.

   Onda que quebra o granular volta para o passo 3 daquela etapa. Onda verde no granular e vermelha na completa é sinal
   de acoplamento fora dos arquivos da onda: **não** é caso de reduzir a completa, é caso de olhar o que ficou acoplado.
6. Parada: veredito limpo, `--max-iters` (padrão 3, contado em `reviewRounds` e persistido; é do loop, outro contador que `HADES_ESCALATE_GATE_WAVES`, o do agente orquestrado: `roles/impl.md` §Escalar), ou
   **ausência de progresso** — mesmos achados em duas iterações seguidas. Sem progresso, pare e
   reporte; não insista.

## 7. Ritmo sob `/loop`

- Cada tick é **uma passada**: coletor → escolhe o alvo → age → reporta.
- **Uma PR por tick** nos modos que escrevem, serial, para não disputar o working tree. No modo
  default, `deliver` só entra se o `inbox` não achou nada acionável — nunca os dois escrevendo no
  mesmo tick.
- `noop: true` quando nada mudou; `noop: false` quando houve commit, push, comentário ou escalação.
- Ritmo: 1200–1800 s por default. ~480 s em dois casos, e só neles: enquanto observa um run de CI
  específico que acabou de ser disparado (e aí o modo certo é `watch`), e depois de um tick encerrado
  por **gate enfileirado** (saída 75) — a fila anda sozinha e nada notifica quando isso
  acontece. Não encurte para "poll" de coisa que notifica sozinha.
- Tick encerrado por gate enfileirado mantem o lock da PR e reporta o motivo (`fila`, `orcamento`,
  `MemAvailable`) e os `clone` que estavam na frente. `noop: false` se houve commit antes da fila; `noop: true` se a passada não mudou nada.
- Encerrar o loop quando não há PR em estado acionável **ou** quando tudo que resta são escalações
  esperando o dono — nesse caso relate as escalações e pare.
