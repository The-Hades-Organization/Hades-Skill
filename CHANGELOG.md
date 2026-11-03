# Changelog — skill `hades`

Formato: uma seção por versão, a mais nova no topo. Cada entrada diz **o que mudou, por quê, e o que se descobriu no
caminho** (regra de negócio, armadilha, número medido). Versão: minor = capacidade nova; patch = correção ou armadilha;
major = quebra de contrato do kit (`env.sh`, layout de `$D`, nomes de scripts).

## 6.0.0 — 2026-11-03

Primeiro release público, sob a licença MIT. O repositório recomeça aqui, e este arquivo também: o resumo abaixo é o que
a skill faz hoje, por área. Para instalar, `git clone` em `~/.claude/skills/hades` e `kit/install.sh` (README,
§Instalação); o pacote `hades-skill-v<versão>.tar.gz` segue como alternativa sem git. Vulnerabilidade se reporta em
privado, como diz o [`SECURITY.md`](SECURITY.md).

- **Loop de engenharia.** `deliver` leva a spec até a PR (código, gates, `/review-agents`); `inbox` faz a triagem dos reviews
  recebidos e corrige os achados vivos; `review` revisa PRs de terceiros em paralelo; `cascade` e `sweep` cascateiam a
  stack nos quatro sentidos; `orchestrate` e `consolidate` alocam agentes pelo herdr e juntam as PRs numa só, com gate
  único. Cada PR tem um estado calculado por um coletor só de leitura, e o loop **para em `done-pending`**: o merge é
  sempre do dono. Papéis com cartão próprio (implementação, revisão), brief por agente, handoff para estacionar e
  escalada de dúvida ao dono. `hades usage` mede o consumo de tokens por papel, agente e dia.
- **Fila de gates e teto de memória.** Tipos, testes e build passam um de cada vez por uma fila com orçamento de memória
  (`gate-lock`); o hook barra o gate que tenta furar a fila, e o ambiente local cede e pausa quando um gate espera
  memória. No macOS a fila mede pelo `kern.memorystatus_level`.
- **Ambiente local.** A branch `hades/local` (base do projeto mais as PRs, em ordem topológica), infra docker própria,
  serviços sob o teto de memória da slice do systemd, dados e processos de apoio do projeto, snapshot dos bancos antes
  de cada atualização, limpeza de disco e rotação de logs. `/hades env up|update|pause|resume|status|panel|config|doctor|onboard`.
- **Painel web.** Operação ao vivo em `127.0.0.1`: visão geral, branch e PRs, fila de gates, consumo, orquestração,
  revisões, loop, logs, notificações, onboarding, plugins, qualidade, Cerberus e Configurações. Tour por página, prévia
  de exemplo nas páginas vazias, PWA e uma página de chat com o Claude Code, também pelo celular.
- **Túnel.** Acesso de fora pelo devtunnel, com duas camadas obrigatórias: só a conta dona do túnel passa, e uma chave de
  acesso vira cookie `HttpOnly; Secure; SameSite=Strict`, com bloqueio de tentativas erradas por IP. Túnel anônimo só para
  o front do ambiente (com prazo, barrado pelo Cerberus até o dono aprovar) e para o widget.
- **Argos e herdr.** A página dos agentes como grafo navegável, com canvas que reage a mudanças de fora por SSE, notas,
  terminais dos agentes com histórico, seleção e colagem, e ações sobre os agentes. O diário de eventos por agente
  (`hades journal`) é a base comum do Argos e do Thanatos.
- **Cerberus.** Três cabeças guardam as fronteiras: a **Porta** (o que sai: push, comentário, artefato, túnel, release),
  o **Limiar** (o que entra: plugin, `post-install.sh`, hooks, páginas e rotas, com ensaio em sandbox quando há `bwrap`)
  e a **Vigília** (o que acontece dentro: auditoria do DONE e coerência entre plano, registro e realidade). Cada uma tem
  modo `barra` ou `avisa`; exceção e mudança de modo só o dono abre.
