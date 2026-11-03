package dev.hades.widget;

import android.view.View;
import android.widget.RemoteViews;

/** Widget Sistema: medidor de memória, ícones de saúde da infra e da fila; o regular detalha o que caiu e o gate. */
final class SistemaWidgetView implements WidgetView {

    @Override
    public int layout(WidgetSize size) {
        return size == WidgetSize.REGULAR ? R.layout.widget_sistema : R.layout.widget_sistema_compact;
    }

    @Override
    public void bind(RemoteViews views, WidgetInput input, WidgetSize size) {
        WidgetPresenter.Model base = input.presentStatus();
        SystemPresenter.Model model = SystemPresenter.present(
                input.lastGood == null ? null : input.lastGood.system, base);
        bindMemory(views, model);
        if (size == WidgetSize.REGULAR) {
            bindRegular(views, model);
        } else {
            views.setTextViewText(R.id.infra_short, model.infraShort);
            views.setImageViewResource(R.id.infra_icon, StateIcons.health(model.infraDown));
            views.setViewVisibility(R.id.infra_icon, visibleIfText(model.infraShort));
            views.setTextViewText(R.id.queue_short, model.queueShort);
            views.setImageViewResource(R.id.queue_icon, queueIcon(model));
            views.setViewVisibility(R.id.queue_icon, visibleIfText(model.queueShort));
        }
        views.setContentDescription(R.id.root, String.join(", ", model.memory, model.infra, model.queue));
        StatusLine.bind(views, model.status, model.problem);
    }

    private static void bindMemory(RemoteViews views, SystemPresenter.Model model) {
        boolean known = model.memoryPercent != SystemPresenter.NO_PERCENT;
        views.setTextViewText(R.id.memory_percent, known ? model.memoryPercent + "%" : "");
        views.setTextViewText(R.id.memory_detail, model.memoryDetail);
        int progress = known ? model.memoryPercent : 0;
        // a cor do preenchimento vem do recurso: três barras empilhadas, só a do nível aparece
        showOnly(views, model.memoryLevel, progress, R.id.memory_bar_ok, R.id.memory_bar_warn, R.id.memory_bar_bad);
    }

    private static void bindRegular(RemoteViews views, SystemPresenter.Model model) {
        views.setTextViewText(R.id.infra_text, model.infra);
        views.setImageViewResource(R.id.infra_icon_full, StateIcons.health(model.infraDown));
        views.setViewVisibility(R.id.infra_icon_full, visibleIfText(model.infraShort));
        views.setTextViewText(R.id.queue_text, model.queue);
        views.setImageViewResource(R.id.queue_icon_full, queueIcon(model));
        views.setViewVisibility(R.id.queue_icon_full, visibleIfText(model.queueShort));
        views.setProgressBar(R.id.queue_bar, 100, model.queueRssPercent, false);
        views.setViewVisibility(R.id.queue_bar_box, model.queueBusy ? View.VISIBLE : View.GONE);
    }

    private static void showOnly(RemoteViews views, Level level, int progress, int ok, int warn, int bad) {
        int[] ids = {ok, warn, bad};
        for (Level l : Level.values()) {
            int id = ids[l.ordinal()];
            views.setProgressBar(id, 100, progress, false);
            views.setViewVisibility(id, l == level ? View.VISIBLE : View.GONE);
        }
    }

    // sem leitura ainda não há saúde a mostrar: um ✓ ali afirmaria o que não se sabe
    private static int visibleIfText(String text) {
        return text == null || text.isEmpty() ? View.INVISIBLE : View.VISIBLE;
    }

    private static int queueIcon(SystemPresenter.Model model) {
        return model.queueBusy ? R.drawable.ic_state_run : R.drawable.ic_state_ok;
    }
}
