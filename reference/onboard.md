# Onboarding de recursos (`onboard.sh`, página Onboarding)

Depois de instalar, o dono escolhe quais recursos quer preparar e recebe, para cada um, o estado de cada passo
(feito · pendente · não se aplica) e as instruções: os passos que são dele, com o comando pronto para copiar. A fonte de
verdade é uma só (`kit/onboard.tsv` + as checagens do `onboard.sh`); o comando, a página do painel e o doctor leem dela.

## Primeira etapa

Quem acabou de instalar, ou ainda não completou o onboarding, é levado a ele antes do resto, no painel e na CLI. Nada
muda na máquina sem o ok do dono: o `run` pede confirmação e a tela diz isso.

**Completo** tem uma definição só, `onboardProgress()` em `src/lib/onboard.ts`, usada pelo painel, pelo `/hades` e pelo doctor:
toda feature do catálogo escolhida ou pulada, **e** nenhum passo pendente nas escolhidas, **e** o tour do painel visto ou
pulado. Passo "não verificado" (sonda `--quick`) não conta como pendente.

| Onde | O que acontece enquanto não está completo |
|---|---|
| painel | abrir na visão geral leva à página Onboarding (uma vez por sessão do navegador) e oferece o tour; o topo da página mostra "Falta: …" e o botão *Fazer o tour*; vale igual pelo acesso remoto |
| `/hades` sem modo | uma linha com o que falta e `/hades env onboard`, sem bloquear o que foi pedido |
| fim do `install.sh` | a mesma linha, na primeira instalação e nas reinstalações |
| doctor | aviso `Onboarding: N pendente(s) em <recursos>` (passo pendente nos recursos escolhidos) ou `Onboarding: falta …` (nada escolhido, ou tour por fazer); nunca erro. É a fonte do que o doctor mostra: `doctor.md` §Onboarding aponta para cá |

O **tour** (`kit/panel/ui/tour.tsx`, porte do `tonghohin/tour`, sem dependência nova) tem três paradas: serviços no ar, o loop
até a PR e o que falta no onboarding. Esc, ✕ e *Pular* gravam `skipped`; *Concluir* grava `seen`; ←/→ navegam e o foco fica
preso no popover. `onboard.sh reset` esquece a escolha e o tour. Pela CLI: `$D/onboard.sh tour seen|skip`.

```bash
$D/onboard.sh status [--json|--brief|--doctor|--line] [--quick]   # estado; --line = só a linha do que falta (vazia se completo)
$D/onboard.sh tour seen|skip        # marca o tour do painel como visto ou pulado
$D/onboard.sh show <feature>        # instruções e comandos: remoto · notificacoes · automatico · contas
$D/onboard.sh select <feature…>     # escolher para preparar   $D/onboard.sh skip <feature…>   # não preparar
$D/onboard.sh done|undone <passo>   # marca um passo manual (instalar o PWA, assinar o ntfy)
$D/onboard.sh run <passo>           # roda o comando de um passo da Hades (peça o ok do dono antes)
$D/onboard.sh pick                  # escolhe os recursos por menu (precisa de terminal)
$D/onboard.sh reset                 # esquece a escolha
```

## Onde roda

| Onde | Como |
|---|---|
| `/hades env onboard` (Claude Code) | a skill pergunta com `AskUserQuestion` (multiSelect) quais das quatro features preparar, grava com `select`/`skip`, roda com o ok do dono os passos da Hades (`run`) e entrega os passos do dono com os comandos, sugerindo o prefixo `! ` nos interativos (`interativo=1`: login do devtunnel, sudo do firewall, `gh auth login`) |
| fim do `install.sh` | só na **primeira instalação** (sem `env.sh` e sem `onboard.json`): imprime o resumo e aponta o comando e a página; com terminal oferece o `pick` |
| painel → **Onboarding** | um card por feature com estado, comando com botão de copiar, link para a página onde o passo se faz, *Executar (Hades)* (com confirmação, só no painel local), *Marcar como feito* nos manuais, *Escolher* / *Pular* e *Verificar de novo*; a 390 px vira uma coluna |
| `doctor.sh` | as linhas da tabela de §Primeira etapa, como **aviso** (nunca erro); recurso não escolhido não conta; fora do `--quick` |

API do painel: `GET /api/onboard` (estado completo, medido na hora; `?quick=1` usa a sonda rápida, a que o painel faz ao abrir) e
`POST /api/onboard` com `{op: select|skip, features:[…]}`, `{op: done|undone, step}` (só passo manual), `{op: tour, value:
seen|skip}` ou `{op: run, step}` (só passo da Hades; recusado no acesso remoto). Valores vêm do catálogo. O JSON ganhou
`complete`, `tour` e `progress` (aditivo). Pelo acesso remoto valem `select`, `skip`, `done`, `undone` e `tour`.

## Segurança

