# Configurações do Hades (`config.tsv`, `config.env`, painel → Configurações)

Todo parâmetro ajustável do ambiente fica num catálogo só e é editável pelo painel, sem mexer em script nem em arquivo
do systemd. Nenhum script guarda padrão próprio: um valor ajustado nas Configurações nunca é desfeito por uma subida.

Os nomes de unit, slice, projeto compose e túnel citados aqui são os da instância original; numa instância com `HADES_ID` o prefixo vira `hds_<id>` e o slice/projeto `hades_<id>` (`reference/projects.md` §Várias instâncias). O `config.sh` também exporta `HADES_ID`, `HU`, `HSLICE` e `HPROJ`
(não são chaves do catálogo: vêm do `env.sh`) e define `hades_base` (a base da `hades/local`).

## Peças

| Arquivo | Onde | O que é |
|---|---|---|
| `kit/config.tsv` | kit (instalado em `$D`) | catálogo: chave, padrão, tipo, grupo, rótulo, como aplicar, descrição (TAB). Fonte única dos padrões e da tela |
| `$D/plugin/config.tsv` | do plugin do projeto (`<pacote>/env/config.tsv`, instalado pelo `install.sh`) | mesmo formato, somado ao catálogo (§Chaves do plugin). Sem plugin, o catálogo é só o do kit |
| `$D/config.env` | estado (o `install.sh` nunca toca) | valores do dono, só o que difere do padrão, `KEY=VALUE` por linha |
| `kit/config.sh` | kit (um arquivo só, com dois usos) | `source` pelo `env.sh` exporta as chaves para todo script; executado, é a CLI: `config.sh show \| get K \| set K=V … \| unset K …`, `export`, `import`, `apply-slice` (grava e aplica o slice). O painel (TS, `src/lib/config.ts`) lê o mesmo catálogo com a mesma precedência |

**Precedência** de cada chave: variável já definida no shell > `config.env` > padrão do plugin > padrão do `config.tsv` do kit. Assim `HADES_SLICE_MAX=5G run-hades` vale só naquela execução.

O `config.env` só recebe valores validados pelo tipo, sem espaço, aspas nem `$`; o `config.sh` lê sem `eval`.

## Chaves

Um bloco por grupo, na ordem do `kit/config.tsv` (a mesma da página Configurações). O padrão vem entre parênteses; as chaves
vão inteiras, para o grep achar.

### Memória
| Chaves | Aplicar |
|---|---|
| `HADES_SLICE_MAX` (3260M), `HADES_SLICE_HIGH` (3000M), `HADES_SLICE_SWAP` (512M) | na hora: `config.sh apply-slice` grava `~/.config/systemd/user/hades.slice` e faz `systemctl --user set-property --runtime` no slice vivo. No macOS não há slice: `apply-slice` só avisa e sai 0; o teto dos gates é o vigia de RSS do `gate-lock` (`reference/loop/gates.md`) |
| `HADES_SVC_HEAP_MB` (384) | reiniciar os serviços |

### Builds e fila
| Chaves | Aplicar |
|---|---|
| `HADES_BUILD_HEAP_MB` (4096), `HADES_BUILD_COST_GB` (4), `HADES_ENABLE_COST_GB` (3), `HADES_WEB_COST_GB` (5), `HADES_WEB_HEADROOM_GB` (5), `HADES_WEB_WORKERS` (1) | próximo build |

