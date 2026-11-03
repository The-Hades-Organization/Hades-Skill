package dev.hades.widget;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Traduz status + corpo da resposta do painel em {@link FetchResult}. O erro do painel leva um {@code code} estável;
 * o status só decide quando o corpo não traz código (proxy, túnel).
 */
final class ResponseClassifier {

    static final String CODE_WIDGET_TOKEN = "widget_token";
    static final String CODE_WIDGET_OFF = "widget_off";
    static final String CODE_RATE_LIMITED = "widget_rate_limited";

    /** Sem Retry-After legível, o painel promete 600 s (reference/panel.md). */
    static final long DEFAULT_RETRY_AFTER_SECONDS = 600;
    static final long MAX_RETRY_AFTER_SECONDS = 24 * 3600;

    private ResponseClassifier() {
    }

    static FetchResult classify(int status, String body, String retryAfterHeader) {
        if (status == 200) {
            try {
                return FetchResult.ok(body, WidgetParser.parse(body));
            } catch (WidgetParser.ParseException e) {
                return FetchResult.failed(FetchResult.Failure.BAD_RESPONSE);
            }
        }
        String code = errorCode(body);
        if (CODE_RATE_LIMITED.equals(code) || (code == null && status == 429)) {
            return FetchResult.rateLimited(retryAfter(retryAfterHeader));
        }
        if (CODE_WIDGET_TOKEN.equals(code) || (code == null && status == 401)) {
            return FetchResult.failed(FetchResult.Failure.UNAUTHORIZED);
        }
        if (CODE_WIDGET_OFF.equals(code) || (code == null && status == 404)) {
            return FetchResult.failed(FetchResult.Failure.WIDGET_OFF);
        }
        if (status >= 500) {
            return FetchResult.failed(FetchResult.Failure.SERVER);
        }
        return FetchResult.failed(FetchResult.Failure.BAD_RESPONSE);
    }

    private static String errorCode(String body) {
        try {
            return new JSONObject(body).optString("code", null);
        } catch (JSONException e) {
            return null;
        }
    }

    static long retryAfter(String header) {
        if (header == null) {
            return DEFAULT_RETRY_AFTER_SECONDS;
        }
        try {
            long seconds = Long.parseLong(header.trim());
            return Math.max(0, Math.min(seconds, MAX_RETRY_AFTER_SECONDS));
        } catch (NumberFormatException e) {
            return DEFAULT_RETRY_AFTER_SECONDS;
        }
    }
}
