package wsi_server.model;

import java.util.Objects;

/**
 * Display state for one fluorescence channel.
 *
 * Milestone 4 introduces the complete state model while
 * preserving the existing rendering behavior. Later milestones
 * will apply LUT, gamma, opacity, and visibility settings.
 */
public final class ChannelDisplaySettings {

    private boolean visible;
    private DisplayWindow window;
    private LutType lut;
    private double gamma;
    private double opacity;

    public ChannelDisplaySettings() {
        this(
                true,
                new DisplayWindow(0, 65535),
                LutType.GRAY,
                1.0,
                1.0
        );
    }

    public ChannelDisplaySettings(
            boolean visible,
            DisplayWindow window,
            LutType lut,
            double gamma,
            double opacity
    ) {
        this.visible = visible;
        setWindow(window);
        setLut(lut);
        setGamma(gamma);
        setOpacity(opacity);
    }

    public boolean isVisible() {
        return visible;
    }

    public void setVisible(
            boolean visible
    ) {
        this.visible = visible;
    }

    public DisplayWindow getWindow() {
        return window;
    }

    public void setWindow(
            DisplayWindow window
    ) {
        this.window = Objects.requireNonNull(
                window,
                "Display window cannot be null."
        );
    }

    public LutType getLut() {
        return lut;
    }

    public void setLut(
            LutType lut
    ) {
        this.lut = Objects.requireNonNull(
                lut,
                "LUT cannot be null."
        );
    }

    public double getGamma() {
        return gamma;
    }

    public void setGamma(
            double gamma
    ) {
        if (!Double.isFinite(gamma) || gamma <= 0.0) {
            throw new IllegalArgumentException(
                    "Gamma must be a finite value greater than zero."
            );
        }

        this.gamma = gamma;
    }

    public double getOpacity() {
        return opacity;
    }

    public void setOpacity(
            double opacity
    ) {
        if (
                !Double.isFinite(opacity)
                        || opacity < 0.0
                        || opacity > 1.0
        ) {
            throw new IllegalArgumentException(
                    "Opacity must be a finite value between 0.0 and 1.0."
            );
        }

        this.opacity = opacity;
    }
}
