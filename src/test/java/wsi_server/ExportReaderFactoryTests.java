package wsi_server;

import loci.formats.IFormatReader;
import org.junit.jupiter.api.Test;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class ExportReaderFactoryTests {
    @Test
    void exportReaderClosesItsOwnedBioFormatsReader() throws Exception {
        IFormatReader reader = mock(IFormatReader.class);

        try (ExportReaderFactory.ExportReader ignored =
                     new ExportReaderFactory.ExportReader(reader)) {
            // Lifecycle is deliberately scoped to one export.
        }

        verify(reader).close();
    }
}
