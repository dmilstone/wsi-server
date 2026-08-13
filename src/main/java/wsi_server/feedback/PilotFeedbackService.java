package wsi_server.feedback;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@Service
public class PilotFeedbackService {
    public static final List<String> TASK_IDS = List.of(
            "find_open_image",
            "switch_images",
            "pan_zoom",
            "adjust_channels_display",
            "create_annotation",
            "select_annotation",
            "rename_annotation",
            "move_annotation",
            "switch_away_return_persistence",
            "show_hide_annotations",
            "show_hide_names",
            "export_visible_region",
            "export_selected_annotation",
            "slide_overview",
            "full_screen",
            "presentation_mode",
            "find_use_help"
    );

    public static final Map<String, String> TASK_LABELS = Map.ofEntries(
            Map.entry("find_open_image", "Find/open image"),
            Map.entry("switch_images", "Switch images"),
            Map.entry("pan_zoom", "Pan/zoom"),
            Map.entry("adjust_channels_display", "Adjust channels/display"),
            Map.entry("create_annotation", "Create annotation"),
            Map.entry("select_annotation", "Select annotation"),
            Map.entry("rename_annotation", "Rename annotation"),
            Map.entry("move_annotation", "Move annotation"),
            Map.entry("switch_away_return_persistence", "Switch away/return verify persistence"),
            Map.entry("show_hide_annotations", "Show/hide annotations"),
            Map.entry("show_hide_names", "Show/hide names"),
            Map.entry("export_visible_region", "Export visible region"),
            Map.entry("export_selected_annotation", "Export selected annotation"),
            Map.entry("slide_overview", "Slide overview"),
            Map.entry("full_screen", "Full Screen"),
            Map.entry("presentation_mode", "Presentation mode"),
            Map.entry("find_use_help", "Find/use Help")
    );

    public static final List<String> RATING_IDS = List.of(
            "image_navigation",
            "image_switching",
            "responsiveness",
            "channel_display_controls",
            "annotation_workflow",
            "toolbar_clarity",
            "export_workflow",
            "overall_ease",
            "confidence_without_assistance"
    );

    public static final Map<String, String> RATING_LABELS = Map.ofEntries(
            Map.entry("image_navigation", "Image navigation"),
            Map.entry("image_switching", "Image switching"),
            Map.entry("responsiveness", "Responsiveness"),
            Map.entry("channel_display_controls", "Channel/display controls"),
            Map.entry("annotation_workflow", "Annotation workflow"),
            Map.entry("toolbar_clarity", "Toolbar clarity"),
            Map.entry("export_workflow", "Export workflow"),
            Map.entry("overall_ease", "Overall ease of use"),
            Map.entry("confidence_without_assistance", "Confidence using viewer without assistance")
    );

    public static final int MAX_ALIAS_LENGTH = 80;
    public static final int MAX_TEXT_LENGTH = 2000;
    private static final Duration DUPLICATE_WINDOW = Duration.ofSeconds(3);

    private final PilotFeedbackStorage storage;
    private final tools.jackson.databind.json.JsonMapper jsonMapper;
    private final Map<String, Instant> recentSubmissions = new ConcurrentHashMap<>();

    public PilotFeedbackService(PilotFeedbackStorage storage, tools.jackson.databind.json.JsonMapper jsonMapper) {
        this.storage = storage;
        this.jsonMapper = jsonMapper;
    }

    public PilotFeedbackSubmitResponse submit(PilotFeedbackRequest request, HttpServletRequest httpRequest) throws IOException {
        String userId = resolveAuthenticatedUserId();
        String deviceId = requireDeviceId(httpRequest);
        preventRapidDuplicate(userId, deviceId);

        PilotFeedbackEntry entry = new PilotFeedbackEntry(
                UUID.randomUUID().toString(),
                userId,
                deviceId,
                Instant.now(),
                resolveRemoteAddress(httpRequest),
                resolveUserAgent(httpRequest),
                normalizeAlias(request.evaluatorAlias()),
                request.role(),
                request.wsiExperience(),
                validateTaskCompletion(request.taskCompletion()),
                validateRatings(request.ratings()),
                normalizeText(request.mostUseful(), "mostUseful"),
                normalizeText(request.mostConfusing(), "mostConfusing"),
                normalizeText(request.expectedMissing(), "expectedMissing"),
                normalizeText(request.otherComments(), "otherComments")
        );
        storage.append(entry);
        return new PilotFeedbackSubmitResponse(
                entry.responseId(),
                entry.submittedAt(),
                "Pilot feedback submitted. Thank you."
        );
    }

