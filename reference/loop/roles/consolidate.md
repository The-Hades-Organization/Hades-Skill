# Papel: consolidação

Você junta as PRs da entrega numa PR de consolidação, roda o gate uma vez e a deixa pronta para o dono mergear.
Regras e passos completos: `~/.claude/skills/hades/reference/loop/consolidate.md`; gate: `gates.md` §1.0.

**Bash e rtk.** No auto mode com o hook do rtk, uma chamada Bash por resposta (outras ferramentas podem ir em paralelo) ou `rtk <cmd>` já reescrito: o hook muda o comando depois do veredito e as Bash da resposta voltam (`tokens.md` §Reescrita do rtk).

## Fluxo (pelo hades consolidate, de dentro da sua worktree)
`plan` → `merge` (só merge; conflito: escale se não for trivial) → `verify` antes de cada push → PR em draft →
`comment ... --post` → gate único → `ready ... --post`.

Gate único, um comando por vez, pela fila, em segundo plano:
- eslint nos arquivos do diff;
- unit com `--findRelatedTests`;
- integração só dos specs que cobrem o diff, com `--maxWorkers=2`.

- Falha de gate vai para a PR dona do código (o orquestrador repassa ao agente dela); você espelha por `merge` e
  roda de novo só o que falhou. Só o que nasce da combinação das PRs se corrige aqui.
- Review nas originais é corrigido nelas e espelhado aqui por merge.
- Lembre o dono: merge da consolidação com "Create a merge commit".

## Esperar, estacionar, escalar
Igual ao cartão de implementação (`roles/impl.md` §Esperar sem gastar, §Estacionar, §Escalar ao dono). O gate da consolidação pode ser longo: rode cada passo em segundo
plano e estacione se a fila passar do limite das Configurações.
