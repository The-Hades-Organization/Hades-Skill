# Notificações (desktop e celular)

O Hades avisa no desktop (`notify-send`) e no celular (ntfy) quando algo precisa do dono. Tudo em Configurações →
Notificações (`HADES_NOTIFY*`, `reference/config.md`). Nomes de unit, slice, projeto compose e túnel: os da instância original (`reference/projects.md` §Várias instâncias).

## Peças

| Peça | O que é |
|---|---|
| `kit/notify.sh` | CLI: `send <evento> <info\|warn\|error> <texto> [--obj NOME] [--state S]`, `test`, `apply`, `topic [rotate]`, `status` |
| `hades notify` | a CLI (o painel chama este caminho; `kit/notify.sh` é o shim); a lógica está em `src/commands/notify.ts`, `src/lib/notify.ts` (envio, dedupe, histórico) e `src/lib/notify-watch.ts` (o vigia) |
| unit `hds-notify` (no macOS, o serviço `com.hades.hds.notify` do launchd, `reference/adr/0001-gerenciador-de-servico.md`) | vigia persistente, fora do slice (liga com `HADES_NOTIFY=1`; o painel aplica ao salvar, na linha de comando rode `hades notify apply`). Sobe com o login; com a máquina, se o linger estiver ligado (Painel → início automático = `boot`) |
| `$D/ntfy.topic` | tópico secreto do ntfy (600). Nunca no `config.env` nem no export de configurações |
| `$D/notify/` | `history.jsonl` (50 últimas), `dedupe.json`, `heartbeat.json`, `agents/` (estado do `hades watch` do vigia) |

**Lock.** `dedupe.json` e `history.jsonl` mudam sob o `flock` de `$D/notify/.lock`, que nunca fica preso durante a rede:
o `notify` reserva o dedupe sob o lock, solta, envia e volta ao lock só para gravar o histórico. Seções do mesmo
processo entram em fila antes do `flock`, e a espera pelo de outro processo usa `LOCK_NB` com nova tentativa (nunca o
`flock` bloqueante, que parava o laço de eventos do vigia contra o próprio lock). Esperar mais que
`HADES_NOTIFY_LOCK_WAIT_S` (15 s) descarta o aviso (`lock do notify ocupado`) e o `forget` deixa a marca para o próximo
ciclo.

## Canais

- **Desktop:** `notify-send` com o ícone da marca e urgência pela severidade (info=low, warn=normal, error=critical). No macOS, `osascript` (`display notification`), com título e texto passados por argv ao AppleScript, nunca montados na string do script; o macOS não tem urgência, então a severidade não muda a notificação.
  Numa unit o vigia acha o barramento em `/run/user/<uid>/bus`. Sem sessão gráfica (boot sem login) falha calada e o
  ntfy segue.
- **Celular:** `HADES_NOTIFY_NTFY=1`. Servidor em `HADES_NOTIFY_NTFY_URL` (padrão `https://ntfy.sh`). Instale o app
  ntfy (Android/iOS) e assine o endereço `<servidor>/<tópico>` mostrado só no painel local (Configurações →
  Notificações, com QR se o `qrencode` estiver instalado). O tópico nasce aleatório na primeira ativação; "Trocar
  tópico" gera outro e o antigo para de receber. Quem souber o tópico lê as mensagens: não o compartilhe.
  Cabeçalhos: `Title`, `Priority` (info 2, warn 3, error 4) e `Tags`.
- A mensagem leva evento, nome (serviço, PR, agente) e hora. URL, e-mail, token longo e o caminho da casa são
  trocados por `[url]`, `[email]`, `[…]`, `~`. Trecho de log nunca vai.

## Eventos

