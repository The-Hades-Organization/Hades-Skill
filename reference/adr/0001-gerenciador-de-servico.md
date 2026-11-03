# ADR 0001 — Gerenciador de serviço (systemd e launchd)

## Contexto
O Hades pedia o systemd direto: texto de unit, `systemctl --user` e `systemd-run` espalhados no painel, no vigia de
notificação, no doctor e no install. O macOS não tem systemd; o equivalente é o launchd (`launchctl`). Sem uma
fronteira, cada ponto teria dois ramos e o Linux correria risco a cada mudança.

## Decisão
Uma camada TS em `src/lib/service-manager*.ts` que o resto do código chama no lugar do systemd:

- `service-manager.ts`: a interface `ServiceManager`, os tipos (`ServiceSpec`, `TransientSpec`, `UnitInfo`) e a escolha
  (`managerKind`, `serviceManager`). `HADES_SERVICE_MANAGER=systemd|launchd` força; sem ela, launchd no macOS e systemd
  no resto. Valor inválido é erro de uso.
- `service-manager-systemd.ts`: o que existia, extraído byte a byte (texto da unit, argv do `systemctl`/`systemd-run`).
  O golden `loop/test/golden/systemd-contrato.txt` foi gravado antes e não mudou.
- `service-manager-launchd.ts` e `launchd-plist.ts`: plist, rótulo e parsers de `launchctl print` e `launchctl list`.
- `service-manager-ctl.ts`: o spawn comum, com teto de 30 s.

Convenções do launchd:

- Identificador de serviço = nome da unit do systemd (`<HU>-<sufixo>`); rótulo = `com.hades.<HU>.<sufixo>` (o HU não
  tem `-`: o primeiro `-` separa o sufixo).
- Domínio `gui/<uid>`; sem sessão gráfica (ssh), `user/<uid>`.
- Com início automático (`enable`) o plist mora em `~/Library/LaunchAgents`; sem ele, em `~/.claude/hades/launchd`.
  `enable` e `disable` movem o arquivo. `RunAtLoad` é sempre verdadeiro: o início automático é a presença do plist.
- `Restart=on-failure` vira `KeepAlive` com `SuccessfulExit=false`; `RestartSec` vira `ThrottleInterval`.
- O launchd não tem `daemon-reload` nem estado `failed` preso: `restart` é `bootout` + `bootstrap`, e `resetFailed`
  descarrega o serviço que caiu com código diferente de zero.
- `start` de serviço carregado e parado, depois de um `write` que mudou o plist, faz `bootout` + `bootstrap` (o
  `daemon-reload` do systemd); com o plist igual, é `kickstart`.
- `bootout` de serviço que não está carregado sai 3 (ESRCH) ou 113 ("Could not find specified service"): os dois são
  "não carregado", e `stop` e `restart` os tratam como sucesso (o `restart` de serviço não carregado sobe).
- `bootstrap` logo depois de `bootout` pode sair 5 (Input/output error) enquanto o job desmonta: a camada repete só
  esse código, 4 tentativas com 500 ms entre elas (~1,5 s no total). Vale para `restart`, `armTimer` e `hades svc run`.
- Todo plist gravado (serviço, job transitório, timer) sai com modo `0644`, qualquer que seja o umask: o launchd recusa
  plist que grupo ou outros possam escrever.
- XML 1.0: `plistText` recusa (erro explícito) caractere de controle que XML 1.0 não tem; `\t` e `\n` seguem, `\r` vira
  `&#13;`.
- `parseLaunchctlPrint` lê o número no início de `last exit code = 78: EX_CONFIG`.
- `activeState` fala o vocabulário do `systemctl is-active` (`active|activating|failed|inactive`) para quem consome
  não ramificar por gerenciador.

### API da camada
| Membro | Contrato |
|---|---|
| `kind`, `requires` | gerenciador e id da ferramenta no registro de dependências (`systemctl`, `launchctl`) |
| `definitionPath(unit)` | onde a definição está (ou ficaria) |
| `write(spec)` | grava se mudou; `true` = mudou, quem está no ar precisa reiniciar |
| `start`/`stop`/`restart` | código de saída; `stop` de unit inexistente é 0 |
| `enable`/`disable(unit, now?)` | início automático no login |
| `resetFailed`, `isActive`, `activeState`, `isEnabled`, `enabledState` | consulta e limpeza de estado |
| `inspect(units)` | estado e reinícios de várias units numa chamada |
| `listActive(prefix)` | units em execução com o prefixo; no launchd, `launchctl list` que falha (erro, timeout) lança `ListFailedError`: lista indisponível não é lista vazia |
| `readLog(unit, lines)` | últimas linhas do log (journal no systemd, o arquivo do plist no launchd) |
| `transientArgv(spec)`, `stopTransient(unit)` | processo transitório; ADR 0002 |

### Timer e serviço persistente (implementados)
- **Timer por intervalo** (limpeza): `writeTimer(spec: TimerSpec)` grava o par service/timer no systemd e um plist com
  `StartInterval` no launchd (`parseEverySeconds` converte `HADES_CLEAN_EVERY`); `armTimer(unit, rearm)`,
  `disarmTimer`, `timerEnabled`, `timerEnabledState` e `timerLastTrigger` completam o ciclo. O launchd não guarda a
  última execução: `timerLastTrigger` volta vazio e o chamador lê a marca `logs/logrotate.last`, gravada pelo job.
- **Serviço persistente com KeepAlive** (túnel): `runKeepAlive(spec: KeepAliveSpec)` sobe o serviço que reinicia em
  falha (`systemd-run` com `Restart=on-failure` / plist com `KeepAlive` e `ThrottleInterval`); a URL sai de `readLog`.
- **Recolher transitórios terminados** (`collectFinished(prefix)`, fase 2 do porte macOS): bootout e remoção do plist dos jobs que já
  saíram, como o `--collect` do systemd faz sozinho. Quem coleta (jobs e chat do painel, `clean.sh`) não recolhe nada
  no tick em que a listagem falhou; plist apagado por outro coletor entre o `readdir` e o `stat` conta como recolhido.
- **Intervalo do timer**: `parseEverySeconds` lê o que o `systemd.time` lê num intervalo (número sem unidade = segundos,
  `ms`, `M`/`month`, `y`/`year`) e recusa 0, negativo e acima do teto do `StartInterval`; com `HADES_CLEAN_TIMER=off` o
  `apply` desarma o timer mesmo com o intervalo ilegível.
- **Restart em laço** (`inspect().restarts`): já existe; no launchd é `runs - 1`.

## Alternativas
- **Ramos `if (macOS)` em cada chamador**: mais barato hoje, mas multiplica o risco de regressão no Linux e a cada fase
  nova cada chamador ganha dois caminhos.
- **Um daemon próprio supervisionando os processos nos dois sistemas**: tira a dependência do gerenciador, mas perde o
  início automático no login, o `Restart=` e o log nativos, e vira um serviço a mais para cair.
- **Homebrew services**: exige Homebrew; a regra é só ferramenta nativa do macOS.

## Consequências
- O Linux não muda (texto de unit, chamadas, saídas e códigos de saída idênticos, provado pelo golden).
- A prova do launchd no Linux é um stub (`loop/test/stubs/launchctl`); o que só um Mac prova ficou sem medida.
- Quem acrescenta um verbo à interface implementa os dois lados e o teste dos dois.
