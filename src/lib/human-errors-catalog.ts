// Catálogo das explicações de erro para humano (reference/erros.md). A chave é o código estável que já cruza a fronteira
// (campo `code` das respostas do painel, enums `*_ERRORS` do src/); o texto é só para quem lê e nunca é comparado por
// código. Regras do texto: pt-BR direto, sem nome de função nem pilha, sem dado de runtime (o dado que sustenta a causa
// vai na mensagem original, ao lado), ação com o comando pronto entre crases e referência no formato
// `reference/<arquivo>.md §<título da seção>` (o teste confere que a seção existe).
//
// Os códigos das enums ficam como texto literal aqui, sem importar os módulos de canvas: o catálogo é carregado pela CLI e
// pelo hook, e o código estável só ganha valores (fw.erro-com-codigo-estavel). O teste importa as enums e exige uma
// entrada para cada código do inventário prioritário.

export interface HumanError {
  title: string;
  cause: string;
  action: string;
  ref: string;
}

const PANEL = "reference/panel.md";
const DOCTOR = "reference/doctor.md";
const ARGOS = "reference/argos.md";

/** Códigos que só existem no navegador (o painel nem respondeu); o componente da UI repete o texto de `panel_unreachable`. */
export const CLIENT_ERRORS = { panelUnreachable: "panel_unreachable" } as const;

/** Códigos da CLI que não vêm de uma enum: classe do erro (uso, perfil, dependência) e falha sem causa conhecida. */
export const CLI_ERRORS = {
  unknownCommand: "cli_unknown_command",
  usage: "cli_usage",
  failed: "cli_failed",
  noProfile: "cli_no_profile",
  outsideRepo: "cli_outside_repo",
  missingDependency: "cli_missing_dependency",
  unexpected: "cli_unexpected",
  gateNotAdmitted: "gate_not_admitted",
  agentNameMissing: "cli_agent_name_missing",
  projectFieldMissing: "cli_project_field_missing",
} as const;

/** Códigos das recusas do hook que barra comando de ferramenta do Claude (a razão sai em stderr, com exit 2). */
export const HOOK_ERRORS = {
  gateOutsideQueue: "hook_gate_outside_queue",
  pollingBlocked: "hook_polling_blocked",
  pollingRepeated: "hook_polling_repeated",
  cerberusOwnerOnly: "hook_cerberus_owner_only",
  autonomyOwnerOnly: "hook_autonomy_owner_only",
  rtkOwnerOnly: "hook_rtk_owner_only",
} as const;

/** Códigos das respostas do painel que nasceram sem `code` (só `error`): agora levam um, ao lado do texto de sempre. */
export const PANEL_ERRORS = {
  host: "panel_host",
  origin: "panel_origin",
  token: "panel_token",
  json: "panel_json",
  remoteKey: "panel_remote_key",
  notFound: "panel_not_found",
  envBusy: "env_busy",
  chatBusy: "chat_busy",
  badRequest: "panel_bad_request",
  postMortemNotFound: "postmortem_not_found",
} as const;

