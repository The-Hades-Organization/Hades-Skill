# Estilo visual do painel

O estilo visual do painel da Hades (`kit/panel/ui/`) organiza todas as páginas sobre um fundo escuro em névoa, com superfícies de leitura opacas, controles retos de 32 px sem borda e cor saturada restrita ao estado e à ação principal. A especificação completa de tokens, tipografia, componentes e contrastes medidos está em `kit/panel/ui/DESIGN.md`.

## Princípios

1. Superfícies de leitura (`Card`, `Regua`, diálogo, cartão de erro) são opacas (`bg-card/96` ou `bg-popover`) sobre a névoa e usam colchetes de canto (`cantos`, dois ângulos de 10 px com traço de 2 px em `--line`), sem caixa fechada.
2. Toda a escala `rounded-xs` a `rounded-4xl` vale 0; `rounded-full` existe apenas em ponto de estado (`Dot`), nos indicadores de 7 px da sidebar e em ícones de giro.
3. O hover troca apenas o tom da superfície (`bg-hover`, `bg-primary-hover`, `bg-secondary-hover`), sem brilho, sombra nem escala.
4. O destaque (`--primary`) identifica a ação principal (um botão `default` por região), o foco e controles marcados; o estado em curso usa `--busy` (`var(--foreground)`), e `--vivo` aplica-se apenas a `caret-color` e `::selection`.
5. Os títulos (`t-page-title`, `t-section-lg`, `t-section`, `h1`, `h2`) usam Marcellus em peso 400 sem síntese (`font-synthesis: none`), o corpo usa Figtree e os dados usam Geist Mono.
6. A névoa (`body::before`), a vinheta (`body::after`) e a poeira (`fx/poeira.tsx`) ficam na moldura (z 0) e nunca passam sob o texto.
7. O movimento contínuo fica restrito ao que exige atenção (`pulso` em `warn`/bloqueado) ou está em atividade (fio `fiando`, correnteza do rio na sidebar e aresta trabalhando no Argos), com alternativas paradas sob `prefers-reduced-motion: reduce`.
8. Todo par de cores mantém contraste WCAG AA nos dois temas: texto ≥ 4,5:1 e elementos não textuais ≥ 3:1.

## Paleta e superfícies

O tema escuro é o padrão e o claro funciona como alternativa. Os tokens vivem em `:root` e `.dark` no `kit/panel/ui/index.html`:

| Papel | Token / utilitário | Escuro | Claro | Aplicação |
|---|---|---|---|---|
| Chão | `--background` / `bg-background` | `#0e050a` | `#f8ecf1` | fundo da página e texto sobre selo cheio |
| Texto | `--foreground` / `text-foreground` | `#f2e6d9` | `#301423` | texto principal e estado `--busy` |
| Superfície 1 | `--card` / `bg-card` | `#190d14` | `#fff8fb` | `Card`, `Regua` e corpo de nó do Argos |
| Superfície 2 | `--popover` = `--secondary` = `--muted` | `#25161f` | `#f0dfe6` | campo, menu, diálogo, toast, botão secundário e card aninhado (`.cartao .cartao`) |
| Texto secundário | `--muted-foreground` / `text-muted-foreground` | `#bca7b4` | `#684b5b` | descrição, metadados e ícone de apoio |
| Destaque | `--primary` / `bg-primary` | `#ffc6df` | `#391a2c` | botão primário, foco, linha de base ativa e controle marcado |
| Linha | `--line` / `border-line` | `#876678` | `#926e7e` | colchetes `cantos`, linha de base de `campo` e barra de rolagem |
| Fio | `--border` / `--border-strong` | `line` 32% / 58% | `line` 32% / 58% | divisória interna de 1 px e fio parado |
| Estados | `--ok` / `--warn` / `--bad` / `--info` | `#61d19a` / `#f6b84d` / `#ff6d53` / `#5bc1d9` | `#006b40` / `#8a4c00` / `#b71d00` / `#006585` | selos `Badge`, pontos `Dot`, fios e faixas de estado |
| Sidebar | `--sidebar` / `--rail-muted` | `#190d14` / `#bca7b4` | `#391a2c` / `#d7bfcb` | navegação lateral opaca e escura nos dois temas |
| Terminal | `--term` / `--term-foreground` | `#0b0408` / `#f2e6d9` | `#1d0f17` / `#f2e6d9` | superfície escura nos dois temas |

