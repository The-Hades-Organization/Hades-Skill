# Autonomia do orquestrador

Dois controles em Configurações → Orquestração, para o orquestrador parar menos. Os dois nascem desligados (nível 0,
interruptor 0): sem o dono ligar, nada muda. **Só o dono os altera** (painel local ou `!`), com a mesma trava do modo do
Cerberus (`reference/cerberus.md` §Modos): o hook barra a troca vinda das ferramentas do Claude e o painel remoto recusa.

## Níveis (`HADES_ORCH_AUTONOMY`, 0 a 3, controle deslizante no painel)

| Nível | Rótulo | O orquestrador decide sozinho, pela opção recomendada |
|---|---|---|
| 0 | Pergunta tudo (padrão) | nada: pergunta como sempre |
| 1 | Operacional | `resume`, `phase`, retry, reestimar, `STALLED` e `BUDGET` até o p75 |
| 2 | Execução | o do 1, mais responder as `QUESTION`s dos agentes e corrigir defeito dentro do plano |
| 3 | Totalmente autônomo | o do 2, mais replanejar, reaprovar o plano e fazer release |

A tabela de cada ponto de decisão com o nível mínimo está em `reference/loop/orchestrate.md` §4.1 e no cartão
`reference/loop/roles/orchestrator.md`.

## Nunca cedem, em nenhum nível

Os invariantes da skill · merge de PR de projeto · push público do snapshot da skill · passar de 150% do estimado (a
`QUESTION` do Moirai) · mudar o próprio nível ou o interruptor de auto-alocação. O `decide` as reconhece por `--class
invariante|merge|push-publico|estouro|autonivel` e, sem a flag, por palavras da pergunta e da opção (falso positivo
devolve a pergunta ao dono, o lado seguro). O orquestrador também não consegue mudar as chaves: o hook barra
`hades config set|unset HADES_ORCH_AUTONOMY|HADES_ORCH_AUTO_START`, `HADES_ORCH_…=` em qualquer comando, `/api/config`
com elas e `hades agent auto-start on|off`. O nível é lido só do `config.env`: variável exportada na sessão do agente
não vale.

## `hades agent decide`

```
hades agent decide <plano> --level-needed 1|2|3 --question "<texto>" --chosen "<opção>" [--alternatives "a; b"] [--class <c>]
```

Regra do orquestrador: **chamar antes de cada `AskUserQuestion`**.

- **Sai 0** (`DECIDIDO …`): o nível atual cobre e a decisão não é de classe que nunca cede. Grava uma linha em
  `<plano>.log.md`, um evento no diário (`source: orch`, `kind: decision`, com `decision: {level, needed, question,
  chosen, alternatives}`; `hades journal list`, em `_sessions/_orch`) e notifica (`HADES_NOTIFY`, evento Agente).
- **Sai 3** (`PERGUNTAR AO DONO: …`): nível menor que o pedido ou classe que nunca cede; não grava nada. Pergunte.
- Sai 2 com argumento inválido (nível fora de 1–3, faltou `--question`/`--chosen`, plano inexistente).
- Termina sozinho: se outro processo está com o lock do notify (`notify/.lock`), a notificação espera até
  `HADES_NOTIFY_LOCK_WAIT_S` (15 s) e é descartada (`lock do notify ocupado`); a decisão já está no log e no diário.

## `hades agent auto-start on|off|status` (`HADES_ORCH_AUTO_START`)

`on` liga o interruptor e grava no `~/.claude/settings.json` do usuário **uma** regra allow, `Bash(herdr agent start:*)`;
`off` desliga e remove exatamente essa regra. As duas operações são idempotentes, preservam o resto do arquivo (outras
regras, chaves, indentação) e recusam sem alterar nada um `settings.json` que não seja JSON válido. Nunca grava
`herdr *` nem `Bash(*)`. O painel (Configurações → Orquestração, Auto-alocação) faz o mesmo ao salvar a chave; `HADES_CLAUDE_SETTINGS`
troca o caminho do arquivo (testes). `status` mostra interruptor, regra e se a auto-alocação está **ativa** (as duas coisas).

Ativa, `hades agent new` e `skill-new` imprimem o `herdr agent start …` (modelo e esforço do papel) **sem o `! `**: quem
o roda é o orquestrador, como Bash, sob a regra allow e o classificador; o hades nunca o executa por subprocesso. Sem
painel, sem interruptor ou sem regra, imprimem o comando do dono (`! herdr agent start …`) como sempre; `--dry-run` imprime
sempre o do dono.

**Sem medição prévia:** que a regra allow vença o classificador do auto mode quando quem roda o `herdr agent start` é a
própria sessão do orquestrador só se prova dentro dela, então a primeira auto-alocação real é a prova. Se for barrada, o
interruptor fica desligado e o caso escala ao dono; nada de fila no painel nem outro processo.

## Rastro

Toda decisão autônoma vira: linha no `<plano>.log.md`, evento `decision` no diário, notificação (se ligada) e uma linha
na lista **Decisões autônomas** da página Orquestração do painel (as 20 mais recentes, com nível, pergunta, opção
tomada e alternativas). É reversível pelo log: cada linha diz o que foi escolhido e o que ficou de fora.
