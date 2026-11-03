# Widget Android

Widget de tela inicial que mostra o loop da Hades no celular. Lê `GET /api/widget` (contrato v1 em
`reference/panel.md` §Widget Android); o código Android fica em `kit/android/widget/` (Java, `AppWidgetProvider` +
`RemoteViews`, WorkManager; sem TWA nem Bubblewrap). Vários widgets no mesmo APK, por registro (§Acrescentar um widget). O primeiro, o **widget de status** (`registry/status.widget`), mostra o loop; os outros dois estão em §Widgets Sistema e PRs.

## O que mostra

Cada widget tem dois tamanhos (§Design): o **compacto** cabe no mínimo (4x2) e o **regular** (a partir de 140 dp de
altura) acrescenta a lista.

- Três contadores grandes com rótulo pequeno: `ativos` (`--ok`), `parados` (apoio) e `perguntando` (em `--warn` quando há
  pergunta aberta ao dono).
- Regular: até 4 agentes (perguntando primeiro, depois ativos, depois parados), cada um com ícone de estado, nome com o
  papel e idade (`impl-a (impl)` · `5min`).
- Linha de estado: `atualizado HH:mm` (hora do aparelho, convertida do `updatedAt` UTC) ou o problema da última leitura
  seguido de `último dado HH:mm`. **Uma falha nunca apaga o último dado bom.**
- `available: false` → `sem orquestração`; sem leitura ainda, os contadores ficam em branco (nunca um `0` não medido).
- Estado de agente desconhecido conta como `stopped`; tipo de evento desconhecido e campo novo são ignorados (o contrato
  só ganha campos).

| Situação | Linha de estado |
|---|---|
| `401 widget_token` | `token recusado (401)`: gere outro em Acesso remoto e reconfigure |
| `404 widget_off` | `widget desligado no painel (404)` |
| `429 widget_rate_limited` | `muitas tentativas (429), tente em N min`: respeita o `Retry-After` (padrão 600 s) e não consulta até lá, nem pelo botão |
| sem rede, timeout | `sem rede` |
| `5xx` | `painel com erro` |
| corpo fora do contrato, redirecionamento | `resposta inesperada` (o app não segue redirecionamento: o token não vai para outro destino) |
| sem URL ou token | `toque para configurar` |

O erro é ramificado pelo `code` do corpo; o status só decide quando não há código (proxy, túnel).

## Widgets Sistema e PRs

Mesmo APK, mesma configuração e mesmo `GET /api/widget` (um pedido serve os três); cada um pinta uma seção do contrato
(`reference/panel.md` §Widget Android) e herda do núcleo o último dado bom, os estados de erro da tabela acima, o `↻` e o
refresh de 15 min. Seção ausente (painel antigo, ou fora do formato) vira `sem dados … (painel desatualizado)`; o widget de
status segue normal.

- **Hades Sistema** (4x2): medidor de memória (`39%`, `12,5 / 32,0 GB`; a barra muda de `--ok` para `--warn` em 70% e
  `--bad` em 85%); ícone de saúde da infra (`5/6 serv · 3/3 cont`, em erro quando algo caiu) e da fila (`livre`, ou
  `build-api 4min · +2`). Regular: a infra por extenso (`· caiu: nomes`, até 3 e `+N`) contra os serviços ligados e os
  containers de longa duração, e a fila com uma barra de quanto da memória o gate em andamento consome
  (`fila: build-api 4min · 1,2 GB · 2 esperam`). Fonte: `system` (fila e amostrador do painel, sem custo novo).
- **Hades PRs** (4x3): quatro contadores com ícone (`✓` verde, `✗` falhando, `▶` rodando, olho = review pendente) e, no
  regular, uma linha por PR (até 4; a indicação de frescor tem de caber sempre): ícone do CI, `#12`, título e o olho quando há review pendente. O gate é **só o CI do
  GitHub** (sem CI = anel vazio). A linha seguinte mostra a idade do dado (`dados de 7min atrás`); coleta falha mantém o
  último dado e avisa (`coleta falhou · dados de …`). Sem PRs, o texto `nenhuma PR aberta` no lugar dos contadores. Fonte:
  `prs`, coletor do loop com cache de pelo menos 300 s no painel: a leitura do widget nunca roda o `gh`. A primeira
  leitura depois de subir o painel pode vir `coletando as PRs…`; o `↻` ou o refresh seguinte já traz o dado.

