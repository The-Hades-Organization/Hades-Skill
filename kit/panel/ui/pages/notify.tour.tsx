/* Tour da página Notificações (#/notify). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX): cada string é uma chave de tradução em potencial.
 * Sem prévia: a página sempre tem os canais e o estado do vigia; só o histórico pode estar vazio, e o passo dele leva fallback. */
(() => {
HadesCore.registerTour('notify', {
  steps: [
    {
      id: 'tour-notify',
      title: 'Avisos do Hades',
      body: 'Aqui você vê se o vigia que avisa dos eventos do ambiente está ativo, por quais canais ele fala e o que já enviou. Os dados vêm de /api/notify e atualizam a cada 10 s.',
      command: 'hades notify status',
      ref: 'panel.md › Notificações',
      side: 'bottom',
    },
    {
      id: 'notify-estado',
      title: 'Resumo',
      body: 'Vigia ativo, desligado ou parado, há quantos segundos foi o último ciclo, se está em silêncio agora, quantos avisos recentes há e se algum canal ou checagem está falhando.',
      command: 'hades notify status',
      side: 'bottom',
    },
    {
      id: 'notify-canais',
      title: 'Canais',
      body: 'O vigia, o aviso no desktop, o celular (ntfy) e o horário de silêncio. Cada linha tem o estado com um ponto e uma frase do que isso significa.',
      ref: 'notify.md',
      side: 'right',
    },
    {
      id: 'notify-vigia',
      title: 'Vigia',
      body: 'A unit que confere o ambiente e avisa mesmo com o painel fechado. Se estiver parada com a notificação ligada, a linha diz como religar.',
      command: 'hades notify apply',
      ref: 'notify.md',
      side: 'right',
    },
    {
      id: 'notify-desktop',
      title: 'Desktop',
      body: 'Aviso do sistema nesta máquina. Liga e desliga em Configurações.',
      side: 'right',
    },
    {
      id: 'notify-celular',
      title: 'Celular',
      body: 'O aviso chega pelo app ntfy, num tópico secreto que só aparece no painel local. Sem tópico a linha avisa que falta um para chegar ao celular.',
      command: 'hades notify topic',
      ref: 'notify.md',
      side: 'right',
    },
    {
      id: 'notify-silencio',
      title: 'Silêncio',
      body: 'A janela de horário em que o vigia não avisa. Sem horário, avisa a qualquer hora; durante a janela a linha mostra "agora".',
      side: 'right',
    },
    {
      id: 'notify-checagem',
      title: 'Checagem com erro',
      body: 'Quando uma fonte que o vigia confere falha, ela ganha uma linha aqui com a mensagem de erro.',
      fallback: 'A linha só aparece quando uma checagem do vigia está falhando. Sem erro, ela não existe, e é o esperado.',
      side: 'right',
    },
    {
      id: 'notify-configurar',
      title: 'Configurar',
      body: 'Leva às Configurações já filtradas por notificações: ligar o vigia, os canais, o tópico do ntfy e o horário de silêncio. Lá também ficam os botões de testar.',
      command: 'hades notify test',
      side: 'left',
    },
    {
      id: 'notify-historico',
      title: 'Últimas notificações',
      body: 'As 50 mais recentes, com a gravidade, o objeto, o texto e o resultado por canal (canal que falhou fica em vermelho). A lista é viva: o que chega entra no topo sem empurrar quem lê.',
      command: 'hades notify test',
      fallback: 'A lista fica vazia até o primeiro aviso. Em Configurações → Notificações use Testar notificação: o aviso de teste aparece aqui.',
      side: 'left',
    },
  ],
});
})();
