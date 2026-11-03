/* Tour da página Cerberus (#/cerberus). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX): cada string é uma chave de tradução em potencial. A prévia devolve as três cabeças com
 * guardas, vereditos e uma exceção fictícios, sem nome de projeto, de PR nem de pessoa reais. */
(() => {
const MIN = 60_000;

// estado de exemplo no formato que GET /api/cerberus devolve (as listas todas presentes)
function previewCerberus() {
  const now = Date.now();
  const iso = (min) => new Date(now - min * MIN).toISOString();
  const cabecas = [
    { id: 'porta', nome: 'Porta', modo: 'barra' },
    { id: 'limiar', nome: 'Limiar', modo: 'avisa' },
    { id: 'vigilia', nome: 'Vigília', modo: 'barra' },
  ];
  const guarda = (cabeca, id, titulo, tipo, momentos, descricao) =>
    ({ cabeca, id, titulo, tipo, momentos, dono: cabeca, descricao, origem: `exemplo/${cabeca}/${id}` });
  const guardas = [
    guarda('porta', 'exemplo-sem-segredo', 'Exemplo: sem segredo no push', 'exec', ['push'], 'Barra o push que leva algo parecido com credencial.'),
    guarda('porta', 'exemplo-release', 'Exemplo: release com gate verde', 'exec', ['release'], 'Só deixa publicar com a checagem passando.'),
    guarda('limiar', 'exemplo-plugin', 'Exemplo: plugin sem rota nova', 'emitida', ['push'], 'Avisa quando um plugin acrescenta rota ao painel.'),
    guarda('vigilia', 'exemplo-done', 'Exemplo: DONE coerente com o plano', 'regra', ['consolidacao'], 'Regra escrita; quem confere é o orquestrador.'),
  ];
  const ver = (min, cabeca, guardaId, momento, resultado, efeito, detalhe) =>
    ({ ts: iso(min), avaliacao: `exemplo-${min}`, cabeca, guarda: guardaId, momento, modo: 'barra', resultado, efeito, detalhe,
      evidencia: [{ conferido: 'Exemplo de evidência conferida', onde: 'exemplo/arquivo.txt' }], ctx: { pr: '1' } });
  const historico = [
    ver(300, 'porta', 'exemplo-sem-segredo', 'push', 'ok', 'ok', ''),
    ver(200, 'limiar', 'exemplo-plugin', 'push', 'aviso', 'aviso', 'Exemplo: o plugin acrescentou uma rota.'),
    ver(120, 'porta', 'exemplo-sem-segredo', 'push', 'barra', 'barra', 'Exemplo: padrão de segredo no conteúdo.'),
    ver(60, 'porta', 'exemplo-release', 'release', 'ok', 'ok', ''),
    { ...ver(30, 'porta', 'exemplo-sem-segredo', 'push', 'barra', 'liberado', 'Exemplo: liberado por exceção.'),
      excecao: { id: 'exemplo-exc-1', motivo: 'Exemplo: falso positivo conhecido neste arquivo de teste.', por: 'exemplo', aberta: iso(40) } },
  ];
  const barrados = [{ cabeca: 'porta', guarda: 'exemplo-sem-segredo', vezes: 2, ultimo: historico[4] }];
  const excecoes = [{ id: 'exemplo-exc-1', cabeca: 'porta', guarda: 'exemplo-sem-segredo', momento: 'push', alvo: { pr: '1' },
    motivo: 'Exemplo: falso positivo conhecido neste arquivo de teste.', origem: 'painel', aberta: iso(40), expira: now / 1000 + 3600, usada: true }];
  return { erros: [], cabecas, guardas, historico, barrados, excecoes, blocos: [], total: historico.length, store: '~/.claude/hades/exemplo/cerberus', ttlH: 24, remote: false };
}

HadesCore.registerTour('cerberus', {
  preview: previewCerberus,
  steps: [
    {
      id: 'tour-cerberus',
      title: 'As guardas do Hades',
      body: 'O Cerberus confere o que sai, o que entra e o que acontece dentro do projeto, e registra um veredito por checagem. A página lê esse registro; mudar o modo de uma cabeça é em Configurações, só no painel local.',
      command: 'hades cerberus estado',
      ref: 'panel.md › Cerberus',
      side: 'bottom',
    },
    {
      id: 'cerberus-estado',
      title: 'Resumo',
      body: 'Quanto foi barrado nos vereditos mais recentes, quantas guardas há em quantas cabeças, se existe exceção aberta e quando saiu o último veredito. Arquivo do registro com erro aparece em vermelho aqui.',
      command: 'hades cerberus estado',
      side: 'bottom',
    },
    {
      id: 'cerberus-registro',
      title: 'Registro com erro',
      body: 'Aparece só quando um arquivo do registro não pôde ser lido. Enquanto isso as avaliações da cabeça são recusadas; corrija o arquivo e recarregue.',
      command: 'hades cerberus estado',
      fallback: 'O cartão só aparece quando um arquivo do registro está com erro. Com o registro são, ele não existe, e é o esperado.',
      side: 'bottom',
    },
    {
      id: 'cerberus-cabecas',
      title: 'As três cabeças',
      body: 'Porta olha o que sai (push, comentário de PR, artefato, túnel, release), Limiar o que entra (plugin, hooks, páginas e rotas) e Vigília o que acontece dentro (DONE e coerência entre plano, registro e realidade).',
      command: 'hades cerberus guardas',
      ref: 'cerberus.md',
      fallback: 'Sem cabeça registrada a página mostra o aviso de registro vazio. Reinstale a skill (hades env update) para restaurar o registro.',
      side: 'top',
    },
    {
      id: 'cerberus-modo',
      title: 'O modo de cada cabeça',
      body: 'Barra bloqueia, avisa deixa passar e registra, desligada não avalia. O link leva às Configurações do Cerberus, onde o modo muda, e só no painel local.',
      ref: 'cerberus.md',
      fallback: 'O modo aparece no topo de cada cabeça, que só existe com o registro carregado.',
      side: 'bottom',
    },
    {
      id: 'cerberus-tracos',
      title: 'Vereditos recentes',
      body: 'Um traço por veredito, dos mais antigos aos mais novos: verde passou, amarelo avisou, vermelho barrou, apagado foi liberado por exceção. A legenda abaixo conta cada tipo.',
      fallback: 'Os traços aparecem depois do primeiro veredito da cabeça. Cada push, release, plugin e DONE avaliado gera um.',
      side: 'top',
    },
    {
      id: 'cerberus-guardas',
      title: 'As guardas',
      body: 'Ver as guardas abre a lista da cabeça: título, tipo (executa, emitida ou só regra escrita), momentos em que age e de onde vem a regra.',
      command: 'hades cerberus guardas',
      fallback: 'A lista vem com as guardas da cabeça. Cabeça sem guarda mostra a frase de que nenhuma foi registrada.',
      side: 'top',
    },
    {
      id: 'cerberus-barrados',
      title: 'O que cada guarda barrou',
      body: 'Por guarda, quantas vezes barrou no histórico e a evidência do último caso: o que foi conferido e onde.',
      command: 'hades cerberus historico',
      fallback: 'Sem nenhum veredito de bloqueio o cartão fica só com o título e "nada barrado". Ele se enche quando uma guarda barrar algo.',
      side: 'top',
    },
    {
      id: 'cerberus-excecoes',
      title: 'Exceções',
      body: 'Uma exceção libera uma única vez o veredito de barra de uma guarda num momento, por até 24 h, com motivo registrado. A lista mostra as abertas, as usadas e as expiradas.',
      command: 'hades cerberus excecao listar',
      ref: 'cerberus.md',
      fallback: 'Sem exceção, o cartão mostra só o título e "nenhuma". Abra a primeira pelo botão Abrir exceção ou pelo terminal.',
      side: 'top',
    },
    {
      id: 'cerberus-abrir',
      title: 'Abrir exceção',
      body: 'Escolha a guarda, o momento, um alvo opcional (chave=valor, como pr=12) e o motivo, de 10 a 500 caracteres. Só no painel local ou no terminal; durante este tour o botão fica desligado.',
      command: 'hades cerberus excecao abrir',
      fallback: 'No acesso remoto o botão fica desligado: a exceção só se abre no painel local ou no terminal.',
      side: 'left',
    },
    {
      id: 'cerberus-historico',
      title: 'Histórico de vereditos',
      body: 'Os 500 vereditos mais recentes, do mais novo ao mais antigo. Clique numa linha para ver a evidência, o contexto e a exceção que liberou.',
      command: 'hades cerberus historico',
      fallback: 'O histórico se enche a cada push, release, plugin e DONE avaliado. Sem nenhum, a tabela mostra a frase de que não há veredito ainda.',
      side: 'top',
    },
    {
      id: 'cerberus-filtros',
      title: 'Filtrar por cabeça e efeito',
      body: 'Filtre por cabeça (Porta, Limiar, Vigília) e por efeito (passou, avisou, barrou, liberado). O número ao lado de cada opção é quantos vereditos ela tem.',
      fallback: 'Os filtros ficam no histórico, que só mostra a tabela com vereditos registrados.',
      side: 'bottom',
    },
    {
      id: 'cerberus-terminal',
      title: 'No terminal',
      body: 'O caminho do registro e os comandos para ler o mesmo que a página mostra: estado, guardas, historico e excecao listar.',
      command: 'hades cerberus estado',
      side: 'top',
    },
  ],
});
})();
