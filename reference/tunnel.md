# Túneis do Hades (Microsoft devtunnel): front, painel e widget

Três túneis, cada um com um público:

| Túnel | Quem acessa | Anônimo? | Onde está documentado |
|---|---|---|---|
| front (túnel público) | quem tem o link, sem conta | sim, com prazo | este arquivo (§Passos) |
| painel (acesso remoto) | só a conta dona | não | `reference/panel.md` §Acesso remoto |
| widget (Android) | o widget do celular, com o token do widget | sim, só `GET /api/widget` | este arquivo (§Túnel do widget) |

**Aviso:** o túnel do front é anônimo: qualquer pessoa com a URL abre o front do ambiente, até o prazo vencer. A
guarda `tunel-acesso` do Cerberus barra a publicação anônima (§Passos).

## Túnel do front

Expõe **só uma porta**, `HADES_TUNNEL_PORT` (Configurações → Túnel): a do front do ambiente do projeto, que o plugin
dá como padrão (`reference/config.md` §Chaves do plugin; a do ambiente instalado em `ref env-extensions` §Túnel).
Vazia (sem plugin, ou plugin sem front), o `tunnel.sh` recusa `create` e `start` e o painel não oferece o túnel do
front. Outros devs usam o Hades pelo navegador, sem shell na máquina.

O túnel se chama `hades` e a unit `hds-devtunnel`; numa instância com `HADES_ID` são `hades-<id>` (o devtunnel não aceita
`_`, que vira `-`) e `hds_<id>-devtunnel`, no slice `hades_<id>` (`reference/projects.md` §Várias instâncias).

### Por que não `code tunnel`

`code tunnel` só aceita a **mesma conta** que autenticou: compartilhar significaria entregar shell completo da
máquina (todos os clones, token do `gh`, credenciais do Claude, chaves SSH). Não usar para dar acesso a terceiros.

### Restrição de acesso

| Opção | Resultado em 28/09 |
|---|---|
| `--org <github-org>` | a conta do dono é **User**, não org, e não tinha orgs → "organization not found" |
| `--repo <owner>/<repo>` | o CLI 1.0.2094 falha com "Specify access control parameters" (exceção interna), nos dois formatos |
| `--tenant` (Entra) | exige login com conta Microsoft corporativa (`devtunnel user login -e -d`) |
| `--anonymous -e 1d` | **escolhido pelo dono**: qualquer um com o link; a barreira é o login do próprio sistema |

### Passos

```bash
$D/tunnel.sh install          # agente: baixa ~56 MB para ~/.local/bin (esperar o curl terminar: "Text file busy" = ainda baixando)
$D/tunnel.sh login-cmd        # imprime: ! devtunnel user login -g -d        → o DONO roda e confirma o código
$D/tunnel.sh create           # agente: túnel persistente hades (30 dias) + porta HADES_TUNNEL_PORT
$D/tunnel.sh publish-cmds     # imprime os 2 comandos do DONO:
#   ! devtunnel access create <id> -p <porta> --anonymous -e 1d
#   ! systemd-run --user --unit=hds-devtunnel --slice=hades devtunnel host <id>   (macOS: ! $D/tunnel.sh front-start)
$D/tunnel.sh url              # agente: grava tunnel.url e aplica no .env (as variáveis de URL e de CORS do ambiente do projeto)
```

**Cerberus (Porta) e `HADES_RUN_TUNNEL`:** o `publish-cmds` declara `acesso=anonimo` ao `cerberus_tunel` (guarda
`tunel-acesso`, `reference/cerberus/porta.md`). A guarda passa só com o host do túnel em
`HADES_CERBERUS_PORTA_TUNEL_HOSTS` ou com exceção do dono; com a lista vazia (o padrão) ela barra o front anônimo.
`HADES_RUN_TUNNEL=1` (também padrão) só diz que o `run-hades` deve levantar o túnel (Configurações → Subida): não
libera nada. Os dois convivem assim: o interruptor liga a intenção, a guarda decide o acesso. Para publicar de fato,
liste o host na chave da Porta ou aprove a exceção; para não tentar, desligue `HADES_RUN_TUNNEL` (ou `--no-tunnel`).

Depois do `url`, reiniciar os serviços cujo `.env` mudou. O ambiente do projeto diz quais e o que mais refazer: o
`tunnel-after.txt` é anexado à mensagem do `url`, e o `post-tunnel.sh` roda ao publicar o front pelo painel (ambos
opcionais, em `$D`, vindos do `env/` do pacote).

O **auto mode recusa ao agente** o `access create --anonymous` e o `host` ("External Ingress Tunnel") — correto:
são passos do dono. Não contornar. Renovar o acesso: o dono roda `access reset` e depois `access create` (sem o reset o prazo não muda). Derrubar:
`! systemctl --user stop hds-devtunnel` (macOS: `! $D/tunnel.sh front-stop`).

### No macOS (launchd)

