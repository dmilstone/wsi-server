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

    /**
     * Case / accession token matcher (case-insensitive).
     * Same shape as {@code /\b([A-Z]{2}\d{2}-\d+)\b/i}, but the trailing boundary is a
     * lookahead so filenames like {@code BA26-041340_A2.vsi} still extract
     * {@code BA26-041340} (JS {@code \b} treats underscore as a word character).
     */
    static CASE_ID_PATTERN = /\b([A-Z]{2}\d{2}-\d+)(?![A-Za-z0-9])/i;

    /** Active focal-plane index for tile fetches (0-based). */
    static currentZ = 0;

    /** Active Bio-Formats series/sub-image index for tile fetches. */
    static currentSeries = 0;

    /**
     * Currently opened slide id tracked by the adapter.
     * Cleared immediately on case-filter changes to prevent patient mismatch.
     */
    static currentImageId = null;

    /**
     * Specimen / diagnostic scan profiles only. Label, Macro, Overview, Thumbnail,
     * and Preview series (isDiagnosticSpecimen === false) are excluded.
     */
    static diagnosticSpecimenProfiles(profiles) {
        if (!Array.isArray(profiles)) return [];
        return profiles.filter(profile => profile && profile.isDiagnosticSpecimen === true);
    }

    /** Show the series dropdown only when more than one diagnostic specimen scan exists. */
    static shouldShowSeriesSelector(profiles) {
        return AnnotationAdapter.diagnosticSpecimenProfiles(profiles).length > 1;
    }

    /**
     * Extract the first case / accession id from a path or filename.
     * Returns the matched substring with its original casing, or null.
     */
    static extractCaseId(text) {
        const raw = String(text ?? "");
        if (!raw) return null;
        const match = raw.match(AnnotationAdapter.CASE_ID_PATTERN);
        return match ? match[1] : null;
    }

    /**
     * Scan ingested slide records (id / name / relativePath / folder) and return
     * alphabetically sorted unique case ids for the left-column filter dropdown.
     */
    static uniqueCaseIdsFromImages(images) {
        if (!Array.isArray(images) || images.length === 0) return [];
        const byKey = new Map();
        for (const image of images) {
            if (!image || typeof image !== "object") continue;
            const candidates = [
                image.relativePath,
                image.name,
                image.id,
                image.folder,
                // Base64 ids often decode to a relative path — try atob when safe.
                (() => {
                    try {
                        if (typeof image.id === "string" && image.id.length > 0) {
                            return atob(image.id);
                        }
                    } catch (_) { /* not base64 */ }
                    return null;
                })()
            ];
            for (const candidate of candidates) {
                const extracted = AnnotationAdapter.extractCaseId(candidate);
                if (!extracted) continue;
                const key = extracted.toUpperCase();
                if (!byKey.has(key)) byKey.set(key, extracted.toUpperCase());
            }
        }
        return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    }

    /**
     * Sentinel select values for the left-column case filter.
     * Empty / placeholder keeps the list fully hidden (zero-exposure default).
     */
    static CASE_FILTER_PLACEHOLDER_VALUE = "";
    static CASE_FILTER_ALL_SLIDES_VALUE = "__all_slides__";
    static ZERO_EXPOSURE_STATUS = "Select a patient case to begin.";

    /**
     * True when the case filter is on the blank privacy placeholder
     * ("-- Select a Patient Case --" / empty value).
     */
    static isCaseFilterPlaceholderSelected(selectElement) {
        if (!selectElement) return true;
        const value = String(selectElement.value ?? "").trim();
        if (!value || value === AnnotationAdapter.CASE_FILTER_PLACEHOLDER_VALUE) {
            return true;
        }
        if (/^--\s*select a patient case\s*--$/i.test(value)) {
            return true;
        }
        const label = String(selectElement.selectedOptions?.[0]?.textContent ?? "").trim();
        return /^--\s*select a patient case\s*--$/i.test(label);
    }

    /**
     * Block localStorage / session auto-open of the last slide while the
     * case filter remains on the zero-exposure placeholder.
     */
    static shouldBypassSessionImageAutoload(selectElement) {
        return AnnotationAdapter.isCaseFilterPlaceholderSelected(selectElement);
    }

    /**
     * Blank the main workspace chrome for fresh load / case-filter changes:
     * clear image headers and status text, force {@code viewer.close()} when a
     * viewer is provided (pure-black viewport), and hide Z / channels /
     * measurement panels until a slide is clicked again.
     */
    static applyZeroExposureWorkspace(doc, options = {}) {
        const root = doc || (typeof document !== "undefined" ? document : null);
        if (!root || typeof root.getElementById !== "function") return;

        AnnotationAdapter.resetActiveImageTracking();

        const viewer = options.viewer;
        if (viewer) {
            try {
                // Mandatory: drop all tiles and return the canvas to black.
                viewer.close();
            } catch (_error) {
                try {
                    if (viewer.world && typeof viewer.world.removeAll === "function") {
                        viewer.world.removeAll();
                    }
                } catch (_fallbackError) {
                    // Ignore teardown races during hard refresh / rapid filter changes.
                }
            }
        }

        const setText = (id, text) => {
            const el = root.getElementById(id);
            if (el) el.textContent = text;
        };
        setText("selected-name", "No image selected");
        setText("info-name", "—");
        setText("info-size", "—");
        setText("info-channels", "—");
        setText("info-levels", "—");
        setText("info-tile", "—");
        setText("info-pixel-size", "—");
        setText("status", options.statusText || AnnotationAdapter.ZERO_EXPOSURE_STATUS);
        setText("status-zoom", "—");
        setText("status-x", "—");
        setText("status-y", "—");
        setText("discovery-status", "");

        const imageInfo = root.getElementById("image-info");
        if (imageInfo) imageInfo.hidden = true;

        for (const id of [
            "z-depth-controls",
            "measure-session-panel",
            "series-select-control"
        ]) {
            const el = root.getElementById(id);
            if (el) el.hidden = true;
        }

        const stack = root.querySelector?.(".right-stack-controls");
        if (stack) stack.hidden = true;

        const channels = root.getElementById("channels");
        if (channels) {
            channels.replaceChildren();
            channels.hidden = true;
        }
        const channelsHeader = root.querySelector?.("#channels-panel > .panel-header");
        if (channelsHeader) channelsHeader.hidden = true;

        const measureList = root.getElementById("measure-session-list");
        if (measureList) measureList.replaceChildren();
        AnnotationAdapter.measurementSessionList = [];
    }

    /**
     * Reset adapter-side image / Z / series tracking to the blank baseline.
     */
    static resetActiveImageTracking() {
        try {
            AnnotationAdapter.stopZMovie({ silent: true });
        } catch (_error) {
            // Movie helpers may not be wired yet during first paint.
        }
        AnnotationAdapter.currentImageId = null;
        AnnotationAdapter.setCurrentZ(0);
        AnnotationAdapter.setCurrentSeries(0);
        AnnotationAdapter.imageMetadata = null;
        AnnotationAdapter.isMeasurementModeActive = false;
        AnnotationAdapter.isDragging = false;
    }

    /**
     * Patient-mismatch guard for {@code #case-filter-select}: close the OSD
     * viewport and purge visible metadata the instant the dropdown changes.
     * Call this first inside the select's {@code change} listener.
     */
    static forceCaseFilterViewportWipe(doc, options = {}) {
        AnnotationAdapter.applyZeroExposureWorkspace(doc, {
            viewer: options.viewer,
            statusText: options.statusText
                || "Case filter changed — select a slide to open."
        });
        return null;
    }

    /**
     * Wire {@code #case-filter-select} so every selection change immediately
     * blackens the viewport, then applies the slide-list filter.
     */
    static bindCaseFilterChangeGuard(selectElement, options = {}) {
        if (!selectElement || typeof selectElement.addEventListener !== "function") {
            return null;
        }
        const handler = () => {
            AnnotationAdapter.forceCaseFilterViewportWipe(
                options.document || (typeof document !== "undefined" ? document : null),
                {viewer: options.viewer || null}
            );
            if (typeof options.onBeforeFilter === "function") {
                options.onBeforeFilter();
            }
            AnnotationAdapter.applyCaseFilterToSlideButtons(
                selectElement.value,
                options.imageListRoot || null
            );
            if (typeof options.onAfterFilter === "function") {
                options.onAfterFilter(selectElement.value);
            }
        };
        selectElement.addEventListener("change", handler);
        return handler;
    }

    /**
     * Restore Channels chrome after the user opens a concrete slide.
     */
    static revealWorkspaceImageChrome(doc) {
        const root = doc || (typeof document !== "undefined" ? document : null);
        if (!root || typeof root.getElementById !== "function") return;
        const channels = root.getElementById("channels");
        if (channels) channels.hidden = false;
        const channelsHeader = root.querySelector?.("#channels-panel > .panel-header");
        if (channelsHeader) channelsHeader.hidden = false;
    }

    /**
     * Rebuild {@code <select id="case-filter-select">} options:
     * placeholder first, then "All Slides", then unique case ids.
     * Preserves a prior concrete selection when still present; otherwise
     * resets to the privacy placeholder.
     */
    static populateCaseFilterSelect(selectElement, images) {
        if (!selectElement) return [];
        const previous = String(selectElement.value ?? "");
        const cases = AnnotationAdapter.uniqueCaseIdsFromImages(images);
        selectElement.replaceChildren();

        const placeholder = document.createElement("option");
        placeholder.value = AnnotationAdapter.CASE_FILTER_PLACEHOLDER_VALUE;
        placeholder.textContent = "-- Select a Patient Case --";
        selectElement.append(placeholder);

        const allOption = document.createElement("option");
        allOption.value = AnnotationAdapter.CASE_FILTER_ALL_SLIDES_VALUE;
        allOption.textContent = "All Slides";
        selectElement.append(allOption);

        for (const caseId of cases) {
            const option = document.createElement("option");
            option.value = caseId;
            option.textContent = caseId;
            selectElement.append(option);
        }

        if (previous === AnnotationAdapter.CASE_FILTER_ALL_SLIDES_VALUE) {
            selectElement.value = AnnotationAdapter.CASE_FILTER_ALL_SLIDES_VALUE;
        } else if (previous && cases.some(id => id.toUpperCase() === previous.toUpperCase())) {
            selectElement.value = cases.find(id => id.toUpperCase() === previous.toUpperCase())
                || AnnotationAdapter.CASE_FILTER_PLACEHOLDER_VALUE;
        } else {
            selectElement.value = AnnotationAdapter.CASE_FILTER_PLACEHOLDER_VALUE;
        }
        return cases;
    }

    /**
     * Show/hide left-column slide buttons by case substring.
     * Placeholder / empty → hide all (zero-exposure).
     * {@link CASE_FILTER_ALL_SLIDES_VALUE} / "All Slides" → show all.
     * Otherwise match the chosen case substring (case-insensitive).
     */
    static applyCaseFilterToSlideButtons(selectedCase, root = null) {
        const needle = String(selectedCase ?? "").trim();
        const hideAll = !needle
            || needle === AnnotationAdapter.CASE_FILTER_PLACEHOLDER_VALUE
            || /^--\s*select a patient case\s*--$/i.test(needle);
        const showAll = !hideAll && (
            needle === AnnotationAdapter.CASE_FILTER_ALL_SLIDES_VALUE
            || /^all slides$/i.test(needle)
        );
        const scope = root
            || (typeof document !== "undefined" ? document.getElementById("image-list") : null)
            || (typeof document !== "undefined" ? document : null);
        if (!scope || typeof scope.querySelectorAll !== "function") return;

        const buttons = scope.querySelectorAll(".image-button");
        for (const button of buttons) {
            const haystack = [
                button.dataset?.imagePath,
                button.dataset?.imageName,
                button.dataset?.imageId,
                button.textContent
            ].filter(Boolean).join("\n");
            let visible = false;
            if (hideAll) {
                visible = false;
            } else if (showAll) {
                visible = true;
            } else {
                visible = haystack.toUpperCase().includes(needle.toUpperCase());
            }
            button.style.display = visible ? "" : "none";
        }

        // Collapse empty folder groups so the list stays tidy under a filter.
        for (const folder of scope.querySelectorAll(".folder-group")) {
            const anyVisible = Array.from(folder.querySelectorAll(".image-button"))
                .some(button => button.style.display !== "none");
            folder.style.display = (showAll || anyVisible) && !hideAll ? "" : "none";
        }
    }

    /** Active Z-movie playback timer handle (null when stopped). */
    static zMovieTimer = null;
    /** Ping-pong direction: +1 ascending, -1 descending. */
    static zDirection = 1;
    /** Playback boundary mode: "LOOP" (🔁) or "PING_PONG" (↔️). */
    static animationMode = "LOOP";
    static zMovieIntervalMs = 500;
    static zMoviePlaying = false;
    static zMovieHooks = {
        getMaxZ: () => 0,
        applyZ: (_z) => {},
        onStateChange: (_playing) => {},
        onModeChange: (_mode) => {}
    };

    /**
     * Z-movie engine. Callers should apply Z without wiping OpenSeadragon's
     * tile cache (maxImageCacheCount) so replayed planes stay RAM-resident.
     */
    static configureZMovie(hooks = {}) {
        const previous = AnnotationAdapter.zMovieHooks || {};
        AnnotationAdapter.zMovieHooks = {
            getMaxZ: typeof hooks.getMaxZ === "function" ? hooks.getMaxZ : () => 0,
            applyZ: typeof hooks.applyZ === "function" ? hooks.applyZ : (_z) => {},
            onStateChange: typeof hooks.onStateChange === "function" ? hooks.onStateChange : (_playing) => {},
            onModeChange: typeof hooks.onModeChange === "function"
                ? hooks.onModeChange
                : (typeof previous.onModeChange === "function" ? previous.onModeChange : (_mode) => {})
        };
    }

    static stopZMovie({ silent = false } = {}) {
        if (AnnotationAdapter.zMovieTimer != null) {
            clearInterval(AnnotationAdapter.zMovieTimer);
            AnnotationAdapter.zMovieTimer = null;
        }
        const wasPlaying = AnnotationAdapter.zMoviePlaying;
        AnnotationAdapter.zMoviePlaying = false;
        AnnotationAdapter.zDirection = 1;
        if (wasPlaying && !silent) AnnotationAdapter.zMovieHooks.onStateChange?.(false);
        return false;
    }

    static normalizeAnimationMode(mode) {
        const raw = String(mode || "").trim().toUpperCase().replace(/-/g, "_");
        if (raw === "PING_PONG" || raw === "PINGPONG") return "PING_PONG";
        return "LOOP";
    }

    /** Select LOOP (🔁 head-to-tail) or PING_PONG (↔️). */
    static setAnimationMode(mode) {
        const active = AnnotationAdapter.normalizeAnimationMode(mode);
        AnnotationAdapter.animationMode = active;
        // Always reset travel direction when entering a mode so LOOP never inherits -1.
        AnnotationAdapter.zDirection = 1;
        AnnotationAdapter.zMovieHooks.onModeChange?.(active);
        return active;
    }

    /**
     * One-click mode + play: select the mode, then start playback.
     * Clicking the already-running mode again stops playback.
     */
    static activateModeAndPlay(mode, { intervalMs = 500 } = {}) {
        const next = AnnotationAdapter.normalizeAnimationMode(mode);
        if (AnnotationAdapter.zMoviePlaying
            && AnnotationAdapter.normalizeAnimationMode(AnnotationAdapter.animationMode) === next) {
            return AnnotationAdapter.stopZMovie();
        }
        AnnotationAdapter.setAnimationMode(next);
        return AnnotationAdapter.startZMovie({ intervalMs });
    }

    /**
     * Wire two mode buttons (no separate play button):
     *  - 🔁 selects LOOP and starts (or stops if already looping)
     *  - ↔️ selects PING_PONG and starts (or stops if already ping-ponging)
     */
    static bindZMovieModeButtons({ loopButton, pingpongButton, intervalMs = 500, onModeChange } = {}) {
        const resolvedInterval = Number.parseInt(intervalMs, 10);
        const playIntervalMs = Number.isFinite(resolvedInterval) && resolvedInterval > 0
            ? resolvedInterval
            : 500;

        const syncVisual = (active) => {
            const mode = AnnotationAdapter.normalizeAnimationMode(active);
            if (typeof onModeChange === "function") onModeChange(mode);
            const isLoop = mode === "LOOP";
            const playing = Boolean(AnnotationAdapter.zMoviePlaying);
            if (loopButton) {
                loopButton.textContent = "🔁";
                loopButton.dataset.mode = "LOOP";
                loopButton.setAttribute("aria-pressed", String(isLoop));
                loopButton.classList.toggle("is-active", isLoop);
                loopButton.classList.toggle("z-movie-mode-active", isLoop);
                loopButton.classList.toggle("is-playing", playing && isLoop);
                loopButton.title = playing && isLoop
                    ? "Head-to-tail loop — click to stop"
                    : "Head-to-tail loop — click to play";
                loopButton.setAttribute(
                    "aria-label",
                    playing && isLoop ? "Stop head-to-tail loop" : "Play head-to-tail loop"
                );
            }
            if (pingpongButton) {
                pingpongButton.textContent = "↔️";
                pingpongButton.dataset.mode = "PING_PONG";
                pingpongButton.setAttribute("aria-pressed", String(!isLoop));
                pingpongButton.classList.toggle("is-active", !isLoop);
                pingpongButton.classList.toggle("z-movie-mode-active", !isLoop);
                pingpongButton.classList.toggle("is-playing", playing && !isLoop);
                pingpongButton.title = playing && !isLoop
                    ? "Ping-pong — click to stop"
                    : "Ping-pong — click to play";
                pingpongButton.setAttribute(
                    "aria-label",
                    playing && !isLoop ? "Stop ping-pong" : "Play ping-pong"
                );
            }
        };

        const previousOnStateChange = AnnotationAdapter.zMovieHooks.onStateChange;
        AnnotationAdapter.zMovieHooks = {
            ...AnnotationAdapter.zMovieHooks,
            onModeChange: syncVisual,
            onStateChange: (playing) => {
                if (typeof previousOnStateChange === "function") previousOnStateChange(playing);
                syncVisual(AnnotationAdapter.animationMode);
            }
        };

        loopButton?.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            AnnotationAdapter.activateModeAndPlay("LOOP", { intervalMs: playIntervalMs });
        });
        pingpongButton?.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            AnnotationAdapter.activateModeAndPlay("PING_PONG", { intervalMs: playIntervalMs });
        });

        syncVisual(AnnotationAdapter.animationMode || "LOOP");
        return syncVisual;
    }

    static startZMovie({ intervalMs = 500, mode } = {}) {
        const maxZ = Math.max(0, Number(AnnotationAdapter.zMovieHooks.getMaxZ?.()) || 0);
        if (maxZ <= 0) return AnnotationAdapter.stopZMovie();

        AnnotationAdapter.stopZMovie({ silent: true });
        const parsedInterval = Number.parseInt(intervalMs, 10);
        AnnotationAdapter.zMovieIntervalMs = Number.isFinite(parsedInterval) && parsedInterval > 0
            ? parsedInterval
            : 500;
        if (mode != null) AnnotationAdapter.setAnimationMode(mode);
        AnnotationAdapter.zDirection = 1;
        AnnotationAdapter.zMoviePlaying = true;
        AnnotationAdapter.zMovieTimer = setInterval(
            () => AnnotationAdapter.tickZMovie(),
            AnnotationAdapter.zMovieIntervalMs
        );
        AnnotationAdapter.zMovieHooks.onStateChange?.(true);
        return true;
    }

    static toggleZMovie(options = {}) {
        if (AnnotationAdapter.zMoviePlaying) return AnnotationAdapter.stopZMovie();
        return AnnotationAdapter.startZMovie(options);
    }

    static tickZMovie() {
        const maxZ = Math.max(0, Number(AnnotationAdapter.zMovieHooks.getMaxZ?.()) || 0);
        if (maxZ <= 0) {
            AnnotationAdapter.stopZMovie();
            return;
        }
        const current = Math.max(0, Math.min(maxZ, Number(AnnotationAdapter.currentZ) || 0));
        const mode = AnnotationAdapter.normalizeAnimationMode(AnnotationAdapter.animationMode);
        let next;

        if (mode === "PING_PONG") {
            // ↔️ glide forward, then reverse at the last plane, then reverse again at 0.
            let direction = AnnotationAdapter.zDirection >= 0 ? 1 : -1;
            next = current + direction;
            if (next > maxZ) {
                direction = -1;
                next = maxZ - 1;
                if (next < 0) next = 0;
            } else if (next < 0) {
                direction = 1;
                next = Math.min(1, maxZ);
            }
            AnnotationAdapter.zDirection = direction;
        } else {
            // 🔁 head-to-tail: after the last plane, jump straight back to 0.
            AnnotationAdapter.zDirection = 1;
            next = current >= maxZ ? 0 : current + 1;
        }

        AnnotationAdapter.setCurrentZ(next);
        AnnotationAdapter.zMovieHooks.applyZ?.(AnnotationAdapter.currentZ);
    }

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

    /** Latest image metadata used by measurement (µm/px calibration). */
    static imageMetadata = null;
    /** Global ruler / measure mode flag. */
    static isMeasurementModeActive = false;
    /**
     * True only between a real OSD press and release inside the viewer element.
     * Toolbar activation must never set this.
     */
    static isDragging = false;
    /** @deprecated alias — prefer {@link AnnotationAdapter.isDragging}. */
    static get isDraggingMeasurement() {
        return AnnotationAdapter.isDragging;
    }
    /** Overlay-space drag start; null until canvas press. */
    static measureStartX = null;
    static measureStartY = null;
    /** Image-pixel drag start; null until canvas press. */
    static measureStartImageX = null;
    static measureStartImageY = null;
    /** Active OpenSeadragon viewer (for mouse-nav enable/disable). */
    static viewer = null;
    /** Dedicated SVG overlay above OSD tiles (not the drawer canvas). */
    static measureOverlayEl = null;
    /** Authoritative OSD MouseTracker for measurement gestures. */
    static measureMouseTracker = null;
    /** Optional callback(microns, snapshot) when a drag completes. */
    static onMeasurementComplete = null;
    /** In-session saved measurements for the current browser session. */
    static measurementSessionList = [];
    /** Last completed length — kept so the popup can reopen after storage clears. */
    static lastMeasuredMicrons = null;

    static MEASURE_STROKE = "#FFEA00";
    static MEASURE_HALO = "#000000";
    static MEASURE_STROKE_WIDTH = 3;
    static MEASURE_HALO_WIDTH = 7; // 3px stroke + ~2px black outline each side

    /** Safe defaults after localStorage wipe / cold start. */
    static ensureMeasurementDefaults() {
        if (AnnotationAdapter.imageMetadata == null
            || typeof AnnotationAdapter.imageMetadata !== "object") {
            AnnotationAdapter.imageMetadata = null;
        }
        if (typeof AnnotationAdapter.isMeasurementModeActive !== "boolean") {
            AnnotationAdapter.isMeasurementModeActive = false;
        }
        if (typeof AnnotationAdapter.isDragging !== "boolean") {
            AnnotationAdapter.isDragging = false;
        }
        if (!Array.isArray(AnnotationAdapter.measurementSessionList)) {
            AnnotationAdapter.measurementSessionList = [];
        }
        if (AnnotationAdapter.measureStartX != null && !Number.isFinite(Number(AnnotationAdapter.measureStartX))) {
            AnnotationAdapter.measureStartX = null;
        }
        if (AnnotationAdapter.measureStartY != null && !Number.isFinite(Number(AnnotationAdapter.measureStartY))) {
            AnnotationAdapter.measureStartY = null;
        }
        if (AnnotationAdapter.measureStartImageX != null
            && !Number.isFinite(Number(AnnotationAdapter.measureStartImageX))) {
            AnnotationAdapter.measureStartImageX = null;
        }
        if (AnnotationAdapter.measureStartImageY != null
            && !Number.isFinite(Number(AnnotationAdapter.measureStartImageY))) {
            AnnotationAdapter.measureStartImageY = null;
        }
        if (AnnotationAdapter.lastMeasuredMicrons != null
            && !Number.isFinite(Number(AnnotationAdapter.lastMeasuredMicrons))) {
            AnnotationAdapter.lastMeasuredMicrons = null;
        }
        return AnnotationAdapter;
    }

    static setImageMetadata(metadata) {
        AnnotationAdapter.ensureMeasurementDefaults();
        AnnotationAdapter.imageMetadata = metadata || null;
        return AnnotationAdapter.imageMetadata;
    }

    /**
     * Calibrated microns-per-pixel from metadata.
     * Prefers explicit X/Y; falls back to micronsPerPixel alias.
     */
    static micronsPerPixel(metadata = AnnotationAdapter.imageMetadata) {
        AnnotationAdapter.ensureMeasurementDefaults();
        const source = metadata || AnnotationAdapter.imageMetadata;
        const x = Number(source?.micronsPerPixelX ?? source?.micronsPerPixel);
        const y = Number(source?.micronsPerPixelY ?? source?.micronsPerPixel);
        if (Number.isFinite(x) && x > 0 && Number.isFinite(y) && y > 0) {
            return { x, y };
        }
        if (Number.isFinite(x) && x > 0) return { x, y: x };
        return null;
    }

    static euclideanDistancePixels(x0, y0, x1, y1) {
        const dx = Number(x1) - Number(x0);
        const dy = Number(y1) - Number(y0);
        if (![dx, dy].every(Number.isFinite)) return 0;
        return Math.hypot(dx, dy);
    }

    /**
     * Physical length in microns between two image-pixel points.
     * Uses anisotropic X/Y calibration when both are present.
     */
    static measureLengthMicrons(x0, y0, x1, y1, metadata = AnnotationAdapter.imageMetadata) {
        const mpp = AnnotationAdapter.micronsPerPixel(metadata);
        if (!mpp) return null;
        const dx = (Number(x1) - Number(x0)) * mpp.x;
        const dy = (Number(y1) - Number(y0)) * mpp.y;
        if (![dx, dy].every(Number.isFinite)) return null;
        return Math.hypot(dx, dy);
    }

    static formatMicrons(microns) {
        const value = Number(microns);
        if (!Number.isFinite(value) || value < 0) return "—";
        if (value >= 1000) {
            const mm = value / 1000;
            return `${Number(mm.toPrecision(4))} mm`;
        }
        if (value >= 100) return `${Math.round(value)} µm`;
        if (value >= 10) return `${value.toFixed(1)} µm`;
        return `${value.toFixed(2)} µm`;
    }

    /** Clear drag anchors without touching mode or mouse-nav. */
    static resetMeasurementDragState() {
        AnnotationAdapter.isDragging = false;
        AnnotationAdapter.measureStartX = null;
        AnnotationAdapter.measureStartY = null;
        AnnotationAdapter.measureStartImageX = null;
        AnnotationAdapter.measureStartImageY = null;
    }

    static _openSeadragon() {
        if (typeof window !== "undefined" && window.OpenSeadragon) return window.OpenSeadragon;
        if (typeof globalThis !== "undefined" && globalThis.OpenSeadragon) return globalThis.OpenSeadragon;
        return null;
    }

    /** Remember the active OpenSeadragon viewer for mouse-nav + tracker binding. */
    static setViewer(viewer) {
        AnnotationAdapter.ensureMeasurementDefaults();
        AnnotationAdapter.viewer = viewer || null;
        return AnnotationAdapter.viewer;
    }

    /**
     * Toggle measurement mode and disable/enable OSD mouse navigation.
     * Enabling the toolbar tool must NOT seed coordinates or draw a line.
     */
    static setMeasurementModeActive(active) {
        AnnotationAdapter.ensureMeasurementDefaults();
        const enabled = Boolean(active);
        AnnotationAdapter.isMeasurementModeActive = enabled;
        AnnotationAdapter.resetMeasurementDragState();
        const v = AnnotationAdapter.viewer;
        if (v && typeof v.setMouseNavEnabled === "function") {
            v.setMouseNavEnabled(!enabled);
        }
        if (enabled) {
            AnnotationAdapter.ensureMeasureOverlay();
            AnnotationAdapter.clearMeasureVector({ remove: false, keepDragState: true });
            AnnotationAdapter.resetMeasurementDragState();
        } else {
            AnnotationAdapter.clearMeasureVector({ remove: false });
        }
        return AnnotationAdapter.isMeasurementModeActive;
    }

    /**
     * Bind an authoritative OpenSeadragon.MouseTracker to the viewer element.
     * Replaces any prior measure tracker. Handlers use OSD's press/drag/release cycle.
     */
    static bindMeasureMouseTracker(viewer, options = {}) {
        AnnotationAdapter.ensureMeasurementDefaults();
        AnnotationAdapter.setViewer(viewer);
        AnnotationAdapter.onMeasurementComplete =
            typeof options.onMeasurementComplete === "function"
                ? options.onMeasurementComplete
                : null;

        if (AnnotationAdapter.measureMouseTracker) {
            try { AnnotationAdapter.measureMouseTracker.destroy(); } catch (_) { /* ignore */ }
            AnnotationAdapter.measureMouseTracker = null;
        }

        const OSD = AnnotationAdapter._openSeadragon();
        if (!viewer || typeof OSD?.MouseTracker !== "function") return null;

        const element = viewer.element || viewer.container;
        if (!element) return null;
        AnnotationAdapter.ensureMeasureOverlay(viewer.container || element);

        AnnotationAdapter.measureMouseTracker = new OSD.MouseTracker({
            element,
            pressHandler: (event) => AnnotationAdapter._measurePressHandler(event),
            dragHandler: (event) => AnnotationAdapter._measureDragHandler(event),
            releaseHandler: (event) => AnnotationAdapter._measureReleaseHandler(event),
            // Some OSD builds only fire dragEnd — treat it like release.
            dragEndHandler: (event) => AnnotationAdapter._measureReleaseHandler(event)
        });
        return AnnotationAdapter.measureMouseTracker;
    }

    /** Convert MouseTracker position → image pixels via OSD viewport APIs. */
    static trackerPositionToImage(position) {
        const viewer = AnnotationAdapter.viewer;
        if (!viewer?.viewport || !position) return null;
        let viewportPoint = null;
        try {
            if (typeof viewer.viewport.viewerElementToViewportCoordinates === "function") {
                viewportPoint = viewer.viewport.viewerElementToViewportCoordinates(position);
            } else if (typeof viewer.viewport.pointFromPixel === "function") {
                viewportPoint = viewer.viewport.pointFromPixel(position, true);
            }
        } catch (_) {
            return null;
        }
        if (!viewportPoint) return null;

        let imagePoint = null;
        try {
            if (viewer.world?.getItemCount?.() > 0) {
                imagePoint = viewer.world.getItemAt(0).viewportToImageCoordinates(viewportPoint);
            } else if (typeof viewer.viewport.viewportToImageCoordinates === "function") {
                imagePoint = viewer.viewport.viewportToImageCoordinates(viewportPoint);
            }
        } catch (_) {
            return null;
        }
        if (!imagePoint) return null;
        if (!Number.isFinite(imagePoint.x) || !Number.isFinite(imagePoint.y)) return null;
        return { x: imagePoint.x, y: imagePoint.y };
    }

    /**
     * Overlay CSS pixels for the SVG layer. Tracker is bound to viewer.element,
     * so event.position maps 1:1 when the overlay is parented to that element /
     * container with matching origin.
     */
    static trackerPositionToOverlay(position) {
        if (!position) return null;
        const x = Number(position.x);
        const y = Number(position.y);
        if (![x, y].every(Number.isFinite)) return null;

        const svg = AnnotationAdapter.measureOverlayEl;
        const viewer = AnnotationAdapter.viewer;
        const trackerEl = viewer?.element || viewer?.container;
        if (svg?.parentElement && trackerEl && svg.parentElement !== trackerEl) {
            const parentRect = svg.parentElement.getBoundingClientRect();
            const trackerRect = trackerEl.getBoundingClientRect();
            return {
                x: x + trackerRect.left - parentRect.left,
                y: y + trackerRect.top - parentRect.top
            };
        }
        return { x, y };
    }

    static _measurePressHandler(event) {
        if (!AnnotationAdapter.isMeasurementModeActive) return;
        if (event) event.preventDefaultAction = true;
        if (event?.originalEvent?.preventDefault) event.originalEvent.preventDefault();

        AnnotationAdapter.ensureMeasureOverlay();
        const position = event?.position;
        const imagePoint = AnnotationAdapter.trackerPositionToImage(position);
        const overlayPoint = AnnotationAdapter.trackerPositionToOverlay(position);
        if (!imagePoint || !overlayPoint) return;

        AnnotationAdapter.isDragging = true;
        AnnotationAdapter.measureStartX = overlayPoint.x;
        AnnotationAdapter.measureStartY = overlayPoint.y;
        AnnotationAdapter.measureStartImageX = imagePoint.x;
        AnnotationAdapter.measureStartImageY = imagePoint.y;
        // Do not draw until dragHandler — avoids the startup false-anchor glitch.
    }

    static _measureDragHandler(event) {
        if (!AnnotationAdapter.isDragging) return;
        if (event) event.preventDefaultAction = true;
        if (event?.originalEvent?.preventDefault) event.originalEvent.preventDefault();

        const position = event?.position;
        const imagePoint = AnnotationAdapter.trackerPositionToImage(position);
        const overlayPoint = AnnotationAdapter.trackerPositionToOverlay(position);
        if (!imagePoint || !overlayPoint) return;
        if (AnnotationAdapter.measureStartX == null || AnnotationAdapter.measureStartY == null) return;

        const microns = AnnotationAdapter.measureLengthMicrons(
            AnnotationAdapter.measureStartImageX,
            AnnotationAdapter.measureStartImageY,
            imagePoint.x,
            imagePoint.y
        );
        const label = microns == null
            ? "Not calibrated"
            : AnnotationAdapter.formatMicrons(microns);
        AnnotationAdapter.updateMeasureVector(
            AnnotationAdapter.measureStartX,
            AnnotationAdapter.measureStartY,
            overlayPoint.x,
            overlayPoint.y,
            label
        );
    }

    static _measureReleaseHandler(event) {
        if (!AnnotationAdapter.isDragging) return;
        if (event) event.preventDefaultAction = true;

        const position = event?.position;
        const imagePoint = AnnotationAdapter.trackerPositionToImage(position);
        const overlayPoint = AnnotationAdapter.trackerPositionToOverlay(position);

        const startImageX = AnnotationAdapter.measureStartImageX;
        const startImageY = AnnotationAdapter.measureStartImageY;
        const startOverlayX = AnnotationAdapter.measureStartX;
        const startOverlayY = AnnotationAdapter.measureStartY;

        const endImageX = Number.isFinite(imagePoint?.x) ? imagePoint.x : startImageX;
        const endImageY = Number.isFinite(imagePoint?.y) ? imagePoint.y : startImageY;
        const endOverlayX = Number.isFinite(overlayPoint?.x) ? overlayPoint.x : startOverlayX;
        const endOverlayY = Number.isFinite(overlayPoint?.y) ? overlayPoint.y : startOverlayY;

        const microns = AnnotationAdapter.measureLengthMicrons(
            startImageX, startImageY, endImageX, endImageY
        );
        const lengthLabel = microns == null
            ? "Not calibrated"
            : AnnotationAdapter.formatMicrons(microns);

        if ([startOverlayX, startOverlayY, endOverlayX, endOverlayY].every(Number.isFinite)) {
            AnnotationAdapter.updateMeasureVector(
                startOverlayX, startOverlayY, endOverlayX, endOverlayY, lengthLabel
            );
        }

        AnnotationAdapter.resetMeasurementDragState();
        AnnotationAdapter.lastMeasuredMicrons =
            Number.isFinite(microns) && microns > 0 ? microns : null;

        const snapshot = {
            startOverlayX,
            startOverlayY,
            startImageX,
            startImageY,
            endOverlayX,
            endOverlayY,
            endImageX,
            endImageY,
            microns: AnnotationAdapter.lastMeasuredMicrons,
            lengthLabel
        };

        // Rapid-fire path: auto-save into the session list — no popup.
        let entry = null;
        if (AnnotationAdapter.lastMeasuredMicrons != null) {
            entry = AnnotationAdapter.saveMeasurementToSession({
                lengthMicrons: AnnotationAdapter.lastMeasuredMicrons,
                label: AnnotationAdapter.nextSequentialMeasurementLabel(
                    AnnotationAdapter.lastMeasuredMicrons
                ),
                imageId: typeof AnnotationAdapter.getActiveImageId === "function"
                    ? AnnotationAdapter.getActiveImageId()
                    : null
            });
        }

        if (typeof AnnotationAdapter.onMeasurementComplete === "function") {
            try {
                AnnotationAdapter.onMeasurementComplete(
                    AnnotationAdapter.lastMeasuredMicrons,
                    { ...snapshot, entry }
                );
            } catch (error) {
                console.warn("Measurement complete callback failed", error);
            }
        }
    }

    /**
     * Default sequential label using active series/Z scan parameters.
     * Example: "Measurement 1 (25.0 µm)" or "Measurement 2 · S1/Z3 (12.4 µm)".
     */
    static nextSequentialMeasurementLabel(microns) {
        AnnotationAdapter.ensureMeasurementDefaults();
        const n = AnnotationAdapter.measurementSessionList.length + 1;
        const length = AnnotationAdapter.formatMicrons(microns);
        const series = Number(AnnotationAdapter.currentSeries) || 0;
        const z = Number(AnnotationAdapter.currentZ) || 0;
        if (series > 0 || z > 0) {
            return `Measurement ${n} · S${series}/Z${z} (${length})`;
        }
        return `Measurement ${n} (${length})`;
    }

    /** Optional hook so the page can supply the current image id for session rows. */
    static getActiveImageId = null;

    /**
     * Canvas mousedown helper (tests / legacy). Prefer the OSD MouseTracker path.
     * Does not draw — the vector appears only after drag while isDragging.
     */
    static beginMeasurementDrag({ overlayX, overlayY, imageX, imageY } = {}) {
        if (!AnnotationAdapter.isMeasurementModeActive) return false;
        const ox = Number(overlayX);
        const oy = Number(overlayY);
        const ix = Number(imageX);
        const iy = Number(imageY);
        if (![ox, oy, ix, iy].every(Number.isFinite)) return false;
        AnnotationAdapter.isDragging = true;
        AnnotationAdapter.measureStartX = ox;
        AnnotationAdapter.measureStartY = oy;
        AnnotationAdapter.measureStartImageX = ix;
        AnnotationAdapter.measureStartImageY = iy;
        return true;
    }

    /**
     * Canvas mousemove helper (tests / legacy).
     */
    static updateMeasurementDrag({ overlayX, overlayY, imageX, imageY, labelText = "" } = {}) {
        if (!AnnotationAdapter.isDragging) return false;
        if (AnnotationAdapter.measureStartX == null || AnnotationAdapter.measureStartY == null) {
            return false;
        }
        const ox = Number(overlayX);
        const oy = Number(overlayY);
        if (![ox, oy].every(Number.isFinite)) return false;
        AnnotationAdapter.updateMeasureVector(
            AnnotationAdapter.measureStartX,
            AnnotationAdapter.measureStartY,
            ox,
            oy,
            labelText
        );
        return true;
    }

    /**
     * Canvas mouseup helper (tests / legacy).
     */
    static endMeasurementDrag({ overlayX, overlayY, imageX, imageY, labelText = "" } = {}) {
        if (!AnnotationAdapter.isDragging) return null;
        const start = {
            overlayX: AnnotationAdapter.measureStartX,
            overlayY: AnnotationAdapter.measureStartY,
            imageX: AnnotationAdapter.measureStartImageX,
            imageY: AnnotationAdapter.measureStartImageY
        };
        const ox = Number(overlayX);
        const oy = Number(overlayY);
        const ix = Number(imageX);
        const iy = Number(imageY);
        const endOverlayX = Number.isFinite(ox) ? ox : start.overlayX;
        const endOverlayY = Number.isFinite(oy) ? oy : start.overlayY;
        const endImageX = Number.isFinite(ix) ? ix : start.imageX;
        const endImageY = Number.isFinite(iy) ? iy : start.imageY;

        if ([start.overlayX, start.overlayY, endOverlayX, endOverlayY].every(Number.isFinite)) {
            AnnotationAdapter.updateMeasureVector(
                start.overlayX,
                start.overlayY,
                endOverlayX,
                endOverlayY,
                labelText
            );
        }

        AnnotationAdapter.resetMeasurementDragState();
        return {
            startOverlayX: start.overlayX,
            startOverlayY: start.overlayY,
            startImageX: start.imageX,
            startImageY: start.imageY,
            endOverlayX,
            endOverlayY,
            endImageX,
            endImageY
        };
    }

    static _svgEl(name) {
        return document.createElementNS("http://www.w3.org/2000/svg", name);
    }

    /**
     * Create (or re-parent) a transparent SVG tracking layer above the OSD
     * display container so the vector is never painted under tile canvases.
     */
    static ensureMeasureOverlay(host = null) {
        if (typeof document === "undefined") return null;
        const viewer = AnnotationAdapter.viewer;
        const container = host
            || viewer?.element
            || viewer?.container
            || document.getElementById("viewer");
        if (!container) return null;

        let svg = AnnotationAdapter.measureOverlayEl;
        if (svg && svg.isConnected && svg.parentElement === container) {
            return svg;
        }

        if (!svg) {
            svg = AnnotationAdapter._svgEl("svg");
            svg.setAttribute("class", "wsi-measure-overlay");
            svg.setAttribute("aria-hidden", "true");
            svg.style.cssText = [
                "position:absolute",
                "inset:0",
                "width:100%",
                "height:100%",
                "z-index:100000",
                "pointer-events:none",
                "overflow:visible",
                "display:none"
            ].join(";");

            const halo = AnnotationAdapter._svgEl("line");
            halo.setAttribute("data-measure", "halo");
            halo.setAttribute("stroke", AnnotationAdapter.MEASURE_HALO);
            halo.setAttribute("stroke-width", String(AnnotationAdapter.MEASURE_HALO_WIDTH));
            halo.setAttribute("stroke-linecap", "round");
            halo.setAttribute("fill", "none");

            const stroke = AnnotationAdapter._svgEl("line");
            stroke.setAttribute("data-measure", "stroke");
            stroke.setAttribute("stroke", AnnotationAdapter.MEASURE_STROKE);
            stroke.setAttribute("stroke-width", String(AnnotationAdapter.MEASURE_STROKE_WIDTH));
            stroke.setAttribute("stroke-linecap", "round");
            stroke.setAttribute("fill", "none");

            const arrowHalo = AnnotationAdapter._svgEl("polygon");
            arrowHalo.setAttribute("data-measure", "arrow-halo");
            arrowHalo.setAttribute("fill", AnnotationAdapter.MEASURE_HALO);

            const arrow = AnnotationAdapter._svgEl("polygon");
            arrow.setAttribute("data-measure", "arrow");
            arrow.setAttribute("fill", AnnotationAdapter.MEASURE_STROKE);

            const label = AnnotationAdapter._svgEl("text");
            label.setAttribute("data-measure", "label");
            label.setAttribute("fill", AnnotationAdapter.MEASURE_STROKE);
            label.setAttribute("stroke", AnnotationAdapter.MEASURE_HALO);
            label.setAttribute("stroke-width", "2");
            label.setAttribute("paint-order", "stroke fill");
            label.setAttribute("text-anchor", "middle");
            label.setAttribute("dominant-baseline", "central");
            label.style.font = "700 12px/1.2 ui-sans-serif, system-ui, sans-serif";

            svg.append(halo, stroke, arrowHalo, arrow, label);
            AnnotationAdapter.measureOverlayEl = svg;
        }

        const style = window.getComputedStyle?.(container);
        if (style && style.position === "static") {
            container.style.position = "relative";
        }
        container.appendChild(svg);
        return svg;
    }

    static _arrowPoints(x0, y0, x1, y1, size) {
        const angle = Math.atan2(y1 - y0, x1 - x0);
        if (!Number.isFinite(angle)) return "";
        const a1 = angle + Math.PI - 0.42;
        const a2 = angle + Math.PI + 0.42;
        const bx = x1 + size * Math.cos(a1);
        const by = y1 + size * Math.sin(a1);
        const cx = x1 + size * Math.cos(a2);
        const cy = y1 + size * Math.sin(a2);
        return `${x1},${y1} ${bx},${by} ${cx},${cy}`;
    }

    /**
     * Draw/update the neon measurement vector on the dedicated overlay layer.
     * Coordinates are CSS pixels relative to the overlay host.
     */
    static updateMeasureVector(x0, y0, x1, y1, labelText = "") {
        const svg = AnnotationAdapter.ensureMeasureOverlay();
        if (!svg) return null;

        const width = Math.max(1, Math.round(svg.clientWidth || svg.parentElement?.clientWidth || 1));
        const height = Math.max(1, Math.round(svg.clientHeight || svg.parentElement?.clientHeight || 1));
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        svg.setAttribute("width", String(width));
        svg.setAttribute("height", String(height));
        svg.style.display = "block";

        const sx = Number(x0);
        const sy = Number(y0);
        const ex = Number(x1);
        const ey = Number(y1);
        if (![sx, sy, ex, ey].every(Number.isFinite)) return svg;

        const dx = ex - sx;
        const dy = ey - sy;
        const len = Math.hypot(dx, dy);
        // Pull line end back so the tip sits under the arrow head.
        const tipInset = len > 1 ? Math.min(14, len * 0.35) : 0;
        const lx = len > 0 ? ex - (dx / len) * tipInset : ex;
        const ly = len > 0 ? ey - (dy / len) * tipInset : ey;

        const halo = svg.querySelector('[data-measure="halo"]');
        const stroke = svg.querySelector('[data-measure="stroke"]');
        const arrowHalo = svg.querySelector('[data-measure="arrow-halo"]');
        const arrow = svg.querySelector('[data-measure="arrow"]');
        const label = svg.querySelector('[data-measure="label"]');

        for (const line of [halo, stroke]) {
            if (!line) continue;
            line.setAttribute("x1", String(sx));
            line.setAttribute("y1", String(sy));
            line.setAttribute("x2", String(lx));
            line.setAttribute("y2", String(ly));
        }

        const showArrow = len >= 4;
        if (arrowHalo && arrow) {
            if (showArrow) {
                arrowHalo.setAttribute("points", AnnotationAdapter._arrowPoints(sx, sy, ex, ey, 14));
                arrow.setAttribute("points", AnnotationAdapter._arrowPoints(sx, sy, ex, ey, 11));
                arrowHalo.style.display = "";
                arrow.style.display = "";
            } else {
                arrowHalo.removeAttribute("points");
                arrow.removeAttribute("points");
                arrowHalo.style.display = "none";
                arrow.style.display = "none";
            }
        }

        if (label) {
            label.textContent = labelText || "";
            label.setAttribute("x", String((sx + ex) / 2));
            label.setAttribute("y", String((sy + ey) / 2 - 14));
            label.style.display = labelText ? "" : "none";
        }
        return svg;
    }

    /** Wipe the tracking vector (and optionally detach the overlay node). */
    static clearMeasureVector({ remove = false, keepDragState = false } = {}) {
        if (!keepDragState) AnnotationAdapter.resetMeasurementDragState();
        const svg = AnnotationAdapter.measureOverlayEl;
        if (!svg) return;
        const halo = svg.querySelector('[data-measure="halo"]');
        const stroke = svg.querySelector('[data-measure="stroke"]');
        const arrowHalo = svg.querySelector('[data-measure="arrow-halo"]');
        const arrow = svg.querySelector('[data-measure="arrow"]');
        const label = svg.querySelector('[data-measure="label"]');
        for (const line of [halo, stroke]) {
            if (!line) continue;
            line.setAttribute("x1", "0");
            line.setAttribute("y1", "0");
            line.setAttribute("x2", "0");
            line.setAttribute("y2", "0");
        }
        if (arrowHalo) {
            arrowHalo.removeAttribute("points");
            arrowHalo.style.display = "none";
        }
        if (arrow) {
            arrow.removeAttribute("points");
            arrow.style.display = "none";
        }
        if (label) {
            label.textContent = "";
            label.style.display = "none";
        }
        svg.style.display = "none";
        if (remove) {
            svg.remove();
            AnnotationAdapter.measureOverlayEl = null;
        }
    }

    static saveMeasurementToSession({ lengthMicrons, label = "", imageId = null } = {}) {
        AnnotationAdapter.ensureMeasurementDefaults();
        const microns = Number(lengthMicrons);
        if (!Number.isFinite(microns) || microns < 0) return null;
        const entry = {
            id: `m-${Date.now()}-${AnnotationAdapter.measurementSessionList.length + 1}`,
            lengthMicrons: microns,
            lengthLabel: AnnotationAdapter.formatMicrons(microns),
            label: String(label || "").trim(),
            imageId: imageId || null,
            series: Number(AnnotationAdapter.currentSeries) || 0,
            z: Number(AnnotationAdapter.currentZ) || 0,
            savedAt: new Date().toISOString()
        };
        AnnotationAdapter.measurementSessionList.push(entry);
        if (typeof AnnotationAdapter.onSessionListChange === "function") {
            try {
                AnnotationAdapter.onSessionListChange(
                    AnnotationAdapter.measurementSessionList.slice(),
                    entry
                );
            } catch (error) {
                console.warn("Session list change callback failed", error);
            }
        }
        return entry;
    }

    /** Optional UI hook: (list, latestEntry) => void */
    static onSessionListChange = null;

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

// Cold-start / cleared-storage defaults for measurement state.
AnnotationAdapter.ensureMeasurementDefaults();
