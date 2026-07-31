package wsi_server;

import jakarta.servlet.http.HttpSession;
import org.springframework.stereotype.Service;

@Service
public class ExportService {
    private final BioFormatsTileService imageService;

    public ExportService(BioFormatsTileService imageService) {
        this.imageService = imageService;
    }

    public byte[] export(String imageId, int x, int y, int width, int height,
                         double scale, HttpSession session) throws Exception {
        if (imageId == null || imageId.isBlank()) {
            throw new IllegalArgumentException("An image id is required.");
        }
        if (!Double.isFinite(scale) || scale <= 0) {
            throw new IllegalArgumentException("Scale must be a finite number greater than zero.");
        }
        return imageService.exportRegion(imageId, x, y, width, height, scale, session);
    }
}
