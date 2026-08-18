/** Presentation-only annotation names anchored in OpenSeadragon image coordinates. */
class AnnotationLabelLayer {
    static PREFERENCE_KEY = "wsi.annotationNames.visible";
    /** OSD-style anchor: label bottom-center sits on the top-center of the ROI. */
    static LABEL_PLACEMENT = "BOTTOM_CENTER";

    static annotationLabelAnchor(geometry, displacement = { x: 0, y: 0 }) {
        const x = Number(geometry?.x ?? geometry?.bounds?.minX);
        const y = Number(geometry?.y ?? geometry?.bounds?.minY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const width = Number(
            geometry?.w
            ?? (Number.isFinite(geometry?.bounds?.maxX) && Number.isFinite(geometry?.bounds?.minX)
                ? geometry.bounds.maxX - geometry.bounds.minX
                : 0)
        );
        const dx = Number(displacement?.x) || 0;
        const dy = Number(displacement?.y) || 0;
        const centerX = x + (Number.isFinite(width) && width > 0 ? width / 2 : 0);
        return { x: centerX + dx, y: y + dy };
    }

    static applyLabelScreenPosition(element, point) {
        if (typeof AnnotationAdapter !== "undefined"
            && typeof AnnotationAdapter.applyAnnotationOverlayOffset === "function") {
            return AnnotationAdapter.applyAnnotationOverlayOffset(element, point);
        }
        if (!element?.style) return element;
        const x = Math.round(Number(point?.x) || 0);
        const y = Math.round(Number(point?.y) || 0);
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
        // Force tooltip labels to clear the boundary box lines entirely
        element.style.transform = "translate(-50%, -130%)";
        element.style.transformOrigin = "bottom center";
        element.style.zIndex = "100";
        element.style.whiteSpace = "nowrap";
        return element;
    }

    constructor(viewer, annotator, getName, storage = window.localStorage) {
        this.viewer = viewer;
        this.annotator = annotator;
        this.getName = getName;
        this.storage = storage;
        this.currentImageId = null;
        this.labels = new Map();
        this.temporaryDisplacements = new Map();
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
        if (!this.namesVisible) this.clearTemporaryDisplacements();
        try {
            this.storage?.setItem(AnnotationLabelLayer.PREFERENCE_KEY, String(this.namesVisible));
        } catch (_) {
            // A blocked storage API must not prevent the display control working.
        }
        this.updateVisibility();
    }

    setAnnotationsVisible(visible) {
        this.annotationsVisible = Boolean(visible);
        if (!this.annotationsVisible) this.clearTemporaryDisplacements();
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
            element.style.background = "rgba(0,0,0,0.85)";
            element.style.zIndex = "100";
            element.style.whiteSpace = "nowrap";
            element.style.transform = "translate(-50%, -130%)";
            element.style.transformOrigin = "bottom center";
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
        const displacement = this.temporaryDisplacements.get(entry.annotation.id) || { x: 0, y: 0 };
        const anchor = AnnotationLabelLayer.annotationLabelAnchor(geometry, displacement);
        if (!anchor) {
            entry.element.hidden = true;
            return;
        }
        const primaryTiledImage = this.viewer.world.getItemAt(0);
        if (!primaryTiledImage || typeof primaryTiledImage.imageToViewportCoordinates !== "function") {
            entry.element.hidden = true;
            return;
        }
        const viewportPoint = primaryTiledImage.imageToViewportCoordinates(
            new OpenSeadragon.Point(anchor.x, anchor.y));
        const point = this.viewer.viewport.viewportToViewerElementCoordinates(viewportPoint);
        const placement = (typeof OpenSeadragon !== "undefined" && OpenSeadragon.Placement?.BOTTOM_CENTER)
            ? OpenSeadragon.Placement.BOTTOM_CENTER
            : AnnotationLabelLayer.LABEL_PLACEMENT;
        entry.element.hidden = false;
        entry.element.dataset.osdPlacement = String(placement);
        entry.element.style.background = "rgba(0,0,0,0.85)";
        entry.element.style.zIndex = "100";
        entry.element.style.whiteSpace = "nowrap";
        AnnotationLabelLayer.applyLabelScreenPosition(entry.element, point);
    }

    updatePositions() {
        for (const entry of this.labels.values()) this.position(entry);
    }

    setTemporaryDisplacement(id, x, y) {
        const entry = this.labels.get(id);
        if (!entry || !this.namesVisible || !this.annotationsVisible ||
            !Number.isFinite(x) || !Number.isFinite(y)) return;
        this.temporaryDisplacements.set(id, { x, y });
        this.position(entry);
    }

    getTemporaryDisplacement(id) {
        return this.temporaryDisplacements.get(id) || { x: 0, y: 0 };
    }

    clearTemporaryDisplacement(id) {
        this.temporaryDisplacements.delete(id);
    }

    clearTemporaryDisplacements() {
        this.temporaryDisplacements.clear();
        this.updatePositions();
    }

    remove(id) {
        const entry = this.labels.get(id);
        if (!entry) return;
        entry.element.remove();
        this.labels.delete(id);
        this.temporaryDisplacements.delete(id);
    }

    clear() {
        this.temporaryDisplacements.clear();
        for (const id of [...this.labels.keys()]) this.remove(id);
    }

    destroy() {
        ["animation", "resize", "viewport-change"].forEach(event =>
            this.viewer.removeHandler(event, this.updatePositions));
        this.clear();
        this.layer.remove();
    }
}
