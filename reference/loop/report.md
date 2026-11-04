# Relatório — formato único de todos os modos

Um formato só, para o dono não ter de aprender a ler cada modo. Em **pt-BR**, honesto sobre o que
rodou, sem preâmbulo e sem elogio. Cada modo preenche o bloco que lhe cabe e omite o resto.

## Esqueleto

```markdown
## <modo> — <alvo> <!-- PR #<n> — <título> | spec <ID> | lote de N PRs -->

Estado: <antes> → <depois> · commits: <n> · push: <sha ou "não">
**Card**: <card> (<criado neste tick | reutilizado>) — <título do card> <!-- deliver -->

**Aplicados** (<n>): <código> <arquivo:linha> — <o que mudou>
**Refutados** (<n>): <código> <arquivo:linha> — <por que não procede>
**Triados** (<n>): <n> resolvidos como já corrigidos, <n> aguardando confirmação
**Esperando reviewer** (<n>): <thread> — <o que foi respondido e quando>
**Faixa A** (<projetos tocados>): lint <res> · build <res> · test <res> (<n> suites) · integração <res>
**Faixa B** (ripple, <n> projetos): affected:build <res> · specs relacionados <res> (<n> specs)
<!-- res: passou | falhou | não rodou: <motivo>. A Faixa 0 aparece só quando acha algo. -->
**Avisos do coletor**: <kind> — <detalhe> <!-- omitir se vazio -->

## Conflitos de qualidade

<!-- saída de `hades quality conflicts`; omitir se vazia -->
- `<id>` (<contradiz | severidade-menor | id-desconhecido>, projeto <nome>): <detalhe>

## Itens para discussão

1. <problema claro> — alternativas: (a) ... (b) ... — recomendação: ...

## Escalações abertas de passagens anteriores

- <id> (PR #<n>, desde <data>): <pergunta em uma linha>

## Ficou de fora

- <o que> — <por que>
```

## Regras que valem literalmente

- **Gate que não rodou se declara como não rodado, com o motivo.** Nunca ✅ por omissão. Teste que
  falhou aparece com a saída real, não parafraseada. Gate que voltou `75` do `gate-lock.sh` é
  **enfileirado**: "não rodou: `<motivo>` (fila/orçamento/MemAvailable)", nunca "passou" nem "falhou".
  Gate morto com `137` **ou `143`** e a nota `provavel estouro de memoria` é "não rodou: teto de
  memória" — nunca "falhou". (`143` é o systemd derrubando o scope depois que o oom-kill mata um
  processo irmão: é o mesmo estouro de teto, não alguém matando o gate. Ver `gates.md` §3.2.)
- **A faixa aparece junto do projeto**: "suite completa" é Faixa A, "specs relacionados" é Faixa B
  (`gates.md` §1). Faixa B relatada como suíte completa é gate inflado no relatório.
- **Um achado = uma linha**, com `arquivo:linha` e o código da regra quando existir. Mesmo defeito em
  N locais = uma linha com a contagem.
- **Escalação aberta volta em todo relatório** até ter `answeredAt`. É o único bloco que reaparece
  sem novidade — é o único que não pode ser omitido "porque não mudou".
- **Aviso do coletor entra no relatório** sempre que puder ter escondido trabalho (truncamento,
  `merge-state-missing`, PR pedida e ausente). Vazio depois de um aviso não é "nada a fazer".
- **Escopo que ficou de fora se declara**: o que e por que. Reduzir escopo é decisão do dono, não
  do loop.
- **`--dry-run`** troca todo verbo de escrita pelo condicional e abre com `DRY-RUN` na primeira linha:
  o relatório diz o que **seria** feito, e nada foi.
- Sem hedging ("considere", "talvez"). Dúvida genuína vira item em `## Itens para discussão`.

## Blocos por modo

| Modo | Blocos obrigatórios |
|---|---|
| `deliver` | alvo (spec + PR), card, commits, gates, achados do `/review-agents`, ficou de fora |
| `inbox` | estado antes/depois, aplicados, refutados, triados, esperando reviewer, gates |
| `review` | por PR: autor, veredito, 🔴/🟡, in-line publicados, achados que foram para o resumo por caírem fora de hunk, caminho do relatório local; mais o que foi deduplicado e o que ficou fora por `--max` |
| `cascade` | o sentido da cascata, PRs afetadas, o que propagou, o que escalou |
| `sweep` | padrão, PRs irmãs afetadas, itens enfileirados por PR, nada aplicado em silêncio |
| `status` | tabela do coletor, locks ativos, escalações abertas |
| `ready` | PRs em `done-pending` com o que falta para o merge (que é manual) |
| `orchestrate` | plano e estado atual, agentes (nome, papel, estado), eventos tratados, decisões do dono, o que espera o dono |
| `consolidate` | PRs juntadas, conflitos e como foram resolvidos, gate único (Faixas rodadas), PR de consolidação |
| `locks` | locks de PR e tickets da fila com a classificação (ativo, suspeito), o que foi liberado e por quê |
| `answer` | escalação respondida, decisão gravada (`appliesTo`), PR que voltou a ser acionável |
| `resume` | rastro achado, o que foi retomado e de qual etapa, o que ficou para perguntar |
| ops | o que mudou no próprio loop (lock liberado, escalação respondida, tick retomado) |

Modo `review` que rodou N agentes e não teve achado em um deles **diz "sem achados"** para aquele
agente: omitir esconde cobertura.
