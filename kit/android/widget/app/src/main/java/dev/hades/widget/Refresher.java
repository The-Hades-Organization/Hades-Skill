package dev.hades.widget;

import android.content.Context;

/** Uma leitura completa: lê a configuração, respeita o 429, busca, guarda e redesenha os widgets. */
final class Refresher {

    private final Context context;
    private final HttpWidgetSource source;
    private final StateStore state;

    Refresher(Context context) {
        this.context = context.getApplicationContext();
        this.source = new HttpWidgetSource();
        this.state = new StateStore(context);
    }

    void refresh() {
        SecureSettings settings;
        try {
            settings = SecureSettings.open(context);
        } catch (SecureSettings.VaultException e) {
            state.recordFailure(FetchResult.Failure.NOT_CONFIGURED, 0);
            WidgetRenderer.renderAll(context);
            return;
        }
        if (!settings.isConfigured()) {
            state.recordFailure(FetchResult.Failure.NOT_CONFIGURED, 0);
        } else if (System.currentTimeMillis() >= state.blockedUntilMillis()) {
            apply(source.fetch(settings.widgetUrl(), settings.token()));
        }
        WidgetRenderer.renderAll(context);
    }

    private void apply(FetchResult result) {
        if (result.isOk()) {
            state.recordSuccess(result.body);
            return;
        }
        long blockedUntil = result.failure == FetchResult.Failure.RATE_LIMITED
                ? System.currentTimeMillis() + result.retryAfterSeconds * 1000
                : 0;
        state.recordFailure(result.failure, blockedUntil);
    }
}
