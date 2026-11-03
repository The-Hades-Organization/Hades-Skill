package dev.hades.widget;

import android.widget.RemoteViews;

/**
 * O que varia por widget: o layout de cada tamanho e como o snapshot vira elementos nele. O núcleo cuida do resto
 * (busca, estado, configuração, refresh, toque que abre o painel e o botão ↻). Todo layout precisa dos ids
 * {@code root} e {@code refresh}; só valem as views que o RemoteViews suporta ({@code LayoutPolicy}).
 */
interface WidgetView {

    /** Layout para o tamanho; um widget sem versão compacta devolve o mesmo nos dois. */
    int layout(WidgetSize size);

    void bind(RemoteViews views, WidgetInput input, WidgetSize size);
}