    public List<PilotFeedbackEntry> listResponses(boolean deduplicated) throws IOException {
        List<PilotFeedbackEntry> all = storage.readAll();
        if (!deduplicated) return all;
        return deduplicate(all);
    }

    public PilotFeedbackSummaryResponse summarize(String viewMode) throws IOException {
        boolean deduplicated = "deduplicated".equalsIgnoreCase(viewMode);
        List<PilotFeedbackEntry> entries = listResponses(deduplicated);
        List<PilotFeedbackEntry> all = storage.readAll();

        Set<String> usernames = all.stream().map(PilotFeedbackEntry::authenticatedUserId).collect(Collectors.toSet());
        Set<String> deviceIds = all.stream().map(PilotFeedbackEntry::deviceId).collect(Collectors.toSet());
        Set<String> combos = all.stream()
                .map(entry -> comboKey(entry.authenticatedUserId(), entry.deviceId()))
                .collect(Collectors.toSet());

        Instant latest = entries.stream().map(PilotFeedbackEntry::submittedAt).max(Comparator.naturalOrder()).orElse(null);

        return new PilotFeedbackSummaryResponse(
                deduplicated ? "deduplicated" : "all",
                entries.size(),
                usernames.size(),
                deviceIds.size(),
                combos.size(),
                Math.max(0, all.size() - deduplicate(all).size()),
                latest == null ? null : latest.toString(),
                buildTaskStatistics(entries),
                buildRatingStatistics(entries),
                buildResponderRows(all),
                buildFreeText(entries)
        );
    }

    public String exportJson(boolean deduplicated) throws IOException {
        return jsonMapper.writerWithDefaultPrettyPrinter()
                .writeValueAsString(listResponses(deduplicated));
    }

    public String exportCsv(boolean deduplicated) throws IOException {
        List<PilotFeedbackEntry> entries = listResponses(deduplicated);
        StringBuilder csv = new StringBuilder();
        csv.append("responseId,authenticatedUserId,deviceId,submittedAt,evaluatorAlias,role,wsiExperience");
        for (String taskId : TASK_IDS) csv.append(',').append(taskId);
        for (String ratingId : RATING_IDS) csv.append(',').append(ratingId);
        csv.append(",mostUseful,mostConfusing,expectedMissing,otherComments\n");
        for (PilotFeedbackEntry entry : entries) {
            csv.append(csvField(entry.responseId())).append(',');
            csv.append(csvField(entry.authenticatedUserId())).append(',');
            csv.append(csvField(entry.deviceId())).append(',');
            csv.append(csvField(entry.submittedAt().toString())).append(',');
            csv.append(csvField(entry.evaluatorAlias())).append(',');
            csv.append(csvField(entry.role() == null ? "" : entry.role().name())).append(',');
            csv.append(csvField(entry.wsiExperience() == null ? "" : entry.wsiExperience().name()));
            for (String taskId : TASK_IDS) {
                TaskCompletion value = entry.taskCompletion().get(taskId);
                csv.append(',').append(csvField(value == null ? "" : value.name()));
            }
            for (String ratingId : RATING_IDS) {
                Integer value = entry.ratings().get(ratingId);
                csv.append(',').append(value == null ? "" : value);
            }
            csv.append(',').append(csvField(entry.mostUseful()));
            csv.append(',').append(csvField(entry.mostConfusing()));
            csv.append(',').append(csvField(entry.expectedMissing()));
            csv.append(',').append(csvField(entry.otherComments()));
            csv.append('\n');
        }
        return csv.toString();
    }

