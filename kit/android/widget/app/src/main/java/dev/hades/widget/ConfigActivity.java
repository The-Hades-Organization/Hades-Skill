package dev.hades.widget;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;
import android.widget.EditText;
import android.widget.Toast;

/** Configuração do widget: URL do widget, token (hdw_…) e URL do painel para o toque. */
public final class ConfigActivity extends Activity {

    private SecureSettings settings;
    private EditText widgetUrl;
    private EditText token;
    private EditText panelUrl;
    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setResult(RESULT_CANCELED);
        setContentView(R.layout.config);
        Bundle extras = getIntent().getExtras();
        if (extras != null) {
            widgetId = extras.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        }
        widgetUrl = findViewById(R.id.widget_url);
        token = findViewById(R.id.token);
        panelUrl = findViewById(R.id.panel_url);
        try {
            settings = SecureSettings.open(this);
        } catch (SecureSettings.VaultException e) {
            toast(R.string.err_vault);
            finish();
            return;
        }
        widgetUrl.setText(settings.widgetUrl());
        panelUrl.setText(settings.panelUrl());
        if (!settings.token().isEmpty()) {
            token.setHint(R.string.config_token_kept);
        }
        findViewById(R.id.save).setOnClickListener(v -> save());
    }

    private void save() {
        String newWidgetUrl = widgetUrl.getText().toString().trim();
        String newPanelUrl = panelUrl.getText().toString().trim();
        String newToken = token.getText().toString().trim();
        if (newToken.isEmpty()) {
            newToken = settings.token();
        }
        if (!UrlPolicy.isAllowed(newWidgetUrl)) {
            toast(R.string.err_widget_url);
            return;
        }
        if (!newPanelUrl.isEmpty() && !UrlPolicy.isAllowed(newPanelUrl)) {
            toast(R.string.err_panel_url);
            return;
        }
        if (newToken.isEmpty()) {
            toast(R.string.err_token);
            return;
        }
        settings.save(newWidgetUrl, newToken, newPanelUrl);
        RefreshWorker.schedulePeriodic(this);
        RefreshWorker.refreshNow(this);
        setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
        finish();
    }

    private void toast(int message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }
}
