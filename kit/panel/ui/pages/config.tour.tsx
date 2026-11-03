/* Tour da página Configurações (#/config). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX). Sem prévia: o catálogo de configurações sempre existe, então a página sempre tem conteúdo. */
(() => {
HadesCore.registerTour('config', {
  steps: [
    {
      id: 'tour-config',
      title: 'Configurações do Hades',
      body: 'Todas as chaves do catálogo num formulário só: o rótulo, para que serve, a chave, o padrão e quando a mudança vale. O painel grava só o que difere do padrão, no mesmo arquivo do terminal.',
      command: 'config.sh show',
      ref: 'config.md',
      side: 'bottom',
    },
    {
      id: 'config-busca',
      title: 'Buscar',
      body: 'Casa nome, chave e descrição, sem acento e sem diferenciar maiúsculas. A tecla "/" leva o foco para cá e Esc limpa. A busca fica no endereço (#/config?q=), então dá para mandar o link.',
      side: 'bottom',
    },
    {
      id: 'config-filtros',
      title: 'Filtros',
      body: '"Só fora do padrão" mostra o que você mudou. "Falta aplicar" mostra o que já foi salvo mas ainda não vale, por exemplo o teto de memória, que pede aplicar no slice.',
      side: 'bottom',
    },
    {
      id: 'config-exportar',
      title: 'Exportar e importar',
      body: 'Exportar gera um arquivo com os valores do dono, sem segredo nem dado desta máquina. Importar valida cada chave pelo tipo e mostra o que mudaria antes de aplicar.',
      command: 'config.sh export',
      ref: 'config.md',
      side: 'bottom',
    },
    {
      id: 'config-aplicar',
      title: 'Falta aplicar',
      body: 'Algumas chaves só valem depois de uma ação: aplicar o teto no slice, reiniciar serviços, o painel ou os subagentes. Este card lista o que está salvo e pendente, com o botão certo para cada caso.',
      command: 'config.sh apply-slice',
      fallback: 'Este card só aparece depois de salvar uma chave que pede aplicação (teto de memória, porta do painel e outras). Mude uma e salve para vê-lo.',
      side: 'bottom',
    },
    {
      id: 'config-indice',
      title: 'Índice das seções',
      body: 'Pula para o grupo de chaves e marca o que você está lendo. Um ponto âmbar indica alteração não salva na seção.',
      fallback: 'O índice fixo só cabe em tela larga. No celular, use o seletor "Ir para a seção" acima da lista.',
      side: 'right',
    },
    {
      id: 'config-grupo',
      title: 'Um grupo',
      body: 'Quantas configurações o grupo tem e quantas estão fora do padrão. Alguns grupos trazem contexto próprio, como a memória atual do Hades no grupo Memória.',
      side: 'top',
    },
    {
      id: 'config-linha',
      title: 'Uma configuração',
      body: 'O controle muda com o tipo: interruptor, opções, número ou texto. Abaixo do título vêm a chave, o padrão e quando vale (na hora, ao reiniciar, no próximo ciclo). O botão de seta volta ao padrão; nada grava até você salvar.',
      command: 'config.sh set CHAVE=VALOR',
      ref: 'config.md',
      fallback: 'A linha aparece quando a busca ou o filtro deixa alguma configuração à vista. Limpe-os para vê-las.',
      side: 'top',
    },
    {
      id: 'config-salvar',
      title: 'Salvar',
      body: 'A barra aparece quando há alteração. "Salvar" grava todas de uma vez e avisa o que ainda precisa ser aplicado; "Descartar" volta ao que estava salvo.',
      command: 'config.sh set CHAVE=VALOR',
      fallback: 'A barra de salvar só aparece quando você altera algum valor. Mude uma configuração para vê-la.',
      side: 'top',
    },
    {
      id: 'config-rodape',
      title: 'Onde fica o arquivo',
      body: 'O caminho do arquivo de configuração. Variável exportada no shell que subiu o painel vence o valor salvo aqui. No terminal: show, set e unset.',
      command: 'config.sh show | get K | set K=V | unset K',
      side: 'top',
    },
  ],
});
})();