Os textos completos (`mem 12,5 / 32,0 GB · 39%`, `✗ #12 [review] título`…) seguem nos modelos dos presenters e viram a
descrição de acessibilidade do widget (`contentDescription` do `root`): quem usa leitor de tela ouve o dado, não "ícone".

## Toque e botão

- Tocar no widget abre a **URL do painel** configurada (o Chrome entrega ao PWA instalado). Sem URL de painel, abre a
  tela de configuração.
- O ícone `↻` do cabeçalho lê agora (um trabalho do WorkManager, não bloqueia a tela inicial).
- Atualização periódica: WorkManager a cada 15 min (o mínimo do sistema; o Android pode atrasar com economia de bateria).

## Instalar e configurar

Primeiro uso, do APK ao widget na tela:

1. Obtenha o APK. Pelo celular: abra o painel (PWA ou navegador, pelo acesso remoto), vá em **Visão geral (ou Acesso
   remoto) → App do widget** e toque **Baixar APK** (`reference/panel.md` §Baixar o APK). Se o card avisar
   *Desatualizado*, toque **Gerar APK** antes (precisa de Docker no computador do painel). Ou copie
   `$D/android/hades-widget.apk` para o celular (cabo, `adb install`, ou outro canal seu).
2. Permita a instalação de fonte desconhecida para o app que abriu o arquivo (o navegador ou o painel instalado) e instale.
3. No painel local, página **Acesso remoto** → *Token do widget Android* → gerar. O token `hdw_…` aparece uma vez.
4. Na tela inicial: segure → Widgets → **Hades** (o app do widget). A tela de configuração pede:
   - **URL do widget**: a que responde `GET /api/widget` (o túnel dedicado do widget, ou `http://127.0.0.1:<porta>/api/widget`
     para teste); só HTTPS, salvo `127.0.0.1` e `localhost`;
   - **Token do widget** (`hdw_…`);
   - **URL do painel**: o que o toque abre (a do túnel do painel, onde o PWA está instalado).
5. Para trocar a configuração, remova o widget e adicione de novo (ou, em Android 12+, segure o widget → Configurar).
   Deixar o token em branco ao reconfigurar mantém o guardado.

### Atualizar

Baixe o APK mais novo como no passo 1. Abrir o arquivo baixado instala por cima do app anterior: o widget já colocado
continua com a configuração salva. A tela de informações do app mostra a versão (`versionName`); confira com a do card e
com o SHA-256 curto.

## Gerar o APK

```bash
hades widget-apk               # o comando de verdade (`$D/android/build.sh` é o shim dele, com os mesmos argumentos)
$D/android/build.sh            # testes JVM + APK assinado (pela fila de builds)
$D/android/build.sh test       # só os testes
$D/android/build.sh list       # widgets registrados (valida o registro)
$D/android/build.sh new <id>   # esqueleto de widget novo, já registrado (veja "Acrescentar um widget")
$D/android/build.sh status     # imagem, APK, keystore
```

O host é TypeScript (`src/commands/widget-apk.ts`, `reference/cli.md` §widget-apk): monta os fontes (cópia em TS, sem `rsync`),
sobe o container e grava o APK e o sidecar. O que roda **dentro** do container é bash, `kit/android/docker/inside.sh`.
Sem `docker` no PATH o comando falha cedo dizendo como instalar.

Também pelo painel: Visão geral (ou Acesso remoto) → card **App do widget** → *Gerar APK* (mesmo `build.sh build`, pela fila).

(`$D` = pasta de dados do Hades; também roda de `kit/android/build.sh` na skill.) Precisa de Docker e de rede na primeira
vez (imagem ~1,5 GB e dependências do Gradle).

