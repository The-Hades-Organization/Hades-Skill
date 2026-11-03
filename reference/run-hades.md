# `run-hades` — subir o Hades inteiro com um comando

Ponto de entrada único, **idempotente** e **à prova de reboot**, pensado para o **dono** rodar direto no terminal (sem
agente): depois de um reboot, ou para trocar o conjunto de PRs/branches. Orquestra todas as fases do `SKILL.md`
(Fase 1→7) chamando os scripts do kit, e embute as recuperações que um agente levaria tempo para redescobrir.

Mora no ambiente do pacote do projeto (`<pacote>/env/run-hades.sh`; o `install.sh` o copia para `$D/run-hades.sh`, que é o que o alias chama). O alias e as variáveis por-máquina ficam no
`~/.bashrc` do dono (nunca na skill):

```bash
export HADES_GH_USER=<sua-conta-gh-de-trabalho>     # opcional (ver "Credencial do git")
alias run-hades='<worktree>-data/run-hades.sh'
```

## Uso

```bash
run-hades                 # reusa o conjunto de PRs atual (prs.list); se não houver, só a base
run-hades develop         # só a base, sem PRs
run-hades 4937 4959       # base + PRs 4937 e 4959
run-hades @me             # base + minhas PRs abertas (não-draft)
run-hades @me -4964       # idem, excluindo a 4964
run-hades author:fulano   # base + PRs abertas de <fulano>
```

O conjunto de PRs é o mesmo do `prs.sh`/`hades pr-set` (número, `@me`, `author:<login>`, `-<n>` exclui). A palavra
`develop` sozinha (o argumento é literal; a base vem do perfil) = só a base, sem PRs. Sem argumento de PR, **reusa** o `prs.list` atual (um reboot repete o último
conjunto); trocar é só passar PRs/`develop` de novo.

### Flags

| Flag | Efeito |
|---|---|
| `--no-tunnel` | não cria/levanta o túnel público (front fica só local) |
| `--no-<passo>` / `--<passo>` | desliga ou liga um passo opcional nesta execução, sobrepondo as Configurações (`HADES_RUN_*`); os passos do ambiente do projeto estão em `ref env-run-hades` §Flags do ambiente |
| `--rebuild` | força rebuild de todos os serviços e do front, mesmo sem mudança de código |
| `--status` | só imprime o STATUS atual e sai (não mexe em nada) |
| `-h`/`--help` | ajuda |

### Configurações

Os passos opcionais por padrão, conta do gh (`HADES_GH_USER`), teto de memória do slice, heap dos serviços e
custos na fila ficam nas **Configurações** (painel, ou `$D/config.sh set K=V`): ver `reference/config.md`. Uma
variável exportada no shell vence a configuração naquela execução (`HADES_SLICE_MAX=5G run-hades`).

## O que cada passo faz

O roteiro é do ambiente do projeto (`<pacote>/env/run-hades.sh`). O texto dos passos, o firewall e as recuperações
específicas moram no pacote: `ref env-run-hades`. A ordem, em geral:

0. **Pré-requisitos** — começa com `doctor.sh --quick` (`reference/doctor.md`): erro nele para o `run-hades` com o comando que corrige; aviso só segue. Depois aborta cedo se faltar acesso ao Docker (orienta `usermod -aG docker` + relogin) ou o runtime.
1. **Credencial do git** — abastece o *credential cache* do git do projeto com o token de `HADES_GH_USER` (ou da
   conta ativa), sem trocar a conta ativa do gh. Deixa o `git fetch`/`rebuild-branch` funcionar mesmo com o gh logado
   noutra conta pessoal.
2. **Dependências do worktree** — instala o que faltar; idempotente: pula se já estiver pronto.
3. **Conjunto de PRs + branch** — aplica o conjunto (ou reusa) e roda `rebuild-branch.sh` (`reference/branch.md`).
   Conflito novo → avisa e segue com o que está na árvore.
