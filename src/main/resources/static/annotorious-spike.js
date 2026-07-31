/**
 * Annotorious evaluation integration.
 *
 * Annotorious owns drawing and editing behavior. AnnotationAdapter converts
 * geometry, while AnnotationStore owns annotation state and persistence.
 */
class AnnotoriousSpike {

    constructor(viewer, toggleButton, getCurrentImageId, timingCallbacks = {}) {
        this.viewer = viewer;
        this.toggleButton = toggleButton;
        this.getCurrentImageId = getCurrentImageId;
        this.timingCallbacks = timingCallbacks;
        this.annotator = null;
        this.adapter = null;
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
        this.adapter = new AnnotationAdapter(this.annotator, {
            annotationsLoaded: imageId => this.timingCallbacks.annotationsLoaded?.(imageId),
            annotationsRendered: imageId => this.timingCallbacks.annotationsRendered?.(imageId)
        });

        this.annotator.on("createAnnotation", annotation => {
            this.adapter.annotationCreated(annotation);
        });

        this.annotator.on("updateAnnotation", (annotation, previous) => {
            this.adapter.annotationUpdated(annotation, previous);
        });

        this.annotator.on("deleteAnnotation", annotation => {
            this.adapter.annotationDeleted(annotation);
        });

        this.annotator.on("selectionChanged", selected => {
            const annotation = Array.isArray(selected) ? selected[0] : selected;
            this.adapter.store.setSelectedAnnotationId(annotation?.id || null);
        });

        this.toggleButton.disabled = false;

        this.toggleButton.addEventListener("click", () => {
            this.setDrawingEnabled(!this.drawingEnabled);
        });

        this.installKeyboardShortcuts();

        this.viewer.addHandler("open", () => {
            const imageId = this.getCurrentImageId?.();
            this.timingCallbacks.open?.(imageId);
            this.setDrawingEnabled(false);
            this.adapter.loadCurrentImage(imageId);
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
