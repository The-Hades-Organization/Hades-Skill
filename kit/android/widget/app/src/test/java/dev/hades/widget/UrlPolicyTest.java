package dev.hades.widget;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UrlPolicyTest {

    @Test
    public void givenHttps_whenChecked_thenAllowed() {
        assertTrue(UrlPolicy.isAllowed("https://abc-9000.brs.devtunnels.ms/api/widget"));
    }

    @Test
    public void givenHttpOnLoopback_whenChecked_thenAllowed() {
        assertTrue(UrlPolicy.isAllowed("http://127.0.0.1:21284/api/widget"));
        assertTrue(UrlPolicy.isAllowed("http://localhost:21284/"));
    }

    @Test
    public void givenHttpElsewhere_whenChecked_thenRejected() {
        assertFalse(UrlPolicy.isAllowed("http://192.168.0.10:21284/api/widget"));
        assertFalse(UrlPolicy.isAllowed("http://example.com/"));
        assertFalse(UrlPolicy.isAllowed("http://localhost.evil.com/"));
    }

    @Test
    public void givenGarbage_whenChecked_thenRejected() {
        assertFalse(UrlPolicy.isAllowed(null));
        assertFalse(UrlPolicy.isAllowed(""));
        assertFalse(UrlPolicy.isAllowed("javascript:alert(1)"));
        assertFalse(UrlPolicy.isAllowed("ftp://example.com/"));
        assertFalse(UrlPolicy.isAllowed("https://user:pw@example.com/"));
        assertFalse(UrlPolicy.isAllowed("not a url"));
    }
}