### Fila de gates
| Chaves | Aplicar |
|---|---|
| prefixo `HADES_GATE_`: `HADES_GATE_BUDGET_GB` (8), `HADES_GATE_RESERVE_GB` (2), `HADES_GATE_HEADROOM_GB` (3), `HADES_GATE_PSI_MAX` (10), `HADES_GATE_HEAVY_MAX` (1), `HADES_GATE_PAR_LINT` (0), `HADES_GATE_PAR_BUILD` (0), `HADES_GATE_COST_MEASURED` (0), `HADES_GATE_PRIORITY` (0), `HADES_GATE_WINDOW` (vazio), `HADES_GATE_PROJECT_BUDGET_GB` (0), `HADES_GATE_SCOPE` (projeto \| maquina), `HADES_GATE_OVERRUN_MIN` (90), `HADES_GATE_OVERRUN_FACTOR` (5) | próximo `gate-lock run` (lê o `config.sh` da instalação a cada chamada; variável exportada vence). Os padrões são o comportamento de antes: 8 GB, um pesado por vez, FIFO. `HADES_GATE_COST_MEASURED=1` troca o custo da etapa pelo maior pico das 5 últimas execuções; `HADES_GATE_WINDOW` (`HH:MM-HH:MM`) vale só para gate pesado; `HADES_GATE_PAR_LINT`, `HADES_GATE_PAR_BUILD` e o `parallel` da etapa limitam quantos do tipo rodam juntos; `HADES_GATE_PROJECT_BUDGET_GB` reparte o orçamento entre projetos; `HADES_GATE_SCOPE=maquina` junta todos os projetos numa fila só (`reference/stacks.md` §A fila) |

### Subida (run-hades)
| Chaves | Aplicar |
|---|---|
| `HADES_RUN_TUNNEL` (1), `HADES_GH_USER` (vazio = conta ativa) | próximo `run-hades`; `--tunnel` e `--no-tunnel` forçam na hora (os passos do plugin têm chave e flag próprias, `panel.runFlags`). `HADES_RUN_TUNNEL=1` e a guarda `tunel-acesso` do Cerberus convivem: `reference/tunnel.md` §Túnel do front |

### Plantão
| Chaves | Aplicar |
|---|---|
| `HADES_CEDE` (1), `HADES_CEDE_AVAIL_MB` (7168), `HADES_WATCH_PR_EVERY` (600) | reiniciar o `watch.sh` |

### Túnel
| Chaves | Aplicar |
|---|---|
| `HADES_TUNNEL_PORT` (vazio; o plugin dá o padrão) | próximo `tunnel.sh create`/`start` (`reference/tunnel.md`). Vazio = sem túnel do front |
| `HADES_TUNNEL_ANON_TTL` (1d) | próximo `access create` |
| `HADES_WIDGET_TUNNEL_TTL` (30d) | próximo `tunnel.sh widget-publish-cmds`/`widget-renew-cmds`/`widget-stamp` (`reference/tunnel.md` §Túnel do widget) |

