#!/usr/bin/env bash
# Compila e roda o WidgetTool (registro de widgets) com o JDK da imagem. Uso: run.sh <raiz do projeto widget> <subcomando> [id]
set -euo pipefail
root=$1; shift
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
javac -d "$out" "$root/app/src/main/java/dev/hades/widget/WidgetDeclaration.java" \
  "$root/app/src/main/java/dev/hades/widget/LayoutPolicy.java" "$root/tools/WidgetTool.java"
java -cp "$out" dev.hades.widget.WidgetTool "$root" "$@"
