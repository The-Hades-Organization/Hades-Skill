package dev.hades.widget;

import android.content.Context;
import android.content.SharedPreferences;

/** Último dado bom, última falha e o fim do bloqueio por 429. Nada secreto: a falha guarda só o tipo. */
final class StateStore {

    private static final String FILE = "hades_widget_state";
    private static final String KEY_LAST_GOOD = "last_good_json";
    private static final String KEY_FAILURE = "failure";
    private static final String KEY_BLOCKED_UNTIL = "blocked_until_ms";

    private final SharedPreferences prefs;

    StateStore(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    void recordSuccess(String body) {
        prefs.edit().putString(KEY_LAST_GOOD, body).remove(KEY_FAILURE).remove(KEY_BLOCKED_UNTIL).apply();
    }

    void recordFailure(FetchResult.Failure failure, long blockedUntilMillis) {
        prefs.edit().putString(KEY_FAILURE, failure.name()).putLong(KEY_BLOCKED_UNTIL, blockedUntilMillis).apply();
    }

    WidgetSnapshot lastGood() {
        String body = prefs.getString(KEY_LAST_GOOD, null);
        if (body == null) {
            return null;
        }
        try {
            return WidgetParser.parse(body);
        } catch (WidgetParser.ParseException e) {
            return null;
        }
    }

    FetchResult.Failure failure() {
        String name = prefs.getString(KEY_FAILURE, null);
        if (name == null) {
            return null;
        }
        try {
            return FetchResult.Failure.valueOf(name);
        } catch (IllegalArgumentException e) {
            return FetchResult.Failure.BAD_RESPONSE;
        }
    }

    long blockedUntilMillis() {
        return prefs.getLong(KEY_BLOCKED_UNTIL, 0);
    }
}
