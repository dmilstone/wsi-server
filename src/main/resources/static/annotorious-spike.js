/**
 * Temporary Annotorious evaluation integration.
 *
 * This spike deliberately keeps annotations in browser memory. Persistence and
 * conversion to the WSI server annotation model will be evaluated separately.
 */
class AnnotoriousSpike {

    constructor(viewer, toggleButton) {
        this.viewer = viewer;
        this.toggleButton = toggleButton;
        this.annotator = null;
        this.drawingEnabled = false;

        this.initialize();
    }

    initialize() {
        if (!window.AnnotoriousOSD?.createOSDAnnotator) {
            console.error("Annotorious failed to load; annotation mode is unavailable.");
            this.toggleButton.title = "Annotorious failed to load";
            return;
        }

        this.annotator = window.AnnotoriousOSD.createOSDAnnotator(this.viewer, {
            drawingEnabled: false,
            drawingMode: "drag",
            style: {
                fill: "#ffd54a",
                fillOpacity: 0.14,
                stroke: "#ffd54a",
                strokeOpacity: 1,
                strokeWidth: 2
            }
        });

        this.annotator.setDrawingTool("rectangle");

        this.annotator.on("createAnnotation", annotation => {
            console.info("Annotorious spike: rectangle created", annotation);
        });

        this.annotator.on("updateAnnotation", (annotation, previous) => {
            console.info("Annotorious spike: annotation updated", {
                annotation,
                previous
            });
        });

        this.annotator.on("deleteAnnotation", annotation => {
            console.info("Annotorious spike: annotation deleted", annotation);
        });

        this.toggleButton.disabled = false;

        this.toggleButton.addEventListener("click", () => {
            this.setDrawingEnabled(!this.drawingEnabled);
        });

        this.installKeyboardShortcuts();

        // Annotations from one slide must not be displayed over another during
        // the spike. Backend loading will replace this behavior later.
        this.viewer.addHandler("open", () => {
            this.annotator.clearAnnotations();
            this.setDrawingEnabled(false);
        });
    }

    installKeyboardShortcuts() {
        document.addEventListener("keydown", event => {

            if (event.key !== "Delete" && event.key !== "Backspace") {
                return;
            }

            const target = event.target;

            if (
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target instanceof HTMLSelectElement ||
                target?.isContentEditable
            ) {
                return;
            }

            const selected = this.annotator.getSelected();

            if (!selected || selected.length === 0) {
                return;
            }

            event.preventDefault();

            selected.forEach(annotation => {
                this.annotator.removeAnnotation(annotation);
            });
        });
    }

    setDrawingEnabled(enabled) {
        if (!this.annotator) {
            return;
        }

        this.drawingEnabled = Boolean(enabled);

        this.annotator.setDrawingEnabled(this.drawingEnabled);

        this.toggleButton.setAttribute(
            "aria-pressed",
            String(this.drawingEnabled)
        );

        this.toggleButton.title = this.drawingEnabled
            ? "Exit rectangle annotation mode"
            : "Draw rectangle annotation";

        this.toggleButton.setAttribute(
            "aria-label",
            this.toggleButton.title
        );
    }
}