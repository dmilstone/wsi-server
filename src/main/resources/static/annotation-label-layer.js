/** Presentation-only annotation names anchored in OpenSeadragon image coordinates. */
class AnnotationLabelLayer {
    static PREFERENCE_KEY = "wsi.annotationNames.visible";

    constructor(viewer, annotator, getName, storage = window.localStorage, onEditRequest = null) {
        this.viewer = viewer;
        this.annotator = annotator;
        this.getName = getName;
        this.storage = storage;
        this.onEditRequest = onEditRequest;
        this.currentImageId = null;
        this.selectedId = null;
        this.editingId = null;
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
        this.selectedId = null;
        this.editingId = null;
        this.clear();
    }

    setSelectedAnnotationId(id) {
        const nextId = id || null;
        if (this.selectedId === nextId) {
            this.refreshSelectionPresentation();
            return;
        }
        this.selectedId = nextId;
        this.refreshSelectionPresentation();
    }

    setEditingAnnotationId(id) {
        this.editingId = id || null;
        this.refreshSelectionPresentation();
    }

    refreshSelectionPresentation() {
        const annotations = this.annotator?.getAnnotations?.() || [];
        const liveIds = new Set(annotations.map(item => item?.id).filter(Boolean));
        if (this.selectedId && !liveIds.has(this.selectedId)) this.selectedId = null;
        annotations.forEach(annotation => {
            if (annotation?.id) this.syncAnnotation(annotation);
        });
        for (const id of [...this.labels.keys()]) {
            if (!liveIds.has(id) && id !== this.selectedId) this.remove(id);
        }
        this.updatePositions();
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
        if (this.editingId === annotation.id) return;
        const name = String(this.getName(annotation.id) || "").trim();
        const selected = annotation.id === this.selectedId;
        if (!name && !selected) {
            this.remove(annotation.id);
            return;
        }
        let entry = this.labels.get(annotation.id);
        if (!entry) {
            const element = document.createElement("span");
            element.className = "annotation-name-label";
            element.style.pointerEvents = "none";
            const onClick = event => {
                event.preventDefault();
                event.stopPropagation();
                if (entry.annotation?.id !== this.selectedId) return;
                this.onEditRequest?.(entry.annotation.id, entry.element);
            };
            element.addEventListener("click", onClick);
            this.layer.appendChild(element);
            entry = { annotation, element, onClick };
            this.labels.set(annotation.id, entry);
        }
        entry.annotation = annotation;
        const displayName = name || "Unnamed annotation";
        entry.element.textContent = displayName;
        entry.element.title = selected
            ? (name ? `${name} — click to rename` : "Click to name this annotation")
            : displayName;
        entry.element.classList.toggle("is-placeholder", !name);
        entry.element.classList.toggle("is-editable", selected);
        entry.element.style.pointerEvents = selected ? "auto" : "none";
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
        // During image open/switch OpenSeadragon can briefly lack content bounds;
        // skip placement instead of letting viewport.js throw on undefined.x.
        const tiledImage = this.viewer?.world?.getItemCount?.()
            ? this.viewer.world.getItemAt(0)
            : null;
        if (!tiledImage || !this.viewer?.viewport) {
            entry.element.hidden = true;
            return;
        }
        const displacement = this.temporaryDisplacements.get(entry.annotation.id) || { x: 0, y: 0 };
        let point;
        try {
            const imagePoint = new OpenSeadragon.Point(x + displacement.x, y + displacement.y);
            point = typeof tiledImage.imageToViewerElementCoordinates === "function"
                ? tiledImage.imageToViewerElementCoordinates(imagePoint)
                : this.viewer.viewport.imageToViewerElementCoordinates(imagePoint);
        } catch (_) {
            entry.element.hidden = true;
            return;
        }
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            entry.element.hidden = true;
            return;
        }
        entry.element.hidden = false;
        entry.element.style.transform = `translate(${Math.round(point.x + 6)}px, ${Math.round(point.y + 6)}px)`;
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
        if (entry.onClick) entry.element.removeEventListener("click", entry.onClick);
        entry.element.remove();
        this.labels.delete(id);
        this.temporaryDisplacements.delete(id);
        if (this.editingId === id) this.editingId = null;
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