- **Imagem:** `hades-android-build:<hash do Dockerfile>`, feita de `kit/android/docker/Dockerfile`: JDK 17 (digest
  fixado), Gradle 8.7 e cmdline-tools do Android SDK (sha256 fixado), plataforma `android-34`, build-tools `34.0.0`.
  Subir uma versão = editar o Dockerfile; a tag muda e a imagem é refeita. O container é descartável (`--rm`, nome
  `skilldev-widget-android-*` nos testes de evolução); o script não faz `prune` de nada.
- **Fila:** o comando se põe na fila do gate-lock (`gate-lock run build --label widget-android --cost-gb 3`); chamado de
  dentro da fila, roda direto. Sem gate-lock, roda direto.
- **Onde fica:** tudo em `$D/android/`: `hades-widget.apk`, `hades-widget.keystore` e `keystore.pass` (600, gerados na
  primeira vez, nunca no repositório da skill), `gradle-home/` (cache), `home/` (HOME do container) e `build/` (cópia dos fontes). Nada de cache fora de `$D`.
- **Versão:** `versionName` = `VERSION` da skill e `versionCode` = major×10000 + minor×100 + patch (4.11.0 → 41100),
  para o Android aceitar a atualização por cima. O build lê a `VERSION` ao lado do kit (ou o `kit.version` do `$D`)
  e recusa um valor que não seja `X.Y.Z`. Ao fim do build grava o sidecar `$D/android/hades-widget.apk.json` (versão,
  data UTC, tamanho, sha256, impressão SHA-256 do certificado e hash dos fontes) que o painel lê. `applicationId`,
  keystore e o componente `HadesWidgetProvider` não mudam.
- **A keystore é a identidade do app.** Perdê-la ou trocá-la obriga desinstalar o APK do celular antes de instalar o
  novo. Faça cópia de `$D/android/hades-widget.keystore` e `keystore.pass`.

## Acrescentar um widget

O APK é um só (`applicationId`, keystore e `build.sh` iguais); cada widget é uma entrada do **registro**
`kit/android/widget/registry/<id>.widget` (chave=valor, `#` comenta). Acrescentar um não reabre o código dos existentes.

```bash
$D/android/build.sh new fila      # cria registry/fila.widget, res/layout/widget_fila.xml, widget_fila_preview.xml e FilaWidgetView.java
# edite o layout, a prévia e o bind do FilaWidgetView; rótulo e tamanho em registry/fila.widget
$D/android/build.sh build         # gera <receiver>, res/xml/fila_info.xml e o rótulo; APK com os dois widgets
```

Para tirar o widget: apague os quatro arquivos que o `new` imprimiu.

| Chave | Obrigatória | Padrão | O que é |
|---|---|---|---|
| `label` | sim | | nome no seletor de widgets (sem `< > & " ' \ $ % @ ? { }` nem crases) |
| `cells` | sim | | tamanho em células `LxA` (1 a 10); o `minWidth`/`minHeight` sai de `70·n−30` dp |
| `layout` | não | `widget_<id>` | layout regular em `res/layout/` (precisa dos ids `root` e `refresh`); a prévia é `<layout>_preview.xml` (obrigatória) e a versão compacta, se houver, `<layout>_compact.xml` |
| `renderer` | não | `<Id>WidgetView` | classe que implementa `WidgetView` (layout + bind) |
| `provider` | não | `<Id>WidgetProvider` | só para classe escrita à mão que estende `CoreWidgetProvider`; ausente, o build gera |
| `resize` | não | `horizontal\|vertical` | `none`, `horizontal`, `vertical` ou `horizontal\|vertical` |

`<Id>` é o id em CamelCase (`fila_gate` → `FilaGate`). O id é o nome do arquivo: `[a-z][a-z0-9]*(_[a-z0-9]+)*`, até 24
caracteres. O build reprova id inválido, chave desconhecida, campo obrigatório ausente, layout sem `root`/`refresh`,
classe inexistente, prévia ausente, view fora da lista do RemoteViews (§Views permitidas) e provider repetido (as regras vivem em `WidgetDeclaration`, a mesma classe que os testes cobrem).

