package dev.hades.widget;

import android.view.View;
import android.widget.RemoteViews;

/** Linha de estado comum a todo widget: cinza de apoio normalmente, cor de erro quando a última leitura falhou. */
final class StatusLine {

    private StatusLine() {
    }

    /** Exige os ids {@code status} e {@code status_problem} no layout (o molde de {@code build.sh new} já os traz). */
    static void bind(RemoteViews views, WidgetPresenter.Model model) {
        bind(views, model.status, model.problem);
    }

    static void bind(RemoteViews views, String status, boolean problem) {
        views.setTextViewText(R.id.status, status);
        views.setTextViewText(R.id.status_problem, status);
        views.setViewVisibility(R.id.status, problem ? View.GONE : View.VISIBLE);
        views.setViewVisibility(R.id.status_problem, problem ? View.VISIBLE : View.GONE);
    }
}
