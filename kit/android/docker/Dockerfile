# Imagem de build do widget Android: JDK 17 + Android SDK + Gradle, tudo fixado.
# Base fixada por digest do índice multi-arquitetura; os dois zips, por sha256 (o do cmdline-tools confere com o sha1 de
# repository2-3.xml da Google).
# Subir versão = mudar aqui; o build.sh refaz a imagem (a tag leva o hash deste arquivo).
FROM eclipse-temurin:17-jdk-jammy@sha256:73ed442231ec66cfe48cae0b263ce619a75ab96d162ab325f38fc0a269ee3aab

ARG CMDLINE_TOOLS_ZIP=commandlinetools-linux-11076708_latest.zip
ARG CMDLINE_TOOLS_SHA256=2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258
ARG GRADLE_VERSION=8.7
ARG GRADLE_SHA256=544c35d6bd849ae8a5ed0bcea39ba677dc40f49df7d1835561582da2009b961d
ARG PLATFORM=android-34
ARG BUILD_TOOLS=34.0.0

ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk GRADLE_HOME=/opt/gradle
ENV PATH=/opt/gradle/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/build-tools/${BUILD_TOOLS}:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends unzip curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/gradle.zip "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
 && echo "${GRADLE_SHA256}  /tmp/gradle.zip" | sha256sum -c - \
 && unzip -q /tmp/gradle.zip -d /opt && mv /opt/gradle-${GRADLE_VERSION} /opt/gradle \
 && curl -fsSL -o /tmp/cmdline.zip "https://dl.google.com/android/repository/${CMDLINE_TOOLS_ZIP}" \
 && echo "${CMDLINE_TOOLS_SHA256}  /tmp/cmdline.zip" | sha256sum -c - \
 && mkdir -p /opt/android-sdk/cmdline-tools && unzip -q /tmp/cmdline.zip -d /opt/android-sdk/cmdline-tools \
 && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
 && rm /tmp/gradle.zip /tmp/cmdline.zip \
 && yes | sdkmanager --licenses > /dev/null \
 && sdkmanager "platforms;${PLATFORM}" "build-tools;${BUILD_TOOLS}" "platform-tools" > /dev/null \
 && chmod -R a+rwX /opt/android-sdk

WORKDIR /work
