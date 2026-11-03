/* Tour da página Loop (#/loop). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX): cada string é uma chave de tradução em potencial. A prévia devolve escalações, PRs, sessões
 * e locks fictícios, marcados como exemplo, sem nome de projeto, de PR nem de pessoa reais. */
(() => {
const MIN = 60;

// o formato que GET /api/gates devolve para esta página (loop, agents, locks)
function previewLoop() {
  const now = Date.now() / 1000;
  const hours = Array.from({ length: 24 }, (_, i) => {
    const n = [0, 0, 1, 0, 0, 2, 0, 0, 0, 3, 1, 0, 0, 0, 2, 4, 1, 0, 0, 1, 0, 0, 2, 1][i] || 0;
    return n ? { hoursAgo: i, fixed: n } : { hoursAgo: i };
  });
  return {
    available: true,
    loop: {
      escalations: [{ id: 'exemplo-1', pr: 1, why: 'Exemplo: o review pede trocar a abordagem do cache, e a spec não diz qual das duas vale.', askedAt: new Date((now - 25 * MIN) * 1000).toISOString() }],
      recentPrs: [
        { pr: 1, rounds: 3, blocking: 1, review: 'red', last: now - 25 * MIN },
        { pr: 2, rounds: 2, blocking: 0, review: 'green', last: now - 3 * 3600 },
      ],
      actionsByHour: hours,
      verdicts24h: { fixed: 6, rebutted: 2, escalated: 1 },
      deliveries: { 'in-progress': 1, open: 2 },
    },
    agents: [{ pid: 1, cwd: '~/projeto-exemplo', age: 42 * MIN, rss: 380 * 1024 * 1024, gates: ['tsc'], locks: [] }],
    locks: [
      { name: 'pr-1-exemplo', agentPresent: true, mode: 'deliver', age: 18 * MIN },
      { name: 'pr-2-exemplo', agentPresent: false, mode: 'deliver', age: 5 * 3600 },
    ],
  };
}

HadesCore.registerTour('loop', {
  preview: previewLoop,
  steps: [
    {
      id: 'tour-loop',
      title: 'O loop de engenharia',
      body: 'O estado do loop que leva spec até a PR e reconcilia os reviews. A página só lê: responder, liberar lock e retomar são feitos no terminal ou na página Claude. A frase do topo resume escalações, ações em 24 h, entregas, sessões e locks.',
      command: '/hades status',
      ref: 'panel.md › Páginas',
      side: 'bottom',
    },
    {
      id: 'loop-escalacoes',
      title: 'Escalações abertas',
      body: 'Perguntas que o loop não decide sozinho e que esperam você, mais antigas primeiro, com a PR e há quanto tempo. O botão de copiar leva o /hades answer pronto para colar na página Claude.',
      command: '/hades answer <id>',
      fallback: 'O card diz "0 · tudo respondido" quando não há escalação aberta. Uma aparece quando o loop pára numa decisão que é sua.',
      side: 'bottom',
    },
    {
      id: 'loop-prs',
      title: 'PRs com atividade recente',
      body: 'As PRs mexidas nas últimas 48 h como fios, um nó por rodada de review. Fio frouxo é PR com bloqueante aberto, esperando correção. À direita, o veredito da revisão local e há quanto tempo foi a última rodada.',
      fallback: 'Sem PR mexida nas últimas 48 h o card diz isso. A lista vem das rodadas de review que o loop registra.',
      side: 'right',
    },
    {
      id: 'loop-acoes',
      title: 'Comentários de review tratados',
      body: 'Barras por hora, das últimas 24 h, com quantos comentários de review o loop tratou. A legenda separa corrigido, refutado, escalado e os demais vereditos.',
      fallback: 'Sem ação nas últimas 24 h as barras ficam rasas e a legenda diz que não houve nenhuma.',
      side: 'left',
    },
    {
      id: 'loop-sessoes',
      title: 'Sessões vivas',
      body: 'Sessões do Claude Code vivas: o clone, há quanto tempo, a memória e os gates ou locks que cada uma segura. Serve para achar quem está ocupando o gate.',
      command: 'hades gate-lock status',
      fallback: 'Sem sessão viva o card diz "Nenhuma sessão viva".',
      side: 'top',
    },
    {
      id: 'loop-locks',
      title: 'Locks de PR e deliver',
      body: 'Os locks que impedem duas sessões de mexer na mesma PR. Ponto verde: há agente segurando. Âmbar: sem agente, provável lock preso, e o botão copia /hades locks para liberar.',
      command: '/hades locks',
      ref: 'loop/ops.md',
      fallback: 'Sem lock o card diz "Nenhum lock". Eles aparecem enquanto uma PR está em entrega.',
      side: 'top',
    },
  ],
});
})();
