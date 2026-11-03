package dev.hades.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.time.ZoneOffset;

public class SystemPrsSectionsTest {

    private static final WidgetPresenter PRESENTER = new WidgetPresenter(ZoneOffset.UTC);
    private static final String HEAD = "{\"version\":1,\"updatedAt\":\"2026-10-26T07:33:20Z\",\"available\":true,"
            + "\"counts\":{\"active\":0,\"stopped\":0,\"asking\":0},\"agents\":[]";

    private static final String SYSTEM = "\"system\":{\"memory\":{\"totalBytes\":34359738368,\"usedBytes\":13421772800,"
            + "\"availableBytes\":20937965568},\"infra\":{\"services\":{\"enabled\":6,\"up\":5,\"required\":2,"
            + "\"requiredUp\":2,\"down\":[\"billing\"]},\"containers\":{\"total\":3,\"up\":3,\"down\":[]}},"
            + "\"queue\":{\"running\":{\"label\":\"build-api\",\"ageSeconds\":240,\"rssBytes\":1288490189},\"waiting\":2}}";

    private static final String PRS = "\"prs\":{\"available\":true,\"fetchedAt\":\"2026-10-26T07:26:20Z\","
            + "\"ageSeconds\":420,\"error\":null,\"items\":["
            + "{\"number\":12,\"title\":\"Feature A\",\"reviewPending\":true,\"ci\":\"failing\"},"
            + "{\"number\":13,\"title\":\"Feature B\",\"reviewPending\":false,\"ci\":\"green\"},"
            + "{\"number\":14,\"title\":\"Feature C\",\"reviewPending\":false,\"ci\":\"running\"},"
            + "{\"number\":15,\"title\":\"Feature D\",\"reviewPending\":false,\"ci\":\"none\"}]}";

    private static WidgetSnapshot parse(String sections) throws Exception {
        return WidgetParser.parse(HEAD + sections + "}");
    }

    private static WidgetPresenter.Model status(WidgetSnapshot s, FetchResult.Failure f) {
        return PRESENTER.presentStatus(s, f, 0);
    }

    @Test
    public void givenOldPanelWithoutSections_whenParsed_thenSectionsAreNullAndStatusStillReads() throws Exception {
        WidgetSnapshot s = parse("");
        assertNull(s.system);
        assertNull(s.prs);
        assertEquals(0, s.agents.size());
    }

    @Test
    public void givenOldPanel_whenPresented_thenSistemaAndPrsSayNoData() throws Exception {
        WidgetSnapshot s = parse("");
        assertEquals(SystemPresenter.NO_DATA, SystemPresenter.present(s.system, status(s, null)).status);
        assertEquals(PrsPresenter.NO_DATA, PrsPresenter.present(s.prs, status(s, null)).status);
    }

    @Test
    public void givenSystemSection_whenParsed_thenMemoryInfraAndQueueRead() throws Exception {
        SystemSection sys = parse("," + SYSTEM).system;
        assertEquals(13421772800L, sys.memory.usedBytes);
        assertEquals(5, sys.infra.servicesUp);
        assertEquals("billing", sys.infra.servicesDown.get(0));
        assertEquals("build-api", sys.queue.runningLabel);
        assertEquals(Long.valueOf(240), sys.queue.runningAgeSeconds);
        assertEquals(2, sys.queue.waiting);
    }

    @Test
    public void givenSystemSection_whenPresented_thenLinesAndDownHighlight() throws Exception {
        WidgetSnapshot s = parse("," + SYSTEM);
        SystemPresenter.Model m = SystemPresenter.present(s.system, status(s, null));
        assertEquals("mem 12,5 / 32,0 GB · 39%", m.memory);
        assertEquals("infra 5/6 serv · 3/3 cont · caiu: billing", m.infra);
        assertTrue(m.infraDown);
        assertEquals("fila: build-api 4min · 1,2 GB · 2 esperam", m.queue);
        assertEquals("atualizado 07:33", m.status);
    }

    @Test
    public void givenNothingRunningAndNothingDown_whenPresented_thenQueueFreeAndNoHighlight() throws Exception {
        WidgetSnapshot s = parse(",\"system\":{\"memory\":null,\"infra\":{\"services\":{\"enabled\":1,\"up\":1,"
                + "\"required\":1,\"requiredUp\":1,\"down\":[]},\"containers\":{\"total\":0,\"up\":0,\"down\":[]}},"
                + "\"queue\":{\"running\":null,\"waiting\":0}}");
        SystemPresenter.Model m = SystemPresenter.present(s.system, status(s, null));
        assertEquals("mem sem dados", m.memory);
        assertFalse(m.infraDown);
        assertEquals("fila livre", m.queue);
    }

    @Test
    public void givenMoreDownThanTheLimit_whenPresented_thenNamesAreCapped() throws Exception {
        WidgetSnapshot s = parse(",\"system\":{\"infra\":{\"services\":{\"enabled\":5,\"up\":0,\"required\":0,"
                + "\"requiredUp\":0,\"down\":[\"a\",\"b\",\"c\",\"d\"]},\"containers\":{\"total\":1,\"up\":0,"
                + "\"down\":[\"e\"]}},\"queue\":{\"running\":null,\"waiting\":1}}");
        assertEquals("infra 0/5 serv · 0/1 cont · caiu: a, b, c +2", SystemPresenter.present(s.system, status(s, null)).infra);
        assertEquals("fila livre · 1 espera", SystemPresenter.present(s.system, status(s, null)).queue);
    }

