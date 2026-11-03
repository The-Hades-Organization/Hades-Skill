package dev.hades.widget;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Regras de um layout de widget: o RemoteViews só infla um conjunto fechado de views (as demais derrubam o widget
 * na tela inicial com "Problema ao carregar o widget") e cor só vem de {@code colors.xml}. Sem Android: o build e os
 * testes usam a mesma classe.
 */
final class LayoutPolicy {

    /** Classes que o RemoteViews aceita (docs de RemoteViews, "@RemoteView"), mais Switch do Android 12. */
    static final Set<String> ALLOWED_VIEWS = new HashSet<>(Arrays.asList(
            "AdapterViewFlipper", "AnalogClock", "Button", "CheckBox", "Chronometer", "FrameLayout", "GridLayout",
            "GridView", "ImageButton", "ImageView", "LinearLayout", "ListView", "ProgressBar", "RadioButton",
            "RadioGroup", "RelativeLayout", "StackView", "Switch", "TextClock", "TextView", "ViewFlipper",
            "ViewStub"));

    /** Marcação de estrutura do inflador, não uma view. */
    private static final Set<String> STRUCTURE = new HashSet<>(Arrays.asList("include", "merge", "requestFocus"));

    private static final Pattern COMMENT = Pattern.compile("<!--.*?-->", Pattern.DOTALL);
    private static final Pattern TAG = Pattern.compile("<([A-Za-z][A-Za-z0-9_.]*)");
    private static final Pattern COLOR_LITERAL = Pattern.compile(
            "android:(\\w*[cC]olor\\w*|background|tint|backgroundTint|foreground)=\"#[0-9A-Fa-f]{3,8}\"");

    private LayoutPolicy() {
    }

    /** Problemas do layout, um texto por problema; vazio quando está de acordo. */
    static List<String> violations(String xml) {
        String body = COMMENT.matcher(xml).replaceAll("");
        List<String> found = new ArrayList<>();
        Matcher tags = TAG.matcher(body);
        while (tags.find()) {
            String tag = tags.group(1);
            if (!isSupported(tag) && !found.contains("view não suportada pelo RemoteViews: " + tag)) {
                found.add("view não suportada pelo RemoteViews: " + tag);
            }
        }
        if (COLOR_LITERAL.matcher(body).find()) {
            found.add("cor literal no layout: use @color/hades_*");
        }
        return found;
    }

    private static boolean isSupported(String tag) {
        if (STRUCTURE.contains(tag)) {
            return true;
        }
        String simple = tag;
        if (tag.startsWith("android.widget.")) {
            simple = tag.substring("android.widget.".length());
        }
        return ALLOWED_VIEWS.contains(simple) && (simple.equals(tag) || tag.startsWith("android.widget."));
    }
}
