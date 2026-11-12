# Changelog — skill `hades`

Formato: uma seção por versão, a mais nova no topo. Cada entrada diz **o que mudou, por quê, e o que se descobriu no
caminho** (regra de negócio, armadilha, número medido). Versão: minor = capacidade nova; patch = correção ou armadilha;
major = quebra de contrato do kit (`env.sh`, layout de `$D`, nomes de scripts).

## 6.43.1 — 2026-11-12

Documentação (#17): ganho dos resumidores do rtk medido no que a ferramenta Bash devolve à sessão, não contra a
saída bruta como o `rtk gain` faz. Tabela e método em `reference/rtk.md` §Ganho medido.

- Em saída curta de gate verde o ganho é desprezível: 32% no `bun test`, uns 8 tokens por rodada.
- O `tsc` com poucos erros fica 21 B maior com o rtk: o handler repete a mensagem e acrescenta a contagem.
- O filtro do `bun test` esconde só o cabeçalho de versão e a contagem de `expect()`; contagem de testes, falhas e
  duração ficam.
- Pendente: a linha `node-nx` (`nx lint`/`nx test`), porque o clone medido não tem `node_modules`. O passo para
  completar está na referência.

## 6.43.0 — 2026-11-12

Capacidade nova (#77, #78): criar terminal pelo teclado no canvas do Argos.

- Shift+A cria um terminal de agente, Shift+O um de orquestrador e Shift+S um de shell, na posição do cursor.
- O nó de shell (`shell: true` em `POST /api/argos/terminals`) tem borda própria e fica fora do supervisor: não conta
  como agente nem recebe prompt.
- Teclas que mudaram de lugar: aprovar permissões em lote passou de Shift+A para Shift+Y, e organizar por equipes de
  Shift+O para Shift+T.

## 6.42.0 — 2026-11-12

Capacidade nova (#113, fatia 2, fecha a issue): página Extensões no painel (`#/extensoes`, grupo Sistema), sobre o
carregador da fatia 1.

- Lista as extensões (herdr, Mark) com instalada, versão (ou "desconhecida"), mínima, saúde, capacidades, problemas
  com código estável e chaves próprias com o valor efetivo e link para Configurações.
- Liga e desliga pelo painel local (`HADES_EXT_<NOME>`). `GET /api/extensions` devolve o mesmo JSON do
  `hades ext list --json`; `POST /api/extensions` exige o token da sessão e é recusado pelo acesso remoto
  (`ext.local-only`).
- O comando de instalação aparece como texto copiável que a Hades não executa. Tour de oito passos; sem rolagem
  lateral em 360 e 768 px.
- Armadilhas: religar apaga a chave do `config.env` (volta ao padrão); a lista fica guardada por 10 s porque versão e
  saúde rodam binários de forma síncrona (até 5 s cada).

## 6.41.0 — 2026-11-12

Capacidade nova (#59): avisar worktree de agente com filtro do rtk gerado e sem confiança. O rtk ignora esse filtro
em silêncio, e a saída do build e dos testes chega crua ao contexto do agente.

- `src/lib/rtk-trust.ts` lista, só lendo, as worktrees do registro dos agentes (inclusive as `skill-dev`) com filtro
  gerado pela Hades e estado não confiado ou alterado.
- Doctor: linha `rtk-trust` no grupo Resumidores (rtk), com a contagem, até 5 pastas e o comando de cada uma. Sem rtk,
  a linha não aparece.
- Painel: rota `GET /api/rtk-trust` (cache de 30 s) e card "Resumidores (rtk)" na página Consumo.
- Start do agente: o comando do dono (`agent new`, `review`, `skill-new`, `start-cmd`) vira
  `! (cd <pasta> && rtk trust) && herdr agent start …` quando a worktree tem filtro não confiado. O hook continua
  barrando o trust vindo das ferramentas do Claude.
- Armadilha: o rtk falso dos testes grava o `$PWD` no log, e um caminho com "trust" enganava um teste vizinho.

## 6.40.0 — 2026-11-12

Capacidade nova (#66): higiene do índice de memória do projeto (`MEMORY.md`), que entra em toda sessão do repositório,
inclusive nas worktrees de agente. Numa instalação real ele chegou a 36,4 KB: o que passa de 24,4 KB é cortado em
silêncio, e o resto custa contexto em todo turno.

- Doctor: linha `memoria-indice` (grupo Memória) com o tamanho contra o limite de carregamento, linhas acima de 150
  caracteres, entradas duplicadas, links para arquivo inexistente e entradas com cara de histórico encerrado. Sem
  índice, ok com o motivo.
- `hades memory tidy [--dry-run|--apply] [--json]`: encurta linhas, remove duplicatas e propõe a divisão em
  `MEMORY.md` (regras duráveis), `ORQUESTRACAO.md` e `ARQUIVO.md`, mostrando o diff. Dry-run por padrão; `--apply`
  grava com backup `.bak-<data>` e nunca apaga nem move arquivo de memória.
- O orquestrador grava e lê a memória de orquestração no `ORQUESTRACAO.md` (cartão e `orchestrate.md`).
- Armadilhas: o id `memoria` do doctor já era a checagem de RAM, daí `memoria-indice`; o histórico encerrado é
  heurística (60 dias ou "mergeada/entregue/concluída" no texto), por isso o `tidy` mostra o diff antes de gravar.

## 6.39.0 — 2026-11-12

Capacidade nova, pedida pelo dono (#113, fatia 1): Extensões, ferramentas externas da máquina que a Hades detecta e
consome. Extensão não é plugin: plugin é código do pacote de um projeto que roda no painel; extensão tem binário
próprio, fora da skill.

- Manifesto `extensions/<nome>/extension.json` (herdr e Mark embutidos): binário, comando de versão e versão mínima,
  capacidades (`canvas.terminal`, `voice`, `window`), texto de instalação, comando de saúde e chaves próprias.
- Validação na fronteira com caminho do campo e código estável (`ext.manifest.*`, `ext.binary-missing`,
  `ext.version-below-min`, …). Ler o manifesto não executa nada; versão e saúde são argv sem shell, e o comando de
  instalação é só texto para o dono.
- `hades ext list|info|enable|disable|doctor [<nome>] [--json]`; estado em `HADES_EXT_HERDR` e `HADES_EXT_MARK`
  (padrão ligado: nada muda). O doctor ganha o grupo Extensões, uma linha por extensão; ausente é ok com o comando de
  instalar.
- O código que já usa herdr e Mark continua igual nesta fatia. A página do painel fica para a fatia 2.
- Armadilhas: o Mark não tem comando de versão seguro (abriria a janela), então a versão sai "desconhecida"; o
  ambiente vence o `config.env`, e o teste do `ext` tira as `HADES_EXT_*` herdadas da release.

## 6.38.0 — 2026-11-12

Capacidade nova (#65): medir quanto contexto cada sessão já começa carregando, o piso que se paga em todo turno.

- `hades usage` ganha o bloco "contexto fixo": o contexto da primeira resposta de cada sessão principal (entrada +
  leitura + escrita de cache), com mediana, p90 e série diária por repositório, papel e modelo. `--json` ganha o campo
  `fixedContext`; nada foi renomeado.
- Decomposição em disco (estimativa por tamanho, dita no rótulo): cadeia de `CLAUDE.md`, `MEMORY.md`, `SKILL.md` e
  `brief.md`. Retrato diário em `~/.claude/hades/usage/partes.json` (30 dias).
- Linha "contexto fixo × custo": quanto do custo vem só do piso (contexto fixo × turnos), com o método escrito. Medido
  nesta máquina em 7 dias: mediana 41k, p90 73k, piso ~24% do custo.
- Página Consumo: cartão "Contexto fixo" (resumo, barras por dia, lista por grupo), sem rolagem lateral em 360 px.
- Doctor: linha `contexto-fixo` avisa quando a mediana dos últimos 7 dias sobe mais que `HADES_USAGE_BASELINE_WARN_PCT`
  (nova, padrão 15) contra os 7 anteriores e diz qual parte cresceu. Com menos de 3 sessões numa janela, fica neutra.
- Armadilhas: o cache de transcrições sobe para a versão 6 (relido uma vez); a parte que cresceu só aparece depois de
  uma semana de retratos; prompt de sistema, ferramentas e skills não têm arquivo e ficam fora da decomposição.

## 6.37.2 — 2026-11-12

Correção (#112): no Argos, clique, seleção por arrasto, duplo clique e links do terminal do nó caíam deslocados do
ponteiro, mais longe quanto mais longe da origem do terminal e diferente a cada zoom.

- Causa: o `getCoords` do xterm divide `clientX - rect.left` (retângulo já com a escala do quadro × zoom do canvas)
  pela célula sem transformação. O DPR não entra.
- Correção: `pointerCell` (modelo puro em `node-tty.tsx`) leva o deslocamento de volta ao layout por `rect / clientWidth`
  em cada eixo, e `fixMouseCoords` troca o `getCoords` do serviço de mouse do xterm por ele. Uma troca cobre arrasto,
  duplo clique e links; sem a API interna, o xterm segue com o dele. O terminal do celular não usa esse caminho.
- Teste: 9 casos do modelo (escalas 0,25–3,2, eixos distintos, fora da grade, meio da célula). Não houve prova no
  navegador nesta rodada.

## 6.37.1 — 2026-11-11

Correção (#109): o `hades minos publish explicacao|proposta` recusava toda página sobre o projeto ativo, porque a
camada 1 da guarda varria os termos de todos os perfis instalados, inclusive o do cwd.

- Na página pessoal (sem `--team`) dos modelos `explicacao` e `proposta`, a varredura de nome dispensa o perfil do
  projeto do cwd (`activeProjectTerms` → `guardTerms(roots, except)`). Credencial, caminho da máquina, e-mail, valores
  do `credenciais.md` e termos de outros perfis seguem barrados; página do time e modelo de orquestração não mudam.
- Armadilha: o vocabulário é subtraído por igualdade de texto; um termo ERE idêntico em outro perfil também sai da
  varredura dessa página.
- Teste: `loop/test/ts/minos-guarda-projeto.test.ts` (7 casos).
- Release: a guarda de nome da `skill-release` só acusa o nome do perfil sem letra colada dos dois lados. Um perfil de
  nome curto contido numa palavra comum (como "credenciais") fazia a guarda barrar 83 arquivos; `nome_db` e `NOME_URL`
  seguem acusados (por isso não é `grep -w`, que trata `_` como letra).

## 6.37.0 — 2026-11-09

Capacidade nova, pedida pelo dono: o Minos publica mais dois modelos de página, além do acompanhamento da orquestração.
A sessão escreve um JSON e o Minos monta a página, passa o Cerberus e entrega o arquivo para a ferramenta Artifact.

- **Explicação de código em página (`explicacao`).** Resumo que responde antes do detalhe, fluxo passo a passo com
  `arquivo:linha`, seções com trechos copiados do arquivo, tabela de arquivos, glossário, ressalvas (o que não foi
  conferido) e perguntas para investigar.
- **Proposta ou discussão em página (`proposta`).** Cinco tipos (`implementacao`, `correcao`, `fluxo`, `refatoracao`,
  `discussao`), cada um com o próprio título de página. Mostra contexto, problema, escopo, fluxo de hoje ao lado do
  proposto, opções com prós, contras, esforço e risco, recomendação, plano, riscos e perguntas abertas ou respondidas.
  A discussão segue pelos comentários do artifact; resposta e decisão entram no JSON e a página é republicada no mesmo
  link.
- **`hades minos schema <modelo>`** imprime um exemplo completo e válido. Os textos do exemplo mostram o tom esperado:
  conclusão primeiro, afirmação com fonte e lacuna nomeada. As regras de conteúdo estão em `reference/minos.md`
  §Como escrever o conteúdo.
- **O escopo vem da invocação.** `publish` toma `scope` do `--team` e ignora o do arquivo, então um JSON não se
  publica na página do time sozinho. `generatedAt` ausente vira o instante da publicação.
- **Contrato na fronteira**, como na orquestração: tipo errado, enum desconhecido, id de opção repetido, recomendação
  que não aponta opção e texto acima do teto são recusados com o caminho do campo. Tetos: 500 caracteres em rótulo,
  4000 em parágrafo, 12000 por trecho, 2 MB no arquivo. Só a crase vira marcação, e depois do escape.
- **Página de documento.** `kit/minos/orquestracao.html` virou `kit/minos/pagina.html`, o modelo dos três. Explicação
  e proposta usam seções separadas por fio, sem cards aninhados, e linha de no máximo 70 caracteres. A orquestração
  segue em cards. Conferido em 1000 px e em 390 px, sem rolagem lateral.
- Os helpers de validação saíram de `minos-model.ts` para `minos-check.ts`, e o escape foi para `minos-esc.ts`. Os
  dois módulos novos são `minos-doc.ts` (contrato e exemplos) e `minos-doc-html.ts` (corpo das páginas).

Verificação: `bun test loop/test/ts/minos-*.test.ts` com 43 casos, 0 falhas. O grupo novo é `minos-documento`.

Descoberto no caminho:

- **Cache de versão nova gravado dentro da skill, corrigido.** Sem `HADES_DATA` no ambiente, `hades version-check`
  caía no `kitDir()` e gravava `version-check.json` em `kit/`. O `install.sh` copiava esse arquivo para o `$D` como se
  fosse do kit, e o golden `skill-release-cli.json` regravado o listava. Agora o comando resolve o `$D` por
  `findStateDir()`, como o resto da CLI, e só usa o kit quando não há instalação. Teste novo em `versao-check`.
  O golden regravado mostra só a troca de `minos/orquestracao.html` por `minos/pagina.html`.
- **Regressão completa sob carga.** Numa máquina carregada, 12 casos estouraram o prazo de 5 s (install, launchd,
  multi-instancia, plugins-painel, resolver, rtk-worktree). Rodados à parte, os 12 passaram.

## 6.36.0 — 2026-11-08

Capacidade (#106, unidade argos-zoom): zoom semântico no Argos. Afastando o zoom, o canvas perdia o significado antes do
espaço: de longe só sobravam blocos de cor, e saber o que trabalha ou pede você exigia aproximar.

- **Bem longe:** cada área e grupo mostra o nome e a contagem por estado (trabalhando, pede você, ocioso) em 11 px de
  tela, sem sobrepor, as maiores primeiro. Clique ou toque sem arrasto no rótulo enquadra a área; Enter na área focada
  faz o mesmo abaixo do nó completo.
- **De longe e Médio:** uma linha de resumo por nó (agente: estado e fase; PR: número, estado e CI; nota: título ou
  primeira linha), cortada por largura e só com bloco de 30 px de tela ou mais.
- **De perto**, os limites de escala e o HTML do nó não mudam. O resumo e a contagem saem de um modelo puro
  (`src/lib/canvas-semantic.ts`); o motor só desenha.
- Limites: terminal sem resumo (a última linha só chega pelo fluxo do tty), nó com forma própria fica só com o rótulo,
  grupo não tem foco de teclado, contagem longa corta sem tooltip.
- Medido com 2000 nós: p50 por quadro igual (±0,2 ms) e 59,7 fps em todos os níveis; o p95 do zoom pela roda subiu
  de 7,3 para 9,0 ms, porque os rótulos de área são recalculados a cada quadro.

## 6.35.1 — 2026-11-08

Correção (#103, unidade voz-celular): a voz do Mark no Chrome do Android abria, mas o microfone não entregava áudio.
O medidor ficava parado com o botão apertado e o Mark fechava em 5 s com `mark_voice_idle_timeout`. Causa provável,
ainda sem prova no aparelho: o worklet de captura não tinha saída e o `AudioContext` ficava suspenso fora do gesto (o
pedido de permissão do `getUserMedia` tira o contexto do gesto).

- O worklet `voice-capture` ganhou uma saída, ligada ao `destination` por um `GainNode` de ganho 0: o grafo passa a
  processá-lo, sem eco.
- `resume()` do contexto ao apertar o botão, ao ligar a conversa aberta e depois do `getUserMedia`. A espera é limitada
  a 800 ms, porque sem gesto o `resume()` pode nunca resolver (medido no Firefox headless).
- Vigia no cliente (`createMicWatchdog`, relógio injetado): botão apertado, ou conversa aberta com a voz pronta, e
  nenhum quadro em 1,5 s fecha com o erro novo `mark_voice_mic_silent`, antes do timeout de 5 s do Mark. Não vigia com
  a aba escondida.
- Linha de diagnóstico sob o medidor: estado do contexto, taxa e quadros enviados. Só contagem, nenhum áudio em log.

## 6.35.0 — 2026-11-08

Feature (#97 e #102, unidade canvas-criar): o agente cria desenho no canvas sem passo manual do dono, e o Mark ganha
botão na barra do Argos.

- `hades canvas drawing new <nome> [--title t] [--w n --h n] [--link-to <recruta>]… [--from-json arq]`: espelho do
  `note new`. Cria o nó `drawing` (480×320) acima do orquestrador sem sobrepor outro nó, liga ao chamador e aos
  recrutas citados num lote só do desfazer e imprime o id. O `<nome>` vira o título (o nó não tem campo `name`); a
  unicidade é por título sem distinguir caixa, porque o `drawing add` acha o desenho por id ou título. `--from-json`
  aceita até 1 MiB e valida os elementos com os tetos de `DRAWING_LIMITS`. Só o orquestrador cria, como no `note new`
  (a issue previa recruta criando ligado a si). Erros novos: `drawing_title_exists`, `canvas_from_json_invalid`; o
  404 do painel passa a ser `canvas_not_found`.
- Botão **Mark** na barra de ferramentas do canvas, depois de Desenho, sempre visível: com nó `mark` revela o nó; com
  a ponte presente e sem nó cria (o mesmo comando `mark:add` da paleta); sem `bridge.json` fica `aria-disabled`,
  focável, com causa e ação no `title`. A disponibilidade muda sem recarregar.
- Armadilha: qualquer edição em `kit/panel/` muda o hash do service worker, então o golden `painel-legado.json`
  (linha `GET /sw.js`) se regrava junto.

## 6.34.0 — 2026-11-08

Feature (#99, unidades mark-voz no fork do Mark e argos-voz na skill): falar e ouvir o Mark pelo Argos, no celular
(Android com Chrome, via túnel) e no desktop, com a mesma voz e o mesmo cérebro do desktop. O dono pediu o áudio pelo
Mark, não pela fala e voz do navegador: o celular vira microfone e alto-falante remotos do Gemini Live dele.

- Servidor (`src/panel/mark-voice.ts`, `mark-voice-logic.ts`): `GET /api/mark/voice` com upgrade WebSocket e as
  mesmas guardas do terminal (host, chave, Origin antes do upgrade). Repassa quadros binários e de controle ao
  `/ws/voice` da ponte do Mark em loopback, lendo o `bridge.json` a cada conexão (o token não chega ao navegador).
  Um cliente por vez (`busy`), teto de quadro (3200 B) e de taxa (100 quadros/s) também na entrada do painel, teto de
  duração (`HADES_MARK_VOICE_MAX_S`, 600 s), fechamento conjunto, erros `mark_voice_*` no catálogo de erros humanos.
  Nenhum quadro de áudio vai para log, arquivo ou teste.
- Cliente (`kit/panel/ui/argos/voice.tsx`, `voice-logic.tsx` e dois AudioWorklets): captura com cancelamento de eco,
  reamostrada para PCM16 16 kHz; reprodução 24 kHz com buffer curto, que `interrupted` esvazia. O nó `mark` ganha
  "Falar", que abre uma folha em tela cheia: segurar para falar (padrão, `HADES_MARK_VOICE_MODE`), conversa aberta,
  medidor, orbe, últimas falas, encerrar. Espaço segurado no desktop; Wake Lock e retomada do `AudioContext` no
  celular; comando de paleta `mark:voice`. O código de voz carrega sob demanda.
- Doctor: item `mark-voz` (o Mark responde `ready` a um `hello`).
- Lado do Mark (PR #8 do fork, mergeada): `/ws/voice` na ponte; enquanto há cliente, o microfone e a palavra de
  ativação do desktop pausam e a resposta toca só no cliente; a sessão do Live não reinicia na troca.
- Descoberto: o Live gera fala mais rápido que o tempo real; sem cadenciar a saída (~0,4 s à frente), a resposta
  inteira ia ao buffer do celular e `interrupted` não a cortava. Em conversa aberta o cliente manda quadro sempre,
  porque calar estouraria o `idle_timeout` de 5 s do Mark. Captura headless mostra `rate_limit` falso: o worklet gira
  no tempo virtual do navegador.
- Fica com o dono no aparelho: voz real, latência até a primeira sílaba, eco no viva-voz, tela apagando, troca de rede.

## 6.33.0 — 2026-11-08

Feature (#98, unidade argos-mark): o Mark-LVI vira um nó do canvas do Argos. O dono pediu para ver e falar com o Mark
de qualquer aba do painel, inclusive pelo celular via túnel. A voz continua no desktop.

- Nó `mark` (`kit/panel/ui/argos/node-mark.tsx`, 360×420): orbe na cor do estado (ouvindo, pensando, falando, mudo),
  nome, log ao vivo com rolagem própria, campo de texto, botões acordar e abrir o último relatório (só leitura, como
  `<pre>`, sem HTML). Fora do ar, o nó mostra causa e ação e reconecta com recuo. "Mark" aparece na paleta só quando a
  ponte existe.
- Servidor do painel (`src/panel/mark.ts`, `src/lib/mark-bridge.ts`): `GET /api/mark/state`, `GET /api/mark/events`
  (SSE que repassa o `/ws` do Mark), `POST /api/mark/command`, `POST /api/mark/wake`, `GET /api/mark/report`. O painel
  lê `bridge.json` (`{port, token, scheme, pid}`) a cada chamada, fala só com 127.0.0.1 e manda o token como Bearer:
  **o token nunca chega ao navegador**. Arquivo ausente, `pid` morto ou porta fechada respondem `{online:false, cause}`
  com códigos `mark_*` no catálogo de erros humanos. O relatório só abre se for um `.md` regular dentro de uma pasta
  `reports`, conferido depois de resolver links simbólicos.
- Configurações: `HADES_MARK_BRIDGE` (caminho do `bridge.json`, padrão `~/.config/mark-lvi/bridge.json`) e
  `HADES_MARK_TIMEOUT_S`. O plano falava em `mark.bridge`, mas o catálogo só aceita chaves `HADES_*`.
- Doctor: item `mark-ponte` (ponte encontrada, Mark respondendo).
- Limite conhecido: copiar, colar ou duplicar pode criar um segundo nó mark. O teto de 8 streams SSE protege o servidor.
- Capturas em 360 e 768 px pelo Firefox headless atrás de um proxy que segura o `load`. O chromium headless shell não
  esperou a página e capturou só a tela de abertura.

## 6.32.0 — 2026-11-07

Correção com opção nova (#45, unidade notify-dedupe): CI vermelho e review novo avisam uma vez por evento, não uma vez
por janela de tempo.

- Identidade do aviso: CI = PR + head + conjunto de checks que falharam; review = PR + id do review (ou `submittedAt`) +
  comentários top-level por id. Responder ou resolver thread não é review novo; rerun que falha nos mesmos checks não
  repete; push novo que falha avisa.
- As marcas ficam em `$D/notify/pr-marks.json` (`src/lib/notify-marks.ts`, decisão pura em `planPrNotices`). Não expiram
  por `HADES_NOTIFY_DEDUPE_MIN` nem somem no `forget`. A de CI zera quando o head muda; a da PR some quando ela sai da
  lista do coletor (fechou ou mergeou), com tolerância de 1 h para falha passageira da busca.
- Interruptores "CI vermelho" e "Review novo" independentes: `HADES_NOTIFY_EV_CI` passa ao padrão `both`. O valor `pr`
  já gravado segue aceito e segue o canal do review. Mudança de comportamento: quem só tinha desligado `EV_PR` passa a
  receber CI vermelho (era o defeito: desligar o review calava o CI).
- Lembrete opcional `HADES_NOTIFY_CI_REMIND_H` (padrão 0, desligado): "Lembrete: segue vermelho há N h (não é falha nova)".
- `failing: []` (rerun pendente) deixou de contar como CI vermelho.
- Teste de regressão com relógio injetado além da janela (`loop/test/ts/notify-dedupe.test.ts`); `NotifyContext` aceita
  o relógio.
- Fica de fora: dedupe entre instâncias do mesmo repositório (documentado em `reference/notify.md`); o seletor segmentado
  do CI vermelho corta o último rótulo em 360 px (já cortava antes).

## 6.31.0 — 2026-11-07

Capacidade nova (unidade erros-humanos): toda falha visível ao dono diz o que aconteceu, por quê, o que fazer e onde
ler mais, em português e sem pilha nem segredo.

- Catálogo único `src/lib/human-errors-catalog.ts` (código → título, causa, ação, referência) e `src/lib/human-errors.ts`;
  o código estável (`code`, `*_errors`) não muda. Código sem entrada mostra o código e aponta o `doctor`.
- CLI: stderr com "Por quê", "O que fazer", "Saiba mais" e o código; `hades explain <código>` explica um erro.
- Painel: as respostas de erro ganham o campo aditivo `explain`; recusas sem código passam a ter um (`panel_host`,
  `panel_token`, `panel_remote_key`, `panel_bad_request`). O componente `ErroExplicado` quebra texto longo e esconde a
  mensagem crua (`JSON.parse…`, `Failed to fetch`) em Cerberus, Docs, Configurações, Qualidade, Consumo, Notificações e
  Onboarding, com botões de 44 px no celular.
- Hook que barra comando diz o que fazer no lugar. Guia em `reference/erros.md`; pedido "por que falhou?" em
  `reference/pedidos.md`.
- Armadilha: o `check` mostra só as 40 primeiras linhas de falha (cerca de 8 testes); para ver todas, rodar a suíte do
  núcleo inteira.

## 6.30.0 — 2026-11-07

Capacidade nova (Argos, unidade argos-fluxo): o fluxo de uso do canvas ficou mais claro.

- Toolbar com rótulos a partir de `xl`; filtros de estado e níveis de conteúdo em português; "Conteúdo dos nós" no
  menu Vista.
- Menu do fundo enxuto: 12 essenciais e "Mais N comandos…", com o motivo de cada item desabilitado.
- Tela vazia com botões de ação (novo terminal, nova nota).
- Ilha de estado com chips por tom; cada chip filtra e leva aos nós dele ("esperam por você").
- Organizar por equipes (`Shift+O`), procurando vaga livre no canvas.
- Celular: piso de toque de 44 px (antes 40) e trilho lateral de 44 px; a Legenda não fica mais sob a barra de zoom.
  Medido em 360 e 768 px, sem rolagem horizontal.

## 6.29.0 — 2026-11-07

Capacidade nova (Argos, unidade argos-camadas): o "subir/baixar" vira um modelo só, com três estados.

- **No canvas**, **Em destaque** (antes elevar/acoplar) e **Na bandeja** (antes ocultar), com os verbos Destacar,
  Recolher e Voltar ao canvas. A bandeja fica sobre o canvas (pílula "Bandeja · N", chips por nó, "Voltar todos").
- O cabeçalho do terminal, do agente, da nota e do esboço de unidade ganhou Destacar, Recolher e "⋯". A moldura
  destacada mostra o nome do nó e o "Voltar ao canvas" sempre visível, e não fica mais sob o painel do nó no desktop.
- Áreas com 12 cores e amostra no seletor; título com folga da borda.
- Celular: alvos de toque de 44 px até 1023 px (antes só abaixo de 768). Medido em 360 e 768 px, sem rolagem horizontal.
- Armadilha: `button { min-width: 40px }` do `index.html`, fora de `@layer`, vencia o `max-md:min-w-11` do Tailwind;
  o mínimo passou a `max-lg:min-w-11!`.
- Limite: no canvas o nó escala com o zoom (44 px viram 26 px a 60%); o caminho de toque é Destacar, que abre em 1:1.

## 6.28.1 — 2026-11-07

Correção (bug do dono, 07/11: "não deu pra remover do canvas o agente encerrado"; unidade canvas-remover).

- Remover um terminal encerrado do canvas não volta mais quando outra aba ou o orquestrador grava o mesmo nó no meio:
  `DocSaver.forget(ids)` faz a remoção do dono vencer no 409 e na mescla do stream (`rebaseDoc(..., dropped)`,
  aditivo e idempotente). O toast de falha diz o código da gravação ou que outro escritor segurou o canvas.
- Medido: com escritor concorrente, 64 de 400 remoções precisavam de 2+ tentativas e 3 esgotavam as 3 tentativas; a
  mescla da 6.28.0 mantinha o nó que o servidor tinha mexido. Teste de regressão em
  `loop/test/ts/canvas-remover-terminal.test.ts`.

## 6.28.0 — 2026-11-07

Capacidade nova (Argos, unidade argos-interacao).

- O canvas se atualiza sozinho quando o documento muda no servidor (CLI, outra aba, agentes): o stream existente
  (`/api/canvas/stream`) ganhou religação com recuo (`src/lib/canvas-live.ts`) e mescla por nó (`DocSaver.absorb`
  sobre `rebaseDoc`). Edição local em curso é preservada; o aviso e o botão "Recarregar" saíram.
- Medido: 43 ms entre duas abas, religação em 1,3 s, nenhum timer com a aba escondida. WebSocket e CRDT foram
  avaliados e descartados (o stream já bastava).
- `Ctrl+A` seleciona os nós visíveis (não vale em campo nem no terminal); Shift sobre o fundo mostra o cursor em cruz
  do retângulo de seleção.
- Celular (360 px): sem rolagem horizontal; ficam abaixo de 44 px os botões do cabeçalho da nota e o trilho lateral,
  e o botão "Legenda" fica sob a barra de zoom (arquivos de outras unidades, a corrigir nelas).
- Armadilha: a suíte paralela do `check` estoura 30 s em `caronte unpack` e `painel-herdr-admin` com a máquina
  carregada; isolados passam.

## 6.27.1 — 2026-11-07

Correção (pedido do dono, 07/11): três avisos falsos do `doctor` medidos na máquina do dono.

- `herdr-servidor`: o doctor dizia "painel no ar sem servidor herdr" com o servidor no ar. Causa: sob o `env.sh` o PATH
  começa pela pasta do node (`/usr/bin`), e o CLI chamava o herdr 0.8.2 do sistema (protocolo 20) contra o servidor
  0.9.5 (protocolo 22), recebendo `protocol_mismatch`. `herdr()` passa a usar o binário do painel (`HADES_HERDR_BIN`,
  vazio segue o PATH; valor inválido falha alto) e o doctor distingue servidor fora do ar de cliente incompatível.
- `node_modules`: com o plugin do projeto desligado (`plugins.disabled`) ou sem `node-modules.sh` no `$D`, o item sai
  "não se aplica"; a sugestão só nomeia script que existe.
- Onboarding: o passo `front-tunnel` vira `na` com o plugin do projeto desligado (não há front para publicar).
- Falta: `wait.ts`, `watch.ts`, `agent.ts`, `agent-registry.ts` e `panel/term.ts` ainda chamam `herdr` do PATH direto.

## 6.27.0 — 2026-11-07

Capacidade nova (issue #81, etapa 2): guia de escrita da Hades e um checador dos padrões de texto de IA.

### Guia de escrita e `hades write-check`

- `reference/escrita.md`: por tipo de texto (documento técnico, nota ao dono, relatório de agente, CHANGELOG, brief,
  post, texto de interface), qual skill de escrita carregar, quem vence quando duas discordam, construções banidas em
  pt-BR e checklist de entrega. As skills carregam sob demanda, não em todo turno (o corpo pesa de 10 a 32 KB).
- `hades write-check [--changelog] [--json] <arquivo>...`: grep dos padrões de escrita de IA em pt-BR (17 regras;
  travessão em prosa, gancho e resíduo de chat são bloqueantes). Mascara código, crases, aspas retas e comentário HTML;
  `--changelog` desliga as regras que o formato do CHANGELOG pede. Saída 0 limpo, 1 achados, 2 uso.
- Modelos de brief, formato do relatório e contrato das unidades apontam o guia; pedido "escreve sem cara de IA" em
  `reference/pedidos.md`.
- Medido no corpus: a prosa da Hades já é limpa; o defeito real é travessão em prosa, cabeçalho em pergunta, negrito de
  rótulo e histórico de edição dentro de referência. O checador não pega o que depende de sentido (tríade,
  reformulação, hedge). O legado fica como está até o arquivo ser tocado por outro motivo.
- Armadilha: o ponteiro novo nos modelos de brief muda os goldens `refs-brief`, `agent-new-brief`, `agent-skill-brief`
  e a lista de docs do `painel-legado`.

## 6.26.0 — 2026-11-07

Capacidade nova (issue #81, frente 2): regras contra interface de cara gerada no catálogo de qualidade.

### Pacote `anti-slop` (#81)

- 22 regras `ui.*` (tipografia, cor, hierarquia, espaçamento, ornamento, texto vago, estados, responsivo, movimento),
  derivadas do Impeccable (Apache-2.0, atribuição em `quality/THIRD-PARTY.md` e licença em `quality/licenses/`).
  Seis delas têm `check` por grep.
- Campo novo `scope` no catálogo (aditivo no esquema): regra com `scope: ["frontend"]` só entra em trabalho de frontend
  (dependência de UI no `package.json`, `index.html` ou stack de UI). Backend não recebe.
- `doctor` e `hades deps` avisam se o Impeccable está instalado e o que se perde sem ele; é aviso, nunca erro.
- Armadilha: os goldens de quality e do doctor mudam a cada regra nova do catálogo.
- Correção de teste: `painel-herdr-admin` dependia da config da máquina que a fila de gates exporta; com
  `HADES_HERDR_BIN` absoluto, o painel do teste chamava o herdr real. O teste agora fixa o herdr falso.

## 6.25.0 — 2026-11-07

Capacidade nova (issue #81, frente 1): auditoria de usabilidade recorrente do painel com o Impeccable.

### `hades ux-audit` e o papel `ux-audit` (#81)

- Auditoria de usabilidade do painel e do Argos com o Impeccable que o dev instalou (nunca empacotado). Comandos
  `start`, `add`, `list`, `forward [--issues]`, `resolve`, `done`, `reminder`; cartão em `reference/loop/roles/ux-audit.md`.
- Achados viram itens com chave estável (página + regra) que não se repetem entre rodadas; resolvido que volta é
  regressão. `forward --issues` abre issue só por ordem explícita.
- `HADES_UX_AUDIT_REMINDER` (padrão `release`, ou `off`): o `skill-release check` lembra quando `kit/panel/ui` mudou desde
  a última rodada. Sem o Impeccable, `start` sai 69 com como instalar.
- Armadilha: a regra do achado é o tipo do problema, não a frase; frase como chave fazia o mesmo achado voltar como novo.
- Prova: duas rodadas num painel descartável; a segunda repetiu os 7 achados como "repetido" e trouxe 1 novo.

## 6.24.0 — 2026-11-07

Capacidade nova (issue #79): desenho e escrita livre no canvas do Argos, legíveis e editáveis por agentes.

### Desenho do canvas (#79)

- Nó `drawing` no canvas: traço livre, formas, texto e conectores ligados aos elementos (o conector segue o elemento
  quando ele se move). Formato versionado (`v: 1`), modelo puro em `src/lib/` com SVG próprio.
- Botão **Desenho** na barra do canvas; exportação PNG no painel (rasteriza o mesmo SVG da rota) e SVG pela CLI e pela
  rota.
- Agentes leem e editam pelo `hades canvas drawing …` (leitura estruturada, não imagem), com as mesmas regras de
  permissão das notas: desenho não ligado ao agente responde 404. O compositor cita o desenho pelo `@`, no texto e no
  menu, e "o que o agente lê" inclui os desenhos ligados (`canvas-links.ts`, lado `drawing`).
- Golden do painel regravado só pelo caminho explícito (o `sw.js` ganhou os arquivos novos do desenho).
- Não provado ao vivo: o clique no botão PNG no navegador e a CLI com pane real do herdr (coberta por teste com herdr
  falso). Fica para depois: o `canvas recruit` listar os desenhos ligados no primeiro prompt.

## 6.23.1 — 2026-11-07

Correção da 6.23.0 (#80): a área colorida só saía pelo menu e pela paleta; faltava o botão na barra do canvas.

### Botão Área na barra do canvas

- Ferramenta **Área** (ícone de retângulo tracejado) ao lado de Terminal e Nota. Arrastar um retângulo cria a área com
  esse tamanho (clique ou Enter: 480×320) e já encaixa os nós cujo centro cai dentro dele, num passo só de desfazer
  (`nodesCenteredIn` em `src/lib/canvas-areas.ts`).

## 6.23.0 — 2026-11-07

Capacidade nova (issue #80): áreas coloridas no canvas do Argos para agrupar agentes por frente de trabalho, com encaixe
por arraste.

### Áreas do canvas (#80)

- Tipo de nó do usuário `area`: retângulo com título e cor da paleta `chart-1`..`chart-5`, desenhado atrás de tudo
  (`z = -layer`), que move e redimensiona pelas bordas como os outros. O interior é oco: só o cabeçalho e as bordas
  pegam clique; o resto passa para os nós e para o fundo, e a seleção por retângulo só pega a área inteira.
- Encaixe: soltar um nó com o centro dentro da área o encaixa; soltar fora o retira. Durante o arraste, a área que vai
  receber o nó se destaca. Mover a área leva os membros; apagar a área não apaga os nós. Mover e encaixar é um passo
  só de desfazer (`settleMove`).
- Pertença gravada em `data.members` da área (aditivo, sem subir `v` do documento). Um nó fica em no máximo uma área;
  apagar nó poda a lista e colar remapeia os ids.
- Comandos `area:create` (em volta da seleção), `area:dock`, `area:undock`, `area:rename`, `area:color`, também no
  menu do nó; leitura para agentes: `hades canvas area list`.
- Grupos e áreas são independentes: o grupo continua sendo a caixa que envolve os membros; a área é retângulo fixo.

### Armadilhas

- Redimensionar a área e mover grupo por comando não mudam a pertença (documentado em `reference/argos.md` §Áreas).
- O `PUT /api/canvas` não valida o `data` da área; o desenho tolera valor fora da paleta (área neutra), para documento
  editado à mão nunca quebrar o quadro.

## 6.22.0 — 2026-11-07

Correção (issue #76): sair do canvas do Argos e voltar (trocar de aba, clicar na barra lateral do painel) levava a
câmera até um nó que o dono não pediu.

### Câmera quieta na volta do foco (#76)

- Causa: quando o host do canvas recebia foco sem nó focado, o `onFocus` entrava pelo primeiro nó da ordem de leitura e
  a câmera ia até ele. O foco devolvido pelo navegador ao voltar à aba ou à janela e o clique no canvas caíam nesse
  caminho. "Aleatório" era o primeiro da ordem de leitura mudando com o canvas; "fixo", o mesmo com o canvas parado.
- Correção: só o Tab entra pelo primeiro (ou último) nó. Clique e volta de janela/aba deixam a câmera onde está
  (`entersFirstNodeOnFocus` em `src/lib/canvas-selection.ts`; sinais de clique e de janela fora em `canvas-engine.tsx`).
- Mantidos: devolução de foco ao fechar menus e diálogos, F6 e navegação explícita até nó.

### Armadilhas

- Os `.focus()` do Argos já usavam `preventScroll`: a rolagem do navegador não era a causa.

## 6.21.0 — 2026-11-07

Terminal do nó do Argos com links clicáveis e busca (issue #73). O mouse no programa fica para depois: precisa de
mudança no fork do herdr (contrato abaixo).

### Links e busca (#73)

- **Links:** URL `http(s)` da tela abre em nova aba (`noopener,noreferrer`). Caminho absoluto de arquivo `.md`,
  `.markdown` ou `.txt` vira nota ao lado do nó, pelo mesmo `POST /api/canvas-notes/link` de soltar arquivo: o servidor
  decide a raiz e recusa `..`, fora da raiz e link simbólico para fora. Caminho relativo não abre.
- **Busca:** Ctrl+F no nó focado abre uma barra que procura na tela e no scrollback (`/api/herdr/scrollback`), com
  contagem, próximo/anterior (Enter e Shift+Enter, com volta) e destaque. Esc fecha e devolve o foco ao terminal. A barra
  não deixa tecla nem colagem irem ao pane e não bloqueia as teclas globais do Argos.
- Regra pura em `kit/panel/ui/argos/tty-extras.tsx` (detecção de link, busca sem regex), sem dependência nova; teste
  `argos-tty-extras` (18 casos).

### Mouse: contrato pendente no fork

O fork do herdr não expõe o modo de mouse do pane, e `send_text`/`send_input` entregam o texto como colagem entre
colchetes, então bytes SGR não chegam ao programa como mouse. Proposta em `reference/argos.md`: `pane.read` ganha
`mouse {reporting, protocol, encoding}` (aditivo) e um método `pane.send_mouse` que o herdr codifica no formato do
programa, com erro `mouse_not_enabled`.

### Armadilhas

- Com o nó focado, Ctrl+F abre a busca e não chega ao shell (no readline, ele avança o cursor uma letra).
- `rtk-worktree: doctor` estourou os 30 s em dois `check` seguidos sob carga e passou sozinho: teste instável, aberto.

## 6.20.0 — 2026-11-07

Terminais do Argos com tamanho real (issue #56): o nó dimensiona o PTY do pane do herdr em vez de só escalar a fonte,
e o cursor desenhado é o do herdr, não o estimado. Exige o fork do herdr com `pane.set_size` e o cursor no `pane.read`,
publicado em [The-Hades-Organization/herdr](https://github.com/The-Hades-Organization/herdr) (base v0.9.5, branch
`hades/pane-set-size`). Com o herdr do sistema, tudo degrada para o comportamento anterior.

### Resize real e cursor real (#56)

- `HADES_HERDR_BIN`: caminho do binário do herdr usado pelo painel (o fork). Rota `POST /api/herdr/size` chama o
  `pane.set_size` (fixa ou libera); o herdr sem o método responde e o nó segue com o tamanho do layout.
- `kit/panel/ui/argos/node-tty.tsx`: o nó calcula cols × rows pelo tamanho dele e pela métrica real da célula do xterm
  e pede o resize com debounce; o zoom do texto muda só a fonte. O cursor real substitui o `guessCursor` quando o herdr
  o entrega.
- `src/panel/herdr-stream.ts`: com o tamanho fixado, o quadro do fluxo usa o tamanho do PTY e não o retângulo do layout,
  até ser liberado (`pane_updated` com `size_pinned` e a rota de tamanho avisam o fluxo).
- **Bordas:** o terminal redimensiona pela borda esquerda, direita e de baixo e pelos dois cantos de baixo, sem
  precisar selecionar; o topo (e os cantos de cima) continua sendo a alça de mover. A borda esquerda move `x` junto,
  a direita fica parada. O cursor do mouse segue a borda. Os outros tipos de nó mantêm a alça do canto inferior direito.
- **Nome no herdr:** o fork só aceita nome de agente em `[a-z][a-z0-9_-]{0,31}`. O `herdr agent start` recebe o nome
  derivado do nome do painel (`src/lib/herdr-agent-name.ts`: minúsculas, sem acento, `-` no lugar do resto, começa por
  letra, até 32, `-2`/`-3` na colisão); o canvas segue mostrando o nome do painel. O registro guarda `herdrName`;
  registro antigo deriva na hora.

### Correções do teste do dono

- O debounce do resize chamava `setTimeout` sem o `this` da janela (o Firefox recusava).
- A célula do xterm era medida antes do primeiro desenho e sobrava uma faixa preta; agora é remedida a cada desenho.
- O fluxo anunciava cols/rows do tile do layout em vez do PTY fixado.

### Armadilhas

- No fork, a fixação vive só em memória: não sobrevive a restart do servidor do herdr. Resize só de layout não emite
  `pane.updated`.
- O tamanho do herdr é um só por sessão (spike na 0.8.2): vários clientes anexados não dão vários tamanhos, por isso o
  fork.
- `.canvas-resize-cursor` forçava `nwse-resize`; agora lê `--canvas-resize-cursor`.
- A colisão de nome no herdr só considera os terminais registrados no canvas, não outros agentes da sessão.

## 6.19.0 — 2026-11-07

Custo dos agentes no auto mode com o hook do rtk (issue #60): quando várias Bash vão na mesma resposta, o hook do rtk
reescreve o comando depois do veredito do classificador e todas voltam negadas, cada uma custando um turno a mais com o
contexto inteiro. Medido nas transcrições: 63 recusas em duas redações.

### Guard orienta uma Bash por resposta (#60)

- `src/lib/guard-hook.ts`: no PostToolUse, o guard lê o fim do transcript; achando um `tool_result` negado com "gave no
  verdict … changed by a hook" (ou "another call in this response was changed by a hook"), injeta uma orientação curta
  (uma Bash por resposta, ou `rtk <cmd>` já reescrito), **uma vez por sessão**. A orientação vence os avisos de contexto
  sem consumir o estado deles.
- Cartões `reference/loop/roles/*.md` ganham a linha "Bash e rtk"; `reference/loop/tokens.md` ganha a seção
  "Reescrita do rtk no auto mode".
- Página Consumo: o texto separa a coluna "Reescrita depois de pausa" (cache regravado após mais de 1 h parado) da
  reescrita do rtk.
- Teste novo `guard-rtk-reescrita` (8 casos: primeira e segunda da sessão, outra sessão, sem o texto, sem `is_error`,
  "no verdict" sem hook, as duas redações).

### Armadilhas

- A chamada negada **não dispara nenhum hook** (nem PreToolUse completo nem PostToolUse): o resultado existe só no
  transcript. Por isso o guard o lê de lá, na próxima chamada que conclui.
- O `hades usage` não mede esse custo: a coluna "reescrita" é outra coisa. O custo do rtk aparece só como turnos extras.

## 6.18.0 — 2026-11-06

Custo dos agentes, última onda: o `SKILL.md`, carregado inteiro em cada `/hades`, cai de 51,4 KB para 19,3 KB (issue
#61). Movimento de texto, sem reescrita: toda linha do original está no `SKILL.md` novo ou num arquivo de `reference/`,
aberto sob demanda. Medido antes: o primeiro turno de uma sessão aberta com `/hades` ficava em ≈ 96k tokens, contra
≈ 74k–86k sem ele.

### SKILL.md enxuto (#61)

- A Parte I (ambiente local: regras duras, onde fica cada coisa, fases 0–8) vai para `reference/env.md`; no `SKILL.md`
  ficam os 8 invariantes do ambiente, uma linha cada.
- "Pedidos típicos do dono" vai inteira para `reference/pedidos.md`. **Armadilha:** quem evolui a skill acrescenta o
  pedido lá (`evolving.md` e o template de brief já apontam), não no `SKILL.md`.
- "Onde fica" e "Defaults" do loop vão para `reference/loop/onde-fica.md` e `reference/loop/defaults.md`; os predicados
  da máquina de estados vão para `reference/loop/collector.md`.
- O `SKILL.md` ganha um mapa de referências e fica com termos, tabela canônica do `/hades`, invariantes, máquina de
  estados, precedência e escalonamento.
- Teto: o teste `skill-teto` (20480 bytes) entra na regressão do `check`. Sobram ~1,1 KB; o que for novo vai para
  `reference/`.
- A página Documentação lista `pedidos.md` e `env.md` em "Visão geral".

### Correção

- `commands/hades.md` mandava ler o `SKILL.md` também no agente `--orchestrated`, que assim carregava a skill inteira
  e depois o cartão. Agora o agente alocado lê só o cartão do papel, o brief e os trechos de `reference/loop/` que o
  cartão indica.

## 6.17.0 — 2026-11-06

Custo dos agentes, quarta onda: o orquestrador acompanha os agentes por evento e por status em vez de ler pane, e cada
despertar junta os eventos que chegam juntos (issue #63). A medida veio antes da mudança: em 30 dias, os turnos de
acompanhamento do orquestrador foram 5,4% dos turnos e 4,2% do custo (US$ 62 de US$ 1.477), com contexto médio de 265k,
maior que o dos turnos de decisão (237k), porque cada despertar relê tudo. O ganho possível é pequeno; a regra de
classificação é conservadora, então o número é piso.

### Acompanhamento barato do orquestrador (#63)

- `hades wait agents --any`: espera o primeiro evento de qualquer agente do orquestrador e junta os que chegam juntos
  num despertar só (`AGENTS <n>` + uma linha por evento); `HADES_ORCH_WAKE_MIN_S` (30 s) é o intervalo mínimo entre
  despertares.
- `hades agent status --compact`: uma linha por agente (herdr, fase, último evento, PR, contexto, custo), sem consultar
  o GitHub.
- Consumo e `hades usage` separam, no orquestrador, os turnos de acompanhamento dos de decisão. O cache do usage passou
  à v5.
- Cartões do orquestrador: acompanhar por evento, pane do herdr só para diagnóstico (com teto de linhas), cada despertar
  relê o contexto inteiro.

### Correção

- A CI da 6.16.0 ficou vermelha: o `hades doctor` sem instalação do Hades (o caso do runner) saía com rc=1 e stdout
  vazio, e o `--json` não parseava. Agora relata o item `instalacao`, ainda roda `settings-padrao` e imprime o resultado.

## 6.16.0 — 2026-11-06

Custo dos agentes, terceira onda: o doctor aponta o padrão caro herdado do `settings.json` (issue #67) e o Consumo mostra
quando um agente rodou num modelo diferente do configurado para o papel, com o custo da diferença (issue #64). Na
auditoria que motivou a #64, 36 de 37 sessões de recruta rodaram em Opus com `HADES_MODEL_IMPL` em Sonnet, por uma
semana, sem ninguém perceber.

### Padrão herdado do settings.json (#67)

- `hades doctor` ganha a linha `settings-padrao`: avisa `effortLevel` global `xhigh`/`max`, modelo padrão com janela
  `[1m]` (que deixa os tetos `HADES_CTX_CAP_*` só como aviso), chave de `modelSettings` que não casa com nenhum id de
  modelo das sessões recentes e padrão global mais caro que todos os `HADES_MODEL_*`/`HADES_EFFORT_*`. Só avisa; não
  grava no `settings.json`. Arquivo ausente ou ilegível vira aviso, nunca quebra o doctor.
- Configurações → Modelos por papel mostra o padrão herdado (modelo e esforço) e quem herda (sessões interativas,
  agentes sem flags, subagentes), só leitura.

### Modelo real × configurado (#64)

- `hades usage` e a página Consumo leem o `message.model` das sessões principais de cada agente registrado e comparam
  com o `HADES_MODEL_<PAPEL>`: coluna com o modelo real e, na divergência, `DIVERGE de X: +US$ N` (custo real menos o
  custo no modelo configurado, sobre os mesmos tokens). O esforço entra só quando a transcrição o registra, sem custo.
- O watch emite `MODEL-MISMATCH <agente> <real> <configurado>` no primeiro turno divergente, uma vez por sessão, e o nó
  do agente no Argos ganha o indicador `model`.
- Sessão iniciada depois da escalada registrada (`escalatedAt`, `HADES_MODEL_ESCALATE`) não conta; subagentes ficam fora.
- Interno: tabela de preço única em `src/lib/price.ts`; a ordem de custo do doctor deriva dela, em vez de uma cópia.
- Armadilhas: escrita de cache conta a 1,25× (o TTL de 1 h não é separado); apelido de família (`sonnet`) resolve para a
  versão mais nova da tabela e modelo fora da tabela não é comparado.

## 6.15.0 — 2026-11-06

Custo dos agentes, segunda onda: o orquestrador do canvas cria as próprias notas (issue #50) e o agente que conclui
deixa de ficar vivo para ser reaproveitado (issue #62). Nas medições de uma semana, sessões de Opus reaproveitadas
chegaram a 70–131 turnos e 146k–221k de contexto médio; do meio para o fim, cada turno custava de 2 a 4 vezes o do início.

### Notas criadas pelo orquestrador (#50)

- `hades canvas note new <nome> [--title t] [--text t] [--link-to <recruta>]…`: nó `note` ligado ao orquestrador e aos
  recrutas citados (mesmas recusas do `connect`), num lote só pelo `commit`; depois o arquivo com revisão nula e o título.
  Sem `--text`, lê a entrada padrão só quando ela não é o teclado.
- `hades canvas recruit --new-note <nome>`: o recruta nasce com a nota de andamento (`# Andamento: <recruta>`) ligada a
  ele e ao orquestrador, citada no primeiro prompt. As instruções de gerente passam a usar os dois.
- Códigos novos: `recruit_note_exists` e `canvas_note_file_exists` (nome que já é arquivo, ainda que órfão, é recusado
  para não sobrescrever).
- Armadilha: a nota nasce **acima** do orquestrador, na grade espelhada do `recruit`, porque as fileiras de baixo são
  dos recrutas; o arquivo só é gravado depois do nó, porque a rota confere o vínculo no documento.

### Fechar o agente ao concluir (#62)

- **Fechamento automático**: depois do `DONE`, o watch fecha a sessão quando o herdr mostra `idle`/`done` e, nos modos
  com PR, o head da PR é o último commit da worktree; a auditoria de git e o Cerberus vêm do `closeAgent`, agora o
  caminho único do `agent done` e do watch. Eventos: `DISMISSED <agente> fechado ao concluir`, `DISMISS-HELD <agente>
  <motivo>` (herdr-working|blocked|fora, sem-pr, pr-head-diferente, auditoria, cerberus…) e `DISMISS-READY` com
  `HADES_ORCH_AUTO_DISMISS=0`. Registro vai a encerrado com `closedOnDone`; o nó do Argos ganha o chip "fechado".
- **Não reaproveitar**: `agent resume` e `canvas recruit --cwd` avisam (não recusam) quando a sessão foi encerrada ao
  concluir; a correção abre agente novo na mesma worktree.
- **Compactar antes do teto**: o aviso de contexto do hook sugere `/compact` a partir de `HADES_CTX_COMPACT_AT` (150000),
  uma vez por sessão.
- **Consumo**: `hades usage` e a página separam unidades reaproveitadas das novas (sessões, turnos e custo).
- Defeito achado por teste: o fechamento gravava o registro no caminho do projeto, não no da unidade `_skill`.
- Fica para depois: recruta do canvas não está no registro de agentes, então o watch não o fecha (só o aviso do recruit).
- Medido no caminho: a própria unidade (sonnet/high) estourou o teto de 160k três vezes e terminou em quatro sessões
  pelo `park`/`resume`, a cerca de 1,5× o p75 estimado; foi o primeiro uso real do `CTX-OVER` da 6.14.0.

## 6.14.0 — 2026-11-06

Custo dos agentes, primeira onda: o recruta do canvas passa a usar o modelo e o esforço do papel e a abrir a PR com
assignee, labels e reviewers das Configurações (issues #57 e #49), e o teto de contexto por papel deixa de ser só uma
instrução (issue #58). Na auditoria de 05/11, 36 de 37 recrutas rodaram no modelo e esforço mais caros da máquina, e
agentes de impl chegaram a 490k de contexto com teto de 200k.

### Recruta com o modelo, o esforço e a PR das Configurações (#57, #49)

- **Modelo e esforço**: `canvas recruit` (e a criação de terminal pelo Argos) aplica `HADES_MODEL_<PAPEL>` /
  `HADES_EFFORT_<PAPEL>` como default, pelo mesmo leitor do `agent new` (`roleModelDefaults`). Precedência: flag > predefinição
  ou papel do Argos > Configurações > `settings.json`. Valor inválido nas Configurações é ignorado com aviso, sem derrubar a
  criação, e só vale para o que o agente aceita. Recruta sem modelo resolvido: o `recruit` avisa que vai herdar o
  `settings.json`, e o nó mostra `modelo · esforço` ou "herda settings.json".
- **PR pronta**: `src/lib/brief-pr.ts` é o render único do bloco (assignee, labels, reviewers); o `agent new` o usa pelo token
  `{{PR_PRONTA}}` do brief-template e o `canvas recruit` o põe no primeiro prompt quando o papel abre PR (impl, spec,
  consolidate). As instruções de gerente do canvas citam `hades consolidate ready <N> --post`.
- Fica para depois: evento `PR-OPEN` no watch sem assignee e um campo "abre PR" no papel do Argos.

### Teto de contexto que segura (#58)

- **Papel certo**: o `roleOf` escolhe o registro de worktree mais específica (por componente de caminho, não `startsWith`);
  sessão na worktree de agente encerrado mantém o papel; recruta do canvas sem registro usa o papel do Argos. O registro
  (`agent new|adopt|review|skill-new`) recusa worktree que contém outras (`WORKTREE_CONTAINS_AGENTS`): um registro na
  pasta-mãe das worktrees tomava o papel e o handoff de todos os recrutas.
- **Teto do recruta**: `ctxCapOf` é o único ponto que traduz papel em teto; chave própria `HADES_CTX_CAP_<SLUG>` vence, e o
  recruta sem ela usa a chave nova `HADES_CTX_CAP_RECRUIT` (200000), em vez do teto interativo, que só avisa.
- **Conferência fora do agente**: o `hades watch` emite `CTX-OVER <agente> <usado>k <teto>k` uma vez por limiar cruzado
  (`HADES_CTX_REWARN`), no lugar de `CONTEXT`; o orquestrador estaciona com `hades agent park`. O nó do agente no Argos
  ganha `ctxOver` e o chip "context".
- **Consumo**: `hades usage` e a página destacam as sessões principais acima do teto do papel (`ctxCap`, `overCap`, cartão
  "Sessões acima do teto"); dentro do teto o relatório não muda. O `classify` do usage também passa a usar a worktree mais
  específica.
- Fica para depois: `journal.ts` (`agentOfCwd`) ainda resolve cwd → agente por conta própria.

## 6.13.0 — 2026-11-05

Terminais do herdr no Argos: cursor, zoom do texto e fechar (issue #48, PR #51); e o canvas que deixava de gravar com
mais de uma aba do painel aberta (issue #52, PR #53).

### Terminais: cursor, zoom do texto e fechar (#51)

- **Cursor estimado na caixa do Claude Code**: o herdr (0.8.2 e 0.9.5, conferido no schema da API) não entrega a posição do
  cursor, e o `guessCursor` punha o cursor no fim da última linha com texto, que no Claude Code é o rodapé ("auto mode on…").
  Agora `promptBoxCursor` reconhece a caixa (linha `❯` entre duas réguas `─`) e põe o cursor no fim do que foi digitado; a
  sugestão esmaecida (SGR 2) da caixa vazia não conta. Descoberto: a premissa de que o Claude desenha o próprio cursor em
  vídeo inverso não vale mais (ele usa o cursor do terminal), então o vídeo inverso só decide dentro da caixa.
- **Zoom do texto** (`Ctrl+Alt+=` / `Ctrl+Alt+-` / `Ctrl+Alt+0`, também na paleta e no menu do nó): o herdr não muda colunas nem
  linhas de um pane, então o nó vai à proporção exata do quadro na escala seguinte (`ttyZoomSize`, passo 1,2×), sem a faixa
  vazia que o resize livre deixa. As teclas sobem ao canvas com o teclado no terminal. Resize real (colunas acompanhando o
  nó) segue fora: não há API de tamanho por pane nem fluxo de bytes na 0.9.5.
- **Fechar com conferência**: `ensureNodeRemoved` (o inverso de `ensureNodeSaved`) só termina com o nó fora do documento do
  servidor, relendo e reaplicando em 409. Medido no canvas real: o `terminal-fechar` encerrou o pane e o nó ficou no
  `canvas.json`.
- **Delete fecha o processo** num terminal vivo, pelo diálogo do `Ctrl+Alt+W`; só tirar o nó deixava o pane órfão.
- **Terminais encerrados**: `GET /api/argos/terminals/orphans` devolve `dead` (aditivo), conferido também a cada 30 s com a
  aba visível. O nó mostra "Processo encerrado" com "Remover do canvas", e um banner remove todos, ocultos inclusive: no
  canvas real 8 dos 9 nós ocultos com `Shift+H` eram terminais com o pane já morto.
- Testes: `argos-terminal-fechar.test.ts` (novo), `argos-terminal-orfaos.test.ts` e `term-cursor.test.ts`; golden do `/sw.js`
  com o hash novo da UI.

### Canvas com várias abas (#53)

- **Sintoma**: nota criada sumia no reload, terminal novo nascia "fora do canvas" ("Terminal criado, mas o nó não foi
  gravado") e terminal fechado continuava no canvas. No `panel.log`, 30 min sem `canvas gravado` nem `canvas recusado`,
  enquanto `nota gravada` e o input do herdr passavam: o `PUT /api/canvas` não chegava ao servidor.
- **Causa**: o painel é HTTP/1.1 e o navegador abre no máximo 6 conexões por servidor, somando as abas. Cada `EventSource`
  prende uma enquanto vive, e uma aba do Argos abre 3 (canvas, terminais, linha do tempo). Com 2 abas, o teto acaba e todo
  `fetch` fica na fila até o `AbortSignal.timeout` de 10 s (`TimeoutError`, código 23 no console). Medido num Firefox
  headless: 1 aba grava na hora; 4 abas, a ativa nem lê o canvas (9 conexões presas).
- **`ui/stream-logic.tsx`** (`window.PanelStream.open(url)`): fluxo SSE com a interface do `EventSource` que solta a conexão
  5 s depois de a aba esconder e religa ao voltar, com os mesmos ouvintes; solto, `readyState` é `CONNECTING` (ninguém cai
  para o polling por isso) e o `open` da religação dispara a conferência do canvas. O Argos (canvas, terminais, linha do
  tempo) e o terminal do herdr abrem por ele. Com a correção, 4 abas = 3 conexões (as da aba ativa) e nenhum timeout.
- **`beforeunload`** no Argos com edição do canvas que o servidor ainda não tem: o navegador pergunta antes de recarregar
  ou fechar (era assim que a nota sumia).
- A mensagem de `canvas_save_unreachable` aponta as abas abertas; a armadilha está em `reference/panel.md` §Armadilhas.
- Fora: o chat do Claude segue com `EventSource` direto (religa pelo `offset` da URL) e duas janelas visíveis lado a lado
  ainda somam conexões; resolver de vez pede uma conexão só para os fluxos (WebSocket ou multiplexação).
- Testes: `painel-stream.test.ts` (9 casos); goldens do `/sw.js` (hash novo da UI) e do drift do kit (arquivo novo).

## 6.12.1 — 2026-11-05

Terminal do canvas com o servidor do herdr parado (issue #46).

- **Subida por demanda**: depois de um reboot só o `hds-panel` sobe, e criar terminal no Argos falhava em `workspace create`
  com o genérico "o herdr recusou". Agora, se o servidor não responde, o painel sobe o `herdr server` (uma subida por vez,
  pedidos simultâneos esperam a mesma; teto de 15 s até `api snapshot` responder) e repete a criação uma vez. Só ao criar
  terminal, nunca no boot do painel.
- **Erro com código próprio**: `herdr-server-down` (503), em toda rota que passa pelo `herdrCall`, com "o servidor do herdr não
  está rodando: abra o `herdr` e tente de novo" na tela, quando a subida falha ou estoura o teto. `herdr-failed` segue para o resto.
- **Doctor**: aviso `herdr-servidor` (grupo Painel) com o painel ativo e o socket do herdr mudo.
- Armadilhas: sob systemd o `detached` sozinho não basta, porque o `KillMode=control-group` do `hds-panel` mataria o servidor
  ao reiniciar o painel; por isso `systemd-run --user` (unit transitória), com o `detached` de reserva. O PATH do gerenciador
  de usuário não tem `~/.local/bin` nem o node do nvm, e os panes herdam o ambiente do servidor: o `systemd-run` leva o PATH
  do painel e o caminho absoluto do `herdr`. Não medido com o herdr real (provado com fakes).
- Testes: o `notify-lock` herdava o filtro de eventos da instância (`HADES_NOTIFY_EV_AGENT=off` no `config.env`, que o
  `skill-release` carrega) e falhava as quatro asserções de envio; agora tira as `HADES_NOTIFY_EV_*` do ambiente. Golden do
  `/sw.js` com o hash novo da UI (`terminal-create.tsx`).

## 6.12.0 — 2026-11-04

Sub-rede do firewall é da instância e o padrão sai do núcleo; `panel.units[]` do plugin com `<HU>`; túnel do front desligado
por padrão (issues #41 e #42).

- **Sub-rede da instância**: `fw_test`/`fw_cmd` (`kit/lib-checks.sh`) e o onboarding usam `HADES_DOCTOR_SUBNET` (ou a rede
  `${HPROJ}_default`) e o gateway derivado dela, em vez de `172.18.0.0/16`/`172.18.0.1` fixos: numa instância a mais, o teste
  de firewall e o comando sugerido eram os da original. Sem sub-rede, não há checagem. O padrão de `HADES_DOCTOR_SUBNET`
  sai do `kit/config.tsv` do núcleo (fica vazio) e passa a ser do plugin, que o grava por instância.
- **`<HU>` em `panel.units[]`**: o manifesto do plugin declara `<HU>-x`, e o núcleo expande para o prefixo da instância
  (`hds-x` na original, `hds_<id>-x` nas outras). Antes, nome literal fazia a instância a mais listar as units da original.
  Plugin que passa a usar `<HU>` exige `core >=6.12`: num núcleo anterior as units dele somem da página Logs.
- **Túnel do front desligado por padrão** (`HADES_RUN_TUNNEL=0`): o primeiro "Subir" numa máquina nova publicava o front num
  túnel público sem o dono ter escolhido. O onboarding (Acesso remoto) e as Configurações ligam. Armadilha: o `config.env` não
  guarda valor igual ao padrão, então quem dependia do padrão antigo (1) sem ter gravado a chave passa a subir sem túnel;
  para manter, grave `HADES_RUN_TUNNEL=1` depois de reinstalar.
- **Armadilha de teste**: sem sub-rede, o texto genérico do `fw_cmd` citava "ufw" também no macOS. O teste do launchd só
  passava na máquina que tinha a rede docker da instância (o `fw_subnet` a encontrava); a CI, sem rede, pegou. O texto genérico
  agora segue a plataforma, e um teste cobre a instância sem rede.

## 6.11.1 — 2026-11-04

Jobs e chat do painel com o HOME da instância (issue #38); instalação limpa e doctor numa instância a mais (issues #39 e
#40). As três saíram da validação de um plugin numa Hades instalada do zero, numa instância isolada ao lado da original.

- **Ambiente do job**: as units transitórias dos jobs e do chat do painel recebiam só `PATH`, `HADES_WT` e `HADES_DATA`, e
  herdavam o HOME do gerenciador de serviço do usuário, não o do painel. Numa instância com outro HOME, o job lia e gravava
  o `~` real e via a instância errada. Agora `instanceEnv` (`src/lib/systemd-run-env.ts`) leva o HOME do painel e as
  variáveis da instância (`HADES_ID`, `HU`, `HSLICE`, `HPROJ`); `hades svc run` leva o HOME de quem o rodou (`--env HOME=`
  vence). O golden `systemd-contrato.txt` ganha essas variáveis. Ainda sem o HOME: as units persistentes (painel,
  notificações, limpeza) e o keepalive do túnel, porque corrigir reescreve as units da instância original.
- **Instalação limpa**: o fetch da base no install usa a credencial do `gh` (`gh auth git-credential`, depois dos helpers do
  dono, sem prompt), e a falha vira aviso com o motivo em vez de `fatal:`. `hades doctor` fora do `env.sh` resolve a
  instância pelo diretório, como o `hades instance`, e roda o `doctor.sh` dela.
- **Doctor numa instância a mais**: processo é da instância pelo cgroup ou unit, pelo `$D` no argv ou pelo `HADES_DATA` no
  ambiente, então o painel em primeiro plano não aparece como "porta ocupada por outro processo"; as portas de outra
  instância registrada deixam de ser acusadas. O slice é conferido carregado (`systemctl --user show`): erro se não está,
  aviso se o `MemoryMax` difere de `HADES_SLICE_MAX`. Armadilha: com `SKIP_SYSTEMD=1` o slice não carrega e agora o doctor
  acusa erro, que é o caso real (serviços sem teto de memória).

## 6.11.0 — 2026-11-04

Modo de loop de revisão (issue #26); rolagem do terminal do nó do Argos e limite medido do resize (issue #33).

- **`hades review --loop`** (`[--every 30m] [--author <login> | --pr N…] [--max N] [--deep] [--until <hora>|--rounds N]
  [--note <nota>]`): processo próprio que, a cada rodada, revisa só as PRs do escopo de head novo ou nunca revisadas. O estado
  por PR (último head, data, link, achados abertos) fica na raiz de trabalho da Hades, e achado já reportado e ainda aberto
  não é postado de novo (identidade = código|arquivo). Duas rodadas nunca se sobrepõem (`flock` do processo), a PR com lock
  de outra sessão é pulada com motivo e as revisões passam pela fila de reviews (`HADES_REVIEW_MAX_PARALLEL`). Pausa e avisa
  uma vez quando a janela de 5 h ou a semanal passa do limiar (`HADES_REVIEW_LOOP_*`). Para por `--until`/`--rounds`, por
  `hades review loop stop` e sozinho com escopo vazio. Revisores entram no canvas ligados ao orquestrador do loop, e o
  resumo da rodada vai a uma nota; `notify` só com bloqueante novo. Painel: `GET /api/reviews/loop` e card "Loop de
  revisão" com status e % das janelas por rodada. Armadilhas: o serializador do painel imprime `undefined` literal (o
  status passa por normalização); o loop não retira do GitHub achado já postado; o revisor é um `claude -p` filho, então
  o nó dele aparece "fora do herdr".
- **Rolagem do nó do Argos**: o xterm do nó (sem scrollback) convertia a roda em setas e cancelava o evento, e nem o nó nem
  o canvas a recebiam. Agora a roda e o arrasto de um dedo rolam o histórico por `/api/herdr/scrollback`, Ctrl/Alt+roda
  volta ao canvas e, em tela alternativa, o nó avisa que não há histórico em vez de mandar setas ao agente.
- **Resize do nó, fechado como limite medido**: um cliente herdr anexado muda cols×rows de todos os panes da sessão (não
  há tamanho por pane), vence o último que anexou ou redimensionou, e o terminal criado no canvas também é pane do herdr.
  Os nós seguem só com escala. O cursor do nó segue estimado: o herdr 0.8.2 não entrega a posição, e o Claude Code usa
  o cursor real do terminal, sem vídeo reverso.
- **Teste instável do rig** (`plugin.test.ts`, prazo de cada processo): falhou na CI da 6.9.0 e da 6.11.0 com "o neto não
  ficou vivo". O SIGTERM do `timeout` chega ao grupo junto com a morte do sh, mas o neto só morre quando é escalonado, e em
  CI carregada isso passava do instante em que o rc era gravado. O teste agora espera a morte do neto por até 2 s (ele viveria
  60 s), e a asserção segue exigindo que ele morra.

## 6.10.0 — 2026-11-04

Aba Workspaces do Herdr com terminal de verdade, no desktop e em tela cheia no celular (issue #32).

- **Terminal na aba Workspaces**: o pane escolhido aparece num xterm com cores, cursor e teclado direto, pelo mesmo caminho do
  nó do Argos (`NodeTty` reaproveitado sem mudança, quadro por `/api/herdr/stream`, entrada por `/api/herdr/input` numa fila de
  um envio por vez). Metadados e ações ficam ao redor. A saída de 200 linhas virou alternativa recolhida (copiar, leitor de
  tela), que abre sozinha quando o fluxo cai e só faz polling de 3 s aberta. Fluxo caído ou pane encerrado: aviso e
  **Reconectar**. O tamanho do pane não muda (só escala): no herdr o tamanho é da sessão inteira.
- **Celular**: tela cheia com a barra de teclas, o teclado virtual e a acentuação do terminal; metadados, prompt e ações numa
  gaveta. Defeitos registrados antes da correção: sem barra de teclas (a página não passava `apiRef`), digitação só pelo
  campo de texto, rolagem aninhada. Armadilha: o `NodeTty` tirava o foco quando o toque caía na barra de teclas e só focava
  fora do gesto (o iOS não abre o teclado assim); agora o toque foca dentro do gesto e a barra não rouba o foco. Toque e
  teclado virtual foram verificados por código e teste, não num aparelho.

## 6.9.1 — 2026-11-04

Tipos de notificação com nome claro e CI separado de review (issue #28); câmera do Argos só se move por gesto ou seleção do
dono (issue #31).

- **Tipos de notificação**: `gate` passa a se chamar "Gate, build ou teste falhou" e cobre os três; `test` (o botão de envio)
  sai da lista desligável. CI vermelho ganha o tipo `ci` (`HADES_NOTIFY_EV_CI`), cujo padrão segue o canal de `pr`, então um
  `HADES_NOTIFY_EV_PR=off` existente continua silenciando o CI sem migração. `prProblems()` vira função pura e a fonte `prs`
  só roda com `pr` ou `ci` ligado. `status --json` ganha `events[{event,label,channels,pinnedByEnv}]` e a tela de
  Configurações mostra como fixo o tipo exportado no ambiente. Um teste varre `src/` e exige que todo emissor use evento do
  catálogo. Armadilha: o `env.sh` exporta o `config.env` em todo processo, então só conta como fixo o export com valor
  diferente do `config.env`.
- **Câmera do Argos**: segurar o Espaço arma o pan, e soltá-lo sem arrastar selecionava o nó focado, levando a câmera até
  ele. Só o arrasto com ponteiro marcava o Espaço como usado; zoom por roda e teclas de câmera, não. Agora esses gestos
  também consomem o Espaço. A seleção ganha origem (`pointer`/`key`/`command`/`sync`, e `sync` nunca move a câmera), e
  `localStorage["argos.cameraDebug"]` registra a origem de cada movimento. A causa foi medida no motor com DOM falso, sem
  reprodução em navegador: se a câmera ainda saltar sem o Espaço, ligar `argos.cameraDebug` e ler o console.

## 6.9.0 — 2026-11-04

Preferências para desligar as travas de confirmação (issue #22); Reviews sem teto de PRs selecionadas (issue #27).

- **Travas de confirmação** (`HADES_CONFIRM_HOLD`, `HADES_CONFIRM_TYPED`, padrão ligadas, grupo Painel): desligam o "segurar
  para confirmar" e o "digitar o nome para confirmar" das ações destrutivas, sem recarregar. A checagem do nome é do servidor,
  lida do `config.env` a cada ação, e valor ausente ou inválido mantém a trava. Pelo acesso remoto as duas chaves não mudam
  (`remoteConfigRefusal`): quem entra pelo túnel não desliga a trava que o protege. Armadilha: com digitar desligado o Argos
  ainda envia `confirm` vazio, e o servidor só o ignora com a preferência desligada.
- **Reviews sem teto**: o painel marca quantas PRs se quiser, com "marcar todas" (página visível do seletor) e "limpar", e
  mostra "N selecionadas · até P em paralelo"; `--max` não tem máximo. O único limite é `HADES_REVIEW_MAX_PARALLEL`, e as
  excedentes esperam na fila. `/api/reviews` ganha `maxParallel`.
- **Armadilha de golden**: mudança em `kit/panel/ui` ou numa rota lida pelo legado exige regravar só o golden do painel
  (`LEGADO_REGRAVA=1 bun test ./painel-legado.test.ts`). Sem o caminho, o filtro casa outros arquivos e regrava goldens alheios.

## 6.8.0 — 2026-11-04

`hades canvas join` e `leave` (issue #25); cursor do terminal do Argos (issue #20); eco da digitação no Argos (issue #21).

- **`hades canvas join` e `leave`**: trazem para o Argos um pane do herdr criado fora dele, e tiram de volta, sem reiniciar o
  processo. Identidade por `paneKey`: pane que já é nó não duplica, e nó `agent` do mesmo pane é fundido. Terminal do registro volta
  com nome, agente, modelo, esforço, papel e orquestrador, e `recruit` funciona em seguida. Fora do herdr recusa com instrução
  (`canvas_join_outside_herdr`). Armadilha: orquestrador órfão só volta como orquestrador se estiver em `terminals.json`.
- **Remoção em massa**: a confirmação do gesto de apagar vale até o servidor aceitar (`createSaveMeta`), inclusive em retry depois de
  409. O 422 `canvas_mass_removal` tem texto próprio na tela e não gera reenvio a cada `SAVE_RETRY_MS`.
- **Cursor no nó do Argos**: com foco, bloco piscando; sem foco, contorno, como no `PtyTerminal`. O herdr 0.8.2 não entrega o cursor
  no quadro e `screenOf` abre com `?25l`, então a posição é **estimada** pelo fim do texto (`guessCursor`).
- **Eco da entrada**: `herdr-stream.ts` abre uma janela de releituras curtas (15 e 30 ms) depois do `nudge`, só no pane que recebeu
  a tecla, e quadro igual não dobra o intervalo nessa janela. Medido do POST ao quadro no SSE: p90 de 96 para 10 ms com 1 pane e de
  102 para 4 ms com 8 panes. O navegador não era o gargalo (tecla até o POST 0–1 ms, `term.write` 0–2 ms). A página Terminal segue
  mais rápida (0,4 ms), por usar PTY por WebSocket: o herdr não dá fluxo de bytes.

## 6.7.1 — 2026-11-04

Nós do canvas não somem mais sem ação do dono (issue #23) e um pane do herdr é um nó só (issue #24).

- **Remoção com guarda**: `mergeWithGraph` só tira nó vivo com grafo confiável, e `createAbsenceTracker` exige duas leituras
  seguidas sem o nó; grafo vazio ou parcial não remove nada. Gravação que levaria notas ou terminais em massa (5 ou mais, e mais
  da metade dos nós do usuário) é recusada com 422 `canvas_mass_removal`, salvo pelo gesto de apagar, que manda
  `X-Canvas-Confirm-Removal: 1`.
- **Rastro**: cada remoção vai ao `panel.log` (`canvas remoção`) com causa, tamanho do grafo, versão sobrescrita e ids, e a versão
  sobrescrita fica em `$D/canvas-trash/` (20 por canvas). O evento fica no `panel.log`, e não no diário por agente, porque não
  tem agente.
- **Um pane, um nó** (`paneKey`, `claimed`/`duplicates`): grafo lido no meio da criação do terminal, `agent adopt` de pane que já
  é nó e `reassign` mantêm o mesmo nó.
- **Armadilha medida**: `note` e `terminal` não são tipos vivos, então `mergeWithGraph` não explica a perda deles. Numa instalação
  real, notas, terminais e arestas saíram num único `PUT` do cliente com a `rev` certa (30 → 22 nós, 10 → 0 arestas), sem 409. A
  causa exata desse cliente segue sem prova, por falta de cópia do documento; o `canvas-trash/` e o `panel.log` fecham a causa se
  acontecer de novo.
- **Suíte**: `cerberus-vigilia-legado` falhou uma vez na regressão completa (`sem valor gravado para '27:auditoria ["capturas"]'`)
  e passou sozinho 3 de 3 e na rodada seguinte: a chave do golden usa um contador sequencial, sensível à ordem.

## 6.7.0 — 2026-11-04

Minos, o publicador do acompanhamento da orquestração (issue #15); fila de revisões com teto (issue #14); permissão do
Argos respondível quando o aviso não nomeia a ferramenta (issue #16); roda em tela alternativa na página Terminal (issue #18).

- **Minos** (`reference/minos.md`): `hades minos list|publish|link|open`. O modelo `orquestracao` declara um contrato JSON
  (validado na fronteira) montado do plano, dos agentes, das PRs, das escalações e do consumo do Moirai; a página é
  estática, gerada no servidor com tudo escapado, nos temas claro e escuro, e a mesma serve ao `--html` offline. Publicar
  num Artifact é da sessão do Claude: o `publish` prepara a página e os dados e o `link` grava o endereço estável
  (só `https://claude.ai/.../artifact/<id>`). O Cerberus roda antes de gerar qualquer saída (varredura em memória e o
  momento `artefato`); recusa sai 1 sem gravar nada. Botão **Publicar** na página Orquestração
  (`POST /api/orchestration/publish`). A **Página do time** é recurso opcional próprio no onboarding (`@minos`,
  `HADES_MINOS_TEAM=0` por padrão): como passo de "Contas e loop" ela deixaria a feature pendente para sempre.
- **Fila de revisões** (`reference/loop/review.md` §6): `hades review`, do painel ou do terminal, respeita
  `HADES_REVIEW_MAX_PARALLEL` (padrão 4) por um semáforo de `flock(2)` em `reviews/slots/slot-<i>.lock`, sem processo
  central; o kernel solta a vaga se a revisão morrer. O excedente espera em `fila` sem falhar, e o prazo de 300 s do
  `fetch` e do `worktree add` só corre depois da admissão. Cada job mostra a fase (fila, fetch, checkout, revisão,
  publicação) no log, em Revisões › Em curso e na página de jobs. Motivo: 25 revisões disparadas juntas derrubaram 23 por
  prazo de checkout (load 62, 8 GB de swap). Medido e não adotado: checkout sparse ou `--no-checkout` pelo diff (108 ms
  contra 7–22 ms num repo pequeno) tira do review o código vizinho que ele lê.
- **Permissão no Argos:** quando o aviso do Claude Code não traz "use <Ferramenta>", o pedido chegava com `tool: null` e
  Aprovar/Negar ficavam desabilitados. A ferramenta agora vem do último `tool_pre` sem `tool_post` antes do pedido (zera em
  `stop`, `prompt` e no fim do agente); o texto "use X" continua vencendo. Com os botões desabilitados, o diálogo sempre
  diz o motivo e manda ao terminal do agente; herdr fora de `blocked` cita o estado.
- **Roda na página Terminal:** com o `herdr-client` em tela alternativa, a roda anda pelo histórico do pane em foco da
  sessão (`/api/herdr/scrollback`, mesma regra e mesma volta ao vivo do nó do Argos, agora uma só em `term-logic.tsx`);
  sem pane (`claude`, shell), a roda segue ao programa e uma dica de PageUp/PageDown aparece uma vez. `/api/term` ganha
  `herdrSession`.
- Armadilhas: o ambiente do PTY é o do painel, então `HERDR_PANE_ID` ali não identifica pane (o pane vem do foco da sessão
  do herdr; dois clientes na mesma sessão veem o mesmo); o `Notification` do hook não traz a ferramenta em campo
  estruturado; o ResizeObserver dispara sem mudança de tamanho, por isso o refit só descarta o histórico com cols/rows
  novos; `readonly x` no construtor quebra o `erasableSyntaxOnly`; registro com hora real (`faseDesde`) precisa sair da
  comparação dos goldens, como `started`; a Vigília lê todo caminho do parágrafo "não toque" do brief como proibido, então
  arquivo compartilhado liberado para acréscimo vai em parágrafo próprio.
- Consolidação: as quatro unidades rodaram em paralelo pelo `skill-new`; gate único no fim com o mesmo roteiro do CI
  (`tsc` dos dois configs, guarda e suíte: 5952 passam). Os 4 testes de `notify-lock` falham igual na 6.6.0 nesta máquina
  (causa ainda não investigada): anterior, não regressão.

## 6.6.0 — 2026-11-04

Resumidores por stack entregues pelo rtk (issue #10) e terminais do painel com acentuação e rolagem corretas (issues #12 e #13).

- **Resumidores do rtk** (`reference/rtk.md`): `stacks/{node-nx,pnpm-next,rust-cargo,tauri}/rtk-filters.toml` mais os
  filtros do plugin (`rtk.filters` no perfil, validado no `project validate`) viram `.rtk/filters.toml` em cada worktree
  (install, `agent new`, `skill-new`), no `.git/info/exclude`; nunca tocam `~/.config/rtk/*`. `HADES_RTK_FILTERS=auto|off`,
  `HADES_RTK_OFF_STACKS` e `HADES_RTK_OFF_FILTERS` no grupo "Resumidores (rtk)" das Configurações; `hades rtk status|apply`.
  O rtk entra como `warn` no registro de dependências; o `doctor` mostra estado, confiança e recomenda política (sem gravar).
- **Corte sempre anunciado:** os filtros entregues só descartam por mecanismo que o rtk anuncia (`head_lines`/`tail_lines`,
  `... (N lines omitted)` e a saída inteira no `rtk recall`); `strip_lines_matching` só tira linha em branco. Teste na
  regressão das stacks barra corte sem anúncio. `env.sh` aponta `RTK_RECALL_DB`/`RTK_TEE_DIR` para `$D/rtk/` (rotação pelo `clean`).
- **Só o dono muda a política:** o guard barra `HADES_RTK_*=`, `config set` dessas chaves e `rtk trust` vindos das
  ferramentas do agente; o painel remoto recusa as chaves. O agente vê mais com `rtk proxy <cmd>`. O install e a criação
  de agente rodam `rtk trust --yes` no worktree que geram (confia no conteúdo do plugin do projeto).
- **Terminal e Herdr:** tecla morta (`´ ~ ^` + letra) no Firefox chegava duplicada (`aaá`): o navegador manda keydown da
  letra base com a composição aberta e o xterm a tomava por tecla. `composeGate` segura a composição e entrega o
  caractere composto uma vez (`c3 a1` = `á`). O nó do Argos também ignora tecla com composição aberta.
- **Roda no nó de terminal do Argos:** pixels do trackpad somam pela altura de linha na tela (antes cada evento valia uma
  linha), rajadas não perdem passos, topo e fim presos, volta ao vivo; nó distante deixa a roda para o zoom do canvas.
- Armadilhas: rtk 1.x trocou o `[tee]` por `[retriever]`/`rtk recall`; filtro de projeto só vale depois de `rtk trust`
  (SHA-256 do arquivo); o TOML do rtk é só o fallback de comando sem handler próprio; o painel de teste serve a cópia
  instalada (reinstale para provar); Firefox sem monitor não pinta (prova por bytes do WebSocket).
- Pendente: medição de tokens com e sem filtros numa rodada real de gate (rtk ausente na máquina de desenvolvimento); roda
  em tela alternativa na página Terminal.

## 6.5.0 — 2026-11-04

Espera por processo no `hades wait` (issue #11), `agent resume` sem rótulo de papel (issue #9), Argos sem permissão
pendente de agente encerrado (issue #7) e a suíte estável na CI pública.

- **`hades wait proc <padrão>`**: espera até nenhum processo casar com o padrão (`pgrep -f`) e notifica `PROC <padrão>
  terminou`; o próprio wait e os seus ancestrais não contam; padrão vazio ou que casa com o próprio wait é recusado.
  Intervalo e prazo pelos `HADES_WAIT_EVERY`/`HADES_WAIT_MAX` de sempre.
- **Guard:** laço com `sleep` num comando em segundo plano passa a receber aviso (sem barrar) com o `hades wait`
  equivalente (`proc` para `pgrep`, `queue`, `ci`, `agent`); `HADES_POLL_GUARD=0` desliga também o aviso. A linha HOW cita
  o alvo novo.
- **`agent resume`** usa a fase do registro ou do cabeçalho `# Handoff — <u>, fase \`<f>\`` do `handoff.md`; sem ela, o
  prompt não cita fase e o registro não ganha `phase` (antes rotulava pelo papel, "fase impl"). `agent prompt --phase <f>`
  registra a fase desde o primeiro prompt.
- **Argos:** `agent done`, `park` e `skill-clean` gravam `orch agent.end` no diário, que encerra a pendência; registro
  `done`/`archived` ou pane fora do `herdr agent list` não mostra `pendingPermission`; aprovar ou negar sem pane responde
  409 `pane_gone`.
- **CI pública:** o teste do rig "morre com os netos" falhava no runner porque, em contêiner sem init que colha órfãos, o
  neto morto fica zumbi e `kill(pid, 0)` ainda responde; a checagem ignora o estado `Z` de `/proc/<pid>/stat`
  (reproduzido com `unshare -rpf --mount-proc`).
- Armadilhas: o golden `bun-loop2.json` guarda o texto do `resume`; mensagem de commit ou de merge com "hades wait …" é
  barrada pelo guard como espera em primeiro plano.

## 6.4.0 — 2026-11-04

Documentação revista com o Impeccable (critique, clarify, distill, typeset, quieter, polish, optimize, delight, document).

- **Página Documentação** do painel: linha 1.7, código inline com folga curta, código em título sem bloco cinza, 1ª coluna
  de tabela sem quebrar no meio da palavra; índice de documentos com rolagem própria (os tópicos ficam à vista) e, no
  celular, "Tópicos" mostrando o atual e o caminho escondido. Documento cortado em seções por `## ` com
  `content-visibility:auto` (o de 3.249 linhas não pinta tudo de uma vez); o salto ao tópico respeita
  `prefers-reduced-motion` e corrige a posição depois que as seções adiadas pintam. Botão "Copiar" nos blocos de código.
  `DESIGN.md` novo, com o sistema de design do painel.
- **Textos públicos:** README com os recursos no topo e menos ênfase (462 → 398 linhas); requisitos corrigidos (`rsync`
  saiu, o install copia em TypeScript; entram `bwrap` e `launchctl`); `CONTRIBUTING.md` novo, com o caminho único de
  contribuição; SECURITY e modelos de issue mais enxutos.
- **`reference/`** inteira: parágrafos densos e células longas viram listas, sem vocabulário de domínio nem número de PR
  de projeto, acentos corrigidos. Nenhuma seção renomeada; regras, comandos, chaves e caminhos conferidos token a token
  contra a versão anterior. O cartão do orquestrador mantém a lista do que nunca cede.
- Armadilhas: um agente commitou o relatório da própria pasta `.design-sync-reports/` (saiu no merge); a faixa de portas
  de teste das unidades (21270–21289) esgota com worktrees não limpas (`skill-clean`, ou `skill-new --port N`); o guard não
  barra um laço `while pgrep …; do sleep 5; done`.

## 6.3.0 — 2026-11-04

Consumo em % das janelas de 5 h e semanal (issue #4) e `hades watch` por orquestrador (issue #5).

- **Limites de uso: medir.** A fonte é o `rate_limits` do JSON que o Claude Code entrega ao `statusLine`
  (`five_hour`/`seven_day`, `used_percentage` e `resets_at`; só assinantes Pro/Max, depois da primeira resposta da sessão;
  documentação oficial lida com o Claude Code 2.1.317). `hades usage sample` é o comando do statusLine: grava a amostra em
  `~/.claude/hades/limits/samples.jsonl`, sem rede, e nunca quebra o status line. Ligar é passo do dono
  (`reference/limites.md`, inclusive encadeado com um statusLine existente); o doctor e o onboarding só apontam o passo.
- **Limites de uso: converter.** Calibração tokens → % por modelo e por janela, recalculada com o uso (nada fixo no código);
  abaixo de `HADES_LIMITS_MIN_INTERVALS` diz "sem calibração". `hades usage` ganha `% 5h` e `% semana` (estimadas, `~`) por
  papel, agente e dia e o % medido com a renovação; `hades moirai estimate` mostra a faixa p25–p75 em % de cada janela e
  "cabe na janela atual?".
- **Limites de uso: mostrar e avisar.** Painel → Consumo com o cartão "Janelas do plano" (% medido, renovação, idade da
  amostra; sem amostra, só como ligar a coleta), colunas estimadas por papel e agente, rota `GET /api/limits`; linha no painel
  lateral do agente no Argos. `hades watch` emite `LIMITE <5h|semana> <pct> renova <hora>` ao passar de
  `HADES_LIMITS_WARN_FIVE_PCT` (80) / `HADES_LIMITS_WARN_SEVEN_PCT` (90), uma vez por janela e renovação, para todo
  observador. O orquestrador compara o p75 do plano com o que resta da janela de 5 h antes de alocar em paralelo.
- **`hades watch` por orquestrador** (#5). Chamado de um pane do herdr, acompanha só os agentes cujo `orchestrator` é esse
  pane (sem `orchestrator`: todos); `--agent`/`--agents`, `--orchestrator <sessão:pane>` e `--all`. O "já visto" é por
  observador (`watch/by/<observador>/`), herdando o compartilhado na primeira passada: um watch não consome mais o evento
  do outro. `hades agent reassign-orchestrator <nome>…|--all` aponta os agentes para o pane atual quando o herdr reinicia.
- Armadilhas: a renovação oscila segundos entre leituras (≤2 min é a mesma janela); `claude -p` não aciona o statusLine;
  o id de pane tem `:` (`--orchestrator default:w1:p1` divide no primeiro). Pendente: o `notify` ainda não conhece `LIMITE`.

## 6.2.1 — 2026-11-04

Correções do `hades watch` (issues #6 e #8).

- **DONE de report antigo** (#6): o `scanDone` só emite `DONE` com `mtime(report.md)` posterior ao último prompt (a mesma
  regra do `PARKED`). Antes, um `prompt`/`resume`/`phase` novo liberava o DONE do report da rodada anterior e o orquestrador
  auditava um relatório velho com o agente ainda trabalhando. `prompt`, `resume`, `answer` e `phase` avisam quando o
  `report.md` existente já começa com `STATUS: DONE` (renomear para `report-<n>.md`); só aviso.
- **DONE segurado em silêncio** (#8): report `STATUS: DONE` sem prova ou commit agora sai como
  `DONE-HELD <agente> sem-prova|sem-commit|commit-fora-da-branch`, uma vez por prompt e motivo, também no diário
  (`watch.done-held`). Quando a prova ou o commit entram, sai o `DONE`. `hades agent phase <nome> <fase> --no-commit` marca a
  fase que dispensa commit (o DONE exige só a prova).
- Cartões `roles/impl.md` e `skill-dev-contract.md`: o report precisa de uma linha de prova positiva e do commit citado na
  linha da palavra "commit". `orchestrate.md` §4: o que fazer com o `DONE-HELD` (auditar, devolver pedindo prova, aceitar).
- Armadilha: o `answer` não muda o `promptedAt`; report DONE escrito antes do `answer` continua valendo para o ciclo do
  último prompt. O mtime é em segundos: report reescrito no mesmo segundo do prompt não conta.

## 6.2.0 — 2026-11-03

Terminal completo no painel e páginas Claude e Herdr de primeira classe no celular (issue #3).

- **Servidor do terminal** (`src/panel/term.ts`, `term-ring.ts`, `term-protocol.ts`, `term-http.ts`). Sessões PTY com o PTY nativo
  do Bun (sem `node-pty`) servidas por WebSocket: `shell`, `claude` (novo ou `--resume`, sempre em auto mode) e `herdr-client`
  (`herdr --session`; o herdr 0.8.2 não anexa a um pane sozinho). Resize, anel de saída com offset absoluto para retomar sem
  perder nem repetir, uma tela por sessão (a segunda fecha a primeira com 4001), teto de sessões e inatividade. Protocolo e
  códigos de recusa em `reference/panel.md` §Terminal.
- **Segurança do terminal.** `HADES_TERMINAL` nasce desligada e as quatro chaves `HADES_TERMINAL*` só mudam pelo painel local
  (o mesmo bloqueio de `HADES_CHAT`, também no import). O upgrade do WebSocket confere host, chave remota e `Origin` (pelo túnel,
  sem `Origin` recusa); a pasta é resolvida por `realpath` e só vale dentro do clone principal, das worktrees de agente e de `$D`;
  argv em lista; o grupo de processos morre ao fechar, expirar ou parar o painel. Aviso ao dono a cada sessão aberta de fora **e**
  no primeiro anexo remoto a uma sessão aberta no local; `logs/panel-term.log` (0600) só com ação, tipo, pasta, origem e id,
  nunca o que foi digitado nem a saída. Os PTYs ficam no cgroup da unit do painel (fora do slice `hades`, como o painel).
- **Interface do terminal.** xterm.js 6.0.0 e addon-fit 0.11.0 vendorizados (integrity conferido, MIT em `THIRD_PARTY_NOTICES.md`).
  `HadesCore.PtyTerminal` (o nome `Terminal` segue sendo o visualizador de log das Execuções) reconecta com recuo e retoma pelo
  offset, trata os códigos de fechamento e as recusas pelo `code`; `HadesCore.createXterm` dá o mesmo tema ao terminal e ao Argos.
- **Página Herdr** refeita: abas de sessão (shell, Claude Code, cliente do herdr) na pasta escolhida, lado a lado na mesa, sessões
  vivas, e **gerência do herdr** pelo painel (`POST /api/herdr/admin`): criar, renomear e fechar workspace, aba e painel, dividir
  painel e iniciar agente, com argv validado e confirmação por nome nas destrutivas.
- **Argos:** o nó de agente é desenhado pelo xterm (só leitura de saída; nós distantes ficam no resumo leve). **"Abrir terminal"**
  na Orquestração, no menu do nó do Argos e nas Execuções (a meta da execução ganha `cwd`, aditivo).
- **Página Claude:** modo Terminal ao lado do Chat (Claude Code de verdade, novo ou "Continuar no terminal"); no chat, o bloqueio de
  ferramenta ganha "Abrir no terminal para aprovar" (o `claude -p` não aceita aprovação no meio da resposta) e o anexo de imagem
  ou texto vai para `$D/claude/attach/<sessão>` (`HADES_CHAT_ATTACH_MB`, 20 por conversa, apagado com a sessão).
- **Celular:** Claude e Herdr mostram uma coisa por vez e o voltar do sistema desce um nível; barra de teclas acima do teclado
  virtual (Esc, Tab, Ctrl fixo, setas, colar, copiar e as respostas do Claude Code: 1/2/3, y/n, Shift+Tab, Ctrl+C), configurável
  por `HADES_TERMINAL_KEYS`; o terminal acompanha o `visualViewport` e tem "Ir ao fim"; o agente esperando você abre o painel dele
  com as respostas rápidas.
- Correção: `HADES_CHAT_BIN` inexistente no terminal responde 422 `term_kind_unavailable`, não 500.
- Armadilhas medidas: o xterm não lê `oklch` (tokens resolvidos em RGB); o Bun derruba o socket com quadro acima de `maxPayload`
  (o cliente vê 1006); o eco do tty vem com `\r` antes da saída; o xterm não seleciona por toque (Copiar leva a seleção ou a tela);
  `navigator.clipboard.readText` só em HTTPS/localhost; `agent start` do herdr só entra em painel de shell livre.
- Limites: Safari iOS e Chrome de celular não foram testados (só Firefox com viewport de celular); "Ir ao fim" não foi visto no
  navegador sem tela.

## 6.1.2 — 2026-11-03

- **Busca do seletor de arquivos cede o laço de eventos de verdade.** O `readdir` assíncrono do Bun pode resolver sem
  passar pelo laço; a busca agora cede a vez explicitamente a cada pasta, e o painel não trava os terminais durante uma
  busca grande. Quem achou foi o teste que já cobria isso, que falhava só no runner do CI.
- Teste do `notify restart` com ordem determinística entre o aviso do `cat` e o registro de chamadas (as duas leituras
  em sequência, não num `cat` só).

## 6.1.1 — 2026-11-03

- **Suíte portável para o CI público.** Os golden deixam de guardar dado da máquina que os gravou, e a suíte
  `loop/test/ts` volta a passar num runner limpo (o primeiro CI público teve 60 falhas em 23 testes). Agora são
  normalizados no teste o usuário do `plan.json`, o conteúdo de hooks e objects de repositório git, as frases do `sh` e
  do git e o tamanho dos worktrees do `clean`, que nascem sem modelo de hook nem compressão. A presença de `qrencode` e
  `bwrap` é fixada por stub, e o doctor completo não lê pela rede a versão publicada. O comportamento do produto não muda.
- Armadilha medida: simular o runner com `env -i HOME=<tmp>` não pega nada disso, porque as ferramentas continuam no PATH
  e o uid é o mesmo. Use um container `ubuntu:24.04` com usuário `runner`, bun e node, sem herdr, docker, systemd nem
  notify-send (`reference/evolving.md` §Golden que depende da máquina).

## 6.1.0 — 2026-11-03

- **Painel: `Select` próprio no lugar do select nativo** (issue #2). `HadesCore.Select` e `HadesPanel.Select` (para plugins):
  mesmo desenho em qualquer navegador e dispositivo, lista em portal na mesa (não é cortada por `overflow` nem por diálogo) e
  folha inferior no celular (`Sheet side="bottom"`, opções de 44 px). Grupos, contagem, ícone, dica e opção desabilitada; busca
  acima de 10 opções; teclado combobox/listbox da WAI-ARIA (setas, Home/End, PageUp/PageDown, digitar para pular, Esc fecha só a
  lista). Os 14 selects do painel migraram: `Choice` no celular, "últimas N" do visualizador de logs, Caronte, Cerberus (guarda
  agrupada por cabeça), Documentação, Configurações ("Ir para a seção"), criação de terminal, barra de leitura e ações do Argos.
  A guarda `src/panel/select-guard.ts` (no `check`) reprova select nativo novo em `kit/panel/ui/` fora de `vendor/`. Referência e
  roteiro de conversão em `reference/panel.md` §Select.
- **Teste do doctor isolado da rede.** Com o repositório da skill público, o GET anônimo da checagem de versão responde e o
  `doctor --json` do `bun-kit2` ganhava o aviso `versao-nova`; o teste agora desliga a checagem (`HADES_VERSION_CHECK_HOURS=0`).
- Armadilhas medidas: o `Dialog` tem `transform`, que prende `position: fixed` (por isso o portal no `body`); o `value`/`onChange`
  do `Select` é sempre texto (número se converte na borda); a regra de teclado e busca é pura (`ui/select-logic.tsx`,
  `window.SelectLogic`) e testada sem navegador.

## 6.0.0 — 2026-11-03

Primeiro release público, sob a licença MIT. O repositório recomeça aqui, e este arquivo também: o resumo abaixo é o que
a skill faz hoje, por área. Para instalar, `git clone` em `~/.claude/skills/hades` e `kit/install.sh` (README,
§Instalação); o pacote `hades-skill-v<versão>.tar.gz` segue como alternativa sem git. Vulnerabilidade se reporta em
privado, como diz o [`SECURITY.md`](SECURITY.md).

- **Loop de engenharia.** `deliver` leva a spec até a PR (código, gates, `/review-agents`); `inbox` faz a triagem dos reviews
  recebidos e corrige os achados vivos; `review` revisa PRs de terceiros em paralelo; `cascade` e `sweep` cascateiam a
  stack nos quatro sentidos; `orchestrate` e `consolidate` alocam agentes pelo herdr e juntam as PRs numa só, com gate
  único. Cada PR tem um estado calculado por um coletor só de leitura, e o loop **para em `done-pending`**: o merge é
  sempre do dono. Papéis com cartão próprio (implementação, revisão), brief por agente, handoff para estacionar e
  escalada de dúvida ao dono. `hades usage` mede o consumo de tokens por papel, agente e dia.
- **Fila de gates e teto de memória.** Tipos, testes e build passam um de cada vez por uma fila com orçamento de memória
  (`gate-lock`); o hook barra o gate que tenta furar a fila, e o ambiente local cede e pausa quando um gate espera
  memória. No macOS a fila mede pelo `kern.memorystatus_level`.
- **Ambiente local.** A branch `hades/local` (base do projeto mais as PRs, em ordem topológica), infra docker própria,
  serviços sob o teto de memória da slice do systemd, dados e processos de apoio do projeto, snapshot dos bancos antes
  de cada atualização, limpeza de disco e rotação de logs. `/hades env up|update|pause|resume|status|panel|config|doctor|onboard`.
- **Painel web.** Operação ao vivo em `127.0.0.1`: visão geral, branch e PRs, fila de gates, consumo, orquestração,
  revisões, loop, logs, notificações, onboarding, plugins, qualidade, Cerberus e Configurações. Tour por página, prévia
  de exemplo nas páginas vazias, PWA e uma página de chat com o Claude Code, também pelo celular.
- **Túnel.** Acesso de fora pelo devtunnel, com duas camadas obrigatórias: só a conta dona do túnel passa, e uma chave de
  acesso vira cookie `HttpOnly; Secure; SameSite=Strict`, com bloqueio de tentativas erradas por IP. Túnel anônimo só para
  o front do ambiente (com prazo, barrado pelo Cerberus até o dono aprovar) e para o widget.
- **Argos e herdr.** A página dos agentes como grafo navegável, com canvas que reage a mudanças de fora por SSE, notas,
  terminais dos agentes com histórico, seleção e colagem, e ações sobre os agentes. O diário de eventos por agente
  (`hades journal`) é a base comum do Argos e do Thanatos.
- **Cerberus.** Três cabeças guardam as fronteiras: a **Porta** (o que sai: push, comentário, artefato, túnel, release),
  o **Limiar** (o que entra: plugin, `post-install.sh`, hooks, páginas e rotas, com ensaio em sandbox quando há `bwrap`)
  e a **Vigília** (o que acontece dentro: auditoria do DONE e coerência entre plano, registro e realidade). Cada uma tem
  modo `barra` ou `avisa`; exceção e mudança de modo só o dono abre.
- **Moirai.** Estimativa de custo e duração por unidade de um plano, a partir do que as unidades encerradas custaram,
  antes da aprovação.
- **Caronte.** Empacota uma orquestração num arquivo cifrado com senha para retomá-la em outra sessão ou máquina
  (`caronte pack|unpack|brief`, `agent park`), com validação dos destinos e desfazer.
- **Thanatos.** Post-mortem de incidente ou bug em produção do projeto, montado de git, PRs, reviews e diário de eventos,
  fora do repositório.
- **Regras de qualidade.** Pacotes de regras de engenharia que o dono liga e desliga, injetados nos briefs; as do projeto
  valem por cima. Autonomia do orquestrador em dois controles que nascem desligados.
- **Perfis de projeto, stacks e plugins.** O que é de cada projeto mora num perfil (`/hades project init` gera o
  primeiro); pacotes de stack e um catálogo de checagens; plugins acrescentam ambiente, páginas e rotas, sempre com a
  prévia do commit e do que executa, avaliados pelo Limiar. Várias instâncias na mesma máquina.
- **Notificações e widget Android.** Aviso no desktop (`notify-send`) e no celular (ntfy) quando algo espera pelo dono;
  widget de tela inicial com agentes ativos, parados e perguntando, por token de leitura que só vale na rota do widget.
- **Doctor e onboarding.** `hades doctor` confere a instalação e diz o comando que corrige cada item; o onboarding
  entrega os passos que são do dono, com a mesma fonte de verdade para o comando, a página e o doctor.
- **Evolução da skill.** `hades skill-release` (`drift`, `check`, `guard`, `release`) valida o kit, roda as guardas de
  nome de projeto e de domínio e a regressão, e empacota; `hades agent skill-new` abre unidades de evolução em worktrees
  próprias; `hades contrib` devolve a melhoria ao repositório da skill.
- **Garantias que não cedem a pedido.** Nunca faz merge, nunca faz push sem conferir o upstream, nunca pula hook, nunca
  enfraquece teste, nunca declara verde um gate que não rodou e nunca escreve estado dentro do repositório do projeto
  (tudo vive em `~/.claude/hades/`).

O que mudou para abrir o repositório:

- **Licença e avisos.** `LICENSE` (MIT) e `THIRD_PARTY_NOTICES.md` com versão, origem e licença de cada biblioteca, fonte e
  componente adaptado que o painel redistribui; `kit/panel/ui/vendor/OFL.txt` com a OFL 1.1 das fontes; cabeçalho de
  licença nos bundles que não o traziam.
- **Componentes do painel reescritos.** Oito efeitos do painel (sino, cifra, botão de segurar, tinta metálica, barra de
  prompt, segmento elástico, névoa e ondas) foram reimplementados do zero, em sala limpa, a partir de uma especificação de
  comportamento, com os mesmos nomes e exports. A origem anterior tinha licença que proibia redistribuir os componentes.
- **CI público.** `.github/workflows/ci.yml` roda tipos (núcleo e UI), a suíte `loop/test/ts` e a guarda de release em
  cada PR, com actions fixadas por SHA. Os casos que exigem mais memória do que a máquina tem são pulados com o motivo no nome.
- **Checagem de versão sem login.** A VERSION mais recente é lida anonimamente do repositório público; o `gh` fica de
  reserva para fork privado ou espelho (`HADES_VERSION_CHECK_RAW_BASE`).
- **Guarda de repositório proibido.** `skill-release guard` reprova link para os repositórios listados em
  `HADES_FORBIDDEN_REPOS`, para que nada privado vaze para a árvore pública.
- **Segurança e contribuição.** `SECURITY.md` (relato privado pelo GitHub, versões suportadas, alcance) e o fluxo de
  contribuição por fork e PR no README.
