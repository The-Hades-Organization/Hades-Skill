/* Tour da página Extensões (#/extensoes). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto (sem JSX). Sem prévia: a página mostra o estado real das ferramentas desta máquina e um exemplo fictício enganaria;
 * o que pode faltar leva fallback. */
(() => {
HadesCore.registerTour('extensoes', {
  steps: [
    {
      id: 'tour-extensoes',
      title: 'Extensões da Hades',
      body: 'Uma extensão é uma ferramenta externa da máquina, com binário próprio (herdr, Mark), que a Hades detecta e consome. Não é plugin: não traz código para a Hades executar, só o manifesto que descreve o binário. Esta página mostra o estado de cada uma e liga ou desliga.',
      command: 'hades ext list',
      ref: 'extensoes.md › Página do painel',
      side: 'bottom',
    },
    {
      id: 'extensoes-extensao',
      title: 'Uma extensão',
      body: 'Nome e descrição do manifesto embutido na skill. Cada linha é lida na hora de abrir a página (GET /api/extensions, o mesmo JSON do comando).',
      command: 'GET /api/extensions',
      fallback: 'Este card aparece quando houver pelo menos um manifesto válido em extensions/.',
      side: 'top',
    },
    {
      id: 'extensoes-estado',
      title: 'Instalada, versão e mínima',
      body: 'Diz se o binário está no PATH, qual versão ele responde (ou "desconhecida" quando a ferramenta não tem como medir) e a versão mínima que o manifesto exige. Só o comando de versão e o de saúde do manifesto rodam, sem shell.',
      command: 'hades ext info <nome>',
      fallback: 'A linha de estado aparece com a primeira extensão.',
      side: 'top',
    },
    {
      id: 'extensoes-ligar',
      title: 'Ligar e desligar',
      body: 'O interruptor grava HADES_EXT_<NOME> em config.env, como o comando. Desligada, a Hades a trata como ausente onde consulta as extensões; o binário não é tocado. Só pelo painel local.',
      command: 'hades ext enable | disable <nome>',
      fallback: 'O interruptor não aparece pelo acesso remoto, que é só leitura. Abra o painel local para mudar.',
      side: 'left',
    },
    {
      id: 'extensoes-problemas',
      title: 'Problemas',
      body: 'Binário ausente, versão ilegível, versão abaixo da mínima e saúde falha viram um problema com código estável (ext.binary-missing, ext.version-unreadable, ext.version-below-min, ext.health-failed).',
      command: 'hades ext doctor',
      fallback: 'Esta lista só aparece quando uma extensão tem problema. Sem ela, a extensão está saudável.',
      side: 'top',
    },
    {
      id: 'extensoes-instalar',
      title: 'Como instalar',
      body: 'O comando de instalação é texto para você copiar. A Hades não o executa: instalar é passo do dono.',
      ref: 'extensoes.md › Manifesto',
      side: 'top',
    },
    {
      id: 'extensoes-chaves',
      title: 'Chaves da extensão',
      body: 'As chaves de configuração próprias da extensão, com o valor efetivo (ambiente, config.env ou padrão). Cada uma leva a Configurações, onde se edita.',
      command: 'hades config',
      ref: 'config.md',
      side: 'top',
    },
    {
      id: 'extensoes-comando',
      title: 'No terminal',
      body: 'Tudo o que a página faz tem comando equivalente; o JSON de list e de info é o mesmo que a página lê.',
      command: 'hades ext list --json',
      side: 'top',
    },
  ],
});
})();