### Painel
| Chaves | Aplicar |
|---|---|
| `HADES_PANEL_PORT` (21220) | reiniciar o painel (e o túnel do painel, que segue a porta) |
| `HADES_CANVAS_PORTAL_HOSTS` (vazio; hosts por vírgula, `*.exemplo.com` aceito) | próximo pedido do painel (o nó portal do canvas; `reference/argos.md` §Portal web) |
| `HADES_SUPERVISOR_CLAUDE` (1) | próximo pedido do painel: a consulta e o resumo das notas do supervisor do canvas vão ao `claude -p` (o texto sai da máquina); 0 deixa só o cartão local e as anotações (`reference/argos.md` §Supervisor) |
| `HADES_PANEL_AUTOSTART` (off \| login \| boot) | na hora: `panel.sh autostart` habilita/desabilita a unit `hds-panel` e, em `boot`, liga o linger (`reference/panel.md` §Início automático) |
| `HADES_PLUGIN_GIT_TIMEOUT` (120 s) | próxima operação da página Plugins: teto de cada clone e fetch do `plugins.sh` (`reference/projects.md` §Plugin do Hades) |
| `HADES_VERSION_CHECK_REPO` (`The-Hades-Organization/Hades-Skill`) | próxima checagem: repositório (dono/nome) cuja `VERSION` do branch padrão é lida **sem login** (GET anônimo em `<HADES_VERSION_CHECK_RAW_BASE>/<repo>/HEAD/VERSION`); se o repo não responder como público (404, sem rede, erro do servidor) a checagem cai no `gh api` com o tempo que sobrou. Resposta que não é `X.Y.Z` (ou maior que 256 bytes) é recusada sem tentar o `gh` |
| `HADES_VERSION_CHECK_HOURS` (1; 0 desliga) | próxima checagem: intervalo entre consultas ao GitHub; dentro dele painel e doctor leem o cache `$D/version-check.json` |
| `HADES_VERSION_CHECK_TIMEOUT` (8 s) | próxima checagem: teto da consulta inteira (o GET e, se couber no que sobrou, o `gh`); passou disso, a checagem fica oculta até o próximo intervalo |
| `HADES_VERSION_CHECK_GH_USER` (vazio = conta ativa do `gh`) | próxima checagem: conta cujo token (`gh auth token --user`) lê o repo da skill. Preenchida, a checagem usa **só** o `gh` com essa conta (nunca o GET anônimo). **Não herda `HADES_GH_USER`**, que é a conta do projeto e costuma não ter acesso ao repo da skill. Conta que não existe ou sem acesso: checagem oculta e calada. Trocar a conta vence o cache |
| `HADES_VERSION_CHECK_RAW_BASE` (`https://raw.githubusercontent.com`) | próxima checagem: servidor do GET anônimo da `VERSION`. Só se muda para um espelho próprio; os testes apontam para uma porta local |
| `HADES_WIDGET_EVENTS` (8) | próxima leitura do widget: quantos eventos recentes `GET /api/widget` devolve (`reference/panel.md` §Widget Android) |
| `HADES_WIDGET_PORT` (21221) | reiniciar o painel (o listener do widget sobe com ele) e refazer `tunnel.sh widget-create`; só pelo painel local. Instância extra recebe a primeira porta livre no install (`reference/projects.md` §Várias instâncias) |
| `HADES_WIDGET_PRS_TTL` (300) | próxima leitura do widget: idade do cache das PRs da seção `prs` do `GET /api/widget` (coletor do loop; nunca abaixo de 300 s) |

### Orquestração
| Chaves | Aplicar |
|---|---|
| `HADES_ORCH_*` (pastas, workspace, assignee, reviewers, ClickUp, owners de spec, agente parado) e `HADES_SKILL_PORT_MIN`/`HADES_SKILL_PORT_MAX` (faixa de portas de teste das unidades da skill: padrão 21270–21289, 20 portas, fora do painel 21220 e do widget 21221) | próxima alocação |
| `HADES_ARGOS_AGENT_MAX_AGE_H` (24, 0–8760 h: agente cuja última atividade passou disso sai do grafo do Argos e, pela sincronia, do canvas; 0 = mostra todos) | próxima atualização do grafo. Ver `reference/argos.md` §Corte por idade |
| `HADES_ARGOS_ACTION_TIMEOUT_S` (1200, 10–3600 s: tempo de uma ação do Argos sobre o agente; `answer` e `prompt` no máximo 120 s; passou disso, `action_timeout`) | próxima ação. Ver `reference/argos.md` |
| `HADES_THANATOS_SUGGEST` (1; 0 desliga a sugestão do watch), `HADES_THANATOS_SOURCE_TIMEOUT_S` (60, 1–600), `HADES_THANATOS_IO_TIMEOUT_S` (60, 1–600: cada git e gh), `HADES_THANATOS_MAX_PRS` (30, 1–200), `HADES_THANATOS_JOURNAL_MAX` (40, 1–500 eventos do diário na linha do tempo) | próxima execução. Ver `reference/thanatos.md` |
| `HADES_MOIRAI_MIN_SAMPLE` (5, 1–100: amostra mínima de parecidas; abaixo, confiança baixa e regra só de tamanho), `HADES_MOIRAI_HIGH_FACTOR` (3: múltiplo da mínima para confiança alta), `HADES_MOIRAI_WINDOW_DAYS` (90, 0 = tudo), `HADES_MOIRAI_SMALL_LINES` (150) e `HADES_MOIRAI_LARGE_LINES` (600: limites das faixas de tamanho), `HADES_MOIRAI_DEEP_TIMEOUT_S` (180, 1–1800), `HADES_MOIRAI_WARN_PCT` (100) e `HADES_MOIRAI_ASK_PCT` (150): % do p75 da estimativa em que o `hades watch` emite `BUDGET` e grava a pergunta ao dono | próxima execução do `hades moirai` e do `hades watch` (`reference/moirai.md`) |
| `HADES_CARONTE_OUT_DIR` (vazio: `~/.claude/hades/caronte`; pasta dos pacotes do `hades caronte pack`, fora de qualquer repo), `HADES_CARONTE_SCRYPT_LOG2N` (17, 14–20: custo do scrypt da senha do pacote; 17 usa 128 MB, e o valor vai no cabeçalho do arquivo) | próxima execução |
| `HADES_ORCH_AUTO_START` (0; 1 = `new`/`skill-new` imprimem o `herdr agent start` sem o `! ` para o orquestrador rodar como Bash, e a regra allow `Bash(herdr agent start:*)` entra no `settings.json` do usuário), `HADES_ORCH_AUTONOMY` (0, 0–3, controle deslizante: quanto o orquestrador decide sozinho; `reference/autonomia.md`). Só o dono muda (painel local ou `!`; o hook e o painel remoto barram) | próxima execução |

