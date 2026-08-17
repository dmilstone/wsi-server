package wsi_server.plugin;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Writes per-object intensity metrics to {@code exports/nuclei_metrics_*.csv}.
 */
@Component
public class NucleiMetricsExporter {

    private static final Logger LOGGER = LoggerFactory.getLogger(NucleiMetricsExporter.class);
    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss");

    private final Path directory;
    private final Clock clock;

    public NucleiMetricsExporter() {
        // Default empty constructor for Spring container bean instantiation
        this(resolveDirectory(""), Clock.systemDefaultZone());
    }

    @Autowired
    public NucleiMetricsExporter(
            @Value("${wsi.plugin.exports-directory:}") String directory
    ) {
        this(resolveDirectory(directory), Clock.systemDefaultZone());
    }

    NucleiMetricsExporter(Path directory, Clock clock) {
        this.directory = directory;
        this.clock = clock == null ? Clock.systemDefaultZone() : clock;
    }

    static Path resolveDirectory(String directory) {
        if (directory != null && !directory.isBlank()) return Path.of(directory.trim());
        return Path.of(System.getProperty("user.dir", "."), "exports");
    }

    public Path write(String imageId, List<NucleusObjectReport> reports) throws Exception {
        Files.createDirectories(directory);
        String stamp = STAMP.withZone(clock.getZone()).format(clock.instant());
        Path file = uniqueFile("nuclei_metrics_" + stamp);
        Files.writeString(file, toCsv(reports), StandardCharsets.UTF_8);
        String message = "Saved nuclei metrics: " + file.toAbsolutePath();
        if (imageId != null && !imageId.isBlank()) {
            message = message + " [" + imageId + "]";
        }
        LOGGER.info(message);
        System.out.println(message);
        return file;
    }

    Path directory() {
        return directory;
    }

    static String toCsv(List<NucleusObjectReport> reports) {
        List<NucleusObjectReport> rows = reports == null ? List.of() : reports;
        List<String> channels = channelHeaders(rows);
        StringBuilder csv = new StringBuilder();
        csv.append("object_id,x,y,radius");
        for (String channel : channels) {
            csv.append(',').append(csvCell(channel + "_mean"))
                    .append(',').append(csvCell(channel + "_sd"))
                    .append(',').append(csvCell(channel + "_min"))
                    .append(',').append(csvCell(channel + "_max"));
        }
        csv.append('\n');
        for (NucleusObjectReport row : rows) {
            if (row == null) continue;
            csv.append(row.objectId()).append(',')
                    .append(number(row.x())).append(',')
                    .append(number(row.y())).append(',')
                    .append(number(row.radius()));
            for (String channel : channels) {
                ChannelIntensityStats stats = findChannel(row.channels(), channel);
                if (stats == null || stats.sampleCount() <= 0) {
                    csv.append(",,,,");
                    continue;
                }
                csv.append(',').append(number(stats.mean()))
                        .append(',').append(number(stats.stdDev()))
                        .append(',').append(stats.minimum())
                        .append(',').append(stats.maximum());
            }
            csv.append('\n');
        }
        return csv.toString();
    }

    private Path uniqueFile(String stem) {
        Path file = directory.resolve(stem + ".csv");
        int n = 1;
        while (Files.exists(file)) {
            file = directory.resolve(stem + "_" + n + ".csv");
            n += 1;
        }
        return file;
    }

    private static List<String> channelHeaders(List<NucleusObjectReport> rows) {
        Set<String> names = new LinkedHashSet<>();
        for (NucleusObjectReport row : rows) {
            if (row == null || row.channels() == null) continue;
            for (ChannelIntensityStats stats : row.channels()) {
                if (stats == null || stats.name() == null || stats.name().isBlank()) continue;
                names.add(headerToken(stats.name()));
            }
        }
        return new ArrayList<>(names);
    }

    private static ChannelIntensityStats findChannel(List<ChannelIntensityStats> channels, String header) {
        if (channels == null) return null;
        for (ChannelIntensityStats stats : channels) {
            if (stats != null && header.equals(headerToken(stats.name()))) return stats;
        }
        return null;
    }

    private static String headerToken(String name) {
        String token = name == null ? "channel" : name.trim().replaceAll("[^A-Za-z0-9]+", "_");
        if (token.isBlank()) return "channel";
        return token;
    }

    private static String number(double value) {
        if (!Double.isFinite(value)) return "";
        return String.format(Locale.US, "%.6f", value);
    }

    private static String csvCell(String value) {
        if (value == null) return "";
        if (value.indexOf(',') >= 0 || value.indexOf('"') >= 0 || value.indexOf('\n') >= 0) {
            return '"' + value.replace("\"", "\"\"") + '"';
        }
        return value;
    }
}
