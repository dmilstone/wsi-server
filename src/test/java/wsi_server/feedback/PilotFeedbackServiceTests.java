package wsi_server.feedback;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Path;
import java.time.Instant;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class PilotFeedbackServiceTests {
    @TempDir
    Path tempDir;

    private PilotFeedbackService service;

    @BeforeEach
    void setUp() throws Exception {
        JsonMapper jsonMapper = JsonMapper.builder().findAndAddModules().build();
        PilotFeedbackStorage storage = new PilotFeedbackStorage(tempDir.toString(), jsonMapper);
        service = new PilotFeedbackService(storage, jsonMapper);
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(
                        "viewer",
                        "n/a",
                        List.of(new SimpleGrantedAuthority("ROLE_VIEWER"))
                )
        );
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void submitStoresResponseAndSummaryCountsRepeats() throws Exception {
        MockHttpServletRequest request = requestWithDevice("00000000-0000-4000-8000-0000000000aa");
        service.submit(validRequest(), request);
        Thread.sleep(3100);
        service.submit(validRequest(), request);

        var summary = service.summarize("all");
        assertEquals(2, summary.totalSubmissions());
        assertEquals(1, summary.uniqueUsernames());
        assertEquals(1, summary.uniqueDeviceIds());
        assertEquals(1, summary.uniqueCombos());
        assertEquals(1, summary.repeatSubmissions());

        var dedup = service.summarize("deduplicated");
        assertEquals(1, dedup.totalSubmissions());
    }

    @Test
    void deduplicateKeepsMostRecentPerUsernameAndDevice() throws Exception {
        PilotFeedbackEntry older = entry("older", "viewer", "device-a", Instant.parse("2026-08-09T10:00:00Z"));
        PilotFeedbackEntry newer = entry("newer", "viewer", "device-a", Instant.parse("2026-08-09T11:00:00Z"));
        PilotFeedbackEntry otherDevice = entry("other", "viewer", "device-b", Instant.parse("2026-08-09T12:00:00Z"));

        List<PilotFeedbackEntry> deduped = PilotFeedbackService.deduplicate(List.of(older, newer, otherDevice));
        assertEquals(2, deduped.size());
        assertEquals("newer", deduped.getFirst().responseId());
        assertEquals("other", deduped.get(1).responseId());
    }

    @Test
    void rejectsMissingRatings() {
        MockHttpServletRequest request = requestWithDevice("00000000-0000-4000-8000-0000000000bb");
        PilotFeedbackRequest invalid = new PilotFeedbackRequest(
                null, null, null,
                validRequest().taskCompletion(),
                Map.of(),
                null, null, null, null
        );
        assertThrows(IllegalArgumentException.class, () -> service.submit(invalid, request));
    }

    @Test
    void rejectsRapidDuplicateSubmission() throws Exception {
        MockHttpServletRequest request = requestWithDevice("00000000-0000-4000-8000-0000000000cc");
        service.submit(validRequest(), request);
        assertThrows(IllegalArgumentException.class, () -> service.submit(validRequest(), request));
    }

    private static PilotFeedbackRequest validRequest() {
        Map<String, TaskCompletion> tasks = new LinkedHashMap<>();
        for (String taskId : PilotFeedbackService.TASK_IDS) {
            tasks.put(taskId, TaskCompletion.DID_NOT_TRY);
        }
        Map<String, Integer> ratings = new LinkedHashMap<>();
        for (String ratingId : PilotFeedbackService.RATING_IDS) {
            ratings.put(ratingId, 3);
        }
        return new PilotFeedbackRequest(
                "pilot-1",
                EvaluatorRole.PATHOLOGIST,
                WsiExperience.LIMITED,
                tasks,
                ratings,
                "useful",
                "confusing",
                "missing",
                "comments"
        );
    }

    private static MockHttpServletRequest requestWithDevice(String deviceId) {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setAttribute(BrowserProfileCookieFilter.class.getName() + ".deviceId", deviceId);
        request.setRemoteAddr("127.0.0.1");
        request.addHeader("User-Agent", "JUnit");
        return request;
    }

    private static PilotFeedbackEntry entry(String id, String user, String device, Instant submittedAt) {
        Map<String, TaskCompletion> tasks = new LinkedHashMap<>();
        for (String taskId : PilotFeedbackService.TASK_IDS) {
            tasks.put(taskId, TaskCompletion.COMPLETED_EASILY);
        }
        Map<String, Integer> ratings = new LinkedHashMap<>();
        for (String ratingId : PilotFeedbackService.RATING_IDS) {
            ratings.put(ratingId, 5);
        }
        return new PilotFeedbackEntry(
                id, user, device, submittedAt, "127.0.0.1", "JUnit",
                null, null, null, tasks, ratings, null, null, null, null
        );
    }
}