### Modelos por papel
| Chaves | Aplicar |
|---|---|
| `HADES_MODEL_<PAPEL>`, `HADES_EFFORT_<PAPEL>` (`ORCHESTRATOR`, `SPEC`, `IMPL`, `CONSOLIDATE`, `REVIEW`, `ESCALATE`), `HADES_ESCALATE_GATE_WAVES` | próxima vez que o agente subir |
| `HADES_REVIEW_SUBAGENT_MODELS` (mapa por subagente) | aplicar nos subagentes (`hades models` grava o `model:` em `~/.claude/agents/review-*.md`) |

### Contexto e espera
| Chaves | Aplicar |
|---|---|
| `HADES_CTX_GUARD`, `HADES_CTX_CAP_<PAPEL>` (e `HADES_CTX_CAP_INTERACTIVE`), `HADES_CTX_REWARN`, `HADES_POLL_GUARD`, `HADES_POLL_REPEAT_MIN`, `HADES_POLL_LOG_SETTLE_S` (15; log parado há esse tempo deixa de contar como polling), `HADES_READ_WARN_KB` (aviso de leitura grande; 0 desliga) | na hora: o `hades guard` lê a cada chamada |
| `HADES_PARK_GATE_WAIT_MIN`, `HADES_PLAN_REQUIRED`, `HADES_USAGE_DAYS` | próxima execução |
| `HADES_JOURNAL` (1; 0 desliga a gravação), `HADES_JOURNAL_DAYS` (14, 1–3650), `HADES_JOURNAL_MAX_MB` (20, 1–1024; passou disso `<agente>.jsonl` vira `<agente>.1.jsonl`) | o teto e o liga/desliga na hora (o hook lê a cada chamada); os dias na próxima limpeza (`clean`, categoria `journal`). Ver `reference/journal.md` |

### Diagnóstico
| Chaves | Aplicar |
|---|---|
| `HADES_DOCTOR_DISK_WARN_GB` (10), `HADES_DOCTOR_DISK_MIN_GB` (2), `HADES_DOCTOR_SUBNET`, `HADES_DOCTOR_NODE_BINS` (os dois últimos: padrão do plugin) | próxima execução do `doctor.sh` (`reference/doctor.md`) |

