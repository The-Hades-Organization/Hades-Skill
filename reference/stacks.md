# Pacotes de stack e a fila de gates

O formato (`hades.stack/1`) é o de `reference/projects.md` §Pacote de stack. Este arquivo é o que a skill faz com ele:
quais pacotes vêm instalados, como o hook e a fila os leem, o que o dono configura e como `/hades stack add` cria um novo.

## Onde ficam e quem vence

`<stacks>/<n>/stack.json` do dono (`HADES_STACKS_ROOT` > `~/.claude/hades/stacks-root` > `~/.claude/hades/stacks`),
depois `<skill>/stacks/<n>/stack.json`. O mesmo nome nos dois: vale o do dono. O perfil do projeto lista as que usa em
`stacks`; **sem perfil, ou perfil sem `stacks`, valem todas as instaladas** (a fila é da máquina, o hook barra o comando
cru de qualquer uma). `hades project stacks [<dir>]` lista as ativas, `detect [<dir>]` as que casam com os arquivos do
repo, `step <stack>:<etapa>` imprime `kind custo paralelismo medição` de uma etapa.

## Os quatro pacotes

| Pacote | Detecta | Etapas (kind · custo) |
|---|---|---|
| `node-nx` | `nx.json` e `package.json` | `lint` 2 GB · `build` 3 GB · `test` 4 GB · `integration` 5 GB · `affected` 5 GB; `npm run <script> -- {project}` |
| `pnpm-next` | `pnpm-lock.yaml` e `next.config.*` | `typecheck` 2 · `lint` 1 (paralelo 2) · `build` 3 · `test` 2; `pnpm run types:check\|lint\|build\|test` (scripts do `package.json`; o projeto aponta para tsc, biome ou eslint, vitest) |
| `rust-cargo` | `Cargo.toml` | `typecheck` (`cargo check`) 2 · `lint` (clippy) 2 · `build --release` 4 · `test` 3 |
| `tauri` | `src-tauri/tauri.conf.json` ou `src-tauri/Cargo.toml` | `typecheck` 2 · `build` (`tauri build`) 6 · `test` 3 |

`node-nx` reproduz exatamente os comandos e custos que o hook e o loop usavam fixos antes do perfil (`reference/loop/gates.md` §1 e §3.2):
mesmos scripts `npm run … -- <projeto>`, mesmos 2/3/4/5 GB, mesmos padrões do hook (`nx test|lint|build|affected`,
`npm run test|lint|build|affected*`, `jest`). Os custos dos outros três são estimativas até a primeira medição
(`measuredAt` vazio); `/hades stack add` (abaixo) mede e grava.

**Medições:** nenhuma ainda. No piloto de projeto trunk com várias stacks (pnpm + `rust-server` + `src-tauri`) a tentativa com `cargo check`/`cargo test --offline`
falhou antes de compilar (`no matching package named argon2`: o cache do cargo da máquina não cobre o `Cargo.lock` do
projeto), `clippy` não está instalado no toolchain e `pnpm` não está no PATH; medir exige rede e instalar dependências,
então `pnpm-next`, `rust-cargo` e `tauri` seguem com a estimativa. Ao medir, avise o dono antes (é uma execução real).

## O que o hook e a fila leem

- **Hook** (`hades guard`): o comando cru de gate (test, lint, build) que ele barra vem de `guard.patterns` das stacks
  do projeto ativo (`hades project gate_patterns`). O mesmo comando dentro de `gate-lock.sh run …` passa. Um repo cargo
  não barra `npx nx test`, um repo nx não barra `cargo build`; sem perfil valem os padrões de todas.
- **Fila** (`gate-lock.sh`): `run --step <stack>:<etapa> [--label L] -- <cmd…>` toma `kind`, custo e `parallel` da etapa.
  Ordem do custo: `--cost-gb` explícito > pico medido (`HADES_GATE_COST_MEASURED=1`) > `costGb` da etapa > padrão do
  kind. `run <kind> …` sem `--step` continua igual a antes. Etapa inexistente sai com 2.
- **Pico medido**: quando o gate roda no scope systemd (`MemoryMax`), a fila amostra o `memory.peak` do scope e grava
  `peak=NNNMB` e `step=` no `done` do journal. `gate-lock.sh peak <label>` imprime o da última execução com o label.
  Sem `systemd-run --user` não há teto nem medição (a fila avisa).
  No macOS o pico vem do vigia de RSS da árvore (soma do `ps`, `reference/loop/gates.md`), com a mesma gravação; o RSS
  somado é um pouco maior que o `memory.peak` do cgroup (conta páginas compartilhadas duas vezes), então o custo medido
  no macOS tende a sobrar, nunca a faltar.
