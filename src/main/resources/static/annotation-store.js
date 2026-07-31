/**
 * Application state and persistence boundary for annotations.
 *
 * UI adapters translate geometry, but this store alone owns the active image,
 * collection, selection, dirty flag, save lifecycle, and their notifications.
 */
class AnnotationStore {

    static collectionCache = new Map();

    static prefetchImage(imageId) {
        const normalizedImageId = imageId || null;
        if (!normalizedImageId) return Promise.resolve(null);

        if (!this.collectionCache.has(normalizedImageId)) {
            const request = fetch(`/api/images/${encodeURIComponent(normalizedImageId)}/annotations`, {
                headers: { "Accept": "application/json" }
            }).then(async response => {
                if (!response.ok) throw new Error(await AnnotationStore.responseError(response));
                return response.json();
            }).catch(error => {
                this.collectionCache.delete(normalizedImageId);
                throw error;
            });
            this.collectionCache.set(normalizedImageId, request);
        }

        return this.collectionCache.get(normalizedImageId);
    }

    constructor({ saveDelayMs = 400, reconcileSavedCollection = null } = {}) {
        this.currentImageId = null;
        this.currentCollection = null;
        this.dirty = false;
        this.selectedAnnotationId = null;
        this.saveState = "idle";

        this.saveDelayMs = saveDelayMs;
        this.reconcileSavedCollection = reconcileSavedCollection;
        this.listeners = new Map();
        this.loadGeneration = 0;
        this.changeVersion = 0;
        this.savedVersion = 0;
        this.saveRequested = false;
        this.saveTimer = null;
        this.activeSavePromise = null;
    }

