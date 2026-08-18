package wsi_server.plugin;

/**
 * Ruifrok–Johnston optical-density unmixing for Hematoxylin + DAB.
 * {@code OD = -log10(I / 255)}, then {@code stains = M⁻¹ · OD}.
 */
final class IhcColorDeconvolution {

    /** Normalized Hematoxylin absorption (R, G, B). */
    static final double[] HEMATOXYLIN = {0.6500286, 0.704031, 0.2860126};

    /** Normalized DAB absorption (R, G, B). */
    static final double[] DAB = {0.26814753, 0.57031375, 0.77642715};

    private static final double[][] INV;

    static {
        double[] residual = normalize(cross(HEMATOXYLIN, DAB));
        double[][] matrix = {
                {HEMATOXYLIN[0], HEMATOXYLIN[1], HEMATOXYLIN[2]},
                {DAB[0], DAB[1], DAB[2]},
                {residual[0], residual[1], residual[2]}
        };
        INV = invert3(matrix);
    }

    private IhcColorDeconvolution() {
    }

    static double opticalDensity(int raw) {
        int value = Math.max(1, Math.min(255, raw));
        return -Math.log10(value / 255.0);
    }

    static double dabAmount(int red, int green, int blue) {
        double odR = opticalDensity(red);
        double odG = opticalDensity(green);
        double odB = opticalDensity(blue);
        return INV[1][0] * odR + INV[1][1] * odG + INV[1][2] * odB;
    }

    static double[] dabPlane(int[] red, int[] green, int[] blue) {
        int n = Math.min(red == null ? 0 : red.length, Math.min(
                green == null ? 0 : green.length,
                blue == null ? 0 : blue.length));
        double[] dab = new double[n];
        for (int i = 0; i < n; i++) {
            dab[i] = dabAmount(red[i], green[i], blue[i]);
        }
        return dab;
    }

    static OdSummary summarize(double[] plane, boolean[] mask) {
        if (plane == null || plane.length == 0) return OdSummary.empty();
        long n = 0;
        double mean = 0;
        double m2 = 0;
        double min = Double.POSITIVE_INFINITY;
        double max = Double.NEGATIVE_INFINITY;
        for (int i = 0; i < plane.length; i++) {
            if (mask != null && (i >= mask.length || !mask[i])) continue;
            double value = plane[i];
            if (!Double.isFinite(value)) continue;
            n += 1;
            double delta = value - mean;
            mean += delta / n;
            m2 += delta * (value - mean);
            if (value < min) min = value;
            if (value > max) max = value;
        }
        if (n == 0) return OdSummary.empty();
        return new OdSummary(mean, Math.sqrt(m2 / n), max, min, n);
    }

    record OdSummary(double mean, double stdDev, double maximum, double minimum, long sampleCount) {
        static OdSummary empty() {
            return new OdSummary(0, 0, 0, 0, 0);
        }
    }

    private static double[] cross(double[] a, double[] b) {
        return new double[] {
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0]
        };
    }

    private static double[] normalize(double[] v) {
        double n = Math.hypot(v[0], Math.hypot(v[1], v[2]));
        if (n < 1e-12) return new double[] {0, 0, 1};
        return new double[] {v[0] / n, v[1] / n, v[2] / n};
    }

    private static double[][] invert3(double[][] m) {
        double det =
                m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        if (Math.abs(det) < 1e-12) {
            throw new IllegalStateException("H-DAB stain matrix is singular.");
        }
        double invDet = 1.0 / det;
        return new double[][] {
                {
                        (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * invDet,
                        (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invDet,
                        (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invDet
                },
                {
                        (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invDet,
                        (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invDet,
                        (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * invDet
                },
                {
                        (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * invDet,
                        (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * invDet,
                        (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * invDet
                }
        };
    }
}