- **Repo sem `origin` (ou fora de git)**: a fila e o journal são do work `_maquina` (`~/.claude/hades/work/_maquina/`),
  para que o comando barrado pelo hook tenha sempre caminho pela fila.

## A fila: configurações (Configurações → Fila de gates)

Chaves em `kit/config.tsv` (descritas em `reference/config.md`); os padrões são o comportamento de antes (8 GB, um pesado
por vez, FIFO). O `gate-lock.sh` lê o `config.sh` da instalação a cada chamada; variável exportada vence.

| Chave | Efeito |
|---|---|
| `HADES_GATE_BUDGET_GB` · `_RESERVE_GB` · `_HEADROOM_GB` · `_PSI_MAX` | orçamento, reserva de MemAvailable, folga do teto do scope e pressão máxima |
| `HADES_GATE_HEAVY_MAX` | pesados ao mesmo tempo (test, test:integration, gate) |
| `HADES_GATE_PAR_LINT` · `_PAR_BUILD` | teto de lints/builds juntos (0 = só o orçamento); o `parallel` da etapa limita a etapa |
| `HADES_GATE_COST_MEASURED` | custo = maior pico das 5 últimas execuções da etapa, em GB inteiros para cima |
| `HADES_GATE_PRIORITY` · `--priority N` | maior passa à frente na fila; empate por chegada |
| `HADES_GATE_WINDOW` | `HH:MM-HH:MM`; fora dela o gate pesado espera sem travar quem está atrás |
| `HADES_GATE_PROJECT_BUDGET_GB` | teto por projeto, abaixo do orçamento da máquina |
| `HADES_GATE_SCOPE` | `projeto` (uma fila por repo, onde o painel lê) ou `maquina` (todos na mesma fila) |

`scope=maquina` muda onde ficam os tickets (`work/_maquina/locks`); a página **Fila de gates** lê as duas filas e marca a da máquina com o selo "Máquina" (`reference/panel.md` §Fila de gates).

## `/hades stack add`

Cria um pacote para um repo que nenhuma stack instalada cobre. O agente conduz; `hades stack-add` faz o trabalho
mecânico. Nada é gravado sem o ok do dono.

1. **Detectar.** `hades project detect <repo>` — se já casa uma stack, pare e mostre-a (ajuste o pacote em vez de criar).
2. **Propor.** `hades stack-add propose <repo> [--name N]` lê `package.json` (scripts `typecheck`/`lint`/`build`/
   `test`/`test:integration`, gerenciador pelo lockfile), `Cargo.toml`, `go.mod`, `pyproject.toml` e os `run:` dos
   workflows do GitHub; escreve o rascunho em `~/.claude/hades/stacks-draft/<n>/stack.json` e imprime o pacote, a
   validação e o que o CI roda (`ci.match` = linhas do CI que coincidem com as etapas). Custos saem estimados.
   Confira etapas e comandos contra o CI; edite o rascunho se divergirem. Sem manifest conhecido sai com 3: escreva à mão.
3. **Medir pela fila.** Para cada etapa que o dono quiser medir: `hades stack-add measure <rascunho-dir> <repo> <etapa>
   [--project P]`. Roda a etapa com `gate-lock.sh run --step <n>:<etapa>` (entra na fila, sob teto), lê o pico e grava
   `costGb` (GB inteiros, mínimo 1) e `measuredAt` no rascunho. Avise o dono antes: é uma execução real (minutos, GBs).
   Falha da etapa não grava custo.
4. **Perguntar.** `AskUserQuestion` com o pacote final (nome, detecção, etapas, custos medidos, `guard`); opções:
   gravar, ajustar, descartar.
5. **Gravar.** Só com o ok: `hades stack-add save <rascunho-dir> --confirmed` valida e copia para a pasta de stacks do dono
   (recusa sobrescrever sem `--force`). Depois, o dono lista a stack em `stacks` do perfil do projeto, se houver um.

Prova (repo descartável): `~/.claude/hades/skill-dev/_data/stacks-fila/` — `propose` num repo npm, `measure` da etapa
`lint` (pico de ~329 MB medido pela fila, `costGb: 1`), `save` sem `--confirmed` recusado e com ele gravado.
