/* Tour da página Execuções (#/jobs). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto (sem JSX): cada string é uma chave de tradução em potencial. Sem prévia: o log é lido de uma execução real
 * (por id), então um exemplo fictício não teria o que mostrar; a página vazia já se explica e os passos levam fallback. */
(() => {
HadesCore.registerTour('jobs', {
  steps: [
    {
      id: 'tour-jobs',
      title: 'Execuções do painel',
      body: 'Cada ação disparada pelo painel (subir, atualizar, build, diagnóstico) roda como uma unit transitória e aparece aqui como um fio, com o log ao vivo. A unit sobrevive se o painel reiniciar.',
      command: 'systemctl --user list-units "hds-pjob-*"',
      ref: 'panel.md › Ações',
      side: 'bottom',
    },
    {
      id: 'jobs-estado',
      title: 'Resumo',
      body: 'Quantas execuções rodam, quantas falharam na última hora, o tamanho do histórico e o prefixo das units, que continuam se o painel reiniciar.',
      fallback: 'Sem nenhuma execução a página mostra "Nenhuma execução ainda" e um fio parado. Dispare uma ação pelo painel, como Atualizar na Visão geral, e ela aparece aqui.',
      side: 'bottom',
    },
    {
      id: 'jobs-historico',
      title: 'Histórico',
      body: 'Todas as execuções, da mais nova à mais antiga, cada uma com o estado no fio. Na mesa, clicar escolhe a execução ao lado; no celular o log abre numa gaveta.',
      fallback: 'O histórico aparece com a primeira execução. Dispare uma ação pelo painel.',
      side: 'right',
    },
    {
      id: 'jobs-execucao',
      title: 'A execução escolhida',
      body: 'O título, a primeira linha do comando, a fase quando a execução a declara (as revisões de PR: fila, fetch, checkout, revisão, publicação), quando começou, quanto levou e, se falhou, o código de saída. Marca também se a ação é exclusiva e bloqueia outras do ciclo.',
      fallback: 'Este detalhe fica ao lado do histórico e só em tela larga (a partir de 1024 px). No celular, toque numa execução para abrir o log na gaveta.',
      side: 'bottom',
    },
    {
      id: 'jobs-terminal',
      title: 'Abrir terminal',
      body: 'Abre um shell na pasta onde a execução rodou e leva você à página Herdr com ele na mesa. Só aparece se a pasta estiver entre as permitidas do terminal; com HADES_TERMINAL desligada, o botão mostra como ligar.',
      fallback: 'O botão só existe com uma execução escolhida e a pasta dela dentro das raízes do terminal.',
      side: 'left',
    },
    {
      id: 'jobs-interromper',
      title: 'Interromper',
      body: 'Para a execução que está rodando (systemctl --user stop da unit). Só aparece enquanto ela roda.',
      command: 'systemctl --user stop hds-pjob-<id>',
      fallback: 'O botão só existe enquanto uma execução está rodando. Com tudo concluído não há o que interromper.',
      side: 'left',
    },
    {
      id: 'jobs-fio',
      title: 'O fio',
      body: 'O estado da execução em uma linha: fiando enquanto roda, medido ao concluir e cortado, em vermelho, quando falha. O ponto do corte mostra o quanto ela andou antes de cair.',
      ref: 'panel.md › Linguagem de componentes',
      fallback: 'O fio aparece com a execução escolhida, em tela larga.',
      side: 'bottom',
    },
    {
      id: 'jobs-log',
      title: 'O log',
      body: 'A saída da execução num terminal, ao vivo enquanto roda. O arquivo e o código de saída ficam em logs/panel-jobs, na pasta de dados.',
      fallback: 'O log fica ao lado do histórico, em tela larga. No celular ele abre na gaveta ao tocar na execução.',
      side: 'top',
    },
  ],
});
})();
