package wsi_server;

import java.awt.image.BufferedImage;

/** A small seam around the Bio-Formats pixel APIs; it deliberately performs no series selection. */
final class AssociatedImageDecoder {
    static final String UNSUPPORTED_THUMBNAIL_MESSAGE =
            "Bio-Formats does not provide a meaningful thumbnail for the selected associated-image series.";

    interface Reader {
        void setSeries(int series);
        int sizeX();
        int sizeY();
        int thumbnailSizeX();
        int thumbnailSizeY();
        BufferedImage openFullImage() throws Exception;
        BufferedImage openThumbnailImage() throws Exception;
    }

    BufferedImage decode(Reader reader, int selectedSeries, AssociatedImageDecodeStrategy strategy)
            throws Exception {
        reader.setSeries(selectedSeries);
        if (strategy == AssociatedImageDecodeStrategy.FULL) return reader.openFullImage();

        int width = reader.thumbnailSizeX();
        int height = reader.thumbnailSizeY();
        if (width <= 0 || height <= 0 || (width >= reader.sizeX() && height >= reader.sizeY())) {
            throw new UnsupportedOperationException(UNSUPPORTED_THUMBNAIL_MESSAGE);
        }
        BufferedImage thumbnail = reader.openThumbnailImage();
        if (thumbnail == null || thumbnail.getWidth() <= 0 || thumbnail.getHeight() <= 0) {
            throw new UnsupportedOperationException(UNSUPPORTED_THUMBNAIL_MESSAGE);
        }
        return thumbnail;
    }
}
