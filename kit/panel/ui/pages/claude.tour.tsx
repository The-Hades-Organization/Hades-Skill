/* Tour da página Claude (#/claude). Contrato dos tours por página: reference/panel.md §Tour por página.
 * Só texto (sem JSX): cada string é uma chave de tradução em potencial. Sem prévia: a conversa é um fluxo ao vivo
 * (SSE) com gasto real, e um exemplo fictício não mostraria nada do que ela faz; o que pode faltar leva fallback. */
(() => {
HadesCore.registerTour('claude', {
  steps: [
    {
      id: 'tour-claude',
      title: 'Conversa com o Claude Code',
      body: 'Um chat com o Claude Code no clone principal do projeto, no navegador e no celular. Cada mensagem roda um claude -p em auto mode, com a resposta em streaming. Nada aqui é terminal: é mensagem, resposta e ferramentas em blocos recolhíveis.',
      command: 'claude -p "<mensagem>"',
      ref: 'panel.md › Claude',
      side: 'bottom',
    },
    {
      id: 'claude-ligar',
      title: 'Ligar a conversa',
      body: 'A conversa pode estar desligada (HADES_CHAT=0). O botão a liga e só aparece no painel local; pelo acesso remoto ele não existe, por segurança.',
      ref: 'panel.md › Claude',
      fallback: 'Com a conversa ligada este botão não aparece. Para desligar ou religar: Configurações → Sessão Claude → "Ligar a página Claude", pelo painel local.',
      side: 'bottom',
    },
    {
      id: 'claude-conversas',
      title: 'Conversas',
      body: 'As sessões deste projeto, da mais recente: título, se está respondendo ou veio pelo acesso remoto, há quanto tempo e quanto custou. "Nova" abre uma conversa em branco; a lixeira tira do registro do Hades, sem apagar o transcript do Claude.',
      fallback: 'Em tela estreita a lista fica numa gaveta, aberta pelo botão de painel no cabeçalho da conversa. Sem conversa ainda, ela diz "Nenhuma conversa ainda": a primeira mensagem abre uma.',
      side: 'right',
    },
    {
      id: 'claude-cabecalho',
      title: 'Qual sessão e como roda',
      body: 'O título da conversa, o clone onde ela roda, o modelo, o esforço e o auto mode. Mostra "respondendo" enquanto há resposta e, à direita, quantas conversas respondem agora contra o teto.',
      fallback: 'O cabeçalho só existe com a conversa ligada. Veja o passo de ligar.',
      side: 'bottom',
    },
    {
      id: 'claude-intro',
      title: 'Como funciona',
      body: 'Em auto mode o Claude executa comandos e edições sem pedir confirmação. O hook hades guard continua barrando o que barra numa sessão interativa. Enter envia, Shift Enter quebra a linha.',
      ref: 'guard.md',
      fallback: 'O texto de abertura some assim que a conversa tem a primeira mensagem. Clique em "Nova" para vê-lo de novo.',
      side: 'top',
    },
    {
      id: 'claude-conversa',
      title: 'A conversa',
      body: 'Suas mensagens à direita e as respostas em coluna de leitura. Cada ferramenta usada (Bash, Read, Edit…) é um bloco recolhível com o resultado; recusa e erro aparecem em destaque. Ao fim de cada turno, o custo, os tokens e um botão para copiar a resposta.',
      fallback: 'A coluna da conversa só aparece com a conversa ligada.',
      side: 'top',
    },
    {
      id: 'claude-modo',
      title: 'Chat ou Terminal',
      body: 'O seletor troca a mesa: o chat (claude -p) ou o Claude Code de verdade num terminal, na pasta que você escolher e retomando uma conversa. "Continuar no terminal" leva a conversa atual; uma ferramenta barrada no chat oferece "Abrir no terminal para aprovar".',
      ref: 'panel.md › Claude',
      fallback: 'O seletor só existe com a conversa ligada. O modo terminal também precisa de HADES_TERMINAL=1 (Configurações → Terminal), e a página explica isso quando está desligado.',
      side: 'bottom',
    },
    {
      id: 'claude-envio',
      title: 'Mensagem para o Claude',
      body: 'Escreva e envie; durante a resposta o botão vira Parar. O clipe anexa uma imagem ou um arquivo de texto (o Claude lê pelo caminho que a mensagem cita). Uma resposta por vez em cada sessão.',
      fallback: 'A barra de envio só aparece com a conversa ligada.',
      side: 'top',
    },
  ],
});
})();
