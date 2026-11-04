# Cerberus: as fronteiras da Hades

O Cerberus guarda as fronteiras da Hades com três cabeças. Cada cabeça observa os próprios aspectos e, em cada momento
de fronteira, emite um **veredito com evidência**:

| Cabeça | Id | Observa |
|---|---|---|
| **Porta** | `porta` | o que sai da máquina: push, comentário de PR, artefato, túnel, release |
| **Limiar** | `limiar` | o que entra: plugin, `post-install.sh`, hooks, páginas e rotas do painel |
| **Vigília** | `vigilia` | o que acontece dentro: auditoria do DONE, coerência entre plano, registro e realidade |

Este arquivo é o **contrato** entre o corpo (motor, registro, histórico, página) e as cabeças. Mudança nele é só
aditiva: campo novo, momento novo, valor novo. Nada some nem muda de significado.

Peças do corpo:

| Peça | Caminho |
|---|---|
| motor (avaliação, registro, histórico, exceção) | `src/lib/cerberus.ts` e `src/commands/cerberus.ts` (`hades cerberus …`) |
| registro de guardas | `loop/cerberus/<cabeça>/<guarda>.json` |
| histórico e exceções | `<work>/_maquina/cerberus/` (`<work>` = `HADES_WORK_ROOT`, `~/.claude/hades/work-root` ou `~/.claude/hades/work`) |
| modos e limites | Configurações → grupo **Cerberus** (`HADES_CERBERUS_*`, `reference/config.md`) |
| página do painel | `kit/panel/ui/pages/cerberus.tsx`, `GET /api/cerberus` (`reference/panel.md` §Cerberus) |
| bloco de cada cabeça na página | `kit/panel/ui/cerberus/{porta,limiar,vigilia}.tsx` (servidos como `.js`) |
| texto de cada cabeça | `reference/cerberus/porta.md`, `reference/cerberus/limiar.md`, `reference/cerberus/vigilia.md` |
| regressão | `bun test` (`loop/test/ts/`, `cerberus-*.test.ts`) |

O corpo mora em TypeScript (Bun): `hades cerberus …` (sem Bun sai 69 com a instrução do registro de dependências). `gate-lock.sh` e `skill-release.sh` o chamam pela CLI (`hades cerberus registrar …`). Os arquivos de estado (histórico, exceções) e as chaves são os mesmos de sempre.

## Veredito

Um veredito é um objeto JSON:

```json
{
  "cabeca": "porta",
  "guarda": "upstream-push",
  "momento": "push",
  "resultado": "barra",
  "evidencia": [
    {"conferido": "@{upstream} = origin/feat/x, headRefName da PR = feat/y", "onde": "git rev-parse --abbrev-ref @{upstream} em <worktree>"}
  ],
  "detalhe": "a branch local rastreia outra branch"
}
```

- `resultado`: `ok`, `aviso` ou `barra`.
- `evidencia`: lista não vazia (até 20 itens) de `{conferido, onde}`, os dois texto não vazio (até 500 caracteres): o que
  foi conferido e onde (arquivo, comando, URL, linha). **Veredito sem evidência não vale**: o corpo o recusa.
- `detalhe`: texto opcional (até 1000 caracteres).
- `cabeca`, `guarda` e `momento` a guarda pode omitir (o corpo preenche); se vierem, têm de bater com o registro.

O corpo acrescenta, no histórico: `ts` (UTC, ISO 8601 com `Z`), `avaliacao` (id da avaliação conjunta, 12 hex),
`modo` (o da cabeça no momento), `efeito`, `origem` (`avaliar` ou `emitida`), `ctx`, `dir` e, quando houver,
`invalido: true` e `excecao`.

`efeito` é o que o veredito fez no momento:

| resultado | modo `barra` | modo `avisa` | com exceção do dono |
|---|---|---|---|
| `ok` | `ok` | `ok` | — |
| `aviso` | `aviso` | `aviso` | — |
| `barra` | `barra` | `aviso` | `liberado` |

**Veredito inválido** (saída que não é JSON, resultado fora da lista, evidência vazia ou malformada, guarda que estourou
o tempo ou saiu com erro sem veredito, cabeça/guarda/momento que não batem): o corpo o troca por um `barra` com
`invalido: true`, a evidência do próprio corpo (o que recusou e por quê) e o modo da cabeça aplicado em cima. Falha da
guarda nunca vira `ok` em silêncio.

