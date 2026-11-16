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
`failed`) e `tools` (ferramentas das stacks do worker no PATH do ssh; §Toolchain). O painel lê esse comando a cada 15 s enquanto a página está aberta, com limite de 4 s por worker, e mostra na página Fila
de gates:

| O que aparece | Significa |
|---|---|
| Worker **inacessível**, com a última leitura em cache | o ssh falhou ou estourou o limite; a fila local segue normal |
| `remote:<host>` no item | o gate roda no worker; o item não entra na soma de memória local |
| `remoto perdido (75)` no histórico | o worker sumiu no meio do gate; o gate terminou com saída 75 |

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

## Problemas comuns

- `Permission denied (publickey)`: a chave não está no `authorized_keys` do usuário certo, ou o `IdentityFile` do `~/.ssh/config`
  não aponta para ela.
- `worker sem ferramenta no PATH do ssh não interativo` ou `npm: command not found`: veja §Toolchain.
- Resposta fora do contrato: a Hades do worker está desatualizada. Atualize a skill no worker.
- Fila local parada e worker ocioso: `HADES_GATE_WHERE` está em `local`. Use `auto` ou passe `--where <host>` no gate.
