package wsi_server.feedback;

import java.util.Map;

/** Client-submitted pilot feedback payload (identity fields are server-derived). */
public record PilotFeedbackRequest(
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
