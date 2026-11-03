package dev.hades.widget;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Ferramenta de build do registro (roda no container, com o JDK da imagem). Uso: WidgetTool &lt;raiz&gt; check | list |
 * generate | new &lt;id&gt;. A raiz é o projeto widget/ (a cópia do build em generate; a árvore da skill em new e list).
 */
public final class WidgetTool {

    private static final String RECEIVERS_MARKER = "<!-- hades:receivers";
    private static final String JAVA_DIR = "app/src/main/java/dev/hades/widget/";
    private static final String RES_DIR = "app/src/main/res/";
    private static final int MAX_INCLUDE_DEPTH = 4;
    private static final Pattern INCLUDE = Pattern.compile("<include\\s+layout=\"@layout/([a-z0-9_]+)\"");

    private final Path root;

    private WidgetTool(Path root) {
        this.root = root;
    }

    public static void main(String[] args) {
        if (args.length < 2) {
            fail("uso: WidgetTool <raiz> check|list|generate|new <id>");
        }
        WidgetTool tool = new WidgetTool(Paths.get(args[0]));
        try {
            switch (args[1]) {
                case "check":
                    System.out.println(tool.load().size() + " widget(s) válido(s)");
                    break;
                case "list":
                    tool.list();
                    break;
                case "generate":
                    tool.generate();
                    break;
                case "new":
                    if (args.length < 3) {
                        fail("uso: build.sh new <id>");
                    }
                    tool.create(args[2]);
                    break;
                default:
                    fail("subcomando desconhecido: " + args[1]);
            }
        } catch (WidgetDeclaration.InvalidException | IOException e) {
            fail(e.getMessage());
        }
    }

    private static void fail(String message) {
        System.err.println("registro de widgets: " + message);
        System.exit(1);
    }

