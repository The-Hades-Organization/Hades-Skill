package dev.hades.widget;

import java.util.Collections;
import java.util.List;

/** Seção {@code system} do GET /api/widget: memória da máquina, infra e fila de builds. Cada parte pode faltar. */
final class SystemSection {

    static final class Memory {
        final long totalBytes;
        final long usedBytes;

        Memory(long totalBytes, long usedBytes) {
            this.totalBytes = totalBytes;
            this.usedBytes = usedBytes;
        }
    }

    static final class Infra {
        final int servicesEnabled;
        final int servicesUp;
        final int servicesRequired;
        final int servicesRequiredUp;
        final List<String> servicesDown;
        final int containersTotal;
        final int containersUp;
        final List<String> containersDown;

        Infra(int servicesEnabled, int servicesUp, int servicesRequired, int servicesRequiredUp,
              List<String> servicesDown, int containersTotal, int containersUp, List<String> containersDown) {
            this.servicesEnabled = servicesEnabled;
            this.servicesUp = servicesUp;
            this.servicesRequired = servicesRequired;
            this.servicesRequiredUp = servicesRequiredUp;
            this.servicesDown = Collections.unmodifiableList(servicesDown);
            this.containersTotal = containersTotal;
            this.containersUp = containersUp;
            this.containersDown = Collections.unmodifiableList(containersDown);
        }
    }

    static final class Queue {
        /** Nulo quando não há gate rodando. */
        final String runningLabel;
        final Long runningAgeSeconds;
        final Long runningRssBytes;
        final int waiting;

        Queue(String runningLabel, Long runningAgeSeconds, Long runningRssBytes, int waiting) {
            this.runningLabel = runningLabel;
            this.runningAgeSeconds = runningAgeSeconds;
            this.runningRssBytes = runningRssBytes;
            this.waiting = waiting;
        }
    }

    final Memory memory;
    final Infra infra;
    final Queue queue;

    SystemSection(Memory memory, Infra infra, Queue queue) {
        this.memory = memory;
        this.infra = infra;
        this.queue = queue;
    }
}
