# Caronte — levar uma orquestração para outra sessão ou máquina

O Caronte empacota o estado de uma orquestração num arquivo **cifrado com senha**, para retomá-la em outra sessão do
Claude ou em outra máquina: `hades caronte pack` empacota, `hades caronte unpack` abre e refaz, `hades caronte brief` e
`hades agent park` completam o fluxo. O `unpack` só **lê** o formato abaixo. Código: `src/lib/caronte.ts` (formato,
cifra, guarda, git), `src/lib/caronte-unpack.ts` (destinos, validação, aplicação com desfazer) e
`src/commands/caronte.ts` (CLI).

## Fluxo

1. `hades agent park <agente>` em cada agente do plano e espere o `PARKED` do `hades watch`.
2. `hades caronte pack <plano>` (a senha vem do prompt do tty, duas vezes, sem eco).
3. Na mesma máquina, outra sessão: `hades caronte brief <plano>` imprime o prompt de retomada do orquestrador.
4. Em outra máquina: clone o projeto, `hades caronte unpack <arq>` (a senha vem do prompt do tty, uma vez) e rode, por agente, os
   comandos de retomada que ele imprime.

**A senha não é guardada em lugar nenhum: senha esquecida perde o pacote.** Nunca vai em argumento, log nem diário. O jeito recomendado é o prompt interativo pelo tty; a variável
`HADES_CARONTE_PASSWORD` é só para automação (§Configurações).
`<plano>` é o caminho do `.md` ou o nome em `~/.claude/hades/plans/`.

**Pelo painel:** a página Caronte (`reference/panel.md` §Caronte) mostra os planos e a prontidão para o pack, a prévia do
`--dry-run`, os pacotes e o prompt de retomada, e tem o botão **Estacionar** por agente. Pack e unpack só no terminal: a
senha nunca passa pelo navegador.

## `hades agent park <nome> ["<motivo>"]`

Manda ao agente, pelo mesmo caminho do `prompt`, a instrução de commitar o pronto, gravar o `handoff.md` começando com
`STATUS: PARKED — …` e encerrar o turno. Espera o turno acabar (10 min) e só então grava `state: "parked"` e `parkedAt`
no registro, se o handoff chegou fresco; senão avisa e sai 1 (rode de novo). Não mata a sessão, não fecha o painel e não
mexe em `promptedAt` (o `watch` continua emitindo `PARKED`). Agente já estacionado ou encerrado (`done`/`archived`):
mensagem e saída 0. `hades agent resume` devolve o registro a `working`.

**Estacionado** (o que o pack exige) = registro `parked`, ou handoff com `STATUS: PARKED` mais novo que o último prompt
(a regra do `watch`); **encerrado** = `done` ou `archived`.

## `hades caronte pack`

```
hades caronte pack <plano> [--out <arq>] [--with-journal] [--allow <caminho>]… [--dry-run]
```

- **Raiz de trabalho:** plano em `~/.claude/hades/plans/` usa a raiz `_skill`; os demais, a do projeto do diretório atual.
- **Agentes do plano:** os do registro da raiz cujo nome aparece como palavra no texto do plano. Recusa (saída 1), nomeando
  o agente e o comando `hades agent park <nome>`, se algum não está estacionado ou encerrado. Nunca estaciona sozinho.
- **O que entra:** o plano e o `<plano>.log.md`; `plan.json`; por agente do plano o `agents/<n>.json`, os arquivos
  `watch/<n>.*` e `consolidations/<n>.*`; da pasta de relatórios da worktree `brief.md`, `handoff.md`, `report.md`,
  `questions.md`, `quality.md`; com `--with-journal`, `journal/<n>.jsonl`; por worktree, o bundle e o patch (abaixo).
- **O que nunca entra:** transcripts das sessões (a retomada é pelo handoff, como no teto de contexto), infra e dados do
  ambiente local, `credenciais.md`, `.env*` (fora `.env.example`), chaves (`*.pem`, `*.key`, `id_*`) e padrões de segredo.
- **Worktree:** `commits.bundle` = `git bundle` de `<merge-base com a base>..HEAD` (o que não está publicado), só se há
  commit próprio; `uncommitted.patch` = `git diff --binary` do não commitado **incluindo não rastreados e excluindo
  ignorados** (índice temporário: o da worktree não é tocado; a pasta de relatórios fica de fora, vai como parte própria).
  A pasta só entra num `:(exclude)` quando **não** é ignorada (`git check-ignore`): ignorada (o caso de toda worktree de
  unidade da skill), ela já está fora do `add -A`, e o exclude faria o git sair com 1 ("caminhos ignorados").
  Worktree limpa e sem commit próprio leva só a referência da base (`baseRef`, `baseSha`, `head` no manifesto).