    private List<WidgetDeclaration> load() throws IOException, WidgetDeclaration.InvalidException {
        List<Path> files = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(root.resolve("registry"), "*.widget")) {
            stream.forEach(files::add);
        }
        files.sort(null);
        List<WidgetDeclaration> declarations = new ArrayList<>();
        Set<String> providers = new HashSet<>();
        for (Path file : files) {
            String name = file.getFileName().toString();
            String id = name.substring(0, name.length() - ".widget".length());
            WidgetDeclaration declaration = WidgetDeclaration.parse(id,
                    WidgetDeclaration.readFields(new String(Files.readAllBytes(file), StandardCharsets.UTF_8)));
            requireSources(declaration);
            if (!providers.add(declaration.provider)) {
                throw new WidgetDeclaration.InvalidException(id + ": provider " + declaration.provider
                        + " já usado por outro widget");
            }
            declarations.add(declaration);
        }
        if (declarations.isEmpty()) {
            throw new WidgetDeclaration.InvalidException("nenhum widget em registry/*.widget");
        }
        return declarations;
    }

    private void requireSources(WidgetDeclaration d) throws IOException, WidgetDeclaration.InvalidException {
        Path layout = root.resolve(RES_DIR + "layout/" + d.layout + ".xml");
        if (!Files.isRegularFile(layout)) {
            throw new WidgetDeclaration.InvalidException(d.id + ": layout ausente: " + RES_DIR + "layout/" + d.layout
                    + ".xml");
        }
        String xml = withIncludes(new String(Files.readAllBytes(layout), StandardCharsets.UTF_8), 0);
        for (String required : new String[] {"root", "refresh"}) {
            if (!xml.contains("id/" + required + "\"")) {
                throw new WidgetDeclaration.InvalidException(d.id + ": o layout " + d.layout + " precisa do id '"
                        + required + "' (o núcleo liga o toque e o botão ↻)");
            }
        }
        if (!Files.isRegularFile(root.resolve(RES_DIR + "layout/" + d.previewLayout() + ".xml"))) {
            throw new WidgetDeclaration.InvalidException(d.id + ": prévia do seletor ausente: " + RES_DIR + "layout/"
                    + d.previewLayout() + ".xml (o layout com dados de exemplo; veja templates/preview.xml)");
        }
        requireSupportedViews(d);
        if (!Files.isRegularFile(root.resolve(JAVA_DIR + d.renderer + ".java"))) {
            throw new WidgetDeclaration.InvalidException(d.id + ": renderizador ausente: " + JAVA_DIR + d.renderer
                    + ".java");
        }
        if (d.handWrittenProvider) {
            Path provider = root.resolve(JAVA_DIR + d.provider + ".java");
            if (!Files.isRegularFile(provider)
                    || !new String(Files.readAllBytes(provider), StandardCharsets.UTF_8)
                            .contains("extends CoreWidgetProvider")) {
                throw new WidgetDeclaration.InvalidException(d.id + ": provider " + d.provider
                        + " precisa existir em " + JAVA_DIR + " e estender CoreWidgetProvider");
            }
        }
    }

    /** O texto do layout com o dos trechos que ele inclui (os ids obrigatórios podem estar num {@code <include>}). */
    private String withIncludes(String xml, int depth) throws IOException, WidgetDeclaration.InvalidException {
        if (depth > MAX_INCLUDE_DEPTH) {
            throw new WidgetDeclaration.InvalidException("<include> aninhado além de " + MAX_INCLUDE_DEPTH + " níveis");
        }
        StringBuilder all = new StringBuilder(xml);
        Matcher includes = INCLUDE.matcher(xml);
        while (includes.find()) {
            Path included = root.resolve(RES_DIR + "layout/" + includes.group(1) + ".xml");
            if (!Files.isRegularFile(included)) {
                throw new WidgetDeclaration.InvalidException("<include> de layout inexistente: " + includes.group(1));
            }
            all.append('\n').append(withIncludes(new String(Files.readAllBytes(included), StandardCharsets.UTF_8),
                    depth + 1));
        }
        return all.toString();
    }

    /** Todo layout do widget (o principal e os derivados {@code <layout>_*.xml}, como compacto, prévia e linhas). */
    private void requireSupportedViews(WidgetDeclaration d) throws IOException, WidgetDeclaration.InvalidException {
        List<Path> layouts = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(root.resolve(RES_DIR + "layout"),
                d.layout + "{,_*}.xml")) {
            stream.forEach(layouts::add);
        }
        layouts.sort(null);
        for (Path file : layouts) {
            List<String> violations = LayoutPolicy.violations(new String(Files.readAllBytes(file),
                    StandardCharsets.UTF_8));
            if (!violations.isEmpty()) {
                throw new WidgetDeclaration.InvalidException(d.id + ": " + file.getFileName() + ": "
                        + String.join("; ", violations) + " (views aceitas: "
                        + String.join(", ", new java.util.TreeSet<>(LayoutPolicy.ALLOWED_VIEWS)) + ")");
            }
        }
    }

    private void list() throws IOException, WidgetDeclaration.InvalidException {
        System.out.println("id\tcélulas\tprovider\trenderizador\trótulo");
        for (WidgetDeclaration d : load()) {
            System.out.println(d.id + "\t" + d.cellsWide + "x" + d.cellsHigh + "\t" + d.provider + "\t" + d.renderer
                    + "\t" + d.label);
        }
    }

    private void generate() throws IOException, WidgetDeclaration.InvalidException {
        List<WidgetDeclaration> declarations = load();
        StringBuilder entries = new StringBuilder();
        StringBuilder receivers = new StringBuilder();
        StringBuilder strings = new StringBuilder("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<resources>\n");
        for (WidgetDeclaration d : declarations) {
            if (!d.handWrittenProvider) {
                write(JAVA_DIR + d.provider + ".java", "package dev.hades.widget;\n\n"
                        + "/** Gerado de registry/" + d.id + ".widget; não edite. */\n"
                        + "public final class " + d.provider + " extends CoreWidgetProvider {\n}\n");
            }
            write(RES_DIR + "xml/" + d.infoResource() + ".xml", info(d));
            entries.append(entries.length() == 0 ? "" : ",\n").append("            new WidgetRegistry.Entry(\"")
                    .append(d.id).append("\", ").append(d.provider).append(".class, new ").append(d.renderer)
                    .append("())");
            receivers.append(receiver(d));
            strings.append("    <string name=\"").append(d.labelResource()).append("\">").append(d.label)
                    .append("</string>\n");
        }
        write(JAVA_DIR + "WidgetCatalog.java", "package dev.hades.widget;\n\nimport java.util.Arrays;\n\n"
                + "/** Gerado de registry/*.widget no build; não edite. */\nfinal class WidgetCatalog {\n\n"
                + "    static final WidgetRegistry REGISTRY = new WidgetRegistry(Arrays.asList(\n" + entries
                + "));\n\n    private WidgetCatalog() {\n    }\n}\n");
        write(RES_DIR + "values/widgets_generated.xml", strings + "</resources>\n");
        patchManifest(receivers.toString());
        System.out.println(declarations.size() + " widget(s) gerado(s)");
    }

    private static String info(WidgetDeclaration d) {
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
                + "<appwidget-provider xmlns:android=\"http://schemas.android.com/apk/res/android\"\n"
                + "    android:configure=\"dev.hades.widget.ConfigActivity\"\n"
                + "    android:initialLayout=\"@layout/" + d.layout + "\"\n"
                + "    android:previewImage=\"@drawable/widget_preview\"\n"
                + "    android:previewLayout=\"@layout/" + d.previewLayout() + "\"\n"
                + "    android:minWidth=\"" + d.minWidthDp() + "dp\"\n"
                + "    android:minHeight=\"" + d.minHeightDp() + "dp\"\n"
                + "    android:resizeMode=\"" + d.resize + "\"\n"
                + "    android:targetCellWidth=\"" + d.cellsWide + "\"\n"
                + "    android:targetCellHeight=\"" + d.cellsHigh + "\"\n"
                + "    android:updatePeriodMillis=\"0\"\n"
                + "    android:widgetFeatures=\"reconfigurable\"\n"
                + "    android:widgetCategory=\"home_screen\" />\n";
    }

    private static String receiver(WidgetDeclaration d) {
        return "        <receiver\n"
                + "            android:name=\"." + d.provider + "\"\n"
                + "            android:exported=\"true\"\n"
                + "            android:label=\"@string/" + d.labelResource() + "\">\n"
                + "            <intent-filter>\n"
                + "                <action android:name=\"android.appwidget.action.APPWIDGET_UPDATE\" />\n"
                + "                <action android:name=\"dev.hades.widget.REFRESH\" />\n"
                + "            </intent-filter>\n"
                + "            <meta-data\n"
                + "                android:name=\"android.appwidget.provider\"\n"
                + "                android:resource=\"@xml/" + d.infoResource() + "\" />\n"
                + "        </receiver>\n";
    }

    private void patchManifest(String receivers) throws IOException, WidgetDeclaration.InvalidException {
        Path manifest = root.resolve("app/src/main/AndroidManifest.xml");
        List<String> out = new ArrayList<>();
        boolean replaced = false;
        for (String line : Files.readAllLines(manifest, StandardCharsets.UTF_8)) {
            if (line.contains(RECEIVERS_MARKER)) {
                out.add(receivers.substring(0, receivers.length() - 1));
                replaced = true;
            } else {
                out.add(line);
            }
        }
        if (!replaced) {
            throw new WidgetDeclaration.InvalidException("AndroidManifest.xml sem o marcador " + RECEIVERS_MARKER);
        }
        Files.write(manifest, (String.join("\n", out) + "\n").getBytes(StandardCharsets.UTF_8));
    }

    private void create(String id) throws IOException, WidgetDeclaration.InvalidException {
        if (!WidgetDeclaration.isValidId(id)) {
            throw new WidgetDeclaration.InvalidException("id '" + id + "' inválido: minúsculas, dígitos e _ (até "
                    + WidgetDeclaration.MAX_ID_LENGTH + " caracteres, começa por letra)");
        }
        String base = WidgetDeclaration.camel(id);
        String layout = "widget_" + id;
        String[][] files = {
            {"registry/" + id + ".widget", "widget.properties"},
            {RES_DIR + "layout/" + layout + ".xml", "layout.xml"},
            {RES_DIR + "layout/" + layout + "_preview.xml", "preview.xml"},
            {JAVA_DIR + base + "WidgetView.java", "View.java"},
        };
        for (String[] file : files) {
            if (Files.exists(root.resolve(file[0]))) {
                throw new WidgetDeclaration.InvalidException("já existe: " + file[0]);
            }
        }
        for (String[] file : files) {
            String text = new String(Files.readAllBytes(root.resolve("templates/" + file[1])), StandardCharsets.UTF_8)
                    .replace("@ID@", id).replace("@CLASS@", base).replace("@LAYOUT@", layout)
                    .replace("@LABEL_RESOURCE@", "widget_label_" + id).replace("@LABEL@", "Hades " + id);
            write(file[0], text);
            System.out.println("criado: kit/android/widget/" + file[0]);
        }
        load();
    }

    private void write(String relative, String content) throws IOException {
        Path target = root.resolve(relative);
        Files.createDirectories(target.getParent());
        Files.write(target, content.getBytes(StandardCharsets.UTF_8));
    }
}
