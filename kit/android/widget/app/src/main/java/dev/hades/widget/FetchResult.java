package dev.hades.widget;

/** Resultado de uma leitura: o contrato lido, ou uma falha com tipo estável. Exatamente um dos dois. */
final class FetchResult {

    enum Failure { NOT_CONFIGURED, UNAUTHORIZED, WIDGET_OFF, RATE_LIMITED, NETWORK, SERVER, BAD_RESPONSE }

    final String body;
    final WidgetSnapshot snapshot;
    final Failure failure;
    final long retryAfterSeconds;

    private FetchResult(String body, WidgetSnapshot snapshot, Failure failure, long retryAfterSeconds) {
        this.body = body;
        this.snapshot = snapshot;
        this.failure = failure;
        this.retryAfterSeconds = retryAfterSeconds;
    }

    static FetchResult ok(String body, WidgetSnapshot snapshot) {
        return new FetchResult(body, snapshot, null, 0);
    }

    static FetchResult failed(Failure failure) {
        return new FetchResult(null, null, failure, 0);
    }

    static FetchResult rateLimited(long retryAfterSeconds) {
        return new FetchResult(null, null, Failure.RATE_LIMITED, retryAfterSeconds);
    }

    boolean isOk() {
        return failure == null;
    }
}