- **Saída:** `~/.claude/hades/caronte/<plano>-<UTC>.caronte` (ou `HADES_CARONTE_OUT_DIR`), modo 600, nunca sobrescreve e
  recusa `--out` dentro de um repositório.
- **`--dry-run`:** lista partes, tamanhos, agentes e achados da guarda; não pede senha, não grava; sai 1 se houver barrado.

### Guarda de segredo

Roda sobre os arquivos, os commits (`base..HEAD`) e o patch. Barra por **nome** (`credenciais.md`, `.env*`, chaves) e por
**conteúdo** (os marcadores do release-guard: `secretPattern()` em `src/lib/release-guard.ts`, sem usuário e host da
máquina, que aparecem legitimamente em briefs). Recusa (saída 1) nomeando o **caminho lógico** e a regra, nunca o valor.
`--allow <caminho lógico>` (repetível; igualdade exata, ex. `worktrees/fake-a/.env`) libera o caminho e o grava em
`manifest.allowed`.

## Formato do pacote (contrato; só cresce)

Arquivo = `MAGIC | u32 tamanho do cabeçalho | cabeçalho JSON | texto cifrado | tag GCM (16 bytes)`, tudo big-endian.

- `MAGIC` = `CARONTE` + byte `0x01`.
- Cabeçalho (JSON UTF-8, até 4 KiB): `{ "v": 1, "kdf": "scrypt", "log2n": 17, "r": 8, "p": 1, "salt": "<b64, 16 B>",
  "cipher": "aes-256-gcm", "iv": "<b64, 12 B>" }`. `MAGIC | tamanho | cabeçalho` é o **AAD** do GCM: adulterar o cabeçalho
  falha na autenticação. Chave = `scrypt(senha NFKC, salt, N=2^log2n, r, p)`, 32 bytes. O leitor recusa `log2n` fora de
  1–22 e `v` maior que o seu.
- Texto cifrado = AES-256-GCM de `gzip(contêiner)`. **Senha errada e arquivo adulterado são indistinguíveis no GCM**: a
  mensagem diz as duas coisas (`CaronteError`, código `wrong-password`).
- Contêiner = sequência de partes `[u32 tamanho do nome][nome UTF-8][u64 tamanho][bytes]`; a primeira é sempre
  `manifest.json`. Partes de até 1 GiB.
- Só `node:crypto` e `node:zlib`; nenhuma dependência.
- Funções do contrato: `encryptPackage`, `decryptPackage`, `verifyParts` (confere o sha256 de cada parte) em
  `src/lib/caronte.ts`.

### Caminhos lógicos das partes

`plan/<plano>.md`, `plan/<plano>.log.md`, `orchestration/plan.json`, `orchestration/agents/<n>.json`,
`orchestration/watch/<n>.*`, `orchestration/consolidations/<n>.*`, `reports/<n>/{brief,handoff,report,questions,quality}.md`,
`journal/<n>.jsonl` (só com `--with-journal`), `worktrees/<n>/commits.bundle`, `worktrees/<n>/uncommitted.patch`.

### `manifest.json`

| Campo | Conteúdo |
|---|---|
| `format` | versão do formato (1). Sobe só em quebra; o major do leitor diferente recusa |
| `skillVersion` | `VERSION` da skill que empacotou (menor diferente: avisa) |
| `createdAt` | UTC, ISO 8601 com `Z` |
| `workRoot` | raiz de trabalho de origem (`~/.claude/hades/work/<slug>`) |
| `scope` | `skill` ou `project` |
| `repo` | `{ remote, clone }`: `remote.origin.url` e o caminho do clone principal (vazio no remote se não há) |
| `plan` | `{ path, name, approvedSha, sha }`: caminho de origem, nome, sha **aprovado** no `plan.json` (ou `null` se o `plan.json` é de outro plano) e sha atual do plano sem o "Estado atual" |
| `agents` | nomes dos agentes do plano |
| `worktrees[]` | `{ agent, path, branch, head, baseRef, baseSha, bundle, patch }`; `bundle` e `patch` são caminhos lógicos ou `null` |
| `parts[]` | `{ path, size, sha256 }` de cada parte (menos o `manifest.json`) |
| `withJournal` | se o diário entrou |
| `allowed[]` | caminhos liberados com `--allow` |

Regra do contrato: campo novo é **aditivo** (o leitor ignora o que não conhece); remover ou mudar o significado de um
campo exige `format` novo e janela de migração.

## `hades caronte unpack`

```
hades caronte unpack <arq> [--work-root <d>] [--plans <d>] [--worktrees <d>] [--clone <d>] [--dry-run]
```

Abre o pacote e refaz a orquestração. Nunca clona, nunca estaciona, nunca sobrescreve.