## Momentos

| Momento | Quando | Quem chama `avaliar` |
|---|---|---|
| `done` | DONE de agente | `hades agent done` (depois da auditoria, antes de liberar o lock) |
| `push` | push de branch de PR | o agente, antes do push (`reference/loop/gates.md` §2); não há script do núcleo |
| `release` | release da skill | `kit/skill-release.sh release` (depois do `check`, antes do bump) |
| `plugin` | instalar, atualizar ou religar plugin | `hades plugins` (`add --apply`, `update --apply`, `enable`) |
| `consolidacao` | PR de consolidação posta para review | `hades consolidate ready --post` |
| `continuo` | dentro, a qualquer hora (hook, fila) | ninguém avalia: só guardas `emitida` registram aqui |
| `publicacao` | comentário ou review publicado em PR, artefato publicado | o agente, antes de publicar; não há script do núcleo |
| `comentario` | antes de postar texto numa PR | `hades review` (o `claude -p` que posta), `hades consolidate`, a reconciliação (`reference/loop/inbox.md`) |
| `artefato` | antes de publicar artefato | `hades minos publish` (a página preparada passa por aqui antes de existir; o agente só publica o que o comando devolveu) |
| `tunel` | antes de abrir túnel para fora | `kit/tunnel.sh` (`publish-cmds` no front, `panel-start` no painel) |

Contexto do `plugin`: `plugin`, `op` (`add`, `update` ou `enable`), `commit` e `pack_dir`: no `add`, o clone em prévia
(em `$D/plugins-staging`, avaliado **antes** de ir para a pasta de pacotes); no `update` e no `enable`, o pacote
instalado (no `update`, ainda no commit atual; o alvo é `commit`). A guarda herda `HADES_DATA`, `HADES_PACKS_ROOT` e
`HADES_SKILL_DIR` sempre preenchidos.

Contexto do `comentario`: `pr` (número) e `texto` (arquivo com o corpo exato que vai ser postado). Do `artefato`:
`arquivo` (o caminho do que vai ser publicado). Do `tunel`: `tunel` (`front` ou `painel`) e `porta`. Nos três, exit `1`
do `avaliar` = não publicar.

## Avaliação conjunta

```bash
hades cerberus avaliar <momento> [--dir <d>] [--ctx chave=valor]... [--cabeca <c>] [--json]
```

- Roda toda guarda `exec` registrada para o momento, das cabeças que não estão em `off`, na ordem cabeça → id.
- Saída: uma linha por veredito (`efeito cabeça/guarda: detalhe`) e o resultado; com `--json`, o objeto
  `{avaliacao, momento, resultado, barras, avisos, vereditos: [...], ignoradas: [<cabeça em off>]}`.
- **Exit:** `0` passa (`ok` ou só avisos; os avisos se somam no resultado), `1` barra (qualquer `efeito: barra`), `2`
  uso ou registro inválido. Quem chama trata `1` como o momento barrado.
- Sem nenhuma guarda para o momento (zero guardas), o resultado é `ok`, nada vai ao histórico e a saída de texto fica
  vazia (o `--json` sai sempre).
- `--ctx`: chave `[a-z][a-z0-9_]{0,31}`, valor até 300 caracteres; chega à guarda (abaixo) e ao histórico. Chaves
  usuais: `pr`, `branch`, `agente`, `plugin`, `commit`, `versao`, `op`.
- `--dir`: diretório de trabalho da guarda (padrão: o atual).

## Registro de guardas

Uma guarda entra por **um arquivo** `loop/cerberus/<cabeça>/<id>.json`; o código do corpo não muda. O nome do arquivo é
o id (`[a-z0-9][a-z0-9-]{0,47}`).

```json
{
  "titulo": "Upstream confere com a branch da PR antes do push",
  "momentos": ["push"],
  "tipo": "exec",
  "cmd": ["hades", "cerberus-check", "porta/upstream-push"],
  "timeoutS": 30,
  "origem": "SKILL.md §Invariantes de seguranca (nao destravaveis)",
  "descricao": "Compara git rev-parse --abbrev-ref @{upstream} com o headRefName da PR do contexto."
}
```

