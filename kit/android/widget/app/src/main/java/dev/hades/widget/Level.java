package dev.hades.widget;

/** Gravidade de um valor medido, que escolhe a cor do medidor e do ícone (--ok, --warn, --bad). Sem Android. */
enum Level {
    OK, WARN, BAD;

    private static final int WARN_PERCENT = 70;
    private static final int BAD_PERCENT = 85;

    static Level forPercent(int percent) {
        if (percent >= BAD_PERCENT) {
            return BAD;
        }
        return percent >= WARN_PERCENT ? WARN : OK;
    }
}
