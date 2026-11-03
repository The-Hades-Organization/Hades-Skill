package dev.hades.widget;

import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Um widget declarado em registry/&lt;id&gt;.widget (chave=valor). Regras do registro num lugar só: o gerador do build
 * e os testes usam esta classe. Sem Android.
 */
final class WidgetDeclaration {

    static final class InvalidException extends Exception {
        InvalidException(String message) {
            super(message);
        }
    }

    private static final Pattern ID = Pattern.compile("[a-z][a-z0-9]*(_[a-z0-9]+)*");
    private static final Pattern CLASS_NAME = Pattern.compile("[A-Z][A-Za-z0-9]*");
    private static final Pattern RESOURCE = Pattern.compile("[a-z][a-z0-9_]*");
    private static final Pattern CELLS = Pattern.compile("([1-9]|10)x([1-9]|10)");
    // fora do texto do rótulo: o que quebraria o XML, o Java ou o shell onde ele é gravado
    private static final Pattern UNSAFE_LABEL = Pattern.compile("[<>&\"'\\\\$`%@?{}\\p{Cntrl}]");
    private static final Set<String> RESIZE_MODES = new HashSet<>(
            Arrays.asList("none", "horizontal", "vertical", "horizontal|vertical"));
    private static final Set<String> KEYS = new HashSet<>(
            Arrays.asList("label", "cells", "layout", "renderer", "provider", "resize"));

    static final int MAX_ID_LENGTH = 24;
    private static final int DP_PER_CELL = 70;
    private static final int DP_CELL_MARGIN = 30;

    final String id;
    final String label;
    final int cellsWide;
    final int cellsHigh;
    final String layout;
    final String renderer;
    final String provider;
    /** true quando o provider é uma classe escrita à mão (campo provider= no arquivo); senão o build o gera. */
    final boolean handWrittenProvider;
    final String resize;

    private WidgetDeclaration(String id, String label, int cellsWide, int cellsHigh, String layout, String renderer,
                              String provider, boolean handWrittenProvider, String resize) {
        this.id = id;
        this.label = label;
        this.cellsWide = cellsWide;
        this.cellsHigh = cellsHigh;
        this.layout = layout;
        this.renderer = renderer;
        this.provider = provider;
        this.handWrittenProvider = handWrittenProvider;
        this.resize = resize;
    }

    static boolean isValidId(String id) {
        return id != null && id.length() <= MAX_ID_LENGTH && ID.matcher(id).matches();
    }

    /** "demo_x" vira "DemoX": base dos nomes derivados (renderizador, provider). */
    static String camel(String id) {
        StringBuilder out = new StringBuilder();
        for (String part : id.split("_")) {
            out.append(Character.toUpperCase(part.charAt(0))).append(part.substring(1));
        }
        return out.toString();
    }

    int minWidthDp() {
        return DP_PER_CELL * cellsWide - DP_CELL_MARGIN;
    }

    int minHeightDp() {
        return DP_PER_CELL * cellsHigh - DP_CELL_MARGIN;
    }

    /** Layout com dados de exemplo, que o seletor de widgets mostra (previewLayout); sem dado vivo, o real sairia vazio. */
    String previewLayout() {
        return layout + "_preview";
    }

    String infoResource() {
        return id + "_info";
    }

    String labelResource() {
        return "widget_label_" + id;
    }

    /** Lê as linhas chave=valor (# comenta). Chave repetida e linha sem "=" são erro. */
    static Map<String, String> readFields(String text) throws InvalidException {
        Map<String, String> fields = new LinkedHashMap<>();
        int lineNumber = 0;
        for (String raw : text.split("\n", -1)) {
            lineNumber++;
            String line = raw.trim();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            int eq = line.indexOf('=');
            if (eq <= 0) {
                throw new InvalidException("linha " + lineNumber + ": esperado chave=valor");
            }
            String key = line.substring(0, eq).trim();
            if (fields.put(key, line.substring(eq + 1).trim()) != null) {
                throw new InvalidException("linha " + lineNumber + ": chave repetida '" + key + "'");
            }
        }
        return fields;
    }

    static WidgetDeclaration parse(String id, Map<String, String> fields) throws InvalidException {
        if (!isValidId(id)) {
            throw new InvalidException("id '" + id + "' inválido: minúsculas, dígitos e _ (até " + MAX_ID_LENGTH
                    + " caracteres, começa por letra)");
        }
        for (String key : fields.keySet()) {
            if (!KEYS.contains(key)) {
                throw new InvalidException(id + ": chave desconhecida '" + key + "'");
            }
        }
        String label = required(id, fields, "label");
        if (UNSAFE_LABEL.matcher(label).find()) {
            throw new InvalidException(id + ": label com caractere não permitido");
        }
        Matcher cells = CELLS.matcher(required(id, fields, "cells"));
        if (!cells.matches()) {
            throw new InvalidException(id + ": cells deve ser LxA com 1 a 10 células (ex.: 4x2)");
        }
        String base = camel(id);
        String layout = pattern(id, fields, "layout", "widget_" + id, RESOURCE);
        String renderer = pattern(id, fields, "renderer", base + "WidgetView", CLASS_NAME);
        String provider = pattern(id, fields, "provider", base + "WidgetProvider", CLASS_NAME);
        String resize = fields.getOrDefault("resize", "horizontal|vertical");
        if (!RESIZE_MODES.contains(resize)) {
            throw new InvalidException(id + ": resize deve ser none, horizontal, vertical ou horizontal|vertical");
        }
        return new WidgetDeclaration(id, label, Integer.parseInt(cells.group(1)), Integer.parseInt(cells.group(2)),
                layout, renderer, provider, fields.containsKey("provider"), resize);
    }

    private static String required(String id, Map<String, String> fields, String key) throws InvalidException {
        String value = fields.get(key);
        if (value == null || value.isEmpty()) {
            throw new InvalidException(id + ": campo obrigatório ausente '" + key + "'");
        }
        return value;
    }

    private static String pattern(String id, Map<String, String> fields, String key, String fallback, Pattern allowed)
            throws InvalidException {
        String value = fields.getOrDefault(key, fallback);
        if (!allowed.matcher(value).matches()) {
            throw new InvalidException(id + ": " + key + " '" + value + "' fora do formato permitido");
        }
        return value;
    }
}
