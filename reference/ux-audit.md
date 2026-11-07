# Auditoria de usabilidade recorrente (painel e Argos)

Fluxo que se repete: um agente do papel `ux-audit` (`reference/loop/roles/ux-audit.md`) captura o painel de teste, passa a
crítica do **Impeccable** e grava cada achado como item de trabalho. A 5.20.0 fez a primeira rodada à mão (Argos); aqui ela
virou comando.

## Impeccable não vem na Hades
A Hades usa o instalado pelo dev em `~/.claude/skills/impeccable` (`$HOME`; `HADES_IMPECCABLE_DIR` troca a pasta, só para
teste). Sem ele, `hades ux-audit start` recusa (saída 69) com o jeito de instalar, e nada mais da Hades muda: o lembrete do
`skill-release` também fica calado. O cartão do papel só manda invocar a skill; não copia texto dela. Se um dia o cartão
passar a derivar texto do Impeccable, acrescente a linha em `quality/THIRD-PARTY.md` (atribuição, origem, commit do
upstream, texto modificado) e use a cópia do LICENSE em `quality/licenses/impeccable-LICENSE`.

## Itens de trabalho
`~/.claude/hades/work/_skill/ux-audit/<data>/` (raiz de `HADES_WORK_ROOT`), por rodada (`<data>` ou `<data>-2`…):
- `items/<chave>.json`: `key`, `page`, `rule`, `severity` (`bloqueante|alta|media|baixa`), `title`, `evidence` (capturas
  relativas à rodada e texto), `fix`, `round`, `status` (`open|issue|resolved`), `issue` e `regression` quando há.
- `capturas/`: as imagens citadas (o `add --evidence <arquivo>` copia para cá).
- `../last.json`: rodada e último commit de `kit/panel/ui` quando `done` fechou a última rodada.

**Chave estável** = `<página>--<regra>` (minúsculas, sem acento). Achado cuja chave já existe em qualquer rodada não se
repete (`add` diz "repetido", sai 0). Exceção: item `resolved` que volta entra de novo, marcado `regression`.

## Comandos
| Comando | O que faz |
|---|---|
| `hades ux-audit start` | confere o Impeccable, abre a rodada de hoje, imprime nome e pasta |
| `ux-audit add --round R --page P --rule X --severity S --title T [--fix F] [--evidence arq]…` | grava o achado |
| `ux-audit list [--round R] [--status open\|issue\|resolved\|all] [--json]` | itens por severidade (último estado de cada chave) |
| `ux-audit forward [--round R] [--issues [--repo dono/nome]]` | rascunho de issue de cada item aberto; **só `--issues` abre** (repo padrão `HADES_VERSION_CHECK_REPO`, conta do `gh` ativa: troque para a da org antes). Nunca automático |
| `ux-audit resolve <chave>` | marca resolvido |
| `ux-audit done --round R` | fecha a rodada para o lembrete |
| `ux-audit reminder` | imprime o lembrete, se houver |

## Recorrência
Chave `HADES_UX_AUDIT_REMINDER` (`release` padrão, `off`): o `skill-release check` imprime, depois do veredito, uma linha
quando o último commit de `kit/panel/ui` difere do gravado em `last.json` (ou nunca houve rodada). Escolhido ligado: só
custa uma linha, não agenda nada (sem cron) e a auditoria em si continua pedida pelo dono ("audita a usabilidade do painel").

## Armadilhas
- Porta do painel de teste vem do brief; nunca `panel.sh start|restart|autostart`.
- `--screenshot` headless do Firefox não espera o `fetch`: use o proxy de `reference/panel.md` §Armadilhas.
- A regra do achado é o tipo do problema, não a frase: duas frases para o mesmo problema viram achados repetidos.
