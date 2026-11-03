package dev.hades.widget;

import java.util.Collections;
import java.util.List;

/** Leitura do contrato v1 de GET /api/widget (reference/panel.md §Widget Android). Só os campos que o widget mostra. */
final class WidgetSnapshot {

    enum AgentState { ACTIVE, STOPPED, ASKING }

    static final class Agent {
        final String name;
        final String role;
        final AgentState state;
        final Long ageSeconds;
        final int openQuestions;

        Agent(String name, String role, AgentState state, Long ageSeconds, int openQuestions) {
            this.name = name;
            this.role = role;
            this.state = state;
            this.ageSeconds = ageSeconds;
            this.openQuestions = openQuestions;
        }
    }

    final int version;
    final String updatedAt;
    final boolean available;
    final int active;
    final int stopped;
    final int asking;
    final List<Agent> agents;
    /** Seções acrescentadas depois do v1 original; nulas quando o painel é antigo (ou a seção veio fora do formato). */
    final SystemSection system;
    final PrsSection prs;

    WidgetSnapshot(int version, String updatedAt, boolean available, int active, int stopped, int asking,
                   List<Agent> agents) {
        this(version, updatedAt, available, active, stopped, asking, agents, null, null);
    }

    WidgetSnapshot(int version, String updatedAt, boolean available, int active, int stopped, int asking,
                   List<Agent> agents, SystemSection system, PrsSection prs) {
        this.version = version;
        this.updatedAt = updatedAt;
        this.available = available;
        this.active = active;
        this.stopped = stopped;
        this.asking = asking;
        this.agents = Collections.unmodifiableList(agents);
        this.system = system;
        this.prs = prs;
    }
}
