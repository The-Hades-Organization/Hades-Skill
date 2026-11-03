#!/usr/bin/env bash
# Roda DENTRO do container de build do widget (montado em /inside.sh por `hades widget-apk`). $1 = build | test | shots.
# Entradas: /work (= $D/android: cópia dos fontes em build/src, keystore, APK) e HADES_VERSION_NAME/CODE/SOURCES_SHA do host.
set -euo pipefail
mkdir -p /work/home /work/gradle-home
cd /work/build/src
bash tools/run.sh . generate
if [[ $1 == shots ]]; then
  # Paparazzi e Kotlin entram só nesta cópia dos fontes: o APK e os testes do dia a dia não os conhecem
  cp /work/build/shots/WidgetShotsTest.kt app/src/test/java/dev/hades/widget/
  sed -i "s/id 'com.android.application' version '8.5.2' apply false/&\n    id 'org.jetbrains.kotlin.android' version '1.9.24' apply false\n    id 'app.cash.paparazzi' version '1.3.5' apply false/" build.gradle
  sed -i "s/id 'com.android.application'/&\n    id 'org.jetbrains.kotlin.android'\n    id 'app.cash.paparazzi'/" app/build.gradle
  printf '\nandroid {\n    kotlinOptions {\n        jvmTarget = "17"\n    }\n}\n' >> app/build.gradle
  gradle --no-daemon --console=plain -q recordPaparazziDebug
  rm -rf /work/shots
  mkdir -p /work/shots
  # o Paparazzi prefixa o nome com classe e método do teste; o nome que interessa é o do que foi renderizado
  for f in app/src/test/snapshots/images/*.png; do cp "$f" "/work/shots/${f##*_allWidgets_}"; done
  echo "capturas: $(ls /work/shots | wc -l) em \$D/android/shots"
  exit 0
fi
gradle --no-daemon --console=plain -q testDebugUnitTest
echo "testes JVM: ok ($(grep -ho '<testcase ' app/build/test-results/testDebugUnitTest/*.xml | wc -l) casos)"
[[ $1 == test ]] && exit 0
gradle --no-daemon --console=plain -q assembleRelease
umask 077
if [[ ! -f /work/hades-widget.keystore ]]; then
  head -c 24 /dev/urandom | base64 > /work/keystore.pass
  keytool -genkeypair -keystore /work/hades-widget.keystore -storepass:file /work/keystore.pass \
    -alias hades-widget -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Hades Widget" > /dev/null
  echo "keystore nova gerada"
fi
zipalign -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk /work/build/aligned.apk
rm -f /work/hades-widget.apk.json   # APK e sidecar andam juntos: sem sidecar o painel não afirma a versão
apksigner sign --ks /work/hades-widget.keystore --ks-pass file:/work/keystore.pass --ks-key-alias hades-widget \
  --out /work/hades-widget.apk /work/build/aligned.apk
certs=$(apksigner verify --print-certs /work/hades-widget.apk)
echo "$certs"
cert=$(sed -n 's/^Signer #1 certificate SHA-256 digest: //p' <<< "$certs")
[[ -n $cert ]] || { echo "impressão SHA-256 do certificado não encontrada na saída do apksigner" >&2; exit 1; }
sha=$(sha256sum /work/hades-widget.apk | cut -d' ' -f1)
printf '{"versionName":"%s","versionCode":%s,"builtAt":"%s","sha256":"%s","size":%s,"certSha256":"%s","sourcesSha256":"%s"}\n' \
  "$HADES_VERSION_NAME" "$HADES_VERSION_CODE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sha" \
  "$(stat -c %s /work/hades-widget.apk)" "$cert" "$HADES_SOURCES_SHA" > /work/hades-widget.apk.json.tmp
mv /work/hades-widget.apk.json.tmp /work/hades-widget.apk.json
