/* Tour da página Onboarding (#/onboard). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX). Este é o tour da página; o "Fazer o tour" dela é o tour de boas-vindas do painel (ui/tour.tsx),
 * outro caminho. Sem prévia: a página sempre lista as features, com ou sem passo feito. */
(() => {
HadesCore.registerTour('onboard', {
  steps: [
    {
      id: 'tour-onboard',
      title: 'Preparar o Hades, recurso a recurso',
      body: 'Cada recurso (acesso remoto, notificações, início automático, contas e loop) tem seus passos, com o estado e o comando de cada um. A página lê o mesmo estado do comando de terminal e da checagem do doctor.',
      command: 'onboard.sh status',
      ref: 'onboard.md',
      side: 'bottom',
    },
    {
      id: 'onboard-intro',
      title: 'Escolher só marca',
      body: 'Escolher um recurso não roda nada: os passos mostram o que fazer. O Hades só executa um passo com o seu ok; túnel público, login, sudo e tokens são seus e aparecem como comando. Comando com "!" na frente roda no Claude Code com o "!", porque pede terminal ou senha.',
      ref: 'panel.md › Onboarding',
      side: 'bottom',
    },
    {
      id: 'onboard-fazer-tour',
      title: 'Fazer o tour',
      body: 'Reabre o tour de boas-vindas do painel (a visita pelas áreas principais), diferente deste, que explica a página. Ele grava "visto" ou "pulado" no onboarding.',
      side: 'bottom',
    },
    {
      id: 'onboard-resumo',
      title: 'O que falta',
      body: 'A linha resume quantos passos estão feitos e o que falta: escolher o que preparar, passos pendentes das features escolhidas e o tour. "Verificar de novo" mede tudo na hora.',
      command: 'onboard.sh status',
      fallback: 'O resumo aparece quando o servidor devolve o progresso do onboarding. Use "Verificar de novo" para medir.',
      side: 'bottom',
    },
    {
      id: 'onboard-recurso',
      title: 'Um recurso',
      body: 'O card mostra se o recurso foi escolhido, pulado ou ainda não escolhido, e quantos passos estão feitos. "Escolher" e "Pular" gravam a decisão, como o onboard.sh select e skip.',
      command: 'onboard.sh select <recurso>',
      side: 'right',
    },
    {
      id: 'onboard-fio',
      title: 'O fio de progresso',
      body: 'Um nó por passo feito, na posição do passo. Medido quando não falta nada, frouxo quando o recurso foi escolhido e ainda tem passo pendente, parado quando não foi escolhido.',
      side: 'bottom',
    },
    {
      id: 'onboard-passo',
      title: 'Um passo',
      body: 'Nome, estado (feito, pendente ou não se aplica), quem faz (você ou o Hades) e uma nota do que a checagem encontrou. Passo pendente de recurso não escolhido fica quieto: não é urgente.',
      side: 'top',
    },
    {
      id: 'onboard-comando',
      title: 'O comando do passo',
      body: 'O comando exato, com botão de copiar. Passo já feito não mostra o comando.',
      ref: 'onboard.md',
      fallback: 'Só passo pendente que tem comando mostra este bloco. Escolha um recurso com passo pendente para vê-lo.',
      side: 'top',
    },
    {
      id: 'onboard-acoes',
      title: 'Executar, marcar ou abrir a página',
      body: '"Executar pelo Hades" roda o passo depois de pedir confirmação (só no painel local). "Marcar como feito" vale para passo manual. "Abrir a página" leva ao painel onde o passo se faz. Pelo acesso remoto valem só escolher, pular e marcar; executar nunca.',
      ref: 'panel.md › Onboarding',
      fallback: 'Os botões variam por passo: passo já feito ou sem ação não mostra nenhum. Abra um passo pendente para vê-los.',
      side: 'top',
    },
  ],
});
})();
