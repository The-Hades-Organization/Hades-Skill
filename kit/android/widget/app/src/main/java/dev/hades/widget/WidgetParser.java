package dev.hades.widget;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Parser do contrato v1. O contrato só ganha campos: campo novo é ignorado, estado de agente desconhecido vira
 * {@code stopped} (regra da tabela do contrato). Faltar um campo que o contrato garante é erro, não zero.
 */
final class WidgetParser {

    /** Teto de agentes lidos: a resposta vem de fora, o laço não pode crescer com ela. */
    static final int MAX_AGENTS = 100;
    /** Teto de PRs e de nomes de serviço lidos, pelo mesmo motivo. */
    static final int MAX_PRS = 50;
    static final int MAX_NAMES = 50;

    static final class ParseException extends Exception {
        ParseException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private WidgetParser() {
    }

    static WidgetSnapshot parse(String json) throws ParseException {
        try {
            JSONObject root = new JSONObject(json);
            int version = root.getInt("version");
            String updatedAt = root.getString("updatedAt");
            boolean available = root.getBoolean("available");
            JSONObject counts = root.optJSONObject("counts");
            if (available && counts == null) {
                throw new JSONException("counts ausente com available=true");
            }
            return new WidgetSnapshot(
                    version,
                    updatedAt,
                    available,
                    count(counts, "active"),
                    count(counts, "stopped"),
                    count(counts, "asking"),
                    available ? agents(root.optJSONArray("agents")) : new ArrayList<>(),
                    system(root.optJSONObject("system")),
                    prs(root.optJSONObject("prs")));
        } catch (JSONException e) {
            throw new ParseException("resposta fora do contrato v1", e);
        }
    }

    /** Seção ausente (painel antigo) ou fora do formato: o widget dela mostra "sem dados", o de status segue. */
    private static SystemSection system(JSONObject o) {
        if (o == null) {
            return null;
        }
        try {
            return new SystemSection(memory(o.optJSONObject("memory")), infra(o.optJSONObject("infra")),
                    queue(o.optJSONObject("queue")));
        } catch (JSONException e) {
            return null;
        }
    }

    private static SystemSection.Memory memory(JSONObject o) throws JSONException {
        return o == null ? null : new SystemSection.Memory(o.getLong("totalBytes"), o.getLong("usedBytes"));
    }

    private static SystemSection.Infra infra(JSONObject o) throws JSONException {
        if (o == null) {
            return null;
        }
        JSONObject s = o.getJSONObject("services");
        JSONObject c = o.getJSONObject("containers");
        return new SystemSection.Infra(s.getInt("enabled"), s.getInt("up"), s.getInt("required"),
                s.getInt("requiredUp"), names(s.optJSONArray("down")), c.getInt("total"), c.getInt("up"),
                names(c.optJSONArray("down")));
    }

    private static List<String> names(JSONArray array) throws JSONException {
        List<String> out = new ArrayList<>();
        int n = array == null ? 0 : Math.min(array.length(), MAX_NAMES);
        for (int i = 0; i < n; i++) {
            out.add(array.getString(i));
        }
        return out;
    }

    private static SystemSection.Queue queue(JSONObject o) throws JSONException {
        if (o == null) {
            return null;
        }
        JSONObject running = o.optJSONObject("running");
        return new SystemSection.Queue(
                running == null ? null : running.getString("label"),
                running == null ? null : nullableLong(running, "ageSeconds"),
                running == null ? null : nullableLong(running, "rssBytes"),
                o.getInt("waiting"));
    }

    private static Long nullableLong(JSONObject o, String key) throws JSONException {
        return o.isNull(key) || !o.has(key) ? null : o.getLong(key);
    }

    private static PrsSection prs(JSONObject o) {
        if (o == null) {
            return null;
        }
        try {
            JSONArray array = o.optJSONArray("items");
            List<PrsSection.Item> items = new ArrayList<>();
            int n = array == null ? 0 : Math.min(array.length(), MAX_PRS);
            for (int i = 0; i < n; i++) {
                JSONObject p = array.getJSONObject(i);
                items.add(new PrsSection.Item(p.getInt("number"), p.optString("title", ""),
                        p.optBoolean("reviewPending", false), ci(p.optString("ci", ""))));
            }
            return new PrsSection(o.getBoolean("available"), nullableLong(o, "ageSeconds"),
                    o.isNull("error") ? null : o.optString("error", null), items);
        } catch (JSONException e) {
            return null;
        }
    }

    private static PrsSection.Ci ci(String wire) {
        switch (wire) {
            case "green":
                return PrsSection.Ci.GREEN;
            case "failing":
                return PrsSection.Ci.FAILING;
            case "running":
                return PrsSection.Ci.RUNNING;
            case "none":
            default:
                return PrsSection.Ci.NONE;
        }
    }

    private static int count(JSONObject counts, String key) throws JSONException {
        return counts == null ? 0 : counts.getInt(key);
    }

    private static List<WidgetSnapshot.Agent> agents(JSONArray array) throws JSONException {
        List<WidgetSnapshot.Agent> out = new ArrayList<>();
        if (array == null) {
            return out;
        }
        int n = Math.min(array.length(), MAX_AGENTS);
        for (int i = 0; i < n; i++) {
            JSONObject a = array.getJSONObject(i);
            out.add(new WidgetSnapshot.Agent(
                    a.getString("name"),
                    a.isNull("role") ? null : a.optString("role", null),
                    state(a.optString("state", "")),
                    a.isNull("ageSeconds") || !a.has("ageSeconds") ? null : a.getLong("ageSeconds"),
                    a.optInt("openQuestions", 0)));
        }
        return out;
    }

    private static WidgetSnapshot.AgentState state(String wire) {
        switch (wire) {
            case "active":
                return WidgetSnapshot.AgentState.ACTIVE;
            case "asking":
                return WidgetSnapshot.AgentState.ASKING;
            case "stopped":
            default:
                return WidgetSnapshot.AgentState.STOPPED;
        }
    }
}
