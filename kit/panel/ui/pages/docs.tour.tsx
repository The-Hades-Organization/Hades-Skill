/* Tour da página Documentação (#/docs). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX). Sem prévia: a documentação vem junto com a skill, então a página sempre tem conteúdo. */
(() => {
HadesCore.registerTour('docs', {
  steps: [
    {
      id: 'tour-docs',
      title: 'A documentação da skill',
      body: 'Lê as referências da própria skill instalada, em Markdown renderizado sem HTML cru. É a mesma documentação que o Claude consulta; a versão que você vê é a da instalação.',
      ref: 'panel.md › Páginas',
      side: 'bottom',
    },
    {
      id: 'docs-grupos',
      title: 'Grupos de documentos',
      body: 'Os documentos vêm agrupados por assunto. Escolher um grupo troca a lista de documentos; o último grupo aberto fica lembrado neste navegador. Em tela estreita o seletor "Grupo" faz o mesmo papel.',
      side: 'bottom',
    },
    {
      id: 'docs-origem',
      title: 'Versão e origem',
      body: 'A versão da skill e a pasta de onde os documentos são lidos. Útil para conferir se a documentação bate com a instalação em uso.',
      fallback: 'A origem aparece na barra de grupos; em tela estreita ela desce para a linha de baixo.',
      side: 'bottom',
    },
    {
      id: 'docs-documentos',
      title: 'Documentos do grupo',
      body: 'Os documentos do grupo escolhido, um por linha. O aberto fica marcado. O link "ref" dos tours das outras páginas leva direto a um destes documentos.',
      fallback: 'A lista só aparece em tela larga e em grupo com mais de um documento. No celular, use o seletor "Documento" acima do texto.',
      side: 'right',
    },
    {
      id: 'docs-topicos',
      title: 'Tópicos do documento',
      body: 'Os títulos do documento aberto, com o trecho que você está lendo marcado. Clique para pular até ele; com muitos tópicos, o campo acima filtra por nome.',
      fallback: 'O índice fixo só cabe em tela larga. No celular, abra "Tópicos" acima do texto.',
      side: 'right',
    },
    {
      id: 'docs-leitura',
      title: 'A leitura',
      body: 'O texto numa medida confortável de leitura, com código e tabelas podendo passar dela. Mostra o id do documento e quando foi atualizado. Só leitura: nada aqui altera a skill.',
      side: 'left',
    },
  ],
});
})();
