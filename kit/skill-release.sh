#!/usr/bin/env bash
# Evolução da própria skill (não é instalado em $D; rode daqui: ~/.claude/skills/hades/kit/skill-release.sh).
#
#   skill-release.sh drift                 o que foi editado à mão no kit INSTALADO ($HADES_DATA) e não voltou para
#                                          o kit da skill — todo ajuste feito no ambiente vivo tem de ser portado antes
#   skill-release.sh check                 valida o kit: bash -n, node --check, py_compile, varredura de segredos e de
#                                          caminhos/identidades da máquina, perfis válidos, regressão (loop/test e a
#                                          de cada pacote), guarda de nome de projeto (HADES_NAME_GUARD=report|strict),
#                                          guarda de domínio (HADES_DOMAIN_GUARD=report|strict; padrão strict)
#                                          e instalação numa pasta descartável
#   skill-release.sh check --regressao     roda a regressão mesmo que o HEAD já tenha uma verde registrada (reference/evolving.md §5)
#   skill-release.sh release <major|minor|patch> "<resumo>" [--out <dir>] [--plano <plan.json>]
#                                          check → sobe VERSION → garante a entrada no CHANGELOG.md → empacota
#                                          hades-skill-v<versão>.tar.gz em <dir> (padrão: ~/.claude/hades/releases) → sha256
#   skill-release.sh release same [--out <dir>]
#                                          sem bump: empacota a VERSION atual (já subida na consolidação), exigindo a
#                                          entrada dela no CHANGELOG.md. Também é o jeito de reempacotar depois de
#                                          detalhar o CHANGELOG: o release <nível> só empacota uma vez
#   --plano <plan.json>                    o plano aprovado da consolidação da skill, passado ao Cerberus (o repo da skill
#                                          não tem origin para achá-lo). Sem ele: o plano da skill (_skill/orchestration/plan.json na raiz de trabalho, do plan-approve rodado no repo da skill)
#
# Regras do versionamento (reference/evolving.md): minor = capacidade nova (serviço, dispositivo, fluxo, comando);
# patch = correção/armadilha documentada; major = quebra de contrato do kit (env.sh, layout de $D, nomes de scripts).
#
# Wrapper: a lógica está em src/commands/skill-release.ts (`hades skill-release`); este script mantém o caminho e o contrato até a 5.0.0.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hades-ts.sh"
hades_kit_ts skill-release "$@"
