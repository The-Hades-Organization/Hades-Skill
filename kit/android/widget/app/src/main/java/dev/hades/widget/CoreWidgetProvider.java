package dev.hades.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/** Comportamento comum dos receivers: cada widget registrado só estende esta classe (sem corpo). */
public abstract class CoreWidgetProvider extends AppWidgetProvider {

    @Override
    public void onEnabled(Context context) {
        RefreshWorker.schedulePeriodic(context);
    }

    @Override
    public void onDisabled(Context context) {
        // o periódico serve a todos os widgets: só cessa quando o último, de qualquer tipo, sai da tela
        if (!WidgetRenderer.hasInstances(context)) {
            RefreshWorker.cancelPeriodic(context);
        }
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        WidgetRegistry.Entry entry = WidgetCatalog.REGISTRY.forProvider(getClass());
        for (int id : widgetIds) {
            WidgetRenderer.render(context, manager, entry, id);
        }
        RefreshWorker.refreshNow(context);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int widgetId, Bundle options) {
        WidgetRenderer.render(context, manager, WidgetCatalog.REGISTRY.forProvider(getClass()), widgetId);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (WidgetRenderer.ACTION_REFRESH.equals(intent.getAction())) {
            RefreshWorker.refreshNow(context);
            return;
        }
        super.onReceive(context, intent);
    }
}
