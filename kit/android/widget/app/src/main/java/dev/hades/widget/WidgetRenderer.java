package dev.hades.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.SizeF;
import android.widget.RemoteViews;

import java.time.ZoneId;
import java.util.HashMap;
import java.util.Map;

/** Borda de interface do núcleo: monta os RemoteViews de qualquer widget registrado e liga os toques comuns. */
final class WidgetRenderer {

    static final String ACTION_REFRESH = "dev.hades.widget.REFRESH";

    private WidgetRenderer() {
    }

    static void renderAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        for (WidgetRegistry.Entry entry : WidgetCatalog.REGISTRY.entries()) {
            for (int id : manager.getAppWidgetIds(new ComponentName(context, entry.provider))) {
                render(context, manager, entry, id);
            }
        }
    }

    static boolean hasInstances(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        for (WidgetRegistry.Entry entry : WidgetCatalog.REGISTRY.entries()) {
            if (manager.getAppWidgetIds(new ComponentName(context, entry.provider)).length > 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * Android 12+ entrega os dois layouts e o launcher escolhe pelo tamanho; antes disso o tamanho vem das opções da
     * instância (e {@link CoreWidgetProvider} redesenha quando ela é redimensionada).
     */
    static void render(Context context, AppWidgetManager manager, WidgetRegistry.Entry entry, int widgetId) {
        StateStore state = new StateStore(context);
        long retryMinutes = Math.max(0, state.blockedUntilMillis() - System.currentTimeMillis()) / 60_000 + 1;
        WidgetInput input = new WidgetInput(state.lastGood(), state.failure(), retryMinutes, ZoneId.systemDefault());

        RemoteViews views;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Map<SizeF, RemoteViews> bySize = new HashMap<>();
            bySize.put(new SizeF(0, 0), build(context, entry, input, widgetId, WidgetSize.COMPACT));
            bySize.put(new SizeF(0, WidgetSize.REGULAR_MIN_HEIGHT_DP),
                    build(context, entry, input, widgetId, WidgetSize.REGULAR));
            views = new RemoteViews(bySize);
        } else {
            views = build(context, entry, input, widgetId, sizeOf(manager.getAppWidgetOptions(widgetId)));
        }
        manager.updateAppWidget(widgetId, views);
    }

    private static WidgetSize sizeOf(Bundle options) {
        return WidgetSize.forHeightDp(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0));
    }

    private static RemoteViews build(Context context, WidgetRegistry.Entry entry, WidgetInput input, int widgetId,
                                     WidgetSize size) {
        RemoteViews views = new RemoteViews(context.getPackageName(), entry.view.layout(size));
        entry.view.bind(views, input, size);
        views.setOnClickPendingIntent(R.id.root, openIntent(context, widgetId));
        views.setOnClickPendingIntent(R.id.refresh, refreshIntent(context, entry, widgetId));
        return views;
    }

    /** Toque abre o painel (o Chrome entrega ao PWA instalado); sem URL de painel, abre a configuração. */
    private static PendingIntent openIntent(Context context, int widgetId) {
        String panelUrl = panelUrlOrEmpty(context);
        Intent intent;
        if (panelUrl.isEmpty()) {
            intent = new Intent(context, ConfigActivity.class)
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
            return PendingIntent.getActivity(context, widgetId, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }
        intent = new Intent(Intent.ACTION_VIEW, Uri.parse(panelUrl));
        return PendingIntent.getActivity(context, widgetId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent refreshIntent(Context context, WidgetRegistry.Entry entry, int widgetId) {
        Intent intent = new Intent(context, entry.provider).setAction(ACTION_REFRESH);
        return PendingIntent.getBroadcast(context, widgetId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static String panelUrlOrEmpty(Context context) {
        try {
            String url = SecureSettings.open(context).panelUrl();
            return UrlPolicy.isAllowed(url) ? url : "";
        } catch (SecureSettings.VaultException e) {
            return "";
        }
    }
}
