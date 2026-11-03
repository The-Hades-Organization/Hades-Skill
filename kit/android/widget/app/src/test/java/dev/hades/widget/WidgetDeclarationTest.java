package dev.hades.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.util.Map;

public class WidgetDeclarationTest {

    private static WidgetDeclaration parse(String id, String text) throws WidgetDeclaration.InvalidException {
        return WidgetDeclaration.parse(id, WidgetDeclaration.readFields(text));
    }

    private static void assertInvalid(String id, String text, String messagePart) {
        try {
            parse(id, text);
            fail("esperava InvalidException");
        } catch (WidgetDeclaration.InvalidException e) {
            assertTrue(e.getMessage(), e.getMessage().contains(messagePart));
        }
    }

    @Test
    public void givenOnlyRequiredFields_whenParsed_thenNamesAreDerivedFromId() throws Exception {
        WidgetDeclaration d = parse("fila_gate", "label=Fila\ncells=2x1\n");

        assertEquals("widget_fila_gate", d.layout);
        assertEquals("FilaGateWidgetView", d.renderer);
        assertEquals("FilaGateWidgetProvider", d.provider);
        assertFalse(d.handWrittenProvider);
        assertEquals("horizontal|vertical", d.resize);
        assertEquals("fila_gate_info", d.infoResource());
        assertEquals("widget_label_fila_gate", d.labelResource());
    }

    @Test
    public void givenExplicitProvider_whenParsed_thenItIsHandWrittenAndKeepsTheName() throws Exception {
        WidgetDeclaration d = parse("status",
                "# comentário\nlabel=Hades\ncells=4x2\nlayout=widget\nrenderer=StatusWidgetView\n"
                        + "provider=HadesWidgetProvider\n");

        assertTrue(d.handWrittenProvider);
        assertEquals("HadesWidgetProvider", d.provider);
        assertEquals("widget", d.layout);
    }

    @Test
    public void givenCells_whenParsed_thenMinSizeFollowsTheLauncherGrid() throws Exception {
        WidgetDeclaration d = parse("status", "label=Hades\ncells=4x2\n");

        assertEquals(250, d.minWidthDp());
        assertEquals(110, d.minHeightDp());
    }

    @Test
    public void givenInvalidIds_whenChecked_thenRejected() {
        assertTrue(WidgetDeclaration.isValidId("a"));
        assertTrue(WidgetDeclaration.isValidId("demo_2"));
        assertFalse(WidgetDeclaration.isValidId(null));
        assertFalse(WidgetDeclaration.isValidId(""));
        assertFalse(WidgetDeclaration.isValidId("Demo"));
        assertFalse(WidgetDeclaration.isValidId("2demo"));
        assertFalse(WidgetDeclaration.isValidId("demo_"));
        assertFalse(WidgetDeclaration.isValidId("de__mo"));
        assertFalse(WidgetDeclaration.isValidId("../etc"));
        assertFalse(WidgetDeclaration.isValidId("demo;rm"));
        assertFalse(WidgetDeclaration.isValidId("a".repeat(WidgetDeclaration.MAX_ID_LENGTH + 1)));
        assertTrue(WidgetDeclaration.isValidId("a".repeat(WidgetDeclaration.MAX_ID_LENGTH)));
    }

    @Test
    public void givenInvalidId_whenParsed_thenRejected() {
        assertInvalid("Bad Id", "label=X\ncells=1x1\n", "inválido");
    }

    @Test
    public void givenMissingRequiredField_whenParsed_thenNamesTheField() {
        assertInvalid("demo", "cells=2x2\n", "'label'");
        assertInvalid("demo", "label=X\n", "'cells'");
        assertInvalid("demo", "label=\ncells=2x2\n", "'label'");
    }

    @Test
    public void givenBadCells_whenParsed_thenRejected() {
        assertInvalid("demo", "label=X\ncells=0x2\n", "cells");
        assertInvalid("demo", "label=X\ncells=11x2\n", "cells");
        assertInvalid("demo", "label=X\ncells=4\n", "cells");
        assertInvalid("demo", "label=X\ncells=4x2x1\n", "cells");
    }

    @Test
    public void givenUnknownKey_whenParsed_thenRejectedSoTyposDoNotPassSilently() {
        assertInvalid("demo", "label=X\ncells=2x2\nlayuot=widget\n", "layuot");
    }

    @Test
    public void givenUnsafeValues_whenParsed_thenRejected() {
        assertInvalid("demo", "label=<b>X\ncells=2x2\n", "label");
        assertInvalid("demo", "label=X&Y\ncells=2x2\n", "label");
        assertInvalid("demo", "label=$(x)\ncells=2x2\n", "label");
        assertInvalid("demo", "label=X\ncells=2x2\nrenderer=../Evil\n", "renderer");
        assertInvalid("demo", "label=X\ncells=2x2\nprovider=lower\n", "provider");
        assertInvalid("demo", "label=X\ncells=2x2\nlayout=Widget-1\n", "layout");
        assertInvalid("demo", "label=X\ncells=2x2\nresize=diagonal\n", "resize");
    }

    @Test
    public void givenAccentedLabel_whenParsed_thenAccepted() throws Exception {
        assertEquals("Fila de gates · ação", parse("demo", "label=Fila de gates · ação\ncells=2x2\n").label);
    }

    @Test
    public void givenMalformedLines_whenRead_thenRejected() {
        assertInvalid("demo", "label\ncells=2x2\n", "chave=valor");
        assertInvalid("demo", "label=X\nlabel=Y\ncells=2x2\n", "repetida");
    }

    @Test
    public void givenBlankLinesAndComments_whenRead_thenIgnored() throws Exception {
        Map<String, String> fields = WidgetDeclaration.readFields("\n# nota\n  label = A \n\ncells=1x1\n");

        assertEquals("A", fields.get("label"));
        assertEquals(2, fields.size());
    }

    @Test
    public void givenIdWithUnderscores_whenCamelled_thenEachPartIsCapitalised() {
        assertEquals("Demo", WidgetDeclaration.camel("demo"));
        assertEquals("FilaGate2", WidgetDeclaration.camel("fila_gate_2"));
    }
}