Não há `systemd-run` nem journal: o `tunnel.sh` hospeda o túnel como serviço do launchd, pela camada de serviço
(`reference/adr/0001-gerenciador-de-servico.md`). O plist fica no diretório privado (sem início no login, como a unit
transitória), com `KeepAlive` só em saída com erro e `ThrottleInterval` 10 (o `RestartSec` do systemd). O log é
`$D/logs/<sufixo>.log` (`devtunnel.log`, `panel-tunnel.log`, `widget-tunnel.log`) e a URL sai dele, não do `journalctl`.
O `front-start` faz o que a linha `systemd-run` faz e, como ela, é passo do dono: o `publish-cmds` já passou pelo
Cerberus. O `install` baixa o build `osx-arm64` ou `osx-x64`. O `devtunnel` entra no PATH do plist por `PATH` do ambiente.

Os consoles do ambiente do projeto **não** passam pelo túnel. Se o dono quiser, criar uma rota no `infra/nginx.conf`
(lembrando que o túnel é anônimo).

### Túnel que parou de conectar

Dois modos de falha independentes (30/09) — conferir os dois com `devtunnel show <id>`:

| Sintoma | Causa | Conserto (dono) |
|---|---|---|
| `Host connections: 0` com `hds-devtunnel` `active`; no journal `Refreshed tunnel access token is not valid ... Unauthorized` depois de um `ConnectionLost` | o host perdeu a sessão e não reautentica sozinho (o login `devtunnel user show` segue válido) | `! systemctl --user stop hds-devtunnel` + o `systemd-run ... devtunnel host <id>` de novo |
| acesso anônimo vencido ou perto de vencer | o `--anonymous` tem prazo; **`access create` sobre uma entrada anônima existente não renova** (devolve o prazo antigo: 6,1 h e 3,9 h em 30/09) | `! devtunnel access reset <id> -p <porta>` e depois `! devtunnel access create <id> -p <porta> --anonymous -e 1d` → `Expiration: 24 hours` (link fechado por segundos entre os dois; sem reiniciar o host) |

A URL não muda em nenhum dos dois: nada de `.env`/restart de serviço.

### Token GitHub inválido (401 invalid_token)

O `devtunnel user show` lê só o perfil guardado e segue dizendo "Logged in as ..." com o token revogado ou expirado; a API
responde `401 invalid_token`. Por isso `create`, `panel-start` e `widget-create` conferem o login com uma chamada que exige
token válido (`devtunnel list`) e param com a mensagem "token GitHub do devtunnel inválido ou expirado", saída 1, sem criar
túnel. O dono refaz o login no terminal (`$D/tunnel.sh login-cmd` imprime o comando: `! devtunnel user login -g -d`) e o
agente repete o passo. O agente nunca faz o login.

### Túnel do widget (Android)

Terceiro túnel, só para o widget do celular ler `GET /api/widget` fora de casa (`reference/panel.md` §Widget Android).
`hades-widget` (`hades-widget-<id>` com `HADES_ID`), porta `HADES_WIDGET_PORT` (21221), unit `hds-widget-tunnel`. É o
**único túnel anônimo além do do front**, e expõe só o listener do widget, que responde nada além de `GET /api/widget`
com o token do widget (`Bearer`). O túnel do painel segue só com a conta dona.

```bash
$D/tunnel.sh widget-create        # agente: cria o túnel e a porta (acesso: só o dono até publicar)
$D/tunnel.sh widget-publish-cmds  # imprime o que o DONO roda (o Cerberus avalia antes: acesso=anonimo):
#   ! devtunnel access create <id> -p <porta> --anonymous -e 30d
#   ! systemd-run --user --unit=hds-widget-tunnel ... devtunnel host <id>
#   ! tunnel.sh widget-stamp      (grava a validade para o painel mostrar)
$D/tunnel.sh widget-url           # agente: lê a URL do journal da unit (no macOS, do log do serviço) → widget-tunnel.url (o painel mostra no card)
$D/tunnel.sh widget-status        # unit, URL e validade
```

- **Publicar e renovar são do dono.** O auto mode recusa ao agente o `access create --anonymous` e o `host`; não
  contornar. O agente só roda `widget-create`, `widget-url`, `widget-stamp` e `widget-status`.
- **Cerberus (Porta):** o `widget-publish-cmds`, `widget-renew-cmds` e `widget-start` declaram `acesso=anonimo` ao
  `cerberus_tunel` e passam só com exceção do dono (guarda `tunel-acesso`, `reference/cerberus.md`); o host
  `<id>-<porta>.<cluster>.devtunnels.ms` precisa estar em `HADES_CERBERUS_PORTA_TUNEL_HOSTS`. Não há isenção para o widget.
- **Renovar (a cada 30 d, `HADES_WIDGET_TUNNEL_TTL`):** `widget-renew-cmds` imprime o `access reset` + `access create` +
  `widget-stamp` para o dono (sem o reset o prazo não muda: §Passos e §Túnel que parou de conectar). A URL não muda. O painel mostra "Acesso vencido"
  depois do prazo.
- **Parar:** `tunnel.sh widget-stop` (ou `! systemctl --user stop hds-widget-tunnel`; no macOS só o `widget-stop`). Sem token do widget o listener
  responde `404 widget_off`: revogar o token fecha o widget mesmo com o túnel no ar.
- O widget usa `https://<host do túnel>/api/widget` e `Authorization: Bearer hdw_…`.
