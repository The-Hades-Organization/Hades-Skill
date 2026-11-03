package dev.hades.widget;

import android.view.View;
import android.widget.RemoteViews;

import java.util.List;

/** Widget de status: contadores grandes e, no tamanho regular, a lista de agentes com ícone de estado. */
final class StatusWidgetView implements WidgetView {

    private static final int[] AGENT_ROWS = {R.id.agent_0, R.id.agent_1, R.id.agent_2, R.id.agent_3};
    private static final int[] AGENT_ICONS = {R.id.agent_0_icon, R.id.agent_1_icon, R.id.agent_2_icon, R.id.agent_3_icon};
    private static final int[] AGENT_NAMES = {R.id.agent_0_name, R.id.agent_1_name, R.id.agent_2_name, R.id.agent_3_name};
    private static final int[] AGENT_AGES = {R.id.agent_0_age, R.id.agent_1_age, R.id.agent_2_age, R.id.agent_3_age};

    @Override
    public int layout(WidgetSize size) {
        return size == WidgetSize.REGULAR ? R.layout.widget : R.layout.widget_compact;
    }

    @Override
    public void bind(RemoteViews views, WidgetInput input, WidgetSize size) {
        WidgetPresenter.Model model = input.present();
        bindCounters(views, model);
        if (size == WidgetSize.REGULAR) {
            bindAgents(views, model.agentRows);
        }
        StatusLine.bind(views, model);
    }

    private static void bindCounters(RemoteViews views, WidgetPresenter.Model model) {
        views.setTextViewText(R.id.count_active, count(model.active, model.activeCount));
        views.setTextViewText(R.id.count_stopped, count(model.stopped, model.stoppedCount));
        views.setTextViewText(R.id.count_asking, count(model.asking, model.askingCount));
        views.setTextViewText(R.id.count_asking_hot, count(model.asking, model.askingCount));
        views.setContentDescription(R.id.root, String.join(", ", model.active, model.stopped, model.asking));
        // o destaque (--warn) é um segundo TextView alternado por visibilidade: a cor vem do recurso, não do Java
        views.setViewVisibility(R.id.count_asking, model.highlightAsking ? View.GONE : View.VISIBLE);
        views.setViewVisibility(R.id.count_asking_hot, model.highlightAsking ? View.VISIBLE : View.GONE);
    }

    /** Sem leitura (texto vazio) o contador fica em branco em vez de mostrar um 0 que ninguém mediu. */
    private static String count(String text, int value) {
        return text.isEmpty() ? "" : String.valueOf(value);
    }

    private static void bindAgents(RemoteViews views, List<WidgetPresenter.AgentRow> rows) {
        for (int i = 0; i < AGENT_ROWS.length; i++) {
            if (i >= rows.size()) {
                views.setViewVisibility(AGENT_ROWS[i], View.GONE);
                continue;
            }
            WidgetPresenter.AgentRow row = rows.get(i);
            views.setImageViewResource(AGENT_ICONS[i], StateIcons.agent(row.state));
            views.setTextViewText(AGENT_NAMES[i], row.name);
            views.setTextViewText(AGENT_AGES[i], row.age);
            views.setViewVisibility(AGENT_ROWS[i], View.VISIBLE);
        }
    }
}