### Limpeza
| Chaves | Aplicar |
|---|---|
| `HADES_CLEAN_LOG_MAX` (50M), `HADES_CLEAN_PRIO_LOG_MAX` (20M), `HADES_CLEAN_PRIO_LOGS`, `HADES_CLEAN_LOG_TOTAL` (500M), `HADES_CLEAN_LOG_KEEP` (3), `HADES_CLEAN_JOBS_KEEP` (100), `HADES_CLEAN_JOBS_DAYS` (14), `HADES_CLEAN_CACHE_DAYS` (1), `HADES_CLEAN_RELEASES_DIR`, `HADES_CLEAN_RELEASES_KEEP` (2), `HADES_CLEAN_TIMER` (on), `HADES_CLEAN_EVERY` (6h) | na hora: `clean.sh apply` regrava o timer `hds-logrotate`; o resto vale na próxima limpeza (`reference/limpeza.md`) |

### Snapshots
| Chaves | Aplicar |
|---|---|
| `HADES_SNAPSHOT_MODE` (migration \| always \| never), `HADES_SNAPSHOT_KEEP` (5), `HADES_SNAPSHOT_MAX_GB` (10) | próximo `snapshot.sh` / `update.sh` (`reference/snapshot.md`) |

### Notificações
| Chaves | Aplicar |
|---|---|
| `HADES_NOTIFY` (0), `HADES_NOTIFY_DESKTOP` (1), `HADES_NOTIFY_NTFY` (0), `HADES_NOTIFY_NTFY_URL`, `HADES_NOTIFY_EV_<GATE\|RESTART\|HEALTH\|PR\|AGENT\|SNAPSHOT\|DOCTOR\|CHAT\|HERDR>` (both), `HADES_NOTIFY_EVERY` (30), `HADES_NOTIFY_PRS_EVERY` (300), `HADES_NOTIFY_AGENTS_EVERY` (120), `HADES_NOTIFY_DOCTOR_EVERY` (1800), `HADES_NOTIFY_GATE_WAIT_MIN` (20), `HADES_NOTIFY_RESTARTS` (3), `HADES_NOTIFY_DEDUPE_MIN` (60), `HADES_NOTIFY_QUIET` | na hora: o vigia relê a cada ciclo; `HADES_NOTIFY` liga/desliga a unit (o painel aplica ao salvar; senão `notify.sh apply`). Tipos novos: `url`, `hours` (HH:MM-HH:MM). O tópico do ntfy não é chave: fica em `$D/ntfy.topic` (`reference/notify.md`) |

### Sessão Claude
| Chaves | Aplicar |
|---|---|
| `HADES_CHAT` (1), `HADES_MODEL_CHAT` (claude-opus-5-5), `HADES_EFFORT_CHAT` (high), `HADES_CHAT_MAX` (2), `HADES_CHAT_BIN` (vazio = `claude` do PATH), `HADES_CHAT_ATTACH_MB` (5) | na hora: o painel lê a cada requisição; modelo e esforço valem na próxima mensagem. `HADES_CHAT` e `HADES_CHAT_BIN` só mudam pelo painel local (`reference/panel.md` §Claude). É o grupo da página Claude; `HADES_CHAT_ATTACH_MB` é o teto de cada anexo do chat |

### Terminal
| Chaves | Aplicar |
|---|---|
| `HADES_TERMINAL` (0), `HADES_TERMINAL_MAX` (4), `HADES_TERMINAL_IDLE_MIN` (30; 0 = sem limite), `HADES_TERMINAL_SCROLLBACK_KB` (256) | na hora: o painel lê a cada requisição; o anel vale na próxima sessão aberta. **As quatro só mudam pelo painel local** (`reference/panel.md` §Terminal), inclusive no import. |
| `HADES_TERMINAL_KEYS` (esc,tab,ctrl,up,down,left,right,enter,pipe,tilde,slash,dash,paste,copy,1,2,3,y,n,shift-tab,ctrl-c) | ao recarregar a página: lista de ids da barra de teclas do celular (`reference/panel.md` §Terminal › Interface). Id desconhecido invalida a lista: cai no padrão e a tela avisa. Não é da lista "só painel local": só muda a barra, não abre acesso. |

