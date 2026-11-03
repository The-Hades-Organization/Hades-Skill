/* Tour da página Thanatos (#/thanatos). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX): cada string é uma chave de tradução em potencial. A prévia devolve post-mortems fictícios,
 * marcados como exemplo, sem nome de projeto, de PR nem de pessoa reais. */
(() => {
const MIN = 60_000;

// dois post-mortems de exemplo no formato que GET /api/thanatos e /api/thanatos/:id devolvem
function previewThanatos() {
  const base = Date.now() - 3 * 24 * 60 * MIN;
  const at = (min) => new Date(base + min * MIN).toISOString();
  const fixed = {
    id: 'EXEMPLO-1',
    title: 'Exemplo: fila de envio travada por chamada sem limite de tempo',
    summary: 'Os envios pararam por cerca de duas horas porque uma chamada externa ficou pendurada e prendeu a fila inteira.',
    impact: 'Exemplo: os envios ficaram parados por 2 h 40 min.',
    cause: 'A chamada ao serviço externo não tinha limite de tempo; quando ele parou de responder, cada tentativa ficou pendurada e a fila não andou.',
    fix: 'Foi posto um limite de tempo na chamada, com nova tentativa depois de uma pausa. A PR de exemplo #1 foi mergeada.',
    timeline: [
      { ts: at(0), source: 'diario', text: 'Primeiro alerta: a fila de envio parou de andar.' },
      { ts: at(35), source: 'gh', text: 'Aberta a investigação (PR de exemplo #1).' },
      { ts: at(120), source: 'git', text: 'Primeiro commit da correção: limite de tempo na chamada.' },
      { ts: at(160), source: 'gh', text: 'PR de exemplo #1 mergeada; a fila voltou a andar.' },
    ],
    fixData: { prs: [{ number: 1, author: 'pessoa-exemplo', mergedAt: at(160) }], commits: [{ sha: 'aaaaaaa' }, { sha: 'bbbbbbb' }],
      timeToFix: { from: at(0), to: at(160), ms: 160 * MIN, basis: 'fonte' } },
    gaps: [],
    createdAt: at(170),
  };
  const open = {
    id: 'EXEMPLO-2',
    title: 'Exemplo: cache servindo preço antigo',
    summary: 'Alguns clientes viram o preço de ontem durante a manhã. A correção ainda não foi mergeada.',
    impact: 'Exemplo: preços desatualizados para parte dos clientes.',
    cause: '(a preencher)',
    fix: '(a preencher)',
    timeline: [
      { ts: at(1500), source: 'fonte', text: 'Cliente de exemplo avisou do preço antigo.' },
      { ts: at(1560), source: 'diario', text: 'Cache limpo à mão; o problema voltou depois.' },
    ],
    fixData: { prs: [], commits: [], timeToFix: null },
    gaps: ['Causa', 'Como foi corrigido'],
    createdAt: at(1600),
  };
  const md = (pm) => [
    `# Post-mortem ${pm.id}: ${pm.title}`, '', 'Gerado em exemplo (UTC) por `hades thanatos new`.', '',
    '## Resumo', pm.summary, '', '## Impacto', pm.impact, '', '## Linha do tempo (UTC)',
    ...pm.timeline.map((e) => `- ${e.ts} · ${e.source} · ${e.text}`), '',
    '## Causa', pm.cause, '', '## Como foi corrigido', pm.fix, '', '## Lacunas',
    ...(pm.gaps.length ? pm.gaps.map((g) => `- ${g}`) : ['- (nenhum)']), '',
  ].join('\n');
  const doc = (pm) => ({ id: pm.id, markdown: md(pm), postmortem: pm });
  const item = (pm) => ({ id: pm.id, title: pm.title, createdAt: pm.createdAt, timeToFixMs: pm.fixData.timeToFix ? pm.fixData.timeToFix.ms : null, gaps: pm.gaps.length });
  return { items: [item(fixed), item(open)], docs: { [fixed.id]: doc(fixed), [open.id]: doc(open) } };
}

HadesCore.registerTour('thanatos', {
  preview: previewThanatos,
  steps: [
    {
      id: 'tour-thanatos',
      title: 'Post-mortems do projeto',
      body: 'Aqui ficam os post-mortems de incidente e de bug em produção do projeto. A página só lê: nada aqui muda o repositório. Os documentos ficam fora dele.',
      command: 'hades thanatos list',
      ref: 'panel.md › Thanatos',
      side: 'bottom',
    },
    {
      id: 'thanatos-lista',
      title: 'A lista',
      body: 'Do mais novo ao mais antigo, com o tempo até a correção e as seções que ainda faltam preencher. Clique num item para ler.',
      command: 'hades thanatos list',
      fallback: 'A lista aparece quando houver pelo menos um post-mortem. Gere o primeiro com hades thanatos new <PR>.',
      side: 'right',
    },
    {
      id: 'thanatos-filtro',
      title: 'Filtrar',
      body: 'Filtra a lista por id ou título, sem diferenciar maiúsculas. Para buscar dentro do texto, use o terminal.',
      command: 'hades thanatos search <termo>',
      fallback: 'O filtro vem junto com a lista, que só aparece com post-mortems gerados.',
      side: 'right',
    },
    {
      id: 'thanatos-linha',
      title: 'Linha do tempo',
      body: 'Os eventos do incidente, no seu fuso. O fio é cheio até o início da contagem, tracejado em vermelho até a correção e cheio de novo depois dela.',
      fallback: 'A linha do tempo vem do post-mortem aberto. Sem nenhum, não há o que desenhar.',
      ref: 'thanatos.md › Esquema do .json',
      side: 'top',
    },
    {
      id: 'thanatos-causa',
      title: 'Causa',
      body: 'O que fez o incidente acontecer. Esta seção costuma pedir revisão: edite o arquivo .md para refinar o texto que a ferramenta montou.',
      fallback: 'A seção aparece dentro do documento de um post-mortem. Abra um da lista.',
      side: 'top',
    },
    {
      id: 'thanatos-correcao',
      title: 'Como foi corrigido',
      body: 'A correção e os dados dela: PRs, commits, autores e arquivos tocados, tirados do git e do GitHub.',
      fallback: 'A seção aparece dentro do documento de um post-mortem. Abra um da lista.',
      side: 'top',
    },
    {
      id: 'thanatos-lacunas',
      title: 'Lacunas',
      body: 'O que a ferramenta não achou nas PRs e ficou em branco. A lista mostra quantas faltam; preencha editando o .md.',
      fallback: 'A seção aparece dentro do documento de um post-mortem. Abra um da lista.',
      side: 'top',
    },
    {
      id: 'thanatos-gerar',
      title: 'Gerar um novo',
      body: 'A página não cria nada; quem gera é o terminal. Passe uma PR, um card ou um intervalo de datas com fuso.',
      command: 'hades thanatos new 123',
      ref: 'thanatos.md › Entradas',
      fallback: 'Sem post-mortem, a página mostra só o comando para gerar o primeiro: hades thanatos new <PR>.',
      side: 'top',
    },
  ],
});
})();
