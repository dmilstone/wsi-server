package wsi_server.plugin;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class NucleiMetricsExporterTests {

    @TempDir
    Path tempDir;

    @Test
    void writesTimestampedCsvWithPerChannelStats() throws Exception {
        NucleiMetricsExporter exporter = new NucleiMetricsExporter(
                tempDir,
                Clock.fixed(Instant.parse("2026-08-17T21:32:00Z"), ZoneOffset.UTC)
        );
        Path file = exporter.write("slide-a", List.of(new NucleusObjectReport(
                0,
                12.5,
                40.0,
                8.0,
                List.of(new ChannelIntensityStats("DAPI", 0, 10.5, 1.25, 20, 4, 9)),
                10.5
        )));
        assertEquals(tempDir.resolve("nuclei_metrics_20260817_213200.csv"), file);
        String csv = Files.readString(file);
        assertTrue(csv.startsWith("object_id,x,y,radius,DAPI_mean,DAPI_sd,DAPI_min,DAPI_max\n"));
        assertTrue(csv.contains("0,12.500000,40.000000,8.000000,10.500000,1.250000,4,20"));
    }
}
