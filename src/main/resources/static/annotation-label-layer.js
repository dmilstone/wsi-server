/** Presentation-only annotation names anchored in OpenSeadragon image coordinates. */
class AnnotationLabelLayer {
    static PREFERENCE_KEY = "wsi.annotationNames.visible";

    constructor(viewer, annotator, getName, storage = window.localStorage) {
        this.viewer = viewer;
        this.annotator = annotator;
        this.getName = getName;
        this.storage = storage;
        this.currentImageId = null;
        this.labels = new Map();
        this.namesVisible = this.readPreference();
        this.annotationsVisible = true;
        this.layer = document.createElement("div");
        this.layer.className = "annotation-name-layer";
        this.layer.style.pointerEvents = "none";
        this.layer.setAttribute("aria-live", "polite");
        this.layer.setAttribute("aria-label", "Annotation names");
        viewer.element.appendChild(this.layer);
        this.updatePositions = this.updatePositions.bind(this);
        ["animation", "resize", "viewport-change"].forEach(event =>
            viewer.addHandler(event, this.updatePositions));
        this.updateVisibility();
    }

    readPreference() {
        try {
            const value = this.storage?.getItem(AnnotationLabelLayer.PREFERENCE_KEY);
            return value === null ? true : value !== "false";
        } catch (_) {
            return true;
        }
    }

    setNamesVisible(visible) {
        this.namesVisible = Boolean(visible);
        try {
            this.storage?.setItem(AnnotationLabelLayer.PREFERENCE_KEY, String(this.namesVisible));
        } catch (_) {
            // A blocked storage API must not prevent the display control working.
        }
        this.updateVisibility();
    }

    setAnnotationsVisible(visible) {
        this.annotationsVisible = Boolean(visible);
        this.updateVisibility();
    }

    updateVisibility() {
        this.layer.hidden = !(this.namesVisible && this.annotationsVisible);
    }

    beginImage(imageId) {
        this.currentImageId = imageId;
        this.clear();
    }

    sync(imageId) {
        if (imageId !== this.currentImageId) return false;
        const annotations = this.annotator?.getAnnotations?.() || [];
        const liveIds = new Set();
        annotations.forEach(annotation => {
            if (!annotation?.id) return;
            liveIds.add(annotation.id);
            this.syncAnnotation(annotation);
        });
        for (const id of this.labels.keys()) {
            if (!liveIds.has(id)) this.remove(id);
        }
        this.updatePositions();
        return true;
    }

    syncAnnotation(annotation) {
        if (!annotation?.id) return;
        const name = String(this.getName(annotation.id) || "").trim();
        if (!name) {
            this.remove(annotation.id);
            return;
        }
        let entry = this.labels.get(annotation.id);
        if (!entry) {
            const element = document.createElement("span");
            element.className = "annotation-name-label";
            element.style.pointerEvents = "none";
            this.layer.appendChild(element);
            entry = { annotation, element };
            this.labels.set(annotation.id, entry);
        }
        entry.annotation = annotation;
        entry.element.textContent = name;
        entry.element.title = name;
        this.position(entry);
    }

    position(entry) {
        const geometry = entry.annotation?.target?.selector?.geometry;
        // Annotorious updates x/y as the live shape moves. In the committed
        // updateAnnotation payload, bounds can briefly retain the pre-drag
        // values, so prefer the same canonical x/y fields used for persistence.
        const x = Number(geometry?.x ?? geometry?.bounds?.minX);
        const y = Number(geometry?.y ?? geometry?.bounds?.minY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            entry.element.hidden = true;
            return;
        }
        const point = this.viewer.viewport.imageToViewerElementCoordinates(
            new OpenSeadragon.Point(x, y));
        entry.element.hidden = false;
        entry.element.style.transform = `translate(${Math.round(point.x + 6)}px, ${Math.round(point.y + 6)}px)`;
    }

    updatePositions() {
        for (const entry of this.labels.values()) this.position(entry);
    }

    remove(id) {
        const entry = this.labels.get(id);
        if (!entry) return;
        entry.element.remove();
        this.labels.delete(id);
    }

    clear() {
        for (const id of [...this.labels.keys()]) this.remove(id);
    }

    destroy() {
        ["animation", "resize", "viewport-change"].forEach(event =>
            this.viewer.removeHandler(event, this.updatePositions));
        this.clear();
        this.layer.remove();
    }
}
