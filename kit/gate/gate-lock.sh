#!/usr/bin/env bash
# gate-lock.sh — fila de admissao de gate da Hades: builds do ambiente e gates do loop (lint/build/teste) de todos os
# clones, nos mesmos tickets (~/.claude/hades/work/<owner__repo>/locks). Local-only, fora do repositorio.
# Fonte unica: ~/.claude/skills/hades/kit/gate/gate-lock.sh (o loop chama esta; o install copia para $D/gate/).
#
#   gate-lock.sh run <kind> [--label L] [--timeout S] [--cost-gb N] [--step S:E] [--priority N] -- <cmd...>
#   gate-lock.sh run --step <stack>:<etapa> [...] -- <cmd...>     kind e custo vem da etapa da stack (stacks/<n>/stack.json)
#   gate-lock.sh status
#   gate-lock.sh peak <label>                                      pico de memoria (MB) da ultima execucao com esse label
#
# Saida 75 (EX_TEMPFAIL) = nao admitido ate o fim do timeout; o chamador cede o tick.
# Wrapper: a logica (fila FIFO, admissao por memoria, scope systemd) esta em src/commands/gate-lock.ts (`hades gate-lock`);
# este script mantem o caminho e o contrato ate a 5.0.0. A copia instalada em $D/gate/ acha a skill pelo HADES_SKILL ou
# por ~/.claude/skills/hades.
_here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
for _skill in "${HADES_SKILL:-}" "$_here/../.." "$HOME/.claude/skills/hades"; do
  [[ -n $_skill && -f $_skill/loop/bin/lib.sh ]] && { HADES_LIB_BUN_ONLY=1 source "$_skill/loop/bin/lib.sh"; break; }
done
declare -F hades_ts > /dev/null || { printf 'gate-lock: nao achei a skill (HADES_SKILL ou ~/.claude/skills/hades)\n' >&2; exit 2; }
hades_ts gate-lock "$@"
