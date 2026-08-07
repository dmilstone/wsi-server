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

    static AssociatedImageSelection select(List<SeriesIdentity> series) {
        int label = MISSING;
        long labelArea = -1;
        int overview = MISSING;
        long overviewArea = -1;
        for (SeriesIdentity candidate : series) {
            if (candidate.width() <= 0 || candidate.height() <= 0) continue;
            String name = candidate.name() == null ? "" : candidate.name().toLowerCase(Locale.ROOT);
            boolean explicitlyLabel = name.contains("label") || name.contains("barcode");
            boolean explicitlyOverview = name.contains("macro") || name.contains("overview")
                    || name.contains("thumbnail") || name.contains("preview")
                    || candidate.thumbnailSeries();
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
