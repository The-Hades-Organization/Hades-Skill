package dev.hades.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.time.ZoneOffset;

public class VisualModelTest {

    private static final WidgetPresenter PRESENTER = new WidgetPresenter(ZoneOffset.UTC);
    private static final String HEAD = "{\"version\":1,\"updatedAt\":\"2026-10-26T07:33:20Z\",\"available\":true,"
            + "\"counts\":{\"active\":2,\"stopped\":1,\"asking\":1},\"agents\":[";

    private static WidgetSnapshot parse(String agents, String sections) throws Exception {
        return WidgetParser.parse(HEAD + agents + "]" + sections + "}");
    }

    private static String system(long total, long used, String queue) {
        return ",\"system\":{\"memory\":{\"totalBytes\":" + total + ",\"usedBytes\":" + used + "},"
                + "\"infra\":{\"services\":{\"enabled\":2,\"up\":2,\"required\":1,\"requiredUp\":1,\"down\":[]},"
                + "\"containers\":{\"total\":1,\"up\":1,\"down\":[]}}," + queue + "}";
    }

    @Test
    public void givenHeight_whenSizeChosen_thenDetailOnlyFromTheRegularThreshold() {
        assertEquals(WidgetSize.COMPACT, WidgetSize.forHeightDp(0));
        assertEquals(WidgetSize.COMPACT, WidgetSize.forHeightDp(WidgetSize.REGULAR_MIN_HEIGHT_DP - 1));
        assertEquals(WidgetSize.REGULAR, WidgetSize.forHeightDp(WidgetSize.REGULAR_MIN_HEIGHT_DP));
    }

    @Test
    public void givenPercent_whenLeveled_thenWarnAndBadStartAtTheirLimits() {
        assertEquals(Level.OK, Level.forPercent(69));
        assertEquals(Level.WARN, Level.forPercent(70));
        assertEquals(Level.WARN, Level.forPercent(84));
        assertEquals(Level.BAD, Level.forPercent(85));
    }

    @Test
    public void givenAgents_whenPresented_thenCountsAndRowsFollowTheTextOrder() throws Exception {
        WidgetSnapshot s = parse("{\"name\":\"a\",\"role\":\"impl\",\"state\":\"active\",\"ageSeconds\":5600},"
                + "{\"name\":\"b\",\"role\":null,\"state\":\"asking\"}", "");
        WidgetPresenter.Model m = PRESENTER.present(s, null, 0);
        assertEquals(2, m.activeCount);
        assertEquals(1, m.stoppedCount);
        assertEquals(1, m.askingCount);
        assertEquals(WidgetSnapshot.AgentState.ASKING, m.agentRows.get(0).state);
        assertEquals("b", m.agentRows.get(0).name);
        assertEquals("", m.agentRows.get(0).age);
        assertEquals("a (impl)", m.agentRows.get(1).name);
        assertEquals("1h33", m.agentRows.get(1).age);
    }

    @Test
    public void givenNoReading_whenPresented_thenCountersAreEmptyNotZero() {
        WidgetPresenter.Model m = PRESENTER.present(null, null, 0);
        assertEquals("", m.active);
        assertTrue(m.agentRows.isEmpty());
    }

    @Test
    public void givenMemory_whenPresented_thenPercentLevelAndDetail() throws Exception {
        long gib = 1L << 30;
        WidgetSnapshot s = parse("", system(10 * gib, 9 * gib, "\"queue\":{\"running\":null,\"waiting\":0}"));
        SystemPresenter.Model m = SystemPresenter.present(s.system, PRESENTER.presentStatus(s, null, 0));
        assertEquals(90, m.memoryPercent);
        assertEquals(Level.BAD, m.memoryLevel);
        assertEquals("9,0 / 10,0 GB", m.memoryDetail);
    }

    @Test
    public void givenMemoryWithoutTotal_whenPresented_thenNoPercent() throws Exception {
        WidgetSnapshot s = parse("", system(0, 0, "\"queue\":{\"running\":null,\"waiting\":0}"));
        SystemPresenter.Model m = SystemPresenter.present(s.system, PRESENTER.presentStatus(s, null, 0));
        assertEquals(SystemPresenter.NO_PERCENT, m.memoryPercent);
        assertEquals("", m.memoryDetail);
    }

    @Test
    public void givenRunningGate_whenPresented_thenQueueIsBusyWithItsShareOfMemory() throws Exception {
        long gib = 1L << 30;
        WidgetSnapshot s = parse("", system(10 * gib, 2 * gib,
                "\"queue\":{\"running\":{\"label\":\"tsc\",\"ageSeconds\":240,\"rssBytes\":" + gib + "},\"waiting\":2}"));
        SystemPresenter.Model m = SystemPresenter.present(s.system, PRESENTER.presentStatus(s, null, 0));
        assertTrue(m.queueBusy);
        assertEquals(10, m.queueRssPercent);
        assertEquals("tsc 4min · +2", m.queueShort);
    }

    @Test
    public void givenIdleQueue_whenPresented_thenFreeAndNoBar() throws Exception {
        WidgetSnapshot s = parse("", system(1L << 30, 1L << 20, "\"queue\":{\"running\":null,\"waiting\":0}"));
        SystemPresenter.Model m = SystemPresenter.present(s.system, PRESENTER.presentStatus(s, null, 0));
        assertFalse(m.queueBusy);
        assertEquals(0, m.queueRssPercent);
        assertEquals("livre", m.queueShort);
        assertEquals("2/2 serv · 1/1 cont", m.infraShort);
    }

    @Test
    public void givenPrs_whenPresented_thenCountsAndRowsCarryNumberAndReview() throws Exception {
        WidgetSnapshot s = parse("", ",\"prs\":{\"available\":true,\"ageSeconds\":5,\"error\":null,\"items\":["
                + "{\"number\":12,\"title\":\"A\",\"reviewPending\":true,\"ci\":\"failing\"},"
                + "{\"number\":13,\"title\":\"B\",\"reviewPending\":false,\"ci\":\"green\"}]}");
        PrsPresenter.Model m = PrsPresenter.present(s.prs, PRESENTER.presentStatus(s, null, 0));
        assertTrue(m.hasCounts);
        assertEquals(1, m.green);
        assertEquals(1, m.failingCount);
        assertEquals(1, m.review);
        assertEquals("#12", m.rows.get(0).number);
        assertTrue(m.rows.get(0).reviewPending);
        assertEquals(PrsSection.Ci.GREEN, m.rows.get(1).ci);
    }

    @Test
    public void givenNoPrs_whenPresented_thenTextReplacesTheCounters() throws Exception {
        WidgetSnapshot s = parse("", ",\"prs\":{\"available\":true,\"ageSeconds\":5,\"error\":null,\"items\":[]}");
        PrsPresenter.Model m = PrsPresenter.present(s.prs, PRESENTER.presentStatus(s, null, 0));
        assertFalse(m.hasCounts);
        assertEquals("nenhuma PR aberta", m.summary);
    }
}
