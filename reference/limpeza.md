# Limpeza de disco e rotação de logs (`clean.sh`, `hades logrotate`)

As units dos serviços escrevem em `$D/logs/<ms>.log` (`<ms>` = o nome do serviço, `services.tsv`) por `StandardOutput=append:` (`svc.sh`) e o arquivo só cresce
(os de serviços de eventos lideram; um ambiente antigo chegou a 312 MB de logs; o ambiente do projeto sugere o grupo de
prioridade em `config.defaults`). Nomes de unit, slice, projeto compose e túnel: os da instância original (`reference/projects.md` §Várias instâncias). A política fica em
**Configurações → Limpeza** (`HADES_CLEAN_*`, `reference/config.md`).

## Rotação: copiar + truncar

A unit mantém o arquivo aberto em `O_APPEND`: **não se renomeia**. `hades logrotate` copia para `<nome>.1.gz`, reconfere o
tamanho (copia o que chegou no meio) e faz `ftruncate` no mesmo fd; o escritor continua no mesmo inode e a próxima
escrita cai no início. As gerações descem (`.1.gz` → `.2.gz` …) até `HADES_CLEAN_LOG_KEEP`.

- Teto por arquivo `HADES_CLEAN_LOG_MAX`; menor para o grupo de prioridade (`HADES_CLEAN_PRIO_LOGS`,
  `HADES_CLEAN_PRIO_LOG_MAX`). Vale para todo `logs/*.log` (serviços, `panel.log`, processos de apoio).
- Teto total `HADES_CLEAN_LOG_TOTAL` (vivos + gerações): apaga as gerações mais antigas e, se preciso, rotaciona o maior.
- **Arquivo aberto sem `O_APPEND`** (um `> arquivo` de shell) é pulado e listado: truncar deixaria um buraco de bytes
  nulos na próxima escrita.
- Medido: escritor em `O_APPEND` a ~270 mil linhas em 6 s, 15 rotações no meio, zero linha perdida, zero byte nulo.
  A janela de perda é o intervalo entre a última conferência de tamanho e o `ftruncate` (microssegundos).
- `logs/panel-jobs/`: por quantidade (`HADES_CLEAN_JOBS_KEEP`) e idade (`HADES_CLEAN_JOBS_DAYS`); execução em andamento fica.
  `logs/panel-cache/`: arquivos mais velhos que `HADES_CLEAN_CACHE_DAYS`.

## `clean.sh`

| Comando | Faz |
|---|---|
| `status [--tsv]` | uso e o que dá para liberar, por categoria (logs, panel-jobs, panel-cache, images, releases, worktrees, dist) |
| `list <cat>` | o que a categoria tiraria (item, bytes, nota) |
| `run [--dry-run] [--quiet] [--yes <cat>]…` | limpa o **seguro** (logs, panel-jobs, panel-cache); o resto só lista até receber `--yes` |
| `yes <cat>` | só uma categoria de apagar artefato (o botão do painel) |
| `rotate [--dry-run]` | só a rotação dos logs |
| `apply` | grava/ajusta a unit e o timer `hds-logrotate` |

Categorias que **apagam artefato** (sempre `--yes`, nunca sozinhas, nunca no timer):
- `images`: imagens do projeto docker `hades` (rótulo compose ou do `compose.yml`) que nenhum container, nem parado, usa;
  `docker rmi` sem `-f`. Nunca `docker system prune`, nada de fora do projeto.
- `releases`: `hades-skill-v*.tar.gz` além dos `HADES_CLEAN_RELEASES_KEEP` mais novos (`sort -V`). Só com pedido do
  dono (`evolving.md`).
- `worktrees`: worktrees do registro de agentes (`orchestration/agents/*.json`) cuja PR está CLOSED/MERGED
  (`gh pr view`, estado terminal em cache). Remove com `git worktree remove` sem `--force`: com alterações locais fica. A branch fica.

`dist/` do worktree só aparece no status: apagar derruba os serviços até o próximo build.
Categoria nova (ex.: snapshots de banco): funções `size_<cat>` (`uso liberável itens detalhe`), `list_<cat>`,
`clean_<cat>` e uma entrada em `SAFE`/`CONFIRM`/`INFO`; o painel e o status leem a lista do script.

## Timer

`clean.sh apply` grava `~/.config/systemd/user/hds-logrotate.{service,timer}` (oneshot `clean.sh run --quiet`,
`Nice=10`, fora do slice, `Persistent=true`, `OnUnitActiveSec=$HADES_CLEAN_EVERY`) e liga/desliga o timer por
`HADES_CLEAN_TIMER`. O `install.sh` o aplica (fora de `SKIP_SYSTEMD`); mudar o intervalo nas Configurações pede
**Aplicar o timer de limpeza**. Log do timer: `logs/logrotate.log`. `CLEAN_UNIT` troca o nome (testes: `skilldev-<unidade>-…`).

**macOS (launchd):** `apply` grava `~/Library/LaunchAgents/com.hades.hds.logrotate.plist` (diretório privado quando
`HADES_CLEAN_TIMER=off`) com `StartInterval` em segundos, `Nice` e `LowPriorityIO`. `HADES_CLEAN_EVERY` aceita
`6h`, `1d`, `30min`, `1h 30min`, `90s`, `2w`; zero, sem unidade ou acima de 2^31-1 s sai com código 2. Sem `RunAtLoad`
nem `Persistent`: a primeira execução espera o intervalo e execuções perdidas com o Mac dormindo não se acumulam.
O launchd não guarda a última execução: o `clean.sh run` grava `logs/logrotate.last` (UTC, ISO 8601) e o `status` a lê.

## Painel

Visão geral → card **Disco**: uso por categoria, quanto libera, **Rotacionar agora**, **Limpar (seguro)** e
**Apagar…** nas categorias que apagam artefato. Cada botão busca a prévia (`GET /api/disk/preview`, o `clean.sh` em
simulação) e a mostra na confirmação antes de rodar. `GET /api/disk` (cache de 60 s; `?refresh=1`). Apagar
imagens/pacotes/worktrees não se faz pelo acesso remoto.
