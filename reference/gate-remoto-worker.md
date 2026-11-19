# Worker de gates remoto: preparação

Um worker é outra máquina do dono que executa gates da fila (`reference/loop/gates.md`) quando a local está cheia ou quando
`--where` aponta para ela. Este guia prepara a máquina. O motor (`gate-lock run --where`, `hades worker`) e as chaves
`HADES_GATE_WHERE`, `HADES_GATE_WORKERS` e `HADES_GATE_AUTO_AFTER_S` ficam em `reference/config.md`. O painel mostra o resultado
na página **Fila de gates** (`reference/panel.md` §Fila de gates).

## Requisitos

- **Máquina do dono, não compartilhada.** O worker roda o código de todos os clones do dono com as credenciais do usuário dele.
  Máquina com outros usuários, servidor de equipe ou runner compartilhado não serve.
- **Rede privada.** Alcance o worker por Tailscale, WireGuard ou LAN. A porta do ssh nunca é aberta na internet e o tráfego do
  worker nunca passa pelo túnel do painel (`reference/panel.md` §Acesso remoto), que é público por natureza.
- **Mesmo usuário e mesma árvore em `$HOME`.** O worker usa o mesmo nome de usuário e os mesmos caminhos (`~/.claude/hades/work`,
  o clone do projeto) da máquina de origem, porque o ticket carrega o caminho do clone.
- **Espelho git.** O worker mantém um clone do projeto atualizado (`git fetch`) e recebe o commit do gate pelo espelho, não por
  cópia de arquivos.
- **Sem credencial do `gh`.** Não rode `gh auth login` no worker nem copie `~/.config/gh`. O gate remoto testa e compila; abrir PR,
  comentar e publicar continuam na máquina de origem.
- **Hades instalada.** `hades worker status --json` precisa responder no worker (veja §Conferir).

## Chave ssh restrita

Crie uma chave só para o worker na máquina de origem (`ssh-keygen -t ed25519 -f ~/.ssh/hades-worker -N ''`) e grave a pública no
`~/.ssh/authorized_keys` do worker, numa linha só, com o comando forçado:

```
command="hades worker exec",no-agent-forwarding,no-port-forwarding,no-pty ssh-ed25519 AAAA… hades-worker
```

- `command="hades worker exec"` faz o ssh ignorar o que o cliente pediu e entregar o pedido a `hades worker exec`, que aceita só
  os subcomandos do worker (o pedido original chega em `SSH_ORIGINAL_COMMAND`). A chave não abre shell.
- `no-agent-forwarding`, `no-port-forwarding` e `no-pty` fecham o encaminhamento do agente, de portas e o terminal.
- Quando o IP da origem é estável, restrinja também com `from="<ip privado da origem>"` na frente das opções.
- Aponte o cliente para a chave com um bloco no `~/.ssh/config` da origem (`Host`, `IdentityFile`, `IdentitiesOnly yes`).

## Configuração

Na máquina de origem, em Configurações do painel ou `config.sh set`:

| Chave | Valor | Efeito |
|---|---|---|
| `HADES_GATE_WORKERS` | `host[:rótulo,…]`, separados por espaço, por exemplo `big:docker` | lista os workers e os rótulos que cada um declara |
| `HADES_GATE_WHERE` | `local` (padrão), `auto` ou um host da lista | onde o gate roda por padrão |
| `HADES_GATE_AUTO_AFTER_S` | segundos | no modo `auto`, quanto esperar sem admissão local antes de transbordar |

O rótulo `docker` é opcional: declare-o só se o worker tem Docker. A etapa de integração exige o rótulo `docker` no worker.

## Conferir

Da máquina de origem, na forma que o painel usa:

```
ssh -o BatchMode=yes -- <host> status --json
```

