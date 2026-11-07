# Escrita da Hades

Guia de escrita para notas, resumos, relatórios, descrições de PR, CHANGELOG, briefs, posts, documentos e texto de interface. O
objetivo é um texto que o dono lê uma vez e entende, sem cara de IA.

## Como usar

1. Identifique o tipo do texto na tabela abaixo.
2. Carregue só a skill da linha, no momento de escrever ou revisar. Nenhuma fica carregada em todo turno: a descrição entra sozinha, o
   corpo custa de 10 a 32 KB.
3. Escreva já pela regra. Antes de entregar, rode o passe de revisão e o checador.

| Tipo de texto | Carregue | Passe final |
|---|---|---|
| Documento técnico (`reference/`, spec, ADR, README, descrição de PR) | `technical-writing` | `reviewing-technical-prose` |
| Nota ou resumo ao dono (chat, nota do Argos) | `technical-writing`, só a regra de abrir pela conclusão | `humanizer-pt-br` |
| Relatório de agente (`report.md`, relatório do loop) | nenhuma; vale o formato de `reference/loop/report.md` | `hades write-check` |
| CHANGELOG, release notes, resumo de entrega | `writing-changelogs` por cima do formato da casa | `reviewing-technical-prose` |
| Brief, SKILL.md, CLAUDE.md (texto que agente lê) | `writing-for-agents` | `technical-writing` nas frases |
| Post público | `humanizer` e `humanizer-pt-br` | a amostra do dono vence qualquer regra |
| Texto de interface (botão, erro, vazio, carregando) | Impeccable `clarify` | seção Texto de interface, abaixo |

Revisar texto alheio ou pedir "revisa este texto": `reviewing-technical-prose`, depois `humanizer-pt-br` (aplique as listas dele e
não reescreva fato). Pedir "escreve sem cara de IA": o tipo da tabela decide a skill, e o passe final roda sempre.

## Precedência

Documento técnico, relatório e referência seguem `technical-writing`: sem opinião, sem primeira pessoa, sem travessão. A seção
"Personalidade e Voz" do `humanizer-pt-br` vale só para post e nota pessoal do dono. O formato do CHANGELOG da Hades (o que mudou, por
quê, o que se descobriu, `(#n)` da issue) vence o de `writing-changelogs`. A honestidade dessa skill vale: implementado, publicado e
verificado são estados diferentes, e a entrada diz qual é. Relatório de agente usa negrito de rótulo por exceção de tipo. Texto de
interface segue `clarify`, que vence o limite de frase da prosa técnica.

## Regras da casa

- Abra pela conclusão: o estado, a decisão ou o pedido ao dono. Contexto vem depois, e só o que muda a decisão.
- Uma afirmação por frase; média de 20 palavras e teto de 35. Procedimento: uma ação por frase, no imperativo.
- Nomeie quem agiu: "o hook barra o gate", não "o gate é barrado". Obrigação diz o dono dela.
- Número no lugar de adjetivo: "140 chaves", não "muitas chaves". Estimativa vem marcada como estimativa.
- Um termo por conceito, no documento inteiro. Não alterne "agente", "worker" e "sessão" para o mesmo papel.
- Diga o estado de cada afirmação: rodou, não rodou (e por quê), supôs, leu no código. Teste que falhou aparece com a saída.
- Cabeçalho nomeia o conteúdo (substantivo ou imperativo); pergunta só em FAQ de verdade.
- Estrutura só onde quem consome age sobre ela: tabela para itens com duas ou mais propriedades comparadas, lista para itens
  paralelos. Duas colunas de prosa são prosa.
- Termine no último fato. Oferta e pergunta ao leitor ficam no chat, em uma linha.
- Texto da referência descreve o que o sistema faz hoje. "Antes era", "passou a usar" e "foi refatorado para" vão ao CHANGELOG.
- Releia em voz alta e reescreva o que você não diria a um colega.

## Construções banidas em pt-BR

O `hades write-check` acha as marcadas com (c). As outras pedem leitura.

| Padrão | Exemplo | Reparo |
|---|---|---|
| Travessão em prosa (c) | "a única coisa que faltava — saber o estado" | vírgula, dois-pontos, ponto ou parênteses. Cabeçalho e célula `—` ficam |
| Antítese (c) | "não é só um gate, é uma política" | afirme o que é; contraste só quando corrige algo em que o leitor acredita |
| Anúncio de importância (c) | "vale destacar", "é importante notar", "o ponto central é" | diga a consequência |
| Gancho (c) | "e é aqui que tudo muda", "a verdade é que" | diga o fato |
| Recap (c) | "em resumo", "no fim das contas" | termine no último fato |
| Vocabulário inflado (c) | "crucial", "robusto", "poderoso", "abrangente", "jornada", "alavancar", "potencializar" | número, propriedade nomeada ou nada |
| Muleta formal (c) | "no que tange", "à luz de", "com o objetivo de", "além disso" | para, porque, se, agora |
| Gerúndio de cauda (c) | ", garantindo a consistência", ", permitindo escalar" | corte a cauda |
| Atribuição vaga (c) | "especialistas dizem", "estudos apontam" | a fonte e o achado, ou assuma como opinião |
| Resíduo de chat (c) | "espero ter ajudado", "ótima pergunta", "se quiser que eu" | apague |
| Cabeçalho em pergunta (c) | `## Por que JSON` | `## Formato JSON` |
| Aspas curvas, emoji e Title Case (c) | "Título Em Caixa Alta", "✅" | aspas retas, marcador simples, só a primeira maiúscula |
| Negrito de rótulo em lista (c) | `- **Desempenho**: ...` repetido | itens paralelos sem rótulo, ou subseções |
| Resíduo de produção (c) | "conforme solicitado", "diferente da versão anterior" | a restrição molda o texto e fica invisível |
| Diário de edição (c) | "antes era", "foi refatorado para" | descreva o que o sistema faz; a mudança é do CHANGELOG |
| Tríade por ritmo | "mais rápido, seguro e previsível" | dois itens, quatro, ou a medida: "poupa dois passos por release" |
| Frase de sentido no fim da seção | "essa distinção importa" | apague |
| Reformulação para ênfase | segunda frase que repete a primeira com mais força | fique com a melhor |
| Intervalo falso | "da arquitetura à cultura" | nomeie os itens |
| Hedge empilhado | "poderia potencialmente, em alguns casos" | um qualificador por afirmação, e só quando a fonte exige |
| Metáfora em gate ou procedimento | "o trem espera" | a ação: "o release para até o dono aprovar" |

