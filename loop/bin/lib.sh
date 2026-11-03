# Casca bash da Hades (source, não executa): o que os scripts que ainda sobram precisam para chegar ao Bun.
# Exporta: HADES_SKILL e as funções hades_bun, dep_need e hades_ts. Projeto, qualidade, registro e Configurações
# são da CLI (`hades project`, `hades quality`, `hades agent`, `hades config`).
HADES_SKILL=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# --- CLI hades (src/cli.ts, TypeScript executado do fonte pelo Bun). Os scripts portados são wrappers: mesmo caminho,
# argumentos, saída e código de saída do original, e delegam com `hades_ts <subcomando> <args>`. Dependência externa
# faltando falha cedo (exit 69) com a instrução de instalar, lida do registro único src/deps/registry.tsv.
# HADES_LIB_BUN_ONLY=1 segue aceito (o kit/install.sh o define): hoje a casca inteira é só isto, sem ler config nem exigir repo.
hades_bun() {   # caminho do bun: HADES_BUN (testes), PATH, ~/.bun/bin; sai 1 se não há
  [[ -n ${HADES_BUN:-} ]] && { printf '%s' "$HADES_BUN"; return 0; }
  command -v bun && return 0
  [[ -x $HOME/.bun/bin/bun ]] && { printf '%s' "$HOME/.bun/bin/bun"; return 0; }
  return 1
}
dep_need() {   # dep_need <id>: sai 69 com a instrução de instalar se a dependência do registro falta (igual a `hades deps need`)
  local row cmd install purpose
  row=$(awk -F'\t' -v id="$1" '!/^#/ && $1 == id {print; exit}' "$HADES_SKILL/src/deps/registry.tsv" 2>/dev/null)
  [[ -n $row ]] || { printf 'hades: dependência %s fora do registro (src/deps/registry.tsv)\n' "$1" >&2; exit 1; }
  cmd=$(cut -f2 <<< "$row") install=$(cut -f6 <<< "$row") purpose=$(cut -f7 <<< "$row")
  if [[ $1 == bun ]]; then hades_bun > /dev/null && return 0; else command -v "$cmd" > /dev/null && return 0; fi
  printf 'hades: dependência ausente: %s (%s). Como instalar: %s\n' "$1" "$purpose" "$install" >&2
  exit 69
}
hades_ts() {   # hades_ts <subcomando> [args…]: executa a CLI TS e sai com o código dela
  local b; dep_need bun; b=$(hades_bun)
  exec "$b" "$HADES_SKILL/src/cli.ts" "$@"
}