### Cerberus
| Chaves | Aplicar |
|---|---|
| `HADES_CERBERUS_PORTA` (barra), `HADES_CERBERUS_LIMIAR` (barra), `HADES_CERBERUS_VIGILIA` (avisa): `off` \| `avisa` \| `barra`; `HADES_CERBERUS_TIMEOUT_S` (60), `HADES_CERBERUS_HIST_KB` (2048), `HADES_CERBERUS_EXC_TTL_H` (24), `HADES_CERBERUS_PORTA_TUNEL_HOSTS` (padrões de host do túnel, vírgula; vazio = nenhum permitido), `HADES_CERBERUS_VIGILIA_IO_S` (8, 1–60 s: tempo de cada leitura de git, `gh` e herdr das guardas da Vigília; passou disso, o item vira aviso) | na próxima avaliação. Só mudam pelo painel local ou pelo `!` do dono: o acesso remoto recusa (também no Importar) e o hook barra a troca vinda das ferramentas do Claude (`reference/cerberus.md` §Modos) |

Regras validadas: tamanhos `512M`/`4G` (mínimo 64M), `HADES_SLICE_HIGH` ≤ `HADES_SLICE_MAX`, inteiros dentro da faixa
do catálogo, `multi:` subconjunto da lista do tipo, `port` entre 1024 e 65535 (ou vazio).

**Fora das Configurações, de propósito:** as portas que o ambiente do projeto fixa nos arquivos dele (contrato do plugin;
as que o núcleo confere vêm das chaves do plugin, §Chaves do plugin), os caminhos do `env.sh` e os segredos (`root.env`,
`credenciais.md`).

## Chaves do plugin

O plugin do projeto soma chaves ao catálogo por `env/config.tsv` (mesmo formato de 7 colunas TAB; linha fora do formato
derruba o catálogo com o nome do arquivo e a linha, como no kit). Regras:
- **Chave nova:** entra com o grupo, o rótulo e a descrição do plugin; grupo novo ganha ícone por `plugin.json →
  panel.configGroups`. O modo de aplicar é um do núcleo ou um declarado em `panel.applies` (rótulo, botão e a ação do
  plugin que o executa).
- **Chave que o núcleo já tem:** só o padrão do plugin vale (tipo, grupo, rótulo e aplicar ficam os do kit). É assim
  que o plugin dá a porta do túnel (`HADES_TUNNEL_PORT`).
- **Sem plugin, ou plugin sem `config.tsv`:** o catálogo é o do kit, nada do projeto aparece.
- **Valor já gravado** no `config.env` continua valendo sem migração: a chave saiu do kit e voltou pelo plugin com o
  mesmo nome. Chave do `config.env` fora do catálogo atual (plugin desinstalado ou trocado) fica no arquivo como estava
  ao salvar outra chave, e volta a valer quando o plugin volta.

As chaves do ambiente instalado: `ref env-extensions` §Configurações.

## A página Configurações

Página **Configurações**: um card por grupo, controle por tipo (switch, segmentado, caixas, campo), selo "fora do padrão" e
botão de voltar ao padrão. Salvar grava o `config.env` e mostra o card **Falta aplicar** com um botão por modo
(teto no slice, reiniciar serviços ou painel, início automático, timer de limpeza, e os modos do plugin). O diálogo **Subir o Hades** parte de `HADES_RUN_*` e só
manda flag para o que o dono mudar ali. A porta e o início automático do painel não se mudam pelo acesso remoto.

## Exportar e importar

`config.sh export [--all] [--include-identity]` imprime um arquivo texto: cabeçalho (`#`: versão da skill, data, "valores do dono")
e `KEY=VALUE`. O padrão leva só o que difere do padrão; `--all` leva todas as chaves. **Nunca vai:** segredo (tipo
`secret`, ou chave em `SECRET_KEYS` no `config.sh`; nem com flag, e o import também o ignora) e dado desta máquina ou da
conta do dono (tipos `path`, `login`, `logins`, `emails`, `digits`, `url`: o servidor ntfy próprio), que só entra com `--include-identity`. Chave nova
sensível: dê a ela o tipo certo no catálogo e o export já a trata.

