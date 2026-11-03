package dev.hades.widget;

import java.time.ZoneId;

/** O que o núcleo entrega a cada {@link WidgetView}: o último dado bom, a última falha e o fuso do aparelho. */
final class WidgetInput {

    /** Nulo enquanto não houve leitura boa. */
    final WidgetSnapshot lastGood;
    /** Nulo quando a última leitura foi boa. */
    final FetchResult.Failure failure;
    final long retryMinutes;
    final ZoneId zone;

    WidgetInput(WidgetSnapshot lastGood, FetchResult.Failure failure, long retryMinutes, ZoneId zone) {
        this.lastGood = lastGood;
        this.failure = failure;
        this.retryMinutes = retryMinutes;
        this.zone = zone;
    }

    /** Só a linha de estado, para widgets que não dependem da orquestração. */
    WidgetPresenter.Model presentStatus() {
        return new WidgetPresenter(zone).presentStatus(lastGood, failure, retryMinutes);
    }

    WidgetPresenter.Model present() {
        return new WidgetPresenter(zone).present(lastGood, failure, retryMinutes);
    }
}
