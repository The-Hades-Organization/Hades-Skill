package dev.hades.widget;

import java.util.List;

/** Texto do widget Sistema a partir da seção {@code system}. Sem Android: o que aparece e o destaque ficam testáveis. */
final class SystemPresenter {

    static final String NO_DATA = "sem dados do sistema (painel desatualizado)";
    private static final long GIB = 1L << 30;
    private static final int MAX_DOWN_NAMES = 3;

    static final int NO_PERCENT = -1;

    static final class Model {
        final String memory;
        /** Percentual da memória em uso; {@link #NO_PERCENT} sem dado. */
        final int memoryPercent;
        final Level memoryLevel;
        /** "12,5 / 32,0 GB": o apoio do medidor; vazio sem dado. */
        final String memoryDetail;
        final String infra;
        /** Contagens sem o rótulo ("5/6 serv · 3/3 cont"), para a coluna estreita do layout compacto. */
        final String infraShort;
        /** Algum serviço ligado ou container caiu: o ícone de infra vira erro. */
        final boolean infraDown;
        final String queue;
        /** "livre" ou "build-api 4min", mais "· +2" quando há espera. */
        final String queueShort;
        final boolean queueBusy;
        /** Quanto da memória o gate em andamento consome, 0 a 100; 0 sem gate ou sem medida. */
        final int queueRssPercent;
        final String status;
        final boolean problem;

        Model(String memory, int memoryPercent, String memoryDetail, String infra, String infraShort,
              boolean infraDown, String queue, String queueShort, boolean queueBusy, int queueRssPercent,
              String status, boolean problem) {
            this.memory = memory;
            this.memoryPercent = memoryPercent;
            this.memoryLevel = memoryPercent == NO_PERCENT ? Level.OK : Level.forPercent(memoryPercent);
            this.memoryDetail = memoryDetail;
            this.infra = infra;
            this.infraShort = infraShort;
            this.infraDown = infraDown;
            this.queue = queue;
            this.queueShort = queueShort;
            this.queueBusy = queueBusy;
            this.queueRssPercent = queueRssPercent;
            this.status = status;
            this.problem = problem;
        }
    }

    private SystemPresenter() {
    }

    static Model present(SystemSection s, WidgetPresenter.Model statusModel) {
        if (s == null) {
            return new Model("", NO_PERCENT, "", "", "", false, "", "", false, 0,
                    statusModel.problem ? statusModel.status : NO_DATA, statusModel.problem);
        }
        return new Model(memory(s.memory), percent(s.memory), memoryDetail(s.memory), infra(s.infra),
                infraShort(s.infra), isDown(s.infra), queue(s.queue), queueShort(s.queue), s.queue != null
                && s.queue.runningLabel != null, queueRssPercent(s.queue, s.memory), statusModel.status,
                statusModel.problem);
    }

    static int percent(SystemSection.Memory m) {
        if (m == null || m.totalBytes <= 0) {
            return NO_PERCENT;
        }
        return (int) Math.max(0, Math.min(100, Math.round(100.0 * m.usedBytes / m.totalBytes)));
    }

    static String memoryDetail(SystemSection.Memory m) {
        return percent(m) == NO_PERCENT ? "" : gib(m.usedBytes) + " / " + gib(m.totalBytes) + " GB";
    }

    static int queueRssPercent(SystemSection.Queue q, SystemSection.Memory m) {
        if (q == null || q.runningRssBytes == null || m == null || m.totalBytes <= 0) {
            return 0;
        }
        return (int) Math.max(0, Math.min(100, Math.round(100.0 * q.runningRssBytes / m.totalBytes)));
    }

    static String infraShort(SystemSection.Infra i) {
        if (i == null) {
            return "sem dados";
        }
        return i.servicesUp + "/" + i.servicesEnabled + " serv · " + i.containersUp + "/" + i.containersTotal + " cont";
    }

    static String queueShort(SystemSection.Queue q) {
        if (q == null) {
            return "sem dados";
        }
        StringBuilder sb = new StringBuilder();
        if (q.runningLabel == null) {
            sb.append("livre");
        } else {
            sb.append(q.runningLabel);
            if (q.runningAgeSeconds != null) {
                sb.append(' ').append(WidgetPresenter.age(q.runningAgeSeconds));
            }
        }
        if (q.waiting > 0) {
            sb.append(" · +").append(q.waiting);
        }
        return sb.toString();
    }

    static String memory(SystemSection.Memory m) {
        if (m == null || m.totalBytes <= 0) {
            return "mem sem dados";
        }
        long percent = Math.round(100.0 * m.usedBytes / m.totalBytes);
        return "mem " + gib(m.usedBytes) + " / " + gib(m.totalBytes) + " GB · " + percent + "%";
    }

    static boolean isDown(SystemSection.Infra i) {
        return i != null && (i.servicesUp < i.servicesEnabled || i.containersUp < i.containersTotal);
    }

    static String infra(SystemSection.Infra i) {
        if (i == null) {
            return "infra sem dados";
        }
        StringBuilder sb = new StringBuilder("infra ").append(i.servicesUp).append('/').append(i.servicesEnabled)
                .append(" serv · ").append(i.containersUp).append('/').append(i.containersTotal).append(" cont");
        List<String> down = new java.util.ArrayList<>(i.servicesDown);
        down.addAll(i.containersDown);
        if (!down.isEmpty()) {
            sb.append(" · caiu: ").append(String.join(", ", down.subList(0, Math.min(down.size(), MAX_DOWN_NAMES))));
            if (down.size() > MAX_DOWN_NAMES) {
                sb.append(" +").append(down.size() - MAX_DOWN_NAMES);
            }
        }
        return sb.toString();
    }

    static String queue(SystemSection.Queue q) {
        if (q == null) {
            return "fila sem dados";
        }
        StringBuilder sb = new StringBuilder();
        if (q.runningLabel == null) {
            sb.append("fila livre");
        } else {
            sb.append("fila: ").append(q.runningLabel);
            if (q.runningAgeSeconds != null) {
                sb.append(' ').append(WidgetPresenter.age(q.runningAgeSeconds));
            }
            if (q.runningRssBytes != null) {
                sb.append(" · ").append(gib(q.runningRssBytes)).append(" GB");
            }
        }
        if (q.waiting > 0) {
            sb.append(" · ").append(q.waiting).append(q.waiting == 1 ? " espera" : " esperam");
        }
        return sb.toString();
    }

    /** GiB com uma casa e vírgula (pt-BR), sem depender do locale do aparelho. */
    static String gib(long bytes) {
        long tenths = Math.round(bytes * 10.0 / GIB);
        return (tenths / 10) + "," + (tenths % 10);
    }
}