export const HUMAN_ERRORS: Readonly<Record<string, HumanError>> = {
  // ------------------------------------------------------------------ CLI
  [CLI_ERRORS.unknownCommand]: {
    title: "Esse subcomando não existe",
    cause: "O nome depois de `hades` não bate com nenhum subcomando. Em geral é erro de digitação ou um comando de uma versão diferente da skill.",
    action: "Veja a lista com `hades --help`. Se a skill está desatualizada, rode `hades version-check status`.",
    ref: "reference/cli.md §install",
  },
  [CLI_ERRORS.usage]: {
    title: "Faltou ou sobrou argumento no comando",
    cause: "O comando foi chamado sem algo que ele precisa (um nome, um número, uma opção) ou com algo que ele não conhece.",
    action: "Confira o uso do comando em `hades --help` e, para o pedido em linguagem comum, em `reference/pedidos.md`.",
    ref: "reference/pedidos.md §Pedidos típicos do dono",
  },
  [CLI_ERRORS.failed]: {
    title: "O comando não conseguiu terminar",
    cause: "A operação foi recusada ou falhou por um motivo que a mensagem acima descreve; ele não tem um código próprio ainda.",
    action: "Leia a mensagem acima e rode `hades doctor --quick`: ele aponta o que falta na máquina e o comando que corrige.",
    ref: `${DOCTOR} §O que checa e como corrigir`,
  },
  [CLI_ERRORS.noProfile]: {
    title: "Este repositório ainda não tem perfil da Hades",
    cause: "O comando precisa saber os comandos de build, teste e gate do projeto, e eles ficam no perfil do repositório. Não achei um aqui.",
    action: "Rode `hades project-init draft` dentro do repositório para gerar o rascunho do perfil e depois `hades project-init save`.",
    ref: "reference/project-init.md §Fluxo",
  },
  [CLI_ERRORS.outsideRepo]: {
    title: "Você está fora de um repositório git",
    cause: "O comando trabalha sobre um repositório e a pasta atual não pertence a nenhum.",
    action: "Entre na pasta do projeto (`cd <pasta do repositório>`) ou aponte-a com `--dir <pasta>`.",
    ref: "reference/projects.md §Resolvedor do projeto ativo",
  },
  [CLI_ERRORS.missingDependency]: {
    title: "Falta uma ferramenta instalada na máquina",
    cause: "O comando usa um programa externo (gh, docker, herdr, git, jq, bun…) que não está no PATH.",
    action: "Rode `hades deps` para ver o que falta e como instalar cada coisa; depois repita o comando.",
    ref: "reference/cli.md §Registro único de dependências (`src/deps/registry.tsv`)",
  },
  [CLI_ERRORS.unexpected]: {
    title: "A Hades tropeçou num erro que ela não esperava",
    cause: "Algo saiu do previsto (arquivo corrompido, estado antigo ou um defeito). O detalhe técnico fica fora desta tela de propósito.",
    action: "Rode `hades doctor` e repita o comando. Para ver o detalhe técnico, repita com `HADES_DEBUG=1` na frente.",
    ref: `${DOCTOR} §Armadilhas`,
  },
  [CLI_ERRORS.agentNameMissing]: {
    title: "Faltou o nome do agente",
    cause: "`hades agent new` precisa do nome como primeiro argumento: é ele que vira a pasta do trabalho e o rótulo do agente.",
    action: "Rode `hades agent new <nome> ...` (veja `hades agent --help`) ou peça em linguagem comum: \"cria um agente para a tarefa X\".",
    ref: "reference/pedidos.md §Pedidos típicos do dono",
  },
  [CLI_ERRORS.projectFieldMissing]: {
    title: "Faltou dizer qual campo do projeto ler",
    cause: "`hades project get` e `ref` leem um campo ou nome do perfil do projeto, e o comando veio sem ele.",
    action: "Informe o campo (`hades project get <campo>`, `hades project ref <nome>`). Para ver o que existe, rode `hades project resolve`.",
    ref: "reference/projects.md §Perfil de projeto (`hades.profile/1`)",
  },
  [CLI_ERRORS.gateNotAdmitted]: {
    title: "A fila de gates não liberou a sua vez",
    cause: "Há gates demais rodando ou pouca memória livre: a fila admite um de cada vez para não derrubar a máquina.",
    action: "Veja a fila com `hades gate-lock status` e espere com `hades wait queue <label>` (em segundo plano), sem repetir a checagem.",
    ref: "reference/loop/gates.md §3. Locks (estado global, execução local)",
  },

  // ------------------------------------------------------------------ hook que barra comando
  [HOOK_ERRORS.gateOutsideQueue]: {
    title: "Teste, lint ou build precisa passar pela fila de gates",
    cause: "Esses comandos pesam na máquina; a fila deixa um rodar de cada vez e guarda o resultado para o loop reaproveitar.",
    action: "Embrulhe o comando: `~/.claude/skills/hades/kit/gate/gate-lock.sh run <tipo> --label <agente> -- <comando>`, em segundo plano.",
    ref: "reference/loop/gates.md §3.2 Fila de admissão de gate (memória primeiro)",
  },
  [HOOK_ERRORS.pollingBlocked]: {
    title: "Esperar com laço ou sleep gasta turno à toa",
    cause: "Cada checagem em primeiro plano relê o contexto inteiro da conversa; uma espera por evento acorda a sessão só quando algo muda.",
    action: "Rode a espera em segundo plano com `hades wait <evento>` (ci, gate, queue, review, agent, proc) e leia o resultado quando ela terminar.",
    ref: "reference/loop/tokens.md §As sete regras (todas configuráveis no painel)",
  },
  [HOOK_ERRORS.pollingRepeated]: {
    title: "Essa mesma checagem acabou de rodar",
    cause: "Repetir o mesmo comando dentro da janela configurada quase nunca traz dado novo e custa um turno cheio de contexto.",
    action: "Espere pelo evento com `hades wait <evento>` em segundo plano. A janela fica nas Configurações (`HADES_POLL_REPEAT_MIN`).",
    ref: "reference/loop/tokens.md §As sete regras (todas configuráveis no painel)",
  },
  [HOOK_ERRORS.cerberusOwnerOnly]: {
    title: "Exceção e modo do Cerberus são só do dono",
    cause: "O Cerberus é a trava que o agente não pode afrouxar sozinho; só a pessoa dona da máquina muda exceção, rota ou modo.",
    action: "Faça pelo painel (página Cerberus, Configurações) ou no terminal com `!`. Para ler, use `hades cerberus historico`.",
    ref: "reference/cerberus.md §Exceção",
  },
  [HOOK_ERRORS.autonomyOwnerOnly]: {
    title: "Nível de autonomia e auto-alocação são só do dono",
    cause: "Quanto o orquestrador decide sozinho é escolha da pessoa dona; o agente não sobe o próprio nível.",
    action: "Mude no painel (Configurações → Orquestração) ou no terminal com `!`. Para ler, use `hades agent auto-start status`.",
    ref: "reference/autonomia.md §Níveis (`HADES_ORCH_AUTONOMY`, 0 a 3, controle deslizante no painel)",
  },
  [HOOK_ERRORS.rtkOwnerOnly]: {
    title: "A política dos resumidores do rtk é só do dono",
    cause: "O rtk resume a saída dos comandos; quem decide em qual filtro confiar é a pessoa dona, não o agente que lê a saída.",
    action: "Mude no painel (Configurações → Resumidores (rtk)) ou com `!`. Para ver a saída sem filtro, use `rtk proxy <comando>`.",
    ref: "reference/rtk.md §Confiança (`rtk trust`)",
  },

  // ------------------------------------------------------------------ canvas na CLI (hades canvas)
  canvas_no_caller: {
    title: "O comando não sabe de qual terminal você fala",
    cause: "Os comandos `hades canvas` identificam quem chama pelo pane do herdr; este processo não roda dentro de um pane.",
    action: "Rode o comando no terminal de uma sessão aberta pelo herdr (ou pelo canvas do painel). Fora dele, use a página Argos.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  canvas_panel_unreachable: {
    title: "O painel local não respondeu",
    cause: "A CLI conversa com o painel desta máquina, e ele está parado ou em outra porta.",
    action: "Veja com `hades panel service status` e suba com `hades panel service start`. A porta certa vem das Configurações (`HADES_PANEL_PORT`).",
    ref: "reference/panel.md §Início automático",
  },
  canvas_panel_refused: {
    title: "O painel recusou o pedido",
    cause: "O painel respondeu, mas rejeitou a operação; o motivo vem no código entre parênteses da mensagem.",
    action: "Rode `hades explain <código entre parênteses>` para o significado e a ação daquele código.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  canvas_many_canvases: {
    title: "Seu terminal está em mais de um canvas",
    cause: "O mesmo pane aparece em canvases diferentes, e a CLI não adivinha em qual agir.",
    action: "Repita o comando com `--canvas <id>` (os ids aparecem na mensagem).",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  canvas_note_no_access: {
    title: "Esse terminal não alcança a nota",
    cause: "Uma nota só é lida por quem está ligado a ela por uma conexão (direta ou em cadeia), ou o nome não existe neste canvas.",
    action: "Confira o nome com `hades canvas note list` e ligue a nota ao seu terminal no Argos (arraste uma conexão entre os dois).",
    ref: "reference/argos.md §Notas",
  },
  canvas_note_write_direct_only: {
    title: "Só se escreve na nota ligada direto ao terminal",
    cause: "Pela cadeia a nota só se lê; escrever exige uma conexão direta entre o terminal e a nota.",
    action: "Ligue a nota direto ao seu terminal no Argos e repita o `hades canvas note write`.",
    ref: "reference/argos.md §Notas",
  },
  canvas_note_conflict: {
    title: "A nota mudou enquanto você gravava",
    cause: "Outra pessoa ou outro agente gravou a mesma nota no meio; a CLI desiste depois de algumas tentativas.",
    action: "Leia de novo com `hades canvas note read <nota>` e grave outra vez sobre a versão nova.",
    ref: "reference/argos.md §Notas",
  },
  canvas_doc_conflict: {
    title: "O canvas mudou durante a operação",
    cause: "O canvas foi editado por outra origem enquanto a CLI aplicava o plano e as tentativas acabaram.",
    action: "Repita o comando; se persistir, feche as outras abas do Argos que estejam editando.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  canvas_herdr_failed: {
    title: "O herdr recusou a ação",
    cause: "A CLI pediu algo ao herdr (abrir, enviar ou fechar terminal) e ele respondeu com erro; o detalhe vem na mensagem.",
    action: "Confira o herdr na página Herdr do painel (ou com `herdr pane list`) e repita o comando.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  canvas_notify_failed: {
    title: "A notificação não saiu",
    cause: "O pedido ao herdr para avisar o terminal falhou; o resto da operação não é desfeito.",
    action: "Repita `hades canvas notify` ou confira o herdr na página Herdr do painel.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  canvas_join_outside_herdr: {
    title: "Esse terminal não está dentro do herdr",
    cause: "O canvas só mostra panes do herdr, e este terminal foi aberto fora dele.",
    action: "Abra o terminal (ou a sessão do Claude Code) num pane do herdr e rode `hades canvas join` de novo.",
    ref: "reference/argos.md §Terminal fora do canvas",
  },
  canvas_join_pane_not_found: {
    title: "O herdr não conhece esse pane",
    cause: "O id passado em `--pane` não existe mais no herdr (o terminal fechou ou o id está errado).",
    action: "Liste os panes com `herdr pane list` e repita com um id que apareça lá.",
    ref: "reference/argos.md §Terminal fora do canvas",
  },
  canvas_join_bad_pane: {
    title: "O id de pane não tem o formato esperado",
    cause: "O valor de `--pane` não parece um id de pane do herdr.",
    action: "Copie o id exato de `herdr pane list` (sem aspas nem espaços).",
    ref: "reference/argos.md §Terminal fora do canvas",
  },
  canvas_note_file_exists: {
    title: "Já existe um arquivo de nota com esse nome",
    cause: "A nota nova viraria um arquivo que já existe na pasta de notas, e a Hades não sobrescreve.",
    action: "Escolha outro nome para a nota, ou apague o arquivo antigo se ele não serve mais.",
    ref: "reference/argos.md §Notas",
  },
  canvas_drawing_no_access: {
    title: "Esse terminal não alcança o desenho",
    cause: "Um desenho só é lido por quem está ligado a ele por uma conexão (direta ou em cadeia), ou o id não existe.",
    action: "Ligue o desenho ao seu terminal no Argos e confira o id com `hades canvas drawing list`.",
    ref: "reference/argos.md §Desenho (`canvas-drawing.ts`)",
  },
  canvas_drawing_write_direct_only: {
    title: "Só se edita o desenho ligado direto ao terminal",
    cause: "Pela cadeia o desenho só se lê; editar exige conexão direta.",
    action: "Ligue o desenho direto ao seu terminal no Argos e repita a edição.",
    ref: "reference/argos.md §Desenho (`canvas-drawing.ts`)",
  },
  canvas_drawing_conflict: {
    title: "O desenho mudou enquanto você gravava",
    cause: "Outra origem editou o mesmo desenho no meio da gravação.",
    action: "Releia o desenho e refaça a edição sobre a versão nova.",
    ref: "reference/argos.md §Desenho (`canvas-drawing.ts`)",
  },
  recruit_not_in_canvas: {
    title: "Seu terminal não está em nenhum canvas",
    cause: "O pane que chamou não é um nó de canvas do painel.",
    action: "Abra o terminal pelo Argos (ou rode `hades canvas join`) e repita.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  recruit_not_orchestrator: {
    title: "Só o orquestrador comanda recrutas",
    cause: "O nó que chamou não tem a caixa Orquestrador ligada.",
    action: "Ligue a caixa Orquestrador no nó do terminal, no Argos, e repita o comando.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  recruit_not_recruit: {
    title: "Não achei esse recruta no canvas",
    cause: "O nome ou id não bate com nenhum nó recrutado neste canvas.",
    action: "Veja quem está em cada área com `hades canvas area list` e use o nome ou o id exato.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  recruit_not_yours: {
    title: "Esse terminal não é recruta seu",
    cause: "Só o orquestrador que criou o recruta pode comandá-lo.",
    action: "Peça ao orquestrador dono dele, ou recrute outro terminal com `hades canvas recruit`.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  recruit_missing_note: {
    title: "Não achei essa nota no canvas",
    cause: "O nome passado em `--note` não existe neste canvas.",
    action: "Veja as notas com `hades canvas note list` ou crie uma com `--new-note <nome>`.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  recruit_note_not_shared: {
    title: "A nota não está ligada ao orquestrador",
    cause: "Só se passa ao recruta uma nota que o orquestrador alcança.",
    action: "Ligue a nota ao orquestrador no Argos e repita o `recruit`.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  recruit_ambiguous: {
    title: "Mais de um nó tem esse nome",
    cause: "O nome serve para vários nós do canvas, e a CLI não escolhe por você.",
    action: "Repita com o id do nó (`hades canvas area list` mostra quem está em cada área).",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  recruit_join_target_not_orchestrator: {
    title: "O destino de `--to` não é orquestrador",
    cause: "O nó citado não existe neste canvas ou não tem a caixa Orquestrador.",
    action: "Use o nome ou id de um terminal com a caixa Orquestrador ligada, ou ligue a caixa nele.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  recruit_note_exists: {
    title: "Já existe uma nota com esse nome",
    cause: "O nome de `--new-note` já está em uso no canvas ou em arquivo.",
    action: "Escolha outro nome para a nota.",
    ref: "reference/argos.md §Orquestrador no canvas",
  },
  links_no_reader: {
    title: "Esses dois nós não se ligam",
    cause: "Nenhum dos dois entende o outro como leitor: a conexão não teria efeito.",
    action: "Ligue, por exemplo, uma nota ou desenho a um terminal; veja os pares válidos em Conexões.",
    ref: "reference/argos.md §Conexões",
  },
  links_self_loop: {
    title: "Um nó não liga a si mesmo",
    cause: "A origem e o destino da conexão são o mesmo nó.",
    action: "Escolha outro nó como destino.",
    ref: "reference/argos.md §Conexões",
  },
  links_duplicate_link: {
    title: "Essa conexão já existe",
    cause: "Já há uma conexão entre esses dois nós.",
    action: "Nada a fazer: a ligação já vale. Para trocar o estilo, edite a conexão existente.",
    ref: "reference/argos.md §Conexões",
  },
  links_limit_exceeded: {
    title: "O canvas chegou ao limite de conexões",
    cause: "O teto de conexões por canvas foi atingido.",
    action: "Remova conexões que não usa mais ou divida o trabalho em outro canvas.",
    ref: "reference/argos.md §Conexões",
  },

  // ------------------------------------------------------------------ painel: acesso
  [PANEL_ERRORS.host]: {
    title: "O painel recusou o endereço usado para abri-lo",
    cause: "O painel só atende pelo endereço local ou pelo endereço do túnel dele, e só quando a chave de acesso remoto existe.",
    action: "Abra `http://127.0.0.1:21220` na própria máquina. Para acesso de fora, crie o túnel e a chave na página Acesso remoto.",
    ref: `${PANEL} §Acesso remoto`,
  },
  [PANEL_ERRORS.origin]: {
    title: "O painel recusou a origem do pedido",
    cause: "O pedido veio de uma página que não é a do painel (outro endereço, outra porta ou uma aba antiga), e o painel barra isso de propósito.",
    action: "Feche a aba, abra o painel de novo pelo endereço de sempre e repita a ação.",
    ref: `${PANEL} §Acesso remoto`,
  },
  [PANEL_ERRORS.token]: {
    title: "A aba ficou velha em relação ao painel",
    cause: "O painel foi reiniciado depois que esta aba abriu, e a chave de sessão da aba deixou de valer.",
    action: "Recarregue a página (F5) e repita a ação.",
    ref: `${PANEL} §Ações`,
  },
  [PANEL_ERRORS.json]: {
    title: "O painel não entendeu o pedido",
    cause: "O corpo do pedido não era um JSON de objeto, ou passou do limite de tamanho.",
    action: "Recarregue a página. Se vier de um script seu, envie um objeto JSON com `Content-Type: application/json`.",
    ref: `${PANEL} §Ações`,
  },
  [PANEL_ERRORS.remoteKey]: {
    title: "O acesso remoto pede a chave",
    cause: "Você chegou ao painel pelo túnel e a sessão ainda não tem a chave, ou ela expirou.",
    action: "Abra o endereço do túnel e digite a chave. Ela está em Acesso remoto, no painel local (e em `credenciais.md` na pasta de dados).",
    ref: `${PANEL} §Acesso remoto`,
  },
  [PANEL_ERRORS.notFound]: {
    title: "O painel não tem essa rota",
    cause: "O endereço pedido não existe nesta versão do painel. Costuma ser aba antiga depois de uma atualização da skill.",
    action: "Recarregue a página. Se persistir, rode `hades doctor` para conferir a versão do kit e da skill.",
    ref: `${PANEL} §Páginas`,
  },
  [CLIENT_ERRORS.panelUnreachable]: {
    title: "O painel não respondeu",
    cause: "O navegador não conseguiu falar com o painel: ele pode estar parado, reiniciando, ou a conexão (túnel, rede) caiu.",
    action: "Espere alguns segundos e tente de novo. Se continuar, rode `hades doctor --quick` na máquina: ele diz se o painel está de pé e como religá-lo.",
    ref: `${PANEL} §Páginas`,
  },
  [PANEL_ERRORS.badRequest]: {
    title: "O painel recusou o valor enviado",
    cause: "A mensagem acima diz qual campo veio fora do esperado (vazio, grande demais ou de outro tipo).",
    action: "Corrija o campo indicado e tente de novo.",
    ref: `${PANEL} §Ações`,
  },
  [PANEL_ERRORS.envBusy]: {
    title: "O ambiente está ocupado com outra ação",
    cause: "Já existe uma ação exclusiva rodando (subir, atualizar, migrar). Duas ao mesmo tempo corromperiam o ambiente.",
    action: "Espere a ação em andamento terminar (página Execuções) ou interrompa-a por lá, e repita.",
    ref: `${PANEL} §Ações`,
  },
  [PANEL_ERRORS.chatBusy]: {
    title: "O chat já está respondendo",
    cause: "Cada conversa processa uma mensagem por vez; a anterior ainda não terminou.",
    action: "Espere a resposta chegar ou interrompa-a no próprio chat, e envie de novo.",
    ref: `${PANEL} §Claude`,
  },
  [PANEL_ERRORS.postMortemNotFound]: {
    title: "Esse post-mortem não existe",
    cause: "O nome pedido não bate com nenhum post-mortem gravado fora do repositório do projeto.",
    action: "Veja os existentes com `hades thanatos list`.",
    ref: `${PANEL} §Thanatos`,
  },
  internal_error: {
    title: "O painel falhou por dentro",
    cause: "Aconteceu um erro que o painel não previa. O detalhe técnico vai só para o log, nunca para a tela.",
    action: "Veja a página Logs (categoria painel) ou `hades doctor`. Repetir a ação costuma funcionar se foi um tropeço isolado.",
    ref: `${DOCTOR} §Armadilhas`,
  },
  ui_module_build_failed: {
    title: "Uma peça da tela não foi montada",
    cause: "O painel converte os arquivos da interface na hora, e um deles não compilou (geralmente por edição em andamento no kit).",
    action: "Recarregue; se continuar, rode `hades doctor` e reinstale o kit com `kit/install.sh`.",
    ref: `${PANEL} §Páginas`,
  },
  canvas_streams_busy: {
    title: "Há conexões ao vivo demais abertas",
    cause: "O painel limita quantas abas recebem o canvas em tempo real ao mesmo tempo para não sobrecarregar a máquina.",
    action: "Feche as abas do painel que você não usa e recarregue esta.",
    ref: `${ARGOS} §Sincronia ao vivo`,
  },
  invalid_plan: {
    title: "Nome de plano inválido",
    cause: "O nome do plano tem caractere que não pode ir no endereço ou não existe entre os planos da orquestração.",
    action: "Escolha o plano pela lista da página Orquestração em vez de digitar o nome.",
    ref: `${PANEL} §Orquestração`,
  },
  invalid_unit: {
    title: "Nome de unidade inválido",
    cause: "O nome da unidade tem caractere que não pode ir no endereço.",
    action: "Escolha a unidade pela lista do plano na página Orquestração.",
    ref: `${PANEL} §Orquestração`,
  },
  unknown_plan: {
    title: "O plano não foi encontrado",
    cause: "Não há plano com esse nome na orquestração (apagado, renomeado ou de outra instância).",
    action: "Abra a página Orquestração e escolha um plano da lista.",
    ref: `${PANEL} §Orquestração`,
  },
  unknown_unit: {
    title: "A unidade não foi encontrada",
    cause: "Esse plano não tem unidade com esse nome.",
    action: "Escolha a unidade pela lista do plano na página Orquestração.",
    ref: `${PANEL} §Orquestração`,
  },
  not_found: {
    title: "Não encontrei o que foi pedido",
    cause: "O item não existe mais ou nunca existiu (apagado, renomeado ou de outra instância).",
    action: "Atualize a lista na página e escolha o item de novo.",
    ref: `${PANEL} §Páginas`,
  },

  // ------------------------------------------------------------------ widget e plugin
  widget_off: {
    title: "O widget do celular está desligado",
    cause: "Ainda não existe token de widget nesta instalação, então o painel não responde a ele.",
    action: "No painel local, abra Acesso remoto e gere o token do widget.",
    ref: "reference/android-widget.md §Instalar e configurar",
  },
  widget_token: {
    title: "O widget não passou na conferência do token",
    cause: "O token do widget está ausente, foi revogado ou foi gerado de novo depois de configurado no celular.",
    action: "Gere um token novo em Acesso remoto (painel local) e cole-o no widget.",
    ref: "reference/android-widget.md §Instalar e configurar",
  },
  widget_token_scope: {
    title: "O token do widget só serve para leitura do widget",
    cause: "Ele foi feito para uma rota só (ver o estado); qualquer outra rota é recusada de propósito.",
    action: "Use a chave de acesso remoto para controlar o painel; deixe o token do widget só no widget.",
    ref: "reference/android-widget.md §Segurança",
  },
  widget_local_only: {
    title: "O token do widget só se gerencia no painel local",
    cause: "Criar e revogar token pelo acesso remoto daria a quem entrou pelo túnel o controle do widget.",
    action: "Abra o painel na própria máquina (`http://127.0.0.1:21220`) e faça a operação lá.",
    ref: "reference/android-widget.md §Segurança",
  },
  widget_rate_limited: {
    title: "Tentativas demais com o token do widget",
    cause: "O painel segura por um tempo depois de várias conferências erradas seguidas.",
    action: "Espere alguns minutos e confira o token configurado no widget.",
    ref: "reference/android-widget.md §Segurança",
  },
  apk_missing: {
    title: "O APK do widget ainda não foi gerado",
    cause: "O arquivo só existe depois do primeiro build, que roda num container Docker.",
    action: "Use Gerar APK na página do widget ou rode `hades widget-apk build`.",
    ref: "reference/android-widget.md §Gerar o APK",
  },
  plugin_not_found: {
    title: "O plugin não tem essa rota",
    cause: "O painel não conhece a rota pedida: o plugin está desligado ou a versão dele não a oferece.",
    action: "Veja o estado em Plugins ou com `hades plugins list`; ative o plugin se estiver desligado.",
    ref: `${PANEL} §Página Plugins`,
  },
  plugin_local_only: {
    title: "Esta rota do plugin só responde no painel local",
    cause: "O plugin marcou a rota como local; pelo acesso remoto ela fica fechada.",
    action: "Abra o painel na própria máquina e repita.",
    ref: `${PANEL} §Página Plugins`,
  },
  plugin_error: {
    title: "O plugin do projeto falhou",
    cause: "O código do plugin lançou erro ao atender o pedido. O detalhe fica no log do painel.",
    action: "Veja a página Logs (painel) e, se o erro for do plugin, `hades plugins disable <nome>` isola o problema.",
    ref: `${PANEL} §Página Plugins`,
  },

  // ------------------------------------------------------------------ terminal, herdr e supervisor
  unreachable: {
    title: "Não consegui falar com o herdr",
    cause: "O herdr (o gerenciador de terminais) não está rodando ou o socket dele não está onde o painel procura.",
    action: "Suba o herdr numa janela de terminal (`herdr`) e recarregue o painel. `hades deps need herdr` diz se ele está instalado.",
    ref: `${PANEL} §Herdr`,
  },
  timeout: {
    title: "O herdr não respondeu a tempo",
    cause: "O pedido foi enviado, mas a resposta não chegou dentro do limite. O herdr pode estar travado ou muito ocupado.",
    action: "Tente de novo; se repetir, reinicie o herdr e recarregue o painel.",
    ref: `${PANEL} §Herdr`,
  },
  closed: {
    title: "A conexão com o herdr caiu",
    cause: "O herdr fechou o socket no meio da conversa, normalmente porque foi encerrado ou reiniciado.",
    action: "Suba o herdr de novo e recarregue o painel.",
    ref: `${PANEL} §Herdr`,
  },
  too_large: {
    title: "A resposta do herdr veio grande demais",
    cause: "O painel descarta respostas acima do limite para não travar a aba.",
    action: "Feche terminais que não usa e tente de novo.",
    ref: `${PANEL} §Herdr`,
  },
  bad_reply: {
    title: "O herdr respondeu algo que o painel não entende",
    cause: "A versão do herdr instalada é mais nova ou mais antiga que a esperada.",
    action: "Rode `hades deps` para ver a versão do herdr e atualize se estiver fora do que a skill pede.",
    ref: `${PANEL} §Herdr`,
  },
  "herdr-unsupported": {
    title: "Esta versão do herdr não permite essa ação",
    cause: "A ação (como redimensionar o terminal) não existe na versão instalada.",
    action: "Atualize o herdr (`hades deps` mostra como) e recarregue o painel.",
    ref: `${PANEL} §Herdr`,
  },
  "size-rate-limited": {
    title: "Redimensionando rápido demais",
    cause: "O painel limita quantas mudanças de tamanho do terminal aceita por instante.",
    action: "Espere um segundo e solte o redimensionamento.",
    ref: `${PANEL} §Terminal`,
  },
  "size-invalid": {
    title: "Tamanho de terminal inválido",
    cause: "As colunas ou linhas pedidas estão fora do intervalo aceito.",
    action: "Recarregue a página; a aba calcula o tamanho de novo.",
    ref: `${PANEL} §Terminal`,
  },
  terminals_unreadable: {
    title: "O registro de terminais não pôde ser lido",
    cause: "O arquivo em que o painel guarda os terminais do canvas está corrompido ou sem permissão de leitura.",
    action: "Rode `hades doctor`. Se o arquivo estiver corrompido, a cópia mais recente está na pasta `argos/` dos dados.",
    ref: `${ARGOS} §Terminais criados no canvas`,
  },
  pane_gone: {
    title: "O terminal já não existe",
    cause: "O painel do herdr foi fechado (ou o agente terminou) antes da ação chegar.",
    action: "Atualize o canvas; se o agente ainda deveria estar vivo, retome-o com `hades agent resume <nome>`.",
    ref: `${ARGOS} §Terminais criados no canvas`,
  },
  "supervisor-claude-off": {
    title: "O supervisor está desligado",
    cause: "Ele consulta o `claude -p`, o que gasta tokens do seu plano e envia texto do terminal para fora da máquina; alguém desligou essa opção nas Configurações.",
    action: "Para ligar de novo: Configurações → Painel → Canvas: supervisor usa o claude -p, ou `hades config set HADES_SUPERVISOR_CLAUDE=1`.",
    ref: `${ARGOS} §Supervisor`,
  },
  "claude-missing": {
    title: "Não encontrei o programa `claude`",
    cause: "O painel precisa dele para o chat e o supervisor e não achou no PATH nem no caminho configurado.",
    action: "Informe o caminho em Configurações → Sessão Claude → Caminho do claude, ou instale o Claude Code.",
    ref: `${PANEL} §Claude`,
  },
  "claude-failed": {
    title: "O `claude -p` não respondeu",
    cause: "O processo terminou sem resposta: login vencido, limite de uso atingido ou rede fora.",
    action: "Rode `claude` num terminal para conferir o login e o limite; o detalhe está na página Logs (painel).",
    ref: `${ARGOS} §Supervisor`,
  },
  "herdr-failed": {
    title: "Não consegui ler o terminal pelo herdr",
    cause: "O herdr recusou a leitura: o terminal fechou ou o herdr está fora do ar.",
    action: "Confira se o terminal ainda existe no canvas e se o herdr está rodando.",
    ref: `${ARGOS} §Supervisor`,
  },
  "confirm-required": {
    title: "Falta confirmar digitando o nome",
    cause: "Pelo acesso remoto, essa ação exige digitar o nome do alvo, para um toque acidental no celular não disparar nada.",
    action: "Digite o nome pedido na caixa de confirmação e envie de novo.",
    ref: `${PANEL} §Acesso remoto`,
  },
  "rate-limited": {
    title: "Pedidos demais em pouco tempo",
    cause: "O painel limita a frequência desta ação para não sobrecarregar a máquina.",
    action: "Espere alguns segundos e tente de novo.",
    ref: `${ARGOS} §Supervisor`,
  },
  busy: {
    title: "Já há uma operação em andamento",
    cause: "A mesma operação ainda está rodando; o painel não aceita duas ao mesmo tempo.",
    action: "Espere terminar e repita.",
    ref: `${PANEL} §Páginas`,
  },
  invalid: {
    title: "O pedido veio com dado inválido",
    cause: "Algum campo está vazio, grande demais ou fora do formato esperado.",
    action: "Confira o que foi digitado (nome do terminal, pergunta, canvas) e tente de novo.",
    ref: `${PANEL} §Páginas`,
  },
  "not-found": {
    title: "Não encontrei o que foi pedido",
    cause: "O terminal, o canvas ou a nota não existe mais, ou ainda não tem conteúdo.",
    action: "Atualize o canvas e escolha o item de novo.",
    ref: `${ARGOS} §Supervisor`,
  },
  action_failed: {
    title: "A ação não foi concluída",
    cause: "Quem recebeu o pedido (o herdr ou o processo do agente) recusou ou falhou; o motivo está na mensagem acima e no log do painel.",
    action: "Veja a página Logs (painel). Conferir se o herdr roda (`hades deps need herdr`) resolve a maioria dos casos.",
    ref: `${PANEL} §Herdr`,
  },
  action_timeout: {
    title: "A ação demorou além do limite",
    cause: "O pedido foi enviado, mas a resposta não voltou a tempo; a ação pode ter acontecido mesmo assim.",
    action: "Atualize a página e confira o resultado antes de repetir.",
    ref: `${PANEL} §Herdr`,
  },
  unknown_action: {
    title: "O painel não conhece essa ação",
    cause: "A aba usa um nome de ação que esta versão do painel não tem; costuma ser aba antiga após atualizar a skill.",
    action: "Recarregue a página.",
    ref: `${ARGOS} §\`POST /api/argos/action\``,
  },
  confirm_required: {
    title: "A ação pede confirmação",
    cause: "Ela é destrutiva ou difícil de desfazer (encerrar um agente, por exemplo) e só roda com a confirmação.",
    action: "Confirme na caixa que abre (segurar o botão ou digitar o nome, conforme as Configurações).",
    ref: `${ARGOS} §\`POST /api/argos/action\``,
  },
  permission_not_pending: {
    title: "Não há permissão esperando resposta",
    cause: "O agente já recebeu a resposta (de você, de outra aba ou do próprio terminal).",
    action: "Atualize o canvas.",
    ref: `${ARGOS} §Menu, balão e permissão no nó (\`canvas-menu.tsx\`, \`node-balloon.tsx\`, \`node-permission.tsx\`)`,
  },
  unknown_node: {
    title: "Esse nó não existe mais no grafo",
    cause: "O agente ou o terminal foi encerrado depois que a tela foi desenhada.",
    action: "Atualize o canvas.",
    ref: `${ARGOS} §\`GET /api/argos/node/<id>\``,
  },

  // ------------------------------------------------------------------ canvas: documento, arquivo e gravação
  canvas_save_conflict: {
    title: "Outra aba gravou o canvas antes de você",
    cause: "O canvas mudou desde que esta aba o carregou; gravar por cima apagaria o trabalho da outra aba.",
    action: "Recarregue a página para ver a versão mais nova e refaça a sua alteração.",
    ref: `${ARGOS} §Sincronia ao vivo`,
  },
  canvas_save_unreachable: {
    title: "O canvas não conseguiu ser gravado",
    cause: "O painel não respondeu (parou, reiniciou ou a rede caiu), então a mudança ficou só na aba.",
    action: "Confira se o painel está no ar (`hades doctor`), mantenha a aba aberta e tente de novo.",
    ref: `${ARGOS} §Sincronia ao vivo`,
  },
  canvas_stale_revision: {
    title: "O canvas mudou desde a última leitura",
    cause: "Alguém (outra aba ou um agente pela CLI) gravou uma versão mais nova, e esta gravação partia da antiga.",
    action: "Recarregue e refaça a alteração; pela CLI, leia de novo com `hades canvas note read <nota>` antes de gravar.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  canvas_invalid_json: {
    title: "O arquivo do canvas não é um JSON válido",
    cause: "O conteúdo está truncado ou foi editado à mão com erro de sintaxe.",
    action: "Restaure a cópia anterior em `canvas-trash/` ou `backups/` dos dados, ou importe um arquivo exportado.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  canvas_too_large: {
    title: "O canvas passou do tamanho máximo",
    cause: "O documento ultrapassou o limite de bytes que o painel aceita gravar.",
    action: "Apague nós e imagens que não usa, ou divida em outro canvas (`+` ao lado do nome do canvas).",
    ref: `${ARGOS} §Vários canvases e exportação`,
  },
  canvas_limit_exceeded: {
    title: "O canvas atingiu o limite de itens",
    cause: "Há nós, conexões ou grupos demais para um só canvas.",
    action: "Poda o que está parado (Ocultar e podar) ou crie outro canvas para o assunto novo.",
    ref: `${ARGOS} §Ocultar e podar o canvas`,
  },
  canvas_mass_removal: {
    title: "A gravação apagaria quase tudo do canvas",
    cause: "A nova versão tem muito menos nós que a gravada. Quase sempre é uma aba que carregou vazia, e o painel barra para proteger o seu trabalho.",
    action: "Recarregue a página e confira. Se a remoção é de propósito, apague em partes ou use a cópia em `canvas-trash/`.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  canvas_unreadable: {
    title: "Não consegui ler o canvas gravado",
    cause: "O arquivo existe, mas está corrompido, sem permissão de leitura ou de uma versão futura.",
    action: "Rode `hades doctor`; restaure de `backups/` ou `canvas-trash/` nos dados se o arquivo estiver corrompido.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  canvas_unsupported_version: {
    title: "O canvas é de uma versão mais nova da skill",
    cause: "O arquivo foi gravado por uma versão da Hades mais recente que a instalada.",
    action: "Atualize a skill (`hades version-check status`) antes de abrir esse canvas.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  canvas_not_found: {
    title: "Esse canvas não existe",
    cause: "Foi apagado, renomeado ou é de outra instância da Hades.",
    action: "Escolha outro na lista de canvases do topo da página.",
    ref: `${ARGOS} §Vários canvases e exportação`,
  },
  canvas_exists: {
    title: "Já existe um canvas com esse nome",
    cause: "Os nomes de canvas são únicos.",
    action: "Escolha outro nome ou abra o canvas que já existe.",
    ref: `${ARGOS} §Vários canvases e exportação`,
  },
  canvas_default_protected: {
    title: "O canvas padrão não pode ser apagado",
    cause: "Ele é onde a Hades mostra os agentes por padrão, e a página precisa de pelo menos um.",
    action: "Crie e use outro canvas; para limpar o padrão, apague os nós por dentro dele.",
    ref: `${ARGOS} §Vários canvases e exportação`,
  },
  canvas_limit_reached: {
    title: "Você atingiu o limite de canvases",
    cause: "Existe um teto de canvases por instalação, para não encher o disco.",
    action: "Apague os que não usa (os apagados ficam em `canvas-trash/` por um tempo).",
    ref: `${ARGOS} §Vários canvases e exportação`,
  },
  canvas_invalid_name: {
    title: "Nome de canvas inválido",
    cause: "O nome está vazio, comprido demais ou usa caractere que não vira nome de arquivo.",
    action: "Use letras, números, espaço e hífen, com até algumas dezenas de caracteres.",
    ref: `${ARGOS} §Vários canvases e exportação`,
  },
  canvas_invalid_id: {
    title: "Identificador de canvas inválido",
    cause: "O endereço usa um identificador fora do formato aceito.",
    action: "Abra o canvas pela lista do topo da página, sem digitar o identificador.",
    ref: `${ARGOS} §Vários canvases e exportação`,
  },
  canvas_invalid_shape: {
    title: "O canvas tem a estrutura errada",
    cause: "O arquivo é JSON, mas falta ou sobra campo em relação ao formato do documento.",
    action: "Importe um arquivo exportado pelo próprio painel, sem editar à mão.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  canvas_dangling_reference: {
    title: "Uma conexão aponta para um nó que não existe",
    cause: "O nó foi apagado e a conexão ficou órfã (ou o arquivo foi editado à mão).",
    action: "Recarregue; o painel descarta conexões órfãs ao gravar de novo.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  canvas_duplicate_id: {
    title: "Dois itens do canvas usam o mesmo identificador",
    cause: "Aconteceu uma colagem ou edição manual que copiou o identificador.",
    action: "Desfaça a última colagem (Ctrl+Z) ou importe um arquivo exportado pelo painel.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  canvas_invalid_node: {
    title: "Um nó do canvas está inválido",
    cause: "Falta algum campo do nó ou o valor dele saiu do aceito (posição, tamanho, texto).",
    action: "Desfaça a última alteração (Ctrl+Z). Se veio de importação, exporte de novo do canvas de origem.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  canvas_invalid_edge: {
    title: "Uma conexão do canvas está inválida",
    cause: "A conexão liga coisas que não podem se ligar ou tem campo fora do aceito.",
    action: "Desfaça a última alteração (Ctrl+Z) e ligue de novo pelo nó de origem.",
    ref: `${ARGOS} §Conexões`,
  },
  canvas_invalid_group: {
    title: "Um grupo do canvas está inválido",
    cause: "O grupo tem membro que não existe ou campo fora do aceito.",
    action: "Desfaça a última alteração (Ctrl+Z) e agrupe de novo.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  canvas_invalid_scope: {
    title: "Escopo de canvas inválido",
    cause: "O canvas por worktree ou rodada pede um escopo que não existe.",
    action: "Escolha o escopo pela lista de canvases da página.",
    ref: `${ARGOS} §Canvas por worktree ou rodada e filtros salvos`,
  },

  // ------------------------------------------------------------------ canvas: notas, desenhos, arquivos e terminais
  note_stale_revision: {
    title: "A nota mudou desde que você a abriu",
    cause: "O agente (ou outra aba) gravou uma versão mais nova da nota; a sua partia da antiga.",
    action: "Reabra a nota para ver a versão atual e refaça a edição. Pela CLI, `hades canvas note read <nota>` antes de gravar.",
    ref: `${ARGOS} §Notas`,
  },
  note_not_found: {
    title: "Essa nota não existe",
    cause: "Foi apagada ou o nome é de outro canvas.",
    action: "Veja as notas com `hades canvas note list`.",
    ref: `${ARGOS} §Notas`,
  },
  note_locked: {
    title: "A nota está travada",
    cause: "Alguém travou a nota para edição; só quem travou (ou o dono) destrava.",
    action: "Destrave pelo menu da nota, no painel local.",
    ref: `${ARGOS} §Notas`,
  },
  note_agent_local_only: {
    title: "O agente só grava nota pelo painel local",
    cause: "Pelo acesso remoto, a escrita do agente nas notas fica fechada, para quem entrou pelo túnel não editar a memória do agente.",
    action: "Faça a operação no painel aberto na própria máquina.",
    ref: `${ARGOS} §Notas`,
  },
  note_local_only: {
    title: "Esta operação de nota só vale no painel local",
    cause: "Ela mexe em arquivo da máquina e fica fechada pelo acesso remoto.",
    action: "Abra o painel na própria máquina e repita.",
    ref: `${ARGOS} §Notas`,
  },
  note_invalid_body: {
    title: "O corpo da nota veio inválido",
    cause: "O texto, o título ou algum campo da nota está fora do formato aceito.",
    action: "Confira o texto enviado (tamanho e formato) e tente de novo.",
    ref: `${ARGOS} §Notas`,
  },
  note_unreadable: {
    title: "Não consegui ler a nota gravada",
    cause: "O arquivo da nota está corrompido ou sem permissão de leitura.",
    action: "Rode `hades doctor`; a nota apagada ou corrompida pode estar em `canvas-trash/` nos dados.",
    ref: `${ARGOS} §Notas`,
  },
  note_exists: {
    title: "Já existe uma nota com esse nome",
    cause: "Os nomes de nota são únicos por canvas.",
    action: "Escolha outro nome, ou grave sobre a existente com `hades canvas note write <nome>`.",
    ref: `${ARGOS} §Notas`,
  },
  drawing_stale_revision: {
    title: "O desenho mudou desde que você o abriu",
    cause: "Outra aba (ou o agente) gravou uma versão mais nova do desenho.",
    action: "Recarregue a página e refaça o traço.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  drawing_agent_local_only: {
    title: "O agente só desenha pelo painel local",
    cause: "Pelo acesso remoto, a escrita do agente no desenho fica fechada.",
    action: "Faça a operação no painel aberto na própria máquina.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  drawing_body_too_large: {
    title: "O desenho passou do tamanho máximo",
    cause: "Há traços demais num só desenho.",
    action: "Apague traços antigos ou desenhe o resto em outro canvas.",
    ref: `${ARGOS} §Documento do canvas`,
  },
  files_unknown_pane: {
    title: "O terminal escolhido não existe mais",
    cause: "O seletor de arquivos precisa do terminal para saber a pasta, e ele foi fechado.",
    action: "Atualize o canvas e escolha o terminal de novo.",
    ref: `${ARGOS} §Compositor`,
  },
  files_no_cwd: {
    title: "Não sei em qual pasta esse terminal está",
    cause: "O herdr não informou a pasta atual do terminal, então o painel não sabe onde procurar arquivos.",
    action: "Rode `pwd` no terminal para o herdr atualizar e tente de novo; confirme que o herdr está rodando.",
    ref: `${ARGOS} §Compositor`,
  },
  files_path_not_found: {
    title: "Esse arquivo ou pasta não existe",
    cause: "Foi renomeado ou apagado depois da listagem.",
    action: "Atualize a listagem do seletor.",
    ref: `${ARGOS} §Compositor`,
  },
  attachment_too_large: {
    title: "O anexo é grande demais",
    cause: "O compositor limita o tamanho de cada anexo e do conjunto.",
    action: "Comprima ou reduza o arquivo, ou cite o caminho dele em texto em vez de anexar.",
    ref: `${ARGOS} §Compositor`,
  },
  attachment_type: {
    title: "Esse tipo de arquivo não pode ser anexado",
    cause: "O compositor só aceita os tipos de imagem e texto da lista.",
    action: "Converta para imagem (PNG ou JPG) ou texto, ou cite o caminho do arquivo.",
    ref: `${ARGOS} §Compositor`,
  },
  attachment_failed: {
    title: "Não consegui anexar o arquivo",
    cause: "A cópia do arquivo falhou (disco cheio, sem permissão ou arquivo que sumiu).",
    action: "Confira o espaço em disco (`hades clean status`) e tente de novo.",
    ref: `${ARGOS} §Compositor`,
  },
  portal_rate_limited: {
    title: "Conferências de portal demais em pouco tempo",
    cause: "O painel limita quantas páginas externas verifica por minuto.",
    action: "Espere o tempo indicado (cabeçalho Retry-After) e tente de novo.",
    ref: `${ARGOS} §Portal web (modelo puro e rota)`,
  },

  // ------------------------------------------------------------------ caronte
  invalid_agent: {
    title: "Nome de agente inválido",
    cause: "O nome tem caractere não aceito (o agente é identificado por um nome simples).",
    action: "Veja os nomes com `hades agent list` e use um deles.",
    ref: "reference/caronte.md §Fluxo",
  },
  unknown_agent: {
    title: "Não conheço esse agente",
    cause: "Não há agente registrado com esse nome (terminou, foi dispensado ou é de outra instância).",
    action: "Veja os registrados com `hades agent list`.",
    ref: "reference/caronte.md §Fluxo",
  },
  preview_failed: {
    title: "Não consegui montar a prévia",
    cause: "A prévia usa a worktree da unidade, e ela não existe mais ou o preview não subiu.",
    action: "Confira a worktree em `~/.claude/hades/skill-dev/` (ou do projeto) e a página Logs (painel).",
    ref: "reference/caronte.md §Fluxo",
  },

  // ------------------------------------------------- argos, arquivos, notas e desenhos (pedido recusado por forma)
  invalid_node: {
    title: "O canvas pediu um nó que não existe",
    cause: "O identificador do nó veio vazio ou fora do formato; costuma ser tela desatualizada.",
    action: "Atualize a página do Argos e repita a ação.",
    ref: `${ARGOS} §\`GET /api/argos/node/<id>\``,
  },
  invalid_args: {
    title: "A ação veio com dados faltando ou fora do formato",
    cause: "Um dos campos que a ação pede está ausente ou tem valor que ela não aceita.",
    action: "Refaça a ação pelo botão da tela. Se vier de um comando, confira os argumentos com `hades canvas --help`.",
    ref: `${ARGOS} §\`POST /api/argos/action\``,
  },
  invalid_query: {
    title: "A consulta ao grafo está mal formada",
    cause: "Um filtro da URL (ou do comando) tem valor fora da lista aceita.",
    action: "Limpe os filtros da página e aplique de novo; no comando, remova o filtro que falhou.",
    ref: `${ARGOS} §\`GET /api/argos/graph\``,
  },
  action_not_for_node: {
    title: "Essa ação não vale para esse tipo de nó",
    cause: "Cada tipo de nó (agente, terminal, nota) aceita só algumas ações.",
    action: "Abra o menu do nó e escolha uma das ações que ele oferece.",
    ref: `${ARGOS} §Tipos de nó e comandos`,
  },
  permission_not_supported: {
    title: "O agente não permite responder por aqui",
    cause: "Esse agente pede permissão de um jeito que o painel não consegue responder por ele.",
    action: "Responda no terminal do próprio agente (abra o nó e use o terminal).",
    ref: `${ARGOS} §\`POST /api/argos/action\``,
  },
  files_invalid_target: {
    title: "O seletor de arquivos não sabe onde procurar",
    cause: "O pedido não trouxe um terminal ou pasta de partida válido.",
    action: "Feche o seletor, escolha o terminal de novo e reabra.",
    ref: `${ARGOS} §Compositor`,
  },
  files_invalid_path: {
    title: "Esse caminho não vale no seletor",
    cause: "O caminho tem trechos que saem da pasta do terminal ou caracteres não aceitos.",
    action: "Navegue pelas pastas na lista, em vez de digitar o caminho inteiro.",
    ref: `${ARGOS} §Compositor`,
  },
  files_not_directory: {
    title: "O seletor esperava uma pasta e achou um arquivo",
    cause: "O caminho pedido para listar aponta para um arquivo.",
    action: "Volte uma pasta e escolha o arquivo na lista.",
    ref: `${ARGOS} §Compositor`,
  },
  files_invalid_query: {
    title: "A busca no seletor de arquivos está mal formada",
    cause: "O texto de busca ou o limite pedido está fora do que o painel aceita.",
    action: "Apague a busca e digite de novo, com menos caracteres.",
    ref: `${ARGOS} §Compositor`,
  },
  attachment_invalid: {
    title: "O anexo não chegou inteiro",
    cause: "O arquivo veio sem nome ou sem conteúdo legível.",
    action: "Anexe de novo; se repetir, escolha o arquivo pelo seletor em vez de arrastar.",
    ref: `${ARGOS} §Compositor`,
  },
  note_invalid_name: {
    title: "Nome de nota não aceito",
    cause: "O nome tem barra, ponto no começo ou caractere que não cabe num arquivo.",
    action: "Use letras, números e hífen, por exemplo `andamento-do-dia`.",
    ref: `${ARGOS} §Notas`,
  },
  note_too_large: {
    title: "A nota passou do tamanho máximo",
    cause: "O texto, com as imagens coladas, ultrapassa o teto de uma nota.",
    action: "Divida em duas notas ou tire as imagens maiores.",
    ref: `${ARGOS} §Notas`,
  },
  note_invalid_path: {
    title: "A nota aponta para um lugar que não pode usar",
    cause: "O arquivo vinculado à nota está fora da pasta permitida.",
    action: "Escolha um arquivo dentro do projeto ou crie a nota sem vínculo.",
    ref: `${ARGOS} §Notas`,
  },
  note_invalid_image: {
    title: "A imagem colada na nota não vale",
    cause: "O arquivo não é PNG, JPG, GIF ou WebP legível.",
    action: "Cole de novo uma captura de tela, ou converta a imagem para PNG.",
    ref: `${ARGOS} §Notas`,
  },
  note_too_many_images: {
    title: "A nota já tem imagens demais",
    cause: "Cada nota aceita um número limitado de imagens.",
    action: "Remova alguma imagem ou use outra nota.",
    ref: `${ARGOS} §Notas`,
  },
  note_invalid_title: {
    title: "Título de nota não aceito",
    cause: "O título está vazio ou longo demais.",
    action: "Escreva um título curto, de uma linha.",
    ref: `${ARGOS} §Notas`,
  },
  note_invalid_query: {
    title: "A busca de notas está mal formada",
    cause: "O texto ou o limite da busca está fora do que o painel aceita.",
    action: "Apague a busca e escreva de novo.",
    ref: `${ARGOS} §Notas`,
  },
  drawing_invalid_body: {
    title: "O desenho enviado está fora do formato",
    cause: "O conteúdo não segue o formato que o painel grava (traços e formas).",
    action: "Recarregue a página e refaça o traço; o desenho gravado antes continua intacto.",
    ref: `${ARGOS} §Desenho (\`canvas-drawing.ts\`)`,
  },
  drawing_not_found: {
    title: "Esse desenho não existe",
    cause: "Foi apagado ou pertence a outro canvas.",
    action: "Atualize o canvas e abra o desenho pela lista.",
    ref: `${ARGOS} §Desenho (\`canvas-drawing.ts\`)`,
  },
  drawing_unreadable: {
    title: "Não consegui ler o desenho gravado",
    cause: "O arquivo do desenho está corrompido ou sem permissão de leitura.",
    action: "Rode `hades doctor`; a cópia anterior do desenho pode estar em `canvas-trash/` nos dados.",
    ref: `${ARGOS} §Desenho (\`canvas-drawing.ts\`)`,
  },
  drawing_too_many_edits: {
    title: "Edições demais de uma vez no desenho",
    cause: "O agente mandou mais alterações num só pedido do que o limite aceita.",
    action: "Peça ao agente para dividir em pedidos menores.",
    ref: `${ARGOS} §Desenho (\`canvas-drawing.ts\`)`,
  },

  // ------------------------------------------------------------------ Mark no Argos (nó mark, src/panel/mark.ts)
  mark_bridge_missing: {
    title: "O Mark não está aberto",
    cause: "O arquivo da ponte (`bridge.json`) não existe: o Mark apaga o arquivo ao sair e só o grava quando sobe.",
    action: "Abra o Mark com `mark`. Se ele já está aberto e o arquivo mora em outro lugar, aponte a chave `HADES_MARK_BRIDGE` nas Configurações.",
    ref: `${ARGOS} §Mark`,
  },
  mark_bridge_invalid: {
    title: "O arquivo da ponte do Mark está inválido",
    cause: "O `bridge.json` existe, mas não tem porta, token, esquema e pid válidos (arquivo cortado, de outra versão ou de outro programa).",
    action: "Feche o Mark e abra de novo com `mark`, que regrava o arquivo. Confira se `HADES_MARK_BRIDGE` aponta o arquivo do Mark.",
    ref: `${ARGOS} §Mark`,
  },
  mark_process_gone: {
    title: "O Mark fechou sem apagar a ponte",
    cause: "O `bridge.json` sobrou de uma execução que terminou à força, e o processo que ele cita não existe mais.",
    action: "Abra o Mark com `mark`: ele regrava o arquivo e o nó volta sozinho.",
    ref: `${ARGOS} §Mark`,
  },
  mark_unreachable: {
    title: "O Mark não respondeu na ponte",
    cause: "O arquivo da ponte existe e o processo está vivo, mas a porta recusou a conexão, caiu no meio ou passou do tempo de espera.",
    action: "Reabra o Mark com `mark`. Se ele demora a subir, aumente `HADES_MARK_TIMEOUT_S` nas Configurações.",
    ref: `${ARGOS} §Mark`,
  },
  mark_rejected: {
    title: "O Mark recusou o token da ponte",
    cause: "O token do `bridge.json` não vale mais: o Mark gera um novo a cada execução e o arquivo lido é de uma anterior.",
    action: "Reabra o Mark com `mark` para gravar um token novo.",
    ref: `${ARGOS} §Mark`,
  },
  mark_bad_response: {
    title: "O Mark respondeu algo que o painel não entende",
    cause: "A resposta da ponte não segue o contrato esperado (estado fora do formato ou resposta de erro).",
    action: "Atualize o Mark para a versão com a ponte (`/api/state`) e abra de novo com `mark`. `hades doctor` mostra o que a ponte devolveu.",
    ref: `${ARGOS} §Mark`,
  },
  mark_text_empty: {
    title: "O pedido ao Mark está vazio",
    cause: "O campo de texto chegou sem nada além de espaços.",
    action: "Escreva o pedido e envie de novo.",
    ref: `${ARGOS} §Mark`,
  },
  mark_text_too_long: {
    title: "O pedido ao Mark é longo demais",
    cause: "O painel recusa pedido acima de 2000 caracteres para o Mark não ler um texto enorme em voz alta nem enfileirar um bloco inteiro.",
    action: "Encurte o pedido. Texto longo vai melhor numa nota do Argos que o Mark leia depois.",
    ref: `${ARGOS} §Mark`,
  },
  mark_streams_busy: {
    title: "Abas demais acompanhando o Mark",
    cause: "O painel limita quantas abas recebem o fluxo ao vivo do Mark ao mesmo tempo.",
    action: "Feche as abas do painel que não usa; a aba recusada tenta de novo sozinha em alguns segundos.",
    ref: `${ARGOS} §Mark`,
  },
  mark_rate_limited: {
    title: "Pedidos demais ao Mark em pouco tempo",
    cause: "O painel limita pedidos e acordares por janela de 10 segundos, porque o Mark fala e abre janelas na máquina.",
    action: "Espere o tempo do `Retry-After` e envie de novo.",
    ref: `${ARGOS} §Mark`,
  },
  mark_no_report: {
    title: "O Mark ainda não tem relatório",
    cause: "O estado do Mark não cita relatório, ou o arquivo citado está fora da pasta `reports` dele.",
    action: "Peça ao Mark uma pesquisa ou tarefa que gere relatório e abra o botão de novo.",
    ref: `${ARGOS} §Mark`,
  },
  mark_report_unreadable: {
    title: "Não consegui ler o relatório do Mark",
    cause: "O arquivo do relatório sumiu ou o painel não tem permissão para lê-lo.",
    action: "Confira a pasta `reports` do Mark e rode `hades doctor`.",
    ref: `${ARGOS} §Mark`,
  },

  // ------------------------------------------------------------------ Voz do Mark pelo painel (src/panel/mark-voice.ts)
  mark_voice_hello_required: {
    title: "A conversa de voz começou fora de ordem",
    cause: "O primeiro aviso da conexão de voz não foi o `hello`, ou veio de uma aba com versão antiga da vista.",
    action: "Recarregue a página do painel e abra a voz de novo.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_bad_mode: {
    title: "Modo de voz desconhecido",
    cause: "A conexão de voz pediu um modo que não é `ptt` (segurar para falar) nem `open` (conversa aberta).",
    action: "Recarregue a página do painel. Se persistir, confira `HADES_MARK_VOICE_MODE` nas Configurações.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_bad_message: {
    title: "Mensagem de voz inválida",
    cause: "A mensagem de controle da voz veio fora do formato ou maior que o limite.",
    action: "Recarregue a página do painel e abra a voz de novo.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_frame_too_large: {
    title: "Quadro de áudio grande demais",
    cause: "O navegador mandou um pedaço de áudio acima de 3200 bytes (100 ms), o teto do painel e do Mark.",
    action: "Recarregue a página do painel: a vista manda quadros de 20 a 40 ms.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_bad_frame: {
    title: "Quadro de áudio com tamanho ímpar",
    cause: "O pedaço de áudio não tem um número par de bytes, então não é PCM de 16 bits.",
    action: "Recarregue a página do painel. Se persistir com a mesma aba, o navegador não suporta o áudio da vista.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_rate_limit: {
    title: "Áudio chegando rápido demais",
    cause: "O navegador mandou mais de 100 quadros por segundo, depois de uma pausa na rede ou de um relógio de áudio errado.",
    action: "Abra a voz de novo. Se repetir, troque de rede ou recarregue a página.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_idle_timeout: {
    title: "A voz ficou em silêncio",
    cause: "Na conversa aberta, ou com o botão apertado, nenhum áudio chegou por 5 segundos: a aba parou, a tela apagou ou a rede caiu.",
    action: "Mantenha a tela acesa com a vista aberta e abra a voz de novo.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_busy: {
    title: "Já há alguém falando com o Mark",
    cause: "O Mark aceita um cliente de voz por vez (o painel de outra aba ou do celular está com a voz aberta).",
    action: "Encerre a voz na outra aba e abra de novo.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_too_long: {
    title: "A sessão de voz chegou ao tempo máximo",
    cause: "O painel encerra a voz depois de `HADES_MARK_VOICE_MAX_S` segundos para o microfone não ficar aberto esquecido.",
    action: "Abra a voz de novo. Para sessões mais longas, aumente `HADES_MARK_VOICE_MAX_S` nas Configurações.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_unavailable: {
    title: "O Mark não atende voz",
    cause: "O Mark está de pé, mas não abriu o canal de voz: a versão dele é anterior à voz remota.",
    action: "Atualize o Mark-LVI para a versão com `/ws/voice` e abra de novo com `mark`. `hades doctor` mostra o item `mark-voz`.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_failed: {
    title: "A voz do Mark falhou",
    cause: "O Mark encerrou a voz com um motivo que esta versão do painel não conhece.",
    action: "Abra a voz de novo. Se repetir, atualize a Hades e o Mark e rode `hades doctor`.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_mic_denied: {
    title: "O navegador não liberou o microfone",
    cause: "A permissão de microfone foi negada para este endereço, ou o sistema bloqueia o microfone do navegador.",
    action: "Toque no cadeado ao lado do endereço, libere o microfone para este site e abra a voz de novo.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_mic_missing: {
    title: "Nenhum microfone encontrado",
    cause: "O aparelho não tem microfone disponível, ou outro app está usando todos.",
    action: "Conecte um microfone, feche o app que o usa e abra a voz de novo.",
    ref: `${ARGOS} §Voz`,
  },
  mark_voice_insecure_context: {
    title: "O navegador só libera o microfone em endereço seguro",
    cause: "A página foi aberta por `http` fora do próprio computador, e o navegador esconde o microfone nesse caso.",
    action: "Abra o painel pelo endereço `https` do túnel, ou por `localhost` no computador.",
    ref: `${ARGOS} §Voz`,
  },
};
