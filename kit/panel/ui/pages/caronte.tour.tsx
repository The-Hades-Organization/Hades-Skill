/* Tour da página Caronte (#/caronte). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto e dados (sem JSX): cada string é uma chave de tradução em potencial. A prévia devolve dois planos fictícios,
 * marcados como exemplo, sem nome de projeto, de agente, de PR nem de pessoa reais. */
(() => {
const MIN = 60_000;

// dois planos de exemplo no formato que GET /api/caronte e GET /api/caronte/plan/<nome> devolvem
function previewCaronte() {
  const now = Date.now();
  const at = (min) => new Date(now - min * MIN).toISOString();
  const dir = '~/.claude/hades/caronte';
  const pronto = {
    name: 'exemplo-plano-pronto',
    ready: true,
    missing: [],
    modifiedAt: at(90),
    agents: [
      { name: 'exemplo-agente-a', readiness: 'parked', canPark: false },
      { name: 'exemplo-agente-b', readiness: 'ended', canPark: false },
    ],
  };
  const aEstacionar = {
    name: 'exemplo-plano-em-voo',
    ready: false,
    missing: ['exemplo-agente-c'],
    modifiedAt: at(20),
    agents: [
      { name: 'exemplo-agente-c', readiness: 'working', canPark: true },
      { name: 'exemplo-agente-d', readiness: 'parked', canPark: false },
    ],
  };
  const pacote = { name: 'exemplo-plano-pronto-20260101T000000Z.caronte', size: 482_304, modifiedAt: at(45),
    unpack: 'hades caronte unpack ' + dir + '/exemplo-plano-pronto-20260101T000000Z.caronte' };
  const commands = (plan) => ({ pack: `hades caronte pack ${plan}`, dryRun: `hades caronte pack ${plan} --dry-run`, unpack: 'hades caronte unpack <pacote>' });
  const brief = (plan) => `Exemplo de prompt de retomada do plano ${plan}.\n\nLeia o plano, confira os agentes estacionados e continue de onde o handoff de cada um parou.`;
  return {
    data: { plans: [pronto, aEstacionar], packages: [pacote], packagesDir: dir },
    details: {
      [pronto.name]: {
        preview: {
          parts: [{ path: 'plano/exemplo-plano-pronto.md', size: 4_096 }, { path: 'worktrees/exemplo-agente-a/handoff.md', size: 2_048 }],
          worktrees: [{ agent: 'exemplo-agente-a', branch: 'exemplo/ramo-a', baseRef: 'main', bundle: true, patch: false }],
          blocked: [], rawBytes: 612_352,
        },
        previewError: null, brief: brief(pronto.name), agents: pronto.agents, commands: commands(pronto.name),
      },
      [aEstacionar.name]: {
        preview: null, previewError: { code: 'not_ready', agents: ['exemplo-agente-c'] },
        brief: brief(aEstacionar.name), agents: aEstacionar.agents, commands: commands(aEstacionar.name),
      },
    },
  };
}

HadesCore.registerTour('caronte', {
  preview: previewCaronte,
  steps: [
    {
      id: 'tour-caronte',
      title: 'Levar uma orquestração a outra sessão ou máquina',
      body: 'O Caronte empacota um plano da orquestração num arquivo cifrado e ajuda a retomá-lo do outro lado. Três travessias: estacionar os agentes, empacotar e retomar. A página lê e estaciona; o pack e o unpack ficam no terminal.',
      command: 'hades caronte pack <plano>',
      ref: 'panel.md › Caronte',
      side: 'bottom',
    },
    {
      id: 'caronte-resumo',
      title: 'Resumo',
      body: 'Quantos planos já estão prontos para o pack, quantos ainda têm agente a estacionar e quantos pacotes existem. Atualiza sozinho a cada 10 s.',
      fallback: 'O resumo aparece quando existe pelo menos um plano. Os planos ficam em ~/.claude/hades/plans; o orquestrador grava um ao começar.',
      side: 'bottom',
    },
    {
      id: 'caronte-planos',
      title: 'Os planos',
      body: 'Um item por plano do orquestrador, do mais novo ao mais antigo (até 100), com a prontidão e o número de agentes. No celular vira um seletor. Escolher um plano troca tudo que está abaixo.',
      fallback: 'Sem plano, a página mostra só o aviso de que nenhum existe. Inicie uma orquestração com o orquestrador e o plano aparece aqui.',
      side: 'right',
    },
    {
      id: 'caronte-travessia',
      title: 'A travessia',
      body: 'Estacionar, Empacotar e Retomar, com o estado de cada margem: o losango cheio é o que já atravessou, o círculo é onde o plano está e o vazio é o que falta. Clicar rola até a seção.',
      fallback: 'A travessia mostra o plano escolhido. Sem plano, não há o que desenhar.',
      side: 'bottom',
    },
    {
      id: 'caronte-estacionar',
      title: 'Estacionar',
      body: 'O pack exige agentes estacionados ou encerrados. Estacionar faz o agente commitar o que está pronto, gravar o handoff e parar, sem fechar o terminal, em até 10 min.',
      command: 'hades agent park <agente>',
      ref: 'caronte.md',
      fallback: 'A seção aparece com um plano escolhido. Sem plano, não há agente para estacionar.',
      side: 'top',
    },
    {
      id: 'caronte-park',
      title: 'Segure para estacionar',
      body: 'O botão pede que você segure por 1,2 s para não estacionar sem querer. Só aparece para o agente que ainda trabalha; o estacionado ou encerrado já atravessa. Durante este tour o botão fica desligado.',
      command: 'hades agent park <agente>',
      fallback: 'O botão só aparece para agente ainda trabalhando. Com todos estacionados ou encerrados o plano está pronto para o pack.',
      side: 'left',
    },
    {
      id: 'caronte-empacotar',
      title: 'Empacotar',
      body: 'A prévia roda o pack em modo de ensaio, sem gravar nada, para você ver o que iria no pacote antes de gerá-lo.',
      command: 'hades caronte pack <plano> --dry-run',
      ref: 'caronte.md',
      fallback: 'A seção aparece com um plano escolhido.',
      side: 'top',
    },
    {
      id: 'caronte-previa',
      title: 'Prévia do pacote',
      body: 'Partes (arquivos do plano e das worktrees), worktrees, tamanho estimado antes do gzip e da cifra, e o que a guarda de segredo barraria, só caminho e regra, nunca o valor. Com agente trabalhando não há prévia: o pack recusaria.',
      command: 'hades caronte pack <plano> --dry-run',
      fallback: 'Sem a prévia, a página nomeia o agente que falta estacionar ou mostra o comando para ver o motivo no terminal.',
      side: 'top',
    },
    {
      id: 'caronte-pack',
      title: 'O comando do pack',
      body: 'Copie e rode no terminal: a senha é digitada só lá, nunca passa pelo navegador. Esquecida a senha, o pacote se perde.',
      command: 'hades caronte pack <plano>',
      fallback: 'O comando vem do plano escolhido e aparece quando o detalhe dele carrega.',
      side: 'top',
    },
    {
      id: 'caronte-retomar',
      title: 'Retomar',
      body: 'Na outra máquina, abra o pacote e entregue o prompt de retomada ao orquestrador de lá.',
      command: 'hades caronte unpack <pacote>',
      ref: 'caronte.md',
      fallback: 'A seção aparece com um plano escolhido.',
      side: 'top',
    },
    {
      id: 'caronte-pacotes',
      title: 'Pacotes gerados',
      body: 'Os arquivos .caronte da pasta de saída, com tamanho e idade; os do plano escolhido vêm primeiro. A página só lista: o conteúdo é cifrado e nunca é lido. O botão de cada linha copia o comando que abre o pacote.',
      command: 'hades caronte unpack <pacote>',
      fallback: 'Nenhum pacote ainda. Rode hades caronte pack <plano> no terminal; o arquivo cai em HADES_CARONTE_OUT_DIR (padrão ~/.claude/hades/caronte).',
      side: 'top',
    },
    {
      id: 'caronte-brief',
      title: 'Prompt de retomada',
      body: 'O texto que você entrega ao orquestrador da outra máquina para ele continuar de onde o plano parou. Vem do hades caronte brief; o botão copia.',
      command: 'hades caronte brief <plano>',
      fallback: 'O prompt aparece quando o detalhe do plano carrega; sem ele a página diz que não há prompt.',
      side: 'top',
    },
  ],
});
})();
