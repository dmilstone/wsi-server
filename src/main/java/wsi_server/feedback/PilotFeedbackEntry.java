package wsi_server.feedback;

import java.time.Instant;
import java.util.Map;

/**
 * Durable pilot feedback submission. Identity fields are abstracted for future LDAP
 * integration; {@code authenticatedUserId} is the Spring Security principal name and
 * {@code deviceId} is the first-party browser/profile cookie UUID.
 */
public record PilotFeedbackEntry(
        String responseId,
        String authenticatedUserId,
        String deviceId,
        Instant submittedAt,
        String remoteAddress,
        String userAgent,
        String evaluatorAlias,
        EvaluatorRole role,
        WsiExperience wsiExperience,
        Map<String, TaskCompletion> taskCompletion,
        Map<String, Integer> ratings,
        String mostUseful,
        String mostConfusing,
        String expectedMissing,
        String otherComments
) {}
