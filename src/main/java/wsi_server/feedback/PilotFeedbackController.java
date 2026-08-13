package wsi_server.feedback;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.List;

@RestController
@RequestMapping("/api/pilot-feedback")
public class PilotFeedbackController {
    private final PilotFeedbackService service;

    public PilotFeedbackController(PilotFeedbackService service) {
        this.service = service;
    }

    @PostMapping
    public PilotFeedbackSubmitResponse submit(
            @RequestBody PilotFeedbackRequest request,
            HttpServletRequest httpRequest
    ) throws IOException {
        return service.submit(request, httpRequest);
    }

    @GetMapping("/summary")
    public PilotFeedbackSummaryResponse summary(
            @RequestParam(defaultValue = "all") String view
    ) throws IOException {
        return service.summarize(view);
    }

    @GetMapping("/responses")
    public List<PilotFeedbackEntry> responses(
            @RequestParam(defaultValue = "false") boolean deduplicated
    ) throws IOException {
        return service.listResponses(deduplicated);
    }

    @GetMapping(value = "/export.json", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> exportJson(
            @RequestParam(defaultValue = "false") boolean deduplicated
    ) throws IOException {
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"pilot-feedback.json\"")
                .body(service.exportJson(deduplicated));
    }

    @GetMapping(value = "/export.csv", produces = "text/csv")
    public ResponseEntity<String> exportCsv(
            @RequestParam(defaultValue = "false") boolean deduplicated
    ) throws IOException {
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"pilot-feedback.csv\"")
                .body(service.exportCsv(deduplicated));
    }
}
