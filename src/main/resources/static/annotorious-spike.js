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

        // Constructing the OSD annotator before the first OpenSeadragon `open`
        // leaves its internal store only partly initialized. A cached annotation
        // request can then reach add/setAnnotations while that store is being
        // created. Initialize from the open event instead, then await loading.
        this.viewer.addHandler("open", () => {
            void this.handleViewerOpen().catch(error =>
                console.error("Annotorious: unable to initialize annotations", error)
            );
        });
    }

    async handleViewerOpen() {
        if (!this.annotator) this.createAnnotator();
        const imageId = this.getCurrentImageId?.();
        this.timingCallbacks.open?.(imageId);
        this.setDrawingEnabled(false);
        this.notifySelectionChanged();
        await this.adapter.loadCurrentImage(imageId);
    }

    createAnnotator() {
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
            annotationsRendered: imageId => {
                this.timingCallbacks.annotationsRendered?.(imageId);
                this.notifySelectionChanged();
            }
        });

        this.annotator.on("createAnnotation", annotation => {
            this.adapter.annotationCreated(annotation);
            this.notifySelectionChanged();
        });

        this.annotator.on("updateAnnotation", (annotation, previous) => {
            this.adapter.annotationUpdated(annotation, previous);
        });

        this.annotator.on("deleteAnnotation", annotation => {
            this.adapter.annotationDeleted(annotation);
            // Annotorious updates its canonical selection after dispatching the
            // delete event, so inspect it once that event has finished.
            queueMicrotask(() => this.notifySelectionChanged());
        });

        this.annotator.on("selectionChanged", () => {
            const annotation = this.getSelectedAnnotations()[0];
            this.adapter.store.setSelectedAnnotationId(annotation?.id || null);
            this.notifySelectionChanged();
        });

        this.toggleButton.disabled = false;

        this.toggleButton.addEventListener("click", () => {
            this.setDrawingEnabled(!this.drawingEnabled);
        });

        this.installKeyboardShortcuts();

    }

    getSelectedAnnotations() {
        if (!this.annotator || typeof this.annotator.getSelected !== "function") return [];
        const selected = this.annotator.getSelected();
        return Array.isArray(selected) ? selected.filter(Boolean) : (selected ? [selected] : []);
    }

    notifySelectionChanged() {
        this.timingCallbacks.selectionChanged?.(this.getSelectedAnnotations());
    }

    getAnnotationBounds(annotation) {
        const geometry = annotation?.target?.selector?.geometry;
        const bounds = geometry?.bounds;
        const minX = Number(bounds?.minX);
        const minY = Number(bounds?.minY);
        const maxX = Number(bounds?.maxX);
        const maxY = Number(bounds?.maxY);

        if ([minX, minY, maxX, maxY].every(Number.isFinite) && maxX > minX && maxY > minY) {
            return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        }

        const x = Number(geometry?.x);
        const y = Number(geometry?.y);
        const width = Number(geometry?.w ?? geometry?.width);
        const height = Number(geometry?.h ?? geometry?.height);
        if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) {
            return { x, y, width, height };
        }

        // Future drawing tools may expose polygon vertices instead of a bounds
        // object. Their image-coordinate bounding box is sufficient for export.
        const points = geometry?.points || geometry?.coordinates;
        const vertices = Array.isArray(points) ? points.map(point => ({
            x: Number(Array.isArray(point) ? point[0] : point?.x),
            y: Number(Array.isArray(point) ? point[1] : point?.y)
        })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)) : [];
        if (vertices.length > 0) {
            const xs = vertices.map(point => point.x);
            const ys = vertices.map(point => point.y);
            const polygonMinX = Math.min(...xs);
            const polygonMinY = Math.min(...ys);
            return {
                x: polygonMinX,
                y: polygonMinY,
                width: Math.max(...xs) - polygonMinX,
                height: Math.max(...ys) - polygonMinY
            };
        }

        throw new Error("The selected annotation has no exportable geometry.");
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
