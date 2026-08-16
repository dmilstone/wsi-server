package wsi_server;

import java.util.List;
import java.util.Locale;

/** Selects only explicitly identified Bio-Formats associated images. */
final class AssociatedImageSelection {
    static final int MISSING = -1;
    static final String MISSING_LABEL_MESSAGE =
            "This slide does not contain a readable label associated image.";
    static final String MISSING_OVERVIEW_MESSAGE =
            "This slide does not contain a macro/overview associated image.";

    private final int labelSeries;
    private final int overviewSeries;

    private AssociatedImageSelection(int labelSeries, int overviewSeries) {
        this.labelSeries = labelSeries;
        this.overviewSeries = overviewSeries;
    }

    /**
     * True when OME/series naming or Bio-Formats thumbnail designation marks this
     * series as a Label, Macro, Overview, Thumbnail, or Preview — never by size alone.
     */
    static boolean isAssociatedNonDiagnostic(String name, boolean thumbnailSeries) {
        return isExplicitLabel(name) || isExplicitOverview(name, thumbnailSeries);
    }

    /** Specimen / diagnostic scan series (everything that is not an associated preview). */
    static boolean isDiagnosticSpecimen(String name, boolean thumbnailSeries) {
        return !isAssociatedNonDiagnostic(name, thumbnailSeries);
    }

    static boolean isExplicitLabel(String name) {
        String normalized = normalizeName(name);
        return normalized.contains("label") || normalized.contains("barcode");
    }

    static boolean isExplicitOverview(String name, boolean thumbnailSeries) {
        String normalized = normalizeName(name);
        return normalized.contains("macro")
                || normalized.contains("overview")
                || normalized.contains("thumbnail")
                || normalized.contains("preview")
                || thumbnailSeries;
    }

    private static String normalizeName(String name) {
        return name == null ? "" : name.toLowerCase(Locale.ROOT);
    }

    static AssociatedImageSelection select(List<SeriesIdentity> series) {
        int label = MISSING;
        long labelArea = -1;
        int overview = MISSING;
        long overviewArea = -1;
        for (SeriesIdentity candidate : series) {
            if (candidate.width() <= 0 || candidate.height() <= 0) continue;
            boolean explicitlyLabel = isExplicitLabel(candidate.name());
            boolean explicitlyOverview = isExplicitOverview(candidate.name(), candidate.thumbnailSeries());
            long area = (long) candidate.width() * candidate.height();
            if (explicitlyLabel && area > labelArea) {
                label = candidate.index();
                labelArea = area;
            }
            // A label can never double as an overview, even if Bio-Formats also marks it thumbnail-like.
            if (explicitlyOverview && !explicitlyLabel && area > overviewArea) {
                overview = candidate.index();
                overviewArea = area;
            }
        }
        return new AssociatedImageSelection(label, overview);
    }

    int labelSeries() { return labelSeries; }
    int overviewSeries() { return overviewSeries; }
    boolean isLabel(int series) { return series == labelSeries; }
    boolean isOverview(int series) { return series == overviewSeries; }

    int requireLabelSeries() {
        if (labelSeries == MISSING) {
            throw new IllegalStateException(MISSING_LABEL_MESSAGE);
        }
        return labelSeries;
    }

    int requireOverviewSeries() {
        if (overviewSeries == MISSING) {
            throw new IllegalStateException(MISSING_OVERVIEW_MESSAGE);
        }
        return overviewSeries;
    }

    record SeriesIdentity(int index, String name, int width, int height, boolean thumbnailSeries) { }
}
