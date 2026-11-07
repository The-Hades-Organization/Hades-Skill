# Material de terceiros no catálogo de qualidade

## Impeccable

- Autor: Paul Bakaus
- Origem: https://github.com/pbakaus/impeccable
- Licença: Apache License 2.0 (cópia em `licenses/impeccable-LICENSE`, do commit abaixo)
- Commit do upstream: `414603bf14c7a344edb466bb1f85690c77ce8b7d` (tag `skill-v4.8.0`)

### O que derivou dele

As 22 regras `ui.*` do catálogo (`base.json`) e o pacote `anti-slop` (`packs.json`) derivam dos critérios de
design do Impeccable (`SKILL.md` e `reference/`, sobretudo `craft-floor.md`, `typeset.md`, `layout.md`, `clarify.md`,
`harden.md` e `animate.md`): tipografia, cor e contraste, hierarquia, espaçamento, ornamento genérico, texto de
interface vago, estados vazio/erro/carregando, responsivo e movimento.

### Modificações

O texto foi **modificado**: reescrito com palavras da Hades, em português do Brasil, reorganizado em regras
independentes com severidade e, quando cabe, uma checagem por `grep`. Nenhum trecho do upstream é copiado ao pé da
letra, e o upstream não endossa estas regras.

A Hades não empacota a skill do Impeccable. Quando o dono a instala, a Hades a usa
(`~/.claude/skills/impeccable`); sem ela, as regras acima seguem valendo.

Aviso de atribuição (Apache-2.0 §4): ver a licença em `licenses/impeccable-LICENSE`.
