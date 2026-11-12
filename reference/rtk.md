# Resumidores por stack entregues pelo rtk

O [rtk](https://github.com/rtk-ai/rtk) é um proxy de linha de comando que resume a saída de `cargo`, `npm`, `jest`, `tsc`… antes de ela
entrar no contexto do agente. A Hades não reimplementa nem faz fork dele: **detecta o rtk, entrega os filtros de cada stack e liga
isso por worktree**. Sem o rtk no `PATH` nada muda (nenhum arquivo, nenhum aviso além de uma linha `warn` no `doctor`).

## O que a Hades faz

| Peça | Onde |
|---|---|
| Detecção | `src/deps/registry.tsv` (`rtk`, `warn`: opcional); `hades deps`, `doctor` e o painel mostram presença e versão |
| Filtros da stack | `stacks/<stack>/rtk-filters.toml` (`node-nx`, `pnpm-next`, `rust-cargo`, `tauri`) |
| Filtros do plugin | `rtk.filters` no `profile.json` do pacote do projeto (abaixo) |
| Instalação por worktree | `kit/install.sh` e a criação de agente (`agent new`, `skill-new`) geram `.rtk/filters.toml` e o põem no `.git/info/exclude` |
| Estado e ajuste | `hades rtk status\|apply`, `doctor`, Configurações → Resumidores (rtk) |

- **Nunca** edita `~/.config/rtk/*` (config e filtros globais do dono). O que a Hades escreve fica no worktree
  (`.rtk/filters.toml`) e em `$D/rtk/` (saída inteira).
- O arquivo gerado começa com `# Gerado pela Hades`: é a marca que autoriza a Hades a regerar e a remover. Arquivo `.rtk/filters.toml`
  **versionado pelo projeto**, ou presente sem a marca, fica como está.
- Worktree sem stack com filtro, ou com todos os filtros desligados, não ganha arquivo (e o gerado antes sai).

## O corte sempre se anuncia

Regra dura: nenhum filtro entregue descarta linha com conteúdo sem avisar que descartou.

- O filtro TOML do rtk só **anuncia** o que cortam `head_lines`, `tail_lines` e `max_lines` (`... (N lines omitted)` ou
  `... (N lines truncated)`) e `truncate_lines_at`. Com `strip_lines_matching` de uma linha com conteúdo, `keep_lines_matching`
  e `match_output` a linha some sem contagem e sem aviso, e um TOML não tem como acrescentar um marcador próprio.
- Por isso os filtros entregues usam só: `strip_ansi`, `replace` (colapsa o redesenho de progresso com `\r` na última versão da linha),
  `strip_lines_matching` **só de linha em branco** (`^\s*$`, `^$`, `^\s+$`) e o teto `head_lines` + `tail_lines`.
- **O marcador é o anúncio do rtk** (`... (N lines omitted)`) mais o aviso de recall que o rtk 1.x imprime
  (`[full output: rtk recall <hash>]`): o `N` é o número de linhas cortadas e o hash recupera a saída inteira.
- A mesma regra valida o arquivo de filtros do plugin: `hades project validate` reprova `strip_lines_matching` de linha com
  conteúdo, `keep_lines_matching`, `match_output` com regra, chave que o rtk desconhece e TOML inválido.
- A regressão (`loop/test/ts/rtk-filters.test.ts`) simula o pipeline do rtk com saída sintética (ANSI, `\r` de progresso, linhas em branco,
  de 1 a 1000 linhas) e **falha** se um filtro entregue fizer sumir linha com conteúdo sem `N` omitidas correto.

## Saída inteira: recall e tee

- `install` cria `$D/rtk/` e o `env.sh` exporta `RTK_RECALL_DB=$D/rtk/recall.db` e `RTK_TEE_DIR=$D/rtk/tee`: a saída inteira que um
  filtro cortou fica **dentro dos dados da instância**, não no padrão do rtk (`~/.local/share/rtk`). Vale em todo shell que carrega o `env.sh`.
- Rotação: a categoria `rtk-tee` da limpeza (`clean.sh`, `hades logrotate`) apaga os arquivos de `$D/rtk/tee/` mais velhos que
  `HADES_CLEAN_CACHE_DAYS`; o sqlite do recall tem retenção própria do rtk (`reference/limpeza.md`).
- O `doctor` avisa quando as duas variáveis não apontam para `$D` no processo que o roda.
- **Evidência de gate nunca passa por filtro.** O log do `gate-lock.sh run` e os resumos dos comandos da Hades (`hades wait gate`,
  `hades gate-lock status`, `hades project step`…) são lidos como estão; o rtk só reescreve o que o agente roda dentro do worktree.

## Quando o filtro TOML roda (rtk 1.x)

- O rtk procura filtro em `.rtk/filters.toml` > `~/.config/rtk/filters.toml` > embutidos. O TOML só é o **fallback** do comando sem handler
  próprio: `cargo build|test|clippy|check|install|nextest`, `npm`, `pnpm`, `vitest`, `next` e `tsc` já têm handler Rust e o filtro TOML
  não os alcança. Por isso o `rust-cargo-extra` cobre `cargo run|bench|doc|llvm-cov|deny|audit` e os de `node-nx`/`pnpm-next` cobrem
  `nx`, `jest`, `pnpm exec jest|playwright|eslint|biome` e `pnpm run types:check|lint|test|build`.
- Filtros entregues:

| Stack | Filtro | Casa |
|---|---|---|
| `node-nx` | `node-nx-nx`, `node-nx-jest` | `nx …`, `npx nx …`, `jest …` |
| `pnpm-next` | `pnpm-next-exec`, `pnpm-next-script` | `pnpm exec jest\|playwright\|eslint\|biome`, `pnpm run types:check\|lint\|test\|build` |
| `rust-cargo` | `rust-cargo-extra` | `cargo run\|bench\|doc\|llvm-cov\|deny\|audit` |
| `tauri` | `tauri-build` | `[npx\|pnpm\|cargo] tauri build\|dev\|bundle` |

## Confiança (`rtk trust`)

O rtk **ignora em silêncio** um `.rtk/filters.toml` de projeto que não foi confiado (a confiança é o SHA-256 do arquivo, em
`~/.local/share/rtk/trusted_filters.json`, fora de `~/.config/rtk`). Quem confia:

- **O dono**: `install` e a criação de agente (caminho do dono) rodam `rtk trust --yes` no worktree que acabaram de gerar.
  **Isso confia no conteúdo do plugin do projeto**: o arquivo do pacote apontado por `rtk.filters` entra no arquivo confiado.
- **Exceção**: existindo `~/.config/rtk/filters.toml`, o `rtk trust --yes` confiaria também no filtro global, então a Hades **não** confia
  e avisa; o dono roda `rtk trust` por conta própria.
- **Nunca o agente**: o hook barra `rtk trust`, `rtk untrust` e `hades rtk apply --trust`. Regerar o arquivo muda o SHA-256: o `doctor`
  mostra "ainda não confiado" ou "mudou depois de confiado" com o comando (`cd <worktree> && rtk trust`).

**Aviso das worktrees dos agentes.** Toda worktree nova nasce com o filtro gerado e não confiado, e `rtk trust --list` só enxerga uma
pasta por vez. O modelo `src/lib/rtk-trust.ts` junta as worktrees do registro dos agentes (as `skill-dev` entram) que têm
`.rtk/filters.toml` com a marca da Hades e estado `nao-confiado` ou `alterado` (reusa `trustState`; arquivo do dono não conta). Só lê:
nunca roda `rtk trust`. Três lugares usam a lista:

- **`doctor`**: linha `rtk-trust` no grupo *Resumidores (rtk)* com a contagem, até 5 pastas (depois `+N`) e o comando de cada uma
  (`! cd <pasta> && rtk trust`, ou `hades rtk apply <pasta> --trust`). Nenhuma: ok. Sem rtk, a linha não aparece.
- **Painel**: card *Resumidores (rtk)* na página Consumo (`GET /api/rtk-trust`, cache de 30 s) com o número e o comando das primeiras 5.
  Sem rtk, o card não aparece.
- **Start do agente**: o comando que `agent new|review|skill-new|start-cmd` entrega ao dono vira
  `! (cd <worktree> && rtk trust) && herdr agent start …` quando a worktree tem filtro gerado e não confiado. É texto: a sessão não
  executa, e o hook continua barrando `rtk trust` e `--trust` das ferramentas do Claude. O comando do orquestrador (auto-alocação, sem
  `! `) não leva o trust.

## Desligar e ajustar

| Chave | Efeito |
|---|---|
| `HADES_RTK_FILTERS` | `auto` (padrão, com rtk presente) liga; `off` remove o `.rtk/filters.toml` gerado dos worktrees |
| `HADES_RTK_OFF_STACKS` | stacks (`node-nx`, `pnpm-next`, `rust-cargo`, `tauri`; vírgulas) sem filtro |
| `HADES_RTK_OFF_FILTERS` | nomes de filtro (os da tabela acima, ou do plugin; vírgulas) que ficam de fora |

- Painel → Configurações → **Resumidores (rtk)**; ou `config.sh set`. Aplicação `next`: vale na próxima instalação ou criação de agente,
  ou na hora com `hades rtk apply [<dir>]` (o dono acrescenta `--trust`).
- **O agente pode ver mais, não muda a política**: `rtk proxy <comando>` roda sem filtro, e `rtk recall <hash>` devolve a saída inteira.
  As chaves `HADES_RTK_*` entram na mesma trava de dono das chaves de autonomia (hook e painel remoto barram `HADES_RTK_*=`,
  `config set` e POST em `/api/config`; a ação vira veredito `excecao-so-dono` do Cerberus).
- Só vale em shell que carrega o `env.sh` (`RTK_RECALL_DB`/`RTK_TEE_DIR`); um agente aberto antes do `install` precisa exportá-las.

## Filtros do plugin do projeto

`profile.json` ganha o campo opcional `rtk` (aditivo; sem ele nada muda):

```json
{ "rtk": { "filters": "rtk-filters.toml" } }
```

- Caminho **relativo ao pacote do projeto**, dentro dele (como `refs`); mesmo formato do `rtk-filters.toml` das stacks.
- `hades project validate` confere que o arquivo existe no pacote e que `filterFileProblems` é vazio (regra do corte anunciado, chaves do rtk).
- Os blocos entram no `.rtk/filters.toml` depois dos das stacks e respondem a `HADES_RTK_OFF_FILTERS` pelo nome do bloco.
  Arquivo do plugin inválido é ignorado na geração (o `validate` é onde o erro aparece).

## Política recomendada ao `doctor` (só lê, nunca grava)

O `doctor` lê o `config.toml` do rtk (`~/.config/rtk/` ou `~/Library/Application Support/rtk/`) e recomenda:

| Chave do rtk | Recomendação | Por quê |
|---|---|---|
| `[hooks] exclude_commands` | acrescentar `"diff"` e `"ps -p"` | o rtk reescreve a saída e muda o que o comando prova |
| `[limits] grep_max_results` / `grep_max_per_file` | subir de 200 / 25 | o `grep` para no teto sem avisar |
| `[display] max_width` | subir de 120 | o corte de linha esconde o fim da mensagem |
| `[retriever] mode` (1.x) | `sqlite` (padrão) ou `tee`; com `tee`, `tee_on_success = true` | `disabled` não guarda a saída inteira |
| `[tee] mode = "always"` (0.x) | só se o `rtk --version` for 0.x | no 0.x o padrão grava só em falha |

A geração é lida de `rtk --version`; versão desconhecida não recebe a recomendação de nenhuma das duas.

## Chaves do rtk usadas e a fonte

Versão do rtk conferida: **1.1.0** (a issue de origem foi escrita contra a 0.43.0). Nenhuma chave foi inventada.

| Chave | Fonte (repositório `rtk-ai/rtk`, v1.1.0) |
|---|---|
| `schema_version`, `[filters.<nome>]`: `description`, `match_command`, `strip_ansi`, `replace` (`pattern`, `replacement`), `strip_lines_matching`, `head_lines`, `tail_lines`, `max_lines`, `truncate_lines_at`, `on_empty`, `match_output`, `keep_lines_matching`, `filter_stderr` | `src/core/toml_filter.rs` (`TomlFilterDef`, `deny_unknown_fields`) e `src/filters/README.md` (pipeline de 8 estágios) |
| `rtk trust`, `rtk trust --yes`, `rtk trust --list`, busca `.rtk/filters.toml` > `~/.config/rtk/filters.toml` > embutidos | `docs/guide/getting-started/configuration.md` §Trusting custom filters |
| `[hooks] exclude_commands`, `[limits] grep_max_results` / `grep_max_per_file`, `[display] max_width`, `[retriever] mode` / `tee_on_success`, `RTK_RECALL_DB`, `RTK_TEE_DIR` | `docs/guide/getting-started/configuration.md` e `src/core/config.rs` |
| `[tee] mode` (0.x) | documentação do rtk 0.x citada na issue; só entra na recomendação quando a versão detectada é 0.x |

## Ganho medido

Medido em 2026-11-12 com o rtk 1.1.0, **no que a ferramenta Bash devolve à sessão**, e não contra a saída bruta como o `rtk gain` faz.

**Método.** Cada comando rodou pela fila (`gate-lock.sh run test --label rtk-ganho-<caso> -- …`), três vezes: sem rtk (bruto), `rtk <cmd>`
(o que o hook do rtk faz com `HADES_RTK_FILTERS=auto`) e `rtk proxy <cmd>` (sem resumo, o caso `off`). A saída foi para um arquivo dentro do
comando da fila; contei `wc -c` e estimei tokens como bytes/4. O Claude Code corta a saída do Bash em 30000 caracteres: nenhum caso chegou
perto, então o corte dele não mudou nada. O que o rtk entrega é a saída inteira dele, sem passar pelo corte.

| Data | rtk | Projeto | Comando | Bruto (B / tokens) | Com filtro | Sem filtro (`proxy`) | Poupado |
|---|---|---|---|---|---|---|---|
| 2026-11-12 | 1.1.0 | skill Hades | `bun test loop/test/ts/rtk-filters.test.ts` (31 testes) | 103 / 26 | 70 / 18 | 103 / 26 | 32% |
| 2026-11-12 | 1.1.0 | skill Hades | `bun test rtk` (100 testes, 4 arquivos) | 105 / 26 | 71 / 18 | 105 / 26 | 32% |
| 2026-11-12 | 1.1.0 | skill Hades | `bun x tsc --noEmit` (rc=1: falta `@types/bun`, sem `node_modules`) | 163 / 41 | 184 / 46 | 163 / 41 | -13% |
| | 1.1.0 | node-nx | `nx lint` / `nx test` de um lib pequeno | pendente: clone sem `node_modules` | | | |

O que a tabela diz:

- **Ganho desprezível em valor absoluto.** As saídas já eram curtas (uma passagem verde de `bun test` tem 6 linhas). Os 32% são 8 tokens por
  rodada; um gate verde não paga a pena do resumo, e a economia real do rtk está nas saídas longas (falha com pilha, lint com centenas de achados).
- **`tsc` ficou maior** (+21 B): o handler do rtk repete a mensagem e acrescenta `TypeScript: 1 errors`. Com poucos erros o resumo custa mais
  que poupa; só compensa quando os erros se agrupam por arquivo.
- **O que o filtro esconde no `bun test`:** o cabeçalho com a versão do bun e a linha `N expect() calls`. Contagem de testes, falhas e duração
  ficam. Nada que decida se o gate passou.
- **Os filtros TOML da Hades não entraram.** Nenhum dos comandos casa `node-nx-nx` ou `node-nx-jest` (os de `bun` e `tsc` têm handler Rust
  no rtk, e o TOML só é o fallback). Por isso não ajustei `stacks/node-nx/rtk-filters.toml`: sem dado do `nx`/`jest`, ajuste seria palpite.

**Pendente: node-nx.** O clone `node-nx` usado (o do projeto ativo) tem `node_modules` apontando para uma pasta que não existe, e instalar
dependência não é permitido ao agente. Para completar: o dono roda `npm ci` no clone (`! cd <clone> && npm ci`) e alguém reroda a medição
pelo mesmo método num lib pequeno, `nx lint <lib>` e `nx test <lib>` (com `NX_SKIP_NX_CACHE=true`, para o nx não repetir saída do cache),
nos casos bruto, `rtk` e `rtk proxy`, e preenche a linha acima. Se o filtro esconder algo útil ou o ganho for desprezível, ajustar
`stacks/node-nx/rtk-filters.toml` com teste que prove o que passou a aparecer.