| Campo | Obrigatório | Valor |
|---|---|---|
| `titulo` | sim | uma linha |
| `momentos` | sim | lista não vazia de momentos (acima) |
| `tipo` | sim | `exec`, `emitida` ou `regra` |
| `cmd` | só `exec` | lista; `cmd[0]` relativo à pasta da cabeça (`loop/cerberus/<cabeça>/`), sem `..`, existente |
| `timeoutS` | não | 1–600; padrão `HADES_CERBERUS_TIMEOUT_S` |
| `origem` | sim | onde a regra está escrita ou onde a guarda vive (arquivo e seção) |
| `descricao` | não | o que confere |
| `dono` | só `regra` | a cabeça que deve dar corpo a ela (padrão: a própria) |

Tipos:
- **`exec`**: o corpo roda `cmd` em cada momento listado. A guarda recebe o contexto e imprime **um** veredito JSON na
  saída padrão (o exit é ignorado quando há veredito válido). Ambiente: `CERBERUS_CABECA`, `CERBERUS_GUARDA`,
  `CERBERUS_MOMENTO`, `CERBERUS_DIR`, `CERBERUS_SKILL` (raiz da skill), `CERBERUS_CTX` (o contexto em JSON) e
  `CERBERUS_CTX_<CHAVE>` para cada `--ctx`; o mesmo JSON do contexto chega na entrada padrão. cwd = `--dir`.
- **`emitida`**: a guarda vive no próprio script e decide sozinha (barra ou não, como sempre fez); só **registra** o
  veredito pelo corpo (`registrar`, abaixo). O modo da cabeça e a exceção não mudam o que ela faz: valem para a
  avaliação conjunta. O histórico guarda o `efeito` que o script aplicou.
- **`regra`**: só existe como regra escrita; não executa. Aparece na página como "só regra escrita", com o `dono`.

Validação do registro: `hades cerberus guardas --validar` (exit 2 com a lista de erros). Arquivo inválido
nunca é ignorado em silêncio: `avaliar` sai 2 com o erro.

### Onde mora o código de um check

Os checks das três cabeças são TypeScript (`src/lib/cerberus-porta.ts`, `cerberus-limiar.ts`, `cerberus-vigilia.ts`), chamados
por `hades cerberus-check <cabeça>/<guarda> [arg]` (uma linha de veredito, o mesmo JSON de antes). Não há scripts em
`checks/`: o `cmd` do JSON da guarda chama o `hades cerberus-check`, e a forma muda por cabeça:

| Cabeça | `cmd` | Exemplo |
|---|---|---|
| Porta | `["hades","cerberus-check","porta/<guarda>"]` | `porta/upstream-push` |
| Limiar | `["hades","cerberus-check","limiar","<check>"]` | `limiar commit-fixado` |
| Vigília | `["hades","cerberus-check","vigilia/<grupo>","<check>"]` | `vigilia/auditoria status`, `vigilia/coerencia plano` |

O contrato do check `exec` (ambiente `CERBERUS_*`, veredito em JSON na saída) é aberto: um check de terceiros, de plugin ou
do dono pode ser em qualquer linguagem.

Check novo da casa, em TypeScript:
1. a função da guarda (`(ce: CheckEnv) => CheckVerdict`, de `src/lib/cerberus-check.ts`) entra na tabela da cabeça
   (`PORTA_GUARDS`, `LIMIAR_GUARDS` ou os mapas da Vigília): o que a guarda lê vem de `ce` (`dir`, `skill`, `momento`,
   `ctx`, `env`), nunca do ambiente global, para o teste injetar;
2. `loop/cerberus/<cabeça>/<id>.json` registra a guarda; o `cmd` segue a forma da cabeça (tabela acima), como os vizinhos;
3. o teste da cabeça cobre o veredito `ok`, o `barra` e a falha ao conferir (sem a ferramenta, sem o contexto: `aviso`
   ou `barra` com `detalhe`, nunca um erro solto); `hades cerberus guardas --validar` tem de seguir verde.

### Registrar veredito de guarda `emitida`

```bash
hades cerberus registrar --cabeca <c> --guarda <id> --momento <m> --resultado ok|aviso|barra \
  --evidencia "<conferido>|<onde>" [--evidencia ...] [--detalhe "<texto>"] [--efeito ok|aviso|barra] [--ctx k=v]... [--dir <d>]
```

