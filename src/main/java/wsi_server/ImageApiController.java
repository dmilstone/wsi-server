package wsi_server;

import jakarta.servlet.http.HttpSession;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import wsi_server.api.*;

import java.nio.charset.StandardCharsets;
import java.time.Duration;

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
                                          @RequestParam(value = "series", defaultValue = "0") int series,
                                          HttpSession session) throws Exception {
        return service.getMetadata(imageId, series, session);
    }
    @GetMapping("/{imageId}/associated-images")
    public java.util.List<AssociatedImageSeriesDto> associatedImages(@PathVariable String imageId) throws Exception {
        return service.getAssociatedImageSeries(imageId);
    }
    @GetMapping(value = "/{imageId}/label.png", produces = MediaType.IMAGE_PNG_VALUE)
    public ResponseEntity<byte[]> label(@PathVariable String imageId) throws Exception {
        return pngResponse(service.getSlideLabel(imageId), "slide-label.png");
    }
    @GetMapping(value = "/{imageId}/thumbnail.png", produces = MediaType.IMAGE_PNG_VALUE)
    public ResponseEntity<byte[]> thumbnail(@PathVariable String imageId, HttpSession session) throws Exception {
        return pngResponse(service.getDisplayThumbnail(imageId, session), "slide-thumbnail.png");
    }
    @GetMapping("/{imageId}/display")
    public DisplayResponse display(@PathVariable String imageId,
                                   @RequestParam(value = "series", defaultValue = "0") int series,
                                   HttpSession session) throws Exception {
        return service.getDisplay(imageId, series, session);
    }
    @GetMapping("/{imageId}/pixel")
    public PixelSampleResponse pixel(@PathVariable String imageId,
                                     @RequestParam(value = "series", defaultValue = "0") int series,
                                     @RequestParam int x,
                                     @RequestParam int y) throws Exception {
        return service.getPixelSample(imageId, series, x, y);
    }
    @GetMapping("/{imageId}/pixel-block")
    public PixelBlockResponse pixelBlock(@PathVariable String imageId,
                                         @RequestParam(value = "series", defaultValue = "0") int series,
                                         @RequestParam int x,
                                         @RequestParam int y,
                                         @RequestParam(defaultValue = "64") int size) throws Exception {
        return service.getPixelBlock(imageId, series, x, y, size);
    }
    @PostMapping("/{imageId}/display/reset")
    public DisplayResponse resetDisplay(@PathVariable String imageId,
                                        @RequestParam(value = "series", defaultValue = "0") int series,
                                        HttpSession session) throws Exception {
        return service.resetDisplay(imageId, series, session);
    }
    @PostMapping("/{imageId}/display/recompute-auto")
    public DisplayResponse recomputeAutomaticDisplay(@PathVariable String imageId,
                                                     @RequestParam(value = "series", defaultValue = "0") int series,
                                                     HttpSession session) throws Exception {
        return service.recomputeAutomaticDisplay(imageId, series, session);
    }
    @PutMapping("/{imageId}/display")
    public DisplayResponse updateDisplay(@PathVariable String imageId,
                                         @RequestParam(value = "series", defaultValue = "0") int series,
                                         @RequestBody DisplayUpdateRequest request,
                                         HttpSession session) throws Exception {
        return service.updateDisplay(imageId, series, request, session);
    }

    private static ResponseEntity<byte[]> pngResponse(byte[] png, String filename) {
        return ResponseEntity.ok()
                .contentType(MediaType.IMAGE_PNG)
                .cacheControl(CacheControl.maxAge(Duration.ofDays(7)).cachePublic())
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.inline()
                                .filename(filename, StandardCharsets.UTF_8)
                                .build()
                                .toString())
                .contentLength(png.length)
                .body(png);
    }
}
