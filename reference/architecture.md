# Arquitetura do Hades

Onde cada parte vive (núcleo da máquina × ambiente do projeto), as decisões de desenho com as medidas que as sustentam e o resumo do macOS.

## Onde vive cada parte

- **Núcleo da máquina** (`kit/` da skill): `install.sh`, Configurações (`config.*`), `doctor.sh`, onboarding, painel,
  notificações, túnel, fila de gates, subida automática, rotação de logs, `skill-release.sh`.
- **Ambiente do projeto** (`env/` do pacote do projeto, `env.pack` do perfil; `reference/projects.md`): compose, nginx,
  gateway, dados, processos de apoio, overlay web, serviços (`services.tsv`, `svc.sh`…), `run-hades.sh`, `update.sh`, `STATUS.template.md`. Texto específico em `env/reference/`
  (`ref env-<nome>`).
- O `install.sh` resolve o projeto do worktree, copia o `kit/` para o `$D` e **sobrepõe o `env/`** com o mesmo layout
  (`post-install.sh`, `assets/` e `reference/` ficam no pacote). Depois disso `$D`, `run-hades` e
  `~/.claude/hades/instance` são os de sempre: nenhum script instalado sabe de onde veio. Sem `env.pack`, só a máquina.
- Vários projetos na mesma máquina: uma instância por projeto (`$D`, worktree, painel, units, slice e projeto compose
  próprios), separadas pelo `HADES_ID` do `env.sh` (`reference/projects.md` §Várias instâncias). Os nomes da tabela de §Decisões são os da instância original.

## Decisões (medidas em 2026-09-28, máquina de 15 GB / 12 CPUs compartilhada)

| Componente | Modo | Por quê |
|---|---|---|
| Infra | docker, projeto `hades`, `mem_limit` em tudo | isolamento de nomes/volumes/portas; o compose do repo usa `container_name` fixo e já colidiu entre sessões |
| Serviços | **build do repo + `node dist/.../main.js`**, units systemd `hds-<serviço>` na slice `hades` | o modo dev (`nx serve`) custa ~400–600 MB de webpack watch **por serviço**; `node dist` fica em ~120–290 MB. Atualização é por head de PR, não por tecla |
| Front | build de produção estático + nginx (container `web`, ~5 MB) | dev server ficaria em ~1,5–2 GB permanentes; o build (5 GB transitórios) só roda quando o front/libs mudam |
| Builds | fila do gate-lock (`build`, custo 4 GB serviços / 5 GB front), serviços **um por vez** | não disputam memória com gates de outros agentes; 2 webpacks em paralelo passaram de 3,5 GB (medido: 12 GB na máquina) |
| Teto | slice `MemoryMax=3260M` (`MemoryHigh=3000M`; padrões, ajustáveis em Configurações — `reference/config.md`) + `mem_limit` por container | estouro derruba o Hades, não a máquina. 2560M (design de ~9 serviços) fazia OOM-kill com todos os serviços + processos de apoio; ajustável via `HADES_SLICE_MAX` |

**Regime medido:** processos node + processos de apoio + túnel ≈ **1,9 GB**; containers ≈ **0,6 GB**; total ≈ **2,5 GB**.
Um gate de 5 GB exige 7 GB livres, então **com o Hades no ar os gates pesados esperam** — daí a regra de ceder
(pausa total), não a de derrubar só serviços acessórios (libera pouco).

A reserva do Hades é **informativa** (`$LOCKS/hades.reservation`): um ticket permanente no gate-lock contaria
em dobro (o `MemAvailable` já enxerga o Hades) e travaria todo gate de 5 GB.

Portas, como as peças se falam e a lista de serviços do projeto: `ref env-architecture`.

## macOS (launchd)

O gerenciador de serviço é uma camada (`src/lib/service-manager*.ts`): systemd no Linux, launchd no macOS, escolha por
plataforma ou por `HADES_SERVICE_MANAGER=systemd|launchd`. Rótulo `com.hades.<HU>.<sufixo>`; plist em
`~/Library/LaunchAgents` com início automático e em `~/.claude/hades/launchd` sem ele. Sem linger (`linger.sh state` →
`n/a`; o modo `boot` sobe no login), sem slice (o teto é por processo) e o painel lê sysctl e ps no lugar de `/proc`
(a idade dos processos usa o `kern.boottime` real; o `ps` sai em duas consultas, para `comm` com espaço não se
misturar com `command`). `launchctl list` que falha não recolhe jobs nem chats naquele tick; `bootstrap` que sai 5
logo depois do `bootout` é repetido por ~1,5 s; plist sai sempre `0644`.
Estado de cada fase e contrato: `reference/adr/0001-gerenciador-de-servico.md`, `0002-processo-efemero.md`,
`0003-teto-de-memoria.md`.
