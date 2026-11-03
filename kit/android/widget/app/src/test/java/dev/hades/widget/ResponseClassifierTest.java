package dev.hades.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ResponseClassifierTest {

    @Test
    public void givenRateLimitCode_whenClassified_thenHonorsRetryAfter() {
        FetchResult r = ResponseClassifier.classify(429, "{\"code\":\"widget_rate_limited\"}", "600");
        assertEquals(FetchResult.Failure.RATE_LIMITED, r.failure);
        assertEquals(600, r.retryAfterSeconds);
    }

    @Test
    public void givenRateLimitWithoutUsableHeader_whenClassified_thenDefaultsTo600() {
        assertEquals(600, ResponseClassifier.classify(429, "", null).retryAfterSeconds);
        assertEquals(600, ResponseClassifier.classify(429, "", "amanha").retryAfterSeconds);
    }

    @Test
    public void givenHugeRetryAfter_whenClassified_thenCapped() {
        assertEquals(ResponseClassifier.MAX_RETRY_AFTER_SECONDS,
                ResponseClassifier.classify(429, "", "999999999").retryAfterSeconds);
    }

    @Test
    public void givenErrorCodes_whenClassified_thenCodeBeatsStatus() {
        assertEquals(FetchResult.Failure.UNAUTHORIZED,
                ResponseClassifier.classify(401, "{\"code\":\"widget_token\"}", null).failure);
        assertEquals(FetchResult.Failure.WIDGET_OFF,
                ResponseClassifier.classify(404, "{\"code\":\"widget_off\"}", null).failure);
        assertEquals(FetchResult.Failure.WIDGET_OFF,
                ResponseClassifier.classify(503, "{\"code\":\"widget_off\"}", null).failure);
    }

    @Test
    public void givenNoCodeInBody_whenClassified_thenStatusDecides() {
        assertEquals(FetchResult.Failure.UNAUTHORIZED, ResponseClassifier.classify(401, "", null).failure);
        assertEquals(FetchResult.Failure.WIDGET_OFF, ResponseClassifier.classify(404, "<html>", null).failure);
        assertEquals(FetchResult.Failure.SERVER, ResponseClassifier.classify(502, "bad gateway", null).failure);
        assertEquals(FetchResult.Failure.BAD_RESPONSE, ResponseClassifier.classify(302, "", null).failure);
    }

    @Test
    public void givenOkWithBrokenBody_whenClassified_thenBadResponse() {
        assertEquals(FetchResult.Failure.BAD_RESPONSE, ResponseClassifier.classify(200, "{}", null).failure);
    }

    @Test
    public void givenOkWithContract_whenClassified_thenSnapshot() {
        String body = "{\"version\":1,\"updatedAt\":\"2026-10-26T07:33:20Z\",\"available\":false}";
        FetchResult r = ResponseClassifier.classify(200, body, null);
        assertTrue(r.isOk());
        assertEquals(body, r.body);
    }
}
