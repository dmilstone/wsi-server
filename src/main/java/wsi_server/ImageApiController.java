package wsi_server;

import jakarta.servlet.http.HttpSession;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import wsi_server.api.*;

@RestController
@RequestMapping("/api/images")
public class ImageApiController {
    private final BioFormatsTileService service;
    private final ImageRegistry registry;
    public ImageApiController(BioFormatsTileService service, ImageRegistry registry) {
        this.service = service;
        this.registry = registry;
    }

    @GetMapping public ImageListResponse images() {
        registry.requestRefresh(false);
        return service.listImages();
    }
    @GetMapping("/discovery") public ImageDiscoveryStatus discovery() { return discoveryStatus(); }
    @PostMapping("/refresh") public ImageDiscoveryStatus refresh() {
        registry.requestRefresh(true);
        return discoveryStatus();
    }

    private ImageDiscoveryStatus discoveryStatus() {
        ImageRegistry.RefreshStatus current = registry.getStatus();
        return new ImageDiscoveryStatus(current.running(), current.added(), current.unavailableOrPending(),
                current.failureCategory(), registry.getRefreshInterval().toMillis());
    }
    @GetMapping("/{imageId}")
    public ImageMetadataResponse metadata(@PathVariable String imageId,
                                          @RequestParam(defaultValue = "0") int series,
                                          HttpSession session) throws Exception {
        return service.getMetadata(imageId, series, session);
    }
    @GetMapping("/{imageId}/associated-images")
    public java.util.List<AssociatedImageSeriesDto> associatedImages(@PathVariable String imageId) throws Exception {
        return service.getAssociatedImageSeries(imageId);
    }
    @GetMapping(value = "/{imageId}/label.png", produces = MediaType.IMAGE_PNG_VALUE)
    public byte[] label(@PathVariable String imageId,
                        @RequestParam(defaultValue = "0") int max) throws Exception {
        return service.getSlideLabel(imageId, max);
    }
    @GetMapping(value = "/{imageId}/thumbnail.png", produces = MediaType.IMAGE_PNG_VALUE)
    public byte[] thumbnail(@PathVariable String imageId, HttpSession session) throws Exception {
        return service.getDisplayThumbnail(imageId, session);
    }
    @GetMapping(value = "/{imageId}/region.png", produces = MediaType.IMAGE_PNG_VALUE)
    public byte[] region(@PathVariable String imageId,
                         @RequestParam int x,
                         @RequestParam int y,
                         @RequestParam int width,
                         @RequestParam int height,
                         @RequestParam(defaultValue = "2048") int max,
                         @RequestParam(defaultValue = "0") int series,
                         @RequestParam(defaultValue = "0") int z,
                         HttpSession session) throws Exception {
        return service.renderAnalysisRegion(imageId, series, z, x, y, width, height, max, session);
    }
    @GetMapping("/{imageId}/display")
    public DisplayResponse display(@PathVariable String imageId,
                                   @RequestParam(defaultValue = "0") int series,
                                   HttpSession session) throws Exception {
        return service.getDisplay(imageId, series, session);
    }
    @GetMapping("/{imageId}/pixel")
    public PixelSampleResponse pixel(@PathVariable String imageId,
                                     @RequestParam int x,
                                     @RequestParam int y,
                                     @RequestParam(defaultValue = "0") int series) throws Exception {
        return service.getPixelSample(imageId, series, x, y);
    }
    @GetMapping("/{imageId}/pixel-block")
    public PixelBlockResponse pixelBlock(@PathVariable String imageId,
                                         @RequestParam int x,
                                         @RequestParam int y,
                                         @RequestParam(defaultValue = "64") int size,
                                         @RequestParam(defaultValue = "0") int series) throws Exception {
        return service.getPixelBlock(imageId, series, x, y, size);
    }
    @PostMapping("/{imageId}/display/reset")
    public DisplayResponse resetDisplay(@PathVariable String imageId,
                                        @RequestParam(defaultValue = "0") int series,
                                        HttpSession session) throws Exception {
        return service.resetDisplay(imageId, series, session);
    }
    @PostMapping("/{imageId}/display/recompute-auto")
    public DisplayResponse recomputeAutomaticDisplay(@PathVariable String imageId,
                                                     @RequestParam(defaultValue = "0") int series,
                                                     HttpSession session) throws Exception {
        return service.recomputeAutomaticDisplay(imageId, series, session);
    }
    @PutMapping("/{imageId}/display")
    public DisplayResponse updateDisplay(@PathVariable String imageId,
                                         @RequestParam(defaultValue = "0") int series,
                                         @RequestBody DisplayUpdateRequest request,
                                         HttpSession session) throws Exception {
        return service.updateDisplay(imageId, series, request, session);
    }
}
