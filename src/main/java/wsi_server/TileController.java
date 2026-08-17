package wsi_server;

import jakarta.servlet.http.HttpSession;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;

@RestController
public class TileController {
    private final BioFormatsTileService service;
    public TileController(BioFormatsTileService service) { this.service = service; }

    @GetMapping(value="/tile/{imageId}/{level}/{x}/{y}.png", produces=MediaType.IMAGE_PNG_VALUE)
    public byte[] tile(@PathVariable String imageId, @PathVariable int level,
                       @PathVariable int x, @PathVariable int y,
                       @RequestParam(defaultValue="0") int channel,
                       @RequestParam(defaultValue="0") int z,
                       @RequestParam(defaultValue="0") int series,
                       HttpSession session) throws Exception {
        return service.getTile(imageId, level, channel, x, y, z, series, session);
    }

    @GetMapping(value="/tile/{imageId}/composite/{level}/{x}/{y}.png", produces=MediaType.IMAGE_PNG_VALUE)
    public byte[] compositeTile(@PathVariable String imageId, @PathVariable int level,
                                @PathVariable int x, @PathVariable int y,
                                @RequestParam(defaultValue="0") long revision,
                                @RequestParam(defaultValue="0") int z,
                                @RequestParam(defaultValue="0") int series,
                                HttpSession session) throws Exception {
        return service.getCompositeTile(imageId, level, x, y, z, series, session);
    }

    @GetMapping(value="/tile/{level}/{x}/{y}.png", produces=MediaType.IMAGE_PNG_VALUE)
    public byte[] legacyTile(@PathVariable int level, @PathVariable int x, @PathVariable int y,
                             @RequestParam(defaultValue="0") int channel,
                             @RequestParam(defaultValue="0") int z,
                             @RequestParam(defaultValue="0") int series,
                             HttpSession session) throws Exception {
        return service.getTile(service.firstImageId(), level, channel, x, y, z, series, session);
    }

    @GetMapping(value="/tile/composite/{level}/{x}/{y}.png", produces=MediaType.IMAGE_PNG_VALUE)
    public byte[] legacyCompositeTile(@PathVariable int level, @PathVariable int x,
                                      @PathVariable int y,
                                      @RequestParam(defaultValue="0") int z,
                                      @RequestParam(defaultValue="0") int series,
                                      HttpSession session) throws Exception {
        return service.getCompositeTile(service.firstImageId(), level, x, y, z, series, session);
    }
}