**O que o núcleo dá de graça** a todo widget registrado: busca (`HttpWidgetSource`), classificação da resposta,
último dado bom e falha (`StateStore`), configuração (URL, token no cofre, painel), refresh periódico de 15 min e o `↻`,
o toque que abre o painel, o respeito ao 429 e o redesenho de todas as instâncias após cada leitura. A configuração e o
último dado são do app, não de cada instância: um `GET /api/widget` serve todos os widgets.

**O que o widget implementa:** só `WidgetView` (`layout(WidgetSize)` e `bind(RemoteViews, WidgetInput, WidgetSize)`), mais
os layouts e a prévia. O `bind` recebe o último dado bom, a falha, os minutos de retry, o fuso e o tamanho, e pinta a parte
do snapshot que interessa (`WidgetInput.present()` dá o modelo do widget de status; widgets de outra seção montam o
próprio). Widget sem versão compacta devolve o mesmo layout nos dois tamanhos.

**Gerado no build** (na cópia em `$D/android/build/src`, nunca na árvore da skill): `<Id>WidgetProvider`, o `<receiver>`
no manifest (no lugar do marcador `hades:receivers`), `res/xml/<id>_info.xml`, `res/values/widgets_generated.xml` e o
`WidgetCatalog` que liga provider a renderizador. Por isso o código Android só compila pelo `build.sh`.

### Compatibilidade de atualização (não quebre)

O widget já colocado na tela do dono é identificado por **nome de componente + `applicationId` + assinatura**. Mantenha:

- o componente `dev.hades.widget.HadesWidgetProvider` (`registry/status.widget` o fixa em `provider=`);
- o `applicationId` `dev.hades.widget` e o `namespace`;
- a keystore de `$D/android/` (trocá-la obriga desinstalar).

Com isso o APK novo instala por cima e o widget continua com a configuração salva (`EncryptedSharedPreferences`) e o
último dado. Widget novo é componente novo: aparece no seletor, sem afetar os colocados.

## Design

A interface segue o painel (`kit/panel/ui/index.html`): primária vinho, cantos retos (`--radius: 0`), neutros
levemente púrpura, estados `--ok`/`--warn`/`--bad`/`--info`, e o modo claro/escuro **do sistema** (`values-night/`,
como o painel segue `prefers-color-scheme`). O widget é um cartão (`widget_bg`: superfície, borda de 1 dp e filete
primário de 3 dp à esquerda) com **cabeçalho** (marca, título, `↻`), **área principal** (o número ou o medidor que
importa) e **detalhe** menor por baixo, separado por `divider`.

### Elementos visuais

| Dado | Elemento |
|---|---|
| contagem (ativos, parados, perguntando; PRs por CI) | número grande (24 sp) com rótulo de 10 sp; a cor do número troca de `TextView` por visibilidade |
| percentual (memória, fatia da memória do gate) | `ProgressBar` horizontal de 6 dp; o nível (`Level`: 70% aviso, 85% erro) escolhe entre `bar_ok`/`bar_warn`/`bar_bad` (três barras empilhadas, só a do nível visível) |
| estado (CI, agente, infra, fila) | ícone vetorial trocado por `setImageViewResource` (`StateIcons`) |
| review pendente | `ic_review` (olho, `--warn`) |
| cabeçalho | `ic_mark` (marca) e `ic_refresh` (↻, alvo de toque de 32 dp) |

Ícones (`res/drawable/ic_*.xml`, 24 dp, só `@color/hades_*`): `ic_state_ok`, `ic_state_warn`, `ic_state_bad`,
`ic_state_run` (rodando), `ic_state_active` (agente ativo), `ic_state_idle` (parado / sem CI), `ic_review`, `ic_pr`,
`ic_refresh`, `ic_mark`. A cor vem do recurso (claro/escuro) e nunca do Java: onde a cor muda com o dado, o ícone ou a
barra muda de recurso, ou dois elementos se alternam por visibilidade.

