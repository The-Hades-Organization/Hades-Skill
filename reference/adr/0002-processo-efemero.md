# ADR 0002 — Processo efêmero (jobs e chat do painel)

## Contexto
O painel lança jobs (`hds-pjob-*`) e sessões de chat (`hds-chat-*`) com `systemd-run --user --collect`: a unit existe
enquanto o processo roda, a saída vai para um arquivo, o systemd recolhe tudo quando acaba e `systemctl stop` para. O
launchd não tem equivalente de unit transitória: só serviço carregado de um plist.

## Decisão
No launchd o job transitório é um plist por job, em `~/.claude/hades/launchd` (nunca em `~/Library/LaunchAgents`: não
deve voltar no próximo login). A camada expõe:

- `transientArgv(spec)`: grava o plist do job (`StandardOutPath` e `StandardErrorPath` no arquivo de saída,
  `StandardInPath` quando há stdin, sem `KeepAlive`) e devolve o argv do `launchctl bootstrap` que o chamador executa,
  assíncrono, como faz com o `systemd-run`. No systemd devolve o argv do `systemd-run`, igual a hoje.
- `stopTransient(unit)`: `bootout` e remoção do plist, porque o launchd não recolhe sozinho.
- `listActive(prefix)`: `launchctl list` filtrado pelo rótulo `com.hades.<HU>.pjob-`.

Jobs que terminaram sozinhos deixam o plist para trás até alguém recolher: `collectFinished(prefix, active)` (fase 2 do porte macOS) faz
`bootout` e apaga os plists com o prefixo cujo processo não está em `active`, ignorando os de menos de 10 s (entre a
gravação e o `bootstrap`). O painel o chama a cada listagem de jobs e de chat, e o `clean.sh run` também. No systemd não
faz nada: o `--collect` já recolhe.

A fase 2 do porte macOS acrescentou à interface `listActiveAsync`, `stopTransientAsync`, `unitEnvironment` e `collectFinished`: o
painel não pode travar o laço de eventos com `spawnSync` a cada 3 s, então as versões assíncronas usam `ctlAsync`
(teto de 8 s, o mesmo que o painel já tinha). O amostrador do launchd devolve as units na forma do `systemctl show` (o
plugin consome essas chaves), com memória e CPU da árvore de processos do `ps`.

## Alternativas
- **`launchctl submit`**: serviço sem plist, mas sem stdin nem `WorkingDirectory` garantidos e obsoleto no macOS atual.
- **Processo filho do painel (`spawn` detached)**: não depende do launchd, mas o job morre junto com o painel e o log
  de quem reinicia o painel se perde; o chat precisa sobreviver ao restart do painel.
- **`nohup` em arquivo de pid**: refaz à mão o que o gerenciador faz (estado, listagem, parada) e quebra o `active()`.

## Consequências
- Há um arquivo por job em `~/.claude/hades/launchd`: a limpeza dos terminados é parte do contrato da fase 2 do porte macOS.
- `stop` de job já terminado é 0 (bootout devolve `ESRCH`, tratado como ok), igual ao systemd.
- O argv do systemd continua protegido pelo golden; o do launchd, pelo `launchd.test.ts`.