O onboarding **nunca executa** passo do dono: túnel público, acesso anônimo, login do devtunnel, sudo e tokens são dele;
`run` recusa passo com `quem=dono`. Nenhum segredo entra no catálogo, no `onboard.json`, no log ou na saída do `status`
(token, tópico do ntfy, chave de acesso, URL de túnel): o estado diz só feito/pendente. O tópico do ntfy continua só na
página Notificações do painel local.

## O catálogo (`kit/onboard.tsv`)

Linhas `@<feature>` definem as features (rótulo e descrição; a ordem é a da tela). Cada passo é uma linha de 10 colunas
separadas por TAB: `feature · passo · nome · quem · check · interativo · comando · doc · página · detalhe`.

| Coluna | Valores |
|---|---|
| `quem` | `dono` (só mostra o comando) · `hades` (o `run` executa o comando, com ok do dono) |
| `check` | nome da função `check_<nome>` do `onboard.sh` (hífen vira `_`), que imprime `feito`, `pendente` ou `na [nota]`; `manual` = o dono marca com `done` |
| `interativo` | `1` pede terminal ou senha (a skill sugere `! `) |
| `comando` | `{D}` vira a pasta de dados, `{FW}` o comando de firewall desta máquina (`fw_cmd`) |
| `página` | id da página do painel: `remote`, `notify`, `config` (do núcleo, em `CORE_NAV`) ou `services`, `support` (páginas de plugin) |

Passos de hoje:

| Feature | Passos (quem) |
|---|---|
| Acesso remoto | login do devtunnel (dono) · túnel do painel (dono) · chave de acesso (dono) · PWA no celular (dono, manual) · túnel do front (dono) |
| Notificações | desktop (Hades) · ntfy ligado (Hades) · assinar o tópico no celular (dono, manual) · teste de envio (Hades, manual: feito quando o `run` sai com 0) |
| Início automático | painel no login/boot (Hades) · linger (Hades, só no modo boot) · firewall docker → host (dono, sudo). No macOS (launchd) o linger é `na` (o painel sobe no login) e o firewall não sugere ufw nem firewalld |
| Contas e loop | conta gh / `HADES_GH_USER` (dono) · ClickUp (dono) · herdr (dono) · serviços, dados e processos de apoio do ambiente do projeto (Hades) |

### Checagens, sem duplicar o doctor

As checagens de estado que mais de um script usa moram em `kit/lib-checks.sh` (`chk_gh_token`, `chk_devtunnel_login`, `chk_linger`,
`chk_unit_enabled/active`, `fw_test`, `fw_cmd`); o `doctor.sh`, o `run-hades.sh` e o `onboard.sh` as chamam. Ao criar uma
checagem nova que o doctor também precise, ponha a função aqui.

## Acrescentar um passo (quando uma feature nova nascer)

1. Uma linha no `onboard.tsv` na feature certa (ou `@nova` + linhas, se for uma feature nova). Feature nova entra no
   `AskUserQuestion` do `/hades env onboard` (acrescente à lista da skill, máximo de 4 opções por pergunta: agrupe) e no `pick`.
2. A função `check_<check>` no `onboard.sh` (só leitura, rápida; consulta de rede respeita `QUICK`). Se o doctor também a
   usa, a função vai para o `lib-checks.sh`.
3. Passo da Hades: o `comando` tem de ser idempotente e não pedir senha. Passo do dono: `quem=dono`, e `interativo=1` se pedir terminal.
4. Documente o assunto em `reference/<assunto>.md` e aponte o `doc` do passo para ele. Chaves de `config.tsv` que o passo liga, em `reference/config.md`.
5. Sem segredo no texto. Rode `onboard.sh status` e a página.

## Estado (`$D/onboard.json`)

`{"selected": […], "skipped": […], "done": […], "tour": "seen"|"skipped"}` (features escolhidas, puladas, passos manuais marcados e o
tour; `tour` ausente = ainda não visto), 600, gravado por
rename. O `install.sh` nunca toca nele. Feature que não está em nenhuma lista é "não escolhida" (não conta no doctor).

## Armadilhas

- **Unit não herda o seu shell** (incidente de 25/10): os passos da Hades que mexem em unit (`panel.sh autostart`,
  `notify.sh apply`) rodam o script do kit, que carrega o `env.sh`; não escreva comando de passo que dependa de variável do seu terminal.
- **`status` sem `--quick` consulta o devtunnel e o docker** (até ~8 s no pior caso). O `install.sh` usa `--quick`: os dois passos
  aparecem "não verificado": mostrado, mas não contado como pendente. O doctor só inclui o onboarding fora do `--quick`.
- **`--quick` não conta "não verificado"**: a sonda rápida (painel ao abrir, `/hades`, install) não mede devtunnel nem docker;
  contar esses passos como pendência manteria o aviso ligado sem o dono ter nada a fazer.
- **Firewall só se mede com a infra no ar** (o teste é um container alcançando o host): sem ela o passo fica "não se aplica"
  com a nota, nunca "pendente" por falta de medida.
- **Passo manual** (PWA, assinar o ntfy) não tem como ser medido: fica pendente até o dono marcar.
