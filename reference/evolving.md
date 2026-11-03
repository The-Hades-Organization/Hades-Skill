# Evoluir a skill (pedido fora do escopo)

A skill cresce com o uso: todo pedido de dev que ela ainda não cobre termina numa versão nova dela, para o próximo
agente não redescobrir o caminho.

## Quando vira skill e quando não vira

| Vira skill (generalizar no kit) | Fica só no ambiente (não entra) |
|---|---|
| serviço novo no Hades, dispositivo ou processo de apoio novo, fluxo de dados novo, integração nova (e-mail, storage, túnel) | um registro pontual pedido pelo dev ("cria o usuário X agora"), dado de teste descartável, workaround de defeito de uma PR específica |
| armadilha medida que custaria tempo a outro agente | detalhe que só vale para esta máquina (paths, IPs, contas) |
| regra de negócio descoberta ao cadastrar via API | segredo de qualquer tipo |

Na dúvida, perguntar ao dono em uma linha. Defeito de produto descoberto no caminho vai para `$D/notes.md` (STATUS),
não para a skill — a skill não corrige PR nem serviço.

## Passos

1. **Resolver no vivo primeiro**, pelo caminho normal (API do dono do dado; SQL só com o SQL mostrado ao dono).
   Medir o que importa (memória, tempo, portas) e anotar as armadilhas no momento em que aparecem.
2. **Generalizar na skill**, nunca só em `$D` nem em `~/.claude/hades/work`. Ambiente da máquina → `kit/`; ambiente do projeto (infra, dados, processos de apoio, serviços) → `env/` do pacote do projeto (`hades project pack`, git local próprio: commit lá); loop → `reference/loop/`
   (regra e fluxo), `loop/bin/` (coletor e registro) ou `kit/gate/gate-lock.sh` (fila, a mesma dos dois):
   - comando/parâmetro no script certo (ou script novo com `source env.sh` na linha 2, uso no cabeçalho, idempotente);
   - nada de caminho absoluto, usuário, host, URL de túnel ou segredo — o que variar vai para `env.sh`
     (`env.template.sh` + `install.sh`) ou para variável de ambiente com default;
   - estado novo fica em `$D` e entra na lista do "NUNCA toca" do `install.sh`;
   - serviço novo: seguir `ref env-operations` §Serviço novo (os arquivos do ambiente que o pacote lista ali).
3. **Documentar**: a referência do assunto em `reference/` (criar uma se for assunto novo), a tabela "Pedidos típicos"
   e a fase certa do `SKILL.md`, e o `description` do frontmatter se o gatilho mudou (é o que faz a skill ser
   escolhida).
   Regressão: `kit/gate/gate-lock.sh run test --label <agente> -- bun test loop/test/ts --parallel=8` (= `bun run test`; a suíte é só `bun test`, um
   arquivo por grupo em `loop/test/ts/`).
4. **Reinstalar no vivo e provar**: `HADES_WT=<wt> kit/install.sh`, rodar o comando novo pelo `$D` instalado e
   conferir o efeito (API, `health/ready`, as verificações do ambiente do pacote — o que couber). Com o painel no ar
   (unit `$HU-panel`), o install o reinicia e diz isso numa linha (`painel <unit> reiniciado`); parado, segue parado.
