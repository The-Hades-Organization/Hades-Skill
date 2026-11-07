/* Tour da página Consumo (#/usage). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto (sem JSX): cada string é uma chave de tradução em potencial. Sem prévia: a leitura (régua, tabelas, gráfico)
 * depende do cálculo real dos transcripts e não cabe num exemplo fictício; o que pode faltar leva fallback. */
(() => {
HadesCore.registerTour('usage', {
  steps: [
    {
      id: 'tour-usage',
      title: 'Consumo de tokens',
      body: 'Quanto as sessões do Claude consumiram, por papel, agente e dia. O custo é o equivalente em API (estimativa), não a cobrança da sua assinatura. A conta sai dos transcripts do Claude Code.',
      command: 'hades usage',
      ref: 'panel.md › Consumo',
      side: 'bottom',
    },
    {
      id: 'usage-resumo',
      title: 'Resumo da janela',
      body: 'O custo por dia, a diferença sobre a linha de base, os dias da janela, os turnos e há quanto tempo o cálculo foi feito. A nota abaixo explica o que entrou na conta.',
      command: 'hades usage --days 7',
      fallback: 'Enquanto o primeiro cálculo roda a página mostra "Calculando o consumo…" (leva alguns segundos). Se /api/usage não responde, aparece "Consumo indisponível" com o botão para tentar de novo.',
      side: 'bottom',
    },
    {
      id: 'usage-acoes',
      title: 'Recalcular e gravar a linha de base',
      body: 'Recalcular refaz a conta agora, sem esperar os 15 s da atualização. Gravar linha de base guarda a janela atual como referência; as próximas leituras comparam com ela (pede confirmação).',
      command: 'hades usage --baseline',
      fallback: 'Os botões vêm junto com o resumo, que só aparece depois do primeiro cálculo.',
      side: 'bottom',
    },
    {
      id: 'usage-janelas',
      title: 'Janelas do plano',
      body: 'O % já usado das janelas de 5 h e semanal, lido do statusLine do Claude Code, com a hora em que cada uma renova e há quanto tempo foi medido. As colunas ~% das tabelas abaixo são estimadas por calibração, nunca medidas.',
      command: 'hades usage sample',
      ref: 'limites.md',
      fallback: 'Sem amostras o card explica como ligar a coleta (colocar hades usage sample no statusLine); a Hades não mostra número sem medida.',
      side: 'bottom',
    },
    {
      id: 'usage-leituras',
      title: 'As quatro leituras',
      body: 'Custo por dia contra a linha de base; polling (turnos que só esperavam) contra o limite de 5%; contexto médio dos agentes contra 200k tokens por turno; e reescrita de cache depois de pausa (não a reescrita de comando do rtk no auto mode: uma Bash por resposta, em loop/tokens.md). A barra é o valor, o traço é a referência, e passar dela troca o tom.',
      ref: 'loop/tokens.md',
      fallback: 'As leituras aparecem junto com o resumo, depois do primeiro cálculo.',
      side: 'bottom',
    },
    {
      id: 'usage-papel',
      title: 'Por papel',
      body: 'Sessões, custo, parte do custo, polling e contexto (médio e máximo) por papel: implementação, spec, consolidação, revisão, orquestrador e interativa. Mostra quem pesa mais e onde o polling passa do limite.',
      command: 'hades usage --json',
      fallback: 'A tabela vem do cálculo de consumo; sem ele a página não mostra este card.',
      side: 'top',
    },
    {
      id: 'usage-dia',
      title: 'Por dia',
      body: 'Uma coluna por dia: o custo útil embaixo e o polling por cima, em âmbar. O rótulo aparece só no dia mais caro e em hoje; passe o mouse ou foque uma coluna para ver o valor.',
      fallback: 'Sem dias na janela o card diz "Sem dias na janela". Em tela estreita ele desce para baixo da tabela por papel.',
      side: 'left',
    },
    {
      id: 'usage-estimado',
      title: 'Estimado × real',
      body: 'Para cada unidade de um plano aprovado, a faixa provável de custo (p25 a p75, traço na mediana) e o custo real. O marcador muda de tom ao passar do p75, e acima do limite maior o orquestrador para e pergunta ao dono.',
      command: 'hades moirai plan',
      ref: 'panel.md › Moirai: Estimado × real',
      fallback: 'O card só aparece quando algum plano aprovado tem a seção "## Estimativa". Sem plano da Moirai ele não existe; aprove um plano com estimativa pela Orquestração.',
      side: 'top',
    },
    {
      id: 'usage-agentes',
      title: 'Agentes',
      body: 'Os 25 agentes mais caros do herdr na janela, com papel, modelos, custo, turnos, contexto e o custo de polling. Contexto acima de 200k aparece em âmbar: cada turno relê demais.',
      command: 'hades usage --json',
      fallback: 'Sem agente do herdr na janela o card diz "Nenhum agente na janela".',
      side: 'top',
    },
  ],
});
})();
