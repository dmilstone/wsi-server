package wsi_server.feedback;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

/** Serves clean pilot feedback page URLs from static resources. */
@Controller
public class PilotFeedbackPageController {
    @GetMapping({"/pilot-feedback", "/pilot-feedback/"})
    public String feedbackForm() {
        return "forward:/pilot-feedback/index.html";
    }

    @GetMapping({"/pilot-feedback/results", "/pilot-feedback/results/"})
    public String feedbackResults() {
        return "forward:/pilot-feedback/results/index.html";
    }
}
