/* Tour da página Herdr (#/herdr). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto (sem JSX): cada string é uma chave de tradução em potencial. Sem prévia: a página é o espelho de terminais
 * vivos da máquina (saída, teclas, prompt) e um exemplo fictício seria enganoso; o que pode faltar leva fallback. */
(() => {
HadesCore.registerTour('herdr', {
  steps: [
    {
      id: 'tour-herdr',
      title: 'Os terminais e agentes do herdr',
      body: 'O herdr organiza terminais em sessões, workspaces e abas. Esta página lista tudo que roda na máquina, de qualquer sessão (dentro ou fora do Hades), mostra a saída ao vivo e deixa você agir sem sair do navegador.',
      command: 'herdr api snapshot',
      ref: 'panel.md › Herdr',
      side: 'bottom',
    },
    {
      id: 'herdr-fora',
      title: 'Quando o herdr não responde',
      body: 'Sem o binário no PATH do painel, ou com o servidor da sessão parado, a página explica o que falta em vez de falhar. Ela volta sozinha quando o herdr responde.',
      command: 'herdr',
      fallback: 'Com o herdr no ar este aviso não aparece. Se ele sumir, instale o binário herdr ou abra o herdr no terminal.',
      side: 'bottom',
    },
    {
      id: 'herdr-estado',
      title: 'Resumo',
      body: 'Quantos agentes esperam por você, quantos trabalham, quantos agentes e terminais sem agente existem e qual sessão está aberta.',
      fallback: 'O resumo vem da árvore do herdr; sem o servidor no ar a página mostra o aviso do passo anterior.',
      side: 'bottom',
    },
    {
      id: 'herdr-sessoes',
      title: 'Sessões',
      body: 'Troca a sessão do herdr quando há mais de uma. "Sessões" abre a lista para parar uma que roda ou apagar uma parada; o nome precisa ser digitado e o botão exige segurar 1,2 s. Parar encerra todos os terminais dela.',
      command: 'herdr session list',
      ref: 'panel.md › Herdr',
      fallback: 'O seletor só aparece com mais de uma sessão; o botão "Sessões" aparece sempre que o herdr responde.',
      side: 'bottom',
    },
    {
      id: 'herdr-filtros',
      title: 'Filtrar',
      body: 'Filtra por nome, caminho, branch ou id, e por estado: esperando você, trabalhando, ocioso ou sem agente. A Visão geral abre esta página já filtrada em quem espera por você.',
      fallback: 'Os filtros aparecem com o herdr no ar.',
      side: 'bottom',
    },
    {
      id: 'herdr-workspaces',
      title: 'Workspaces',
      body: 'Cada workspace com seu repositório ou worktree e os agentes dele: nome, estado (fio fiando trabalhando, frouxo esperando você), pasta, branch e aba. Terminais sem agente ficam numa linha de botões. Atualiza a cada 4 s; o tempo no estado conta desde que o painel viu.',
      command: 'herdr api snapshot',
      fallback: 'Sem workspaces com o filtro atual o card diz "Nada com esse filtro". Limpe o filtro.',
      side: 'right',
    },
    {
      id: 'herdr-detalhe',
      title: 'O terminal escolhido',
      body: 'Ao escolher um item, a coluna da direita mostra o terminal: nome, estado, pasta, o processo em primeiro plano e a saída das últimas 200 linhas.',
      command: 'herdr pane read <pane>',
      fallback: 'No celular o terminal abre numa gaveta ao tocar num item; na mesa ele fica à direita e abre sozinho o agente que espera por você ou, senão, o que trabalha.',
      side: 'left',
    },
    {
      id: 'herdr-terminal',
      title: 'Identificação do terminal',
      body: 'O nome, o agente (Claude, por exemplo), o id do painel, o estado e há quanto tempo, e a pasta em primeiro plano. "Agente do orquestrador" leva à Orquestração.',
      fallback: 'Aparece depois de escolher um terminal na lista.',
      side: 'left',
    },
    {
      id: 'herdr-saida',
      title: 'Saída ao vivo',
      body: 'A saída se atualiza a cada 3 s enquanto "Automático" está ligado; desligue para ler com calma e use "Atualizar saída" para puxar uma vez.',
      command: 'herdr pane read <pane>',
      fallback: 'Aparece depois de escolher um terminal na lista.',
      side: 'left',
    },
    {
      id: 'herdr-enviar',
      title: 'Enviar prompt ou texto',
      body: 'Enviar prompt manda o texto ao agente e aperta Enter. Digitar sem Enter só escreve no terminal. Isto age de verdade na máquina: confira o destino antes.',
      command: 'herdr agent prompt <pane> "<texto>"',
      fallback: 'Aparece depois de escolher um terminal. Só terminais com agente têm "Enviar prompt"; os demais têm "Digitar sem Enter". Pelo acesso remoto cada ação dispara o evento herdr do notify.',
      side: 'left',
    },
    {
      id: 'herdr-teclas',
      title: 'Teclas de atalho',
      body: 'Enter, Tab, setas, y e n vão direto ao terminal. Esc e Ctrl+C podem interromper o que ele faz, então pedem confirmação antes.',
      command: 'herdr pane send-keys <pane> <tecla>',
      fallback: 'Aparece depois de escolher um terminal na lista.',
      side: 'left',
    },
    {
      id: 'herdr-renomear',
      title: 'Renomear o agente',
      body: 'Dá um nome ao agente para achá-lo na lista; deixar vazio remove o nome.',
      fallback: 'Só aparece para terminais com agente. Um terminal comum não pode ser renomeado por aqui.',
      side: 'left',
    },
  ],
});
})();
