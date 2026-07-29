package wsi_server;

import org.springframework.web.bind.annotation.*;

@RestController
public class DziController {


    @GetMapping(
            value="/slide.dzi",
            produces="application/xml"
    )
    public String dzi() {


        int width = 24354;
        int height = 14644;


        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <Image 
          TileSize="512"
          Overlap="0"
          Format="jpg"
          xmlns="http://schemas.microsoft.com/deepzoom/2008">

          <Size 
            Width="%d"
            Height="%d"/>

        </Image>
        """.formatted(width,height);

    }
}