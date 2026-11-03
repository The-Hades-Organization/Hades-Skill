package dev.hades.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.widget.RemoteViews;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

public class WidgetRegistryTest {

    private static final class ProviderA {
    }

    private static final class ProviderB {
    }

    private static final class StubView implements WidgetView {
        private final int layout;

        StubView(int layout) {
            this.layout = layout;
        }

        @Override
        public int layout(WidgetSize size) {
            return layout;
        }

        @Override
        public void bind(RemoteViews views, WidgetInput input, WidgetSize size) {
        }
    }

    @Test
    public void givenTwoWidgets_whenRoutedByProvider_thenEachGetsItsOwnView() {
        StubView viewA = new StubView(1);
        StubView viewB = new StubView(2);
        WidgetRegistry registry = new WidgetRegistry(Arrays.asList(
                new WidgetRegistry.Entry("a", ProviderA.class, viewA),
                new WidgetRegistry.Entry("b", ProviderB.class, viewB)));

        assertSame(viewA, registry.forProvider(ProviderA.class).view);
        assertSame(viewB, registry.forProvider(ProviderB.class).view);
        assertEquals("b", registry.forProvider(ProviderB.class).id);
    }

    @Test
    public void givenUnregisteredProvider_whenRouted_thenFailsLoudly() {
        WidgetRegistry registry = new WidgetRegistry(
                Collections.singletonList(new WidgetRegistry.Entry("a", ProviderA.class, new StubView(1))));

        try {
            registry.forProvider(ProviderB.class);
            fail("esperava IllegalArgumentException");
        } catch (IllegalArgumentException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("ProviderB"));
        }
    }

    @Test
    public void givenRepeatedId_whenBuilt_thenRejected() {
        try {
            new WidgetRegistry(Arrays.asList(
                    new WidgetRegistry.Entry("a", ProviderA.class, new StubView(1)),
                    new WidgetRegistry.Entry("a", ProviderB.class, new StubView(2))));
            fail("esperava IllegalArgumentException");
        } catch (IllegalArgumentException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("id"));
        }
    }

    @Test
    public void givenRepeatedProvider_whenBuilt_thenRejected() {
        try {
            new WidgetRegistry(Arrays.asList(
                    new WidgetRegistry.Entry("a", ProviderA.class, new StubView(1)),
                    new WidgetRegistry.Entry("b", ProviderA.class, new StubView(2))));
            fail("esperava IllegalArgumentException");
        } catch (IllegalArgumentException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("provider"));
        }
    }

    @Test
    public void givenGeneratedCatalog_whenRoutingTheCurrentWidget_thenStatusViewServesHadesProvider() {
        WidgetRegistry.Entry entry = WidgetCatalog.REGISTRY.forProvider(HadesWidgetProvider.class);

        assertEquals("status", entry.id);
        assertTrue(entry.view instanceof StatusWidgetView);
        assertEquals(R.layout.widget, entry.view.layout(WidgetSize.REGULAR));
    }
}
