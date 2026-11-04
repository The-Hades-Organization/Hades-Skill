# Configuração do Hades. Gerado pelo install.sh em $HADES_DATA/env.sh; todo script do kit faz `source` dele.
# Edite aqui (no env.sh instalado) para mudar caminhos; o install.sh não sobrescreve um env.sh existente.
W="__HADES_WT__"          # worktree da branch hades/local (código que roda)
D="__HADES_DATA__"        # pasta de dados do Hades (scripts instalados, estado, logs, segredos) — fora do git
GATE_LOCK="__GATE_LOCK__"   # fila de admissão de builds e gates da máquina; vazio = builds rodam direto
LOCKS="__LOCKS__"           # pasta de locks do gate-lock (onde vive gate-queue/ e hades.reservation)
NODE_BIN="__NODE_BIN__"     # node absoluto: units systemd (console, serviços) não herdam o PATH do nvm
HADES_ID="__HADES_ID__"     # instância nesta máquina: vazio = a original (hds-*, hades.slice); senão hds_<id>-*, hades_<id>.slice
export HADES_WT="$W" HADES_DATA="$D" NX_DAEMON=false
export PATH="$(dirname "$NODE_BIN"):$HOME/.local/bin:$PATH"
export RTK_RECALL_DB="$D/rtk/recall.db" RTK_TEE_DIR="$D/rtk/tee"   # saída inteira que o rtk guarda ao filtrar (reference/rtk.md)

# configurações (config.tsv + config.env, editáveis no painel → Configurações): exporta HADES_* e as chaves do plugin do projeto
[[ -f $D/config.sh ]] && source "$D/config.sh"

# gl_run <kind> --label L --cost-gb N -- <cmd...>: entra na fila do gate-lock quando ela existe; senão roda direto.
gl_run() {
  if [[ -n $GATE_LOCK && -x $GATE_LOCK ]]; then
    "$GATE_LOCK" run "$@"
  else
    while [[ $# -gt 0 && $1 != -- ]]; do shift; done
    shift
    "$@"
  fi
}