A guarda tem de estar registrada como `emitida` naquele momento. Veredito sem evidência é recusado (exit 2, nada
gravado). `--efeito` (padrão: o `resultado`) é o que o script aplicou. Quem emite chama com `|| true`: o registro nunca
muda o comportamento da guarda.

## Guardas registradas

Índice: uma linha por guarda de `loop/cerberus/<cabeça>/<id>.json` (`hades cerberus guardas` lista o mesmo). O que cada
guarda confere, quando barra e de onde vem está no arquivo da cabeça: `reference/cerberus/<cabeça>.md`.

| Guarda | Cabeça | Tipo | Momentos | Detalhe |
|---|---|---|---|---|
| `branch-protegida` | porta | exec | push, consolidacao | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `conta-gh` | porta | exec | push, consolidacao, comentario | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `dominio` | porta | emitida | release | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `nome-de-projeto` | porta | emitida | release | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `nome-dominio` | porta | exec | release, consolidacao | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `plano-aprovado` | porta | exec | release, consolidacao | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `remote-push` | porta | exec | push, consolidacao | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `review-so-comment` | porta | regra | publicacao | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `segredo-diff` | porta | exec | push, release, consolidacao, comentario, artefato | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `sem-coautor` | porta | regra | push | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `sem-force-nem-no-verify` | porta | regra | push | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `sem-merge` | porta | regra | push, consolidacao | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `thread-so-verificada` | porta | regra | publicacao | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `tunel-acesso` | porta | exec | tunel | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `upstream-push` | porta | exec | push, consolidacao | [`reference/cerberus/porta.md`](cerberus/porta.md) |
| `plugin-commit-fixado` | limiar | exec | plugin | [`reference/cerberus/limiar.md`](cerberus/limiar.md) |
| `plugin-executavel-na-previa` | limiar | exec | plugin | [`reference/cerberus/limiar.md`](cerberus/limiar.md) |
| `plugin-invariante-do-nucleo` | limiar | exec | plugin | [`reference/cerberus/limiar.md`](cerberus/limiar.md) |
| `plugin-ensaio-isolado` | limiar | exec | plugin | [`reference/cerberus/limiar.md`](cerberus/limiar.md) |
| `auditoria-done` | vigilia | emitida | done | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `card-obrigatorio` | vigilia | regra | done | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `done-capturas` | vigilia | exec | done, consolidacao | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `done-commits` | vigilia | exec | done, consolidacao | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `done-escopo` | vigilia | exec | done, consolidacao | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `done-gates` | vigilia | exec | done, consolidacao | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `done-perguntas` | vigilia | exec | done, consolidacao | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `done-status` | vigilia | exec | done, consolidacao | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `estado-fora-do-repo` | vigilia | regra | done | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `excecao-so-dono` | vigilia | emitida | continuo | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `gate-lock-admissao` | vigilia | emitida | continuo | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `gerado-e-banco` | vigilia | regra | done | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `hook-fila-e-polling` | vigilia | emitida | continuo | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `plano-registro` | vigilia | exec | done, consolidacao | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `registro-realidade` | vigilia | exec | done, consolidacao | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |
| `teste-nao-enfraquecido` | vigilia | regra | done | [`reference/cerberus/vigilia.md`](cerberus/vigilia.md) |

## Modos

Por cabeça, em Configurações → Cerberus: `HADES_CERBERUS_PORTA`, `HADES_CERBERUS_LIMIAR`, `HADES_CERBERUS_VIGILIA`, cada
um `off`, `avisa` ou `barra`. Padrão: Porta e Limiar em `barra`, Vigília em `avisa` (em calibração).

- `barra`: o `barra` da guarda barra o momento.
- `avisa`: o `barra` vira aviso (`efeito: aviso`, `resultado` continua `barra` no histórico).
- `off`: a cabeça não é avaliada (as guardas `exec` dela não rodam; `ignoradas` na saída).

O modo só se muda pelo painel local ou pelo `!` do dono (`config.sh set HADES_CERBERUS_<C>=<modo>`): o acesso remoto do
painel recusa, e o hook barra a troca vinda das ferramentas do Claude (§Exceção).

## Exceção

