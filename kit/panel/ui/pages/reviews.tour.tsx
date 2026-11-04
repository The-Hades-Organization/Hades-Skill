/* Tour da página Revisões (#/reviews). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX): cada string é uma chave de tradução em potencial. A prévia devolve duas revisões fictícias no
 * histórico, marcadas como exemplo, sem nome de projeto, de PR nem de pessoa reais; o formulário segue real, com Revisar
 * desligado enquanto o exemplo está na tela. */
(() => {
// o formato dos itens de GET /api/reviews (só o histórico: o formulário e os padrões vêm do servidor)
function previewReviews() {
  const at = (min) => Date.now() / 1000 - min * 60;
  const base = { cmd: 'review-pr', model: 'opus', effort: 'medium', report: false, job: null, url: null, author: 'pessoa-exemplo' };
  return {
    items: [
      { ...base, id: 'exemplo-1', pr: 1, title: 'Exemplo: limite de tempo na chamada externa', state: 'ok', verdict: 'yellow', blocking: 0, important: 2, inline: 3,
        post: true, posted: true, costUsd: 0.42, durationMs: 4 * 60_000, tokens: { input: 12000, output: 3000, cacheRead: 480000, cacheWrite: 21000 }, started: at(45) },
      { ...base, id: 'exemplo-2', pr: 2, title: 'Exemplo: cache de preços', cmd: 'review-agents', state: 'ok', verdict: 'red', blocking: 1, important: 1, inline: 4,
        post: false, posted: false, costUsd: 2.1, durationMs: 11 * 60_000, tokens: { input: 40000, output: 9000, cacheRead: 1900000, cacheWrite: 80000 }, started: at(300) },
      { ...base, id: 'exemplo-3', pr: 3, title: 'Exemplo: ajuste de texto', state: 'falhou', error: 'a sessão terminou sem relatório', post: false, posted: false, started: at(1500) },
    ],
  };
}

HadesCore.registerTour('reviews', {
  preview: previewReviews,
  steps: [
    {
      id: 'tour-reviews',
      title: 'Revisão de PRs',
      body: 'Revise PRs de terceiros daqui: marque quantas quiser, escolha como revisar e acompanhe. Cada revisão roda numa sessão claude -p por PR, em paralelo, num worktree descartável (sem build nem teste). A frase do topo resume o que roda, o histórico e o custo.',
      command: '/hades review --pr <N>',
      ref: 'panel.md › Revisões',
      side: 'bottom',
    },
    {
      id: 'reviews-prs',
      title: 'PRs',
      body: 'A lista de PRs abertas do repositório, para marcar quais revisar (quantas quiser; o teto de revisões ao mesmo tempo vem das Configurações e as demais esperam na fila). A mesma lista do seletor da página Branch e PRs.',
      ref: 'panel.md › Seletor de PRs',
      fallback: 'A lista vem do GitHub pelo gh. Sem o gh autenticado ou sem PR aberta ela fica vazia: confira com gh auth status.',
      side: 'right',
    },
    {
      id: 'reviews-como',
      title: 'Como revisar',
      body: '/review-pr é uma sessão que revisa sozinha (rápido, barato); /review-agents usa subagentes em paralelo e depois a coerência (mais profundo e bem mais caro). Escolha Opus ou Sonnet e o esforço. "Publicar nas PRs" comenta no GitHub, só comentário, nunca aprova nem pede mudanças. Desligado, o relatório fica só aqui.',
      command: '/hades review --pr <N> --deep',
      ref: 'panel.md › Revisões',
      side: 'left',
    },
    {
      id: 'reviews-curso',
      title: 'Em curso',
      body: 'As revisões rodando agora, cada uma com a fase (na fila, buscando a PR, preparando o worktree, revisando, publicando), o fio do andamento e a execução para ver o log. Acima do teto de revisões ao mesmo tempo, as demais esperam na fila.',
      fallback: 'O card só aparece com revisão rodando. Marque PRs e clique em Revisar para ver uma.',
      side: 'top',
    },
    {
      id: 'reviews-loop',
      title: 'Loop de revisão',
      body: 'O estado do loop (rodando, pausado pelo limite de uso ou parado) e as últimas rodadas: quantas PRs revisou e pulou, o custo e os tokens, e o % das janelas de 5 h e semanal antes e depois de cada uma. O loop revisa só as PRs de head novo, de tempos em tempos.',
      command: '/hades review --loop --every 30m',
      ref: 'review.md › Loop de revisão',
      fallback: 'O card só aparece com um loop rodando ou com rodadas gravadas. Inicie um com hades review --loop; para parar, hades review loop stop.',
      side: 'top',
    },
    {
      id: 'reviews-fase',
      title: 'Fase da revisão',
      body: 'Onde a revisão está agora: na fila (esperando vaga, acima do teto de revisões ao mesmo tempo), buscando a PR, preparando o worktree, revisando ou publicando. O prazo do preparo só começa a contar quando ela sai da fila.',
      fallback: 'A fase aparece em cada revisão rodando. Marque PRs e clique em Revisar para ver uma.',
      side: 'top',
    },
    {
      id: 'reviews-historico',
      title: 'Histórico',
      body: 'As 20 últimas revisões terminadas, da mais recente para a mais antiga. É daqui que saem a frase de estado e o custo do topo.',
      fallback: 'Sem revisão terminada o card diz "Nenhuma revisão terminada ainda". Marque PRs e clique em Revisar.',
      side: 'top',
    },
    {
      id: 'reviews-linha',
      title: 'Uma revisão',
      body: 'A PR, o comando, o modelo e o esforço, o veredito (bloqueia, pede ajustes ou aprova) com as contagens de bloqueantes, importantes e in-line, se foi publicada, o custo e a duração. Os botões abrem o relatório, a execução e a PR no GitHub. O custo é o equivalente em API.',
      fallback: 'Cada linha aparece quando existe uma revisão terminada; sem nenhuma, não há o que explicar.',
      side: 'top',
    },
  ],
});
})();
