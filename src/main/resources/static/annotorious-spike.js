/**
 * Annotorious evaluation integration.
 *
 * Annotorious owns drawing and editing behavior. AnnotationAdapter converts
 * geometry, while AnnotationStore owns annotation state and persistence.
 */
class AnnotoriousSpike {

    constructor(viewer, toggleButton, visibilityButton, namesButton, nameInput, getCurrentImageId, timingCallbacks = {}) {
        this.viewer = viewer;
        this.toggleButton = toggleButton;
        this.visibilityButton = visibilityButton;
        this.namesButton = namesButton;
        this.nameInput = nameInput;
        this.getCurrentImageId = getCurrentImageId;
        this.timingCallbacks = timingCallbacks;
        this.annotator = null;
        this.adapter = null;
        this.drawingEnabled = false;
        this.annotationsVisible = true;
        this.labelGeneration = 0;
        this.labelRefreshVersions = new Map();
        this.annotationPointerEdit = null;

        this.initialize();
    }

    initialize() {
        if (!window.AnnotoriousOSD?.createOSDAnnotator) {
            console.error("Annotorious failed to load; annotation mode is unavailable.");
            this.toggleButton.title = "Annotorious failed to load";
            return;
        }

        // Annotorious must subscribe to OpenSeadragon before its first `open`.
        // Creating it from inside `open` makes it miss the lifecycle event that
        // initializes and invalidates its SVG overlay.
        this.createAnnotator();
        this.viewer.addHandler("open", () => {
            void this.handleViewerOpen().catch(error =>
                console.error("Annotorious: unable to initialize annotations", error)
            );
        });
    }

    async handleViewerOpen() {
        const imageId = this.getCurrentImageId?.();
        this.beginLabelImage(imageId);
        this.timingCallbacks.open?.(imageId);
        this.setDrawingEnabled(false);
        // Cancel any draft before the old Annotorious selection can outlive an
        // image switch. Loading will publish the new image's actual selection.
        this.nameEditor?.setSelection([], this.annotationsVisible);
        this.timingCallbacks.selectionChanged?.([]);
        // Annotorious' own OSD open handler runs before this handler, but its
        // overlay/store commit completes during the next paint. Do not let a
        // cached annotation response overtake that commit on the first image.
        await this.waitForAnnotoriousReady();
        await this.adapter.loadCurrentImage(imageId);
    }

