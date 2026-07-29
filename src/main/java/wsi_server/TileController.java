package wsi_server;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class TileController {

    private final BioFormatsTileService service;

    public TileController(
            BioFormatsTileService service
    ) {
        this.service = service;
    }

    @GetMapping(
            value = "/tile/{level}/{x}/{y}.png",
            produces = MediaType.IMAGE_PNG_VALUE
    )
    public byte[] tile(
            @PathVariable int level,
            @PathVariable int x,
            @PathVariable int y,
            @RequestParam(
                    defaultValue = "0"
            ) int channel
    ) throws Exception {

        return service.getTile(
                level,
                channel,
                x,
                y
        );
    }
}