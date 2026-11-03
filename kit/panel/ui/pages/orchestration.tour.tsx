/* Tour da página Orquestração (#/orchestration). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX): cada string é uma chave de tradução em potencial. A prévia devolve agentes, consolidação e
 * decisões fictícios, marcados como exemplo, sem nome de projeto, de PR nem de pessoa reais. */
(() => {
const MIN = 60_000;

// o formato que GET /api/orchestration devolve
function previewOrchestration() {
  const at = (min) => new Date(Date.now() - min * MIN).toISOString();
  const agent = (o) => ({ mode: 'impl', card: null, title: '', worktree: '~/exemplo', branch: null, pr: null, pane: null, state: 'active',
    questions: 0, openQuestions: [], reportDone: false, files: ['brief'], ...o });
  return {
    reportsDir: '.design-sync-reports',
    agents: [
      agent({ name: 'exemplo-a', live: 'blocked', title: 'Exemplo: item que espera uma decisão', branch: 'exemplo/item-a', questions: 1,
        openQuestions: ['Q1 — qual abordagem de cache vale?'], files: ['brief', 'questions'] }),
      agent({ name: 'exemplo-b', live: 'working', title: 'Exemplo: item em andamento', branch: 'exemplo/item-b', pr: 1 }),
      agent({ name: 'exemplo-c', live: 'idle', title: 'Exemplo: item pronto', branch: 'exemplo/item-c', pr: 2, reportDone: true, files: ['brief', 'report'] }),
      agent({ name: 'exemplo-d', live: 'fora', state: 'done', branch: 'exemplo/item-d', pr: 3, files: ['brief', 'report'] }),
    ],
    consolidations: [{ branch: 'exemplo/consolidacao', members: [1, 2, 3], verifyOk: true, verifiedAt: at(30) }],
    autonomy: { level: 1, label: 'Decide o óbvio' },
    decisions: [{ ts: at(90), question: 'Exemplo: qual nome dar ao novo arquivo?', level: 1, needed: 1, chosen: 'O nome da convenção vizinha.', alternatives: ['Um nome novo', 'Perguntar ao dono'] }],
  };
}

HadesCore.registerTour('orchestration', {
  preview: previewOrchestration,
  steps: [
    {
      id: 'tour-orchestration',
      title: 'Orquestração de agentes',
      body: 'O orquestrador reparte um plano em agentes, cada um com a sua worktree, e junta o resultado numa consolidação. Esta página mostra quem está ativo, o que espera você e o que foi decidido sozinho. Os dados vêm do registro de agentes e se atualizam a cada 5 s.',
      command: 'hades agent list',
      ref: 'panel.md › Orquestração',
      side: 'bottom',
    },
    {
      id: 'orchestration-perguntas',
      title: 'Perguntas ao dono',
      body: 'Dúvidas que um agente deixou no questions.md e só você decide. "Ler e responder" abre o arquivo; o botão de copiar leva o comando de resposta. O agente segue com o que não depende da resposta.',
      command: 'hades agent answer <agente> <Qn> "<resposta>"',
      ref: 'panel.md › Orquestração',
      fallback: 'O card só aparece com pergunta aberta. Um agente a abre escrevendo "## Qn" no questions.md da worktree dele.',
      side: 'bottom',
    },
    {
      id: 'orchestration-agentes',
      title: 'Agentes',
      body: 'Um cartão por agente ativo, com o fio do estado: trabalhando, ocioso, esperando você ou fora do herdr. Quem espera por você vem primeiro. A pasta no resumo é onde cada agente deixa brief, perguntas, relatório e handoff.',
      command: 'hades agent new',
      fallback: 'Sem agente ativo o card ensina a alocar: hades agent new ou hades agent adopt.',
      side: 'top',
    },
    {
      id: 'orchestration-agente',
      title: 'O cartão do agente',
      body: 'Nome, modo, card, a branch e a PR, perguntas abertas e se o relatório está pronto. Os botões abrem Brief, Perguntas, Relatório e Handoff na lateral; o ícone abre o terminal do agente, e "Abrir no Herdr" leva ao painel dele.',
      command: 'hades agent list',
      fallback: 'O cartão vem com o agente: aloque o primeiro com hades agent new.',
      side: 'right',
    },
    {
      id: 'orchestration-consolidacoes',
      title: 'Consolidações',
      body: 'A PR que junta as dos agentes para um gate único e um merge único. O ponto diz se a branch contém todas as PRs; a linha diz há quanto tempo foi conferida.',
      command: 'hades consolidate verify',
      ref: 'loop/consolidate.md',
      fallback: 'Sem consolidação registrada o card diz isso. Ela nasce quando o orquestrador junta as PRs de vários agentes.',
      side: 'top',
    },
    {
      id: 'orchestration-decisoes',
      title: 'Decisões autônomas',
      body: 'O que o orquestrador decidiu sozinho pela opção recomendada, com a pergunta, a escolha e as alternativas. O nível de autonomia, que decide o que ele pode resolver sem você, fica em Configurações.',
      ref: 'panel.md › Autonomia do orquestrador (Configurações e Orquestração)',
      fallback: 'Com o nível 0 ("Pergunta tudo") nada é decidido sozinho e o card diz "Nenhuma decisão autônoma". Suba o nível em Configurações para ligar.',
      side: 'top',
    },
    {
      id: 'orchestration-encerrados',
      title: 'Encerrados',
      body: 'Os agentes concluídos ou arquivados ficam recolhidos aqui, com os arquivos deles ainda abertos para consulta.',
      fallback: 'A seção só existe quando algum agente terminou ou foi arquivado.',
      side: 'top',
    },
  ],
});
})();