Cada um tem `HADES_NOTIFY_EV_<X>` = `off | desktop | phone | both` (o `CI` aceita também `pr`, o padrão: segue o canal do review).
O que a tela desliga é exatamente o evento da tabela: falha de teste, build e gate saem todas como `gate`; CI vermelho sai
como `ci` e review novo como `pr`. Quem já tinha `HADES_NOTIFY_EV_PR=off` continua sem aviso de CI (o `ci` padrão segue o `pr`).
`test` é só a notificação do botão de testar o envio: ignora os interruptores e não aparece entre os tipos desligáveis.
Todo emissor usa um evento desta tabela (um teste confere o código); evento fora dela valeria sempre `both`.
Variável `HADES_NOTIFY_EV_*` exportada no ambiente do painel com valor diferente do `config.env` vence a configuração: a tela
marca o tipo como fixo (`pinnedByEnv` no `notify status --json`). A unit do vigia não herda variáveis (lista fixa de ambiente)
e o `watch` relê o `config.env` a cada ciclo.

| Evento | Quando | Fonte |
|---|---|---|
| `gate` ("Gate, build ou teste falhou") | `done` com `rc≠0` (gate, build, test) no `gate-journal.tsv`, ou espera na fila ≥ `HADES_NOTIFY_GATE_WAIT_MIN`, ou gate rodando além do estouro (`HADES_GATE_OVERRUN_MIN`, `HADES_GATE_OVERRUN_FACTOR`) | `hades gate-lock` |
| `restart` | unit `failed`, ou NRestarts subiu ≥ `HADES_NOTIFY_RESTARTS` em 10 min | `systemctl --user show` |
| `health` | `/health/ready` ≠ 200 em 2 checagens, serviço habilitado e ativo (Hades pausado não avisa) | HTTP local |
| `pr` | review novo (ou comentário a tratar) nas minhas PRs | `hades pr-loop-state --json` |
| `ci` | CI vermelho nas minhas PRs | `hades pr-loop-state --json` |
| `agent` | `STALLED`, `QUESTION`, `DONE`, `BUDGET`, `CTX-OVER`, `DISMISSED` (informativo, como o `DONE`), `DISMISS-READY`, `DISMISS-HELD` | `hades watch` com `HADES_WATCH_STATE` próprio |
| `snapshot` | snapshot pre-update falhou | `update.sh` chama `notify.sh send` |
| `doctor` | item em erro do `doctor.sh --quick --json` | doctor |
| `chat` | primeira mensagem **remota** de uma sessão da página Claude (hora e "sessão remota", nunca o texto). Só avisa com `HADES_NOTIFY=1` | o servidor do painel (`src/panel/`) chama `hades notify send` |
| `herdr` | escrita na página Herdr **pelo acesso remoto** (prompt, texto, tecla, renomear, parar/apagar sessão): hora, ação e alvo, nunca o texto; um aviso por ação e alvo a cada 60 s. Só avisa com `HADES_NOTIFY=1` | o servidor do painel (`src/panel/`) chama `hades notify send` |

## Dedupe, silêncio e custo

- Dedupe por evento + objeto: repete só se o estado mudou ou passou `HADES_NOTIFY_DEDUPE_MIN`. Problema que some zera a
  marca: o próximo aviso sai na hora.
- `HADES_NOTIFY_QUIET=22:00-07:00`: o celular não recebe; o desktop sempre mostra. `notify.sh test` ignora silêncio e
  switches (respeita só os canais ligados).
- Intervalos: `HADES_NOTIFY_EVERY` (locais, 30 s), `_PRS_EVERY` (GitHub, 300 s), `_AGENTS_EVERY` (120 s; o passo do `hades watch` que o vigia dispara, não o intervalo do vigia), `_DOCTOR_EVERY`.
  Evento `off` não gasta a checagem dele. O vigia relê o `config.env` a cada ciclo.

## Armadilhas

- Teste sem tráfego externo: `HADES_NOTIFY_NTFY_URL=http://127.0.0.1:<porta>` com um servidor HTTP falso.
- O `hades watch` do vigia usa estado próprio: sem isso ele consumiria os eventos do orquestrador.
- Na primeira leitura dos agentes, 30 s de eventos são descartados (o que já existia não é novidade).
- Exceções do ntfy podem carregar a URL com o tópico: o histórico guarda só o tipo do erro.
