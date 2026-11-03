package dev.hades.widget;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;

/** Decide o que o widget escreve (texto e destaque) a partir do último dado bom e da última falha. Sem Android. */
final class WidgetPresenter {

    static final int MAX_AGENT_LINES = 4;

    /** Uma linha de agente: o estado vira ícone, o nome com o papel e a idade ficam em colunas. */
    static final class AgentRow {
        final WidgetSnapshot.AgentState state;
        final String name;
        /** Vazio quando o painel não informou desde quando. */
        final String age;

        AgentRow(WidgetSnapshot.AgentState state, String name, String age) {
            this.state = state;
            this.name = name;
            this.age = age;
        }
    }

    static final class Model {
        final String active;
        final String stopped;
        final String asking;
        final int activeCount;
        final int stoppedCount;
        final int askingCount;
        final boolean highlightAsking;
        final List<String> agentLines;
        final List<AgentRow> agentRows;
        final String status;
        /** A última leitura falhou (ou o dado não está disponível): a linha de estado sai na cor de erro. */
        final boolean problem;

        Model(String active, String stopped, String asking, int[] counts, boolean highlightAsking,
              List<String> agentLines, List<AgentRow> agentRows, String status, boolean problem) {
            this.active = active;
            this.stopped = stopped;
            this.asking = asking;
            this.activeCount = counts[0];
            this.stoppedCount = counts[1];
            this.askingCount = counts[2];
            this.highlightAsking = highlightAsking;
            this.agentLines = agentLines;
            this.agentRows = agentRows;
            this.status = status;
            this.problem = problem;
        }
    }

    private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("HH:mm");

    private final ZoneId zone;

    WidgetPresenter(ZoneId zone) {
        this.zone = zone;
    }

    /** {@code lastGood} e {@code failure} podem coexistir: a falha não apaga o último dado bom. */
    Model present(WidgetSnapshot lastGood, FetchResult.Failure failure, long retryAfterMinutes) {
        String problem = failure == null ? null : failureText(failure, retryAfterMinutes);
        if (lastGood == null) {
            return emptyModel(problem == null ? "aguardando a primeira leitura" : problem, problem != null);
        }
        if (!lastGood.available) {
            return emptyModel(join("sem orquestração", problem, lastGood), problem != null);
        }
        return new Model(
                "● " + lastGood.active + " ativos",
                "○ " + lastGood.stopped + " parados",
                "? " + lastGood.asking + " perguntando",
                new int[] {lastGood.active, lastGood.stopped, lastGood.asking},
                lastGood.asking > 0,
                agentLines(lastGood),
                agentRows(lastGood),
                join(null, problem, lastGood),
                problem != null);
    }

    /** Só a linha de estado (o widget de outra seção não depende de orquestração, então não há "sem orquestração"). */
    Model presentStatus(WidgetSnapshot lastGood, FetchResult.Failure failure, long retryAfterMinutes) {
        String problem = failure == null ? null : failureText(failure, retryAfterMinutes);
        String status = lastGood == null ? (problem == null ? "aguardando a primeira leitura" : problem)
                : join(null, problem, lastGood);
        return emptyModel(status, problem != null);
    }

    private static Model emptyModel(String status, boolean problem) {
        return new Model("", "", "", new int[3], false, new ArrayList<>(), new ArrayList<>(), status, problem);
    }

    /** Os agentes a mostrar: perguntando primeiro, depois ativos, depois parados, até o teto. */
    private static List<WidgetSnapshot.Agent> shownAgents(WidgetSnapshot snapshot) {
        List<WidgetSnapshot.Agent> shown = new ArrayList<>();
        for (WidgetSnapshot.AgentState wanted : new WidgetSnapshot.AgentState[] {
                WidgetSnapshot.AgentState.ASKING, WidgetSnapshot.AgentState.ACTIVE, WidgetSnapshot.AgentState.STOPPED}) {
            for (WidgetSnapshot.Agent a : snapshot.agents) {
                if (a.state == wanted && shown.size() < MAX_AGENT_LINES) {
                    shown.add(a);
                }
            }
        }
        return shown;
    }

    private static List<String> agentLines(WidgetSnapshot snapshot) {
        List<String> lines = new ArrayList<>();
        for (WidgetSnapshot.Agent a : shownAgents(snapshot)) {
            lines.add(agentLine(a));
        }
        return lines;
    }

    private static List<AgentRow> agentRows(WidgetSnapshot snapshot) {
        List<AgentRow> rows = new ArrayList<>();
        for (WidgetSnapshot.Agent a : shownAgents(snapshot)) {
            String name = a.role == null || a.role.isEmpty() ? a.name : a.name + " (" + a.role + ")";
            rows.add(new AgentRow(a.state, name, a.ageSeconds == null ? "" : age(a.ageSeconds)));
        }
        return rows;
    }

    private static String agentLine(WidgetSnapshot.Agent a) {
        String glyph = a.state == WidgetSnapshot.AgentState.ASKING ? "?"
                : a.state == WidgetSnapshot.AgentState.ACTIVE ? "●" : "○";
        StringBuilder sb = new StringBuilder(glyph).append(' ').append(a.name);
        if (a.role != null && !a.role.isEmpty()) {
            sb.append(" (").append(a.role).append(')');
        }
        if (a.ageSeconds != null) {
            sb.append(" · ").append(age(a.ageSeconds));
        }
        return sb.toString();
    }

    static String age(long seconds) {
        if (seconds < 60) {
            return seconds + "s";
        }
        long minutes = seconds / 60;
        if (minutes < 60) {
            return minutes + "min";
        }
        long hours = minutes / 60;
        if (hours < 48) {
            return hours + "h" + String.format("%02d", minutes % 60);
        }
        return (hours / 24) + "d";
    }

    private String join(String lead, String problem, WidgetSnapshot lastGood) {
        List<String> parts = new ArrayList<>();
        if (lead != null) {
            parts.add(lead);
        }
        if (problem != null) {
            parts.add(problem);
        }
        parts.add((problem == null ? "atualizado " : "último dado ") + clock(lastGood.updatedAt));
        return String.join(" · ", parts);
    }

    private String clock(String updatedAtUtc) {
        try {
            return CLOCK.format(Instant.parse(updatedAtUtc).atZone(zone));
        } catch (DateTimeParseException e) {
            return "?";
        }
    }

    private static String failureText(FetchResult.Failure failure, long retryAfterMinutes) {
        switch (failure) {
            case NOT_CONFIGURED:
                return "toque para configurar";
            case UNAUTHORIZED:
                return "token recusado (401)";
            case WIDGET_OFF:
                return "widget desligado no painel (404)";
            case RATE_LIMITED:
                return "muitas tentativas (429), tente em " + Math.max(1, retryAfterMinutes) + " min";
            case NETWORK:
                return "sem rede";
            case SERVER:
                return "painel com erro";
            case BAD_RESPONSE:
            default:
                return "resposta inesperada";
        }
    }
}