Sobre superfícies de terminal (`bg-term`), links usam `text-term-foreground underline decoration-line underline-offset-4 hover:text-metal` para manter contraste nos dois temas.

## Componentes e padrões

As páginas consomem as primitivas de `window.HadesCore` (`kit/panel/ui/app.tsx`).

### Botões e campos

`Button` e `Input` têm 32 px na mesa (`h-8`) e 44 px no celular (`max-md:h-11`). Campos de texto e o gatilho do `Select` usam o utilitário `campo` (superfície 2 e linha de base `inset 0 -2px 0 var(--line)`, que muda para `--primary` em foco e `--bad` quando inválido). Botões desabilitados recebem hachura diagonal; ações destrutivas usam `bg-danger-soft text-bad` ou `HoldConfirm`.

### Seleção e listas

`Segmented` e `Choice` marcam a aba ativa com `bg-secondary` e linha de base de 2 px em `--primary`. Linhas selecionáveis em listas laterais e itens ativos da paleta usam `.item-ativo` (`bg-accent shadow-[inset_3px_0_0_var(--primary)] hover:bg-accent`).

### Selos, tabelas e gráficos

`Badge` tem fundo cheio na cor do estado e texto em `--background`, acompanhado de ícone ou rótulo (`StateBadge` para serviços e units). `Dot` pulsa apenas quando há espera pelo dono (`warn`). `Table` reduz o espaçamento lateral abaixo de `md` (`max-md:px-2`), permite quebra em `Th` e `Td` e oculta colunas secundárias com `max-md:hidden` em telas de 360 px. `AreaChart` renderiza uma linha compacta quando não há amostras ou quando todas as séries estão zeradas no período.

### Navegação lateral

A coluna `Sidebar` (`bg-sidebar`) exibe pontos `.luz` em `--metal` cuja opacidade decai com a distância até a página ativa (`.nav-atual`), ligados pelo `.rio` de 1 px e pelo `.obolo` que desliza na troca. Na barra recolhida (`64 px`, Ctrl+B), cada ícone preserva o indicador `.luz-recolhida`. No celular, a navegação desce do topo como folha (`Sheet side="top" rail`).

### Canvas do Argos

Páginas `{ stage: true }` ocupam a janela sem cabeçalho. Nós completos têm corpo em `--card`, cabeçalho em `--popover`, faixa de estado de 4 px no topo e colchetes `cantos` em `--line`. Nós e arestas em repouso diluem `--muted-foreground` a `REST_FILL_PCT = 70%` sobre `--card` (contraste ≥ 3:1 sobre `--background`, `--card` e `--popover` nos dois temas). Arestas medem de 1,5 a 2,5 px na cor do estado do destino e animam o tracejado a 22 px/s quando o destino trabalha. Painéis e barras flutuantes sobre o canvas usam `elev-float` (superfície 2 `bg-popover` com sombra longa `--elev: 0 12px 32px -8px rgb(0 0 0/.7)`, sem borda).

### Camada de partículas

Em `kit/panel/ui/fx/poeira.tsx`, `window.HadesPoeira` mantém até 48 grãos por unidade de densidade na camada ambiente (canvas fixo em z 0) e emite rajadas em z 65 (`emitir(el, 'desfazer' | 'apagar')`) quando um toast ou elemento se desfaz. Com `prefers-reduced-motion` ou economia de dados (`saveData`), a camada ambiente é pintada uma vez parada e nenhuma rajada é emitida.

## Arquivos

- `kit/panel/ui/index.html`: tokens de cor e escala, papéis tipográficos `@utility t-*`, utilitários `cantos`, `campo`, `elev-float`, `elev-shadow` e `item-ativo`, CSS da navegação e da névoa.
- `kit/panel/ui/app.tsx`: conjunto de ícones `I` (lucide mais 21 ícones próprios em grade de 24 com traço de 2 px e figuras `Argos`, `Cerberus` e `Caronte`), primitivas de `HadesCore`, `Sidebar`, `CommandPalette` e casca do aplicativo.
- `kit/panel/ui/fx/poeira.tsx`: motor de partículas em canvas 2D (`window.HadesPoeira`, tipado em `kit/panel/ui/globals.d.ts`).
- `kit/panel/ui/DESIGN.md`: especificação normativa do sistema visual e tabela de contrastes medidos.
