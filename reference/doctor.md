# Diagnóstico (`doctor.sh`)

Uma linha por item: o que está ok, o que falta e o comando que corrige. O doctor **só diagnostica**; nunca altera nada.

```bash
$D/doctor.sh              # tabela para o terminal
$D/doctor.sh --quick      # só o que custa menos de ~2 s (sem consulta de rede nem de login); o run-hades usa este
$D/doctor.sh --json       # saída para máquina (painel, notificações)
```

`hades doctor` (e o `$D/doctor.sh`) acha a instância sozinho: sem `HADES_WT` no ambiente (shell comum, fora do `env.sh`), a CLI resolve o `$D` pelo diretório atual como o `hades instance` e roda o `$D/doctor.sh`, que carrega o `env.sh` da instância.

Código de saída: `0` tudo ok · `1` há erro · `2` só avisos. Mede ~0,3 s no `--quick` e ~1,6 s completo.

Quem chama: o `install.sh` (no fim, só informativo; `SKIP_DOCTOR=1` pula), o `run-hades.sh` (passo 0, `--quick`: **para** se sair com 1),
`/hades env doctor` e o card **Diagnóstico** da Visão geral do painel.

## O que checa e como corrigir

| Grupo | id | Erro quando | Aviso quando | Correção |
|---|---|---|---|---|
| Ferramentas | `docker` | sem docker, daemon sem resposta ou sem compose v2, onde o projeto tem ambiente de pacote (`$D/plugin`) | os mesmos, sem ambiente de pacote | `sudo systemctl enable --now docker`, `sudo usermod -aG docker $USER` e re-login; plugin docker-compose v2 |
| | `gh` | sem `gh` ou sem login (da conta `HADES_GH_USER`, quando definida; a checagem de versão não usa essa conta) | token existe mas a API não responde (só no modo completo) | `gh auth login`; `gh auth refresh` |
| | `devtunnel` | — | sem o binário, ou sem login (login só no completo); só o túnel público depende dele | `devtunnel user login -g -d` |
| | `node` | sem node, ou major diferente do `.nvmrc` do worktree | — | `nvm install <versão>` e atualizar `NODE_BIN` no `env.sh` |
| | `jq` `unzip` | ausente | — | instalar o pacote |
| | `bun` `git` `herdr` | `bun` ou `git` ausente (`herdr`: aviso, só a orquestração de agentes depende dele) | — | a linha traz a instrução do registro único (`src/deps/registry.tsv`, `reference/cli.md`); `bun <skill>/src/cli.ts deps` lista todas as dependências e o que falta |
| | `bwrap` (bubblewrap) | — | ausente, ou não sobe (sem user namespaces): a guarda `plugin-ensaio-isolado` do Cerberus não ensaia o plugin e só avisa; opcional, linha do registro (`src/deps/registry.tsv`) | instalar o pacote `bubblewrap` (`pacman -S bubblewrap`, `apt install bubblewrap`) |
| | `impeccable` (skill do dono, `~/.claude/skills/impeccable`) | — | ausente: aviso (opcional). Sem ela ficam de fora a auditoria de usabilidade do painel e a crítica de UI; as regras anti-slop do catálogo (`reference/quality.md`) seguem valendo. A Hades nunca a empacota | instalar a skill do Impeccable (https://github.com/pbakaus/impeccable) em `~/.claude/skills/impeccable`; `hades deps` mostra o estado em `optionalSkills` |
| | `systemd` | — | sem sessão de usuário com systemd (a CLI e o painel funcionam sem ele) | `loginctl enable-linger $USER` e re-login |
| | `launchd` | — | macOS: nem `gui/<uid>` nem `user/<uid>` respondem ao `launchctl print` (no lugar da linha `systemd`) | abrir uma sessão de usuário (login gráfico) e rodar de novo |
| Máquina | `portas` | porta que o Hades usa (a do painel, as do `services.tsv` e as de `HADES_PORTS_REQUIRED`) ocupada por outro | outra porta da faixa `HADES_PORT_RANGE` (início-fim) ocupada por quem não é do Hades; as duas chaves vêm do plugin do projeto, e sem elas só a porta do painel é conferida | `ss -ltnp 'sport = :<porta>'` (no macOS, `sudo lsof -nP -iTCP:<porta> -sTCP:LISTEN`) e parar o dono. Sem como listar as portas (`ss` ou `/usr/sbin/netstat` ausente, com erro ou sem resposta em 10 s): aviso "portas não verificadas", e a `rede` segue conferida. É do Hades: unit `hds-*`/slice `hades` (da instância ou de outra registrada em `~/.claude/hades/instances`), processo com o `$D` da instância na linha de comando **ou** com `HADES_DATA`/`HADES_KIT_DIR` apontando para ela no ambiente (o painel em primeiro plano, `panel serve` fora de unit), ou porta publicada por container `hades-*`. Porta de painel ou widget de outra instância registrada não é acusada |
| | `rede` | outra rede docker (que não a `<HPROJ>_default`) na sub-rede `HADES_DOCTOR_SUBNET` (padrão do plugin; vazio = sem a linha) | — | `docker network rm <rede>` se vazia |
| | `memoria` | `HADES_SLICE_MAX` maior que a RAM | teto acima de 75% da RAM | `hades config set HADES_SLICE_MAX=<valor>` e `$D/config.sh apply-slice` |
| | `disco-dados` `disco-worktree` | livre abaixo de `HADES_DOCTOR_DISK_MIN_GB` (2) | abaixo de `HADES_DOCTOR_DISK_WARN_GB` (10) | `docker system prune`, apagar `dist`/`node_modules` antigos |
| Instalação | `instance` | `~/.claude/hades/instance` ausente ou apontando para pasta sem `env.sh` | aponta para outro `$D` e nenhum `~/.claude/hades/instances/<projeto>` aponta para este (instância a mais registrada passa: `reference/projects.md` §Várias instâncias) | rodar o `kit/install.sh` (grava os dois registros) |
| | `worktree` | o `W` do `env.sh` não existe ou não é git | — | corrigir `W=` no `env.sh` ou recriar o worktree |
| | `work-root` | — | `~/.claude/hades/work-root` ausente ou apontando para pasta inexistente (o loop cai no `~/.claude/hades/work`) | `echo <pasta> > ~/.claude/hades/work-root` |
| | `slice` | `$HSLICE.slice` (`hades.slice` na instância original) não instalado, ou instalado mas não carregado no systemd (`systemctl --user show`: `LoadState` ≠ `loaded`, como com `SKIP_SYSTEMD=1`: os serviços subiriam sem teto de memória) | `MemoryMax` (arquivo ou carregado) diferente de `HADES_SLICE_MAX` | `$D/config.sh apply-slice` (ou `systemctl --user daemon-reload`). No macOS é sempre ok, informativo: não há slice (`reference/adr/0003-teto-de-memoria.md`) |
| | `kit-versao` | — | kit instalado (`$D/kit.version`, gravado pelo `install.sh`) com versão diferente da `VERSION` da skill, ou sem registro | `HADES_WT=<wt> <skill>/kit/install.sh` |
| | `node_modules` | — | algum executável de `HADES_DOCTOR_NODE_BINS` (padrão do plugin; vazio = sem a linha) falta em `node_modules/.bin` do worktree (o `run-hades` instala sozinho). Com o plugin do projeto desligado (`$D/plugins.disabled` não vazio) ou sem `$D/node-modules.sh`, a linha sai ok, "não se aplica", com o motivo: o aviso só vale onde o ambiente do plugin sobe e o script existe | `$D/node-modules.sh repair` ou a instalação de dependências do projeto |
| | `versao-nova` | — | a `VERSION` do branch padrão do repo da skill (`HADES_VERSION_CHECK_REPO`) é maior que a instalada (`kit.version`); semver numérico (4.10.0 > 4.9.0) | `git -C <skill> pull && HADES_WT=<wt> <skill>/kit/install.sh` |
| Resumidores (rtk) | `rtk` | — | rtk fora do `PATH` (opcional: sem ele nenhum resumidor liga e nada mais do grupo é checado) | instalar o rtk (https://github.com/rtk-ai/rtk) e `rtk init -g` |
| | `rtk-filtros` | — | filtros previstos para o worktree e `.rtk/filters.toml` ausente; arquivo ainda não confiado ou mudado depois de confiado (o rtk o ignora em silêncio); `HADES_RTK_FILTERS=off` com o arquivo ainda lá. Ok: filtros ativos e confiados, desligado sem arquivo, ou nenhum filtro para as stacks do worktree | `hades rtk apply <worktree> --trust` ou `cd <worktree> && rtk trust` (do dono, com `!`) |
| | `rtk-ajuste` | — | — (informativo, ok) | mostra `HADES_RTK_OFF_STACKS` e `HADES_RTK_OFF_FILTERS` quando há ajuste |
| | `rtk-recall` | — | `RTK_RECALL_DB` e `RTK_TEE_DIR` não apontam para `$D/rtk/`: a saída inteira cortada vai para o padrão do rtk | reinstalar o kit (o `env.sh` exporta) e abrir um shell novo |
| | `rtk-politica` | — | o `config.toml` do rtk está longe do recomendado: `diff` e `ps -p` em `[hooks] exclude_commands`, `grep_max_results`/`grep_max_per_file`/`max_width` acima do padrão, `[retriever]` (1.x) ou `[tee] mode = "always"` (0.x). Só lê, nunca grava | editar o `config.toml` do rtk (`reference/rtk.md` §Política) |
| Claude | `settings-padrao` | — | o padrão herdado do `~/.claude/settings.json` (caminho de `HADES_CLAUDE_SETTINGS`, por padrão o do dono): uma linha por aviso, ou `ok`. Avisa (1) `effortLevel` global `xhigh`/`max`: vale para toda sessão, agente sem flags e subagente; (2) `model` com `[1m]`: sem o limite natural do contexto, os tetos `HADES_CTX_CAP_*` viram só aviso; (3) chave do `modelSettings` que não casa com nenhum id de modelo das sessões recentes (`~/.claude/projects`; ex.: `claude-opus-5` contra `claude-opus-5-5`): a configuração não vale; (4) padrão mais caro que todos os `HADES_MODEL_*`/`HADES_EFFORT_*` (ordem de custo haiku < sonnet < opus < fable, esforço low < medium < high < xhigh < max). `settings.json` ausente ou ilegível: aviso com o motivo. Só lê, nunca grava | baixar o `effortLevel` e usar o esforço alto só no papel que precisa; tirar o `[1m]`; renomear a chave para o id exato em uso; aproximar o padrão do papel mais usado ou passar `--model`/`--effort`. A mudança é do dono |
| Subida | `boot` (só systemd) | — | o `hds-boot.timer` da subida completa automática (que saiu da skill) ainda está enabled: instalação não migrada | `systemctl --user disable --now hds-boot.timer` (a reinstalação do kit também remove a unit) |
| Limpeza | `logrotate` | — | `HADES_CLEAN_TIMER` e o timer `hds-logrotate` incoerentes (`on` sem enabled; `off` com enabled). No macOS a coerência é conferida pelo plist em `~/Library/LaunchAgents` (enabled = plist lá) | `$D/clean.sh apply` |
| Notificações | `notify` | — | `HADES_NOTIFY` e a unit `hds-notify` incoerentes (ligada sem enabled ou parada; desligada com enabled) | `$D/notify.sh apply` (no macOS o log é `$D/logs/notify.log`, não o journal) |
| | `notify-canal` | — | ligadas sem canal (desktop e celular desligados) | `$D/config.sh set HADES_NOTIFY_DESKTOP=1` |
| Memória | `memoria-indice` | — | o índice `MEMORY.md` do projeto passa do limite de carregamento (24,4 KB), tem linha acima de 150 caracteres, entrada duplicada, link para arquivo inexistente ou entrada com cara de histórico encerrado; sem índice é ok (só lê) | `hades memory tidy --dry-run`, depois `--apply` com o ok do dono (`reference/memory.md`) |
| Limites | `limites` | — | a coleta do % das janelas está desligada: o `statusLine` do `~/.claude/settings.json` não chama `hades usage sample` e não há amostra aberta (só aviso; o doctor lê o arquivo, nunca o altera) | `statusLine` = `{"type":"command","command":"hades usage sample"}` (`reference/limites.md`) |
| Painel | `painel` | — | `HADES_PANEL_AUTOSTART` e a unit `hds-panel` incoerentes (`off` com unit enabled; `login`/`boot` sem enabled; `boot` sem linger). No macOS o estado vem do launchd (enabled = plist em `~/Library/LaunchAgents`) e `boot` avisa que o painel sobe no login, não no boot | `$D/panel.sh autostart` |
| | `mark-ponte` | — | `bridge.json` do Mark (`HADES_MARK_BRIDGE`) ausente (Mark fechado), inválido, com `pid` morto, ou o Mark não responde em `/api/state` (porta fechada, token recusado, resposta fora do contrato). Ok: arquivo lido e Mark respondendo, com o estado. A sonda usa curl com o token por stdin (nunca na linha de comando nem na saída) e fica de fora do `--quick`, que só lê o arquivo. Só leitura: nunca manda comando nem acorda o Mark | abrir o Mark com `mark`; apontar `HADES_MARK_BRIDGE` para o arquivo certo; reabrir o Mark se o token foi recusado |
| | `mark-voz` | — | Só roda com o Mark respondendo ao `/api/state` e fora do `--quick`: abre `/ws/voice`, manda `hello`, espera `ready`, manda `bye` e fecha, sem enviar áudio. Aviso: o Mark responde ao estado mas não abriu a voz (versão sem voz remota). Ok também quando outro cliente tem a vaga (`busy`). A sonda roda num `bun -e` à parte e leva o token por stdin | atualizar o Mark-LVI e abrir de novo com `mark` |
| | `herdr-servidor` | — | painel ativo (unit `hds-panel`) e o socket do herdr sem resposta (`herdr api snapshot` falha): "painel no ar sem servidor herdr"; o painel sobe o servidor ao criar um terminal no canvas. Cliente de protocolo diferente do servidor (`protocol_mismatch`): "herdr incompatível com o servidor", com o binário usado; o servidor pode estar no ar. O doctor chama o mesmo herdr do painel (`HADES_HERDR_BIN`; vazio segue o PATH). Sem a linha com o painel parado ou sem o binário `herdr` | fora do ar: abrir o `herdr`, ou criar um terminal no canvas. Incompatível: apontar `HADES_HERDR_BIN` para o herdr da versão do servidor, ou atualizar o herdr do PATH |

A versão da skill vem de `HADES_SKILL_DIR` (padrão `~/.claude/skills/hades`); rodando de dentro da skill, usa o `VERSION` dela.

### Contexto fixo (`contexto-fixo`)

Grupo `Limites`, id `contexto-fixo`: a mediana do contexto da primeira resposta das sessões (entrada + leitura + escrita de
cache) dos últimos 7 dias contra os 7 anteriores (`reference/usage.md`). **Aviso** quando sobe mais que
`HADES_USAGE_BASELINE_WARN_PCT` (padrão 15), dizendo qual parte em disco cresceu (CLAUDE.md, MEMORY.md, SKILL.md, brief.md) contra o
retrato de uma semana atrás; sem retrato, diz que não identificou a parte. Com menos de 3 sessões em qualquer das janelas a
linha fica ok e neutra, com o motivo (`sem dados suficientes`), nunca aviso. Lê transcrições: fora do `--quick`.

### Plugin

Grupo `Plugin`, id `plugin`: a faixa `core` do perfil do projeto do worktree contra a `VERSION` do núcleo
(`hades project core-check`, `reference/projects.md` §Plugin do Hades). **Erro** quando o núcleo está fora da faixa ou a sintaxe do `core`
é inválida (corrige: atualizar o núcleo ou `git -C <pacote> pull`); **aviso** quando o perfil não declara `core`; ok dentro
da faixa, ou quando o repo não tem plugin. Só leitura, entra no `--quick`.

### Projeto (checagens do plugin)

Grupo `Projeto`: o `env/doctor.sh` do plugin do projeto, instalado em `$D/plugin/doctor.sh` e lido com `source` num shim de bash
(`src/lib/doctor-plugin-shim.sh`) que define `ok`/`warn`/`err`/`have` e devolve os registros ao `hades doctor`, na ordem
(o `kit/doctor.sh` é o shim de uma linha da CLI). Um `exit` dentro do arquivo do plugin encerra só o shim, não o diagnóstico. Ele usa as mesmas peças do núcleo (`ok`/`warn`/`err`/`have`, `$G`, `$D`, `$W`,
`$QUICK` e as funções do `kit/lib-checks.sh`) e, como o resto, só diagnostica. Os `id` dele são do plugin e seguem o
contrato do `--json`. Se o arquivo termina com erro, sai um aviso `plugin-doctor` e o diagnóstico continua. Sem plugin,
o grupo não aparece. A sonda de firewall docker → host do núcleo (`fw_test` do `lib-checks.sh`) mede o par
`HADES_FW_PROBE=<container>:<porta>`, também do plugin; sem a chave, não mede. As checagens do ambiente instalado:
`ref env-extensions` §Diagnóstico.

### Versão nova (`versao-nova`)

Só aparece com versão remota maior, **só aviso** e sem nenhuma linha quando está em dia, a checagem está desligada
(`HADES_VERSION_CHECK_HOURS=0`) ou não há acesso ao repo (sem rede, 404, timeout; o `gh` e o login só importam de reserva ou com conta configurada): a feature é
oculta e calada. O modo completo consulta a rede quando o intervalo venceu; o `--quick` lê só o cache. Mesmo código e
mesmo cache do painel (`hades version-check`, `$D/version-check.json`). Lê a `VERSION` por GET anônimo (repo público, sem `gh`); de reserva, a
conta ativa do `gh`, ou só a de `HADES_VERSION_CHECK_GH_USER` quando preenchida (nunca `HADES_GH_USER`, do projeto). Não atualiza nada.

### Onboarding

Grupo `Onboarding`, id `onboard`: **aviso** quando algum recurso escolhido (`onboard.sh select`) tem passo pendente (`Onboarding: N pendente(s) em <recursos>`) ou quando falta escolher ou fazer o tour (`Onboarding: falta …`); ok (`Onboarding: completo` ou `…escolhidas em dia`) nos demais casos. Nunca é erro. As linhas e a definição de completo estão em `reference/onboard.md` §Primeira etapa. Corrige com `onboard.sh show <feature>` (ou `/hades env onboard`, ou a página Onboarding do painel).
Fica fora do `--quick`: o onboarding consulta o devtunnel e o docker. As checagens que ele divide com o doctor estão em
`kit/lib-checks.sh` (`reference/onboard.md`).

## Contrato da saída `--json` (estável)

```json
{"version":1,"quick":false,"time":1792883872,"exit":2,
 "summary":{"ok":16,"warn":4,"error":0},
 "items":[{"level":"ok|warn|error","group":"Ferramentas","id":"docker","msg":"…","fix":"comando que corrige (vazio se ok)"}]}
```

- `version` só muda em quebra de contrato; campos novos podem aparecer, os de hoje não somem nem mudam de sentido.
- Os `id` listados acima são estáveis; `msg` e `fix` são texto para humano (pt-BR), não faça parse deles.

## No painel

Visão geral → card **Diagnóstico** → **Rodar diagnóstico**: ação `doctor`, que grava `$D/doctor.json` (`doctor.sh --json`) e deixa o log do mesmo diagnóstico na execução. O card lê `GET /api/doctor` (o último `doctor.json` + `mtime`; `{}` se nunca rodou) e lista avisos e erros com o comando de correção; os itens ok ficam recolhidos.

## Armadilhas

- `read` com `IFS=TAB` junta campos vazios: o doctor separa os campos internos com `\x1f`.
- `ss -p` só mostra o processo do próprio usuário; o `docker-proxy` é do root. Por isso o dono de porta de container sai do `docker ps`, não do `ss`.
- `gh auth status` bate na rede; o `--quick` usa só `gh auth token` (local).
