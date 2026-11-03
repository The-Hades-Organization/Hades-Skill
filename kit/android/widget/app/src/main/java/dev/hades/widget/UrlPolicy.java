package dev.hades.widget;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Só HTTPS; HTTP apenas para o loopback (painel local). Espelha res/xml/network_security_config.xml. */
final class UrlPolicy {

    private UrlPolicy() {
    }

    static boolean isAllowed(String raw) {
        if (raw == null) {
            return false;
        }
        URI uri;
        try {
            uri = new URI(raw.trim());
        } catch (URISyntaxException e) {
            return false;
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null) {
            return false;
        }
        scheme = scheme.toLowerCase(Locale.ROOT);
        host = host.toLowerCase(Locale.ROOT);
        if (uri.getUserInfo() != null) {
            return false;
        }
        if (scheme.equals("https")) {
            return true;
        }
        return scheme.equals("http") && (host.equals("127.0.0.1") || host.equals("localhost"));
    }
}
