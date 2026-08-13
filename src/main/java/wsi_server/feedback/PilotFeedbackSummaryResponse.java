package wsi_server.feedback;

import java.util.List;
import java.util.Map;

record RatingStatistics(
        int count,
        double mean,
        double median,
        Map<Integer, Integer> distribution
) {}

record TaskCompletionStatistics(
        String taskId,
        String label,
        Map<TaskCompletion, Integer> counts
) {}

record ResponderSummaryRow(
        String authenticatedUserId,
        String deviceIdShort,
        int submissionCount,
        String latestSubmittedAt
) {}

record FreeTextEntry(
        String responseId,
        String authenticatedUserId,
        String deviceIdShort,
        String submittedAt,
        String mostUseful,
        String mostConfusing,
        String expectedMissing,
        String otherComments
) {}

public record PilotFeedbackSummaryResponse(
        String viewMode,
        int totalSubmissions,
        int uniqueUsernames,
        int uniqueDeviceIds,
        int uniqueCombos,
        int repeatSubmissions,
        String latestSubmissionAt,
        List<TaskCompletionStatistics> taskCompletion,
        Map<String, RatingStatistics> ratings,
        List<ResponderSummaryRow> responders,
        List<FreeTextEntry> freeText
) {}
