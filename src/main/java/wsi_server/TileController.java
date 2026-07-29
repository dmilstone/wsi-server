package wsi_server;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;

@RestController
public class TileController {


    private final BioFormatsTileService service;


    public TileController(BioFormatsTileService service) {
        this.service = service;
    }


    @GetMapping(
            value="/tile/{level}/{x}/{y}.jpg",
            produces=MediaType.IMAGE_JPEG_VALUE
    )
    public byte[] tile(
            @PathVariable int level,
            @PathVariable int x,
            @PathVariable int y
    ) throws Exception {


        int[] seriesMap = {
                19,
                18,
                17,
                16,
                15,
                14,
                13
        };


        if (level < 0 || level >= seriesMap.length) {
            throw new IllegalArgumentException(
                    "Invalid level: " + level
            );
        }


        int series = seriesMap[level];


        int pixelX = x * 512;
        int pixelY = y * 512;


        return service.getTile(
                series,
                pixelX,
                pixelY
        );
    }
}