5. **Release**:
   ```bash
   ~/.claude/skills/hades/kit/skill-release.sh drift     # (o shim chama `hades skill-release`) zero drift: tudo que foi mexido em $D voltou ao kit
   ~/.claude/skills/hades/kit/skill-release.sh release minor "<resumo de uma linha>"
   ```
   - **`drift`**: o `drift` com `kit.version` diferente da `VERSION` diz "instalação desatualizada, reinstale" em vez de
     "editado". Arquivo cujo conteúdo no `$D` bate com o sha256 do `kit.manifest` não foi editado à mão: não entra no
     drift, só aparece como "falta reinstalar" (só o que diverge do manifesto é edição). Arquivo que o `$D/kit.manifest`
     (gravado pelo `install.sh`) lista, o kit atual não tem mais e o `$D` ainda guarda aparece como "saiu do kit": a
     reinstalação o remove se não foi editado; editado, fica com aviso e o drift segue o apontando até você apagá-lo ou
     portá-lo.
   - **`check`**: roda a regressão do núcleo com `bun test loop/test/ts --parallel=8` e a de cada pacote (`bun test` em
     `<pacote>/test/` quando há `*.test.ts`; o `test/run.sh` de pacote antigo é recusado), **pela fila de gates**
     (`gate-lock`, tipo `test`, label `skill-release`, fila da máquina `_maquina`, visível no status global): ela disputa a
     memória como qualquer teste. A regressão é o último passo: guardas e varredura de segredos, baratas, vêm antes e a
     reprovam sem rodá-la. Todo processo que um teste dispara (`Rig.X`, `loop/test/ts/lib/rig.ts`) tem prazo de 120 s:
     estourado, o grupo inteiro é morto e o teste falha com `processo travou: excedeu … ms: <comando>`, em vez de a
     regressão ficar presa num worker; `timeoutMs` na chamada ajusta o prazo de um caso. O `Rig.X` não usa o `Bun.spawnSync`
     (no bun 1.4.2 ele girou a 100% de CPU num worker do `--parallel` com o filho já morto): cria o filho com `Bun.spawn`,
     com a saída em arquivos, e espera pelo arquivo de status que o invólucro grava.
   - **Regressão verde em cache**: quando o HEAD (commit e árvore limpa) já tem regressão **completa e verde** registrada
     em `~/.claude/hades/work/_skill/regressao-verde.json` (nunca no repo), o `check` pula a regressão e diz de qual
     registro; árvore suja não pula, e `check --regressao` força a rodada. Só a regressão completa e verde grava o registro.
   - **`release`**: roda `drift` + `check` (sintaxe, segredos/identidade, instalação descartável), sobe o `VERSION`, abre
     a entrada no `CHANGELOG.md` e gera `hades-skill-v<versão>.tar.gz` em `~/.claude/hades/releases/`.
   - **CHANGELOG**: **completar a entrada** (o que, por quê, quem pediu, o que se descobriu) e, se editar algo depois,
     reempacotar com `release same` (o `release <nível>` empacota uma vez e cria a entrada só com o resumo).
6. **Devolver ao repositório da skill** (se a melhoria serve a qualquer usuário): depois da release, se o diff desde a
   versão instalada tocou o núcleo (`kit/`, `src/`, `reference/`, `loop/`, `SKILL.md`), rode `hades contrib suggest` com
   `--title/--why/--gains/--proof`. Passa pela guarda de nome, domínio e segredo; com acesso de escrita ao repo prepara a
   PR e mostra, sem abrir; sem acesso grava um `.html` para enviar ao mantenedor da skill. A PR só abre com confirmação do dono
   (`reference/contrib.md`, que traz também o ciclo do lado do mantenedor da skill).
7. **Entregar ao dev**: versão, o que a skill passou a fazer, caminho e sha256 do pacote. Pacotes de versões
   anteriores só se apagam com pedido do dono.

## Export do núcleo com histórico novo

Para publicar o núcleo num repositório próprio sem levar o histórico do projeto, monte um git novo só com os arquivos
rastreados da branch consolidada:

```bash
OUT=~/.claude/hades/skill-dev/_data/<unidade>/nucleo      # pasta nova, vazia
git -C <worktree> ls-files -z | rsync -a --from0 --files-from=- <worktree>/ "$OUT"/
git -C "$OUT" init -q -b main && git -C "$OUT" add -A && git -C "$OUT" commit -q -m "chore: versão <versão>"
HADES_DATA=<dados de teste> "$OUT"/kit/skill-release.sh guard   # e check, rodados do próprio export
```

O export não leva `assets/` (o que o pacote guarda ali é só de desenvolvimento), pacote de projeto, `__pycache__` nem
`.design-sync-reports/`; `ls-files` já os deixa de fora. Um commit só, sem remote e sem push: publicar
(`git remote add origin <repo>` + `git push -u origin main`) é do mantenedor da skill.