- **Moirai.** Estimativa de custo e duração por unidade de um plano, a partir do que as unidades encerradas custaram,
  antes da aprovação.
- **Caronte.** Empacota uma orquestração num arquivo cifrado com senha para retomá-la em outra sessão ou máquina
  (`caronte pack|unpack|brief`, `agent park`), com validação dos destinos e desfazer.
- **Thanatos.** Post-mortem de incidente ou bug em produção do projeto, montado de git, PRs, reviews e diário de eventos,
  fora do repositório.
- **Regras de qualidade.** Pacotes de regras de engenharia que o dono liga e desliga, injetados nos briefs; as do projeto
  valem por cima. Autonomia do orquestrador em dois controles que nascem desligados.
- **Perfis de projeto, stacks e plugins.** O que é de cada projeto mora num perfil (`/hades project init` gera o
  primeiro); pacotes de stack e um catálogo de checagens; plugins acrescentam ambiente, páginas e rotas, sempre com a
  prévia do commit e do que executa, avaliados pelo Limiar. Várias instâncias na mesma máquina.
- **Notificações e widget Android.** Aviso no desktop (`notify-send`) e no celular (ntfy) quando algo espera pelo dono;
  widget de tela inicial com agentes ativos, parados e perguntando, por token de leitura que só vale na rota do widget.
- **Doctor e onboarding.** `hades doctor` confere a instalação e diz o comando que corrige cada item; o onboarding
  entrega os passos que são do dono, com a mesma fonte de verdade para o comando, a página e o doctor.
- **Evolução da skill.** `hades skill-release` (`drift`, `check`, `guard`, `release`) valida o kit, roda as guardas de
  nome de projeto e de domínio e a regressão, e empacota; `hades agent skill-new` abre unidades de evolução em worktrees
  próprias; `hades contrib` devolve a melhoria ao repositório da skill.
- **Garantias que não cedem a pedido.** Nunca faz merge, nunca faz push sem conferir o upstream, nunca pula hook, nunca
  enfraquece teste, nunca declara verde um gate que não rodou e nunca escreve estado dentro do repositório do projeto
  (tudo vive em `~/.claude/hades/`).

O que mudou para abrir o repositório:

- **Licença e avisos.** `LICENSE` (MIT) e `THIRD_PARTY_NOTICES.md` com versão, origem e licença de cada biblioteca, fonte e
  componente adaptado que o painel redistribui; `kit/panel/ui/vendor/OFL.txt` com a OFL 1.1 das fontes; cabeçalho de
  licença nos bundles que não o traziam.
- **Componentes do painel reescritos.** Oito efeitos do painel (sino, cifra, botão de segurar, tinta metálica, barra de
  prompt, segmento elástico, névoa e ondas) foram reimplementados do zero, em sala limpa, a partir de uma especificação de
  comportamento, com os mesmos nomes e exports. A origem anterior tinha licença que proibia redistribuir os componentes.
- **CI público.** `.github/workflows/ci.yml` roda tipos (núcleo e UI), a suíte `loop/test/ts` e a guarda de release em
  cada PR, com actions fixadas por SHA. Os casos que exigem mais memória do que a máquina tem são pulados com o motivo no nome.
- **Checagem de versão sem login.** A VERSION mais recente é lida anonimamente do repositório público; o `gh` fica de
  reserva para fork privado ou espelho (`HADES_VERSION_CHECK_RAW_BASE`).
- **Guarda de repositório proibido.** `skill-release guard` reprova link para os repositórios listados em
  `HADES_FORBIDDEN_REPOS`, para que nada privado vaze para a árvore pública.
- **Segurança e contribuição.** `SECURITY.md` (relato privado pelo GitHub, versões suportadas, alcance) e o fluxo de
  contribuição por fork e PR no README.