### Tamanhos responsivos

`WidgetSize` tem dois valores: **compacto** (`<layout>_compact`; cabe no mínimo da grade) e **regular** (`<layout>`, a
partir de `REGULAR_MIN_HEIGHT_DP` = 140 dp, onde cabe a lista de agentes/PRs e o detalhe da infra/fila). Android 12+ recebe
os dois layouts num `RemoteViews(Map<SizeF, RemoteViews>)` e o launcher escolhe ao redimensionar; antes disso o
tamanho vem de `appWidgetOptions` (`OPTION_APPWIDGET_MIN_HEIGHT`) e `CoreWidgetProvider.onAppWidgetOptionsChanged`
redesenha. O `bind` só toca os ids que o layout do tamanho tem.

Layouts do kit: `widget`/`widget_compact` (status), `widget_sistema`/`widget_sistema_compact`,
`widget_prs`/`widget_prs_compact`, mais os trechos compartilhados incluídos por `<include>` (`widget_head`,
`widget_sistema_head`, `widget_prs_head`, `widget_status_line`, `widget_status_counters`, `widget_sistema_memory`,
`widget_prs_summary`).

### Views permitidas (o build recusa o resto)

O `RemoteViews` só infla um conjunto fechado de views; qualquer outra faz o widget aparecer como "Problema ao carregar o
widget" na tela inicial, sem erro no build. `LayoutPolicy` (a mesma classe no `build.sh` e nos testes) recusa, em todo
`res/layout/<layout>.xml` e `<layout>_*.xml` do widget, view fora desta lista, cor literal (`#RRGGBB`) e view
customizada ou do AndroidX:

`FrameLayout`, `LinearLayout`, `RelativeLayout`, `GridLayout`, `TextView`, `Button`, `ImageView`, `ImageButton`,
`ProgressBar`, `Chronometer`, `AnalogClock`, `TextClock`, `ListView`, `GridView`, `StackView`, `AdapterViewFlipper`,
`ViewFlipper`, `ViewStub`, `CheckBox`, `RadioButton`, `RadioGroup`, `Switch`; mais `<include>` e `<merge>`.

A mensagem diz o arquivo e a view (`registro de widgets: status: widget_x.xml: view não suportada pelo RemoteViews:
View (views aceitas: …)`). Divisor é um `FrameLayout` de 1 dp com fundo `@drawable/divider`, não um `View`. `ProgressBar`
horizontal usa `style="?android:attr/progressBarStyleHorizontal"` com `minHeight`/`maxHeight` explícitos (o estilo
padrão força 20 dp).

### Prévia do seletor

`<id>_info.xml` (gerado) aponta `previewLayout` para `<layout>_preview` (Android 12+: o layout **com dados de exemplo**,
porque o real sairia vazio no seletor) e `previewImage` para `drawable/widget_preview` (marca, medidor e três ícones de
estado), que serve a quem não tem `previewLayout`. As prévias do kit são o layout regular com os `<include>` expandidos e
texto de exemplo escrito nos elementos.

### Cores e demais peças

- **Cores num lugar só:** `res/values/colors.xml` (claro) e `res/values-night/colors.xml` (escuro), tokens
  `hades_<nome-do-painel>` convertidos de oklch para sRGB. Layout, drawable, tema e Java só referenciam
  `@color/hades_*`; literal de cor fora desses dois arquivos é erro. Mudou o token no painel? Reconverta ali.
- **Peças:** `drawable/widget_bg` (cartão), `field_bg` e `button_bg` (config), `divider`, `bar_*`, `ic_*`, estilos
  `Hades.Label|Body|Field` e tema `Theme.Hades` (claro/escuro).
- **Ícone do app:** adaptive icon (`mipmap-anydpi-v26/ic_launcher*.xml`): fundo `brand_ground`, glifo `brand_glyph` na zona
  segura, versão monocromática (Android 13+).
- **Estados:** linha de estado em apoio e em `hades_bad` quando a leitura falhou (`StatusLine`). Vem antes dos agentes e
  das PRs: no tamanho mínimo o que sobra de altura corta a lista, não o estado.
