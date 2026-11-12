# Memória do projeto: higiene do índice

O Claude Code carrega o `MEMORY.md` do projeto (`~/.claude/projects/<slug do cwd>/memory/MEMORY.md`) no começo de toda
sessão do repositório, inclusive de cada worktree de agente. A Hades é quem mais escreve nele. Acima de 24,4 KB
(`MEMORY_LOAD_LIMIT_BYTES`, medido numa instalação real) o resto é cortado em silêncio, e o que cabe custa tokens em
toda sessão. Uma instalação chegou a 36,4 KB e 189 linhas, com 61 linhas cortadas.

## Linha `memoria-indice` do doctor

`hades doctor` mostra, no grupo Memória, o tamanho do índice contra o limite e a contagem de cada problema:

- linhas acima de 150 caracteres;
- entradas duplicadas (mesmo alvo);
- links para arquivo que não existe (alvo absoluto ou com `..` conta como inexistente e nunca é lido);
- entradas com cara de histórico encerrado.

Histórico encerrado é entrada cujo arquivo tem `type: project` e `modified` (ou, sem ele, a data do arquivo) mais
velho que 60 dias, ou cujo título ou gancho diz "mergeada", "entregue" ou "concluída". Sem `MEMORY.md` a linha é ok,
com o motivo. Com problema é aviso, com o comando `hades memory tidy`. O doctor só lê.

## `hades memory tidy`

```
hades memory tidy [--dry-run | --apply] [--json] [--cwd <dir>]
```

Sem flag é dry-run: mostra o diff (`-` sai, `+` entra) e não grava. `--apply`, que o dono roda, grava. O comando:

1. corta o gancho das linhas acima de 150 caracteres e mantém título e link;
2. remove as entradas duplicadas e mantém a primeira;
3. divide as entradas entre os três índices.

Nunca apaga nem move arquivo de memória: só reescreve os índices. Antes de gravar, copia cada índice que existe para
`<nome>.bak-<data UTC>` ao lado. Rodar de novo sobre um índice já limpo não muda nada.

## Os três índices

| Índice | Conteúdo | Quando é lido |
|---|---|---|
| `MEMORY.md` | regras duráveis, e as entradas com link quebrado (o dono decide) | toda sessão |
| `ORQUESTRACAO.md` | memória de orquestração (entradas com "orquestra" no título, alvo ou gancho) | no início da orquestração |
| `ARQUIVO.md` | histórico encerrado | sob demanda |

Se `ORQUESTRACAO.md` ou `ARQUIVO.md` já existem, o `tidy` acrescenta só as entradas cujo alvo ainda não está lá.
O orquestrador grava memória de orquestração no `ORQUESTRACAO.md` (`reference/loop/orchestrate.md` §7).

Código: `src/lib/memory-index.ts` (modelo puro), `src/lib/doctor-memoria.ts`, `src/commands/memory.ts`.