Só o dono abre, com motivo; ela fica registrada junto do veredito que liberou. Uma exceção casa cabeça, guarda e momento,
e opcionalmente um `alvo` (subconjunto do contexto, ex. `{"pr": "12"}`). É de **uso único** e expira
(`HADES_CERBERUS_EXC_TTL_H`): libera um `barra` (`efeito: liberado`) e fica marcada com o id da avaliação; o veredito leva
`excecao: {id, motivo, por, aberta}`. Armazenamento: `<work>/_maquina/cerberus/excecoes.json`.

Dois pontos de entrada abrem, os dois só do dono:

- **Painel local:** página Cerberus → **Abrir exceção** (motivo obrigatório). `POST /api/cerberus` recusa o acesso
  remoto.
- **Terminal, pelo `!` do dono:**
  `! hades cerberus excecao abrir --cabeca <c> --guarda <id> --momento <m> --motivo "<por quê>" [--alvo k=v]...`

**O que o hook barra.** O hook (`hades guard`) barra, em toda sessão do Claude Code, o que vier das ferramentas:
`excecao abrir`, chamada a `/api/cerberus`, escrita no diretório do Cerberus e troca dos modos `HADES_CERBERUS_*`
(`hades config set`, `/api/config`). O `!` do dono não passa pelo hook. O hook roda em Bun (`src/hook.ts`,
`reference/cli.md` §Hook).

**O limite.** Agente e dono são o mesmo usuário Unix, então isto barra o caminho normal do agente, não um agente
determinado a contornar: a origem (`painel` ou `terminal`) fica na exceção e no veredito que ela liberou.

`hades cerberus excecao listar [--json]` mostra as abertas, as usadas e as expiradas.

## Histórico

`<work>/_maquina/cerberus/vereditos.jsonl`, um veredito por linha (formato acima), fora de qualquer repositório. Passou
de `HADES_CERBERUS_HIST_KB`, o arquivo vira `vereditos.1.jsonl` (o `.1` anterior sai): no máximo duas gerações.

```bash
hades cerberus historico [--cabeca <c>] [--efeito ok|aviso|barra|liberado] [--limite N] [--json]
hades cerberus estado --json      # o que a página usa: cabeças, modos, guardas, histórico, barrados por guarda
```

## Estender uma cabeça

Cada cabeça mexe só no que é dela, e várias podem evoluir em paralelo sem disputar arquivo. Onde cada coisa mora
(`<c>` = `porta`, `limiar` ou `vigilia`):

| O quê | Onde |
|---|---|
| guardas | `loop/cerberus/<c>/<id>.json` (um arquivo por guarda) |
| código das guardas `exec` | `src/lib/cerberus-<c>.ts`, chamado por `hades cerberus-check` (§Onde mora o código de um check) |
| bloco da página | `kit/panel/ui/cerberus/<c>.tsx` (abaixo) |
| regressão | `loop/test/ts/cerberus-<c>.test.ts` (`bun test`) |
| texto | `reference/cerberus/<c>.md` (o que a cabeça confere e por quê) |
| emitir de um script existente | só a linha do `registrar` nele, com `|| true` |
| chave própria | linha nova no `kit/config.tsv`, grupo `Cerberus`, prefixo `HADES_CERBERUS_<C>_` |

Para acrescentar um check em TypeScript, siga os passos de §Onde mora o código de um check. A cabeça pode trocar uma
guarda `regra` por `exec` ou `emitida` editando o arquivo daquela guarda.

Bloco da página: um script que se registra no objeto global da página Cerberus. O fonte é `.tsx` e o painel o serve como
`.js`. Sem o arquivo, a cabeça aparece só com o modo, as guardas e o histórico dela.

```tsx
/* kit/panel/ui/cerberus/porta.tsx */
(() => {
const { Card, CardHeader, CardContent } = HadesCore;
function Bloco({ cabeca, guardas, historico }) {   // cabeca: {id, nome, modo}; guardas e historico já filtrados por ela
  return <Card><CardHeader title="Porta: o que saiu hoje" /><CardContent>…</CardContent></Card>;
}
HadesCerberus.registerBlock('porta', Bloco);
})();
```

O servidor lista os blocos presentes (`GET /api/cerberus` → `blocos`) e a página carrega cada um depois de si.