    static List<PilotFeedbackEntry> deduplicate(List<PilotFeedbackEntry> entries) {
        Map<String, PilotFeedbackEntry> latestByCombo = new LinkedHashMap<>();
        entries.stream()
                .sorted(Comparator.comparing(PilotFeedbackEntry::submittedAt)
                        .thenComparing(PilotFeedbackEntry::responseId))
                .forEach(entry -> latestByCombo.put(comboKey(entry.authenticatedUserId(), entry.deviceId()), entry));
        return latestByCombo.values().stream()
                .sorted(Comparator.comparing(PilotFeedbackEntry::submittedAt).thenComparing(PilotFeedbackEntry::responseId))
                .toList();
    }

    static String comboKey(String userId, String deviceId) {
        return userId + "\u0000" + deviceId;
    }

    static String shortenDeviceId(String deviceId) {
        if (deviceId == null || deviceId.length() < 12) return deviceId;
        return deviceId.substring(0, 8) + "…";
    }

    private void preventRapidDuplicate(String userId, String deviceId) {
        String key = comboKey(userId, deviceId);
        Instant now = Instant.now();
        Instant previous = recentSubmissions.put(key, now);
        if (previous != null && Duration.between(previous, now).compareTo(DUPLICATE_WINDOW) < 0) {
            throw new IllegalArgumentException("Please wait a moment before submitting again.");
        }
    }

    private Map<String, TaskCompletion> validateTaskCompletion(Map<String, TaskCompletion> input) {
        if (input == null || input.isEmpty()) {
            throw new IllegalArgumentException("Task completion responses are required.");
        }
        Map<String, TaskCompletion> normalized = new LinkedHashMap<>();
        for (String taskId : TASK_IDS) {
            TaskCompletion value = input.get(taskId);
            if (value == null) {
                throw new IllegalArgumentException("Missing task completion for " + TASK_LABELS.get(taskId) + ".");
            }
            normalized.put(taskId, value);
        }
        return Map.copyOf(normalized);
    }

    private Map<String, Integer> validateRatings(Map<String, Integer> input) {
        if (input == null || input.isEmpty()) {
            throw new IllegalArgumentException("Ratings are required.");
        }
        Map<String, Integer> normalized = new LinkedHashMap<>();
        for (String ratingId : RATING_IDS) {
            Integer value = input.get(ratingId);
            if (value == null) {
                throw new IllegalArgumentException("Missing rating for " + RATING_LABELS.get(ratingId) + ".");
            }
            if (value < 1 || value > 5) {
                throw new IllegalArgumentException("Ratings must be between 1 and 5.");
            }
            normalized.put(ratingId, value);
        }
        return Map.copyOf(normalized);
    }

    private String normalizeAlias(String alias) {
        if (alias == null || alias.isBlank()) return null;
        String trimmed = alias.trim();
        if (trimmed.length() > MAX_ALIAS_LENGTH) {
            throw new IllegalArgumentException("Evaluator alias must be at most " + MAX_ALIAS_LENGTH + " characters.");
        }
        return trimmed;
    }

    private String normalizeText(String value, String fieldName) {
        if (value == null || value.isBlank()) return null;
        String trimmed = value.trim();
        if (trimmed.length() > MAX_TEXT_LENGTH) {
            throw new IllegalArgumentException(fieldName + " must be at most " + MAX_TEXT_LENGTH + " characters.");
        }
        return trimmed;
    }

    private List<TaskCompletionStatistics> buildTaskStatistics(List<PilotFeedbackEntry> entries) {
        List<TaskCompletionStatistics> stats = new ArrayList<>();
        for (String taskId : TASK_IDS) {
            Map<TaskCompletion, Integer> counts = new EnumMap<>(TaskCompletion.class);
            for (TaskCompletion completion : TaskCompletion.values()) counts.put(completion, 0);
            for (PilotFeedbackEntry entry : entries) {
                TaskCompletion value = entry.taskCompletion().get(taskId);
                if (value != null) counts.put(value, counts.get(value) + 1);
            }
            stats.add(new TaskCompletionStatistics(taskId, TASK_LABELS.get(taskId), Map.copyOf(counts)));
        }
        return stats;
    }

