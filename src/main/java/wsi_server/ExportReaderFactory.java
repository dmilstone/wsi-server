package wsi_server;

import loci.formats.IFormatReader;
import loci.formats.ImageReader;
import loci.formats.MetadataTools;
import org.springframework.stereotype.Component;

/** Opens readers that are owned by one export and never shared with tile requests. */
@Component
class ExportReaderFactory {
    ExportReader open(ImageRegistry.ImageEntry entry) throws Exception {
        IFormatReader reader = new ImageReader();
        boolean opened = false;
        try {
            reader.setMetadataStore(MetadataTools.createOMEXMLMetadata());
            reader.setFlattenedResolutions(false);
            reader.setId(entry.path().toString());
            reader.setSeries(ImageContext.FLUORESCENCE_SERIES);
            reader.setResolution(0);
            opened = true;
            return new ExportReader(reader);
        } finally {
            if (!opened) reader.close();
        }
    }

    static final class ExportReader implements AutoCloseable {
        private final IFormatReader reader;

        ExportReader(IFormatReader reader) {
            this.reader = reader;
        }

        IFormatReader reader() {
            return reader;
        }

        @Override
        public void close() throws Exception {
            reader.close();
        }
    }
}
