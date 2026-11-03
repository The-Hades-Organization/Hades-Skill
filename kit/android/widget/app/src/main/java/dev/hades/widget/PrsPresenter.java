package dev.hades.widget;

import java.util.ArrayList;
import java.util.List;

/** Texto do widget PRs a partir da seção {@code prs}. Sem Android. O gate mostrado é só o CI do GitHub. */
final class PrsPresenter {

    static final int MAX_LINES = 5;
    static final String NO_DATA = "sem dados de PRs (painel desatualizado)";

    /** Uma PR: o CI vira ícone, a pendência de review outro, o número e o título ficam em colunas. */
    static final class Row {
        final PrsSection.Ci ci;
        final String number;
        final String title;
        final boolean reviewPending;

        Row(PrsSection.Ci ci, String number, String title, boolean reviewPending) {
            this.ci = ci;
            this.number = number;
            this.title = title;
            this.reviewPending = reviewPending;
        }
    }

    static final class Model {
        final String summary;
        /** Contadores do resumo; só valem com {@link #hasCounts}. */
        final int green;
        final int failingCount;
        final int running;
        final int review;
        /** Há PRs para contar: os contadores aparecem; senão aparece o {@link #summary} em texto (ou nada). */
        final boolean hasCounts;
        /** Alguma PR com CI falhando: o resumo sai em --bad. */
        final boolean failing;
        final List<String> lines;
        final List<Row> rows;
        /** Idade do dado e aviso de coleta falha; vazio quando não há o que dizer. */
        final String info;
        final String status;
        final boolean problem;

        Model(String summary, int[] counts, boolean hasCounts, List<String> lines, List<Row> rows, String info,
              String status, boolean problem) {
            this.summary = summary;
            this.green = counts[0];
            this.failingCount = counts[1];
            this.running = counts[2];
            this.review = counts[3];
            this.hasCounts = hasCounts;
            this.failing = counts[1] > 0;
            this.lines = lines;
            this.rows = rows;
            this.info = info;
            this.status = status;
            this.problem = problem;
        }
    }

    private PrsPresenter() {
    }

    static Model present(PrsSection s, WidgetPresenter.Model statusModel) {
        if (s == null) {
            return new Model("", new int[4], false, new ArrayList<>(), new ArrayList<>(), "",
                    statusModel.problem ? statusModel.status : NO_DATA, statusModel.problem);
        }
        if (!s.available) {
            String info = s.error == null ? "coletando as PRs…" : "coleta falhou, sem dado ainda";
            return new Model("", new int[4], false, new ArrayList<>(), new ArrayList<>(), info, statusModel.status,
                    statusModel.problem);
        }
        int green = 0, failing = 0, running = 0, review = 0;
        List<String> lines = new ArrayList<>();
        List<Row> rows = new ArrayList<>();
        for (PrsSection.Item it : s.items) {
            switch (it.ci) {
                case GREEN:
                    green++;
                    break;
                case FAILING:
                    failing++;
                    break;
                case RUNNING:
                    running++;
                    break;
                case NONE:
                default:
                    break;
            }
            review += it.reviewPending ? 1 : 0;
            if (lines.size() < MAX_LINES) {
                lines.add(line(it));
                rows.add(new Row(it.ci, "#" + it.number, it.title, it.reviewPending));
            }
        }
        String summary = s.items.isEmpty() ? "nenhuma PR aberta"
                : "✓ " + green + " · ✗ " + failing + " · … " + running + " · review " + review;
        return new Model(summary, new int[] {green, failing, running, review}, !s.items.isEmpty(), lines, rows, info(s),
                statusModel.status, statusModel.problem);
    }

    static String line(PrsSection.Item it) {
        return glyph(it.ci) + " #" + it.number + (it.reviewPending ? " [review] " : " ") + it.title;
    }

    private static String glyph(PrsSection.Ci ci) {
        switch (ci) {
            case GREEN:
                return "✓";
            case FAILING:
                return "✗";
            case RUNNING:
                return "…";
            case NONE:
            default:
                return "–";
        }
    }

    /** A idade do dado mostrado; com coleta falha, o último dado bom segue na tela e o aviso diz isso. */
    private static String info(PrsSection s) {
        String age = s.ageSeconds == null ? "" : "dados de " + WidgetPresenter.age(s.ageSeconds) + " atrás";
        if (s.error == null) {
            return age;
        }
        return age.isEmpty() ? "coleta falhou" : "coleta falhou · " + age;
    }
}
