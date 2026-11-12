/* Tour da página Argos (#/argos). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX). O Argos é página stage (sem cabeçalho e sem o botão [ ? ]): o tour abre pelo item "Tour desta página"
 * da paleta Ctrl+K dele, e o primeiro passo fica centralizado, sem alvo. Sem prévia: o canvas já tem estado vazio próprio e é
 * o documento do dono; dados de exemplo nele se confundiriam com os nós reais. */
(() => {
HadesCore.registerTour('argos', {
  steps: [
    {
      id: 'tour-argos',
      title: 'Argos, o canvas dos agentes',
      body: 'Um canvas infinito com um nó por agente, unidade, PR e fila do gate, ligados como no grafo. Você posiciona os nós e a posição fica gravada; o grafo se atualiza sozinho a cada poucos segundos. Aqui o "?" sozinho abre os atalhos do Argos, e este tour abre pela paleta (Ctrl+K, "Tour desta página").',
      command: 'hades agent new',
      ref: 'argos.md › A página',
    },
    {
      id: 'argos-estado',
      title: 'O estado',
      body: 'A ilha de cima à esquerda diz o que está acontecendo, em chips: quantos esperam por você (laranja), quantos estão parados (vermelho) e quantos trabalham (verde). Toque num chip para filtrar e ir ao primeiro. No celular ela traz o botão que abre a navegação.',
      ref: 'argos.md › A página',
      side: 'bottom',
    },
    {
      id: 'argos-leitura',
      title: 'Leitura do canvas',
      body: 'A busca filtra e enquadra os nós. "Filtros" esconde por estado, atividade e papel (esconder da vista não apaga do documento), e "Vista" troca de canvas, guarda vistas, roda o layout e muda o detalhe dos nós. A paleta (Ctrl+K) roda comandos e leva a outras páginas.',
      ref: 'argos.md › A página',
      side: 'bottom',
    },
    {
      id: 'argos-lista',
      title: 'Lista de nós',
      body: 'O botão "Lista" (tecla l) abre os nós em lista, na ordem de urgência. Clicar num item seleciona o nó e leva a câmera até ele.',
      fallback: 'A lista abre pelo botão "Lista" da ilha de leitura (ou pela tecla l). Feche o painel com Esc.',
      side: 'right',
    },
    {
      id: 'argos-ferramentas',
      title: 'Ferramentas',
      body: 'Terminal e nota novos, ligação entre nós e os atalhos de terminal por papel. Arme a ferramenta e arraste um retângulo no canvas para criar o nó daquele tamanho. O terminal é um terminal de verdade, ligado ao herdr.',
      ref: 'argos.md › Tipos de nó e comandos',
      fallback: 'A barra de ferramentas aparece depois que o canvas carrega e os controles não estão escondidos. Shift+F mostra os controles de volta.',
      side: 'right',
    },
    {
      id: 'argos-camera',
      title: 'Câmera e histórico',
      body: 'Desfazer e refazer as mudanças do canvas, zoom e enquadrar tudo. Arrastar o fundo move a câmera e a roda do mouse (ou o gesto de pinça) dá zoom.',
      ref: 'argos.md › Desfazer e refazer',
      fallback: 'O grupo da câmera aparece quando o canvas está carregado e os controles à vista. Shift+F mostra os controles.',
      side: 'left',
    },
    {
      id: 'argos-organizar',
      title: 'Organizar o canvas',
      body: 'Shift+T arruma tudo por equipes: cada orquestrador com as notas em cima e os recrutas embaixo, sem nada sobreposto, e a câmera enquadra o resultado. Um Ctrl+Z desfaz o arranjo inteiro. O botão direito no fundo do canvas abre um menu curto com o que mais se faz ali (criar aqui, arrumar, enquadrar) e "Mais comandos…" para a paleta.',
      ref: 'argos.md › Layout',
      fallback: 'Organizar e o menu do fundo valem com o canvas carregado: Shift+T, ou Ctrl+K e "Organizar".',
      side: 'bottom',
    },
    {
      id: 'argos-minimapa',
      title: 'Minimapa',
      body: 'Um quadro pequeno com todos os nós e o retângulo do que você vê. Clique ou arraste nele para levar a câmera.',
      ref: 'argos.md › Camadas sobre o canvas na página',
      fallback: 'O minimapa só aparece em tela larga. No celular, use o gesto de pinça e a lista de nós.',
      side: 'left',
    },
    {
      id: 'argos-atalhos',
      title: 'Atalhos e ações do nó',
      body: 'O botão de teclado (ou o "?" fora de campo de texto) lista os atalhos. Clicar num nó abre a gaveta com o detalhe ao vivo, e o botão direito abre o menu com as ações: prompt, retomar, responder, aprovar ou negar permissão, estacionar e encerrar.',
      ref: 'argos.md › Atalhos',
      fallback: 'Este passo é sobre atalhos e gestos, sem card próprio, por isso fica no centro. O detalhe e o menu do nó só existem com pelo menos um nó no canvas: crie o primeiro agente com hades agent new, ou um terminal pelas ferramentas.',
      side: 'bottom',
    },
  ],
});
})();
