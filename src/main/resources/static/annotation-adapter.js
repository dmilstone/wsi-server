/**
 * Bridges Annotorious and the WSI server annotation document API.
 *
 * The backend stores one complete AnnotationCollection per image/user. Browser
 * edits are therefore debounced and persisted with PUT rather than individual
 * create/update/delete requests.
 *
 * Workstation isolation: this adapter reads `wsi.workstation.id` from
 * localStorage and injects `X-WSI-User` on every annotation GET/PUT it drives
 * through AnnotationStore (cookie mirror remains AnnotationStore's job).
 */
class AnnotationAdapter {

    static WORKSTATION_STORAGE_KEY = "wsi.workstation.id";
    static USER_HEADER = "X-WSI-User";

    /** Active focal-plane index for tile fetches (0-based). */
    static currentZ = 0;

    /** Active Bio-Formats series/sub-image index for tile fetches. */
    static currentSeries = 0;

    constructor(annotator, timingCallbacks = {}) {
        this.annotator = annotator;
        this.timingCallbacks = timingCallbacks;
        this.metadataById = new Map();
        this.backendIdByClientId = new Map();
        this.nonDisplayedAnnotations = [];
        this.suppressEvents = false;
        this.replacementQueue = Promise.resolve();

        // Create/persist workstation id from localStorage before any canvas GET/PUT.
        this.workstationUserId = AnnotationAdapter.resolveWorkstationUserId();

        // AnnotationStore owns lifecycle; this adapter supplies the fetch that
        // always attaches X-WSI-User from localStorage for GET/PUT.
        this.store = new AnnotationStore({
            fetchImpl: (url, options) => AnnotationAdapter.workstationFetch(url, options),
            reconcileSavedCollection: (_local, saved) => {
                this.reconcileSavedMetadata(saved);
                return this.toBackendCollection();
            }
        });
        this.store.subscribe("collectionChanged", async event => {
            if (event.reason === "imageChanged") {
                this.metadataById.clear();
                this.backendIdByClientId.clear();
                this.nonDisplayedAnnotations = [];
                await this.replaceAnnotoriousAnnotations([]);
            } else if (event.reason === "loaded") {
                this.timingCallbacks.annotationsLoaded?.(event.collection.imageId);
                await this.applyBackendCollection(event.collection);
                this.timingCallbacks.annotationsRendered?.(event.collection.imageId);
                console.info(`AnnotationAdapter: loaded ${event.collection.annotations?.length || 0} annotations`);
            } else if (event.reason === "saved") {
                // A save changes canonical IDs/timestamps, not client geometry.
                // Replacing here tears down a just-created Annotorious shape and
                // can leave its overlay stale until the next pointer event.
                this.reconcileSavedMetadata(event.collection);
                console.info(`AnnotationAdapter: saved ${event.collection.annotations?.length || 0} annotations`);
            }
        });
    }

    /**
     * Read `wsi.workstation.id` from localStorage (sanitized). Empty when absent.
     */
    static readWorkstationIdFromLocalStorage() {
        try {
            const storage = (typeof window !== "undefined" && window.localStorage)
                || (typeof localStorage !== "undefined" ? localStorage : null);
            if (!storage) return "";
            return AnnotationStore.sanitizeUserToken(
                storage.getItem(AnnotationAdapter.WORKSTATION_STORAGE_KEY)
            );
        } catch (error) {
            console.warn("AnnotationAdapter: unable to read wsi.workstation.id from localStorage", error);
            return "";
        }
    }

    /**
     * Prefer the localStorage workstation id; otherwise create/persist via store.
     */
    static resolveWorkstationUserId() {
        const fromStorage = AnnotationAdapter.readWorkstationIdFromLocalStorage();
        if (fromStorage) {
            AnnotationStore.persistWorkstationIdentity(
                fromStorage,
                AnnotationStore.localStorageOrNull()
            );
            AnnotationStore.workstationUserIdCache = fromStorage;
            return fromStorage;
        }
        return AnnotationStore.resolveWorkstationUserId();
    }

