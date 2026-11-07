# Ambiente local (Parte I)

Texto movido do `SKILL.md`: regras duras do ambiente, onde fica cada coisa e as Fases 0–8. As regras que são
invariantes seguem resumidas no `SKILL.md` (uma linha cada); o detalhe é este arquivo.

### Regras duras do ambiente

Valem para a branch `hades/local` e o ambiente; o loop (Parte II) tem as suas.

- `hades/local` é **local**: nunca push, nunca commitar nas branches das PRs, nunca comentar/editar PR no GitHub.
  Problema que exige mudança de código numa PR → registrar em `notes.md` (vai para o STATUS) e avisar o dono.
- **Não é gate**: nada de `nx test`/`nx lint` de suíte. Compilar para rodar é o mínimo, pela fila do gate-lock.
- **O Hades cede, nunca um gate**: gate pesado esperando memória > 2 min → `hades.sh pause` (sem perder dados);
  `hades.sh resume` quando a fila esvaziar. O `watch.sh` detecta os dois. **Só o dono suspende a regra**: ele
  pede → criar `$D/cede.disabled` (o `watch.sh` para de emitir `CEDE`); reativar apagando o arquivo. Parar um gate de
  outro agente também só com pedido explícito do dono (`systemctl --user stop <scope run-p…>` do gate, nunca `pkill`).
- **Nada destrutivo fora do Hades**: nada de `docker system prune`, `pkill -f`, volume que não seja do projeto
  `hades`, nem os containers de nome aleatório (testcontainers de gates alheios) e os containers de outro projeto com `container_name` fixo.
- **Túnel público é passo do dono**: liberar acesso anônimo e hospedar o túnel são recusados ao agente pelo auto
  mode (External Ingress). O agente prepara e entrega os comandos `! ...` (ver `reference/tunnel.md`).
- Credenciais só em `$D/credenciais.md` (600). Nunca em log, commit ou conversa além do necessário.
- **Antes de subir qualquer coisa numa máquina nova, proponha e espere o ok** (Fase 0).
- **A skill evolui com o uso**: pedido fora do escopo → resolver no vivo, generalizar no `kit/` (nunca só em `$D`),
  documentar e gerar versão nova com `kit/skill-release.sh` (`reference/evolving.md`). Versão atual em `VERSION`,
  histórico em `CHANGELOG.md`.

### Onde fica cada coisa

| | |
|---|---|
| `kit/` (esta skill) | a parte da **máquina**: install, config, doctor, onboarding, painel, notificações, túnel, fila de gates, rotação de logs, `skill-release` |
| `<pacote>/env/` (`env.pack` do perfil) | o **ambiente do projeto**, com o mesmo layout do `$D`: infra, dados, processos de apoio, serviços (`services.tsv`, `svc.sh`…), `run-hades.sh`, `update.sh`, `STATUS.template.md`; `assets/`, `reference/` (textos, abertos por `ref env-<nome>`) e `post-install.sh` não vão para o `$D`. Sem `env.pack` o `install.sh` instala só a máquina |
| `VERSION` · `CHANGELOG.md` (esta skill) | versão atual e histórico (o que mudou, por quê, o que se descobriu) |
| `$D` = `<worktree>-data` | kit e ambiente do pacote instalados (o `install.sh` copia o `kit/` e depois sobrepõe o `env/`) + estado (`env.sh`, `config.env`, `root.env`, `credenciais.md`, `seed/*state.json`, `conflicts.log`, `notes.md`, `STATUS.md`, `logs/`) |
| `<worktree>` | branch `hades/local`, `.env` de cada serviço (gerados), `dist/` e o que o pacote extrair (excluído do git) |

Scripts da máquina instalados em `$D` (todos fazem `source env.sh`):
**`run-hades.sh`** (entrypoint único do dono: sobe tudo, idempotente, à prova de reboot — `reference/run-hades.md`) ·
`config.sh` · `config.tsv` · `prs.sh` · `hades.sh` · `rebuild-branch.sh` · `panel.sh` · `gate/gate-lock.sh` · `tunnel.sh` · `watch.sh`. Os `.sh` do kit são shims permanentes de uma linha da CLI `hades <subcomando>` (`reference/cli.md`), exceto `config.sh` (lógica própria, o mesmo que `hades config`).
Os scripts do ambiente do projeto (infra, serviços, dados, processos de apoio) vêm do `env/` do pacote: lista e roteiro em `ref env-phases`.

### Fluxo

> **Atalho do dono:** as Fases 1→7 abaixo estão encapsuladas em `$D/run-hades.sh` (alias `run-hades`) — um comando
> idempotente e à prova de reboot que o **dono** roda direto, sem agente, inclusive para trocar o conjunto de PRs
> (`run-hades 4937 4959`). O agente usa as fases individualmente quando precisa de controle fino ou quando algo saiu
> do script. Detalhes, flags e troubleshooting em `reference/run-hades.md`.

#### Fase 0 — medir e propor (máquina nova ou pedido novo)
1. `free -h`, `docker ps`, `docker stats --no-stream`, `ss -ltn`, `gate-lock.sh status` (se houver).
2. `gh pr list --author @me --state open --json number,title,headRefName,baseRefName,isDraft,headRefOid,files`
   — ordem topológica (base de PR antes da PR), drafts fora salvo pedido.
3. Propor ao dono: serviços (os obrigatórios do ambiente, `services.required`, + os tocados pelas PRs + dependências diretas), modo
   (`reference/architecture.md` §Decisões), teto de memória, faixa de portas, matriz de usuários. **Esperar o ok.**