Os padrões vêm de `technical-writing` (`references/style.md`) e do `humanizer-pt-br`; a lista acima é a versão em pt-BR do que a
Hades mede. O checador é grep: não pega o que depende de sentido (tríade, reformulação, hedge) e erra por excesso em texto citado,
por isso mascara código, crases, aspas retas e comentário HTML.

## Checador

```
hades write-check [--changelog] [--json] <arquivo>...
```

Saída `arquivo:linha: gravidade [código] trecho => reparo`; código de saída 0 limpo, 1 com achados, 2 uso errado. `--changelog` desliga
as regras de negrito de rótulo e de diário de edição, que o formato do CHANGELOG pede. Bloqueante (travessão em prosa, gancho,
resíduo de chat) se corrige antes de entregar; aviso se corrige ou se justifica no relatório.

## Checklist de entrega

1. O primeiro parágrafo traz a conclusão ou o pedido.
2. Cada afirmação sobre o estado do trabalho diz se rodou, não rodou ou foi suposta.
3. Nenhum fato entrou ou saiu na revisão de estilo (compare número, nome e caminho antes e depois).
4. `hades write-check` sem bloqueante; avisos corrigidos ou justificados.
5. O passe da tabela (`reviewing-technical-prose` ou `humanizer-pt-br`) rodou e o texto o cita no relatório.
6. Um termo por conceito; nenhum "antes era" na referência; nenhuma oferta no fim.

## Texto de interface

Seção autocontida: outros guias a referenciam sem trazer o resto.

Fonte: Impeccable `reference/clarify.md`. Regras que valem para botão, erro, estado vazio, carregando e confirmação:

- Rótulo de ação com verbo e objeto quando o resultado não é óbvio: "Gravar papel", não "Enviar". Rótulo descreve o que acontece, não
  o gesto.
- Ação destrutiva nomeia o objeto e a consequência, nos dois lados (mensagem e botão). Não use "Sim", "Não", "OK" nem "Enviar".
  Quando a recuperação é segura, prefira desfazer a confirmar.
- Erro responde três perguntas: o que falhou, por quê (quando se sabe e ajuda) e como sair. Não use código interno como mensagem
  principal, nem prometa causa ou solução que o sistema não conhece. Pagamento, exclusão e acesso perdido pedem tom sério, sem piada.
- Carregando nomeia a operação real: "Gravando…", "Criando terminal…", nunca "Aguarde…". Barra de progresso só quando há medida.
- Estado vazio distingue primeiro uso, busca sem resultado, filtro, permissão e falha, e oferece o próximo passo.
- Sucesso de rotina é curto. Diga a consequência só quando ela muda o que a pessoa faz.
- Mensagem inteira e traduzível: sem frase montada por pedaços; número e variável em campos que o tradutor reordena; espaço para o
  texto crescer.
- Um termo por conceito em todas as telas, e o mesmo verbo para a mesma ação.
- Aspas retas, sem Title Case, sem emoji como ícone de estado. Ícone sozinho leva nome acessível (`fw.acessibilidade-basica`).

O limite de 35 palavras e as demais regras de prosa não se aplicam a rótulo de botão.

## Fontes

| Fonte | Origem | Licença |
|---|---|---|
| `technical-writing`, `reviewing-technical-prose`, `writing-changelogs` | github.com/riekelt/technical-writer @ 85e53729dd95 | MIT |
| `humanizer` | github.com/blader/humanizer @ 0ef9fe5bc357 (padrões de "Signs of AI writing", Wikipedia) | MIT |
| `humanizer-pt-br` | github.com/mackswendhell/humanizer-pt-br @ ada3599ae273 | MIT |
| `writing-for-agents` | github.com/mattpocock/skills @ 4ae2317ddb22 | MIT |
| Impeccable `clarify` | `~/.claude/skills/impeccable/reference/clarify.md` | do pacote |

As skills são cópias fixadas em commit, sem atualização automática: atualizar é refazer a cópia e reler o diff. As listas de
vocabulário das fontes são em inglês; a cobertura de pt-BR é a do `humanizer-pt-br` e a deste guia.
