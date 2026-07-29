package wsi_server;

import jakarta.servlet.http.HttpSession;
import org.springframework.web.bind.annotation.*;
import wsi_server.api.*;

@RestController
@RequestMapping("/api/images")
public class ImageApiController {
    private final BioFormatsTileService service;
    public ImageApiController(BioFormatsTileService service) { this.service = service; }

    @GetMapping public ImageListResponse images() { return service.listImages(); }
    @GetMapping("/{imageId}")
    public ImageMetadataResponse metadata(@PathVariable String imageId, HttpSession session) throws Exception {
        return service.getMetadata(imageId, session);
    }
    @GetMapping("/{imageId}/display")
    public DisplayResponse display(@PathVariable String imageId, HttpSession session) throws Exception {
        return service.getDisplay(imageId, session);
    }
    @PostMapping("/{imageId}/display/reset")
    public DisplayResponse resetDisplay(@PathVariable String imageId, HttpSession session) throws Exception {
        return service.resetDisplay(imageId, session);
    }
    @PutMapping("/{imageId}/display")
    public DisplayResponse updateDisplay(@PathVariable String imageId,
                                         @RequestBody DisplayUpdateRequest request,
                                         HttpSession session) throws Exception {
        return service.updateDisplay(imageId, request, session);
    }
}
