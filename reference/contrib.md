# Devolver a melhoria ao repositório da skill (`hades contrib`)

A Fase 8 (`reference/evolving.md`) termina numa versão nova da skill **local**. Quando a melhoria serve a qualquer usuário,
o `hades contrib` a prepara para voltar ao repositório da skill. Nada sai da máquina sozinho: com acesso ele só prepara e
mostra; a PR só abre com confirmação explícita; sem acesso grava um `.html` que o dono envia ao mantenedor da skill.

## Quando sugerir

Ao fim do passo de release da Fase 8, o agente roda `hades contrib suggest` se a evolução tocou o núcleo. O diff é o da
árvore de trabalho da skill contra o commit que subiu a **versão instalada** (`$HADES_DATA/kit.version`; `--base <ref>`
escolhe outro ponto). Entram só `kit/`, `src/`, `reference/`, `loop/` e `SKILL.md`.

| Diff | Resultado |
|---|---|
| só núcleo | a contribuição inteira |
| misto (núcleo + `packs/`, `env/`, perfil, `README.md`, `VERSION`…) | só a parte do núcleo; a sugestão lista o que ficou de fora e por quê |
| só pacote de projeto | "nada a sugerir" |

Pacote de projeto nunca entra. Arquivo binário também fica de fora (não dá para varrer).

## Varredura (antes de qualquer sugestão)

Título, corpo e as linhas postas do diff passam pela mesma guarda do `hades skill-release check`: nome de projeto
(termos e vocabulário dos perfis instalados), domínio (`domainTerms`, com os `@allow`) e segredo/identidade da máquina
(`src/lib/release-guard.ts`), mais caminho da máquina (`/home/…`), e-mail e credencial. A slug do repositório da skill é
isenta. Achado → **nada é gerado**: o comando sai com 1 e lista `arquivo:linha  tipo` (nunca o trecho). Limpe e rode de novo.
Termo de perfil que não compila também barra (falha fechado).

## Informar o conteúdo

`--title`, `--why`, `--gains` (uma linha por ganho) e `--proof` são obrigatórios; `--what` é opcional (padrão: os assuntos
dos commits do núcleo). O corpo sai com **o que é, por quê, ganhos, prova, arquivos e o que ficou de fora**.

## Com acesso

Acesso = `gh api repos/<repo>` com `permissions.push` verdadeiro; o repo vem de `HADES_VERSION_CHECK_REPO` (a mesma chave da
checagem de versão, mesmo timeout). Sem `gh`, sem login ou sem permissão é o caminho "sem acesso", sem erro.

- `hades contrib prepare|suggest …` mostra destino, branch (`contrib/<slug>`), título, corpo e diff. Não escreve nada.
- `hades contrib pr …` faz o mesmo e só então pergunta (interativo) ou exige `--yes` (não interativo). Confirmado: clona o
  repo pelo `gh`, aplica só o núcleo numa branch, empurra e abre a PR contra a branch padrão. **O agente nunca passa
  `--yes` por conta própria**: mostra o preparo ao dono e espera o ok.

Ciclo do lado do mantenedor da skill: ele **revisa na PR**; a consolidação traz o diff para a `main` local como patch
(`git am` ou `git apply`), a mudança sai na **próxima release** e a PR é **fechada citando a versão**.

## Sem acesso

`hades contrib html …` (ou `suggest`, que escolhe sozinho) grava `~/.claude/hades/contrib/<slug>.html` a partir de
`kit/contrib/contrib.html`: página autocontida (sem script, sem recurso externo), clara e escura, com o que é, problema,
ganhos, prova, arquivos tocados, o que ficou de fora, o diff embutido (escapado) e um diagrama em SVG das áreas tocadas
quando passam de uma. O comando imprime o caminho; o dono o envia ao mantenedor da skill pelo canal que preferir.

## Slug

`--slug` (minúsculas, números, hífen) nomeia a branch e o arquivo; o padrão é `evolucao-<8 hex do diff>`, estável para o
mesmo diff. Regerar sobrescreve o `.html` do mesmo slug.