    /**
     * Headers every annotation GET/PUT must carry for per-workstation isolation.
     */
    static workstationRequestHeaders(extra = {}) {
        const workstationId = AnnotationAdapter.resolveWorkstationUserId();
        const merged = { ...(extra || {}) };
        merged[AnnotationAdapter.USER_HEADER] = workstationId;
        return merged;
    }

    static setCurrentZ(z) {
        const next = Number.parseInt(z, 10);
        AnnotationAdapter.currentZ = Number.isFinite(next) && next >= 0 ? next : 0;
        return AnnotationAdapter.currentZ;
    }

    static setCurrentSeries(series) {
        const next = Number.parseInt(series, 10);
        AnnotationAdapter.currentSeries = Number.isFinite(next) && next >= 0 ? next : 0;
        return AnnotationAdapter.currentSeries;
    }

    /**
     * Ensures /tile/ requests carry the active focal plane ({@code z}) and
     * Bio-Formats series ({@code series}). Non-tile URLs are returned unchanged.
     */
    static appendTileDepthQuery(url) {
        const text = String(url ?? "");
        if (!text.includes("/tile/")) return text;
        try {
            const parsed = new URL(text, "http://local.invalid");
            parsed.searchParams.set("z", String(AnnotationAdapter.currentZ || 0));
            parsed.searchParams.set("series", String(AnnotationAdapter.currentSeries || 0));
            return `${parsed.pathname}${parsed.search}${parsed.hash}`;
        } catch {
            const z = AnnotationAdapter.currentZ || 0;
            const series = AnnotationAdapter.currentSeries || 0;
            let next = text;
            if (/[?&]z=\d+/.test(next)) next = next.replace(/([?&])z=\d+/, `$1z=${z}`);
            else next = `${next}${next.includes("?") ? "&" : "?"}z=${z}`;
            if (/[?&]series=\d+/.test(next)) next = next.replace(/([?&])series=\d+/, `$1series=${series}`);
            else next = `${next}&series=${series}`;
            return next;
        }
    }

    /**
     * GET/PUT fetch wrapper: always injects X-WSI-User from localStorage.
     * Tile URLs also receive the active {@code z} and {@code series} query parameters.
     * Mutating methods keep going through WsiCsrf.csrfFetch.
     */
    static workstationFetch(url, options = {}) {
        const opts = options || {};
        const headers = AnnotationAdapter.workstationRequestHeaders(opts.headers);
        const method = String(opts.method || "GET").toUpperCase();
        const nextUrl = AnnotationAdapter.appendTileDepthQuery(url);
        const next = { ...opts, headers };
        if (method === "GET" || method === "HEAD") {
            return fetch(nextUrl, next);
        }
        return WsiCsrf.csrfFetch(nextUrl, next);
    }

    async loadCurrentImage(imageId) {
        // Re-read localStorage before the store's annotation GET.
        this.workstationUserId = AnnotationAdapter.resolveWorkstationUserId();
        await this.store.load(imageId);
    }

    annotationCreated(annotation) {
        if (this.suppressEvents) return;
        this.collectionEdited();
    }

    annotationUpdated(annotation, previous) {
        if (this.suppressEvents) return;
        this.collectionEdited();
    }

    annotationDeleted(annotation) {
        if (this.suppressEvents) return;
        this.collectionEdited();
    }

    collectionEdited() {
        // Re-read localStorage before the store's debounced annotation PUT.
        this.workstationUserId = AnnotationAdapter.resolveWorkstationUserId();
        this.store.updateCollection(this.toBackendCollection());
    }

    getAnnotationName(clientId) {
        const value = this.metadataById.get(clientId)?.name;
        return typeof value === "string" ? value : "";
    }

    setAnnotationName(clientId, value) {
        const existing = this.metadataById.get(clientId);
        if (!existing) return false;
        const name = value === null || value === undefined ? null : String(value).trim() || null;
        const previous = typeof existing.name === "string" && existing.name.length > 0
            ? existing.name
            : null;
        if (name === previous) return false;

        const updated = { ...existing, name };
        this.metadataById.set(clientId, updated);
        const backendId = this.backendIdByClientId.get(clientId);
        if (backendId) this.metadataById.set(backendId, updated);
        this.collectionEdited();
        return true;
    }

