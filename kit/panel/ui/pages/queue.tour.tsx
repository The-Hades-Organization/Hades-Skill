/* Tour da página Fila de gates (#/queue). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto (sem JSX): cada string é uma chave de tradução em potencial. Sem prévia: a página sempre tem conteúdo vivo
 * (memória da máquina, gráficos) e a fila vazia já é um estado legível; os cards que podem faltar levam fallback. */
(() => {
HadesCore.registerTour('queue', {
  steps: [
    {
      id: 'tour-queue',
      title: 'A fila de gates da máquina',
      body: 'Gate é a checagem pesada antes da PR (build, lint, testes). A fila admite um de cada vez conforme a memória livre, para a máquina não travar. A página só lê o que o gate-lock grava.',
      command: 'hades gate-lock status',
      ref: 'panel.md › Fila de gates',
      side: 'bottom',
    },
    {
      id: 'queue-estado',
      title: 'Resumo da fila',
      body: 'Quantos gates rodam, quantos esperam (e há quanto tempo o mais antigo), a memória que os gates usam do orçamento, a memória livre contra a reserva e a carga da máquina. Fica vermelho quando a memória livre cai abaixo do mínimo para admitir gates.',
      command: 'hades gate-lock status',
      side: 'bottom',
    },
    {
      id: 'queue-fila',
      title: 'Fila agora',
      body: 'Um fio por gate, em três colunas: esperando (fio frouxo), rodando (fio fiando, com memória, CPU e o passo atual contra a mediana do mesmo passo) e concluídos (fio cortado quando passou muito do tempo normal). A coluna vazia diz "Ninguém na fila".',
      command: 'hades gate-lock run <tipo> --label <agente> -- <comando>',
      ref: 'panel.md › Fila de gates',
      side: 'top',
    },
    {
      id: 'queue-visao',
      title: 'Rio ou lista',
      body: 'Alterna entre as colunas do rio e uma tabela com gate, estado, tempo, memória, CPU e passo. O número ao lado de "Lista" é a quantidade de gates na fila.',
      side: 'left',
    },
    {
      id: 'queue-memoria',
      title: 'Memória da máquina',
      body: 'A barra divide a memória usada entre gates, infraestrutura (containers e daemons), sobra de gate (processos que ficaram depois do fim) e o resto da máquina. O traço claro é a reserva que a fila exige para admitir um gate novo.',
      ref: 'loop/gates.md',
      side: 'top',
    },
    {
      id: 'queue-grafico',
      title: 'Gates simultâneos',
      body: 'Quantos gates rodavam e quantos esperavam, minuto a minuto, na última hora. Serve para ver se a fila está congestionada ou só passou um pico.',
      side: 'top',
    },
    {
      id: 'queue-grafico-memoria',
      title: 'Memória da fila',
      body: 'A memória que os gates usaram contra a que sobrou livre na máquina, na última hora. Quando as duas linhas se aproximam, novos gates passam a esperar.',
      side: 'top',
    },
    {
      id: 'queue-historico',
      title: 'Histórico da fila',
      body: 'O journal do gate-lock, do mais novo ao mais antigo: entrou, admitido, começou, concluído, estourou o tempo ou abortado, com a reserva em GB e o resultado. Saída 137 ou 143 quer dizer que o teto de memória cortou o processo. O botão alterna entre 15 e 60 linhas.',
      command: 'hades gate-lock status',
      fallback: 'O histórico vem do journal do gate-lock. Sem nenhum gate rodado por aqui a tabela fica vazia; rode um com hades gate-lock run <tipo> --label <agente> -- <comando>.',
      side: 'left',
    },
    {
      id: 'queue-sequencias',
      title: 'Sequências recentes',
      body: 'Os últimos resumos de lint, build e teste: quantos passos tiveram, quando terminaram e o que falhou. Abra uma linha para ver o último passo.',
      fallback: 'Sem resumos recentes, o card mostra "Sem resumos recentes". Os resumos aparecem depois que um gate do loop termina.',
      side: 'left',
    },
    {
      id: 'queue-fora',
      title: 'Fora da fila',
      body: 'Processos pesados que rodam sem passar pelo gate-lock e por isso furam a conta de memória dos gates. Para entrar na conta, rode o comando pelo gate-lock.',
      command: 'hades gate-lock run <tipo> --label <agente> -- <comando>',
      fallback: 'O card só aparece quando há processo pesado fora da fila. Se a máquina está limpa, ele não existe: é o estado bom.',
      side: 'left',
    },
    {
      id: 'queue-locks',
      title: 'Locks do loop',
      body: 'Entregas e revisões do loop que seguram um lock, com o tempo e se há agente vivo nele. Lock sem agente costuma ser preso; o link leva à página Loop para liberar.',
      ref: 'panel.md › Fila de gates',
      fallback: 'O card só aparece quando o loop tem lock aberto. Sem loop em andamento ele não existe.',
      side: 'left',
    },
    {
      id: 'queue-sem-amostrador',
      title: 'Amostrador indisponível',
      body: 'Quando o amostrador da fila não responde, a página cai para a lista crua dos tickets do gate-lock, só com estado e custo.',
      fallback: 'Este card só substitui a página se o amostrador da fila estiver fora; com a fila normal você vê as seções acima.',
      side: 'bottom',
    },
  ],
});
})();
