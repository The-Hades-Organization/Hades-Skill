#!/usr/bin/env bash
# Gera o APK assinado do widget Android num container Docker descartável (JDK 17 + Android SDK + Gradle, imagem fixada
# por digest/sha256 em docker/Dockerfile). Uso: build.sh [build|test|shots|list|new <id>|image|status]; `build.sh -h` explica cada um.
# Wrapper: a lógica está em src/commands/widget-apk.ts (`hades widget-apk`); este script mantém o caminho e o contrato.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/../hades-ts.sh"
# o hades-ts.sh procura a CLI ao lado da pasta do shim (kit/android): dentro da skill, é a skill daqui
[[ -f $HERE/../../src/cli.ts ]] && export HADES_SKILL_DIR=${HADES_SKILL_DIR:-$(cd "$HERE/../.." && pwd)}
hades_kit_ts widget-apk "$@"