- **Senha:** prompt do tty (uma vez, sem confirmação) ou, só em automação, `HADES_CARONTE_PASSWORD`; `--dry-run` também pede (sem ela não há
  manifesto). Senha errada ou arquivo adulterado: recusa (`wrong-password`); parte com sha256 fora do manifesto: recusa
  nomeando a parte; só as partes listadas no manifesto são lidas.
- **Versão:** `format` do manifesto maior que o do leitor recusa; `skillVersion` de outro major recusa, de outro minor
  avisa.
- **Destinos** (o padrão refaz o layout da origem nesta máquina; as flags trocam cada um e permitem simular "outra
  máquina" na mesma):

  | O quê | Padrão | Flag |
  |---|---|---|
  | raiz de trabalho | a raiz desta máquina (`HADES_WORK_ROOT`, `work-root`, `~/.claude/hades/work`) + o último componente de `manifest.workRoot` (`_skill` ou o slug do projeto) | `--work-root <d>` troca a raiz (a pasta que contém `_skill`) |
  | plano e `.log.md` | `~/.claude/hades/plans/` se o plano veio de uma pasta `…/hades/plans`; senão a pasta de origem | `--plans <d>` |
  | worktrees | o mesmo diretório-pai da origem, nome igual | `--worktrees <d>` (cada uma em `<d>/<nome>`) |
  | clone | `manifest.repo.clone`, se existe e o `remote.origin.url` confere com `repo.remote` | `--clone <d>` (se o remote difere, avisa) |

- **Plano:** existente com outro sha (a mesma conta do pack, sem o "Estado atual") recusa; com o mesmo sha, segue e não
  sobrescreve. O `plan.json` volta com os caminhos reescritos; a aprovação só vale se `approvedSha` confere com o plano
  restaurado, senão avisa para rodar `hades agent plan-approve` de novo. `plan.json` já existente de outro plano recusa.
- **Clone:** sem clone, recusa e imprime `git clone <remote>`. Base (`baseSha`) ausente do clone: `git fetch origin
  <baseRef>`; se não der, recusa com o comando.
- **Worktrees:** por worktree, `git bundle verify`, fetch do bundle para a branch de origem (sem bundle, a branch nasce na
  base), `git worktree add`, conferência de que o HEAD é o do manifesto e `git apply --binary` do `uncommitted.patch`
  (volta o diff, os não rastreados e os binários). Worktree ou branch já existente: recusa sem mexer em nada. Worktree
  de origem em HEAD destacado: recusa (só branches).
- **Registro:** um mapa origem → destino (worktree, plano, raiz de trabalho) reescreve os caminhos em `agents/*.json`,
  `plan.json` e `watch/`/`consolidations/`. Os agentes voltam `parked` e **sem `pane`** (os encerrados `done`/`archived`
  continuam encerrados); os relatórios voltam para a pasta de relatórios de cada worktree; o diário só volta se veio no
  pacote. Arquivo de registro já existente recusa.
- **Atomicidade:** tudo é validado antes de escrever (destinos livres, clone, base, bundle, nomes). Se uma escrita falha
  no meio, o unpack desfaz em ordem inversa o que criou (arquivos, worktrees, branches, pastas novas), sem tocar no que já
  existia; se o desfazer também falha, a mensagem diz o que conferir à mão.
- **`--dry-run`:** mostra o mapa origem → destino e o que seria criado; não escreve nada (nem fetch).
- **Retomada:** no fim imprime, por agente, `herdr workspace create …`, o start do herdr (como o `skill-new`) e `hades agent
  adopt <n> && hades agent resume <n>`, e depois o prompt do `hades caronte brief`. O dono inicia cada agente.

## `hades caronte brief <plano>`

Só leitura, mesma máquina. Imprime o prompt do orquestrador na sessão nova: ler **só** o "Estado atual" do plano, rearmar
`hades watch --next` em segundo plano e rodar `hades agent resume <nome>` por agente estacionado do plano (os nomes vêm
do registro).

## Configurações

`HADES_CARONTE_OUT_DIR` (pasta dos pacotes) e `HADES_CARONTE_SCRYPT_LOG2N` (17, 14–20); ver `reference/config.md`.
`HADES_CARONTE_PASSWORD` é a senha para uso sem tty: variável de ambiente do processo, não é chave do catálogo e
nunca é gravada. Quando definida, vale no lugar do prompt. Use só em automação, e preencha-a sem que a senha apareça na
linha de comando nem no histórico do shell:

```bash
read -rs HADES_CARONTE_PASSWORD && export HADES_CARONTE_PASSWORD   # digite a senha; sem eco
hades caronte pack <plano>
unset HADES_CARONTE_PASSWORD
```

Nunca escreva `HADES_CARONTE_PASSWORD=<senha> hades caronte …` (a senha vai para o histórico) nem a grave em arquivo.