**Release depois de uma consolidação major:** se a consolidação já gravou o `VERSION` e a entrada do `CHANGELOG.md`, o
`release major` calcularia a versão seguinte (4.0.0 → 5.0.0). Use `release same [--out <dir>]`: sem bump, empacota a
`VERSION` atual e exige a entrada dela no `CHANGELOG.md` (falha logo, antes do `check`, se faltar). Confira o nome do
pacote gerado.

## Várias mudanças em paralelo (unidades da skill)

`.design-sync-reports/` é a **pasta de relatórios** do agente na sua worktree (`brief.md`, `report.md`, `questions.md`, `handoff.md`); o formato do `report.md` está em `reference/loop/report.md`.

Para delegar a evolução a agentes: `hades agent skill-new <u>` cria worktree/branch/brief/porta/workspace e
`skill-clean` arruma depois da consolidação (`reference/loop/orchestrate.md` §Evoluir a própria skill; contrato do
agente em `reference/loop/skill-dev-contract.md`).

## Golden desatualizado por mudança intencional

Regrave com `LEGADO_REGRAVA=1 bun test loop/test/ts/<arquivo>.test.ts` (golden em `loop/test/golden/legado/<arquivo>.json`, via `g.fix`/`g.confere`) e confira no diff que mudou só o que a sua mudança explica; diferença fora disso é defeito, não regrave.

## Golden que depende da máquina

O golden não pode guardar dado da máquina que o gravou (usuário, caminho, versão do git, ferramenta instalada, rede). Três saídas, nesta ordem:

- **Normalizar antes de comparar ou de gravar o hash**, como `<D>`/`@D@`: `STATE` do `bun-loop2.test.ts` troca o usuário de `plan.json` por `<U>` e não soma o conteúdo de `hooks/` e `objects/` de repositório git (os nomes dos objetos, que são o hash do conteúdo, ficam); `npmQuiet` reduz a frase de "comando não achado" do `sh` (dash × bash) e a de "fora de repositório" do git (git novo × antigo, `/tmp` no mesmo sistema de arquivos) à forma gravada.
- **Fixar a presença da ferramenta com um stub no `BIN` do teste**, quando o golden foi gravado com ela: `qrencode` (`"qr"` do `notify status` e de `/api/notify`) e `bwrap` (linha do doctor). Sem o stub o resultado seguiria o PATH da máquina.
- **Tornar a fonte determinística**: worktrees de teste do `clean` nascem com `git init --template=` e objetos sem compressão (`core.looseCompression=0`), porque o tamanho em bytes sai na tela; o doctor completo roda com `HADES_VERSION_CHECK_RAW_BASE` numa porta fechada, para não ler a versão publicada.

Teste que precisa da ferramenta de verdade (bwrap funcional, docker) é pulado por condição de ambiente, com o motivo no nome; nunca removido nem com asserção mais fraca. Antes de regravar, reproduza num container limpo (`ubuntu:24.04`, bun da versão do `bun.lock`, node, sem herdr/docker/systemd/notify-send) e confira no diff do golden que mudou só o valor normalizado.

## Nunca

- Publicar a skill em lugar versionado do repo: ela é global, em `~/.claude/skills/hades`, e serve qualquer clone.
- Empacotar com `drift` pendente ou `check` falhando.
- Citar o domínio de um projeto no núcleo (equipamentos, serviços nomeados, portas, bancos…): o texto específico vai para `env/reference/` do pacote e o núcleo diz o princípio e aponta `ref <nome>`; a guarda de domínio do `check` lê o vocabulário de `domainTerms` do perfil (`reference/projects.md` §Guarda de nome e regressão, item Guarda de domínio).
- Citar projeto no núcleo: o `check` tem a guarda de nome (termos dos perfis instalados, `reference/projects.md` §Guarda de nome e regressão); em modo relatório até o núcleo ficar limpo, depois `HADES_NAME_GUARD=strict`. A varredura inclui `loop/test/` (fixture e teste também não citam projeto); só a guarda de domínio ignora `test/`.
- Guardar na skill credencial, token, URL de túnel, IP, e-mail real ou caminho desta máquina.
