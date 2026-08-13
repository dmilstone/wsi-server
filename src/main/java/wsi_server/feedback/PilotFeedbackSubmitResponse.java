package wsi_server.feedback;

import java.time.Instant;

public record PilotFeedbackSubmitResponse(
        String responseId,
        Instant submittedAt,
        String message
) {}