    @Test
    public void givenMalformedSystemSection_whenParsed_thenSectionIsNullNotAFailure() throws Exception {
        WidgetSnapshot s = parse(",\"system\":{\"infra\":{\"services\":{\"enabled\":\"x\"}}}");
        assertNull(s.system);
        assertEquals(1, s.version);
    }

    @Test
    public void givenFailureAfterGoodData_whenSistemaPresented_thenKeepsLinesAndShowsProblem() throws Exception {
        WidgetSnapshot s = parse("," + SYSTEM);
        SystemPresenter.Model m = SystemPresenter.present(s.system, status(s, FetchResult.Failure.NETWORK));
        assertEquals("sem rede · último dado 07:33", m.status);
        assertTrue(m.problem);
        assertEquals("mem 12,5 / 32,0 GB · 39%", m.memory);
    }

    @Test
    public void givenAvailableFalse_whenSistemaPresented_thenNoOrchestrationNoticeIsNotShown() throws Exception {
        WidgetSnapshot s = WidgetParser.parse("{\"version\":1,\"updatedAt\":\"2026-10-26T07:33:20Z\","
                + "\"available\":false," + SYSTEM + "}");
        assertEquals("atualizado 07:33", SystemPresenter.present(s.system, status(s, null)).status);
    }

    @Test
    public void givenPrsSection_whenParsed_thenItemsAndUnknownCiMapToNone() throws Exception {
        PrsSection prs = parse("," + PRS.replace("\"ci\":\"none\"", "\"ci\":\"amanha\"")).prs;
        assertTrue(prs.available);
        assertEquals(Long.valueOf(420), prs.ageSeconds);
        assertNull(prs.error);
        assertEquals(4, prs.items.size());
        assertEquals(PrsSection.Ci.FAILING, prs.items.get(0).ci);
        assertTrue(prs.items.get(0).reviewPending);
        assertEquals(PrsSection.Ci.NONE, prs.items.get(3).ci);
    }

    @Test
    public void givenPrsSection_whenPresented_thenSummaryLinesAndAge() throws Exception {
        WidgetSnapshot s = parse("," + PRS);
        PrsPresenter.Model m = PrsPresenter.present(s.prs, status(s, null));
        assertEquals("✓ 1 · ✗ 1 · … 1 · review 1", m.summary);
        assertTrue(m.failing);
        assertEquals("✗ #12 [review] Feature A", m.lines.get(0));
        assertEquals("✓ #13 Feature B", m.lines.get(1));
        assertEquals("– #15 Feature D", m.lines.get(3));
        assertEquals("dados de 7min atrás", m.info);
    }

    @Test
    public void givenCollectorFailedWithLastGoodData_whenPresented_thenDataStaysAndInfoWarns() throws Exception {
        WidgetSnapshot s = parse("," + PRS.replace("\"error\":null", "\"error\":\"collector_failed\""));
        PrsPresenter.Model m = PrsPresenter.present(s.prs, status(s, null));
        assertEquals(4, m.lines.size());
        assertEquals("coleta falhou · dados de 7min atrás", m.info);
    }

    @Test
    public void givenNoCollectionYet_whenPresented_thenSaysCollecting() throws Exception {
        WidgetSnapshot s = parse(",\"prs\":{\"available\":false,\"fetchedAt\":null,\"ageSeconds\":null,"
                + "\"error\":null,\"items\":[]}");
        assertEquals("coletando as PRs…", PrsPresenter.present(s.prs, status(s, null)).info);
    }

    @Test
    public void givenNoOpenPrs_whenPresented_thenSaysSo() throws Exception {
        WidgetSnapshot s = parse(",\"prs\":{\"available\":true,\"ageSeconds\":10,\"error\":null,\"items\":[]}");
        PrsPresenter.Model m = PrsPresenter.present(s.prs, status(s, null));
        assertEquals("nenhuma PR aberta", m.summary);
        assertFalse(m.failing);
    }

    @Test
    public void givenMorePrsThanLines_whenPresented_thenLinesCappedButCountsComplete() throws Exception {
        StringBuilder items = new StringBuilder();
        for (int i = 0; i < 8; i++) {
            items.append(i == 0 ? "" : ",").append("{\"number\":").append(i).append(",\"title\":\"t\",\"ci\":\"green\"}");
        }
        WidgetSnapshot s = parse(",\"prs\":{\"available\":true,\"ageSeconds\":1,\"error\":null,\"items\":[" + items + "]}");
        PrsPresenter.Model m = PrsPresenter.present(s.prs, status(s, null));
        assertEquals(PrsPresenter.MAX_LINES, m.lines.size());
        assertTrue(m.summary.startsWith("✓ 8"));
    }

    @Test
    public void givenFailureWithoutAnyData_whenPrsPresented_thenProblemShown() throws Exception {
        PrsPresenter.Model m = PrsPresenter.present(null, status(null, FetchResult.Failure.UNAUTHORIZED));
        assertEquals("token recusado (401)", m.status);
        assertTrue(m.problem);
    }
}
