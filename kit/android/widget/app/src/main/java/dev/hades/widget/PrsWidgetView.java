package dev.hades.widget;

import android.view.View;
import android.widget.RemoteViews;

import java.util.List;

/** Widget PRs: contadores de CI e review e, no tamanho regular, uma linha por PR com o estado como ícone. */
final class PrsWidgetView implements WidgetView {

    private static final int[] ROWS = {R.id.pr_0, R.id.pr_1, R.id.pr_2, R.id.pr_3};
    private static final int[] CI_ICONS = {R.id.pr_0_ci, R.id.pr_1_ci, R.id.pr_2_ci, R.id.pr_3_ci};
    private static final int[] NUMBERS = {R.id.pr_0_number, R.id.pr_1_number, R.id.pr_2_number, R.id.pr_3_number};
    private static final int[] TITLES = {R.id.pr_0_title, R.id.pr_1_title, R.id.pr_2_title, R.id.pr_3_title};
    private static final int[] REVIEW_ICONS = {R.id.pr_0_review, R.id.pr_1_review, R.id.pr_2_review, R.id.pr_3_review};

    @Override
    public int layout(WidgetSize size) {
        return size == WidgetSize.REGULAR ? R.layout.widget_prs : R.layout.widget_prs_compact;
    }

    @Override
    public void bind(RemoteViews views, WidgetInput input, WidgetSize size) {
        WidgetPresenter.Model base = input.presentStatus();
        PrsPresenter.Model model = PrsPresenter.present(input.lastGood == null ? null : input.lastGood.prs, base);
        bindCounts(views, model);
        if (size == WidgetSize.REGULAR) {
            bindRows(views, model.rows);
        }
        views.setTextViewText(R.id.prs_info, model.info);
        views.setViewVisibility(R.id.prs_info, model.info.isEmpty() ? View.GONE : View.VISIBLE);
        StatusLine.bind(views, model.status, model.problem);
    }

    private static void bindCounts(RemoteViews views, PrsPresenter.Model model) {
        views.setTextViewText(R.id.prs_green, String.valueOf(model.green));
        views.setTextViewText(R.id.prs_failing, String.valueOf(model.failingCount));
        views.setTextViewText(R.id.prs_running, String.valueOf(model.running));
        views.setTextViewText(R.id.prs_review, String.valueOf(model.review));
        views.setViewVisibility(R.id.prs_counts, model.hasCounts ? View.VISIBLE : View.GONE);
        views.setTextViewText(R.id.prs_summary, model.summary);
        views.setViewVisibility(R.id.prs_summary, !model.hasCounts && !model.summary.isEmpty() ? View.VISIBLE : View.GONE);
        views.setContentDescription(R.id.root, model.summary);
    }

    private static void bindRows(RemoteViews views, List<PrsPresenter.Row> rows) {
        for (int i = 0; i < ROWS.length; i++) {
            if (i >= rows.size()) {
                views.setViewVisibility(ROWS[i], View.GONE);
                continue;
            }
            PrsPresenter.Row row = rows.get(i);
            views.setImageViewResource(CI_ICONS[i], StateIcons.ci(row.ci));
            views.setTextViewText(NUMBERS[i], row.number);
            views.setTextViewText(TITLES[i], row.title);
            views.setViewVisibility(REVIEW_ICONS[i], row.reviewPending ? View.VISIBLE : View.INVISIBLE);
            views.setViewVisibility(ROWS[i], View.VISIBLE);
        }
    }
}