    private Map<String, RatingStatistics> buildRatingStatistics(List<PilotFeedbackEntry> entries) {
        Map<String, RatingStatistics> stats = new LinkedHashMap<>();
        for (String ratingId : RATING_IDS) {
            List<Integer> values = entries.stream()
                    .map(entry -> entry.ratings().get(ratingId))
                    .filter(Objects::nonNull)
                    .toList();
            Map<Integer, Integer> distribution = new TreeMap<>();
            for (int i = 1; i <= 5; i++) distribution.put(i, 0);
            for (Integer value : values) distribution.put(value, distribution.get(value) + 1);
            double mean = values.isEmpty() ? 0.0 : values.stream().mapToInt(Integer::intValue).average().orElse(0.0);
            double median = median(values);
            stats.put(ratingId, new RatingStatistics(values.size(), round(mean), round(median), Map.copyOf(distribution)));
        }
        return stats;
    }

    private List<ResponderSummaryRow> buildResponderRows(List<PilotFeedbackEntry> all) {
        Map<String, List<PilotFeedbackEntry>> grouped = new HashMap<>();
        for (PilotFeedbackEntry entry : all) {
            grouped.computeIfAbsent(comboKey(entry.authenticatedUserId(), entry.deviceId()), ignored -> new ArrayList<>())
                    .add(entry);
        }
        return grouped.values().stream()
                .map(entries -> {
                    entries.sort(Comparator.comparing(PilotFeedbackEntry::submittedAt).reversed());
                    PilotFeedbackEntry latest = entries.getFirst();
                    return new ResponderSummaryRow(
                            latest.authenticatedUserId(),
                            shortenDeviceId(latest.deviceId()),
                            entries.size(),
                            latest.submittedAt().toString()
                    );
                })
                .sorted(Comparator.comparing(ResponderSummaryRow::latestSubmittedAt).reversed())
                .toList();
    }

    private List<FreeTextEntry> buildFreeText(List<PilotFeedbackEntry> entries) {
        return entries.stream()
                .filter(entry -> hasText(entry.mostUseful()) || hasText(entry.mostConfusing())
                        || hasText(entry.expectedMissing()) || hasText(entry.otherComments()))
                .sorted(Comparator.comparing(PilotFeedbackEntry::submittedAt).reversed())
                .map(entry -> new FreeTextEntry(
                        entry.responseId(),
                        entry.authenticatedUserId(),
                        shortenDeviceId(entry.deviceId()),
                        entry.submittedAt().toString(),
                        entry.mostUseful(),
                        entry.mostConfusing(),
                        entry.expectedMissing(),
                        entry.otherComments()
                ))
                .toList();
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private static double median(List<Integer> values) {
        if (values.isEmpty()) return 0.0;
        List<Integer> sorted = values.stream().sorted().toList();
        int middle = sorted.size() / 2;
        if (sorted.size() % 2 == 1) return sorted.get(middle);
        return (sorted.get(middle - 1) + sorted.get(middle)) / 2.0;
    }

    private static double round(double value) {
        return Math.round(value * 100.0) / 100.0;
    }

    private static String csvField(String value) {
        if (value == null) return "";
        String escaped = value.replace("\"", "\"\"");
        if (escaped.contains(",") || escaped.contains("\"") || escaped.contains("\n") || escaped.contains("\r")) {
            return "\"" + escaped + "\"";
        }
        return escaped;
    }

    static String resolveAuthenticatedUserId() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated()) {
            throw new IllegalStateException("Authenticated user is required.");
        }
        return authentication.getName();
    }

    static String requireDeviceId(HttpServletRequest request) {
        String deviceId = BrowserProfileCookieFilter.resolveDeviceId(request);
        if (deviceId == null) {
            throw new IllegalArgumentException("Browser/profile identifier cookie is required.");
        }
        return deviceId;
    }

    static String resolveRemoteAddress(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }

    static String resolveUserAgent(HttpServletRequest request) {
        String userAgent = request.getHeader("User-Agent");
        return userAgent == null ? "" : userAgent.substring(0, Math.min(userAgent.length(), 512));
    }
}
