/**
 * Bridges Annotorious and the WSI server annotation document API.
 *
 * The backend stores one complete AnnotationCollection per image/user. Browser
 * edits are therefore debounced and persisted with PUT rather than individual
 * create/update/delete requests.
 */
class AnnotationAdapter {

    constructor(annotator) {
        this.annotator = annotator;

        this.loadGeneration = 0;
        this.currentImageId = null;
        this.currentCollection = null;

        this.metadataById = new Map();
        this.backendIdByClientId = new Map();
        this.nonDisplayedAnnotations = [];

        this.saveTimer = null;
        this.saveDelayMs = 400;
        this.changeVersion = 0;
        this.savedVersion = 0;
        this.saveInProgress = false;
        this.activeSavePromise = null;
        this.saveRequested = false;
        this.suppressEvents = false;
        this.ignoredDeletedAnnotationIds = new Set();
    }

    async loadCurrentImage(imageId) {
        const nextImageId = imageId || null;

        // Do not discard a pending edit merely because the user changed slides.
        if (this.currentImageId && this.currentImageId !== nextImageId && this.hasUnsavedChanges()) {
            await this.flushSave();
        }

        const generation = ++this.loadGeneration;
        this.cancelSaveTimer();
        this.currentImageId = nextImageId;
        this.currentCollection = null;
        this.metadataById.clear();
        this.backendIdByClientId.clear();
        this.nonDisplayedAnnotations = [];
        this.changeVersion = 0;
        this.savedVersion = 0;

        this.replaceAnnotoriousAnnotations([]);

        if (!this.currentImageId) {
            return;
        }

        try {
            const response = await fetch(
                `/api/images/${encodeURIComponent(this.currentImageId)}/annotations`,
                { headers: { "Accept": "application/json" } }
            );

            if (!response.ok) {
                throw new Error(await this.responseError(response));
            }

            const collection = await response.json();

            // Ignore a response that completed after another image was selected.
            if (generation !== this.loadGeneration || collection.imageId !== this.currentImageId) {
                return;
            }

            this.applyBackendCollection(collection);

            console.info(
                `AnnotationAdapter: loaded ${this.annotator.getAnnotations().length} annotation${this.annotator.getAnnotations().length === 1 ? "" : "s"}`,
                collection
            );
        } catch (error) {
            if (generation !== this.loadGeneration) {
                return;
            }

            console.error(
                `AnnotationAdapter: unable to load annotations for image ${this.currentImageId}`,
                error
            );
        }
    }

    annotationCreated(annotation) {
        if (this.suppressEvents) return;
        console.info("AnnotationAdapter: annotation created", annotation);
        this.scheduleSave();
    }

    annotationUpdated(annotation, previous) {
        if (this.suppressEvents) return;
        console.info("AnnotationAdapter: annotation updated", { annotation, previous });
        this.scheduleSave();
    }

    annotationDeleted(annotation) {
        const annotationId = annotation?.id;

        // Annotorious may emit delete events asynchronously after a programmatic
        // clear. Those are UI housekeeping events, not user edits.
        if (annotationId && this.ignoredDeletedAnnotationIds.delete(annotationId)) {
            return;
        }

        if (this.suppressEvents) return;
        console.info("AnnotationAdapter: annotation deleted", annotation);
        this.scheduleSave();
    }

