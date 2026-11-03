package dev.hades.widget;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;

import java.io.IOException;
import java.security.GeneralSecurityException;

/** URLs e token do widget, cifrados (Android Keystore). O token só sai daqui para o cabeçalho Authorization. */
final class SecureSettings {

    static final class VaultException extends Exception {
        VaultException(Throwable cause) {
            super("cofre do aparelho indisponível", cause);
        }
    }

    private static final String FILE = "hades_widget_secure";
    private static final String KEY_WIDGET_URL = "widget_url";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_PANEL_URL = "panel_url";

    private final SharedPreferences prefs;

    private SecureSettings(SharedPreferences prefs) {
        this.prefs = prefs;
    }

    static SecureSettings open(Context context) throws VaultException {
        try {
            String masterKey = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC);
            return new SecureSettings(EncryptedSharedPreferences.create(
                    FILE, masterKey, context.getApplicationContext(),
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM));
        } catch (GeneralSecurityException | IOException e) {
            throw new VaultException(e);
        }
    }

    String widgetUrl() {
        return prefs.getString(KEY_WIDGET_URL, "");
    }

    String token() {
        return prefs.getString(KEY_TOKEN, "");
    }

    String panelUrl() {
        return prefs.getString(KEY_PANEL_URL, "");
    }

    boolean isConfigured() {
        return !widgetUrl().isEmpty() && !token().isEmpty();
    }

    void save(String widgetUrl, String token, String panelUrl) {
        prefs.edit()
                .putString(KEY_WIDGET_URL, widgetUrl)
                .putString(KEY_TOKEN, token)
                .putString(KEY_PANEL_URL, panelUrl)
                .apply();
    }
}
