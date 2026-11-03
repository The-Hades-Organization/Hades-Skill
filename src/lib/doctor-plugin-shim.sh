#!/usr/bin/env bash
# Shim do doctor.sh do plugin (contrato público em bash): define ok/warn/err/have como o doctor.sh original e grava os registros
# em $REC_FILE (NUL entre registros, 0x1f entre campos). Chamado por src/commands/doctor.ts: $1 kit, $2 skill, $3 quick.
source "$1/env.sh"
set -uo pipefail
HERE=$1 SK=$2 QUICK=$3 G=Projeto
SEP=$'\x1f'
add() { printf '%s\0' "$1$SEP$2$SEP$3$SEP$4$SEP${5:-}" >> "$REC_FILE"; }
ok()   { add ok   "$1" "$2" "$3"; }
warn() { add warn "$1" "$2" "$3" "$4"; }
err()  { add error "$1" "$2" "$3" "$4"; }
have() { command -v "$1" >/dev/null 2>&1; }
source "$1/lib-checks.sh"
source "$1/plugin/doctor.sh" || warn $G plugin-doctor "o doctor.sh do plugin terminou com erro" "rode: bash -x $1/plugin/doctor.sh"
