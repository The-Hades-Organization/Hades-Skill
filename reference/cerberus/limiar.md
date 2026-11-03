# Cerberus · Limiar: o que entra

O Limiar guarda o que a Hades deixa entrar e executar na máquina do dono: o plugin de um projeto (`post-install.sh`,
`doctor.sh`, `checks/`, `panel/api.ts`, scripts de página, rotas e ações do `plugin.json`). O contrato (veredito,
registro, contexto, modos, exceção) é o de `reference/cerberus.md`; aqui está só o que esta cabeça confere.

Modo padrão `barra` (`HADES_CERBERUS_LIMIAR`, Configurações → Cerberus). Momento: `plugin`, avaliado pelo `hades plugins`
em `add --apply`, `update --apply` e `enable` com o contexto `plugin`, `commit` e `op` (`add`, `update` ou `enable`).

## Por quê

Um plugin é código que roda como o dono. A página Plugins já mostra a prévia e pede o commit; o Limiar torna isso uma
regra que o dono pode ler, calibrar e auditar no histórico, e acrescenta o que a prévia sozinha não garante: que o que
vai executar é mesmo o que foi mostrado e que o plugin não mexe no que protege a Hades.

## Guardas

Todas `exec`, no momento `plugin`, por `hades cerberus-check limiar <guarda>` (`src/lib/cerberus-limiar.ts`). Elas leem o commit pelo
objeto do git (`ls-tree`, `cat-file`), nunca o que está solto na pasta, e reusam do `hades plugins` a lista do que
executa (`RUNS`), a prévia (`plugins-staging/<id>/preview.json`) e o log (`logs/plugins.log`): a regra mora lá, não aqui.

| Guarda | Confere | `barra` quando | `aviso` quando |
|---|---|---|---|
| `plugin-commit-fixado` | o `commit` do contexto é um sha de 40 hex e é o da prévia | ref móvel, sha abreviado ou diferente; no `add`, o clone em prévia não está em `commit` ou tem mudança solta; no `update`, `commit` não é a ponta do remote rastreado, o log não tem `update-preview` dele ou o pacote tem mudança local; no `enable`, o pacote não está em `commit`, mudou depois da última instalação registrada ou tem mudança local | `enable` de pacote sem nenhuma instalação no log (não há com o que conferir) |
| `plugin-executavel-na-previa` | o que executa é o que a prévia mostrou | no `add`, arquivo executável ausente da prévia ou com sha256 diferente, páginas ou rotas diferentes do `preview.json`; no `update`, executável **novo** fora do diff que a prévia mostra (um script do `env/` que não é `post-install.sh`, `doctor.sh`, `checks/*.sh`, `panel/api.ts` nem `panel/ui/*.js`) | `update` altera script existente fora desse diff (só o nome aparece no resumo) |
| `plugin-invariante-do-nucleo` | o plugin não toca o núcleo | arquivo do `env/` que cai por cima de `kit/<mesmo caminho>` (o `install.sh` faz rsync do `env/` sobre o `$D`); arquivo do pacote em `loop/` que já existe no núcleo (o hook `hades guard`); caminho com `cerberus` no nome (guarda, bloco ou registro de cabeça); `config.tsv` declarando `HADES_CERBERUS_*`; página `cerberus` no `plugin.json`; script executável que cita `hades-guard`, `hades-cerberus`, `loop/cerberus`, `api/cerberus`, `HADES_CERBERUS_*`, escreve na pasta da skill ou mexe em `settings.json` onde se fala de hook | script mexe em `settings.json` sem falar de hook |
| `plugin-ensaio-isolado` | o código executável do plugin, ensaiado num sandbox | script que escreve fora do `$D`, usa rede sem declarar ou falha no ensaio | sem `bwrap` utilizável (nada é ensaiado) |

Evidência: cada achado leva `conferido` (o que, com arquivo e linha quando for o caso) e `onde` (comando git, arquivo).
No `update`, a guarda executável lista o resumo (`git diff --stat`) e, por arquivo, o que é novo, alterado ou removido.
Quando tudo passa, a evidência diz o que foi varrido (quantos arquivos e executáveis).

**Falha ao conferir** (pacote ausente, commit sem objeto, git que não roda, contexto sem `plugin`, `commit` ou `op`,
`hades plugins` que não carrega) é `barra` com a evidência do que faltou, nunca `ok` silencioso.

## plugin-ensaio-isolado

Antes de ativar o plugin, a guarda **ensaia** o que ele executa na instalação: o `post-install.sh`, o `doctor.sh` e os
`checks/*.sh` do `env/` do commit (o que existir; sem nenhum, a guarda passa dizendo "nada a ensaiar"). Vale para `add`,
`update` e `enable`, sobre o commit do contexto. Implementação: `src/lib/cerberus-ensaio.ts`.

**O sandbox** (bubblewrap, um por script, com tempo máximo de 20 s e orçamento de 240 s para o conjunto):
- raiz do sistema `--ro-bind / /`; `HOME` em tmpfs somente leitura; `--unshare-pid`, `--die-with-parent`;
- uma **cópia descartável** do `$D` (sem `logs/`, `plugins-staging/` e `_maquina/`), gravável, montada no caminho do `$D`: o
  `$D` real nunca é tocado. O `env/` do commit é extraído dentro dela e o `TMPDIR` aponta para ela (`mktemp` funciona);
- **sockets Unix do host fora de alcance:** `connect()` num socket não é barrado por montagem somente leitura nem por
  `--unshare-net`, então `/run` (docker.sock, systemd, dbus), `/tmp`, `/var/tmp` e o `XDG_RUNTIME_DIR` (barramento da
  sessão) viram tmpfs vazios e somente leitura; os sockets que sobram em `/etc`, `/var`, `/opt`, `/srv`, `/mnt`, `/media`
  e no worktree e na skill são cobertos um a um com `/dev/null`; os do `HOME` (herdr, zed...) somem com o tmpfs do `HOME`.
  Com rede declarada só volta o `resolv.conf` (se for link para `/run`). Limite conhecido: socket abstrato (`@nome`) só
  some com `--unshare-net`, então um item com rede declarada o alcança;
