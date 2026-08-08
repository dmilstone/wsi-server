package wsi_server;

import org.junit.jupiter.api.Test;

import java.awt.image.BufferedImage;

import static org.junit.jupiter.api.Assertions.*;

class AssociatedImageDecoderTests {
    private final AssociatedImageDecoder decoder = new AssociatedImageDecoder();

    @Test
    void fullIsTheDefaultAndUsesOnlyTheCurrentFullDecode() throws Exception {
        FakeReader reader = new FakeReader(11);
        assertEquals(AssociatedImageDecodeStrategy.FULL,
                AssociatedImageDecodeStrategy.fromConfiguration("full"));
        assertSame(reader.full, decoder.decode(reader, 7, AssociatedImageDecodeStrategy.FULL));
        assertEquals(7, reader.series);
        assertEquals(1, reader.fullCalls);
        assertEquals(0, reader.thumbnailCalls);
    }

    @Test
    void candidateUsesTheExactSelectedSeriesAndOnlyThumbnailPixelApi() throws Exception {
        FakeReader reader = new FakeReader(22);
        assertSame(reader.thumbnail,
                decoder.decode(reader, 4, AssociatedImageDecodeStrategy.BIO_FORMATS_THUMBNAIL));
        assertEquals(4, reader.series);
        assertEquals(0, reader.fullCalls);
        assertEquals(1, reader.thumbnailCalls);
    }

    @Test
    void unsupportedCandidateFailsWithoutFullOrSynthesizedDiagnosticPixels() {
        FakeReader reader = new FakeReader(33);
        reader.thumbWidth = reader.width;
        reader.thumbHeight = reader.height;
        UnsupportedOperationException failure = assertThrows(UnsupportedOperationException.class,
                () -> decoder.decode(reader, 9, AssociatedImageDecodeStrategy.BIO_FORMATS_THUMBNAIL));
        assertEquals(AssociatedImageDecoder.UNSUPPORTED_THUMBNAIL_MESSAGE, failure.getMessage());
        assertEquals(9, reader.series);
        assertEquals(0, reader.fullCalls);
        assertEquals(0, reader.thumbnailCalls);
    }

    @Test
    void candidateDecodeFailureDoesNotInvokeFullDecode() {
        FakeReader reader = new FakeReader(44);
        reader.thumbnailFailure = new Exception("fake thumbnail failure");
        Exception failure = assertThrows(Exception.class,
                () -> decoder.decode(reader, 5, AssociatedImageDecodeStrategy.BIO_FORMATS_THUMBNAIL));
        assertEquals("fake thumbnail failure", failure.getMessage());
        assertEquals(0, reader.fullCalls);
        assertEquals(1, reader.thumbnailCalls);
    }

    @Test
    void statelessDecoderDoesNotContaminateResultsAcrossImages() throws Exception {
        FakeReader first = new FakeReader(101);
        FakeReader second = new FakeReader(202);
        BufferedImage firstResult = decoder.decode(first, 2, AssociatedImageDecodeStrategy.BIO_FORMATS_THUMBNAIL);
        BufferedImage secondResult = decoder.decode(second, 8, AssociatedImageDecodeStrategy.BIO_FORMATS_THUMBNAIL);
        assertSame(first.thumbnail, firstResult);
        assertSame(second.thumbnail, secondResult);
        assertNotSame(firstResult, secondResult);
        assertEquals(2, first.series);
        assertEquals(8, second.series);
    }

    @Test
    void configurationRequiresAnExplicitKnownOptIn() {
        assertEquals(AssociatedImageDecodeStrategy.FULL,
                AssociatedImageDecodeStrategy.fromConfiguration(null));
        assertEquals(AssociatedImageDecodeStrategy.BIO_FORMATS_THUMBNAIL,
                AssociatedImageDecodeStrategy.fromConfiguration("bio-formats-thumbnail"));
        assertThrows(IllegalArgumentException.class,
                () -> AssociatedImageDecodeStrategy.fromConfiguration("thumbnail-ish"));
    }

    private static final class FakeReader implements AssociatedImageDecoder.Reader {
        final BufferedImage full;
        final BufferedImage thumbnail;
        int series = -1;
        int width = 800;
        int height = 600;
        int thumbWidth = 80;
        int thumbHeight = 60;
        int fullCalls;
        int thumbnailCalls;
        Exception thumbnailFailure;

        FakeReader(int color) {
            full = new BufferedImage(2, 2, BufferedImage.TYPE_INT_RGB);
            thumbnail = new BufferedImage(1, 1, BufferedImage.TYPE_INT_RGB);
            thumbnail.setRGB(0, 0, color);
        }

        public void setSeries(int series) { this.series = series; }
        public int sizeX() { return width; }
        public int sizeY() { return height; }
        public int thumbnailSizeX() { return thumbWidth; }
        public int thumbnailSizeY() { return thumbHeight; }
        public BufferedImage openFullImage() { fullCalls++; return full; }
        public BufferedImage openThumbnailImage() throws Exception {
            thumbnailCalls++;
            if (thumbnailFailure != null) throw thumbnailFailure;
            return thumbnail;
        }
    }
}