    subscribe(eventName, listener) {
        if (!["collectionChanged", "selectionChanged", "saveStateChanged"].includes(eventName)) {
            throw new Error(`Unsupported AnnotationStore event: ${eventName}`);
        }
        if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set());
        this.listeners.get(eventName).add(listener);
        return () => this.listeners.get(eventName)?.delete(listener);
    }

    emit(eventName, detail) {
        for (const listener of this.listeners.get(eventName) || []) listener(detail);
    }

    setSaveState(saveState) {
        if (this.saveState === saveState) return;
        this.saveState = saveState;
        this.emit("saveStateChanged", { saveState, dirty: this.dirty });
    }

    setSelectedAnnotationId(annotationId) {
        const nextId = annotationId || null;
        if (this.selectedAnnotationId === nextId) return;
        this.selectedAnnotationId = nextId;
        this.emit("selectionChanged", { selectedAnnotationId: nextId });
    }

    async load(imageId) {
        const nextImageId = imageId || null;
        if (this.currentImageId && this.currentImageId !== nextImageId && this.hasUnsavedChanges()) {
            await this.flushSave();
        }

        const generation = ++this.loadGeneration;
        this.cancelSaveTimer();
        this.currentImageId = nextImageId;
        this.currentCollection = null;
        this.changeVersion = 0;
        this.savedVersion = 0;
        this.saveRequested = false;
        this.dirty = false;
        this.setSelectedAnnotationId(null);
        this.setSaveState("idle");
        this.emit("collectionChanged", { collection: null, reason: "imageChanged" });
        if (!nextImageId) return;

        this.setSaveState("loading");
        try {
            const collection = await AnnotationStore.prefetchImage(nextImageId);
            if (generation !== this.loadGeneration || collection.imageId !== this.currentImageId) return;
            this.currentCollection = collection;
            this.setSaveState("idle");
            this.emit("collectionChanged", { collection, reason: "loaded" });
        } catch (error) {
            if (generation !== this.loadGeneration) return;
            this.setSaveState("error");
            console.error(`AnnotationStore: unable to load annotations for image ${nextImageId}`, error);
        }
    }

    updateCollection(collection) {
        if (!this.currentImageId || !this.currentCollection) {
            console.warn("AnnotationStore: edit was not saved because no annotation collection is loaded");
            return;
        }
        this.currentCollection = collection;
        this.changeVersion += 1;
        this.saveRequested = true;
        this.dirty = true;
        this.setSaveState("dirty");
        this.emit("collectionChanged", { collection, reason: "edited" });
        this.cancelSaveTimer();
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.save();
        }, this.saveDelayMs);
    }

    hasUnsavedChanges() {
        return this.saveRequested || this.changeVersion !== this.savedVersion;
    }

    async flushSave() {
        this.cancelSaveTimer();
        if (this.activeSavePromise) await this.activeSavePromise;
        while (this.hasUnsavedChanges()) {
            await this.save();
            if (this.activeSavePromise) await this.activeSavePromise;
        }
    }

    async save() {
        if (!this.currentImageId || !this.currentCollection) return;
        if (this.activeSavePromise) {
            this.saveRequested = true;
            return this.activeSavePromise;
        }

        const imageId = this.currentImageId;
        const generation = this.loadGeneration;
        const versionBeingSaved = this.changeVersion;
        const document = this.currentCollection;
        this.saveRequested = false;
        this.setSaveState("saving");

        const request = (async () => {
            try {
                const response = await fetch(`/api/images/${encodeURIComponent(imageId)}/annotations`, WsiCsrf.withCsrf({
                    method: "PUT",
                    headers: { "Accept": "application/json", "Content-Type": "application/json" },
                    body: JSON.stringify(document)
                }));
                if (!response.ok) throw new Error(await this.responseError(response));
                const savedCollection = await response.json();
                AnnotationStore.collectionCache.set(imageId, Promise.resolve(savedCollection));

                if (generation === this.loadGeneration && imageId === this.currentImageId) {
                    this.savedVersion = Math.max(this.savedVersion, versionBeingSaved);
                    if (this.changeVersion === versionBeingSaved && !this.saveRequested) {
                        this.currentCollection = savedCollection;
                        this.savedVersion = this.changeVersion;
                        this.dirty = false;
                        this.emit("collectionChanged", { collection: savedCollection, reason: "saved" });
                    } else {
                        this.currentCollection = this.reconcileSavedCollection
                            ? this.reconcileSavedCollection(this.currentCollection, savedCollection)
                            : this.currentCollection;
                        this.saveRequested = true;
                        this.dirty = true;
                        this.emit("collectionChanged", {
                            collection: this.currentCollection,
                            serverCollection: savedCollection,
                            reason: "reconciled"
                        });
                    }
                }
                console.info(`AnnotationStore: saved ${savedCollection.annotations?.length || 0} annotations`, savedCollection);
            } catch (error) {
                if (generation === this.loadGeneration && imageId === this.currentImageId) {
                    this.saveRequested = true;
                    this.dirty = true;
                    this.setSaveState("error");
                }
                console.error(`AnnotationStore: unable to save annotations for image ${imageId}`, error);
            } finally {
                this.activeSavePromise = null;
                if (generation === this.loadGeneration && imageId === this.currentImageId && this.hasUnsavedChanges()) {
                    if (this.saveState !== "error") this.setSaveState("dirty");
                    this.cancelSaveTimer();
                    this.saveTimer = window.setTimeout(() => {
                        this.saveTimer = null;
                        void this.save();
                    }, this.saveDelayMs);
                } else if (generation === this.loadGeneration && imageId === this.currentImageId) {
                    this.setSaveState("idle");
                }
            }
        })();
        this.activeSavePromise = request;
        return request;
    }

    cancelSaveTimer() {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
    }

    static async responseError(response) {
        const text = await response.text();
        if (!text) return `${response.status} ${response.statusText}`;
        try {
            const body = JSON.parse(text);
            return body.detail || body.message || body.title || text;
        } catch {
            return text;
        }
    }

    async responseError(response) {
        return AnnotationStore.responseError(response);
    }
}
