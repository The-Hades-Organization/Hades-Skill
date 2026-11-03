package dev.hades.widget;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Borda de rede: um GET com Bearer, timeouts explícitos, sem redirecionar (o token não segue para outro destino). */
final class HttpWidgetSource {

    static final int CONNECT_TIMEOUT_MS = 10_000;
    static final int READ_TIMEOUT_MS = 15_000;
    static final int MAX_BODY_BYTES = 256 * 1024;

    FetchResult fetch(String widgetUrl, String token) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(widgetUrl).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            int status = conn.getResponseCode();
            InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String body = stream == null ? "" : readCapped(stream);
            return ResponseClassifier.classify(status, body, conn.getHeaderField("Retry-After"));
        } catch (IOException e) {
            return FetchResult.failed(FetchResult.Failure.NETWORK);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static String readCapped(InputStream in) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = stream.read(buf)) != -1) {
                if (out.size() + n > MAX_BODY_BYTES) {
                    throw new IOException("resposta maior que o teto");
                }
                out.write(buf, 0, n);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