- `--unshare-net` (sem rede, nem loopback), salvo declaração (abaixo);
- ambiente mínimo (`PATH`, `HOME`, `LANG`, `TMPDIR`, `HADES_DATA`, `HADES_WT`, `HADES_SKILL_DIR`): nenhum segredo do
  dono chega ao script. O worktree e a skill entram somente leitura, para o script poder lê-los;
- o `doctor.sh` roda com `ok`/`warn`/`err`/`have` neutros (só o que ele *faz* importa, não o que diagnostica).

**O que barra**, com o motivo na evidência de cada script (lista: ensaiado / barrado (motivo) / não ensaiado (motivo)):
- escrita fora do `$D` (qualquer caminho, inclusive `$HOME`, `/tmp` e o worktree): o sandbox a impede e o ensaio a detecta
  pelo "Read-only file system" na saída de erro, reportando o caminho;
- rede sem declaração (resolução de nome, "network is unreachable", conexão recusada na saída de erro);
- script que falha no ensaio (saída diferente de 0 ou estouro do tempo), com o final da saída de erro.

**Rede declarada.** O `plugin.json` ganha o campo opcional `ensaio.rede[]` (`reference/projects.md` §Plugin do Hades), `{item, motivo}`:
`item` é o caminho relativo ao `env/` (`post-install.sh`, `checks/x.sh`) e `motivo` diz por que precisa de rede. Só o item
declarado roda sem `--unshare-net`; a evidência dele traz "rede liberada por declaração: <motivo>" e vai ao histórico do
Cerberus. Item ou motivo ausente = declaração ignorada = rede barrada.

**Escrita declarada.** Escrever no worktree (`$HADES_WT`) fora do `$D` barra, como qualquer escrita fora do `$D`. O `plugin.json`
ganha o campo opcional `ensaio.escrita[]` (`reference/projects.md` §Plugin do Hades), `{item, caminho, motivo}`: `item` é o caminho
relativo ao `env/`, `caminho` é uma pasta do worktree (relativa a ele, sem `..`, que exista) e `motivo` diz por que o script
a grava. Só aquele item ganha a pasta, e **sobre uma cópia descartável** montada gravável no lugar dela: o worktree real
nunca é tocado. Declare a pasta mais estreita possível (a cópia tem o tamanho dela; `tools/vendor/bin`, `.git/info`,
não o worktree inteiro). A evidência traz "escrita liberada por declaração (cópia descartável): <caminho> (<motivo>)" e vai
ao histórico do Cerberus, como a rede. Declaração sem item, caminho ou motivo, ou com caminho que escapa do worktree
(inclusive por link), é ignorada: a escrita barra. Limite: o script que grava por caminho relativo ao cwd cai no `$D`
copiado e passa sem declaração; a declaração vale para o caminho absoluto sob `$HADES_WT`.

**Docker fica fora.** O `docker.sock` nunca é montado. Script que chama `docker` (ou `docker-compose`) como comando fica
"não ensaiado (docker)" por inteiro e não barra por si; `command -v docker` e afins não contam como chamada. O que mais esse
script faz não é ensaiado: é um limite conhecido.

**Sem bubblewrap = `aviso`**, nunca barra: a evidência diz que nada foi ensaiado e como instalar o pacote `bubblewrap`
(ele consta no registro de dependências, `hades deps`, como opcional). O mesmo vale se o `bwrap` existe mas não sobe (kernel
sem user namespaces).

**Abrir exceção.** Como as demais guardas: exceção de uso único do dono, com motivo, casando `limiar`, `plugin-ensaio-isolado`
e `{"plugin": "<nome>"}` (`reference/cerberus.md` §Exceção). Antes de abrir, veja qual script e qual motivo na evidência;
para rede, o caminho certo é declarar em `ensaio.rede`, não a exceção.

## Calibrar

- `HADES_CERBERUS_LIMIAR=avisa` enquanto se confia no que um plugin conhecido faz: o `barra` vira aviso e o histórico
  guarda os dois. `off` desliga a cabeça.
- Um plugin legítimo que precisa de uma das coisas barradas (ex. um `post-install.sh` que edita o `settings.json` do
  próprio projeto) tem a exceção de uso único do dono, com motivo (`reference/cerberus.md` §Exceção), casando
  `limiar`, a guarda e `{"plugin": "<nome>"}`.
- A varredura de texto é de padrões fixos em `src/lib/cerberus-limiar.ts` (`TAMPER`, `SETTINGS`, `SKILL_WRITE`): trocar um padrão
  é mudança de código, com caso novo em `loop/test/ts/cerberus-limiar.test.ts`.

## Limites conhecidos

- O ensaio é uma execução só, no estado de um `$D` copiado: um script que só escreve fora do `$D` num ramo que o ensaio não
  percorre (outra data, outro argumento) não é pego. É uma rede a mais sobre a prévia e o diff, não a substitui.
- A varredura é estática: pega o que o script diz, não o que monta em tempo de execução (`eval`, nome de arquivo
  concatenado). O que barra de fato é a prévia com o commit conferido e o dono lendo o diff.
- Os scripts de página e o `api.ts` passam pelos mesmos padrões de texto que os `.sh`; não há análise de sintaxe.
- O contexto não traz o caminho do clone em prévia: a guarda o acha em `plugins-staging/` pelo nome e pelo commit. Se o
  corpo passar `pack_dir`, ele vale.
