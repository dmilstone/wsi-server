package wsi_server.plugin;

/**
 * Single-pass population mean / standard deviation / min / max over an intensity plane.
 * Masked samples ({@code mask[i] == false}) are skipped.
 */
final class IntensityStatsAnalyzer {

    private IntensityStatsAnalyzer() {
    }

    static ChannelIntensityStats summarize(String name, int index, int[] plane, boolean[] mask) {
        if (plane == null || plane.length == 0) {
            return new ChannelIntensityStats(name, index, 0, 0, 0, 0, 0);
        }
        long n = 0;
        double mean = 0;
        double m2 = 0;
        int min = Integer.MAX_VALUE;
        int max = Integer.MIN_VALUE;
        int limit = plane.length;
        for (int i = 0; i < limit; i++) {
            if (mask != null && (i >= mask.length || !mask[i])) continue;
            int value = plane[i];
            n += 1;
            double delta = value - mean;
            mean += delta / n;
            m2 += delta * (value - mean);
            if (value < min) min = value;
            if (value > max) max = value;
        }
        if (n == 0) {
            return new ChannelIntensityStats(name, index, 0, 0, 0, 0, 0);
        }
        double stdDev = Math.sqrt(m2 / n);
        return new ChannelIntensityStats(name, index, mean, stdDev, max, min, n);
    }
}
