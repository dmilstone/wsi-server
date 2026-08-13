package wsi_server.feedback;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.io.IOException;

@RestControllerAdvice(assignableTypes = PilotFeedbackController.class)
public class PilotFeedbackExceptionHandler {
    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail badRequest(IllegalArgumentException exception) {
        ProblemDetail detail = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, exception.getMessage());
        detail.setTitle("Invalid pilot feedback request");
        return detail;
    }

    @ExceptionHandler(IllegalStateException.class)
    ProblemDetail unauthorized(IllegalStateException exception) {
        ProblemDetail detail = ProblemDetail.forStatusAndDetail(HttpStatus.UNAUTHORIZED, exception.getMessage());
        detail.setTitle("Authentication required");
        return detail;
    }

    @ExceptionHandler(IOException.class)
    ProblemDetail storageFailure(IOException exception) {
        ProblemDetail detail = ProblemDetail.forStatusAndDetail(
                HttpStatus.INTERNAL_SERVER_ERROR,
                "Pilot feedback could not be read or written."
        );
        detail.setTitle("Pilot feedback storage failure");
        return detail;
    }
}
