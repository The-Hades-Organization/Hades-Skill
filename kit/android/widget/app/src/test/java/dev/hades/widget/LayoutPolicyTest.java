package dev.hades.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.List;

public class LayoutPolicyTest {

    private static String layout(String inner) {
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<LinearLayout xmlns:android=\"x\">" + inner + "</LinearLayout>";
    }

    @Test
    public void givenSupportedViews_whenChecked_thenNoViolation() {
        String xml = layout("<TextView android:text=\"a\"/><ImageView/><ProgressBar style=\"?android:attr/x\"/>"
                + "<include layout=\"@layout/y\"/><android.widget.Chronometer/>");
        assertTrue(LayoutPolicy.violations(xml).isEmpty());
    }

    @Test
    public void givenUnsupportedView_whenChecked_thenNamedOnce() {
        List<String> v = LayoutPolicy.violations(layout("<View/><EditText/><View/>"));
        assertEquals(2, v.size());
        assertEquals("view não suportada pelo RemoteViews: View", v.get(0));
        assertEquals("view não suportada pelo RemoteViews: EditText", v.get(1));
    }

    @Test
    public void givenCustomOrSupportLibraryView_whenChecked_thenRefused() {
        assertEquals(1, LayoutPolicy.violations(layout("<androidx.constraintlayout.widget.ConstraintLayout/>")).size());
        assertEquals(1, LayoutPolicy.violations(layout("<com.example.Fancy.TextView/>")).size());
    }

    @Test
    public void givenUnsupportedViewInsideComment_whenChecked_thenIgnored() {
        assertTrue(LayoutPolicy.violations(layout("<!-- <View/> não entra --><TextView/>")).isEmpty());
    }

    @Test
    public void givenColorLiteral_whenChecked_thenRefused() {
        List<String> v = LayoutPolicy.violations(layout("<TextView android:textColor=\"#FF0000\"/>"));
        assertEquals(1, v.size());
        assertTrue(v.get(0).contains("cor literal"));
    }

    @Test
    public void givenHashInText_whenChecked_thenNotTakenForAColor() {
        assertTrue(LayoutPolicy.violations(layout("<TextView android:text=\"#412\"/>")).isEmpty());
    }

    @Test
    public void givenColorResource_whenChecked_thenAccepted() {
        assertTrue(LayoutPolicy.violations(layout("<TextView android:textColor=\"@color/hades_ok\"/>")).isEmpty());
    }
}
