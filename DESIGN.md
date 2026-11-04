# DESIGN.md — painel da Hades

Derivado do painel no ar (`kit/panel/ui/index.html`, `app.tsx`, `pages/`), não de intenção. Quando o código mudar, este
arquivo muda junto. Contrato de comportamento das páginas: `reference/panel.md`.

## Princípios

- **Ferramenta de operação, não vitrine.** Quem abre o painel está no meio de um trabalho: estado primeiro, texto
  curto, sem explicação do que a tela já mostra. Pt-BR, tom direto.
- **Quadrado.** `--radius: 0`; separação por fio (`border`, `border-strong`) e por tom de superfície, não por sombra.
  Sombra só em camada flutuante (`--elev`).
- **Cor com função.** Rosa vivo (`--vivo`/`--ring`, oklch 0.586 0.253 17.6) marca o que pede atenção e o foco; verde,
  âmbar, vermelho e azul (`--ok/--warn/--bad/--info`) são estado, nunca decoração. O resto é neutro quente
  (matiz 345–70).
- **Dois temas completos**, claro e escuro, escolhidos por `hades-panel-theme` (localStorage). O trilho lateral é
  escuro nos dois (`--sidebar #391a2c`); o terminal também (`--term`).
- **Movimento só com sentido** (o fio das Moiras, o pulso de quem pede você) e sempre atrás de
  `prefers-reduced-motion`.

## Tipografia

| Papel | Família | Uso |
|---|---|---|
| Texto | Figtree (`--font-sans`) | interface e prosa |
| Título de página | Marcellus (`--font-heading`), só no `h1` | "Documentação", títulos de documento |
| Mono | Geist Mono (`--font-mono`) | ids, caminhos, números, código, terminal |

Escala em rem (acompanha o navegador): micro 11 · meta 12 · label 13 · body 14 · prose 15 · section 16 ·
section-lg 18 · display 24 · page-title 32 px. Os papéis são utilitários `t-*` (`t-body`, `t-label`, `t-meta`, `t-data`,
`t-code`, `t-code-doc`, `t-prose`, `t-kpi`…): página nova usa o papel, não o tamanho solto. Número em coluna leva
`tnum`.

## Superfícies e componentes

`Card` (cabeçalho com título e resumo, conteúdo), `Segmented` (pílula elástica; troca por `Select` abaixo de `xl`),
`Select` próprio (nunca o nativo fora de `vendor/`), `Input` com ícone, `Button` (`variant`: default, outline, link…),
`Empty`, `Skeleton`, `Loading`, `Mono`. Alvo de toque de 40 px no celular e em ponteiro grosso (regra global no
`index.html`). Foco: contorno de 2 px em `--ring`, deslocado para dentro nas linhas de lista.

## Leitura (página Documentação)

- Medida de prosa 68ch (≈ 41rem no corpo de 15 px); código e tabela ocupam a largura da coluna e rolam na horizontal.
- Linha de 1.7 no corpo (`p`, `li`); código inline com folga de 4 px, sem esticar a linha; código em título herda o peso
  e some o fundo cinza (0.7em).
- Tabela: a 1ª coluna nunca quebra no meio da palavra; as demais só quebram se a palavra não couber.
- Documento longo é cortado em seções por `## ` e cada seção pinta só perto da tela (`content-visibility:auto`,
  tamanho estimado de 900 px); o salto a um tópico confere a posição depois e corrige sem animar.
- Bloco de código tem botão "Copiar" (visível ao passar o mouse, ao focar, e sempre em toque).
- Mesa: índice do grupo e "Neste documento" ao lado, com o índice de documentos limitado a 38vh de rolagem própria para
  os tópicos ficarem à vista. Celular: seletores de Grupo e Documento e uma lista recolhível "Tópicos" que mostra o
  tópico atual.

## Regras de bolso

Sem `any`, sem cor fora dos tokens, sem sombra decorativa, sem ícone sozinho sem rótulo, sem animação sem a guarda de
movimento reduzido. A base (`.md`, `renderMd`, `slugify`) é compartilhada com Thanatos, Revisões e Orquestração: ajuste de
uma página vai por classe na própria página, não no `.md` global.
