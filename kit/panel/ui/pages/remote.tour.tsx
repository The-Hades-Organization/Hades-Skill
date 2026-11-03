/* Tour da página Acesso remoto (#/remote). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX): cada string é uma chave de tradução em potencial.
 * Sem prévia: a página sempre tem conteúdo (túnel, chave e widget existem mesmo sem nada publicado). Aberta pelo próprio
 * acesso remoto ela só mostra um aviso, então os passos têm fallback. */
(() => {
HadesCore.registerTour('remote', {
  steps: [
    {
      id: 'tour-remote',
      title: 'Abrir o painel fora da máquina',
      body: 'Publica o painel por um devtunnel próprio e cuida da chave de acesso e do widget Android. Tudo aqui só se controla pelo painel local; pelo acesso remoto a página só avisa isso.',
      command: 'tunnel.sh panel-start',
      ref: 'panel.md › Acesso remoto',
      side: 'bottom',
    },
    {
      id: 'remote-estado',
      title: 'Resumo',
      body: 'Se o painel abre fora da máquina, se já existe chave de acesso e se o widget tem token.',
      fallback: 'Este resumo faz parte da tela do painel local. Você está no acesso remoto: abra o painel na máquina para controlar o túnel.',
      side: 'bottom',
    },
    {
      id: 'remote-tunel',
      title: 'Túnel do painel',
      body: 'O devtunnel que expõe o painel, com o estado em palavra (no ar, parado, nunca publicado). Ele vence 30 dias depois de criado, e publicar de novo cria outro.',
      command: 'tunnel.sh panel-status',
      ref: 'panel.md › Acesso remoto',
      fallback: 'Esta seção faz parte da tela do painel local. Pelo acesso remoto o túnel e a chave não se controlam.',
      side: 'right',
    },
    {
      id: 'remote-url',
      title: 'Endereço do túnel',
      body: 'A URL pública do painel, com botão de copiar. Quem abre entra com a conta do GitHub dona do túnel e cola a chave de acesso.',
      command: 'tunnel.sh panel-url',
      fallback: 'A URL só existe depois de publicar o painel uma vez. Use o botão Publicar painel (ou tunnel.sh panel-start no terminal).',
      side: 'right',
    },
    {
      id: 'remote-acoes',
      title: 'Publicar, parar e reler',
      body: 'Publicar painel cria o túnel se faltar e sobe a unit. Com o túnel no ar, Reler URL confere o endereço e Parar fecha o acesso (URL e chave voltam ao publicar de novo). Cada ação pede confirmação.',
      command: 'tunnel.sh panel-start',
      fallback: 'Os botões fazem parte da tela do painel local.',
      side: 'right',
    },
    {
      id: 'remote-travas',
      title: 'As três travas',
      body: 'Quem entra passa pela conta do GitHub dona do túnel, pela chave de acesso (vale 30 dias neste navegador; oito erros em 10 min bloqueiam novas tentativas) e só muda túnel e chave no painel local.',
      ref: 'panel.md › Acesso remoto',
      fallback: 'Estas linhas fazem parte da tela do painel local.',
      side: 'right',
    },
    {
      id: 'remote-chave',
      title: 'Chave de acesso',
      body: 'A chave que o navegador remoto cola na primeira visita. Ela fica oculta; o olho mostra e o botão copia. Trocar a chave derruba as sessões remotas. Ela nasce ao publicar o painel.',
      command: 'tunnel.sh panel-url',
      fallback: 'A seção faz parte da tela do painel local. Sem chave ainda, ela mostra "Sem chave ainda" e passa a existir ao publicar.',
      side: 'left',
    },
    {
      id: 'remote-widget',
      title: 'Widget Android',
      body: 'Um widget no celular que lê agentes, perguntas e eventos recentes sem abrir o painel. Três peças: o token, o túnel do widget e o APK.',
      ref: 'panel.md › Acesso remoto',
      fallback: 'Este bloco faz parte da tela do painel local.',
      side: 'top',
    },
    {
      id: 'remote-token',
      title: 'Token do widget',
      body: 'Dá ao widget leitura só de /api/widget. O token aparece uma vez, ao gerar: copie na hora, o servidor guarda só o hash. Gerar outro invalida o anterior; Revogar faz o widget parar de atualizar.',
      fallback: 'Esta seção faz parte da tela do painel local.',
      side: 'top',
    },
    {
      id: 'remote-widget-tunel',
      title: 'Túnel do widget',
      body: 'Um túnel anônimo, só na porta do widget: o token é a única autenticação, então o acesso vence e é renovado no terminal. Mostra a URL a colar no widget e quando o acesso vence.',
      command: 'tunnel.sh widget-create',
      ref: 'panel.md › Acesso remoto',
      fallback: 'Esta seção faz parte da tela do painel local. Sem URL, a seção mostra os comandos tunnel.sh widget-create e widget-publish-cmds.',
      side: 'top',
    },
    {
      id: 'remote-apk',
      title: 'APK do widget',
      body: 'Baixa o aplicativo do widget no celular ou o gera aqui no painel. É o mesmo cartão da Visão geral.',
      fallback: 'Este bloco faz parte da tela do painel local.',
      side: 'top',
    },
  ],
});
})();
