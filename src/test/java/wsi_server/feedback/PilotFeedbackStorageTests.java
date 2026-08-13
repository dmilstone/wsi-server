package wsi_server.feedback;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Path;
import java.time.Instant;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PilotFeedbackStorageTests {
    @TempDir
    Path tempDir;

    private PilotFeedbackStorage storage;

    @BeforeEach
    void setUp() throws Exception {
        JsonMapper jsonMapper = JsonMapper.builder().findAndAddModules().build();
        storage = new PilotFeedbackStorage(tempDir.toString(), jsonMapper);
    }

    @Test
    void appendAndReadAllPersistsEntries() throws Exception {
        PilotFeedbackEntry first = sampleEntry("one");
        PilotFeedbackEntry second = sampleEntry("two");
        storage.append(first);
        storage.append(second);

        List<PilotFeedbackEntry> entries = storage.readAll();
        assertEquals(2, entries.size());
        assertEquals("one", entries.get(0).responseId());
        assertEquals("two", entries.get(1).responseId());
        assertTrue(tempDir.resolve("submissions.jsonl").toFile().exists());
    }

    private static PilotFeedbackEntry sampleEntry(String id) {
        Map<String, TaskCompletion> tasks = new LinkedHashMap<>();
        for (String taskId : PilotFeedbackService.TASK_IDS) {
            tasks.put(taskId, TaskCompletion.COMPLETED_EASILY);
        }
        Map<String, Integer> ratings = new LinkedHashMap<>();
        for (String ratingId : PilotFeedbackService.RATING_IDS) {
            ratings.put(ratingId, 4);
        }
        return new PilotFeedbackEntry(
                id,
                "viewer",
                "00000000-0000-4000-8000-000000000001",
                Instant.parse("2026-08-09T12:00:00Z"),
                "127.0.0.1",
                "test-agent",
                "alias",
                EvaluatorRole.RESEARCHER,
                WsiExperience.MODERATE,
                tasks,
                ratings,
                "useful",
                "confusing",
                "missing",
                "comments"
        );
    }
}
