package wsi_server;

import jakarta.servlet.http.HttpSession;
import org.springframework.http.MediaType;
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
    @GetMapping("/{imageId}/associated-images")
    public java.util.List<AssociatedImageSeriesDto> associatedImages(@PathVariable String imageId) throws Exception {
        return service.getAssociatedImageSeries(imageId);
    }
    @GetMapping(value = "/{imageId}/label.png", produces = MediaType.IMAGE_PNG_VALUE)
    public byte[] label(@PathVariable String imageId) throws Exception {
        return service.getSlideLabel(imageId);
    }
    @GetMapping(value = "/{imageId}/thumbnail.png", produces = MediaType.IMAGE_PNG_VALUE)
    public byte[] thumbnail(@PathVariable String imageId, HttpSession session) throws Exception {
        return service.getDisplayThumbnail(imageId, session);
    }
    @GetMapping("/{imageId}/display")
    public DisplayResponse display(@PathVariable String imageId, HttpSession session) throws Exception {
        return service.getDisplay(imageId, session);
    }
    @GetMapping("/{imageId}/pixel")
    public PixelSampleResponse pixel(@PathVariable String imageId,
                                     @RequestParam int x,
                                     @RequestParam int y) throws Exception {
        return service.getPixelSample(imageId, x, y);
    }
    @GetMapping("/{imageId}/pixel-block")
    public PixelBlockResponse pixelBlock(@PathVariable String imageId,
                                         @RequestParam int x,
                                         @RequestParam int y,
                                         @RequestParam(defaultValue = "64") int size) throws Exception {
        return service.getPixelBlock(imageId, x, y, size);
    }
    @PostMapping("/{imageId}/display/reset")
    public DisplayResponse resetDisplay(@PathVariable String imageId, HttpSession session) throws Exception {
        return service.resetDisplay(imageId, session);
    }
    @PostMapping("/{imageId}/display/recompute-auto")
    public DisplayResponse recomputeAutomaticDisplay(@PathVariable String imageId, HttpSession session) throws Exception {
        return service.recomputeAutomaticDisplay(imageId, session);
    }
    @PutMapping("/{imageId}/display")
    public DisplayResponse updateDisplay(@PathVariable String imageId,
                                         @RequestBody DisplayUpdateRequest request,
                                         HttpSession session) throws Exception {
        return service.updateDisplay(imageId, request, session);
    }
}