    waitForAnnotoriousReady() {
        return new Promise(resolve => window.requestAnimationFrame(() =>
            window.requestAnimationFrame(resolve)
        ));
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
                this.labelLayer?.sync(imageId);
                this.timingCallbacks.annotationsRendered?.(imageId);
                this.notifySelectionChanged();
            }
        });
        this.nameEditor = new AnnotationNameEditor(
            this.nameInput,
            this.adapter,
            id => {
                this.labelLayer?.setEditingAnnotationId(null);
                const annotation = this.annotator.getAnnotations().find(item => item.id === id);
                if (annotation) this.labelLayer?.syncAnnotation(annotation);
                else this.labelLayer?.refreshSelectionPresentation();
            },
            () => {
                this.labelLayer?.setEditingAnnotationId(null);
                this.labelLayer?.refreshSelectionPresentation();
            }
        );
        this.labelLayer = new AnnotationLabelLayer(
            this.viewer,
            this.annotator,
            id => this.adapter.getAnnotationName(id),
            window.localStorage,
            (id, host) => {
                this.labelLayer.setEditingAnnotationId(id);
                const started = this.nameEditor.beginInlineEdit(host);
                if (!started) this.labelLayer.setEditingAnnotationId(null);
            }
        );

        this.annotator.on("createAnnotation", annotation => {
            this.adapter.annotationCreated(annotation);
            this.labelLayer.syncAnnotation(annotation);
            this.notifySelectionChanged();
        });

        this.annotator.on("updateAnnotation", (annotation, previous) => {
            this.adapter.annotationUpdated(annotation, previous);
            this.scheduleCommittedLabelRefresh(annotation?.id);
        });

        this.annotator.on("deleteAnnotation", annotation => {
            if (this.annotationPointerEdit?.annotationId === annotation?.id) {
                this.annotationPointerEdit = null;
            }
            this.cancelCommittedLabelRefresh(annotation?.id);
            this.adapter.annotationDeleted(annotation);
            this.labelLayer.remove(annotation.id);
            // Annotorious updates its canonical selection after dispatching the
            // delete event, so inspect it once that event has finished.
            queueMicrotask(() => this.notifySelectionChanged());
        });

        this.annotator.on("selectionChanged", () => {
            const annotation = this.getSelectedAnnotations()[0];
            if (this.annotationPointerEdit &&
                annotation?.id !== this.annotationPointerEdit.annotationId) {
                this.labelLayer.clearTemporaryDisplacement(this.annotationPointerEdit.annotationId);
                this.labelLayer.updatePositions();
                this.annotationPointerEdit = null;
            }
            this.adapter.store.setSelectedAnnotationId(annotation?.id || null);
            this.notifySelectionChanged();
        });

        this.toggleButton.disabled = false;
        this.visibilityButton.disabled = false;
        this.namesButton.disabled = false;
        this.updateNamesButton();

        this.toggleButton.addEventListener("click", () => {
            this.setDrawingEnabled(!this.drawingEnabled);
        });

        this.visibilityButton.addEventListener("click", () => {
            this.setAnnotationsVisible(!this.annotationsVisible);
        });
        this.namesButton.addEventListener("click", () => {
            const visible = !this.labelLayer.namesVisible;
            if (!visible) this.annotationPointerEdit = null;
            this.labelLayer.setNamesVisible(visible);
            this.updateNamesButton();
        });

        this.installKeyboardShortcuts();
        this.installAnnotationLabelMovement();

    }

    installAnnotationLabelMovement() {
        const element = this.viewer.element;
        element.addEventListener("pointerdown", event => {
            this.annotationPointerEdit = null;
            if (this.drawingEnabled || event.button !== 0) return;
            const selected = this.getSelectedAnnotations();
            if (selected.length !== 1 || !this.annotationContainsClientPoint(selected[0], event)) return;
            const point = this.clientToImagePoint(event);
            const displacement = this.labelLayer.getTemporaryDisplacement(selected[0].id);
            this.annotationPointerEdit = {
                pointerId: event.pointerId,
                annotationId: selected[0].id,
                startX: event.clientX,
                startY: event.clientY,
                startImageX: point.x,
                startImageY: point.y,
                startDisplacementX: displacement.x,
                startDisplacementY: displacement.y
            };
        }, true);
        element.addEventListener("pointermove", event => {
            const edit = this.annotationPointerEdit;
            if (!edit || edit.pointerId !== event.pointerId) return;
            if (Math.hypot(event.clientX - edit.startX, event.clientY - edit.startY) >= 3) {
                const point = this.clientToImagePoint(event);
                this.labelLayer.setTemporaryDisplacement(
                    edit.annotationId,
                    edit.startDisplacementX + point.x - edit.startImageX,
                    edit.startDisplacementY + point.y - edit.startImageY);
            }
        }, true);
        element.addEventListener("pointerup", event => {
            if (this.annotationPointerEdit?.pointerId !== event.pointerId) return;
            this.annotationPointerEdit = null;
            // Keep the presentation-only displacement until Annotorious emits
            // its native committed update. Never alter its selection lifecycle.
        }, true);
        element.addEventListener("pointercancel", event => {
            if (this.annotationPointerEdit?.pointerId !== event.pointerId) return;
            if (this.annotationPointerEdit?.annotationId) {
                this.labelLayer.clearTemporaryDisplacement(this.annotationPointerEdit.annotationId);
                this.labelLayer.updatePositions();
            }
            this.annotationPointerEdit = null;
        }, true);
    }

    clientToImagePoint(event) {
        const rect = this.viewer.element.getBoundingClientRect();
        const elementPoint = new OpenSeadragon.Point(
            event.clientX - rect.left, event.clientY - rect.top);
        const tiledImage = this.viewer.world?.getItemCount?.()
            ? this.viewer.world.getItemAt(0)
            : null;
        if (tiledImage && typeof tiledImage.viewerElementToImageCoordinates === "function") {
            return tiledImage.viewerElementToImageCoordinates(elementPoint);
        }
        return this.viewer.viewport.viewerElementToImageCoordinates(elementPoint);
    }

    annotationContainsClientPoint(annotation, event) {
        const geometry = annotation?.target?.selector?.geometry;
        const x = Number(geometry?.x ?? geometry?.bounds?.minX);
        const y = Number(geometry?.y ?? geometry?.bounds?.minY);
        const width = Number(geometry?.w ?? geometry?.width ??
            (geometry?.bounds?.maxX - geometry?.bounds?.minX));
        const height = Number(geometry?.h ?? geometry?.height ??
            (geometry?.bounds?.maxY - geometry?.bounds?.minY));
        if (![x, y, width, height].every(Number.isFinite)) return false;
        const point = this.clientToImagePoint(event);
        return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
    }

    beginLabelImage(imageId) {
        this.annotationPointerEdit = null;
        this.labelGeneration += 1;
        this.labelRefreshVersions.clear();
        this.labelLayer?.beginImage(imageId);
    }

    scheduleCommittedLabelRefresh(annotationId) {
        if (!annotationId) return;
        const generation = this.labelGeneration;
        const imageId = this.getCurrentImageId?.();
        const version = (this.labelRefreshVersions.get(annotationId) || 0) + 1;
        this.labelRefreshVersions.set(annotationId, version);

        // Annotorious dispatches updateAnnotation while its public collection
        // can still expose the pre-drag object. The next paint is its supported
        // post-event boundary: re-read by ID rather than trusting the payload.
        window.requestAnimationFrame(() => {
            if (generation !== this.labelGeneration ||
                imageId !== this.getCurrentImageId?.() ||
                this.labelRefreshVersions.get(annotationId) !== version) return;
            const committed = this.annotator.getAnnotations()
                .find(annotation => annotation?.id === annotationId);
            if (committed) {
                this.labelLayer.clearTemporaryDisplacement(annotationId);
                this.labelLayer.syncAnnotation(committed);
            }
        });
    }

    cancelCommittedLabelRefresh(annotationId) {
        if (!annotationId) return;
        this.labelRefreshVersions.set(
            annotationId, (this.labelRefreshVersions.get(annotationId) || 0) + 1);
    }

    updateNamesButton() {
        const shown = this.labelLayer.namesVisible;
        this.namesButton.setAttribute("aria-pressed", String(shown));
        this.namesButton.textContent = "Names";
        this.namesButton.title = shown ? "Hide annotation names" : "Show annotation names";
        this.namesButton.setAttribute("aria-label", this.namesButton.title);
        this.namesButton.setAttribute("data-tooltip", this.namesButton.title);
    }

    getSelectedAnnotations() {
        if (!this.annotator || typeof this.annotator.getSelected !== "function") return [];
        const selected = this.annotator.getSelected();
        return Array.isArray(selected) ? selected.filter(Boolean) : (selected ? [selected] : []);
    }

    notifySelectionChanged() {
        const selected = this.getSelectedAnnotations();
        this.nameEditor?.setSelection(selected, this.annotationsVisible);
        const selectedId = selected.length === 1 ? selected[0].id : null;
        this.labelLayer?.setSelectedAnnotationId(selectedId);
        this.timingCallbacks.selectionChanged?.(selected);
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
            if (!this.annotationsVisible) return;

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

        this.drawingEnabled = Boolean(enabled) && this.annotationsVisible;
        if (this.drawingEnabled) {
            this.annotationPointerEdit = null;
            this.labelLayer?.clearTemporaryDisplacements();
        }
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
        this.toggleButton.setAttribute(
            "data-tooltip",
            this.drawingEnabled
                ? "Rectangle\nExit rectangle annotation mode"
                : "Rectangle\nDraw rectangle annotation"
        );
    }

    setAnnotationsVisible(visible) {
        this.annotationsVisible = Boolean(visible);

        // This is deliberately a presentation-only switch. Do not remove,
        // replace, or mutate annotations through Annotorious or AnnotationStore.
        // Keeping the live annotator intact also makes showing the layer instant.
        this.viewer.element.classList.toggle("annotations-hidden", !this.annotationsVisible);
        if (!this.annotationsVisible) {
            this.annotationPointerEdit = null;
            this.labelLayer?.clearTemporaryDisplacements();
        }
        this.labelLayer?.setAnnotationsVisible(this.annotationsVisible);

        if (!this.annotationsVisible) this.setDrawingEnabled(false);
        this.toggleButton.disabled = !this.annotationsVisible;
        this.visibilityButton.setAttribute("aria-pressed", String(this.annotationsVisible));
        this.visibilityButton.textContent = "Annotations";
        const visibilityAction = this.annotationsVisible ? "Hide annotations" : "Show annotations";
        this.visibilityButton.title = visibilityAction;
        this.visibilityButton.setAttribute("aria-label", visibilityAction);
        this.visibilityButton.setAttribute("data-tooltip", visibilityAction);
        this.notifySelectionChanged();
    }
}
