package dev.hades.widget;

import java.util.Collections;
import java.util.List;

/** Seção {@code prs} do GET /api/widget: as PRs abertas fora de draft e o estado do CI do GitHub. */
final class PrsSection {

    /** Valor desconhecido do fio vira {@link #NONE}: o contrato só ganha valores. */
    enum Ci { GREEN, FAILING, RUNNING, NONE }

    static final class Item {
        final int number;
        final String title;
        final boolean reviewPending;
        final Ci ci;

        Item(int number, String title, boolean reviewPending, Ci ci) {
            this.number = number;
            this.title = title;
            this.reviewPending = reviewPending;
            this.ci = ci;
        }
    }

    /** Falso até o painel concluir a primeira coleta; então não há itens nem idade. */
    final boolean available;
    /** Segundos desde a última coleta boa; nulo sem coleta. */
    final Long ageSeconds;
    /** Código estável do último erro de coleta (o dado mostrado é o último bom); nulo quando a coleta deu certo. */
    final String error;
    final List<Item> items;

    PrsSection(boolean available, Long ageSeconds, String error, List<Item> items) {
        this.available = available;
        this.ageSeconds = ageSeconds;
        this.error = error;
        this.items = Collections.unmodifiableList(items);
    }
}
