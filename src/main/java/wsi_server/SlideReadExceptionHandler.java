package wsi_server;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Surface slide-open failures as HTTP 500 instead of an empty viewport.
 */
@RestControllerAdvice(assignableTypes = {TileController.class, ImageApiController.class})
class SlideReadExceptionHandler {

    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail badRequest(IllegalArgumentException exception) {
        exception.printStackTrace();
        ProblemDetail detail = ProblemDetail.forStatusAndDetail(
                HttpStatus.BAD_REQUEST,
                exception.getMessage() == null ? "Invalid slide request." : exception.getMessage());
        detail.setTitle("Invalid slide request");
        return detail;
    }

    @ExceptionHandler(Exception.class)
    ProblemDetail failed(Exception exception) {
        exception.printStackTrace();
        ProblemDetail detail = ProblemDetail.forStatusAndDetail(
                HttpStatus.INTERNAL_SERVER_ERROR,
                exception.getMessage() == null ? "Slide could not be read." : exception.getMessage());
        detail.setTitle("Slide read failure");
        return detail;
    }
}
