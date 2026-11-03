# Plano — <entrega>

Aprovado pelo dono em: <data> (registrar com `hades agent plan-approve <este arquivo>`; mudar depois pede nova
aprovação, exceto a seção "Estado atual", que fica fora do hash; o título pode ter sufixo, ex. "## Estado atual (26/10)", e a seção vai até o próximo `## ` fora de bloco de código).

## Estado atual
<!-- Até ~3 KB, reescrito a cada evento (nunca acrescentado): é a ÚNICA seção lida na retomada. Fora do hash da aprovação,
então reescrevê-la não pede nova aprovação. O histórico (eventos tratados, decisões, rodadas) vai em <este arquivo
sem .md>.log.md, só com append, e nunca é lido inteiro: `grep`/`tail -n 40` quando precisar de um fato antigo. -->
- **Unidades:** <nome — estado — PR/branch — próximo passo>, uma linha cada
- **Aguardando:** <o dono, gate, review: o quê e desde quando>
- **Próximo passo do orquestrador:** <uma linha>
- **Decisões em vigor:** <só as que mudam o que fazer agora>

## Objetivo
<o que a entrega resolve, em 2–4 linhas; fora do escopo>

## Unidades
| Unidade | Card | Papel | Modelo/esforço | Base | Depende de | Specs |
|---|---|---|---|---|---|---|
| <nome curto> | <card> ou novo | spec / impl / consolidate | das Configurações, ou exceção justificada | origin/<base> ou branch de baixo | — | IDs |

## Ordem e paralelismo
<quais unidades rodam juntas, quais esperam; stack, se houver>

## Arquivos compartilhados
| Arquivo | Dono | Os outros fazem |
|---|---|---|
| <caminho> | <unidade> | mudança aditiva, registrada no report |

## Consolidação e gate
<PR de consolidação (quais entram) ou stack sem consolidação; onde o gate roda (gates.md §1.0)>

## Riscos e decisões pendentes
<o que pode pedir escalada; perguntas ao dono ainda abertas>

## Estimativa
<!-- Gerada, não escrita à mão: `hades moirai estimate <este arquivo> --write` (antes do plan-approve). Custo e duração por
unidade, faixa p25–p75 e confiança, do histórico das unidades encerradas (`reference/moirai.md`). Dentro do hash da
aprovação: reestimar pede nova aprovação. Declare o tamanho no escopo da unidade ("~300 linhas", "5 arquivos"). -->

## Encolher o plano
Plano que cresceu com histórico (seções de eventos, rodadas, notas datadas): `hades agent plan-trim <plan.md>` move
toda seção `##` que não é do plano base (Estado atual, Objetivo, Unidades, Ordem e paralelismo, Arquivos compartilhados,
Consolidação e gate, Riscos e decisões pendentes, Estimativa) para o fim de `<plan>.log.md` e deixa o plano base.
