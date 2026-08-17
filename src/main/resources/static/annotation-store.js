/**
 * Application state and persistence boundary for annotations.
 *
 * UI adapters translate geometry, but this store alone owns the active image,
 * collection, selection, dirty flag, save lifecycle, and their notifications.
 */
class AnnotationStore {

    static collectionCache = new Map();
    static WORKSTATION_STORAGE_KEY = "wsi.workstation.id";
    static USER_HEADER = "X-WSI-User";
    static USER_COOKIE = "WSI-WORKSTATION-ID";
    static workstationUserIdCache = null;

    /**
     * Stable per-browser workstation id for annotation ownership.
     * Restored from the previous store: Annotorious construction calls this
     * during {@code new AnnotationAdapter(...)}.
     */
    static resolveWorkstationUserId() {
        if (this.workstationUserIdCache) return this.workstationUserIdCache;

        const storage = this.localStorageOrNull();
        if (storage) {
            try {
                const existing = storage.getItem(this.WORKSTATION_STORAGE_KEY);
                const normalized = this.sanitizeUserToken(existing);
                if (normalized) {
                    this.persistWorkstationIdentity(normalized, storage);
                    this.workstationUserIdCache = normalized;
                    return this.workstationUserIdCache;
                }
            } catch (error) {
                console.warn("AnnotationStore: unable to read workstation id", error);
            }
        }

        const newId = this.createWorkstationUserId();
        this.persistWorkstationIdentity(newId, storage);
        this.workstationUserIdCache = newId;
        return this.workstationUserIdCache;
    }

    static persistWorkstationIdentity(workstationId, storage) {
        if (storage) {
            try {
                storage.setItem(this.WORKSTATION_STORAGE_KEY, workstationId);
            } catch (error) {
                console.warn("AnnotationStore: unable to persist workstation id to localStorage", error);
            }
        }
        this.persistWorkstationCookie(workstationId);
    }

    static persistWorkstationCookie(workstationId) {
        try {
            if (typeof document === "undefined") return;
            const maxAge = 365 * 24 * 60 * 60;
            document.cookie =
                `${this.USER_COOKIE}=${encodeURIComponent(workstationId)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
        } catch (error) {
            console.warn("AnnotationStore: unable to persist workstation cookie", error);
        }
    }

    static createWorkstationUserId() {
        const hostname = this.sanitizeUserToken(
            (typeof window !== "undefined" && window.location && window.location.hostname)
                || "workstation"
        ) || "workstation";
        const uuid = this.sanitizeUserToken(this.createMachineId()) || this.fallbackRandomToken();
        const combined = `ws${hostname}${uuid}`;
        return combined.length <= 128 ? combined : combined.slice(0, 128);
    }

    static createMachineId() {
        const cryptoApi = (typeof crypto !== "undefined" && crypto)
            || (typeof window !== "undefined" && window.crypto)
            || null;
        if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
            return cryptoApi.randomUUID();
        }
        return this.fallbackRandomToken();
    }

    static fallbackRandomToken() {
        return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    }

    /** Keep only characters the Java AnnotationUserResolver is guaranteed to accept. */
    static sanitizeUserToken(value) {
        if (value == null) return "";
        return String(value).trim().replace(/[^A-Za-z0-9]/g, "").slice(0, 128);
    }

    static localStorageOrNull() {
        try {
            const storage = typeof window !== "undefined" ? window.localStorage : null;
            if (!storage) return null;
            return storage;
        } catch (error) {
            console.warn("AnnotationStore: localStorage unavailable", error);
            return null;
        }
    }

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

    async emit(eventName, detail) {
        for (const listener of this.listeners.get(eventName) || []) await listener(detail);
    }

    setSaveState(saveState) {
        if (this.saveState === saveState) return;
        this.saveState = saveState;
        void this.emit("saveStateChanged", { saveState, dirty: this.dirty }).catch(error =>
            console.error("AnnotationStore: save-state listener failed", error)
        );
    }

    setSelectedAnnotationId(annotationId) {
        const nextId = annotationId || null;
        if (this.selectedAnnotationId === nextId) return;
        this.selectedAnnotationId = nextId;
        void this.emit("selectionChanged", { selectedAnnotationId: nextId }).catch(error =>
            console.error("AnnotationStore: selection listener failed", error)
        );
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
        await this.emit("collectionChanged", { collection: null, reason: "imageChanged" });
        if (!nextImageId) return;

        this.setSaveState("loading");
        try {
            const collection = await AnnotationStore.prefetchImage(nextImageId);
            if (generation !== this.loadGeneration || collection.imageId !== this.currentImageId) return;
            this.currentCollection = collection;
            this.setSaveState("idle");
            await this.emit("collectionChanged", { collection, reason: "loaded" });
        } catch (error) {
            if (generation !== this.loadGeneration) return;
            this.setSaveState("error");
            console.error("AnnotationStore: unable to load annotations", error);
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
        void this.emit("collectionChanged", { collection, reason: "edited" }).catch(error =>
            console.error("AnnotationStore: edit listener failed", error)
        );
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
                const response = await WsiCsrf.csrfFetch(`/api/images/${encodeURIComponent(imageId)}/annotations`, {
                    method: "PUT",
                    headers: { "Accept": "application/json", "Content-Type": "application/json" },
                    body: JSON.stringify(document)
                });
                if (!response.ok) throw new Error(await this.responseError(response));
                const savedCollection = await response.json();
                AnnotationStore.collectionCache.set(imageId, Promise.resolve(savedCollection));

                if (generation === this.loadGeneration && imageId === this.currentImageId) {
                    this.savedVersion = Math.max(this.savedVersion, versionBeingSaved);
                    if (this.changeVersion === versionBeingSaved && !this.saveRequested) {
                        this.currentCollection = savedCollection;
                        this.savedVersion = this.changeVersion;
                        this.dirty = false;
                        await this.emit("collectionChanged", { collection: savedCollection, reason: "saved" });
                    } else {
                        this.currentCollection = this.reconcileSavedCollection
                            ? this.reconcileSavedCollection(this.currentCollection, savedCollection)
                            : this.currentCollection;
                        this.saveRequested = true;
                        this.dirty = true;
                        await this.emit("collectionChanged", {
                            collection: this.currentCollection,
                            serverCollection: savedCollection,
                            reason: "reconciled"
                        });
                    }
                }
                console.info(`AnnotationStore: saved ${savedCollection.annotations?.length || 0} annotations`);
            } catch (error) {
                if (generation === this.loadGeneration && imageId === this.currentImageId) {
                    this.saveRequested = true;
                    this.dirty = true;
                    this.setSaveState("error");
                }
                console.error("AnnotationStore: unable to save annotations", error);
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