    async applyBackendCollection(collection) {
        this.indexBackendMetadata(collection);

        const displayed = [];
        this.nonDisplayedAnnotations = [];

        const annotations = Array.isArray(collection.annotations) ? collection.annotations : [];
        for (let index = 0; index < annotations.length; index += 1) {
            const annotation = annotations[index];
            if (!annotation || typeof annotation !== "object") {
                console.warn(`AnnotationAdapter: preserved malformed annotation at index ${index}; it was not displayed`);
                this.nonDisplayedAnnotations.push(annotation);
                continue;
            }
            if (annotation.visible === false || !this.isSupportedBackendAnnotation(annotation)) {
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

        await this.replaceAnnotoriousAnnotations(displayed);
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
        const safeAnnotations = (Array.isArray(annotations) ? annotations : [])
            .filter(annotation => annotation && typeof annotation === "object")
            .map(annotation => ({
                ...annotation,
                bodies: Array.isArray(annotation.bodies)
                    ? annotation.bodies.filter(body => body && typeof body === "object")
                    : []
            }));

        // Annotorious replacement can be asynchronous. Serializing replacements
        // makes an older image incapable of winning a race with a newer one.
        const replacement = this.replacementQueue.then(async () => {
            this.suppressEvents = true;
            try {
                if (typeof this.annotator.setAnnotations === "function") {
                    await this.annotator.setAnnotations(safeAnnotations, true);
                } else {
                    await this.annotator.clearAnnotations();
                    if (safeAnnotations.length > 0) {
                        if (typeof this.annotator.addAnnotations === "function") {
                            await this.annotator.addAnnotations(safeAnnotations);
                        } else {
                            for (const annotation of safeAnnotations) {
                                await this.annotator.addAnnotation(annotation);
                            }
                        }
                    }
                }
            } finally {
                this.suppressEvents = false;
            }
        });
        this.replacementQueue = replacement.catch(() => {});
        return replacement;
    }

    toBackendCollection() {
        const annotations = [
            ...this.nonDisplayedAnnotations,
            ...this.annotator.getAnnotations().map(annotation => this.toBackend(annotation))
        ];

        return {
            version: this.store.currentCollection?.version || 1,
            imageId: this.store.currentImageId,
            slidePath: this.store.currentCollection?.slidePath || null,
            userId: this.store.currentCollection?.userId || null,
            modifiedAt: this.store.currentCollection?.modifiedAt || null,
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

        const backend = {
            ...existing,
            // Annotorious-generated IDs are not guaranteed to be UUIDs. Sending
            // null lets the backend assign a canonical UUID.
            id: this.backendIdByClientId.get(annotation.id) ||
                (this.isUuid(annotation.id) ? annotation.id : null),
            type,
            name: typeof existing?.name === "string" && existing.name.length > 0 ? existing.name : null,
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
            modifiedAt: existing?.modifiedAt || null,
            bodies: Array.isArray(annotation?.bodies)
                ? annotation.bodies.filter(body => body && typeof body === "object")
                : (Array.isArray(existing?.bodies) ? existing.bodies : [])
        };
        // Keep metadata for a freshly drawn client ID so it can be named before
        // the first debounced server response assigns a canonical UUID.
        if (annotation?.id) this.metadataById.set(annotation.id, backend);
        return backend;
    }

    toAnnotorious(annotation) {
        const x = Number(annotation.x);
        const y = Number(annotation.y);
        const width = Number(annotation.width);
        const height = Number(annotation.height);

        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
            console.warn("AnnotationAdapter: preserved an annotation whose invalid geometry was not displayed");
            return null;
        }

        const type = String(annotation.type || "rectangle").toLowerCase();
        const selectorType = type === "ellipse" || type === "circle"
            ? "ELLIPSE"
            : "RECTANGLE";

        return {
            id: annotation.id,
            bodies: Array.isArray(annotation.bodies)
                ? annotation.bodies.filter(body => body && typeof body === "object")
                : [],
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

    isUuid(value) {
        return typeof value === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    }

    positiveNumber(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : fallback;
    }
}
