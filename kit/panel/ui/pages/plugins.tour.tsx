/* Tour da página Plugins (#/plugins). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX). A prévia devolve a mesma forma de GET /api/plugins com dois pacotes fictícios, marcados como exemplo,
 * sem nome de projeto, de pessoa nem de repositório reais. */
(() => {
function previewPlugins() {
  const adds = (over) => ({ keys: [], steps: [], checks: [], doctor: false, pages: [], routes: [], actions: [], ...over });
  const ativo = {
    name: 'plugin-exemplo', repo: 'exemplo/projeto', state: 'ativo', mine: true, git: true, branch: 'main', commit: 'aaaaaaaaaaaa0000',
    url: 'https://exemplo.invalid/plugin-exemplo.git', core: { state: 'ok', core: '>=1' }, behind: 2, dirty: false, unpublished: 0, errors: [],
    adds: adds({ steps: [{}, {}], checks: [{}], doctor: true, pages: [{ label: 'Página de exemplo' }], routes: [{}], actions: [{}] }),
  };
  const guardado = {
    name: 'outro-plugin-exemplo', repo: 'exemplo/outro-projeto', state: 'outro-projeto', mine: false, git: true, branch: 'main', commit: 'bbbbbbbbbbbb0000',
    url: 'https://exemplo.invalid/outro-plugin-exemplo.git', core: { state: 'sem-core' }, behind: 0, dirty: true, unpublished: 1, errors: [],
    adds: adds({ steps: [{}] }),
  };
  return { list: { ok: true, remote: false, version: '0.0.0', repo: 'exemplo/projeto', packsRoot: 'pasta-de-pacotes', packs: [ativo, guardado] } };
}

HadesCore.registerTour('plugins', {
  preview: previewPlugins,
  steps: [
    {
      id: 'tour-plugins',
      title: 'Plugins da Hades',
      body: 'Um plugin é um pacote que acrescenta configurações, passos de onboarding, checagens, páginas e rotas ao Hades. Esta página lista os pacotes da pasta de pacotes e deixa adicionar, atualizar, ligar e remover. Nada roda sem a sua confirmação.',
      command: 'plugins.sh list',
      ref: 'projects.md › Plugin do Hades',
      side: 'bottom',
    },
    {
      id: 'plugins-estado',
      title: 'O estado desta instalação',
      body: 'Diz qual plugin está ativo aqui, a versão do núcleo e o repositório do projeto. Só um plugin vale por instalação: o pacote cujo identity.repo é o remote do worktree. Os outros ficam guardados.',
      ref: 'projects.md › Plugin do Hades',
      side: 'bottom',
    },
    {
      id: 'plugins-pacotes',
      title: 'Os pacotes',
      body: 'Um pacote por linha, lido da pasta de pacotes do Hades (GET /api/plugins). A lista é só leitura pelo acesso remoto; mudar plugin é pelo painel local.',
      command: 'plugins.sh list',
      fallback: 'A lista aparece sempre; sem pacote, ela mostra "Nenhum plugin na pasta de pacotes" e o núcleo roda sem plugin.',
      side: 'top',
    },
    {
      id: 'plugins-adicionar',
      title: 'Adicionar por URL',
      body: 'Clona o repositório fora da pasta de pacotes, sem hooks, e mostra uma prévia com o código que vai executar e o commit fixado. Só instala depois que você confere e confirma.',
      command: 'plugins.sh add <url>',
      ref: 'panel.md › Página Plugins',
      fallback: 'O botão não aparece pelo acesso remoto, que é só leitura. Abra o painel local para adicionar.',
      side: 'bottom',
    },
    {
      id: 'plugins-pacote',
      title: 'Um pacote',
      body: 'Nome, repositório do projeto, URL do remote, branch e commit fixado, e a versão do núcleo que o pacote pede. Abaixo, o que ele acrescenta: configurações, passos, checagens, páginas, rotas e ações.',
      fallback: 'Este card aparece quando houver pelo menos um pacote. Adicione o primeiro por URL.',
      side: 'top',
    },
    {
      id: 'plugins-estado-pacote',
      title: 'Ligar e desligar',
      body: 'O ponto e a palavra dizem se o pacote está ativo, desligado ou é de outro projeto. O interruptor, só no pacote desta instalação, reinstala o kit com o plugin e reinicia o painel, sempre depois de pedir confirmação.',
      command: 'plugins.sh enable | disable',
      fallback: 'O interruptor aparece só no pacote desta instalação e só no painel local.',
      side: 'left',
    },
    {
      id: 'plugins-avisos',
      title: 'O que pede atenção',
      body: 'Mudança local, commits não publicados, commits a atualizar e perfil inválido aparecem em destaque. Pacote com mudança local ou commit não publicado é recusado na remoção.',
      fallback: 'Esta linha só aparece quando algum pacote tem aviso. Sem aviso, o pacote está limpo e atualizado.',
      side: 'top',
    },
    {
      id: 'plugins-acoes',
      title: 'Atualizar e remover',
      body: 'Atualizar mostra os commits, o resumo e o diff do que executa antes de aplicar. Remover desliga o plugin, apaga o pacote e pede para digitar o nome. As configurações salvas ficam.',
      command: 'plugins.sh update <nome>',
      ref: 'projects.md › Plugin do Hades',
      fallback: 'Os botões aparecem junto de cada pacote, só no painel local.',
      side: 'top',
    },
    {
      id: 'plugins-comando',
      title: 'No terminal',
      body: 'Tudo o que a página faz tem comando equivalente. Ações que mudam o plugin ativo reiniciam o painel; páginas e rotas novas valem depois de recarregar.',
      command: 'plugins.sh list | add <url> | update <nome> | enable | disable | remove <nome> --confirm <nome>',
      side: 'top',
    },
  ],
});
})();