- **Molde:** `build.sh new <id>` copia `templates/layout.xml` (cabeçalho, número, medidor, linha de estado),
  `templates/preview.xml` e `templates/View.java`; use `StatusLine.bind` e mantenha os ids `status`/`status_problem`.
- **Tipografia:** pilha de sistema (`sans-serif`/`sans-serif-medium`), o fallback do Figtree do painel; fonte embutida
  fica fora (peso do APK e licença).

## Segurança

- O token fica no `EncryptedSharedPreferences` (chave no Android Keystore, AES-256-GCM); nunca é logado nem vai na
  query string (só `Authorization: Bearer`). O app não escreve log algum com URL ou token.
- Só HTTPS: `res/xml/network_security_config.xml` proíbe tráfego em claro salvo `127.0.0.1`/`localhost`, e a tela de
  configuração recusa o resto (`UrlPolicy`).
- O token vale só em `/api/widget` e só lê; revogar no painel derruba o widget na próxima leitura (`401`).
- `android:allowBackup="false"`: o token não entra em backup na nuvem.

## Armadilhas

- O ícone do lançador (a marca do Hades) abre a tela de configuração fora de qualquer widget: salva URL, token e
  painel e lê agora; o widget em si continua sendo colocado pelo seletor de widgets.
- O Android limita o periódico a 15 min e o atrasa em modo de economia; o botão `↻` é o caminho para ver agora.
- A URL do devtunnel autenticado não serve ao widget (login GitHub e connect token de ~24 h); use o túnel anônimo
  dedicado ao widget (`reference/tunnel.md` §Túnel do widget).
- `build.sh` gera APK `release` assinado com a keystore local, não para a Play Store; instalar por cima de um APK com
  outra assinatura falha (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`): desinstale o antigo.

## Testes

`build.sh test` roda no container os testes JVM (JUnit 4 + `org.json`) de `kit/android/widget/app/src/test/`: o parser
contra o exemplo do contrato e variantes (campo novo, seções `system`/`prs` presentes, ausentes e fora do formato (`SystemPrsSectionsTest`), estado desconhecido, `available: false`, versão maior, teto de
agentes, campo obrigatório ausente), o classificador de respostas (código vs status, `Retry-After`), o apresentador
(destaque do `asking`, falha mantendo o último dado, `sem orquestração`), a política de URL, as regras do registro
(`WidgetDeclarationTest`: id, campos obrigatórios, chave desconhecida, valores inseguros) e o roteamento do provider para
o renderizador certo (`WidgetRegistryTest`).
O modelo visual (`VisualModelTest`: nível do medidor, ícone por estado, contadores) e a recusa de view fora do
`RemoteViews` ou de cor literal (`LayoutPolicyTest`) também rodam aí.

`build.sh shots` renderiza cada widget (layout e `bind` reais, via `RemoteViews.apply`, em layoutlib/Paparazzi) nos
dois tamanhos, claro e escuro, com dado completo, em alerta, carregando e com erro: 48 PNGs em `$D/android/shots/`
(`<widget>-<tamanho>-<estado>-<claro|escuro>.png`). Paparazzi e Kotlin entram só na cópia dos fontes que o comando
usa; o APK e `build.sh test` não os conhecem. Olhe as capturas depois de mexer em layout: corte de texto e ícone
sem dado aparecem ali, não nos testes.

O lado host (`hades widget-apk`) tem teste em `loop/test/ts/widget-build.test.ts`, com um `docker` falso no PATH (argumentos
do container, cópia dos fontes, `sourcesSha` igual ao do painel, `list`/`new`, falha cedo sem docker). O build real fica
em `loop/test/ts/widget-build-docker.test.ts`, fora da regressão padrão: `HADES_TEST_DOCKER=1 hades gate-lock run build --
bun test loop/test/ts/widget-build-docker.test.ts` (Docker e rede; confere o sidecar campo a campo, menos `builtAt`, e roda
`apksigner verify` no container).
