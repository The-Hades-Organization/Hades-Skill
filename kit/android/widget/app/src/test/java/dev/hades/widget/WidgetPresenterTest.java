package dev.hades.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.time.ZoneOffset;

public class WidgetPresenterTest {

    private static final WidgetPresenter PRESENTER = new WidgetPresenter(ZoneOffset.UTC);

    private static WidgetSnapshot snapshot(String agentsJson, int asking) throws Exception {
        return WidgetParser.parse("{\"version\":1,\"updatedAt\":\"2026-10-26T07:33:20Z\",\"available\":true,"
                + "\"counts\":{\"active\":1,\"stopped\":1,\"asking\":" + asking + "},\"agents\":[" + agentsJson + "]}");
    }

    @Test
    public void givenAsking_whenPresented_thenHighlightedAndListedFirst() throws Exception {
        WidgetSnapshot s = snapshot("{\"name\":\"a\",\"role\":\"impl\",\"state\":\"active\",\"ageSeconds\":5600},"
                + "{\"name\":\"b\",\"role\":null,\"state\":\"asking\",\"ageSeconds\":30}", 1);
        WidgetPresenter.Model m = PRESENTER.present(s, null, 0);
        assertTrue(m.highlightAsking);
        assertEquals("? b · 30s", m.agentLines.get(0));
        assertEquals("● a (impl) · 1h33", m.agentLines.get(1));
        assertEquals("atualizado 07:33", m.status);
    }

    @Test
    public void givenNoAsking_whenPresented_thenNotHighlighted() throws Exception {
        assertFalse(PRESENTER.present(snapshot("", 0), null, 0).highlightAsking);
    }

    @Test
    public void givenFailureAfterGoodData_whenPresented_thenKeepsDataAndShowsProblem() throws Exception {
        WidgetPresenter.Model m = PRESENTER.present(snapshot("{\"name\":\"a\",\"state\":\"active\"}", 0),
                FetchResult.Failure.NETWORK, 0);
        assertEquals(1, m.agentLines.size());
        assertEquals("sem rede · último dado 07:33", m.status);
    }

    @Test
    public void givenFailure_whenPresented_thenProblemFlagged() throws Exception {
        WidgetSnapshot good = snapshot("{\"name\":\"a\",\"state\":\"active\"}", 0);
        assertTrue(PRESENTER.present(good, FetchResult.Failure.NETWORK, 0).problem);
        assertTrue(PRESENTER.present(null, FetchResult.Failure.NOT_CONFIGURED, 0).problem);
    }

    @Test
    public void givenNoFailure_whenPresented_thenNoProblem() throws Exception {
        assertFalse(PRESENTER.present(snapshot("", 0), null, 0).problem);
        assertFalse(PRESENTER.present(null, null, 0).problem);
    }

    @Test
    public void givenRateLimit_whenPresented_thenShowsMinutes() throws Exception {
        WidgetPresenter.Model m = PRESENTER.present(snapshot("", 0), FetchResult.Failure.RATE_LIMITED, 10);
        assertTrue(m.status.startsWith("muitas tentativas (429), tente em 10 min"));
    }

    @Test
    public void givenUnavailable_whenPresented_thenSemOrquestracao() throws Exception {
        WidgetSnapshot s = WidgetParser.parse(
                "{\"version\":1,\"updatedAt\":\"2026-10-26T07:33:20Z\",\"available\":false}");
        WidgetPresenter.Model m = PRESENTER.present(s, null, 0);
        assertTrue(m.status.startsWith("sem orquestração"));
        assertTrue(m.agentLines.isEmpty());
    }

    @Test
    public void givenNoDataYet_whenPresented_thenShowsFailureOrWaiting() {
        assertEquals("aguardando a primeira leitura", PRESENTER.present(null, null, 0).status);
        assertEquals("token recusado (401)", PRESENTER.present(null, FetchResult.Failure.UNAUTHORIZED, 0).status);
    }

    @Test
    public void givenManyAgents_whenPresented_thenCappedAtLayoutLines() throws Exception {
        StringBuilder agents = new StringBuilder();
        for (int i = 0; i < 9; i++) {
            agents.append(i == 0 ? "" : ",").append("{\"name\":\"a").append(i).append("\",\"state\":\"active\"}");
        }
        WidgetPresenter.Model m = PRESENTER.present(snapshot(agents.toString(), 0), null, 0);
        assertEquals(WidgetPresenter.MAX_AGENT_LINES, m.agentLines.size());
    }

    @Test
    public void givenAges_whenFormatted_thenCompact() {
        assertEquals("59s", WidgetPresenter.age(59));
        assertEquals("1min", WidgetPresenter.age(60));
        assertEquals("2h05", WidgetPresenter.age(7500));
        assertEquals("3d", WidgetPresenter.age(3 * 86400L));
    }
}
