package dev.hades.widget;

import android.widget.RemoteViews;

/**
 * Widget @ID@: o contador de ativos e um medidor. Troque o layout e o bind pelo que este widget mostra; para um
 * tamanho compacto, crie @LAYOUT@_compact.xml e devolva-o em layout(WidgetSize.COMPACT).
 */
final class @CLASS@WidgetView implements WidgetView {

    private static final int PERCENT_MAX = 100;

    @Override
    public int layout(WidgetSize size) {
        return R.layout.@LAYOUT@;
    }

    @Override
    public void bind(RemoteViews views, WidgetInput input, WidgetSize size) {
        WidgetPresenter.Model model = input.present();
        views.setTextViewText(R.id.count_active, String.valueOf(model.activeCount));
        views.setProgressBar(R.id.value_bar, PERCENT_MAX, Math.min(PERCENT_MAX, model.activeCount * 10), false);
        StatusLine.bind(views, model);
    }
}
