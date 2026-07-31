package wsi_server;

import jakarta.servlet.http.HttpSession;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ExportController {
    private final ExportService exportService;

    public ExportController(ExportService exportService) {
        this.exportService = exportService;
    }

    @GetMapping(value = "/export", produces = MediaType.IMAGE_PNG_VALUE)
    public ResponseEntity<byte[]> export(@RequestParam String image,
                                         @RequestParam int x,
                                         @RequestParam int y,
                                         @RequestParam int width,
                                         @RequestParam int height,
                                         @RequestParam(defaultValue = "1.0") double scale,
                                         HttpSession session) throws Exception {
        byte[] png = exportService.export(image, x, y, width, height, scale, session);
        String filename = "region-%d-%d-%dx%d.png".formatted(x, y, width, height);
        return ResponseEntity.ok()
                .contentType(MediaType.IMAGE_PNG)
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment().filename(filename).build().toString())
                .contentLength(png.length)
                .body(png);
    }
}
