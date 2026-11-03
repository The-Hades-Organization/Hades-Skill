package dev.hades.widget;

/** Quanto detalhe o widget mostra: o layout compacto cabe no tamanho mínimo, o regular acrescenta a lista. Sem Android. */
enum WidgetSize {
    COMPACT, REGULAR;

    /** Altura (dp) a partir da qual a lista de detalhe cabe sem cortar o estado; 4x2 (110 dp) é compacto, 4x3 não. */
    static final int REGULAR_MIN_HEIGHT_DP = 140;

    static WidgetSize forHeightDp(int heightDp) {
        return heightDp >= REGULAR_MIN_HEIGHT_DP ? REGULAR : COMPACT;
    }
}
