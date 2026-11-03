# Segurança

A Hades roda com as suas permissões, na sua máquina, e parte dela é feita para ser alcançada de fora: o painel pelo
túnel, o chat com o Claude Code e os terminais dos agentes. Um defeito nessas partes pode virar shell remoto na máquina
de quem usa. Por isso vulnerabilidade não entra em issue pública.

## Como reportar

Pelo GitHub, em privado: no [repositório](https://github.com/The-Hades-Organization/Hades-Skill), **Security → Report a vulnerability** (Private vulnerability reporting). Só
você e o mantenedor veem o relato. Diga:

- a versão (`VERSION`) e o sistema (Linux com systemd ou macOS);
- a parte afetada (painel, túnel, chat, herdr/Argos, widget, plugin, CLI, hook);
- os passos para reproduzir e o que um atacante consegue no fim;
- se precisa de acesso prévio (conta do túnel, chave de acesso, token do widget, shell local) ou não.

Tire do relato caminhos, nomes de projeto, URLs de túnel, tokens e chaves que não sejam de teste. Se a página de
relato não estiver disponível, abra uma issue pedindo um canal, **sem nenhum detalhe** da falha.

## Versões suportadas

Só a última minor publicada recebe correção de segurança. A correção sai numa versão nova; não há backport para
versões anteriores. Atualizar é `git -C ~/.claude/skills/hades pull` seguido do `kit/install.sh` (README,
§Instalação).

## Prazo de resposta

A Hades é mantida por uma pessoa, no tempo que ela tem. Em regime de melhor esforço:

- confirmação de recebimento em até 7 dias;
- avaliação inicial (se é falha, gravidade, escopo) em até 14 dias;
- correção conforme a gravidade, priorizando o que permite execução remota.

Esses prazos são uma intenção, não uma garantia. O mantenedor combina com você a data da divulgação; peço que espere a
versão corrigida sair, ou 90 dias depois do relato, o que vier primeiro.

## Escopo

Entra no escopo o código deste repositório. As partes abaixo são superfície de shell remoto e têm prioridade.

| Parte | O que ela expõe | Barreiras de hoje |
|---|---|---|
| **Painel** (`src/panel/`, `kit/panel/ui/`) | operar o ambiente, rodar ações da lista fechada, ler logs | escuta só em `127.0.0.1`; confere `Host` (contra DNS rebinding) e `Origin`; toda escrita é `POST` com o token do painel embutido na página |
| **Túnel do painel** (devtunnel) | o painel inteiro fora da máquina | duas camadas obrigatórias: só a conta dona do devtunnel passa (o `panel-start` remove regras anônimas e de org) e a chave de acesso (`remote.key`), que vira cookie `HttpOnly; Secure; SameSite=Strict`; oito chaves erradas em 10 min do mesmo IP bloqueiam novas tentativas; no remoto o `Origin` precisa ser o host do túnel; publicar, parar e trocar a chave só pelo painel local |
| **Chat com o Claude** (página Claude) | um Claude Code em auto mode no clone principal | as mesmas camadas do painel; sempre `--permission-mode auto`, nunca `bypassPermissions`; `HADES_CHAT` e o binário só mudam pelo painel local; a primeira mensagem remota de cada sessão avisa o dono (com as notificações ligadas) |
| **Herdr e terminais do Argos** | digitar e mandar teclas aos agentes e terminais da máquina | as mesmas camadas do painel; o `herdr` roda com argumentos em lista, nunca shell; painel e teclas validados contra a listagem atual e uma lista fechada; ação remota avisa o dono e fica registrada sem o texto |
| **Terminal remoto** (quando existir) | shell da máquina pelo painel | entra no escopo desde já |
| **Widget Android** (`GET /api/widget`) | estado do ambiente e títulos de PR | listener próprio, só essa rota; token `hdw_…` só de leitura e recusado em qualquer outra rota; revogar o token fecha a rota |
| **Túnel do front** | o front do ambiente do projeto | anônimo por escolha, com prazo; a barreira é o login do próprio sistema do projeto; o Cerberus barra a publicação anônima até o dono aprovar |
| **Plugins e `post-install.sh`** | código de terceiros executado como você | prévia do commit e do que executa, que é a barreira de fato; o Limiar do Cerberus avalia e, com `bwrap` utilizável, ensaia os scripts num sandbox antes de ativar (sem ele, nada é ensaiado) |
| **CLI, hook e kit** | o que roda com as suas permissões | o hook barra gate fora da fila; nenhum segredo fica no repositório do projeto |

O que conta como vulnerabilidade, por exemplo: passar pelo túnel sem a conta dona ou sem a chave; executar comando por
uma rota ou ação fora da lista fechada; uma página de outra origem acionar o painel local; o token do widget valer fora
da rota dele; texto do chat ou do terminal vazar para log ou notificação; o sandbox do Limiar deixar o plugin escrever
fora dele.

## Fora do escopo

- **O que você aprova.** O Cerberus barra e avisa, mas não é um sandbox geral: plugin, `post-install.sh` ou comando que
  você aprova executa como você, por desenho.
- **Quem já tem a chave.** Quem passa pelas duas camadas do túnel tem, de propósito, o painel, o chat e os terminais:
  trate a chave de acesso como uma senha de shell. Vazamento da chave por quem a guarda não é falha da Hades.
- **Acesso local à sua conta.** Quem já roda código como o seu usuário lê `~/.claude/hades/` e tudo o mais.
- **Dependências externas** (Bun, devtunnel, herdr, Claude Code, `gh`, docker): reporte a quem as mantém. Entra no
  escopo o jeito como a Hades as usa.
- **O projeto e o plugin de cada projeto**: reporte a quem os mantém.
- Falhas que só existem com uma configuração desligada de propósito (por exemplo, um túnel republicado à mão como
  anônimo).