A saída é um JSON com `host`, `labels`, `memFreeGb`, `memTotalGb`, `cpus`, `queue`, `warm` (por chave: `ready`, `warming` ou
`failed`) e `tools` (ferramentas das stacks do worker no PATH do ssh; §Toolchain). Campos aditivos de disco: `diskFreeGb`,
`diskTotalGb` e `inodesFree`, do sistema de arquivos de `$HADES_WORKER_FS_ROOT` (sem a variável, de `~/.cache/hades-worker`);
worker antigo não os manda e o cliente não o recusa por isso. Campos aditivos de recursos (só declaram; o despacho não decide por eles):
`os` (`name` = `PRETTY_NAME` de `/etc/os-release`, ou `os.type() os.release()`; `kernel`; `arch`), `diskUsedGb` e `diskUsedPct`
(do mesmo `statfs` do disco livre), `cpuModel`, `load1`/`load5`/`load15`, `cpuUsedPct` (amostra de `/proc/stat` em ~200 ms),
`memUsedGb`/`memUsedPct` (total menos `MemAvailable`) e `swapTotalGb`/`swapFreeGb`. Sem `/proc` (macOS), os campos de CPU
e swap somem; o status nunca falha por isso, e o cliente e o painel mostram "—" onde o campo falta.

```json
{"host":"w1","os":{"name":"Ubuntu 24.04.1 LTS","kernel":"6.8.0-48-generic","arch":"x64"},"diskFreeGb":30.8,"diskTotalGb":88.4,
 "diskUsedGb":57.6,"diskUsedPct":65,"cpuModel":"AMD Ryzen 7 7435HS","cpus":16,"load1":0.18,"load5":0.52,"load15":0.86,
 "cpuUsedPct":1,"memFreeGb":12.6,"memTotalGb":15.3,"memUsedGb":2.8,"memUsedPct":18,"swapTotalGb":15.3,"swapFreeGb":15.3,
 "queue":0,"warm":{},"labels":[],"tools":{}}
```

`warm` só lista como `ready` a chave cujo ambiente ainda existe
(worktree e a prova da instalação, `remote.installed` da stack); `queue` conta só ticket de processo vivo. O painel lê esse comando a cada 15 s enquanto a página está aberta, com limite de 4 s por worker, e mostra na página Fila
de gates:

| O que aparece | Significa |
|---|---|
| Worker **inacessível**, com a última leitura em cache | o ssh falhou ou estourou o limite; a fila local segue normal |
| `remote:<host>` no item | o gate roda no worker; o item não entra na soma de memória local |
| `remoto perdido (75)` no histórico | o worker sumiu no meio do gate; o gate terminou com saída 75 |
| SO, CPU (% e carga), RAM usada/total e swap do worker | recursos declarados; "—" quando o worker é antigo e não os manda |
| Disco usado do worker, ao lado do disco livre | `diskUsedGb` (%) do mesmo sistema de arquivos |
| Disco livre do worker, em vermelho abaixo de `remote.minDiskGb` | o gate recusa com 75 (`worker sem disco`) até liberar espaço; o `doctor` avisa na linha `workers-disco` |

## Toolchain

O `command=` forçado roda sem shell de login: o ssh não lê `.bashrc` nem `.profile`, então o `nvm` não entra e `node` e `npm`
ficam fora do PATH, mesmo que o terminal do dono os ache. Sem tratamento, o job só falha no preparo (`npm: command not found`),
depois de o código ter sido enviado e minutos perdidos.

**O que o worker carrega sozinho.** Antes de responder ao status, preparar o ambiente ou rodar o job, o `hades worker exec` monta o
PATH sem shell de login e põe na frente, só o que existe na máquina:

1. `HADES_WORKER_PATH_PREPEND` (diretórios absolutos separados por `:`, para o caso exótico);
2. nvm (`$NVM_DIR` ou `~/.nvm`): a versão do `.nvmrc` do repositório (`22`, `22.22`, `v22.22.1`; a maior que casa), senão o alias
   `default`, senão a maior instalada; fnm (`$FNM_DIR` ou `~/.local/share/fnm`) pelo mesmo `.nvmrc`;
3. volta (`~/.volta/bin`), asdf (`~/.asdf/shims`), mise (`~/.local/share/mise/shims`);
4. `~/.cargo/bin`, `~/.bun/bin` e `~/.local/bin`.

**O que a stack exige.** `remote.requires` na stack (ex.: `node-nx` pede `node` e `npm`; `rust-cargo` pede `cargo`; `reference/stacks.md`).
O worker procura cada uma no PATH montado e devolve em `tools` do `status --json` (`{"node": "v22.22.1", "npm": "10.9.2"}`; `null` =
ausente). O gate recusa **antes de enviar o código**, com saída 75 e `worker sem ferramenta no PATH do ssh não interativo: falta npm`;
no despacho `auto` o worker sem a ferramenta nem é candidato. Worker antigo, sem `tools`, não é recusado (o cliente não sabe).