    scheduleSave() {
        if (!this.currentImageId || !this.currentCollection) {
            console.warn("AnnotationAdapter: edit was not saved because no annotation collection is loaded");
            return;
        }

        this.changeVersion += 1;
        this.saveRequested = true;
        this.cancelSaveTimer();
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.saveCurrentImage();
        }, this.saveDelayMs);
    }

    async flushSave() {
        this.cancelSaveTimer();

        // Wait for any request already in flight. Without this, switching images
        // can reset the adapter state before the previous image's PUT completes.
        if (this.activeSavePromise) {
            await this.activeSavePromise;
        }

        while (this.hasUnsavedChanges()) {
            await this.saveCurrentImage();
            if (this.activeSavePromise) {
                await this.activeSavePromise;
            }
        }
    }

    hasUnsavedChanges() {
        return this.saveRequested || this.changeVersion !== this.savedVersion;
    }

    async saveCurrentImage() {
        if (!this.currentImageId || !this.currentCollection) {
            return;
        }

        if (this.activeSavePromise) {
            this.saveRequested = true;
            return this.activeSavePromise;
        }

        const imageId = this.currentImageId;
        const generation = this.loadGeneration;
        const versionBeingSaved = this.changeVersion;
        const document = this.toBackendCollection();

        this.saveInProgress = true;
        this.saveRequested = false;

        const request = (async () => {
            try {
                const response = await fetch(
                    `/api/images/${encodeURIComponent(imageId)}/annotations`,
                    {
                        method: "PUT",
                        headers: {
                            "Accept": "application/json",
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify(document)
                    }
                );

                if (!response.ok) {
                    throw new Error(await this.responseError(response));
                }

                const savedCollection = await response.json();

                // The PUT belongs to the image captured above. Even if the user has
                // switched images, the server-side save is complete. Only mutate
                // the visible adapter state when this is still the active image.
                if (generation === this.loadGeneration && imageId === this.currentImageId) {
                    this.savedVersion = Math.max(this.savedVersion, versionBeingSaved);

                    if (this.changeVersion === versionBeingSaved && !this.saveRequested) {
                        // Rebuild from the saved backend document so annotations created
                        // in this session receive the same canonical UUID-backed model,
                        // geometry bounds and edit behavior as annotations loaded later.
                        // Programmatic delete events are filtered by
                        // replaceAnnotoriousAnnotations().
                        this.applyBackendCollection(savedCollection);
                        this.savedVersion = this.changeVersion;
                    } else {
                        // A newer browser edit occurred while this PUT was in flight.
                        // Keep that visible geometry intact and only reconcile IDs and
                        // timestamps before scheduling the next save.
                        this.currentCollection = savedCollection;
                        this.reconcileSavedMetadata(savedCollection);
                        this.saveRequested = true;
                    }
                }

                console.info(
                    `AnnotationAdapter: saved ${savedCollection.annotations?.length || 0} annotation${savedCollection.annotations?.length === 1 ? "" : "s"}`,
                    savedCollection
                );
            } catch (error) {
                if (generation === this.loadGeneration && imageId === this.currentImageId) {
                    this.saveRequested = true;
                }
                console.error(`AnnotationAdapter: unable to save annotations for image ${imageId}`, error);
            } finally {
                this.saveInProgress = false;
                this.activeSavePromise = null;

                if (
                    generation === this.loadGeneration &&
                    imageId === this.currentImageId &&
                    this.hasUnsavedChanges()
                ) {
                    this.cancelSaveTimer();
                    this.saveTimer = window.setTimeout(() => {
                        this.saveTimer = null;
                        void this.saveCurrentImage();
                    }, this.saveDelayMs);
                }
            }
        })();

        this.activeSavePromise = request;
        return request;
    }

    applyBackendCollection(collection) {
        this.currentCollection = collection;
        this.indexBackendMetadata(collection);

        const displayed = [];
        this.nonDisplayedAnnotations = [];

        for (const annotation of collection.annotations || []) {
            if (annotation.visible === false) {
                this.nonDisplayedAnnotations.push(annotation);
                continue;
            }

            const converted = this.toAnnotorious(annotation);
            if (converted) {
                displayed.push(converted);
            } else {
                // Preserve data that this client cannot safely display/convert.
                this.nonDisplayedAnnotations.push(annotation);
            }
        }

        this.replaceAnnotoriousAnnotations(displayed);
    }

    indexBackendMetadata(collection) {
        this.metadataById.clear();
        this.backendIdByClientId.clear();
        for (const annotation of collection.annotations || []) {
            if (annotation?.id) {
                this.metadataById.set(annotation.id, annotation);
                this.backendIdByClientId.set(annotation.id, annotation.id);
            }
        }
    }

    reconcileSavedMetadata(savedCollection) {
        const displayedBackend = (savedCollection.annotations || []).filter(annotation =>
            annotation.visible !== false && this.isSupportedBackendAnnotation(annotation)
        );
        const displayedClient = this.annotator.getAnnotations();

        this.metadataById.clear();

        // The backend preserves collection order. Match each displayed browser
        // annotation to the corresponding saved record and remember its canonical ID.
        const count = Math.min(displayedClient.length, displayedBackend.length);
        for (let index = 0; index < count; index += 1) {
            const client = displayedClient[index];
            const backend = displayedBackend[index];
            if (!client?.id || !backend?.id) continue;

            this.backendIdByClientId.set(client.id, backend.id);
            this.metadataById.set(client.id, backend);
            this.metadataById.set(backend.id, backend);
        }

        for (const annotation of savedCollection.annotations || []) {
            if (annotation?.id && !this.metadataById.has(annotation.id)) {
                this.metadataById.set(annotation.id, annotation);
            }
        }
    }

    isSupportedBackendAnnotation(annotation) {
        const type = String(annotation?.type || "rectangle").toLowerCase();
        return type === "rectangle" || type === "square" ||
            type === "ellipse" || type === "circle";
    }

    replaceAnnotoriousAnnotations(annotations) {
        // Remember currently displayed IDs before clearing. Annotorious can emit
        // their delete events after this method returns.
        for (const annotation of this.annotator.getAnnotations()) {
            if (annotation?.id) {
                this.ignoredDeletedAnnotationIds.add(annotation.id);
            }
        }

        this.suppressEvents = true;
        try {
            this.annotator.clearAnnotations();
            if (annotations.length > 0) {
                if (typeof this.annotator.addAnnotations === "function") {
                    this.annotator.addAnnotations(annotations);
                } else {
                    annotations.forEach(annotation => this.annotator.addAnnotation(annotation));
                }
            }
        } finally {
            this.suppressEvents = false;
        }
    }

    toBackendCollection() {
        const annotations = [
            ...this.nonDisplayedAnnotations,
            ...this.annotator.getAnnotations().map(annotation => this.toBackend(annotation))
        ];

        return {
            version: this.currentCollection?.version || 1,
            imageId: this.currentImageId,
            slidePath: this.currentCollection?.slidePath || null,
            userId: this.currentCollection?.userId || null,
            modifiedAt: this.currentCollection?.modifiedAt || null,
            annotations
        };
    }

    toBackend(annotation) {
        const geometry = annotation?.target?.selector?.geometry;
        const x = Number(geometry?.x);
        const y = Number(geometry?.y);
        const width = Number(geometry?.w);
        const height = Number(geometry?.h);

        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
            throw new Error("Annotorious returned invalid annotation geometry.");
        }

        const existing = this.metadataById.get(annotation.id);
        const selectorType = String(annotation?.target?.selector?.type || "RECTANGLE").toUpperCase();
        const type = selectorType === "ELLIPSE" ? "ellipse" : "rectangle";

        return {
            // Annotorious-generated IDs are not guaranteed to be UUIDs. Sending
            // null lets the backend assign a canonical UUID.
            id: this.backendIdByClientId.get(annotation.id) ||
                (this.isUuid(annotation.id) ? annotation.id : null),
            type,
            name: existing?.name || "Annotation",
            visible: existing?.visible !== false,
            locked: existing?.locked === true,
            color: existing?.color || "#ffd54a",
            lineWidth: this.positiveNumber(existing?.lineWidth, 2),
            x: Math.max(0, x),
            y: Math.max(0, y),
            width,
            height,
            rotation: Number.isFinite(Number(existing?.rotation)) ? Number(existing.rotation) : 0,
            createdAt: existing?.createdAt || null,
            modifiedAt: existing?.modifiedAt || null
        };
    }

    toAnnotorious(annotation) {
        const x = Number(annotation.x);
        const y = Number(annotation.y);
        const width = Number(annotation.width);
        const height = Number(annotation.height);

        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
            console.warn("AnnotationAdapter: skipped invalid annotation geometry", annotation);
            return null;
        }

        const type = String(annotation.type || "rectangle").toLowerCase();
        const selectorType = type === "ellipse" || type === "circle"
            ? "ELLIPSE"
            : "RECTANGLE";

        return {
            id: annotation.id,
            bodies: [],
            target: {
                selector: {
                    type: selectorType,
                    geometry: {
                        bounds: {
                            minX: x,
                            minY: y,
                            maxX: x + width,
                            maxY: y + height
                        },
                        x,
                        y,
                        w: width,
                        h: height
                    }
                }
            }
        };
    }

    cancelSaveTimer() {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
    }

    isUuid(value) {
        return typeof value === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    }

    positiveNumber(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : fallback;
    }

    async responseError(response) {
        const text = await response.text();
        if (!text) return `${response.status} ${response.statusText}`;

        try {
            const body = JSON.parse(text);
            return body.detail || body.message || body.title || text;
        } catch {
            return text;
        }
    }
}
