# Defaults do loop (destraváveis por pedido explícito)

Valem sempre, mas cedem a um pedido explícito — que **deve aparecer no relatório** como decisão do
dono, com a consequência declarada:

- **Tokens** (Configurações → Modelos por papel, Contexto e espera; `reference/loop/tokens.md`): modelo e esforço por
  papel; sessão nova por fase; teto de contexto por papel aplicado por hook; nenhuma espera por polling (o hook barra;
  esperas pelo `hades wait` em segundo plano); estacionar com `handoff.md` antes de esperar longe.
- **Modo orquestrado** (`--orchestrated`): o agente só roda a checagem de tipos, e o gate roda uma vez, no ponto de
  consolidação ou no topo da stack, só com o que o diff afeta (`reference/loop/gates.md` §1.0). As faixas do projeto
  valem fora dele.
- **Lint, build e teste rodam em sequência**, um projeto e um comando por vez. Nunca em paralelo
  dentro da sessão.
- **Todo comando de gate passa por `gate-lock.sh run`** (`reference/loop/gates.md` §3.2) — inclusive checagem
  "rápida" que chama o gerenciador de build por baixo (um script de lint pode ser um teste). Rodar fora do wrapper fura
  a fila **e** a conta de memória das outras sessões: o que a máquina tem de RAM não escalona como
  CPU, e o excesso vira travamento, não lentidão. Gate de vários passos vai numa concessão
  `run gate`. Só faz sentido destravar quando o dono afirma que não há outra sessão rodando.
- **Regras de código e de comentário do projeto** (`refs.invariants`/`rules.docs`): o loop não gera o ruído que ele
  existe para eliminar e não narra o próprio fix.
- **Uma PR por tick** nos modos que escrevem.
- Subagentes só em quatro lugares: fan-out pré-PR (`/review-agents`), ondas de correção por arquivos
  disjuntos, o re-review único do inbox, e o paralelo do modo review. Em nenhum outro ponto.

#### Overrides declarados

Skill de review avulsa que diga "push nunca" ou mande publicar com `--approve`/`--request-changes` **perde para esta
no seu escopo**, por decisão explícita do dono: push na branch de trabalho é autorizado, e publicação de review sai
sempre como comentário (`event: COMMENT`), nunca aprovando nem rejeitando. Merge segue manual. Overrides de skill de
card (criar sem confirmar) vivem no pacote (`refs.invariants`).