#### Fase 1 — instalar o kit
```bash
HADES_WT=<worktree com a branch hades/local> ~/.claude/skills/hades/kit/install.sh
```
Cria `$D`, `env.sh` (com `HADES_ID`: vazio na primeira instância da máquina), a slice systemd da instância (`hades`; `hades_<id>` nas outras), liga rerere, aplica o `env/` do pacote (`post-install.sh`) e exclui do git o que ele extrair.
O install copia em TypeScript pelo manifesto (sem `rsync`, e nunca por espelho: o `$D` guarda estado) preservando o modo dos `.sh`: grava `$D/kit.manifest` (sha256 de cada arquivo do kit que instalou) e, na reinstalação, remove do `$D` o que saiu do kit e não foi editado à mão (editado: aviso e fica; sem manifesto anterior, só avisa `*.py` e `panel/ui/**` que o kit não tem mais).
O worktree precisa de `node_modules`: ver `ref env-operations` §node_modules (symlinks + `pdfjs-dist` local).
No fim da **primeira** instalação o `install.sh` imprime o resumo do onboarding (o que dá para preparar agora) e aponta `/hades env onboard`, `$D/onboard.sh pick` e a página Onboarding do painel (`reference/onboard.md`).

#### Fase 2 — conjunto de PRs e branch `hades/local`
**Conjunto de PRs** — `$D/prs.list` (uma entrada por linha), gerido por `$D/prs.sh`:

| Entrada | Efeito |
|---|---|
| `4937` | inclui a PR, mesmo draft ou de outro autor |
| `@me` / `author:<login>` | todas as abertas não-draft do autor |
| `-4964` | exclui (vence qualquer inclusão) |

Sem arquivo = `@me`. O dono passou uma lista ("sobe com a 4937, 4959 e 5012") → `$D/prs.sh set 4937 4959 5012`
(só elas) ou `$D/prs.sh add …` (somar às que já estão no conjunto); conferir com `$D/prs.sh show` antes de aplicar. PR mergeada/fechada
sai com aviso; PR empilhada sobre base fora do conjunto entra com aviso (o merge traz os commits da base). O plantão
acompanha os heads desse mesmo conjunto.

`$D/rebuild-branch.sh` (reset para a base do perfil — `branch.base` > `origin/<flow.base>`, `origin/develop` sem perfil — + merge de cada PR do conjunto, stack desalinhada via cherry-pick, rerere,
depois `fixups.sh`). Conflito novo → resolver à mão **pelo conteúdo** (as duas funcionalidades convivem), commitar,
anotar em `conflicts.log` (par, arquivos, resolução) e seguir. Migration conflitante ou contrato sem resolução
equilibrada → tirar a PR mais nova, anotar e avisar. Detalhes: `reference/branch.md`.

#### Fases 3 a 5 — ambiente, infra, serviços e dados
Do ambiente do projeto: geração dos `.env`, infra docker, migrations, build pela fila do gate-lock (`gl_run build …`),
`svc.sh start`, confirmação de `/health/ready` e carga de dados. Roteiro e comandos em `ref env-phases`; o `run-hades`
os encadeia. Nunca deixar `.env` na raiz do worktree (`ref env-operations`). Arquitetura e portas: `reference/architecture.md`.

#### Fase 6 — processos de apoio, painel, túnel (sob demanda)
- Processos de apoio do projeto (os que o ambiente declara além dos serviços): `ref env-phases` §Fase 6.
- `$D/panel.sh start` → http://127.0.0.1:21220 (`reference/panel.md`): painel do dono para monitorar e operar o
  Hades em tempo real (serviços, infra, processos de apoio, branch/PRs, fila do gate-lock, memória) chamando os mesmos
  scripts do kit. O `run-hades` já sobe o painel; ele fica fora do slice e continua no ar com o Hades pausado.
- Onboarding dos recursos desta fase (túnel, notificações, início do painel, contas): `/hades env onboard` ou `$D/onboard.sh show <feature>` (`reference/onboard.md`); o que é público/sudo/token é do dono.
- Túnel: `tunnel.sh install|create`, o **dono** roda `tunnel.sh login-cmd`/`publish-cmds`, depois `tunnel.sh url`
  e reiniciar os serviços cujo `.env` mudou (`reference/tunnel.md`).

#### Fase 7 — STATUS e plantão
O `$D/STATUS.md` vem do script de status do pacote do projeto, se houver. Plantão: `Monitor` com
`bash $D/watch.sh | grep --line-buffered -E "HEADS-CHANGED|CEDE|GATES-CLEAR|rror"` (30 min, rearmar ao expirar).
- `HEADS-CHANGED` → `$D/update.sh` (ciclo completo; para em conflito novo).
- `CEDE` → `$D/hades.sh pause`; `GATES-CLEAR` → `$D/hades.sh resume`.
Rotina e recuperação de falhas: `ref env-operations`.

#### Fase 8 — pedido fora do escopo (a skill evolui)
Seguir `reference/evolving.md`: resolver no vivo → generalizar no kit → documentar (referência + a tabela de `reference/pedidos.md` +
`description` se o gatilho mudou) → reinstalar e provar → `kit/skill-release.sh drift` (zero) →
`kit/skill-release.sh release minor|patch "<resumo>"` → completar o `CHANGELOG.md` → entregar versão, caminho e
sha256 do pacote ao dono; se a melhoria é do núcleo e serve a qualquer usuário, `hades contrib suggest` (guarda,
PR com confirmação ou `.html`; `reference/contrib.md`). Defeito de produto encontrado no caminho vai para `notes.md`, não para a skill.