**Conferir.**

```
ssh -o BatchMode=yes -- <host> status --json
```

O campo `tools` mostra o que o ssh não interativo acha. O painel mostra o mesmo no cartão do worker (ferramenta ausente em vermelho).

**Se ainda faltar.** O Node mora fora dos lugares acima (instalação em `/opt`, por exemplo): ponha o diretório do `bin` no
`command=` da chave, que é onde o ambiente do worker se configura:

```
command="HADES_WORKER_PATH_PREPEND=/opt/node-22/bin hades worker exec",no-agent-forwarding,no-port-forwarding,no-pty ssh-ed25519 AAAA…
```

## Build remoto do front

`gate-lock run build --where <host> --out dist/apps/web --fresh index.html --post-local "<restart>" -- <cmd>` constrói no
worker e traz o diretório de volta. O worker gera o manifesto (lista e sha256); o local confere, promove por `rename` e só
então remove o diretório anterior. Manifesto adulterado, `--fresh` velho, transporte morto ou oom (`143`) deixam o
diretório anterior intacto. `--post-local` roda só depois da promoção. `HADES_GATE_RESULT_FILE` traz `sha=` para o
marcador de "construído". O retorno é tar completo na v1.

## Limpeza (gc)

Cada worktree de worker guarda ~4 GB de `node_modules`. `hades worker gc <host> [--dry-run] [--free-gb N] [--keep-warm]` remove as
ociosas pelo ssh (comando forçado da chave); `--dry-run` só lista. Rode sem argumento extra para aplicar as duas regras abaixo.

- Remove: a worktree sem uso há mais de `HADES_WORKER_GC_IDLE_DAYS` (3), e, com o disco livre abaixo de `HADES_WORKER_GC_MIN_FREE_GB`
  (20), as mais antigas até liberar a diferença. `--free-gb N` libera N GB removidos (soma dos tamanhos), não "livre ≥ N".
  O warm da worktree removida também sai.
- Nunca remove: a worktree com job vivo (lock `<id>.lock`, marcador `<id>.job` ou ticket cujo dono tem o cwd dentro dela) nem a do
  job que acabou de rodar. `--keep-warm` poupa também a com warm `ready`/`warming`; ela aparece em `kept` com o motivo.
- Automático: ao fim de cada job (inclusive recusas) o worker aplica as mesmas regras; só compacta o espelho e limpa results quando
  algo saiu ou o disco está curto. Último uso = o maior entre o mtime de `<id>.used` e o da pasta. `0` numa das chaves desliga a regra.
- O cache do npm do `node-nx` fica em `{cache}/npm` (`NPM_CONFIG_CACHE`): poupa só o download, não os ~4 GB por worktree.

## Problemas comuns

- `Permission denied (publickey)`: a chave não está no `authorized_keys` do usuário certo, ou o `IdentityFile` do `~/.ssh/config`
  não aponta para ela.
- `worker sem ferramenta no PATH do ssh não interativo` ou `npm: command not found`: veja §Toolchain.
- Worker sem disco ou cheio: `hades worker gc <host> --dry-run` mostra o que sairia; sem a flag, remove (§Limpeza).
- `worker sem disco: <livre> GB < <mínimo> GB` (rc 75, antes do envio): o livre do worker está abaixo de `remote.minDiskGb` da stack
  (8 GB no `node-nx`). Apague worktrees e `node_modules` antigos no worker (`git worktree remove` no espelho, depois `git worktree prune`).
  Com o disco cheio demais para o status responder, o push falha com o mesmo motivo `worker sem disco`, trazendo as linhas
  `remote:`/`error:`/`! [remote rejected]` do git (`unpacker error`, `No space left`). Marcação `warm` de ambiente apagado à mão não
  engana mais: o worker confere o worktree e a instalação antes de pular o preparo e, faltando, apaga a marcação e prepara de novo.
- Resposta fora do contrato: a Hades do worker está desatualizada. Atualize a skill no worker.
- Fila local parada e worker ocioso: `HADES_GATE_WHERE` está em `local`. Use `auto` ou passe `--where <host>` no gate.