4. **Ambiente, infra, serviços e front** — gera os `.env`, aplica o teto do slice das Configurações
   (`config.sh apply-slice`), sobe a infra docker, rebuilda só o que mudou de fato (diff de conteúdo, não de SHA: os
   commits de fixups/overlay trocam de SHA sem mudar conteúdo) e espera todos os serviços prontos.
5. **Dados e processos de apoio** — carga de dados e o que mais o ambiente do projeto tiver, quando ligado.
6. **Túnel público** — instala o `devtunnel`, loga (device-code, 1ª vez), cria o túnel + acesso anônimo + host, lê a
   URL e reinicia os serviços cujo `.env` mudou. Pulado se o firewall bloquear, com `HADES_RUN_TUNNEL=0` ou com `--no-tunnel`. O acesso é **anônimo**: qualquer pessoa com a URL abre o front até o prazo vencer. O Cerberus (guarda `tunel-acesso`) avalia a publicação e barra com `HADES_CERBERUS_PORTA_TUNEL_HOSTS` vazia, mesmo com `HADES_RUN_TUNNEL=1` (o padrão): a convivência está em `reference/tunnel.md` §Passos.
7. **STATUS** — o `STATUS.md` (o script de status do pacote do projeto, se houver) e um resumo final com as URLs e os avisos.

Se o firewall do host barra o tráfego do container para o host, o `run-hades` detecta o bloqueio sem sudo e **só então**
aplica a regra, pedindo a senha do sudo uma vez (`ref env-run-hades` §Firewall). Pré-requisito único e que persiste no
reboot: o grupo `docker` (`sudo usermod -aG docker $USER` + relogin; o script checa e orienta se faltar).

## Início automático (só o painel)

Com a máquina ou o login, só o **painel** sobe sozinho (`HADES_PANEL_AUTOSTART`, `reference/panel.md` §Início
automático). Infra, serviços, front e dados nunca sobem sozinhos: sobem pelo painel (botão subir) ou pelo `run-hades`.

- **Migração:** a subida completa automática (`HADES_BOOT`, unit `hds-boot`) saiu. A reinstalação do kit
  (`kit/install.sh`) desabilita e remove o `hds-boot.timer`/`hds-boot.service` que encontrar e diz isso no resumo;
  o `linger.sh sync` desliga o linger que só existia por causa dela. `HADES_BOOT*` num `config.env` antigo ou num
  arquivo importado é ignorado (aviso no import); `boot.json` e `logs/boot.log` antigos ficam.
- **Sobrou o timer?** O doctor avisa (grupo Subida, `boot`) com o comando: `systemctl --user disable --now hds-boot.timer`.
- **Depois de um reboot:** abra o painel (ele sobe sozinho com o autostart) e suba pelo botão, ou rode o `run-hades`.
- **Teste:** `HADES_BOOT_UNIT=skilldev-boot-x` troca o nome da unit que o `install.sh` e o doctor procuram.

## Problemas comuns

| Sintoma | Causa provável | Ação |
|---|---|---|
| `✗ sem acesso ao Docker` | sessão anterior ao `usermod` | relogin/reboot, ou `newgrp docker` e rodar de novo |
| firewall não libera (sudo sem TTY) | rodou fora de um terminal interativo | rode `run-hades` num terminal real (o sudo precisa pedir a senha) |
| `rebuild-branch com conflito` | conflito novo entre PRs | resolver à mão pelo conteúdo (`reference/branch.md`), anotar em `conflicts.log` |
| falhas do ambiente do projeto (firewall, consumer parado, disparo) | específicas do ambiente | `ref env-run-hades` §Falhas do ambiente |
| túnel: "não consegui criar" | `devtunnel` não logado | `devtunnel user login -g -d` e rodar de novo (ou `--no-tunnel`) |

## Relação com os outros scripts

`run-hades` é a subida **completa** do zero/reboot. Para o ciclo de atualização quando só mudou o conjunto de PRs
com o ambiente já no ar, o `update.sh` é mais barato (só recompila/reinicia os afetados). A regra de ceder
(`hades.sh pause|resume`) e o plantão (`watch.sh`) seguem como antes.
