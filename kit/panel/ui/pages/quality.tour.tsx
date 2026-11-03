/* Tour da página Qualidade (#/quality). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX). Sem prévia: o catálogo de regras vem junto com o Hades, então a página sempre tem conteúdo. */
(() => {
HadesCore.registerTour('quality', {
  steps: [
    {
      id: 'tour-quality',
      title: 'Catálogo de regras de qualidade',
      body: 'As regras que o Hades injeta no brief dos agentes. Aqui você liga e desliga regras, grupos e pacotes. A escolha vale para todos os projetos e só guarda o que difere do padrão.',
      command: 'hades quality list',
      ref: 'quality.md',
      side: 'bottom',
    },
    {
      id: 'quality-estado',
      title: 'O resumo',
      body: 'Quantas regras estão ligadas, quantas são bloqueantes, quantos pacotes estão ligados ou parciais, quantas regras você mudou e quantos conflitos há com o perfil do projeto.',
      side: 'bottom',
    },
    {
      id: 'quality-conflitos',
      title: 'Conflitos com o projeto',
      body: 'Quando o perfil do projeto contraria uma regra ligada, ela aparece aqui com o motivo. A regra continua ligada até você decidir; onde o projeto pede menos, vale o catálogo.',
      fallback: 'Este card só aparece quando o perfil do projeto contraria alguma regra ligada. Sem conflito, ele fica fora da tela.',
      side: 'bottom',
    },
    {
      id: 'quality-pacotes',
      title: 'Pacotes',
      body: 'Um pacote reúne regras de um tema. O interruptor liga ou desliga todas de uma vez; mexer numa regra à parte deixa o pacote parcial. "Filtrar" mostra só as regras do pacote.',
      command: 'hades quality packs',
      ref: 'quality.md › Pacotes',
      fallback: 'O card aparece quando o catálogo tem pacotes. Pacotes próprios entram pelo arquivo de pacotes do usuário (veja a referência).',
      side: 'top',
    },
    {
      id: 'quality-busca',
      title: 'Buscar e filtrar',
      body: 'A busca casa id, texto, grupo, severidade e tags, sem acento. Ao lado, o seletor de grupo (Linguagem, Framework, Práticas, Estilo, Testes, Banco) e o contador de quantas regras o filtro mostra.',
      side: 'bottom',
    },
    {
      id: 'quality-todas',
      title: 'Ações em todas as regras',
      body: 'Ligar todas, desligar todas (inclusive as bloqueantes) ou voltar ao padrão, que desfaz as suas escolhas. Desligar todas muda o que os agentes recebem em todo projeto.',
      command: 'hades quality on --all | off --all | reset',
      side: 'bottom',
    },
    {
      id: 'quality-grupo',
      title: 'Um grupo de regras',
      body: 'Cada grupo mostra quantas regras estão ligadas e tem os botões para ligar ou desligar o grupo inteiro. Com filtro ativo, o botão age no grupo todo, não só nas linhas que a tela mostra.',
      command: 'hades quality on --group <grupo>',
      fallback: 'Os grupos aparecem quando a busca ou o filtro deixa alguma regra à vista.',
      side: 'top',
    },
    {
      id: 'quality-regra',
      title: 'Uma regra',
      body: 'O interruptor liga ou desliga a regra. A severidade (bloqueante, alta, média, baixa) hoje só ordena o bloco injetado no brief; quem barra de verdade é o Cerberus. "Checagem sugerida" é um comando que o agente pode rodar, o Hades não o roda sozinho.',
      command: 'hades quality off <id>',
      ref: 'quality.md',
      fallback: 'A regra aparece quando a busca ou o filtro deixa alguma à vista. Limpe os filtros para vê-las.',
      side: 'top',
    },
    {
      id: 'quality-comando',
      title: 'Onde fica e o terminal',
      body: 'O arquivo de escolhas guarda só o que difere do padrão. No terminal, o hades quality faz o mesmo que a página.',
      command: 'hades quality list | packs | on | off [--pack <id>] | reset',
      side: 'top',
    },
  ],
});
})();