`config.sh import <arquivo> [--dry-run] [--yes]` valida cada chave pelo tipo do catálogo e mostra o diff
(`atual → novo`, e o modo de aplicar de cada uma). Chave desconhecida, segredo e linha mal formada viram aviso/erro **por
linha**, nunca derrubam o resto: o arquivo pode vir de outra versão. `--dry-run` só mostra. Sem ele, grava só depois de
confirmar no terminal (`--yes` dispensa; sem TTY exige `--yes`); com erro no arquivo, `--yes` grava só o válido. O import só
altera as chaves presentes no arquivo (não volta nenhuma ao padrão) e respeita `MemoryHigh ≤ MemoryMax`.

No painel: **Exportar** (diálogo com "tudo" e "contas e caminhos") baixa `hades-config-<data>.env` por
`GET /api/config/export`; **Importar** lê o arquivo, pede a prévia em `POST /api/config/preview` (não grava), mostra o
diff num diálogo e, ao confirmar, grava por `POST /api/config`; os modos de aplicar entram no **Falta aplicar**. Pelo acesso
remoto o import ignora `HADES_PANEL_PORT` e `HADES_PANEL_AUTOSTART` (como o salvar) e o export não inclui contas e caminhos.

## Busca

Campo fixo no topo da página: filtra por rótulo, chave, descrição e grupo, sem diferenciar acento nem maiúscula (várias
palavras = todas devem aparecer); cards sem resultado somem. Filtros **Só fora do padrão** (valor ≠ padrão) e **Falta aplicar**
(o que foi salvo ou importado nesta sessão e ainda espera um modo de aplicar). `/` foca a busca, Esc limpa. O estado fica
na URL: `#/config?q=teto&f=alt,falta` (`f`: `alt`, `falta`), para dar link direto. O layout segue em colunas
(`xl:columns-2` + `break-inside-avoid`).

## Chave nova

1. Linha no `config.tsv` do kit, ou no `env/config.tsv` do plugin se a chave é do ambiente do projeto (tipo e modo de aplicar existentes, ou estenda `config.sh validate` e o card Falta aplicar).
2. Usar `$CHAVE` no script (o `env.sh` já exporta; nada de padrão repetido no script).
3. A tabela de §Chaves (no bloco do grupo). Reinstalar e conferir com `config.sh show` e na página.

## Onboarding

O onboarding (`reference/onboard.md`) não tem chave própria: os passos dele ligam chaves que já existem (`HADES_NOTIFY`, `HADES_NOTIFY_DESKTOP`, `HADES_NOTIFY_NTFY`, `HADES_PANEL_AUTOSTART`, `HADES_GH_USER`, `HADES_RUN_TUNNEL`), pelo `config.sh set` do comando do passo. A escolha do dono fica em `$D/onboard.json`, fora do `config.env`.

## Guarda de repositório proibido (`skill-release guard` e `check`)

Não é chave do catálogo (a guarda roda sem `$D`, até num runner de CI): a lista vem da variável de ambiente
`HADES_FORBIDDEN_REPOS`, `dono/nome` separados por vírgula ou espaço. A guarda reprova (sem modo `avisa`) todo arquivo do pacote que
cite um deles em `github.com/<repo>`, `git@github.com:<repo>` ou `repos/<repo>` (`gh api`), sem diferenciar caixa e só pelo nome
inteiro (`a/b` não pega `a/b-outro`). Item fora do formato `dono/nome` também reprova, em vez de virar busca silenciosa. Vazia ou
ausente: não faz nada e a saída da guarda não muda. No repositório público do CI a lista fica num segredo do repositório
(`secrets.HADES_FORBIDDEN_REPOS`), nunca no código nem numa variável: o nome proibido não pode estar no que a guarda protege, e
o log do Actions é público (o segredo sai mascarado). PR vinda de fork não recebe segredos e roda a guarda sem a lista.
