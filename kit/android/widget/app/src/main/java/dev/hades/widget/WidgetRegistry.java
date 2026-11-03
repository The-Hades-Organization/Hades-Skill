package dev.hades.widget;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Os widgets deste APK e o renderizador de cada um. A lista vem de registry/*.widget (WidgetCatalog, gerado). */
final class WidgetRegistry {

    static final class Entry {
        final String id;
        final Class<?> provider;
        final WidgetView view;

        Entry(String id, Class<?> provider, WidgetView view) {
            this.id = id;
            this.provider = provider;
            this.view = view;
        }
    }

    private final List<Entry> entries;

    WidgetRegistry(List<Entry> entries) {
        Set<String> ids = new HashSet<>();
        Set<Class<?>> providers = new HashSet<>();
        for (Entry entry : entries) {
            if (!ids.add(entry.id)) {
                throw new IllegalArgumentException("id de widget repetido: " + entry.id);
            }
            if (!providers.add(entry.provider)) {
                throw new IllegalArgumentException("provider repetido: " + entry.provider.getName());
            }
        }
        this.entries = Collections.unmodifiableList(new ArrayList<>(entries));
    }

    List<Entry> entries() {
        return entries;
    }

    /** O widget cujo receiver é {@code provider}; classe fora do registro é erro de build, não padrão silencioso. */
    Entry forProvider(Class<?> provider) {
        for (Entry entry : entries) {
            if (entry.provider.equals(provider)) {
                return entry;
            }
        }
        throw new IllegalArgumentException("provider sem registro: " + provider.getName());
    }
}
