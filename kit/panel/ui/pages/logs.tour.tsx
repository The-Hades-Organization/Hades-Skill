/* Tour da página Logs (#/logs). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX): cada string é uma chave de tradução em potencial.
 * Sem prévia: a página sempre tem conteúdo (serviços, documentos e processos existem mesmo com o ambiente parado). */
(() => {
HadesCore.registerTour('logs', {
  steps: [
    {
      id: 'tour-logs',
      title: 'Logs do ambiente',
      body: 'Um só lugar para ler o que os serviços, os builds, as units e os containers do projeto escrevem. A página só lê, exceto o botão de subir um serviço parado.',
      ref: 'panel.md › Páginas',
      side: 'bottom',
    },
    {
      id: 'logs-categorias',
      title: 'Categorias',
      body: 'Serviços (logs do projeto), builds e ciclos (build, migrate, update, seed), processos (journalctl das units), containers (docker logs) e documentos (STATUS, notas). O número é quantas fontes cada uma tem; a escolha fica lembrada neste navegador.',
      side: 'right',
    },
    {
      id: 'logs-lista',
      title: 'As fontes da categoria',
      body: 'Cada linha é um log. Em Serviços o ponto diz se o serviço está ativo, subindo ou parado, serviço desligado fica apagado e "N err" conta os erros dos últimos 15 minutos. Clique para ler.',
      side: 'right',
    },
    {
      id: 'logs-filtro',
      title: 'Filtrar',
      body: 'Filtra a lista da categoria pelo nome, sem diferenciar maiúsculas. Trocar de categoria limpa o filtro.',
      side: 'right',
    },
    {
      id: 'logs-leitor',
      title: 'O leitor',
      body: 'Mostra o log escolhido e segue as linhas novas. Dá para filtrar, seguir e copiar. Quando o arquivo ainda não existe, o motivo costuma ser serviço que não subiu.',
      fallback: 'O leitor aparece quando há uma fonte escolhida. Categoria sem fontes mostra só o aviso de que nada foi encontrado; suba a infra na Visão geral para os containers aparecerem.',
      side: 'left',
    },
    {
      id: 'logs-subir',
      title: 'Subir um serviço parado',
      body: 'Log de serviço que não existe quase sempre é serviço que não subiu. Se ele está ligado nas Configurações, o botão sobe só esse serviço.',
      fallback: 'Esta faixa só aparece quando o serviço aberto está parado. Abra em Serviços um item com o ponto apagado; serviço desligado não ganha o botão, ligue-o antes em Configurações.',
      side: 'bottom',
    },
  ],
});
})();
