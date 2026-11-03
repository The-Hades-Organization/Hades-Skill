package dev.hades.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class WidgetParserTest {

    /** Exemplo literal de reference/panel.md §Widget Android. */
    private static final String CONTRACT_EXAMPLE = "{\"version\":1,\"updatedAt\":\"2026-10-26T07:33:20Z\","
            + "\"available\":true,\"counts\":{\"active\":1,\"stopped\":0,\"asking\":1},"
            + "\"agents\":[{\"name\":\"impl-a\",\"role\":\"impl\",\"state\":\"active\","
            + "\"since\":\"2026-10-26T06:00:00Z\",\"ageSeconds\":5600,\"openQuestions\":0}],"
            + "\"events\":[{\"at\":\"2026-10-26T06:00:00Z\",\"type\":\"prompted\",\"agent\":\"impl-a\","
            + "\"role\":\"impl\"}]}";

    @Test
    public void givenContractExample_whenParsed_thenFieldsMatch() throws Exception {
        WidgetSnapshot s = WidgetParser.parse(CONTRACT_EXAMPLE);
        assertEquals(1, s.version);
        assertEquals("2026-10-26T07:33:20Z", s.updatedAt);
        assertTrue(s.available);
        assertEquals(1, s.active);
        assertEquals(0, s.stopped);
        assertEquals(1, s.asking);
        assertEquals(1, s.agents.size());
        WidgetSnapshot.Agent a = s.agents.get(0);
        assertEquals("impl-a", a.name);
        assertEquals("impl", a.role);
        assertEquals(WidgetSnapshot.AgentState.ACTIVE, a.state);
        assertEquals(Long.valueOf(5600), a.ageSeconds);
        assertEquals(0, a.openQuestions);
    }

    @Test
    public void givenNewFieldsAtEveryLevel_whenParsed_thenIgnored() throws Exception {
        String json = "{\"version\":1,\"updatedAt\":\"2026-10-26T07:33:20Z\",\"available\":true,\"novo\":42,"
                + "\"counts\":{\"active\":0,\"stopped\":1,\"asking\":0,\"blocked\":3},"
                + "\"agents\":[{\"name\":\"x\",\"role\":null,\"state\":\"stopped\",\"ageSeconds\":null,"
                + "\"openQuestions\":0,\"extra\":{\"a\":1}}],\"events\":[{\"type\":\"futuro\"}]}";
        WidgetSnapshot s = WidgetParser.parse(json);
        assertEquals(1, s.stopped);
        assertNull(s.agents.get(0).role);
        assertNull(s.agents.get(0).ageSeconds);
    }

    @Test
    public void givenUnknownAgentState_whenParsed_thenTreatedAsStopped() throws Exception {
        String json = "{\"version\":1,\"updatedAt\":\"2026-10-26T07:33:20Z\",\"available\":true,"
                + "\"counts\":{\"active\":0,\"stopped\":1,\"asking\":0},"
                + "\"agents\":[{\"name\":\"x\",\"state\":\"hibernating\"}]}";
        assertEquals(WidgetSnapshot.AgentState.STOPPED, WidgetParser.parse(json).agents.get(0).state);
    }

    @Test
    public void givenAvailableFalse_whenParsed_thenNoAgentsAndZeroCounts() throws Exception {
        String json = "{\"version\":1,\"updatedAt\":\"2026-10-26T07:33:20Z\",\"available\":false,"
                + "\"agents\":[{\"name\":\"ignorado\",\"state\":\"active\"}]}";
        WidgetSnapshot s = WidgetParser.parse(json);
        assertFalse(s.available);
        assertEquals(0, s.agents.size());
        assertEquals(0, s.active);
    }

    @Test
    public void givenNewerContractVersion_whenParsed_thenStillReadable() throws Exception {
        assertEquals(2, WidgetParser.parse(CONTRACT_EXAMPLE.replace("\"version\":1", "\"version\":2")).version);
    }

    @Test
    public void givenMoreAgentsThanTheCap_whenParsed_thenTruncated() throws Exception {
        StringBuilder agents = new StringBuilder();
        for (int i = 0; i < WidgetParser.MAX_AGENTS + 20; i++) {
            agents.append(i == 0 ? "" : ",").append("{\"name\":\"a").append(i).append("\",\"state\":\"active\"}");
        }
        String json = "{\"version\":1,\"updatedAt\":\"2026-10-26T07:33:20Z\",\"available\":true,"
                + "\"counts\":{\"active\":120,\"stopped\":0,\"asking\":0},\"agents\":[" + agents + "]}";
        assertEquals(WidgetParser.MAX_AGENTS, WidgetParser.parse(json).agents.size());
    }

    @Test
    public void givenMissingRequiredField_whenParsed_thenParseException() {
        assertThrows(WidgetParser.ParseException.class,
                () -> WidgetParser.parse("{\"updatedAt\":\"2026-10-26T07:33:20Z\",\"available\":false}"));
        assertThrows(WidgetParser.ParseException.class,
                () -> WidgetParser.parse("{\"version\":1,\"updatedAt\":\"x\",\"available\":true}"));
    }

    @Test
    public void givenNotJson_whenParsed_thenParseException() {
        assertThrows(WidgetParser.ParseException.class, () -> WidgetParser.parse("<html>"));
        assertThrows(WidgetParser.ParseException.class, () -> WidgetParser.parse(""));
    }
}
