/* Tour da página Visão geral (#/overview). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto (sem JSX): cada string é uma chave de tradução em potencial. Sem prévia: a página sempre tem o snapshot do
 * ambiente para mostrar (mesmo parado), então o tour roda na tela real. */
HadesCore.registerTour('overview', {
  steps: [
    {
      id: 'tour-overview',
      title: 'Visão geral do ambiente',
      body: 'O retrato do Hades agora: o estado do ambiente, o que está rodando, o que pede você e a saúde da última hora. Os dados vêm do snapshot que o painel atualiza sozinho; nada aqui precisa de recarga.',
      ref: 'panel.md › Visão geral',
      side: 'bottom',
    },
    {
      id: 'overview-espera',
      title: 'Espera por você',
      body: 'Aparece quando algum agente do Herdr está bloqueado esperando uma resposta sua. "Responder no Herdr" abre os agentes parados; "Ver no Argos" abre o grafo deles.',
      fallback: 'O bloco só aparece quando há agente bloqueado esperando resposta. Sem ninguém esperando, ele some; as perguntas abertas ficam em Orquestração.',
      side: 'bottom',
    },
    {
      id: 'overview-estado',
      title: 'Estado e ações do ciclo',
      body: 'A frase de estado com o que importa agora. Os botões mudam com o estado: parado oferece Subir, pausado oferece Retomar, e Atualizar, Pausar e Dados ficam ao lado. STATUS abre o STATUS.md; o ícone ao lado o regera. Só uma ação de ciclo roda por vez.',
      command: 'run-hades',
      ref: 'panel.md › Ações',
      side: 'bottom',
    },
    {
      id: 'overview-leituras',
      title: 'Leituras',
      body: 'Quatro números do ambiente: serviços prontos, memória do slice contra o teto, containers da infra e erros nos logs dos últimos 15 minutos. Cada leitura com seta leva à página do assunto.',
      ref: 'panel.md › Visão geral',
      side: 'bottom',
    },
    {
      id: 'overview-agora',
      title: 'Agora',
      body: 'O que está vivo: execuções disparadas pelo painel, gates do gate-lock (rodando ou na fila) e agentes do Herdr trabalhando, cada um com o seu fio. As últimas execuções terminadas completam a lista. A linha inteira abre o alvo.',
      command: 'hades gate-lock status',
      fallback: 'O card aparece sempre; sem nada rodando ele diz "Nada rodando agora". Dispare uma ação (por exemplo Atualizar) para ver uma linha.',
      side: 'right',
    },
    {
      id: 'overview-atencao',
      title: 'Atenção',
      body: 'Só o que pede uma ação sua: serviço caído, endereço que não responde, aviso de versão nova. Lista vazia é o estado bom. Cada item leva direto à página que resolve.',
      fallback: 'O card aparece sempre; sem pendência ele fica quase vazio, o que é bom sinal.',
      side: 'left',
    },
    {
      id: 'overview-hora',
      title: 'Última hora',
      body: 'Dois gráficos da última hora, alternados no seletor: Memória (slice de serviços, infra docker e o extra do projeto, com a linha do teto) e Saúde (serviços prontos, ativos e erros). Os pontos vêm do amostrador do painel.',
      fallback: 'Com o Hades parado o gráfico diz "Nada rodou na última hora". Suba o ambiente e espere alguns minutos de amostras.',
      side: 'top',
    },
    {
      id: 'overview-ambiente',
      title: 'Ambiente',
      body: 'Três gavetas fechadas, para abrir só quando precisa: endereços do ambiente, diagnóstico e disco.',
      side: 'left',
    },
    {
      id: 'overview-enderecos',
      title: 'Endereços',
      body: 'Os endereços que o ambiente expõe e se cada um responde. Com o Hades parado todos aparecem apagados.',
      fallback: 'A gaveta lista só os endereços que o projeto declara; sem nenhum, ela não tem o que mostrar.',
      side: 'left',
    },
    {
      id: 'overview-diagnostico',
      title: 'Diagnóstico',
      body: '"Rodar" executa o doctor e mostra o que está errado, com a correção sugerida, e o que está certo. O resultado fica salvo; a gaveta diz há quanto tempo foi a última rodada.',
      command: 'doctor.sh',
      ref: 'doctor.md',
      side: 'left',
    },
    {
      id: 'overview-disco',
      title: 'Disco',
      body: 'Quanto cada categoria ocupa e quanto a limpeza libera. O botão de limpar só apaga o que é seguro (logs, histórico de Execuções, cache); imagens e worktrees ficam. Categorias irreversíveis pedem confirmação, com prévia do que sairia.',
      command: 'clean.sh run',
      ref: 'panel.md › Disco',
      fallback: 'A gaveta mostra "medindo…" até a primeira medição terminar. Se ela nunca sai disso, o painel não conseguiu rodar o clean.sh.',
      side: 'left',
    },
  ],
});
