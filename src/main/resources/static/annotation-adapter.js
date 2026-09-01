/**
 * Bridges the WSI server annotation document API to a native OpenSeadragon
 * SVG overlay (`viewer.svgOverlay()`). Geometry is stored in
 * {@code window.savedAnnotationsArray}.
 */

/** Session-scoped clinical OCR markers — each slide scanned at most once. */
const OcrSessionCache = {};

/** Last adaptive pre-scanner thresholds for the AI Labs reset control. */
let ocrAutoBaseline = { prob: 0.5, nms: 0.4 };

/** In-memory cell polygons drawn on the native OSD canvas overlay. */
let localizedCellObjects = [];

function renderSynchronizedCellObjects() {
    return AnnotationAdapter.renderSynchronizedCellObjects();
}

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
    static currentModality = "";
    static currentEngine = "";
    static FLUORESCENCE_PLUGIN_OPTIONS = [
        { value: "quantify-nuclei-pixel", label: "Run Pixel Intensity Plugin" },
        { value: "per-object-pixel-quantifier", label: "Quantify Individual Objects (Color Code)" }
    ];
    static IHC_PLUGIN_OPTION = {
        value: "ihc-pixel-quantifier",
        label: "Run IHC Color Deconvolution Plugin"
    };

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

    static largestSeriesIndex(profiles) {
        let best = null;
        for (const profile of Array.isArray(profiles) ? profiles : []) {
            const area = Number(profile?.width) * Number(profile?.height);
            const bestArea = best ? Number(best.width) * Number(best.height) : -1;
            if (!best || area > bestArea) best = profile;
        }
        return best ? Number(best.index) || 0 : 0;
    }

    /**
     * Default specimen series. RGB / H&E wins when the container has no
     * fluorescence series-2 stack; otherwise keep the IF convention (index 2).
     */
    static chooseDefaultSeries(profiles) {
        const specimens = AnnotationAdapter.diagnosticSpecimenProfiles(profiles);
        const pool = specimens.length > 0 ? specimens : (Array.isArray(profiles) ? profiles : []);
        if (pool.length === 0) return 0;
        if (pool.length === 1) return Number(pool[0].index) || 0;
        const rgbSpecimens = pool.filter(profile => profile && profile.rgb === true);
        const fluorescence = pool.find(profile =>
            Number(profile.index) === 2 && Number(profile.width) >= 512 && profile.rgb !== true);
        if (rgbSpecimens.length > 0 && !fluorescence) {
            return AnnotationAdapter.largestSeriesIndex(rgbSpecimens);
        }
        if (fluorescence) return 2;
        const seriesTwo = pool.find(profile =>
            Number(profile.index) === 2 && Number(profile.width) >= 512);
        if (seriesTwo) return Number(seriesTwo.index) || 2;
        return AnnotationAdapter.largestSeriesIndex(pool);
    }

    /** RGB H&E / IHC series must use composite tiles, not per-channel lighter stacks. */
    static isRgbSeriesView(metadata, series) {
        const modality = String(metadata?.modality || AnnotationAdapter.currentModality || "").toUpperCase();
        if (modality === "FLUORESCENCE") return false;
        if (metadata && metadata.rgb === true) return true;
        if (AnnotationAdapter.isBrightfieldSlide(metadata)) return true;
        const profiles = Array.isArray(metadata?.seriesProfiles) ? metadata.seriesProfiles : [];
        const index = Number.isFinite(Number(series)) ? Number(series) : Number(metadata?.series);
        const current = profiles.find(profile => Number(profile.index) === index);
        return Boolean(current && current.rgb === true);
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
        return Array.from(byKey.values()).sort((a, b) =>
            AnnotationAdapter.naturalCollator.compare(a, b)
        );
    }

    /**
     * Human / natural alphanumeric collator (so "2" < "10" < "19" < "20").
     */
    static naturalCollator = (typeof Intl !== "undefined" && typeof Intl.Collator === "function")
        ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
        : {
            compare(a, b) {
                return String(a ?? "").localeCompare(String(b ?? ""), undefined, {
                    numeric: true,
                    sensitivity: "base"
                });
            }
        };

    /** Stable natural sort of catalog image records by {@code name}. */
    static sortImagesNaturally(images) {
        const slideListArray = Array.isArray(images) ? images.slice() : [];
        slideListArray.sort((a, b) => AnnotationAdapter.naturalCollator.compare(
            String(a?.name ?? ""),
            String(b?.name ?? "")
        ));
        return slideListArray;
    }

    /**
     * Sentinel select values for the left-column case filter.
     * Empty / placeholder keeps the list fully hidden (zero-exposure default).
     */
    static CASE_FILTER_PLACEHOLDER_VALUE = "";
    static CASE_FILTER_ALL_SLIDES_VALUE = "__all_slides__";
    static CASE_FILTER_PLACEHOLDER_LABEL = "-- Select Slides --";
    static ZERO_EXPOSURE_STATUS = "Select slides to begin.";
    static EMPTY_VIEWPORT_GUIDANCE =
        "Use the dropdown menu on the left to select slides for viewing.";
    /** When true, left-column slide rows show async macro label thumbnails. */
    static slideLabelThumbsEnabled = true;
    static slideLabelThumbObserver = null;
    /** Invalidates in-flight sidebar OCR when the case list is rebuilt. */
    static sidebarOcrBatchGeneration = 0;
    static slideLabelThumbGeneration = 0;
    static sidebarOcrInFlight = typeof Set !== "undefined" ? new Set() : null;
    /** Keys that already received a full-angle list OCR attempt this session. */
    static ocrThoroughAttempt = typeof Set !== "undefined" ? new Set() : null;

    /**
     * True when the case filter is on the blank privacy placeholder
     * ("-- Select Slides --" / empty value).
     */
    static isCaseFilterPlaceholderSelected(selectElement) {
        if (!selectElement) return true;
        const value = String(selectElement.value ?? "").trim();
        if (!value || value === AnnotationAdapter.CASE_FILTER_PLACEHOLDER_VALUE) {
            return true;
        }
        if (/^--\s*select (slides|a patient case)\s*--$/i.test(value)) {
            return true;
        }
        const label = String(selectElement.selectedOptions?.[0]?.textContent ?? "").trim();
        return /^--\s*select (slides|a patient case)\s*--$/i.test(label);
    }

    /**
     * Block localStorage / session auto-open of the last slide while the
     * case filter remains on the zero-exposure placeholder.
     */
    static shouldBypassSessionImageAutoload(selectElement) {
        if (!selectElement) return false;
        return AnnotationAdapter.isCaseFilterPlaceholderSelected(selectElement);
    }

    /**
     * Blank the main workspace chrome for fresh load / case-filter changes:
     * clear image headers and status text, force {@code viewer.close()} when a
     * viewer is provided (pure-black viewport), purge native annotation shapes
     * and AI nuclei overlays left over from the previous slide, and hide Z /
     * channels / measurement panels until a slide is clicked again.
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
            if (typeof viewer.clearOverlays === "function") {
                try { viewer.clearOverlays(); } catch (_error) { /* ignore */ }
            }
        }

        // viewer.close()/clearOverlays() above only tear down OSD's own tiles and
        // overlay nodes. The native annotation shapes (see onSlideClicked) live in
        // their own persistent SVG groups and otherwise keep showing the previous
        // slide's annotations — floating over the now-blank viewport — until a *new*
        // slide is opened. Purge them here too so every case-filter change (e.g.
        // switching to "All Slides") reliably blanks annotations along with the tiles.
        AnnotationAdapter.setSavedAnnotations([]);
        AnnotationAdapter.purgeAlternativeAnnotationLayers();

        const setText = (id, text) => {
            const el = root.getElementById(id);
            if (el) el.textContent = text;
        };
        setText("selected-name", "No image selected");
        setText("header-case-id", "");
        setText("header-slide-detail", "");
        const currentName = root.getElementById("current-image-name");
        if (currentName) currentName.hidden = true;
        const legacyBlock = root.getElementById("brand-case-block");
        if (legacyBlock) legacyBlock.hidden = true;
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
        if (imageInfo) {
            imageInfo.hidden = false;
            imageInfo.open = false;
        }

        for (const id of [
            "z-controls-card",
            "z-depth-controls",
            "measure-session-panel",
            "series-select-control"
        ]) {
            const el = root.getElementById(id);
            if (el) el.hidden = true;
        }

        const stack = root.querySelector?.(".right-stack-controls");
        if (stack) stack.hidden = true;

        AnnotationAdapter.closeFloatingChannelPalette(root);
        AnnotationAdapter.closeFloatingAiLabsPalette(root);
        AnnotationAdapter.closeFloatingAdminPalette(root);
        AnnotationAdapter.setFloatingZStackPaletteVisible(false, root);
        AnnotationAdapter.closeFloatingMeasurementPalette(root);
        AnnotationAdapter.hideMeasurementPopup(root);
        AnnotationAdapter.hideAnnotationEditorPopup(root);
        const channels = root.getElementById("channels");
        if (channels) {
            channels.replaceChildren();
            channels.hidden = true;
        }
        const channelsHeader = root.querySelector?.("#channels-panel > .panel-header");
        if (channelsHeader) channelsHeader.hidden = true;
        const aiPanel = root.getElementById("ai-analytics-panel");
        if (aiPanel) aiPanel.hidden = true;
        const aiLabs = root.getElementById("ai-labs-panel");
        if (aiLabs) {
            aiLabs.hidden = true;
            aiLabs.classList.remove("show");
        }
        AnnotationAdapter.clearAiNucleiOverlay({ remove: true });
        AnnotationAdapter.setAiStatus("AI Pipeline: Idle", root);

        const measureList = root.getElementById("measure-session-list");
        if (measureList) measureList.replaceChildren();
        AnnotationAdapter.measurementSessionList = [];
        AnnotationAdapter.clearMeasurementResultsTable(root);
        AnnotationAdapter.setEmptyViewportGuidanceVisible(root, true);
    }

    /**
     * Show/hide the centered empty-canvas guidance overlay in the main viewport.
     */
    static setEmptyViewportGuidanceVisible(doc, visible) {
        const root = doc || (typeof document !== "undefined" ? document : null);
        if (!root || typeof root.getElementById !== "function") return;
        const overlay = root.getElementById("empty-viewport-guidance");
        if (!overlay) return;
        overlay.hidden = !visible;
        overlay.style.display = visible ? "" : "none";
        overlay.setAttribute("aria-hidden", visible ? "false" : "true");
    }

    /** Default / cycle steps for sidebar + overview slide-label views (clockwise). */
    static SLIDE_LABEL_ROTATIONS_DEG = [90, 180, 270, 0];
    static SLIDE_LABEL_DEFAULT_ROTATION_DEG = 90;
    /** Per-image remembered rotation for sidebar thumbs and main overview label. */
    static slideLabelRotationByImageId = Object.create(null);

    /** Macro label thumbnail URL for a catalog slide id (native Bio-Formats pipeline). */
    static slideLabelThumbUrl(imageId) {
        if (!imageId) return "";
        return `/api/images/${encodeURIComponent(imageId)}/label.png?max=160`;
    }

    /**
     * Full-resolution macro/associated label PNG (same Bio-Formats route as the
     * sidebar thumb src, but always loaded into a detached Image for OCR so CSS
     * layout scaling cannot downsample the pixel buffer).
     */
    static slideLabelFullResUrl(imageId) {
        return AnnotationAdapter.slideLabelThumbUrl(imageId);
    }

    static normalizeSlideLabelRotation(degrees) {
        const allowed = AnnotationAdapter.SLIDE_LABEL_ROTATIONS_DEG;
        let next = Number.parseInt(degrees, 10);
        if (!Number.isFinite(next) || !allowed.includes(next)) {
            next = AnnotationAdapter.SLIDE_LABEL_DEFAULT_ROTATION_DEG;
        }
        return next;
    }

    static getSlideLabelRotation(imageId) {
        if (imageId != null
            && Object.prototype.hasOwnProperty.call(
                AnnotationAdapter.slideLabelRotationByImageId,
                imageId
            )) {
            return AnnotationAdapter.normalizeSlideLabelRotation(
                AnnotationAdapter.slideLabelRotationByImageId[imageId]
            );
        }
        return AnnotationAdapter.SLIDE_LABEL_DEFAULT_ROTATION_DEG;
    }

    static rememberSlideLabelRotation(imageId, degrees) {
        const next = AnnotationAdapter.normalizeSlideLabelRotation(degrees);
        if (imageId != null && imageId !== "") {
            AnnotationAdapter.slideLabelRotationByImageId[imageId] = next;
        }
        return next;
    }

    /**
     * Apply rotation CSS to a wrap/stage element (sidebar thumb or overview popup).
     * Sidebar wrappers keep a fixed 80×80 frame; only the {@code <img>} spins.
     */
    static applySlideLabelRotationStyles(target, degrees) {
        if (!target) return AnnotationAdapter.SLIDE_LABEL_DEFAULT_ROTATION_DEG;
        const next = AnnotationAdapter.normalizeSlideLabelRotation(degrees);
        target.dataset.rotation = String(next);
        if (typeof target.style?.setProperty === "function") {
            target.style.setProperty("--label-rotation", `${next}deg`);
        }
        const classList = target.classList;
        const hasClass = (name) => typeof classList?.contains === "function" && classList.contains(name);
        const isSidebarFrame = hasClass("sidebar-label-wrapper") || hasClass("slide-label-thumb-wrap");
        if (typeof classList?.toggle === "function") {
            if (isSidebarFrame) {
                // Fixed square frame — never swap width/height with rotation.
                if (typeof classList.remove === "function") {
                    classList.remove("is-landscape-rotation");
                }
            } else {
                const landscape = next === 0 || next === 180;
                classList.toggle("is-landscape-rotation", landscape);
            }
        }
        const slot = target.closest?.(".sidebar-label-slot");
        const button = (typeof target.querySelector === "function"
            ? target.querySelector(".slide-label-rotate, .overview-label-rotate")
            : null)
            || slot?.querySelector?.(":scope > .slide-label-rotate")
            || null;
        if (button) {
            button.title = `Rotate label (${next}° → next 90° clockwise)`;
            button.setAttribute("aria-label", `Rotate slide label, currently ${next} degrees`);
        }
        return next;
    }

    /**
     * Push the active angle onto the main-window overview popup + lightbox label.
     * Flat {@code <img>} path (no OpenSeadragon labelViewer in this build).
     */
    static syncMainWindowSlideLabelRotation(degrees, imageId = null) {
        const next = AnnotationAdapter.normalizeSlideLabelRotation(degrees);
        if (imageId != null && imageId !== "") {
            AnnotationAdapter.rememberSlideLabelRotation(imageId, next);
        }
        const root = typeof document !== "undefined" ? document : null;
        if (!root || typeof root.getElementById !== "function") return next;

        const stage = root.getElementById("overview-label-stage");
        if (stage) AnnotationAdapter.applySlideLabelRotationStyles(stage, next);

        const overviewImg = root.getElementById("slide-label-image");
        if (overviewImg && typeof overviewImg.style?.setProperty === "function") {
            overviewImg.style.setProperty("--label-rotation", `${next}deg`);
            overviewImg.dataset.rotation = String(next);
        }

        const lightbox = root.getElementById("image-lightbox-image");
        if (lightbox
            && lightbox.dataset?.rotationKind === "slide-label"
            && typeof lightbox.style?.setProperty === "function") {
            lightbox.style.setProperty("--label-rotation", `${next}deg`);
            lightbox.dataset.rotation = String(next);
            lightbox.classList.add("is-slide-label-rotated");
        }
        return next;
    }

    /**
     * Apply a clockwise rotation (degrees) to one thumbnail wrap.
     * Swaps wrap portrait/landscape slot so the vertical list does not gap oddly.
     */
    static applySlideLabelThumbRotation(wrap, degrees) {
        return AnnotationAdapter.applySlideLabelRotationStyles(wrap, degrees);
    }

    /** Cycle one thumbnail wrap forward by 90° clockwise and sync the overview popup. */
    static cycleSlideLabelThumbRotation(wrap) {
        if (!wrap) return AnnotationAdapter.SLIDE_LABEL_DEFAULT_ROTATION_DEG;
        const current = Number.parseInt(wrap.dataset.rotation || "90", 10);
        const steps = AnnotationAdapter.SLIDE_LABEL_ROTATIONS_DEG;
        const idx = steps.indexOf(current);
        const next = steps[(idx >= 0 ? idx + 1 : 0) % steps.length];
        AnnotationAdapter.applySlideLabelThumbRotation(wrap, next);
        const imageId = wrap.closest?.(".image-button")?.dataset?.imageId || null;
        return AnnotationAdapter.syncMainWindowSlideLabelRotation(next, imageId);
    }

    /** Cycle the main overview popup label and mirror onto the matching sidebar thumb. */
    static cycleOverviewSlideLabelRotation(doc = null, imageId = null) {
        const root = doc || (typeof document !== "undefined" ? document : null);
        const stage = root?.getElementById?.("overview-label-stage");
        const current = Number.parseInt(
            stage?.dataset?.rotation
            || String(AnnotationAdapter.getSlideLabelRotation(imageId)),
            10
        );
        const steps = AnnotationAdapter.SLIDE_LABEL_ROTATIONS_DEG;
        const idx = steps.indexOf(AnnotationAdapter.normalizeSlideLabelRotation(current));
        const next = steps[(idx >= 0 ? idx + 1 : 0) % steps.length];
        AnnotationAdapter.syncMainWindowSlideLabelRotation(next, imageId);
        if (imageId && root) {
            for (const button of root.querySelectorAll?.(".image-button") || []) {
                if (button.dataset?.imageId !== imageId) continue;
                const thumbWrap = button.querySelector(".slide-label-thumb-wrap");
                if (thumbWrap) AnnotationAdapter.applySlideLabelThumbRotation(thumbWrap, next);
                break;
            }
        }
        return next;
    }

    /** Remove all left-column slide-label thumbnail images immediately. */
    static clearSlideLabelThumbs(root = null) {
        AnnotationAdapter.slideLabelThumbGeneration += 1;
        const scope = root
            || (typeof document !== "undefined" ? document.getElementById("image-list") : null)
            || (typeof document !== "undefined" ? document : null);
        if (!scope || typeof scope.querySelectorAll !== "function") return;
        for (const slot of scope.querySelectorAll(".sidebar-label-slot")) {
            const thumb = slot.querySelector(".slide-label-thumb");
            if (thumb) thumb.removeAttribute("src");
            slot.hidden = true;
            slot.remove();
        }
        for (const wrap of scope.querySelectorAll(".slide-label-thumb-wrap, .sidebar-label-wrapper")) {
            const thumb = wrap.querySelector(".slide-label-thumb");
            if (thumb) thumb.removeAttribute("src");
            wrap.hidden = true;
            wrap.remove();
        }
        for (const thumb of scope.querySelectorAll(".slide-label-thumb")) {
            thumb.removeAttribute("src");
            thumb.hidden = true;
            thumb.remove();
        }
        // The rotate button lives in .slide-actions-col, a sibling of the slot
        // removed above, not inside it -- so it must be cleaned up explicitly or
        // it survives as an orphan and loadSlideLabelThumbs() appends a duplicate
        // next time labels are shown again (repeated toggling stacks up N copies).
        for (const rotate of scope.querySelectorAll(".slide-label-rotate")) {
            rotate.remove();
        }
        for (const button of scope.querySelectorAll(".image-button")) {
            button.classList.remove("has-slide-label-thumb");
        }
        // A DOM node removed out from under the pointer does not reliably fire
        // mouseleave, so drop any open hover preview explicitly here too.
        AnnotationAdapter.hideSidebarLabelHoverPreview(
            typeof document !== "undefined" ? document : null
        );
    }

    /**
     * Lazily create the single shared hover-preview panel used to show a large
     * rendering of a sidebar slide-label thumbnail while the pointer rests on
     * it. One instance is reused for every row rather than one per row.
     */
    static ensureSidebarLabelHoverPreview(doc) {
        if (!doc) return null;
        let panel = doc.getElementById("sidebar-label-hover-preview");
        if (panel) return panel;
        panel = doc.createElement("div");
        panel.id = "sidebar-label-hover-preview";
        panel.className = "sidebar-label-hover-preview";
        panel.hidden = true;
        panel.setAttribute("aria-hidden", "true");
        const img = doc.createElement("img");
        img.id = "sidebar-label-hover-preview-image";
        img.alt = "Slide label preview";
        panel.append(img);
        (doc.body || doc.documentElement)?.append?.(panel);
        return panel;
    }

    /**
     * Show a large version of a sidebar label thumbnail on hover, at the
     * slide's current saved rotation. Loads the same full-resolution route
     * as the persistent Slide Overview window's own label image, not the
     * small ?max=160 thumbnail already on screen, so it isn't blown up blurry.
     */
    static showSidebarLabelHoverPreview(doc, imageId, anchorRect) {
        if (!doc || !imageId) return;
        const panel = AnnotationAdapter.ensureSidebarLabelHoverPreview(doc);
        const img = panel?.querySelector?.("img");
        if (!panel || !img) return;
        if (img.dataset.imageId !== String(imageId)) {
            img.dataset.imageId = String(imageId);
            img.src = `/api/images/${encodeURIComponent(imageId)}/label.png`;
        }
        const degrees = AnnotationAdapter.getSlideLabelRotation(imageId);
        img.style.setProperty("--label-rotation", `${degrees}deg`);

        panel.hidden = false;
        const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
        const viewportWidth = Number(win?.innerWidth) || 1200;
        const viewportHeight = Number(win?.innerHeight) || 800;
        const panelWidth = Number(panel.offsetWidth) || 420;
        const panelHeight = Number(panel.offsetHeight) || 420;
        const rect = anchorRect || { left: 0, top: 0, right: 0, bottom: 0 };
        let left = Number(rect.right) + 14;
        let top = Number(rect.top);
        if (left + panelWidth > viewportWidth - 10) {
            left = Math.max(10, Number(rect.left) - panelWidth - 14);
        }
        if (top + panelHeight > viewportHeight - 10) {
            top = Math.max(10, viewportHeight - panelHeight - 10);
        }
        if (top < 10) top = 10;
        if (left < 10) left = 10;
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    }

    static hideSidebarLabelHoverPreview(doc) {
        const panel = doc?.getElementById?.("sidebar-label-hover-preview");
        if (panel) panel.hidden = true;
    }

    /**
     * Attach 80×80 macro label thumbnails + 🔄 under each listed filename.
     * Cached images are revealed immediately (onload does not re-fire).
     * Generation only invalidates after {@link clearSlideLabelThumbs}.
     */
    static revealSlideLabelThumb(button, slot, wrap, thumb) {
        if (!AnnotationAdapter.slideLabelThumbsEnabled) return;
        if (thumb) thumb.hidden = false;
        if (wrap) wrap.hidden = false;
        if (slot) slot.hidden = false;
        if (button && typeof button.classList?.add === "function") {
            button.classList.add("has-slide-label-thumb");
        }
    }

    static loadSlideLabelThumbs(root = null) {
        const generation = AnnotationAdapter.slideLabelThumbGeneration;
        const scope = root
            || (typeof document !== "undefined" ? document.getElementById("image-list") : null)
            || (typeof document !== "undefined" ? document : null);
        if (!scope || typeof scope.querySelectorAll !== "function") return generation;
        const doc = typeof document !== "undefined" ? document : null;
        if (!doc) return generation;

        for (const button of scope.querySelectorAll(".image-button")) {
            const imageId = button.dataset?.imageId;
            if (!imageId) continue;

            let slot = button.querySelector(".sidebar-label-slot");
            let wrap = button.querySelector(".sidebar-label-wrapper, .slide-label-thumb-wrap");
            if (!slot || !wrap) {
                slot = doc.createElement("div");
                slot.className = "sidebar-label-slot";

                wrap = doc.createElement("div");
                wrap.className = "sidebar-label-wrapper slide-label-thumb-wrap";

                const rotate = doc.createElement("button");
                rotate.type = "button";
                rotate.className = "slide-label-rotate";
                rotate.textContent = "🔄";
                rotate.addEventListener("click", event => {
                    event.preventDefault();
                    event.stopPropagation();
                    AnnotationAdapter.cycleSlideLabelThumbRotation(wrap);
                });

                const thumb = doc.createElement("img");
                thumb.className = "slide-label-thumb";
                thumb.alt = "Slide label";
                thumb.decoding = "async";

                wrap.addEventListener("mouseenter", () => {
                    AnnotationAdapter.showSidebarLabelHoverPreview(doc, imageId, wrap.getBoundingClientRect());
                });
                wrap.addEventListener("mouseleave", () => {
                    AnnotationAdapter.hideSidebarLabelHoverPreview(doc);
                });

                wrap.append(thumb);
                slot.append(wrap);
                const info = AnnotationAdapter.ensureSlideInfoBlock(button, doc);
                if (info && typeof button.insertBefore === "function") button.insertBefore(slot, info);
                else button.append(slot);
                const actions = button.querySelector(".slide-actions-col");
                // Defensive de-dup: this creation branch should only ever run once per
                // row, but if a stale rotate button from a previous cycle was ever left
                // behind (e.g. by a future code path that doesn't go through
                // clearSlideLabelThumbs), drop it rather than stacking another one on.
                for (const stale of button.querySelectorAll(".slide-label-rotate")) stale.remove();
                if (actions) actions.append(rotate);
                else slot.append(rotate);
                AnnotationAdapter.ensureRowOcrScanButton(actions || slot, button, doc);
                AnnotationAdapter.applySlideLabelThumbRotation(
                    wrap,
                    AnnotationAdapter.getSlideLabelRotation(imageId)
                );
            } else {
                const legacyScan = slot.querySelector(":scope > .ocr-test-btn, :scope > .ocr-row-scan-btn");
                if (legacyScan) legacyScan.remove();
                const legacyRotate = slot.querySelector(":scope > .slide-label-rotate");
                const actions = button.querySelector(".slide-actions-col");
                if (legacyRotate && actions) actions.append(legacyRotate);
                AnnotationAdapter.ensureRowOcrScanButton(actions || slot, button, doc);
                AnnotationAdapter.applySlideLabelThumbRotation(
                    wrap,
                    AnnotationAdapter.getSlideLabelRotation(imageId)
                );
            }

            const thumb = wrap.querySelector(".slide-label-thumb");
            if (!thumb) continue;
            thumb.loading = "lazy";
            thumb.decoding = "async";
            const url = AnnotationAdapter.slideLabelThumbUrl(imageId);
            thumb.onload = () => {
                if (generation !== AnnotationAdapter.slideLabelThumbGeneration) return;
                AnnotationAdapter.revealSlideLabelThumb(button, slot, wrap, thumb);
            };
            thumb.onerror = () => {
                if (generation !== AnnotationAdapter.slideLabelThumbGeneration) return;
                thumb.hidden = true;
                wrap.hidden = true;
                slot.hidden = true;
                thumb.removeAttribute("src");
                button.classList.remove("has-slide-label-thumb");
            };
            if (thumb.complete && (thumb.naturalWidth || 0) > 0 && thumb.src) {
                AnnotationAdapter.revealSlideLabelThumb(button, slot, wrap, thumb);
                continue;
            }
            if (AnnotationAdapter.isSlideRowVisibleForLabel(button)) {
                AnnotationAdapter.observeSlideLabelThumb(button, thumb, url);
            }
        }
        return generation;
    }

    static isSlideRowVisibleForLabel(button) {
        const contents = button?.closest?.(".folder-contents");
        if (contents && (contents.hidden || contents.style?.display === "none")) return false;
        return true;
    }

    static observeSlideLabelThumb(button, thumb, url) {
        if (!thumb || !url) return;
        if (typeof IntersectionObserver !== "function") {
            if (thumb.src !== url) thumb.src = url;
            return;
        }
        if (!AnnotationAdapter.slideLabelThumbObserver) {
            const root = (typeof document !== "undefined")
                ? document.getElementById("images-panel")
                : null;
            AnnotationAdapter.slideLabelThumbObserver = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const img = entry.target;
                    const pending = img.dataset?.labelSrc;
                    if (pending && img.src !== pending) img.src = pending;
                    AnnotationAdapter.slideLabelThumbObserver.unobserve(img);
                }
            }, { root, rootMargin: "120px", threshold: 0.01 });
        }
        if (thumb.dataset) thumb.dataset.labelSrc = url;
        AnnotationAdapter.slideLabelThumbObserver.observe(thumb);
    }

    /**
     * Browser-tier OCR helpers (hybrid fallback when catalog markers are empty).
     */
    static async loadImageElementForOcrDraw(imgOrSrc) {
        if (!imgOrSrc) return null;
        if (typeof HTMLImageElement !== "undefined" && imgOrSrc instanceof HTMLImageElement) {
            if (imgOrSrc.complete && (imgOrSrc.naturalWidth || 0) > 0) return imgOrSrc;
            await new Promise((resolve, reject) => {
                const onLoad = () => {
                    imgOrSrc.removeEventListener("error", onError);
                    resolve();
                };
                const onError = () => {
                    imgOrSrc.removeEventListener("load", onLoad);
                    reject(new Error("Label image failed to load for OCR"));
                };
                imgOrSrc.addEventListener("load", onLoad, { once: true });
                imgOrSrc.addEventListener("error", onError, { once: true });
            });
            return imgOrSrc;
        }
        const src = typeof imgOrSrc === "string" ? imgOrSrc : String(imgOrSrc?.src || "");
        if (!src || typeof Image === "undefined") return null;
        const img = new Image();
        img.decoding = "async";
        await new Promise((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("Label image failed to load for OCR"));
            img.src = src;
        });
        return img;
    }

    /** Four physical pixel orientations for a forced manual OCR sweep. */
    static OCR_QUADRANT_DEG = [90, 0, 180, 270];

    /** Physically rotate raw label pixels before Tesseract (full-resolution canvas). */
    static createRotatedDataUrl(imgElement, degrees = 90) {
        if (!imgElement || typeof document === "undefined") return "";
        const width = Number(imgElement.naturalWidth || imgElement.width) || 0;
        const height = Number(imgElement.naturalHeight || imgElement.height) || 0;
        if (width < 1 || height < 1) return "";
        const deg = ((Math.round(Number(degrees)) % 360) + 360) % 360;
        const swap = deg === 90 || deg === 270;
        const canvas = document.createElement("canvas");
        canvas.width = swap ? height : width;
        canvas.height = swap ? width : height;
        const context = canvas.getContext("2d");
        if (!context) return "";
        context.clearRect(0, 0, canvas.width, canvas.height);
        if (deg === 90) {
            context.translate(height, 0);
            context.rotate(Math.PI / 2);
        } else if (deg === 180) {
            context.translate(width, height);
            context.rotate(Math.PI);
        } else if (deg === 270) {
            context.translate(0, width);
            context.rotate((3 * Math.PI) / 2);
        }
        context.drawImage(imgElement, 0, 0);
        return canvas.toDataURL("image/png");
    }

    /** Physically spin raw label pixels 90° CW for upright Tesseract input. */
    static createRotated90CwDataUrl(imgElement) {
        return AnnotationAdapter.createRotatedDataUrl(imgElement, 90);
    }

    static OCR_CHAR_WHITELIST =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-.";
    static OCR_PAGE_SEG_MODE = "11";

    static tesseractRecognizeOptions() {
        const whitelist = AnnotationAdapter.OCR_CHAR_WHITELIST;
        const psm = AnnotationAdapter.OCR_PAGE_SEG_MODE;
        return {
            tessedit_char_whitelist: whitelist,
            tessedit_enable_doc_dict: "0",
            tessedit_enable_bigram_dict: "0",
            tessedit_pageseg_mode: psm,
            tessedit_pages_seg_mode: psm
        };
    }

    /**
     * Safe-catch for printer / OCR alignment variance around the clinical
     * {@code if.} anchor (space, period, or space-period permutations).
     */
    static normalizeOcrClinicalText(text) {
        return String(text || "").replace(/if[\s\.]+/i, "if.");
    }

    /** First {@code if.<epitope>} token after omnidirectional normalization. */
    static extractIfEpitopeMarker(text) {
        const source = String(text || "");
        const greedy = source.match(/if[\s\.]+\S+/i);
        const normalized = AnnotationAdapter.normalizeOcrClinicalText(greedy ? greedy[0] : source);
        const match = String(normalized || "").match(/if\.\S+/i);
        if (!match) return "";
        const token = match[0];
        if (/^if\.(pending|none|unknown|n\/?a)\b/i.test(token)) return "";
        return token;
    }

    static catalogSidecarCache = new Map();

    static readPositiveSidecarInt(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
    }

    /**
     * Flatten a sidecar / catalog row into one immutable record. Nested alias
     * walks happen once here, never during listing paint.
     */
    static mapSidecarProperties(raw = {}) {
        const source = raw && typeof raw === "object" ? raw : {};
        const folder = String(source.folder || source.directory || "");
        const clinicalMarker = AnnotationAdapter.extractIfEpitopeMarker(
            source.clinicalMarker || source.clinical_marker || source.epitope || ""
        );
        const zPlanes = AnnotationAdapter.readPositiveSidecarInt(
            source.zPlanes ?? source.z_planes ?? source.zPlaneCount ?? source.z_plane_count
        );
        const depth = AnnotationAdapter.readPositiveSidecarInt(
            source.depth ?? source.zDepth ?? source.z_depth
        );
        const zLayers = AnnotationAdapter.readPositiveSidecarInt(
            source.zLayers ?? source.z_layers ?? source.layers
        );
        return Object.freeze({
            id: source.id || "",
            name: source.name || "",
            relativePath: source.relativePath || source.relative_path || "",
            folder,
            clinicalMarker,
            zPlanes,
            depth,
            zLayers
        });
    }

    static isMultiLayerSlide(image) {
        const mapped = AnnotationAdapter.mapSidecarProperties(image);
        return mapped.zPlanes > 1
            || mapped.depth > 1
            || mapped.zLayers > 1
            || Boolean(mapped.folder && mapped.folder.includes("_z"));
    }

    static zPlaneCountFromSlide(image) {
        const mapped = AnnotationAdapter.mapSidecarProperties(image);
        let count = Math.max(mapped.zPlanes, mapped.depth, mapped.zLayers, 1);
        if (count < 2 && mapped.folder && mapped.folder.includes("_z")) count = 2;
        return count;
    }

    /**
     * One-pass catalog ingest: id / name / path → frozen sidecar record.
     */
    static cacheCatalogSidecarMetadata(images = []) {
        const cache = new Map();
        const list = Array.isArray(images) ? images : [];
        for (const image of list) {
            const mapped = AnnotationAdapter.mapSidecarProperties(image);
            const keys = [mapped.id, mapped.name, mapped.relativePath, image?.id, image?.name, image?.relativePath];
            for (const key of keys) {
                const token = String(key || "").trim();
                if (token) cache.set(token, mapped);
            }
            if (mapped.clinicalMarker) {
                const cacheKey = AnnotationAdapter.sidebarOcrCacheKey(image) || mapped.id;
                AnnotationAdapter.writeOcrSessionCache(cacheKey, mapped.clinicalMarker);
            }
        }
        AnnotationAdapter.catalogSidecarCache = cache;
        return cache;
    }

    static sidecarRecordForImage(image) {
        if (!image) return null;
        const cache = AnnotationAdapter.catalogSidecarCache;
        if (!cache || typeof cache.get !== "function") return null;
        const keys = [
            image.dataset?.imageId,
            image.id,
            image.name,
            image.relativePath,
            image.dataset?.imageName,
            image.dataset?.imagePath
        ];
        for (const key of keys) {
            const token = String(key || "").trim();
            if (token && cache.has(token)) return cache.get(token);
        }
        return null;
    }

    /** Flatten Tesseract output to a single debug line. */
    static flattenRawOcrText(text) {
        return String(text || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    }

    /**
     * Active visual rotation for a left-column row (data-rotation, CSS var, memory).
     */
    static readRowLabelRotation(rowButton) {
        const wrap = rowButton?.querySelector?.(
            ".slide-label-thumb-wrap, .sidebar-label-wrapper"
        );
        const fromData = wrap?.dataset?.rotation;
        const fromCss = wrap?.style?.getPropertyValue?.("--label-rotation");
        const imageId = rowButton?.dataset?.imageId || "";
        const remembered = imageId
            ? AnnotationAdapter.getSlideLabelRotation(imageId)
            : AnnotationAdapter.SLIDE_LABEL_DEFAULT_ROTATION_DEG;
        return AnnotationAdapter.normalizeSlideLabelRotation(
            fromData || fromCss || remembered
        );
    }

    static async recognizeLabelImage(imgOrSrc) {
        if (typeof Tesseract === "undefined" || typeof Tesseract.recognize !== "function") {
            throw new Error("Tesseract.js is unavailable");
        }
        const imgElement = await AnnotationAdapter.loadImageElementForOcrDraw(imgOrSrc);
        if (!imgElement) {
            return { text: "", rawText: "", marker: "", ok: false };
        }
        return AnnotationAdapter.recognizeLabelImageSweep(imgElement, {
            angles: [90]
        });
    }

    /**
     * Full-resolution multi-angle sweep. Stops at the first {@code if.<epitope>}.
     * Manual row scans pass all four quadrants; the background path uses 90° only.
     */
    static async recognizeLabelImageSweep(imgOrSrc, options = {}) {
        if (typeof Tesseract === "undefined" || typeof Tesseract.recognize !== "function") {
            throw new Error("Tesseract.js is unavailable");
        }
        const imgElement = await AnnotationAdapter.loadImageElementForOcrDraw(imgOrSrc);
        if (!imgElement) {
            return { text: "", rawText: "", marker: "", ok: false, angle: null };
        }
        const angles = Array.isArray(options.angles) && options.angles.length
            ? options.angles
            : AnnotationAdapter.OCR_QUADRANT_DEG;
        let lastNormalized = "";
        let lastRaw = "";
        for (const degrees of angles) {
            const rotatedDataUrl = AnnotationAdapter.createRotatedDataUrl(imgElement, degrees);
            if (!rotatedDataUrl) continue;
            const result = await Tesseract.recognize(
                rotatedDataUrl,
                "eng",
                AnnotationAdapter.tesseractRecognizeOptions()
            );
            const engineRaw = String(result?.data?.text || "");
            const normalized = AnnotationAdapter.normalizeOcrClinicalText(engineRaw);
            lastNormalized = normalized;
            lastRaw = engineRaw;
            const marker = AnnotationAdapter.extractIfEpitopeMarker(normalized);
            if (marker) {
                return {
                    text: normalized,
                    rawText: normalized,
                    engineRaw,
                    marker,
                    angle: degrees,
                    ok: true
                };
            }
        }
        return {
            text: lastNormalized,
            rawText: lastNormalized,
            engineRaw: lastRaw,
            marker: "",
            angle: null,
            ok: Boolean(String(lastNormalized || "").trim())
        };
    }

    /**
     * Wipe OCR result nodes. Sidebar clinical markers are kept across slide
     * selection (they are per-row); pass {@code includeSidebar: true} when
     * rebuilding the case list or leaving a case filter.
     */
    static isSidebarSidecarNode(node) {
        return Boolean(node?.closest?.(".image-button") || node?.closest?.(".image-button-stack"));
    }

    /**
     * Force black annotation name tags above the orange ROI top edge.
     * OpenSeadragon centering is overridden so labels do not sit on the box.
     */
    static applyAnnotationOverlayOffset(overlayElement, point) {
        if (!overlayElement?.style) return overlayElement;
        const x = Math.round(Number(point?.x) || 0);
        const y = Math.round(Number(point?.y) || 0);
        overlayElement.style.left = `${x}px`;
        overlayElement.style.top = `${y}px`;
        // Force tooltip labels to clear the boundary box lines entirely
        overlayElement.style.transform = "translate(-50%, -130%)";
        overlayElement.style.transformOrigin = "bottom center";
        overlayElement.style.zIndex = "100";
        overlayElement.style.whiteSpace = "nowrap";
        return overlayElement;
    }

    static revealSidecarText(targetNode) {
        if (!targetNode) return;
        targetNode.hidden = false;
        if (targetNode.style) {
            targetNode.style.display = "";
            targetNode.style.visibility = "";
        }
        if (typeof targetNode.classList?.remove === "function") {
            targetNode.classList.remove("hidden-ingestion");
        }
    }

    static clearSidecarText(targetNode) {
        if (!targetNode) return;
        AnnotationAdapter.revealSidecarText(targetNode);
        targetNode.textContent = "";
        if (typeof targetNode.classList?.remove === "function") {
            targetNode.classList.remove("ocr-result-pending");
            targetNode.classList.remove("ocr-result-raw");
            targetNode.classList.remove("ocr-result-ready");
        }
    }

    static clearAllOcrResultText(root = null, options = {}) {
        const includeSidebar = options.includeSidebar === true;
        const scope = root
            || (typeof document !== "undefined" ? document : null);
        if (!scope?.querySelectorAll) return;
        for (const node of scope.querySelectorAll(".ocr-result-text")) {
            if (!includeSidebar && (node.closest?.(".image-button") || node.closest?.(".slide-row"))) continue;
            AnnotationAdapter.clearSidecarText(node);
        }
    }

    /**
     * Place a permanent compressed {@code if.<epitope>} row under the filename.
     * Keep the node in layout so slide designations stay visible even when empty.
     */
    static renderOcrClinicalMarker(targetNode, text) {
        if (!targetNode) return;
        const marker = AnnotationAdapter.extractIfEpitopeMarker(text);
        AnnotationAdapter.revealSidecarText(targetNode);
        if (typeof targetNode.classList?.remove === "function") {
            targetNode.classList.remove("ocr-result-pending");
            targetNode.classList.remove("ocr-result-raw");
            if (!marker) targetNode.classList.remove("ocr-result-ready");
        }
        if (marker && typeof targetNode.classList?.add === "function") {
            targetNode.classList.add("ocr-result-ready");
        }
        targetNode.textContent = marker;
        if ("title" in targetNode) targetNode.title = marker;
        AnnotationAdapter.enableOcrResultTextSelection(targetNode);
    }

    /** Miss path: overview diagnostics only. Sidebar rows stay in layout. */
    static renderOcrRawDebug(targetNode, rawText) {
        if (!targetNode) return;
        if (AnnotationAdapter.isSidebarSidecarNode(targetNode)) {
            AnnotationAdapter.clearSidecarText(targetNode);
            return;
        }
        const flat = AnnotationAdapter.flattenRawOcrText(rawText) || "(empty)";
        AnnotationAdapter.revealSidecarText(targetNode);
        if (typeof targetNode.classList?.remove === "function") {
            targetNode.classList.remove("ocr-result-pending");
        }
        if (typeof targetNode.classList?.add === "function") {
            targetNode.classList.add("ocr-result-raw");
        }
        targetNode.textContent = `[RAW: ${flat}]`;
        AnnotationAdapter.enableOcrResultTextSelection(targetNode);
    }

    static enableOcrResultTextSelection(targetNode) {
        if (!targetNode || targetNode.dataset?.ocrSelectBound === "1") return;
        if (targetNode.closest?.(".image-button") || targetNode.closest?.(".image-button-stack")) {
            return;
        }
        const stop = event => {
            event.stopPropagation();
        };
        targetNode.addEventListener("mousedown", stop);
        targetNode.addEventListener("mouseup", stop);
        targetNode.addEventListener("click", stop);
        targetNode.addEventListener("dblclick", stop);
        targetNode.addEventListener("selectstart", stop);
        if (targetNode.dataset) targetNode.dataset.ocrSelectBound = "1";
    }

    static beginOcrPendingDisplay(targetNode) {
        if (!targetNode) return;
        if (AnnotationAdapter.isSidebarSidecarNode(targetNode)) {
            AnnotationAdapter.revealSidecarText(targetNode);
            return;
        }
        AnnotationAdapter.revealSidecarText(targetNode);
        if (typeof targetNode.classList?.add === "function") {
            targetNode.classList.add("ocr-result-pending");
        }
        targetNode.textContent = "·";
        AnnotationAdapter.enableOcrResultTextSelection(targetNode);
    }

    /**
     * Compact per-row 🔍 Scan control, parked beside the 🔄 rotator.
     * Scans at the row's current visual rotation (data-rotation / CSS).
     */
    static ensureRowOcrScanButton(host, rowButton, doc) {
        if (!doc) return null;
        const actions = rowButton?.querySelector?.(".slide-actions-col") || host;
        if (!actions) return null;
        let scan = rowButton?.querySelector?.(".ocr-row-scan-btn") || actions.querySelector(".ocr-row-scan-btn");
        if (scan) {
            const parent = scan.parentNode || scan.parent;
            if (parent !== actions && typeof actions.append === "function") actions.append(scan);
            return scan;
        }
        scan = doc.createElement("button");
        scan.type = "button";
        scan.className = "ocr-row-scan-btn";
        scan.title = "Force OCR Scan";
        scan.setAttribute("aria-label", "Force OCR Scan");
        scan.textContent = "🔍";
        scan.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            const degrees = AnnotationAdapter.readRowLabelRotation(rowButton);
            void AnnotationAdapter.runManualRowOcrScan(rowButton, scan, degrees);
        });
        actions.append(scan);
        return scan;
    }

    /**
     * Manual row OCR at the on-screen rotation. Marker hits lock into
     * {@link OcrSessionCache}; misses leave the sidebar epitope line empty.
     */
    static async runManualRowOcrScan(rowButton, scanBtn = null, degrees = null) {
        const doc = typeof document !== "undefined" ? document : null;
        const cacheKey = AnnotationAdapter.sidebarOcrCacheKey(rowButton);
        const targetNode = AnnotationAdapter.ensureSidebarOcrResultNode(rowButton, doc)
            || rowButton?.querySelector?.(".ocr-result-text");
        if (!cacheKey || !targetNode) return "";
        const angle = AnnotationAdapter.normalizeSlideLabelRotation(
            degrees == null
                ? AnnotationAdapter.readRowLabelRotation(rowButton)
                : degrees
        );
        if (scanBtn) {
            scanBtn.disabled = true;
            scanBtn.setAttribute("aria-busy", "true");
        }
        AnnotationAdapter.revealSidecarText(targetNode);
        const source = AnnotationAdapter.slideLabelFullResUrl(cacheKey);
        try {
            const result = await AnnotationAdapter.recognizeLabelImageSweep(source, {
                angles: [angle]
            });
            const raw = result?.engineRaw || result?.rawText || result?.text || "";
            const marker = AnnotationAdapter.extractIfEpitopeMarker(
                result?.marker || raw
            );
            if (marker) {
                AnnotationAdapter.writeOcrSessionCache(cacheKey, marker);
                AnnotationAdapter.renderOcrClinicalMarker(targetNode, marker);
                return marker;
            }
            // A single-angle client-side rescan is far more failure-prone than the
            // server-side OCR pipeline that normally populates this field (sidecar
            // metadata). Finding nothing here does not mean the existing value is
            // wrong -- leave it exactly as it was rather than wiping good data.
            return targetNode.textContent || "";
        } catch (error) {
            console.error("[wsi-ocr] manual rotation-synced scan failed", cacheKey, error);
            return targetNode.textContent || "";
        } finally {
            if (scanBtn) {
                scanBtn.disabled = false;
                scanBtn.removeAttribute("aria-busy");
            }
        }
    }

    static ensureSlideInfoBlock(button, doc) {
        if (!button || !doc) return null;
        let info = button.querySelector(".slide-info-block");
        if (info) return info;
        info = doc.createElement("div");
        info.className = "slide-info-block";
        const topRow = doc.createElement("div");
        topRow.className = "slide-top-row";
        let label = button.querySelector(".image-button-label");
        if (!label) {
            label = doc.createElement("span");
            label.className = "image-button-label";
            label.textContent = button.dataset?.slideLabel || button.dataset?.imageName || "";
        }
        topRow.append(label);
        const second = doc.createElement("div");
        second.className = "slide-second-row";
        const epitopeCol = doc.createElement("div");
        epitopeCol.className = "slide-epitope-col";
        const existingOcr = button.querySelector(".ocr-result-text");
        if (existingOcr) epitopeCol.append(existingOcr);
        const actions = doc.createElement("div");
        actions.className = "slide-actions-col";
        second.append(epitopeCol, actions);
        info.append(topRow, second);
        button.append(info);
        return info;
    }

    static ensureSidebarOcrResultNode(button, doc) {
        if (!button || !doc) return null;
        let result = button.querySelector(".ocr-result-text");
        const info = AnnotationAdapter.ensureSlideInfoBlock(button, doc);
        const epitopeCol = button.querySelector(".slide-epitope-col");
        if (result) {
            if (epitopeCol && (result.parentNode || result.parent) !== epitopeCol && typeof epitopeCol.append === "function") {
                epitopeCol.append(result);
            }
            AnnotationAdapter.revealSidecarText(result);
            AnnotationAdapter.enableOcrResultTextSelection(result);
            return result;
        }
        result = doc.createElement("span");
        result.className = "ocr-result-text";
        result.hidden = false;
        result.textContent = "";
        if (epitopeCol) epitopeCol.append(result);
        else if (info) info.append(result);
        else button.append(result);
        AnnotationAdapter.enableOcrResultTextSelection(result);
        return result;
    }

    /**
     * Listing row: 80×80 thumb plus a two-row info block (title, then
     * epitope + rotate/scan). The whole row loads the slide.
     */
    static createSlideRow(doc, image, title, extraClass, onSelect) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = extraClass
            ? `image-button image-button-stack slide-list-row ${extraClass}`
            : "image-button image-button-stack slide-list-row";
        button.dataset.imageId = image.id;
        button.dataset.imageName = image.name || "";
        button.dataset.imagePath = image.relativePath || "";
        button.dataset.clinicalMarker = image.clinicalMarker || "";
        button.dataset.ocrAttempted = image.ocrAttempted ? "1" : "";
        button.dataset.slideLabel = title;
        button.title = image.relativePath || image.name || "";
        const info = doc.createElement("div");
        info.className = "slide-info-block";
        const topRow = doc.createElement("div");
        topRow.className = "slide-top-row";
        const label = doc.createElement("span");
        label.className = "image-button-label";
        label.textContent = title;
        topRow.append(label);
        const second = doc.createElement("div");
        second.className = "slide-second-row";
        const epitopeCol = doc.createElement("div");
        epitopeCol.className = "slide-epitope-col";
        const actions = doc.createElement("div");
        actions.className = "slide-actions-col";
        second.append(epitopeCol, actions);
        info.append(topRow, second);
        button.append(info);
        button.addEventListener("click", (event) => {
            if (event.target?.closest?.(".ocr-row-scan-btn, .slide-label-rotate, .ocr-test-btn")) {
                return;
            }
            onSelect(image);
        });
        AnnotationAdapter.paintSidecarEpitopeOnButton(button, image, doc);
        return { row: button, button };
    }

    static sidebarOcrCacheKey(buttonOrImage) {
        if (!buttonOrImage) return "";
        const imageId = String(
            buttonOrImage.dataset?.imageId
            || buttonOrImage.id
            || ""
        ).trim();
        if (imageId) return imageId;
        return String(
            buttonOrImage.dataset?.imageName
            || buttonOrImage.dataset?.imagePath
            || buttonOrImage.name
            || buttonOrImage.relativePath
            || ""
        ).trim();
    }

    static hasOcrSessionCacheEntry(cacheKey) {
        return Boolean(cacheKey)
            && Object.prototype.hasOwnProperty.call(OcrSessionCache, cacheKey);
    }

    static readOcrSessionCache(cacheKey) {
        if (!AnnotationAdapter.hasOcrSessionCacheEntry(cacheKey)) return undefined;
        return OcrSessionCache[cacheKey];
    }

    static writeOcrSessionCache(cacheKey, markerText) {
        if (!cacheKey) return;
        OcrSessionCache[cacheKey] = String(markerText || "");
    }

    /**
     * Catalog marker only — never cache empty / Pending placeholders here
     * (empty must stay eligible for an explicit browser-tier OCR fallback).
     */
    static clinicalMarkerFromImage(image) {
        if (!image || typeof image !== "object") return "";
        const fromApi = AnnotationAdapter.extractIfEpitopeMarker(
            image.clinicalMarker || image.clinical_marker || image.epitope || ""
        );
        const cacheKey = AnnotationAdapter.sidebarOcrCacheKey(image);
        if (fromApi) {
            AnnotationAdapter.writeOcrSessionCache(cacheKey, fromApi);
            return fromApi;
        }
        const sidecar = AnnotationAdapter.sidecarRecordForImage(image);
        if (sidecar?.clinicalMarker) {
            AnnotationAdapter.writeOcrSessionCache(cacheKey, sidecar.clinicalMarker);
            return sidecar.clinicalMarker;
        }
        if (AnnotationAdapter.hasOcrSessionCacheEntry(cacheKey)) {
            return AnnotationAdapter.extractIfEpitopeMarker(
                AnnotationAdapter.readOcrSessionCache(cacheKey) || ""
            );
        }
        return "";
    }

    static paintSidecarEpitopeOnButton(button, image, doc) {
        const targetNode = AnnotationAdapter.ensureSidebarOcrResultNode(button, doc);
        if (!targetNode) return "";
        const marker = AnnotationAdapter.clinicalMarkerFromImage(image || {
            id: button?.dataset?.imageId,
            name: button?.dataset?.imageName,
            relativePath: button?.dataset?.imagePath
        });
        if (marker) AnnotationAdapter.renderOcrClinicalMarker(targetNode, marker);
        else AnnotationAdapter.clearSidecarText(targetNode);
        return marker;
    }

    /**
     * Paint cached {@code if.<epitope>} tokens onto listing rows.
     * Browser OCR is opt-in only ({@code allowBrowserFallback === true}).
     */
    static applyCatalogClinicalMarkers(container, images = [], options = {}) {
        if (!container || typeof container.querySelectorAll !== "function") return 0;
        const doc = typeof document !== "undefined" ? document : null;
        const allowBrowserFallback = options.allowBrowserFallback === true;
        const list = Array.isArray(images) ? images : [];
        if (list.length) {
            AnnotationAdapter.cacheCatalogSidecarMetadata(list);
        }
        const byId = new Map();
        for (const image of list) {
            if (image?.id) byId.set(String(image.id), image);
        }
        const missing = [];
        let painted = 0;
        for (const button of container.querySelectorAll(".image-button")) {
            const key = AnnotationAdapter.sidebarOcrCacheKey(button);
            const targetNode = AnnotationAdapter.ensureSidebarOcrResultNode(button, doc)
                || button.querySelector(".ocr-result-text");
            if (!targetNode) {
                continue;
            }
            const existing = AnnotationAdapter.extractIfEpitopeMarker(targetNode.textContent || "");
            const catalogImage = byId.get(String(key)) || {
                id: key,
                name: button.dataset?.imageName,
                relativePath: button.dataset?.imagePath,
                clinicalMarker: button.dataset?.clinicalMarker,
                ocrAttempted: button.dataset?.ocrAttempted === "1"
            };
            const marker = AnnotationAdapter.clinicalMarkerFromImage(catalogImage) || existing;
            const cachedEmptyMiss = AnnotationAdapter.hasOcrSessionCacheEntry(key)
                && !AnnotationAdapter.extractIfEpitopeMarker(
                    AnnotationAdapter.readOcrSessionCache(key) || ""
                );
            const thorough = Boolean(AnnotationAdapter.ocrThoroughAttempt?.has?.(key));
            // Server-side OCR (ops/retro_build_metadata.py, run by the ingestion daemon)
            // already scanned this slide's label at least once. If it found nothing, the
            // label genuinely has no readable marker -- there's no reason for every page
            // load to pay for a slow, sequential client-side Tesseract re-scan of the same
            // dead end. Trust that result the same way `cachedEmptyMiss && thorough` does
            // for a marker this browser tab already scanned itself.
            const serverAlreadyAttemptedOcr = catalogImage.ocrAttempted === true;
            if (marker) {
                AnnotationAdapter.renderOcrClinicalMarker(targetNode, marker);
            } else {
                AnnotationAdapter.clearSidecarText(targetNode);
                if (allowBrowserFallback && !serverAlreadyAttemptedOcr && !(cachedEmptyMiss && thorough)) {
                    missing.push(button);
                }
            }
            painted += 1;
        }
        if (allowBrowserFallback && missing.length) {
            void AnnotationAdapter.runBrowserOcrFallbackBatch(missing);
        }
        return painted;
    }

    static scheduleSidebarClinicalOcrBatch(container, images = []) {
        return AnnotationAdapter.applyCatalogClinicalMarkers(container, images, {
            allowBrowserFallback: true
        });
    }

    /**
     * Proven browser-tier path: rotate label.png 90° CW → Tesseract → normalize.
     * Results commit to {@link OcrSessionCache} so list rebuilds never re-scan.
     */
    static async runBrowserOcrFallbackBatch(buttons) {
        const inFlight = AnnotationAdapter.sidebarOcrInFlight;
        const doc = typeof document !== "undefined" ? document : null;
        const list = Array.isArray(buttons) ? buttons : [];
        for (const button of list) {
            const cacheKey = AnnotationAdapter.sidebarOcrCacheKey(button);
            const targetNode = AnnotationAdapter.ensureSidebarOcrResultNode(button, doc)
                || button.querySelector(".ocr-result-text");
            if (!targetNode || !cacheKey) continue;
            const cachedMarker = AnnotationAdapter.extractIfEpitopeMarker(
                AnnotationAdapter.readOcrSessionCache(cacheKey) || ""
            );
            if (cachedMarker) {
                AnnotationAdapter.renderOcrClinicalMarker(targetNode, cachedMarker);
                continue;
            }
            if (AnnotationAdapter.ocrThoroughAttempt?.has?.(cacheKey)) {
                AnnotationAdapter.renderOcrClinicalMarker(targetNode, cachedMarker);
                continue;
            }
            if (inFlight?.has?.(cacheKey)) continue;
            if (typeof Tesseract === "undefined" || typeof Tesseract.recognize !== "function") {
                AnnotationAdapter.writeOcrSessionCache(cacheKey, "");
                AnnotationAdapter.ocrThoroughAttempt?.add?.(cacheKey);
                AnnotationAdapter.renderOcrClinicalMarker(targetNode, "");
                continue;
            }
            AnnotationAdapter.revealSidecarText(targetNode);
            const thumb = button.querySelector?.(".slide-label-thumb");
            const source = (thumb && thumb.src)
                ? thumb
                : AnnotationAdapter.slideLabelFullResUrl(cacheKey);
            if (!source) {
                AnnotationAdapter.writeOcrSessionCache(cacheKey, "");
                AnnotationAdapter.ocrThoroughAttempt?.add?.(cacheKey);
                AnnotationAdapter.renderOcrClinicalMarker(targetNode, "");
                continue;
            }
            inFlight?.add?.(cacheKey);
            try {
                const result = await AnnotationAdapter.recognizeLabelImageSweep(source, {
                    angles: AnnotationAdapter.OCR_QUADRANT_DEG
                });
                const marker = AnnotationAdapter.extractIfEpitopeMarker(
                    result?.marker || result?.rawText || result?.text || ""
                );
                AnnotationAdapter.writeOcrSessionCache(cacheKey, marker);
                AnnotationAdapter.ocrThoroughAttempt?.add?.(cacheKey);
                if (targetNode.isConnected !== false) {
                    if (marker) AnnotationAdapter.renderOcrClinicalMarker(targetNode, marker);
                    else AnnotationAdapter.clearSidecarText(targetNode);
                }
            } catch (error) {
                console.error("[wsi-ocr] browser Tesseract fallback failed", cacheKey, error);
                AnnotationAdapter.writeOcrSessionCache(cacheKey, "");
                AnnotationAdapter.ocrThoroughAttempt?.add?.(cacheKey);
                if (targetNode.isConnected !== false) {
                    AnnotationAdapter.renderOcrClinicalMarker(targetNode, "");
                }
            } finally {
                inFlight?.delete?.(cacheKey);
            }
        }
    }

    static ensureOverviewOcrControls(doc = null) {
        const root = doc || (typeof document !== "undefined" ? document : null);
        if (!root) return null;
        const figure = root.querySelector(".overview-figure-label");
        if (!figure) return null;
        let result = root.getElementById("overview-ocr-result");
        if (!result) {
            result = root.createElement("pre");
            result.id = "overview-ocr-result";
            result.className = "ocr-result-text overview-ocr-result";
            result.hidden = false;
            const error = root.getElementById("slide-label-error");
            if (error) error.after(result);
            else figure.append(result);
        }
        AnnotationAdapter.enableOcrResultTextSelection(result);
        return { result };
    }

    static applyOverviewClinicalMarker(image, doc = null) {
        const controls = AnnotationAdapter.ensureOverviewOcrControls(doc);
        if (!controls?.result) return;
        const marker = AnnotationAdapter.clinicalMarkerFromImage(image);
        if (marker) {
            AnnotationAdapter.renderOcrClinicalMarker(controls.result, marker);
            AnnotationAdapter.paintSelectedRowEpitope(image, marker, doc);
            return marker;
        }
        // Server-side OCR (ops/retro_build_metadata.py) already scanned this slide's
        // label and found nothing -- don't pay for a multi-second full-resolution
        // Tesseract sweep on every single slide open, only to reconfirm the same
        // dead end. This runs synchronously with the viewer opening, so it was a
        // major (and entirely avoidable) contributor to "the low power view loads
        // slowly" on freshly-ingested slides that simply have no readable label text.
        if (image?.ocrAttempted === true) {
            AnnotationAdapter.clearSidecarText(controls.result);
            return "";
        }
        void AnnotationAdapter.ocrSelectedImageIfMissing(image, controls.result, doc);
        return "";
    }

    static paintSelectedRowEpitope(image, marker, doc = null) {
        const root = doc || (typeof document !== "undefined" ? document : null);
        const imageId = String(image?.id || "").trim();
        if (!root || !imageId || typeof root.querySelector !== "function") return;
        const button = root.querySelector(`.image-button[data-image-id="${imageId}"]`);
        if (!button) return;
        const node = AnnotationAdapter.ensureSidebarOcrResultNode(button, root);
        if (marker) AnnotationAdapter.renderOcrClinicalMarker(node, marker);
        else AnnotationAdapter.clearSidecarText(node);
    }

    /**
     * Sidecar files are often {@code if.Pending}. Previous viewers ran Tesseract
     * on the selected label at image selection; restore that for the chosen slide
     * only (not the whole catalog).
     */
    static async ocrSelectedImageIfMissing(image, overviewNode, doc = null) {
        const cacheKey = AnnotationAdapter.sidebarOcrCacheKey(image);
        const cached = AnnotationAdapter.hasOcrSessionCacheEntry(cacheKey)
            ? AnnotationAdapter.extractIfEpitopeMarker(AnnotationAdapter.readOcrSessionCache(cacheKey) || "")
            : "";
        if (cached) {
            AnnotationAdapter.renderOcrClinicalMarker(overviewNode, cached);
            AnnotationAdapter.paintSelectedRowEpitope(image, cached, doc);
            return cached;
        }
        if (overviewNode) AnnotationAdapter.beginOcrPendingDisplay(overviewNode);
        try {
            const source = AnnotationAdapter.slideLabelFullResUrl(image?.id);
            const angle = AnnotationAdapter.getSlideLabelRotation(image?.id);
            const result = await AnnotationAdapter.recognizeLabelImageSweep(source, {
                angles: [angle]
            });
            const raw = result?.engineRaw || result?.rawText || result?.text || "";
            const marker = AnnotationAdapter.extractIfEpitopeMarker(result?.marker || raw);
            AnnotationAdapter.writeOcrSessionCache(cacheKey, marker);
            if (marker) AnnotationAdapter.renderOcrClinicalMarker(overviewNode, marker);
            else AnnotationAdapter.renderOcrRawDebug(overviewNode, raw);
            AnnotationAdapter.paintSelectedRowEpitope(image, marker, doc);
            return marker;
        } catch (error) {
            if (overviewNode) {
                AnnotationAdapter.renderOcrRawDebug(overviewNode, String(error?.message || error || ""));
            }
            return "";
        }
    }

    /**
     * Multi-plane Z stack: world item index == focal plane index.
     * Active plane opacity 1; all others opacity 0 with preload so tiles stay warm.
     */
    static zStackPlaneCount = 0;
    static zStackActiveIndex = 0;

    static FLUORESCENT_CHANNEL_NAMES = ["DAPI", "FITC", "TRITC"];
    static BASELINE_PYRAMID_LEVEL = 4;

    static fluorescentChannelAssets(options = {}) {
        const names = AnnotationAdapter.FLUORESCENT_CHANNEL_NAMES;
        const count = Math.max(1, Math.min(
            names.length,
            Math.floor(Number(options.channelCount) || names.length)
        ));
        return names.slice(0, count).map((name, index) => ({ name, index }));
    }

    static decorateOpenSeadragonOptions(options = {}) {
        return {
            immediateRender: true,
            placeholderFillStyle: "#111821",
            animationTime: 0,
            blendTime: 0,
            maxImageCacheCount: 4000,
            ...options,
            immediateRender: true,
            placeholderFillStyle: options.placeholderFillStyle || "#111821"
        };
    }

    static taggedZIndex(item) {
        const fromOptions = item?.options?.zIndexProperty ?? item?.options?.zIndices;
        if (fromOptions != null && fromOptions !== "") {
            const tagged = Number(fromOptions);
            return Number.isFinite(tagged) ? tagged : null;
        }
        const fromSource = item?.source?.zIndexProperty ?? item?.source?.zIndices;
        if (fromSource == null || fromSource === "") return null;
        const tagged = Number(fromSource);
        if (!Number.isFinite(tagged)) return null;
        if (item.options && typeof item.options === "object") {
            item.options.zIndexProperty = tagged;
        }
        return tagged;
    }

    static applyZStackLayerOpacities(viewer, activeZ, options = {}) {
        if (!viewer?.world || typeof viewer.world.getItemCount !== "function") return 0;
        const count = viewer.world.getItemCount();
        const targetZIndex = Math.max(0, Number(activeZ) || 0);
        AnnotationAdapter.zStackActiveIndex = targetZIndex;
        const state = options && typeof options === "object"
            ? options
            : AnnotationAdapter.channelLayerState;
        const visibility = state?.visibility || AnnotationAdapter.channelLayerState?.visibility;
        const opacities = state?.opacity || AnnotationAdapter.channelLayerState?.opacity;
        let taggedCount = 0;
        for (let index = 0; index < count; index += 1) {
            const item = viewer.world.getItemAt(index);
            if (AnnotationAdapter.taggedZIndex(item) != null) taggedCount += 1;
        }
        for (let index = 0; index < count; index += 1) {
            const item = viewer.world.getItemAt(index);
            if (!item || typeof item.setOpacity !== "function") continue;
            const tagged = AnnotationAdapter.taggedZIndex(item);
            const isActivePlane = taggedCount > 0 && tagged != null
                ? tagged === targetZIndex
                : index === targetZIndex;
            const channelOn = AnnotationAdapter.channelLayerIsVisible(item, visibility);
            const layerOpacity = AnnotationAdapter.channelLayerOpacity(item, opacities);
            if (typeof item.setPreload === "function") {
                item.setPreload(channelOn);
            }
            item.setOpacity(isActivePlane && channelOn ? layerOpacity : 0);
        }
        if (typeof viewer.forceRedraw === "function") viewer.forceRedraw();
        return count;
    }

    static channelLayerState = { visibility: null, opacity: null };

    static rememberChannelLayerState(channels) {
        const list = Array.isArray(channels) ? channels : [];
        if (!list.length) {
            AnnotationAdapter.channelLayerState = { visibility: null, opacity: null };
            return AnnotationAdapter.channelLayerState;
        }
        const visibility = {};
        const opacity = {};
        for (const channel of list) {
            if (!channel || typeof channel !== "object") continue;
            const visible = channel.visible !== false;
            const amount = Number(channel.opacity);
            const layerOpacity = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 1;
            if (channel.index != null && channel.index !== "") {
                visibility[channel.index] = visible;
                opacity[channel.index] = layerOpacity;
            }
            const name = String(channel.name || "").trim();
            if (name) {
                visibility[name] = visible;
                opacity[name] = layerOpacity;
            }
        }
        AnnotationAdapter.channelLayerState = { visibility, opacity };
        return AnnotationAdapter.channelLayerState;
    }

    static taggedChannelIndex(item) {
        const fromOptions = item?.options?.channelIndex;
        if (fromOptions != null && fromOptions !== "") {
            const tagged = Number(fromOptions);
            return Number.isFinite(tagged) ? tagged : null;
        }
        const fromSource = item?.source?.channelIndex;
        if (fromSource == null || fromSource === "") return null;
        const tagged = Number(fromSource);
        if (!Number.isFinite(tagged)) return null;
        if (item.options && typeof item.options === "object") {
            item.options.channelIndex = tagged;
        }
        return tagged;
    }

    static taggedChannelName(item) {
        const fromOptions = item?.options?.channelName;
        if (fromOptions != null && String(fromOptions).trim()) return String(fromOptions).trim();
        const fromSource = item?.source?.channelName;
        return fromSource != null && String(fromSource).trim() ? String(fromSource).trim() : "";
    }

    static channelLayerIsVisible(item, visibility) {
        if (!visibility || typeof visibility !== "object") return true;
        const index = AnnotationAdapter.taggedChannelIndex(item);
        if (index != null && Object.prototype.hasOwnProperty.call(visibility, index)) {
            return visibility[index] !== false;
        }
        const name = AnnotationAdapter.taggedChannelName(item);
        if (name && Object.prototype.hasOwnProperty.call(visibility, name)) {
            return visibility[name] !== false;
        }
        return true;
    }

    static channelLayerOpacity(item, opacities) {
        if (!opacities || typeof opacities !== "object") return 1;
        const index = AnnotationAdapter.taggedChannelIndex(item);
        if (index != null && Object.prototype.hasOwnProperty.call(opacities, index)) {
            const amount = Number(opacities[index]);
            return Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 1;
        }
        const name = AnnotationAdapter.taggedChannelName(item);
        if (name && Object.prototype.hasOwnProperty.call(opacities, name)) {
            const amount = Number(opacities[name]);
            return Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 1;
        }
        return 1;
    }

    static applyChannelLayerOpacities(viewer, channels, activeZ) {
        AnnotationAdapter.rememberChannelLayerState(channels);
        return AnnotationAdapter.applyZStackLayerOpacities(
            viewer,
            activeZ ?? AnnotationAdapter.zStackActiveIndex ?? AnnotationAdapter.currentZ
        );
    }

    static changeFocalDepth(viewer, z) {
        const next = AnnotationAdapter.setCurrentZ(z);
        return AnnotationAdapter.applyZStackLayerOpacities(viewer, next);
    }

    static buildZStackLayerSpecs(options = {}) {
        const build = options.tileSourceForPlane;
        const planeCount = Math.max(1, Math.floor(Number(options.planeCount) || 1));
        const activeZ = Math.max(
            0,
            Math.min(planeCount - 1, Math.floor(Number(options.activeZ) || 0))
        );
        const rawChannels = Array.isArray(options.channels) ? options.channels : null;
        const channels = rawChannels && rawChannels.length
            ? rawChannels.map((channel, index) => (
                typeof channel === "string" ? { name: channel, index } : channel
            ))
            : null;
        const specs = [];
        const blend = options.compositeOperation
            ?? (channels ? "lighter" : null);
        const pushSpec = (z, channel, tileSource) => {
            const channelIndex = Number(channel?.index);
            const visible = channel?.visible !== false;
            const amount = Number(channel?.opacity);
            const layerOpacity = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 1;
            if (tileSource && typeof tileSource === "object") {
                tileSource.zIndexProperty = z;
                tileSource.zIndices = z;
                if (Number.isFinite(channelIndex)) tileSource.channelIndex = channelIndex;
                tileSource.channelName = channel?.name || "composite";
            }
            const spec = {
                tileSource,
                opacity: z === activeZ && visible ? layerOpacity : 0,
                preload: visible,
                x: 0,
                y: 0,
                width: 1,
                showInNavigator: specs.length === 0,
                zIndexProperty: z,
                zIndices: z,
                channelIndex: Number.isFinite(channelIndex) ? channelIndex : undefined,
                channelName: channel?.name || "composite"
            };
            if (blend) spec.compositeOperation = blend;
            specs.push(spec);
        };
        if (typeof build !== "function") return specs;
        if (channels) {
            for (let z = 0; z < planeCount; z += 1) {
                for (const channel of channels) {
                    pushSpec(z, channel, build(z, channel));
                }
            }
        } else {
            for (let z = 0; z < planeCount; z += 1) {
                pushSpec(z, { name: "composite" }, build(z));
            }
        }
        return specs;
    }

    static applyBaselinePyramidZoom(viewer, options = {}) {
        if (options.preserveViewport) return false;
        return AnnotationAdapter.centerHomeAfterTileSourceReady(viewer, options);
    }

    static tileSourceDimensionsReady(viewer, metadata = null) {
        const meta = metadata || AnnotationAdapter.imageMetadata;
        const item = viewer?.world && typeof viewer.world.getItemCount === "function"
            ? viewer.world.getItemAt(0)
            : null;
        const source = item?.source;
        const width = Number(source?.width ?? meta?.width);
        const height = Number(source?.height ?? meta?.height);
        if (!(width > 1 && height > 1)) return false;
        if (meta?.series != null && source?.series != null
            && Number(meta.series) !== Number(source.series)) {
            return false;
        }
        return Boolean(viewer?.viewport && typeof viewer.viewport.goHome === "function");
    }

    /** Primary active tile-stack layer. OSD multi-image worlds must not use Viewport converters. */
    static primaryTiledImage(viewer) {
        const host = viewer || AnnotationAdapter.viewer;
        if (!host?.world || typeof host.world.getItemAt !== "function") return null;
        try {
            if (typeof host.world.getItemCount === "function" && host.world.getItemCount() < 1) {
                return null;
            }
            return host.world.getItemAt(0) || null;
        } catch (_error) {
            return null;
        }
    }

    static centerHomeAfterTileSourceReady(viewer, options = {}) {
        if (!viewer?.viewport) return false;
        if (options.preserveViewport) return false;
        const metadata = options.metadata || AnnotationAdapter.imageMetadata;
        const goHomeNow = () => {
            if (!AnnotationAdapter.tileSourceDimensionsReady(viewer, metadata)) return false;
            try {
                viewer.viewport.goHome(true);
            } catch (_error) {
                return false;
            }
            return true;
        };
        if (goHomeNow()) {
            return true;
        }
        if (typeof viewer.addHandler !== "function") return false;
        const onReady = () => {
            if (!goHomeNow()) return;
            if (typeof viewer.removeHandler === "function") {
                try { viewer.removeHandler("tile-loaded", onReady); } catch (_error) { /* ignore */ }
            }
        };
        viewer.addHandler("tile-loaded", onReady);
        return false;
    }

    static bindViewportHomeOnOpen(viewer) {
        if (!viewer || typeof viewer.addHandler !== "function" || viewer._wsiHomeOnOpenBound) {
            return false;
        }
        viewer.addHandler("open", () => {
            const pending = AnnotationAdapter.pendingOpenViewport || {};
            AnnotationAdapter.pendingOpenViewport = null;
            if (pending.preserveViewport) return;
            // OSD Viewer.open already calls goHome before raising "open".
            // A second goHome here resets coverage while the 27-layer stack is
            // still fetching tiles ("Ignoring tile loaded before reset").
        });
        viewer._wsiHomeOnOpenBound = true;
        return true;
    }

    /**
     * Open every Z plane in one stamped world list. Depth changes later only
     * flip opacities — never reopen the viewer.
     */
    static openMultiPlaneZStack(viewer, options = {}) {
        if (!viewer || typeof viewer.open !== "function") return false;
        const build = options.tileSourceForPlane;
        if (typeof build !== "function") return false;
        const planeCount = Math.max(1, Math.floor(Number(options.planeCount) || 1));
        const activeZ = Math.max(
            0,
            Math.min(planeCount - 1, Math.floor(Number(options.activeZ) || 0))
        );
        AnnotationAdapter.zStackPlaneCount = planeCount;
        AnnotationAdapter.zStackActiveIndex = activeZ;
        AnnotationAdapter.setCurrentZ(activeZ);
        AnnotationAdapter.rememberChannelLayerState(options.channels || []);

        const stamped = AnnotationAdapter.buildZStackLayerSpecs({
            planeCount,
            activeZ,
            tileSourceForPlane: build,
            channels: options.channels,
            compositeOperation: options.compositeOperation
        });
        AnnotationAdapter.pendingOpenViewport = {
            preserveViewport: Boolean(options.preserveViewport),
            metadata: options.metadata || AnnotationAdapter.imageMetadata
        };
        AnnotationAdapter.bindViewportHomeOnOpen(viewer);
        viewer.open(stamped);

        viewer.addOnceHandler("open", () => {
            const preserved = options.preserveViewport;
            if (preserved?.bounds && viewer.viewport) {
                try {
                    viewer.viewport.fitBounds(preserved.bounds, true);
                    if (preserved.zoom != null) {
                        viewer.viewport.zoomTo(preserved.zoom, null, true);
                    }
                } catch (_error) {
                    // Ignore restore races during image switch.
                }
            }
            AnnotationAdapter.applyZStackLayerOpacities(viewer, activeZ);
            AnnotationAdapter.bindZTilePrefetch(viewer, options);
            if (typeof options.onReady === "function") options.onReady(viewer);
        });
        return true;
    }

    static resolveZStackDeltaHooks(hooks = {}) {
        const resolveMaxZ = () => Math.max(0, Number(
            typeof hooks.getMaxZ === "function" ? hooks.getMaxZ() : 0
        ) || 0);
        const resolveCurrentZ = () => Math.max(0, Number(
            typeof hooks.getZ === "function"
                ? hooks.getZ()
                : AnnotationAdapter.currentZ
        ) || 0);
        const applyDelta = delta => {
            const maxZ = resolveMaxZ();
            if (maxZ < 1 || !delta) return false;
            if (AnnotationAdapter.isMeasurementModeActive) return false;
            const current = resolveCurrentZ();
            const next = Math.max(0, Math.min(maxZ, current + delta));
            if (next === current) return false;
            if (typeof hooks.onZChange === "function") hooks.onZChange(next);
            else AnnotationAdapter.changeFocalDepth(hooks.viewer || AnnotationAdapter.viewer, next);
            return true;
        };
        return { resolveMaxZ, resolveCurrentZ, applyDelta };
    }

    static handleZStackWheel(event, hooks = {}) {
        if (!event?.altKey) return false;
        const { resolveMaxZ, applyDelta } = AnnotationAdapter.resolveZStackDeltaHooks(hooks);
        if (resolveMaxZ() < 1) return false;
        if (AnnotationAdapter.isMeasurementModeActive) return false;
        if (typeof event.preventDefault === "function") event.preventDefault();
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        const deltaY = Number(event.deltaY);
        const delta = Number.isFinite(deltaY) && deltaY !== 0
            ? (deltaY > 0 ? 1 : -1)
            : 0;
        return applyDelta(delta);
    }

    static onZScroll(event, hooks = {}) {
        return AnnotationAdapter.handleZStackWheel(event, hooks);
    }

    static handleZStackKeyDown(event, hooks = {}) {
        if (!event || event.altKey || event.metaKey || event.ctrlKey) return false;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
        const target = event.target;
        if (target && (
            target.tagName === "INPUT"
            || target.tagName === "TEXTAREA"
            || target.tagName === "SELECT"
            || target.isContentEditable
        )) return false;
        const { resolveMaxZ, applyDelta } = AnnotationAdapter.resolveZStackDeltaHooks(hooks);
        if (resolveMaxZ() < 1) return false;
        if (AnnotationAdapter.isMeasurementModeActive) return false;
        if (typeof event.preventDefault === "function") event.preventDefault();
        return applyDelta(event.key === "ArrowUp" ? -1 : 1);
    }

    /**
     * Focal depth via Alt+wheel or ArrowUp/ArrowDown only.
     * Native OSD scroll-zoom stays free (no canvas-scroll interceptor).
     */
    static bindZStackWheel(viewer, hooks = {}) {
        if (!viewer || viewer._wsiZStackFocalBound) return false;
        if (viewer.gestureSettingsMouse) {
            viewer.gestureSettingsMouse.scrollToZoom = true;
        }
        const boundHooks = { ...hooks, viewer };
        const onWheel = event => AnnotationAdapter.handleZStackWheel(event, boundHooks);
        const onKeyDown = event => AnnotationAdapter.handleZStackKeyDown(event, boundHooks);
        if (viewer.element && typeof viewer.element.addEventListener === "function") {
            viewer.element.addEventListener("wheel", onWheel, { capture: true, passive: false });
        }
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            window.addEventListener("keydown", onKeyDown);
            viewer._wsiZStackKeyHandler = onKeyDown;
        }
        viewer._wsiZStackFocalBound = true;
        return true;
    }

    /** Quiet adjacent-Z tile buffer — fills browser cache ahead of focal scroll. */
    static zTilePrefetchUrls = typeof Set !== "undefined" ? new Set() : null;
    static zTilePrefetchQueue = [];
    static zTilePrefetchInFlight = 0;
    static zTilePrefetchImageId = null;
    static zTilePrefetchTimer = null;
    static Z_TILE_PREFETCH_PAUSE_MS = 120;
    static Z_TILE_PREFETCH_CONCURRENCY = 4;

    static resetZTilePrefetchCache(imageId = null) {
        if (AnnotationAdapter.zTilePrefetchTimer != null) {
            clearTimeout(AnnotationAdapter.zTilePrefetchTimer);
            AnnotationAdapter.zTilePrefetchTimer = null;
        }
        if (AnnotationAdapter.zTilePrefetchUrls?.clear) {
            AnnotationAdapter.zTilePrefetchUrls.clear();
        }
        AnnotationAdapter.zTilePrefetchQueue = [];
        AnnotationAdapter.zTilePrefetchInFlight = 0;
        AnnotationAdapter.zTilePrefetchImageId = imageId || null;
    }

    static neighborZTileUrl(url, neighborZ) {
        const source = String(url || "");
        if (!source) return "";
        if (/[?&]z=/.test(source)) return source.replace(/([?&]z=)[^&]*/i, `$1${neighborZ}`);
        return `${source}${source.includes("?") ? "&" : "?"}z=${neighborZ}`;
    }

    static zIndexFromTileUrl(url) {
        const match = String(url || "").match(/[?&]z=([^&]*)/i);
        if (!match) return null;
        const z = Number(match[1]);
        return Number.isFinite(z) ? z : null;
    }

    static drainZTilePrefetchQueue() {
        const max = AnnotationAdapter.Z_TILE_PREFETCH_CONCURRENCY;
        while (
            AnnotationAdapter.zTilePrefetchInFlight < max
            && AnnotationAdapter.zTilePrefetchQueue.length
        ) {
            const url = AnnotationAdapter.zTilePrefetchQueue.shift();
            if (!url) continue;
            AnnotationAdapter.zTilePrefetchInFlight += 1;
            const finish = () => {
                AnnotationAdapter.zTilePrefetchInFlight = Math.max(
                    0,
                    AnnotationAdapter.zTilePrefetchInFlight - 1
                );
                AnnotationAdapter.drainZTilePrefetchQueue();
            };
            try {
                if (typeof Image !== "undefined") {
                    const img = new Image();
                    img.decoding = "async";
                    img.onload = finish;
                    img.onerror = finish;
                    img.src = url;
                } else if (typeof fetch === "function") {
                    void fetch(url, { credentials: "same-origin", cache: "force-cache" })
                        .catch(() => {})
                        .finally(finish);
                } else {
                    finish();
                }
            } catch (_error) {
                finish();
            }
        }
    }

    static prefetchTileUrl(url) {
        const href = String(url || "");
        if (!href) return false;
        if (AnnotationAdapter.zTilePrefetchUrls?.has?.(href)) return false;
        AnnotationAdapter.zTilePrefetchUrls?.add?.(href);
        AnnotationAdapter.zTilePrefetchQueue.push(href);
        AnnotationAdapter.drainZTilePrefetchQueue();
        return true;
    }

    static prefetchAdjacentZPlaneTiles(options = {}) {
        const z = Math.max(0, Number(options.z ?? AnnotationAdapter.currentZ) || 0);
        const maxZ = Math.max(
            0,
            Number(options.maxZ ?? (AnnotationAdapter.zStackPlaneCount - 1)) || 0
        );
        const url = options.url
            || options.tile?.getUrl?.()
            || options.tile?.url
            || "";
        let queued = 0;
        if (url) {
            for (const neighbor of [z - 1, z + 1]) {
                if (neighbor < 0 || neighbor > maxZ) continue;
                if (AnnotationAdapter.prefetchTileUrl(
                    AnnotationAdapter.neighborZTileUrl(url, neighbor)
                )) queued += 1;
            }
        }
        return queued;
    }

    static bindZTilePrefetch(viewer, options = {}) {
        if (!viewer || viewer._wsiZTilePrefetchBound) return false;
        if (typeof viewer.addHandler !== "function") return false;
        viewer.addHandler("tile-loaded", event => {
            try {
                const url = event?.tile?.getUrl?.() || event?.tile?.url || "";
                const tileZ = AnnotationAdapter.zIndexFromTileUrl(url);
                AnnotationAdapter.prefetchAdjacentZPlaneTiles({
                    viewer,
                    url,
                    z: tileZ ?? AnnotationAdapter.currentZ,
                    maxZ: Math.max(0, (options.planeCount || AnnotationAdapter.zStackPlaneCount) - 1)
                });
            } catch (_error) {
                // Never block tile drawing on prefetch faults.
            }
        });
        viewer._wsiZTilePrefetchBound = true;
        return true;
    }

    static schedulePrefetchAdjacentZPlaneTiles(options = {}, delayMs = null) {
        const wait = delayMs == null
            ? AnnotationAdapter.Z_TILE_PREFETCH_PAUSE_MS
            : Math.max(0, Number(delayMs) || 0);
        if (AnnotationAdapter.zTilePrefetchTimer != null) {
            clearTimeout(AnnotationAdapter.zTilePrefetchTimer);
        }
        AnnotationAdapter.zTilePrefetchTimer = setTimeout(() => {
            AnnotationAdapter.zTilePrefetchTimer = null;
            try {
                AnnotationAdapter.prefetchAdjacentZPlaneTiles(options);
            } catch (_error) {
                // Never block UI on prefetch faults.
            }
        }, wait);
        return AnnotationAdapter.zTilePrefetchTimer;
    }



    /**
     * Toggle left-column slide-label thumbnails on/off.
     * @returns {boolean} enabled state after the change
     */
    static setSlideLabelThumbsEnabled(enabled, root = null) {
        AnnotationAdapter.slideLabelThumbsEnabled = Boolean(enabled);
        const scope = root
            || (typeof document !== "undefined" ? document.getElementById("image-list") : null);
        if (AnnotationAdapter.slideLabelThumbsEnabled) {
            AnnotationAdapter.loadSlideLabelThumbs(scope);
            AnnotationAdapter.applyCatalogClinicalMarkers(scope, []);
        } else {
            AnnotationAdapter.clearSlideLabelThumbs(scope);
            // Keep clinical marker text; only hide thumbs.
        }
        return AnnotationAdapter.slideLabelThumbsEnabled;
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
            const images = typeof options.getImages === "function"
                ? options.getImages()
                : options.images;
            if (options.imageListRoot && Array.isArray(images)) {
                AnnotationAdapter.renderImageBrowser(
                    options.imageListRoot,
                    images,
                    selectElement.value,
                    {
                        document: options.document || (typeof document !== "undefined" ? document : null),
                        onSelect: options.onSelect,
                        escapeHtml: options.escapeHtml,
                        storagePrefix: options.storagePrefix
                    }
                );
            } else {
                AnnotationAdapter.applyCaseFilterToSlideButtons(
                    selectElement.value,
                    options.imageListRoot || null
                );
            }
            if (typeof options.onAfterFilter === "function") {
                options.onAfterFilter(selectElement.value);
            }
        };
        selectElement.addEventListener("change", handler);
        return handler;
    }

    /**
     * Apply Case ID + slide/stain lines to the large header typography block.
     */
    static applyHeaderIdentity(doc, image) {
        const root = doc || (typeof document !== "undefined" ? document : null);
        if (!root || typeof root.getElementById !== "function") return;
        const identity = AnnotationAdapter.buildHeaderIdentity(image);
        const caseEl = root.getElementById("header-case-id");
        const detailEl = root.getElementById("header-slide-detail");
        const selectedName = root.getElementById("selected-name");
        const currentName = root.getElementById("current-image-name");
        if (caseEl) caseEl.textContent = identity.caseId || "";
        if (detailEl) detailEl.textContent = identity.slideDetail || "";
        if (selectedName) {
            selectedName.textContent = identity.caseId
                ? `${identity.caseId}${identity.slideDetail ? " · " + identity.slideDetail : ""}`
                : (image?.name || "No image selected");
        }
        const hasIdentity = Boolean(identity.caseId || identity.slideDetail || image?.name);
        if (currentName) {
            currentName.hidden = !hasIdentity;
            if (!identity.caseId && !identity.slideDetail && image?.name) {
                if (caseEl) caseEl.textContent = image.name;
                if (detailEl) detailEl.textContent = "";
            }
        }
        const legacyBlock = root.getElementById("brand-case-block");
        if (legacyBlock) legacyBlock.hidden = !hasIdentity;
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
        const aiPanel = root.getElementById("ai-analytics-panel");
        if (aiPanel) aiPanel.hidden = false;
        const aiLabs = root.getElementById("ai-labs-panel");
        if (aiLabs) aiLabs.hidden = false;
        AnnotationAdapter.enforceDefaultClosedPanelState(root);
    }

    static collapseAiLabsPanel(doc = null) {
        const root = doc || (typeof document !== "undefined" ? document : null);
        if (!root || typeof root.getElementById !== "function") return false;
        AnnotationAdapter.closeFloatingAiLabsPalette(root);
        const aiAnalytics = root.getElementById("ai-analytics-panel")
            || AnnotationAdapter.aiLabsPaletteElement?.querySelector?.("#ai-analytics-panel");
        const aiLabs = root.getElementById("ai-labs-panel")
            || AnnotationAdapter.aiLabsPaletteElement?.querySelector?.("#ai-labs-panel");
        if (!aiAnalytics && !aiLabs) return false;
        if (aiAnalytics) {
            aiAnalytics.open = false;
            if (typeof aiAnalytics.removeAttribute === "function") {
                aiAnalytics.removeAttribute("open");
            }
            aiAnalytics.classList?.remove?.("show");
        }
        if (aiLabs) aiLabs.classList.remove("show");
        return true;
    }

    static enforceDefaultClosedPanelState(doc = null) {
        return AnnotationAdapter.collapseAiLabsPanel(doc);
    }

    /**
     * Mandatory tear-down when the left-column image browser selects a new slide.
     * Hides leftover floating controllers, clears measurement rows, and resets
     * brightness/contrast so the next image's channel matrix can bind cleanly.
     */
    static resetImageControllerState(root = null) {
        const document = root && typeof root.querySelector === "function"
            ? root
            : (typeof globalThis !== "undefined" && globalThis.document) || root;
        if (!document) return false;

        // 1. Hide/Destroy active floating panels from the previous slide view context
        let controllersToHide = ['#floating-channel-palette', '#floating-ai-labs-palette', '#floating-zstack-palette', '#floating-measurement-palette'];
        controllersToHide.forEach(selector => {
            let el = document.querySelector(selector)
                || document.getElementById?.(String(selector).replace(/^#/, ""));
            if (el) el.style.display = 'none';
        });

        // 2. Clear out measurement arrays and table listings
        let measurementBody = document.getElementById('measurement-results-body');
        if (measurementBody) measurementBody.innerHTML = '';
        let savedMeasurementsArray = AnnotationAdapter.measurementSessionList;
        if (typeof savedMeasurementsArray !== 'undefined') savedMeasurementsArray = [];
        AnnotationAdapter.measurementSessionList = [];
        AnnotationAdapter.clearMeasurementResultsTable(document);

        // 3. Reset image adjustments back to clean factory default profiles
        function resetBrightnessContrastSettings() {
            AnnotationAdapter.resetBrightnessContrastSettings(document);
        }
        if (typeof resetBrightnessContrastSettings === 'function') {
            resetBrightnessContrastSettings(); // Forces channel multipliers, min/max limits, and gammas back to default layers
        }
        return true;
    }

    /**
     * Factory-default B&C sliders, histogram, and channel window fields so a
     * newly selected 3-channel fluorescence or brightfield RGB matrix can
     * rebuild checkboxes and sliders from its own metadata.
     */
    static resetBrightnessContrastSettings(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        AnnotationAdapter.channelPaletteSelectedIndex = 0;
        AnnotationAdapter.channelPaletteHistogram = null;
        AnnotationAdapter.clearViewportTileContrastFilter(
            AnnotationAdapter.displayController?.getViewer?.() || AnnotationAdapter.viewer
        );
        const rows = doc?.getElementById?.("floating-channel-palette-rows");
        if (rows && typeof rows.replaceChildren === "function") rows.replaceChildren();
        else if (rows) rows.innerHTML = "";
        const scaleMax = AnnotationAdapter.channelLevelScale();
        const min = doc?.getElementById?.("fcp-min");
        const max = doc?.getElementById?.("fcp-max");
        const gamma = doc?.getElementById?.("fcp-gamma");
        if (min) {
            min.max = String(scaleMax);
            min.value = "0";
        }
        if (max) {
            max.max = String(scaleMax);
            max.value = String(scaleMax);
        }
        if (gamma) gamma.value = "1.00";
        const minOut = doc?.getElementById?.("fcp-min-value");
        const maxOut = doc?.getElementById?.("fcp-max-value");
        const gammaOut = doc?.getElementById?.("fcp-gamma-value");
        const scaleMinLabel = doc?.getElementById?.("fcp-scale-min");
        const scaleMaxLabel = doc?.getElementById?.("fcp-scale-max");
        if (minOut) minOut.textContent = "0";
        if (maxOut) maxOut.textContent = AnnotationAdapter.formatChannelLevel(scaleMax);
        if (gammaOut) gammaOut.textContent = "1.00";
        if (scaleMinLabel) scaleMinLabel.textContent = "0";
        if (scaleMaxLabel) scaleMaxLabel.textContent = AnnotationAdapter.formatChannelLevel(scaleMax);
        return true;
    }

    /**
     * Single authority for the `savedAnnotationsArray` mirrors kept on the class,
     * `window`, and `globalThis`. Always go through this instead of assigning the
     * three copies by hand, so they can never drift out of sync.
     */
    static setSavedAnnotations(list) {
        const next = Array.isArray(list) ? list : [];
        AnnotationAdapter.savedAnnotationsArray = next;
        if (typeof window !== "undefined") window.savedAnnotationsArray = next;
        if (typeof globalThis !== "undefined") globalThis.savedAnnotationsArray = next;
        return next;
    }

    static onSlideClicked(image, doc = null) {
        const viewer = AnnotationAdapter.viewer
            || (typeof globalThis !== "undefined" ? globalThis.viewer : undefined);
        if (viewer) {
            if (typeof viewer.clearOverlays === "function") {
                viewer.clearOverlays(); // Sweeps all custom OpenSeadragon SVG overlay nodes clean
            }
        }
        AnnotationAdapter.setSavedAnnotations([]);
        let measurementBody = (doc && typeof doc.getElementById === "function" ? doc : null)
            ?.getElementById?.("measurement-results-body")
            || (typeof document !== "undefined" ? document.getElementById("measurement-results-body") : null);
        if (measurementBody) measurementBody.innerHTML = "";
        AnnotationAdapter.purgeAlternativeAnnotationLayers();
        const root = doc || (typeof document !== "undefined" ? document : null);
        AnnotationAdapter.resetImageControllerState(root);
        // Force reset and hide the floating Z-stack controller before evaluating the next image properties
        let zStackPalette = root?.getElementById?.("floating-zstack-palette")
            || (typeof document !== "undefined" ? document.getElementById("floating-zstack-palette") : null);
        if (zStackPalette) {
            zStackPalette.classList?.remove?.("zstack-minimized");
            zStackPalette.style.display = "none";
            zStackPalette.style.maxHeight = "none";
        }
        if (!root || typeof root.getElementById !== "function") return false;
        AnnotationAdapter.enforceDefaultClosedPanelState(root);
        const multilayer = AnnotationAdapter.isMultiLayerSlide(image);
        const card = root.getElementById("z-controls-card");
        const zDepth = root.getElementById("z-depth-controls");
        const aiAnalytics = root.getElementById("ai-analytics-panel");
        const aiLabs = root.getElementById("ai-labs-panel");
        const stack = root.querySelector?.(".right-stack-controls");
        if (!multilayer) {
            if (card) {
                card.hidden = true;
                if (card.style) card.style.display = "none";
            }
            if (zDepth) zDepth.hidden = true;
            if (stack) stack.hidden = true;
            AnnotationAdapter.setFloatingZStackPaletteVisible(false, root);
            return false;
        }
        if (card) {
            card.hidden = false;
            if (card.style) card.style.display = "block";
        }
        if (zDepth) zDepth.hidden = false;
        if (aiAnalytics) {
            aiAnalytics.hidden = false;
            aiAnalytics.open = false;
        }
        if (aiLabs) {
            aiLabs.hidden = false;
            aiLabs.classList.remove("show");
        }
        if (stack) stack.hidden = false;
        AnnotationAdapter.setFloatingZStackPaletteVisible(true, root);
        return true;
    }

    static purgeAlternativeAnnotationLayers() {
        try { AnnotationAdapter.cancelQuPathDrawSession(); } catch (_error) { /* ignore */ }
        const trackers = Array.isArray(AnnotationAdapter.qpShapeTrackers)
            ? AnnotationAdapter.qpShapeTrackers
            : [];
        trackers.forEach(tracker => {
            try { tracker.destroy?.(); } catch (_error) { /* ignore */ }
        });
        AnnotationAdapter.qpShapeTrackers = [];
        const svg = AnnotationAdapter.qpDrawOverlayEl
            || (typeof AnnotationAdapter.viewer?.svgOverlay === "function"
                ? AnnotationAdapter.viewer.svgOverlay()?.node?.()
                : null);
        if (svg) {
            const committed = svg.querySelector?.("[data-qp-committed]");
            const preview = svg.querySelector?.("[data-qp-preview]");
            if (committed) committed.innerHTML = "";
            if (preview) preview.innerHTML = "";
        }
        const labels = typeof document !== "undefined"
            ? document.querySelectorAll?.(".osd-annotation-shape, .annotation-shape-overlay, .annotation-text-label, .annotation-marker-node")
            : [];
        labels?.forEach?.(node => {
            if (node?.closest?.("[data-qp-committed], [data-qp-preview]")) return;
            node.remove?.();
        });
        const committedShapes = typeof document !== "undefined"
            ? document.querySelectorAll?.("[data-qp-committed] .osd-annotation-shape")
            : [];
        committedShapes?.forEach?.(node => node.remove?.());
        try {
            (AnnotationAdapter.annotationEngine || AnnotationAdapter.annotationSpike)?.labelLayer?.clear?.();
        } catch (_error) { /* ignore */ }
        try { AnnotationAdapter.hideAnnotationEditorPopup(null, { commit: false }); } catch (_error) { /* ignore */ }
        return true;
    }

    static selectSlideCase(image, doc = null) {
        return AnnotationAdapter.onSlideClicked(image, doc);
    }

    static loadSlide(image, doc = null) {
        return AnnotationAdapter.onSlideClicked(image, doc);
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
        placeholder.textContent = AnnotationAdapter.CASE_FILTER_PLACEHOLDER_LABEL;
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
     * Prefer {@link renderImageBrowser} for Rule A/B layout switches.
     */
    static applyCaseFilterToSlideButtons(selectedCase, root = null) {
        const needle = String(selectedCase ?? "").trim();
        const hideAll = !needle
            || needle === AnnotationAdapter.CASE_FILTER_PLACEHOLDER_VALUE
            || /^--\s*select (slides|a patient case)\s*--$/i.test(needle);
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

    /**
     * Case-filter layout mode for the left image browser.
     * @returns {"placeholder"|"all"|"case"}
     */
    static resolveCaseFilterMode(selectedCase) {
        const needle = String(selectedCase ?? "").trim();
        if (!needle
            || needle === AnnotationAdapter.CASE_FILTER_PLACEHOLDER_VALUE
            || /^--\s*select (slides|a patient case)\s*--$/i.test(needle)) {
            return "placeholder";
        }
        if (needle === AnnotationAdapter.CASE_FILTER_ALL_SLIDES_VALUE
            || /^all slides$/i.test(needle)) {
            return "all";
        }
        return "case";
    }

    /**
     * Human-readable slide / stain label from filename metadata layers.
     * Example: {@code BA26-041340_A2.vsi} → {@code A2}.
     * Underscores inside the remaining token are preserved (not turned into spaces).
     */
    static parseSlideLabel(image) {
        const raw = String(
            image?.name
            || image?.relativePath
            || image?.id
            || ""
        ).trim();
        if (!raw) return "Slide";
        const leaf = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
        const base = leaf.replace(/\.[^.]+$/i, "");
        const caseId = AnnotationAdapter.extractCaseId(base)
            || AnnotationAdapter.extractCaseId(raw);
        let label = base;
        if (caseId) {
            const escaped = caseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            label = base.replace(new RegExp(escaped, "i"), "");
        }
        label = String(label)
            .replace(/^[\s_\-.]+|[\s_\-.]+$/g, "")
            .replace(/\s+/g, " ")
            .trim();
        return label || base || leaf || "Slide";
    }

    /** Leaf filename exactly as stored on disk (underscores preserved). */
    static rawImageFileName(image) {
        const raw = String(image?.name || image?.relativePath || "").trim();
        if (!raw) return "";
        return raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
    }

    /**
     * Trailing acquisition timestamp block: {@code _YYYYMMDD_HHMMSS}.
     * Display-only — never mutate image id / path used for loading.
     */
    static TIMESTAMP_SUFFIX_PATTERN = /_(\d{8})_(\d{6})\b/g;

    /** Remove trailing {@code _xxxxxxxx_xxxxxx} timestamp tokens from a display string. */
    static stripFilenameTimestampSuffix(text) {
        return String(text ?? "").replace(AnnotationAdapter.TIMESTAMP_SUFFIX_PATTERN, "");
    }

    /**
     * Sidebar display stem before duplicate indexing.
     * @param {object} image
     * @param {{useSlideLabel?: boolean}} [options]
     */
    static sidebarDisplayStem(image, options = {}) {
        if (options.useSlideLabel) {
            const label = AnnotationAdapter.stripFilenameTimestampSuffix(
                AnnotationAdapter.parseSlideLabel(image)
            );
            return label || "Slide";
        }
        const leaf = AnnotationAdapter.rawImageFileName(image);
        const base = leaf.replace(/\.[^.]+$/i, "") || leaf;
        const stripped = AnnotationAdapter.stripFilenameTimestampSuffix(base);
        return stripped || base || leaf || "Slide";
    }

    /**
     * Build display titles for a sidebar list: strip timestamps, then append
     * {@code (currentIndex of totalCount)} when the stripped stem appears more
     * than once. Unique stems stay unsuffixed.
     */
    static assignSidebarDisplayTitles(images, options = {}) {
        const list = Array.isArray(images) ? images : [];
        const rows = list.map(image => ({
            image,
            stem: AnnotationAdapter.sidebarDisplayStem(image, options)
        }));
        const totals = new Map();
        for (const row of rows) {
            totals.set(row.stem, (totals.get(row.stem) || 0) + 1);
        }
        const seen = new Map();
        return rows.map(row => {
            const totalCount = totals.get(row.stem) || 1;
            const currentIndex = (seen.get(row.stem) || 0) + 1;
            seen.set(row.stem, currentIndex);
            const title = totalCount > 1
                ? `${row.stem} (${currentIndex} of ${totalCount})`
                : row.stem;
            return { image: row.image, title, stem: row.stem };
        });
    }

    /** Primary Case ID + secondary on-disk filename for the top header. */
    static buildHeaderIdentity(image) {
        if (!image) {
            return {caseId: "", slideDetail: ""};
        }
        const haystack = [
            image.relativePath,
            image.name,
            image.id,
            image.folder
        ].filter(Boolean).join("\n");
        const caseId = AnnotationAdapter.extractCaseId(haystack);
        return {
            caseId: caseId ? String(caseId).toUpperCase() : "",
            // Header must show the raw on-disk name — never strip "_" to spaces.
            slideDetail: AnnotationAdapter.rawImageFileName(image)
        };
    }

    /** Images whose path/name/id contain the selected case token. */
    static filterImagesForCase(images, selectedCase) {
        const needle = String(selectedCase ?? "").trim();
        if (!needle || !Array.isArray(images)) return [];
        const upper = needle.toUpperCase();
        return images.filter(image => {
            if (!image || typeof image !== "object") return false;
            const haystack = [
                image.relativePath,
                image.name,
                image.id,
                image.folder
            ].filter(Boolean).join("\n").toUpperCase();
            return haystack.includes(upper);
        });
    }

    /**
     * Group key for overlapping spectral helper bands that share one checkbox.
     * Channels with the same fluor / designation suffix toggle together.
     */
    static channelVisibilityGroupKey(channel) {
        const name = String(channel?.name ?? "").trim();
        if (!name) return `idx:${channel?.index ?? 0}`;
        const dash = name.match(/\s-\s(.+)$/);
        if (dash) return dash[1].trim().toUpperCase();
        return name.toUpperCase();
    }

    /** Short channel label for the compact matrix (drops "Channel N - "). */
    static compactChannelName(channel) {
        const name = String(channel?.name ?? "").trim();
        if (!name) return `Ch ${channel?.index ?? 0}`;
        const dash = name.match(/\s-\s(.+)$/);
        if (dash) return dash[1].trim();
        return name.replace(/^Channel\s+\d+\s*/i, "").trim() || name;
    }

    /**
     * Rule A (All Slides): collapsed parent directories with counts.
     * Rule B (specific case): flat list of slide labels only.
     * Placeholder: empty list.
     */
    static renderImageBrowser(container, images, selectedCase, options = {}) {
        if (!container || typeof container.replaceChildren !== "function") return;
        AnnotationAdapter.sidebarOcrBatchGeneration += 1;
        AnnotationAdapter.sidebarOcrInFlight?.clear?.();
        container.replaceChildren();
        const mode = AnnotationAdapter.resolveCaseFilterMode(selectedCase);
        const list = AnnotationAdapter.sortImagesNaturally(images);
        AnnotationAdapter.cacheCatalogSidecarMetadata(list);
        const onSelect = typeof options.onSelect === "function" ? options.onSelect : () => {};
        const storagePrefix = String(options.storagePrefix || "wsi.viewer");
        const doc = options.document
            || (typeof document !== "undefined" ? document : null);

        if (mode === "placeholder" || list.length === 0) {
            container.classList.remove("image-list-flat");
            container.classList.remove("image-list-tree");
            return;
        }

        if (mode === "case") {
            container.classList.add("image-list-flat");
            container.classList.remove("image-list-tree");
            const matched = AnnotationAdapter.sortImagesNaturally(
                AnnotationAdapter.filterImagesForCase(list, selectedCase)
            );
            const titled = AnnotationAdapter.assignSidebarDisplayTitles(matched, { useSlideLabel: true });
            for (const { image, title } of titled) {
                const { row } = AnnotationAdapter.createSlideRow(
                    doc,
                    image,
                    title,
                    "image-button-flat",
                    onSelect
                );
                container.append(row);
            }
            if (AnnotationAdapter.slideLabelThumbsEnabled) {
                AnnotationAdapter.loadSlideLabelThumbs(container);
            }
            AnnotationAdapter.scheduleSidebarClinicalOcrBatch(container, matched);
            return;
        }

        // Rule A — global directory tree. Always paint collapsed so first access /
        // switching to "All Slides" shows ONLY parent rows with counts. Nested
        // slides stay hidden until the user clicks a directory summary.
        container.classList.add("image-list-tree");
        container.classList.remove("image-list-flat");
        const groups = new Map();
        for (const image of list) {
            const folder = image.folder || "Images";
            if (!groups.has(folder)) groups.set(folder, []);
            groups.get(folder).push(image);
        }
        const folderNames = Array.from(groups.keys()).sort((a, b) =>
            AnnotationAdapter.naturalCollator.compare(a, b)
        );
        for (const folder of folderNames) {
            const folderImages = AnnotationAdapter.sortImagesNaturally(groups.get(folder) || []);
            const details = doc.createElement("details");
            details.className = "folder-group";
            // Strict collapse: never restore open state from localStorage here —
            // legacy keys previously left the All Slides tree fully exploded.
            details.open = false;
            details.removeAttribute("open");
            const summary = doc.createElement("summary");
            summary.textContent = `${folder} (${folderImages.length})`;
            details.append(summary);
            const contents = doc.createElement("div");
            contents.className = "folder-contents";
            contents.hidden = true;
            contents.style.display = "none";
            const titled = AnnotationAdapter.assignSidebarDisplayTitles(folderImages);
            for (const { image, title } of titled) {
                const { row } = AnnotationAdapter.createSlideRow(doc, image, title, "", onSelect);
                contents.append(row);
            }
            details.append(contents);
            details.addEventListener("toggle", () => {
                const expanded = Boolean(details.open);
                contents.hidden = !expanded;
                contents.style.display = expanded ? "" : "none";
                if (expanded && AnnotationAdapter.slideLabelThumbsEnabled) {
                    AnnotationAdapter.loadSlideLabelThumbs(contents);
                }
                try {
                    const storageKey = `${storagePrefix}.folder.${folder}`;
                    localStorage.setItem(storageKey, expanded ? "open" : "closed");
                } catch (_error) {
                    // Ignore quota / private-mode failures.
                }
            });
            container.append(details);
        }
        if (AnnotationAdapter.slideLabelThumbsEnabled) {
            AnnotationAdapter.loadSlideLabelThumbs(container);
        }
        AnnotationAdapter.scheduleSidebarClinicalOcrBatch(container, list);
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
        this.annotator = annotator || AnnotationAdapter.createNativeAnnotatorFacade();
        this.timingCallbacks = timingCallbacks;
        this.metadataById = new Map();
        this.backendIdByClientId = new Map();
        this.nonDisplayedAnnotations = [];
        this.suppressEvents = false;
        this.replacementQueue = Promise.resolve();

        // Create/persist workstation id from localStorage before any canvas GET/PUT.
        this.workstationUserId = AnnotationAdapter.resolveWorkstationUserId();

        // AnnotationStore owns lifecycle and, internally, always attaches X-WSI-User
        // (via AnnotationStore.resolveWorkstationUserId()) to its own GET/PUT calls.
        this.store = new AnnotationStore({
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
                await this.replaceDisplayedAnnotations([]);
            } else if (event.reason === "loaded") {
                this.timingCallbacks.annotationsLoaded?.(event.collection.imageId);
                await this.applyBackendCollection(event.collection);
                this.timingCallbacks.annotationsRendered?.(event.collection.imageId);
                console.info(`AnnotationAdapter: loaded ${event.collection.annotations?.length || 0} annotations`);
            } else if (event.reason === "saved") {
                // A save changes canonical IDs/timestamps, not client geometry.
                // Replacing here would tear down a just-created SVG shape.
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
     * The web host's own loopback-accessed browser always wins as "local" (see
     * AnnotationStore.isWebHostLoopback), even over a stray id a prior session may
     * have already cached, so it keeps seeing annotations that predate this scoping.
     */
    static resolveWorkstationUserId() {
        if (AnnotationStore.isWebHostLoopback()) {
            return AnnotationStore.resolveWorkstationUserId();
        }
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
    /** True while a floating palette title bar is being dragged. */
    static isDraggingWindow = false;
    static activeDraggingPanel = null;
    /** Alias used by the pointer-unlock sequence (`isDrawing = false`). */
    static get isDrawing() {
        return AnnotationAdapter.isDragging;
    }
    static set isDrawing(value) {
        AnnotationAdapter.isDragging = Boolean(value);
    }
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
    /** Last overlay / image end from an in-progress drag (for Enter commit). */
    static measureEndX = null;
    static measureEndY = null;
    static measureEndImageX = null;
    static measureEndImageY = null;
    /** Last pointer id captured during a measurement drag. */
    static lastPointerId = null;
    /** Active ImageJ-style secondary toolbar tool (`pan`, `ruler`, …). */
    static activeImageJTool = "pan";
    /** QuPath-style annotation matrix tool (`move`, `rectangle`, `ellipse`, …). */
    static currentActiveTool = "move";
    static qpDrawSession = null;
    static qpDrawOverlayEl = null;
    static qpShapeTrackers = [];
    static vectorOutlinesVisible = true;
    static annotationLabelsVisible = true;
    /** Interior fill of annotation shapes (rectangle/ellipse/closed polygon) starts OFF
     *  so drawn regions never obscure the underlying image by default; Shift+F toggles it.
     *  Outlines/strokes are always shown regardless of this flag. */
    static annotationFillEnabled = false;
    static savedAnnotationsArray = [];
    static selectedNativeAnnotationId = null;
    /** Multi-select set (shift-click). `selectedNativeAnnotationId` always tracks the most
     *  recently touched member of this set (or null when empty) so existing single-target
     *  code (drag, rename, name-editor) keeps working unchanged even when several shapes
     *  are highlighted at once. */
    static selectedNativeAnnotationIds = new Set();
    /** Per-annotation position lock (right-click context menu). Persisted to localStorage
     *  by id, independent of selection, so it survives reload as long as the backend keeps
     *  returning the same annotation id. */
    static LOCKED_ANNOTATIONS_STORAGE_KEY = "wsi.lockedAnnotationIds";
    static lockedAnnotationIds = new Set();
    static _lockedAnnotationsLoaded = false;
    static annotationEngine = null;
    static OSD_ANNOTATION_STROKE = "#FFD700";
    static OSD_ANNOTATION_FILL = "rgba(255, 215, 0, 0.22)";
    static OSD_ANNOTATION_SHAPE_CLASS = "osd-annotation-shape";
    static WAND_DEFAULT_RADIUS = 30;
    static WAND_DEFAULT_DELTA = 15;
    static WAND_DEFAULT_MIN_FILL = 8;
    static WAND_DEFAULT_CONNECTIVITY = 4;
    static WAND_DEFAULT_COLOR_METRIC = "chebyshev";
    static WAND_DEFAULT_MAX_VERTICES = 32;
    static WAND_DEFAULT_FALLBACK_VERTICES = 20;
    static WAND_CONFIG_STORAGE_KEY = "wsi.wand.config";
    static wandLookupRadiusPx = 30;
    static wandColorDelta = 15;
    static wandMinFillPixels = 8;
    static wandConnectivity = 4;
    static wandColorMetric = "chebyshev";
    static wandMaxContourVertices = 32;
    static wandFallbackVertices = 20;
    static wandPreset = "default";
    static FREEFORM_BACKEND_TYPES = {
        rectangle: true,
        square: true,
        ellipse: true,
        circle: true,
        polygon: true,
        polyline: true,
        line: true,
        wand: true,
        brush: true,
        points: true
    };
    /** `single` (one-shot) or `multiple` (stay in mode until icon/Enter escape). */
    static _measurementEntryMode = "single";
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
        if (metadata && (metadata.modality || metadata.engine)) {
            AnnotationAdapter.setActiveSlideContext(metadata);
        } else if (!metadata) {
            AnnotationAdapter.setActiveSlideContext(null);
        } else {
            AnnotationAdapter.syncPluginSelector();
        }
        return AnnotationAdapter.imageMetadata;
    }

    static setActiveSlideContext(image) {
        AnnotationAdapter.currentModality = String(image?.modality || "").toUpperCase();
        AnnotationAdapter.currentEngine = String(image?.engine || "").toUpperCase();
        AnnotationAdapter.syncPluginSelector();
        return AnnotationAdapter.isBrightfieldSlide();
    }

    static isBrightfieldSlide(source) {
        const modality = String(source?.modality || AnnotationAdapter.currentModality || "").toUpperCase();
        const engine = String(source?.engine || AnnotationAdapter.currentEngine || "").toUpperCase();
        return modality === "BRIGHTFIELD" || engine === "OPENSLIDE";
    }

    static syncPluginSelector(root) {
        const host = root || (typeof document !== "undefined" ? document : null);
        const select = host && typeof host.getElementById === "function"
            ? host.getElementById("plugin-selector")
            : null;
        if (!select) return false;
        const brightfield = AnnotationAdapter.isBrightfieldSlide();
        const options = brightfield
            ? [AnnotationAdapter.IHC_PLUGIN_OPTION].concat(AnnotationAdapter.FLUORESCENCE_PLUGIN_OPTIONS)
            : AnnotationAdapter.FLUORESCENCE_PLUGIN_OPTIONS.slice();
        const previous = String(select.value || "");
        select.textContent = "";
        for (const item of options) {
            const option = (typeof document !== "undefined" && document.createElement)
                ? document.createElement("option")
                : { value: "", textContent: "" };
            option.value = item.value;
            option.textContent = item.label;
            if (typeof select.appendChild === "function") select.appendChild(option);
        }
        const preferred = brightfield
            ? "ihc-pixel-quantifier"
            : (options.some((item) => item.value === previous) ? previous : options[0].value);
        select.value = preferred;
        return brightfield;
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
        AnnotationAdapter.measureEndX = null;
        AnnotationAdapter.measureEndY = null;
        AnnotationAdapter.measureEndImageX = null;
        AnnotationAdapter.measureEndImageY = null;
    }

    static measurementModeSelectorEl(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root);
        return doc?.getElementById?.("measurement-mode-selector") || null;
    }

    static measurementEntryMode(root = null) {
        const select = AnnotationAdapter.measurementModeSelectorEl(root);
        const raw = String(select?.value || AnnotationAdapter._measurementEntryMode || "single")
            .toLowerCase();
        return raw === "multiple" ? "multiple" : "single";
    }

    static setMeasurementEntryMode(mode, root = null) {
        const next = String(mode || "").toLowerCase() === "multiple" ? "multiple" : "single";
        AnnotationAdapter._measurementEntryMode = next;
        const select = AnnotationAdapter.measurementModeSelectorEl(root);
        if (select) select.value = next;
        return next;
    }

    static _openSeadragon() {
        if (typeof window !== "undefined" && window.OpenSeadragon) return window.OpenSeadragon;
        if (typeof globalThis !== "undefined" && globalThis.OpenSeadragon) return globalThis.OpenSeadragon;
        return null;
    }

    /**
     * Install OpenSeadragon.Viewer.prototype.svgOverlay when the svg-overlay
     * plugin is not already present. Coordinates on overlay.node() are viewport
     * units so shapes pan and zoom with the slide.
     */
    static installSvgOverlayPlugin() {
        const OSD = AnnotationAdapter._openSeadragon();
        if (!OSD?.Viewer?.prototype) return OSD;
        if (typeof OSD.Viewer.prototype.svgOverlay === "function") return OSD;
        const svgNS = "http://www.w3.org/2000/svg";
        function OsdSvgOverlay(viewer) {
            this._viewer = viewer;
            this._containerWidth = 0;
            this._containerHeight = 0;
            this._svg = (typeof document !== "undefined" && document.createElementNS)
                ? document.createElementNS(svgNS, "svg")
                : null;
            if (!this._svg) return;
            this._svg.setAttribute("class", "osd-svg-overlay");
            this._svg.style.position = "absolute";
            this._svg.style.left = "0";
            this._svg.style.top = "0";
            this._svg.style.width = "100%";
            this._svg.style.height = "100%";
            this._svg.style.pointerEvents = "none";
            this._svg.style.overflow = "visible";
            this._svg.style.zIndex = "20";
            this._node = document.createElementNS(svgNS, "g");
            this._svg.appendChild(this._node);
            const host = viewer.canvas || viewer.container || viewer.element;
            if (host && typeof host.appendChild === "function") host.appendChild(this._svg);
            const resize = () => this.resize();
            if (typeof viewer.addHandler === "function") {
                viewer.addHandler("animation", resize);
                viewer.addHandler("open", resize);
                viewer.addHandler("rotate", resize);
                viewer.addHandler("resize", resize);
            }
            this.resize();
        }
        OsdSvgOverlay.prototype.node = function() { return this._node; };
        OsdSvgOverlay.prototype.resize = function() {
            const viewer = this._viewer;
            if (!this._svg || !viewer?.viewport) return;
            const width = Number(viewer.container?.clientWidth || viewer.canvas?.clientWidth || 0);
            const height = Number(viewer.container?.clientHeight || viewer.canvas?.clientHeight || 0);
            if (width && width !== this._containerWidth) {
                this._containerWidth = width;
                this._svg.setAttribute("width", String(width));
            }
            if (height && height !== this._containerHeight) {
                this._containerHeight = height;
                this._svg.setAttribute("height", String(height));
            }
            try {
                const origin = viewer.viewport.pixelFromPoint(new OSD.Point(0, 0), true);
                const zoom = Number(viewer.viewport.getZoom(true)) || 1;
                const rotation = Number(viewer.viewport.getRotation?.() || 0);
                const svgWidth = Number(this._svg.clientWidth || this._containerWidth || 1);
                const scaledZoom = svgWidth * zoom;
                this._node.setAttribute(
                    "transform",
                    `translate(${origin.x},${origin.y}) scale(${scaledZoom}) rotate(${rotation})`
                );
            } catch (_error) { /* viewer not ready */ }
        };
        OSD.Viewer.prototype.svgOverlay = function() {
            if (!this._svgOverlayInfo) this._svgOverlayInfo = new OsdSvgOverlay(this);
            return this._svgOverlayInfo;
        };
        return OSD;
    }

    static createNativeAnnotatorFacade() {
        return {
            getAnnotations() {
                const list = Array.isArray(AnnotationAdapter.savedAnnotationsArray)
                    ? AnnotationAdapter.savedAnnotationsArray
                    : [];
                return list.map(entry => AnnotationAdapter.unifiedRecordToW3c(entry)).filter(Boolean);
            },
            async setAnnotations(values) {
                AnnotationAdapter.mountW3cAnnotationsOnOverlay(values);
            },
            async clearAnnotations() {
                AnnotationAdapter.mountW3cAnnotationsOnOverlay([]);
            },
            async addAnnotation(annotation) {
                const next = this.getAnnotations().concat(annotation).filter(Boolean);
                await this.setAnnotations(next);
            },
            getSelected() {
                const id = AnnotationAdapter.selectedNativeAnnotationId;
                if (!id) return [];
                const found = this.getAnnotations().find(item => item?.id === id);
                return found ? [found] : [];
            },
            setSelected(items) {
                const first = Array.isArray(items) ? items[0] : items;
                AnnotationAdapter.selectedNativeAnnotationId = first?.id || null;
            },
            setDrawingEnabled() {},
            setDrawingTool() {},
            setDrawingMode() {},
            on() {},
            removeAnnotation(annotation) {
                AnnotationAdapter.removeNativeAnnotation(annotation?.id || annotation);
            }
        };
    }

    static installNativeOsdAnnotationEngine(viewer, options = {}) {
        AnnotationAdapter.installSvgOverlayPlugin();
        AnnotationAdapter.setViewer(viewer);
        AnnotationAdapter.setSavedAnnotations(AnnotationAdapter.savedAnnotationsArray);
        const facade = AnnotationAdapter.createNativeAnnotatorFacade();
        const adapter = new AnnotationAdapter(facade, options.timingCallbacks || {});
        AnnotationAdapter.ensureAnnotationEditorPopup();
        const nameInput = options.nameInput
            || (typeof document !== "undefined" ? document.getElementById("annotation-name-input") : null);
        const labelLayer = (typeof AnnotationLabelLayer === "function" && viewer)
            ? new AnnotationLabelLayer(viewer, facade, id => adapter.getAnnotationName(id))
            : null;
        const nameEditor = (nameInput && typeof AnnotationNameEditor === "function")
            ? new AnnotationNameEditor(nameInput, adapter, id => {
                const rec = facade.getAnnotations().find(item => item?.id === id);
                if (rec) labelLayer?.syncAnnotation?.(rec);
            })
            : null;
        const engine = new NativeOsdAnnotationEngine({
            viewer,
            adapter,
            annotator: facade,
            labelLayer,
            nameEditor,
            toggleButton: options.toggleButton,
            visibilityButton: options.visibilityButton,
            namesButton: options.namesButton,
            getCurrentImageId: options.getCurrentImageId,
            timingCallbacks: options.timingCallbacks || {}
        });
        AnnotationAdapter.annotationEngine = engine;
        AnnotationAdapter.annotationSpike = engine;
        if (typeof viewer?.addHandler === "function" && !viewer._wsiNativeAnnotationOpenBound) {
            viewer._wsiNativeAnnotationOpenBound = true;
            viewer.addHandler("open", () => {
                void engine.handleViewerOpen().catch(error =>
                    console.error("Native SVG annotation engine: unable to load annotations", error)
                );
            });
        }
        AnnotationAdapter.bindAnnotationShapeEditorLoop(viewer);
        AnnotationAdapter.ensureQuPathDrawOverlay();
        engine.bindChrome();
        if (options.visibilityButton) options.visibilityButton.disabled = false;
        if (options.namesButton) options.namesButton.disabled = false;
        if (options.toggleButton) options.toggleButton.disabled = false;
        return engine;
    }

    static shapeCoordX(pt) {
        const value = Number(pt?.viewportX ?? pt?.overlayX);
        return Number.isFinite(value) ? value : 0;
    }

    static shapeCoordY(pt) {
        const value = Number(pt?.viewportY ?? pt?.overlayY);
        return Number.isFinite(value) ? value : 0;
    }

    static applyOsdAnnotationStyle(node, { filled = true } = {}) {
        if (!node || typeof node.setAttribute !== "function") return node;
        const existing = String(node.getAttribute?.("class") || node.attrs?.class || "").trim();
        const cls = AnnotationAdapter.OSD_ANNOTATION_SHAPE_CLASS;
        if (!existing.includes(cls)) {
            node.setAttribute("class", `${existing} ${cls} annotation-shape-overlay`.trim());
        }
        node.setAttribute("fill", filled ? AnnotationAdapter.OSD_ANNOTATION_FILL : "none");
        // fill-opacity is a separate, independent knob from the fill color itself so the
        // global on/off toggle (Shift+F, see toggleAnnotationFill) never needs to know or
        // restore whatever color a shape was filled with — it just hides/shows it.
        node.setAttribute("fill-opacity", AnnotationAdapter.annotationFillEnabled ? "1" : "0");
        node.setAttribute("stroke", AnnotationAdapter.OSD_ANNOTATION_STROKE);
        node.setAttribute("stroke-width", "2");
        node.setAttribute("stroke-opacity", "1");
        node.setAttribute("vector-effect", "non-scaling-stroke");
        if (node.style) {
            node.style.pointerEvents = "auto";
            node.style.cursor = "pointer";
        }
        return node;
    }

    static unifiedRecordToW3c(entry) {
        if (!entry?.id) return null;
        const x = Number(entry.x);
        const y = Number(entry.y);
        const width = Number(entry.width);
        const height = Number(entry.height);
        const type = String(entry.type || "rectangle").toLowerCase();
        const selectorType = type === "ellipse" || type === "circle" ? "ELLIPSE"
            : type === "polygon" || type === "wand" ? "POLYGON"
            : type === "polyline" || type === "brush" ? "POLYLINE"
            : type === "line" ? "LINE"
            : "RECTANGLE";
        const geometry = {
            x: Number.isFinite(x) ? x : 0,
            y: Number.isFinite(y) ? y : 0,
            w: Number.isFinite(width) ? width : 0,
            h: Number.isFinite(height) ? height : 0,
            bounds: {
                minX: Number.isFinite(x) ? x : 0,
                minY: Number.isFinite(y) ? y : 0,
                maxX: Number.isFinite(x) && Number.isFinite(width) ? x + width : 0,
                maxY: Number.isFinite(y) && Number.isFinite(height) ? y + height : 0
            }
        };
        if (Array.isArray(entry.vertices) && entry.vertices.length) {
            geometry.points = entry.vertices.map(v => AnnotationAdapter.vertexToImagePair(v)).filter(pair =>
                Number.isFinite(pair[0]) && Number.isFinite(pair[1])
            );
        }
        return {
            id: entry.id,
            bodies: Array.isArray(entry.bodies) ? entry.bodies : [],
            type: entry.type,
            name: entry.name,
            target: { selector: { type: selectorType, geometry } }
        };
    }

    static w3cToUnifiedRecord(annotation) {
        if (!annotation?.id) return null;
        const geometry = annotation?.target?.selector?.geometry || {};
        const selectorType = String(annotation?.target?.selector?.type || "RECTANGLE").toUpperCase();
        const rawType = String(annotation?.type || "").toLowerCase();
        const type = AnnotationAdapter.FREEFORM_BACKEND_TYPES[rawType]
            ? rawType
            : selectorType === "ELLIPSE" ? "ellipse"
            : selectorType === "POLYGON" ? "polygon"
            : selectorType === "POLYLINE" ? "polyline"
            : selectorType === "LINE" ? "line"
            : "rectangle";
        const x = Number(geometry.x ?? geometry.bounds?.minX);
        const y = Number(geometry.y ?? geometry.bounds?.minY);
        const width = Number(geometry.w ?? (geometry.bounds?.maxX - geometry.bounds?.minX));
        const height = Number(geometry.h ?? (geometry.bounds?.maxY - geometry.bounds?.minY));
        const startImage = { x, y };
        const currentImage = {
            x: Number.isFinite(x) && Number.isFinite(width) ? x + width : x,
            y: Number.isFinite(y) && Number.isFinite(height) ? y + height : y
        };
        const startVp = AnnotationAdapter.imagePointToShapePoint(startImage);
        const currentVp = AnnotationAdapter.imagePointToShapePoint(currentImage);
        return {
            id: annotation.id,
            type,
            name: annotation.name || null,
            visible: true,
            x: Number.isFinite(x) ? x : null,
            y: Number.isFinite(y) ? y : null,
            width: Number.isFinite(width) ? width : null,
            height: Number.isFinite(height) ? height : null,
            start: startVp,
            current: currentVp,
            vertices: Array.isArray(geometry.points)
                ? geometry.points.map(pt => AnnotationAdapter.imagePointToShapePoint({
                    x: Number(Array.isArray(pt) ? pt[0] : pt?.x),
                    y: Number(Array.isArray(pt) ? pt[1] : pt?.y)
                }))
                : [],
            bodies: Array.isArray(annotation.bodies) ? annotation.bodies : [],
            node: null
        };
    }

    static vertexToImagePair(vertex) {
        if (Array.isArray(vertex)) {
            return [Number(vertex[0]), Number(vertex[1])];
        }
        return [
            Number(vertex?.image?.x ?? vertex?.x),
            Number(vertex?.image?.y ?? vertex?.y)
        ];
    }

    static imagePointToShapePoint(image) {
        const x = Number(image?.x);
        const y = Number(image?.y);
        const point = {
            overlayX: x,
            overlayY: y,
            viewportX: x,
            viewportY: y,
            image: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
        };
        try {
            const viewer = AnnotationAdapter.viewer;
            const tiled = AnnotationAdapter.primaryTiledImage?.(viewer);
            if (tiled && Number.isFinite(x) && Number.isFinite(y)) {
                const OSD = AnnotationAdapter._openSeadragon();
                const imgPt = OSD ? new OSD.Point(x, y) : { x, y };
                const vp = tiled.imageToViewportCoordinates(imgPt);
                point.viewportX = Number(vp?.x);
                point.viewportY = Number(vp?.y);
                if (viewer?.viewport?.viewportToViewerElementCoordinates) {
                    const el = viewer.viewport.viewportToViewerElementCoordinates(vp);
                    point.overlayX = Number(el?.x);
                    point.overlayY = Number(el?.y);
                }
            }
        } catch (_error) { /* keep image-space fallback */ }
        return point;
    }

    static mountW3cAnnotationsOnOverlay(annotations) {
        const records = (Array.isArray(annotations) ? annotations : [])
            .map(item => AnnotationAdapter.w3cToUnifiedRecord(item))
            .filter(Boolean);
        AnnotationAdapter.setSavedAnnotations(records);
        const group = AnnotationAdapter.quPathCommittedGroup();
        if (group) group.innerHTML = "";
        records.forEach(entry => {
            const node = AnnotationAdapter.buildQuPathSvgShape(entry.type, entry);
            if (!node || !group) return;
            AnnotationAdapter.attachAnnotationShapeOverlay(node, entry.id);
            if (typeof group.appendChild === "function") group.appendChild(node);
        });
        try {
            const engine = AnnotationAdapter.annotationEngine || AnnotationAdapter.annotationSpike;
            engine?.labelLayer?.sync?.(engine.getCurrentImageId?.());
        } catch (_error) { /* labels optional */ }
        return records;
    }

    static removeNativeAnnotation(id) {
        if (!id) return false;
        AnnotationAdapter.setSavedAnnotations(
            (AnnotationAdapter.savedAnnotationsArray || []).filter(item => item?.id !== id)
        );
        AnnotationAdapter.selectedNativeAnnotationIds?.delete?.(id);
        if (AnnotationAdapter.lockedAnnotationIds?.delete?.(id)) {
            AnnotationAdapter.persistLockedAnnotationIds();
        }
        if (AnnotationAdapter.selectedNativeAnnotationId === id) {
            const remaining = AnnotationAdapter.selectedNativeAnnotationIds?.size
                ? AnnotationAdapter.selectedNativeAnnotationIds.values().next().value
                : null;
            AnnotationAdapter.selectedNativeAnnotationId = remaining || null;
        }
        const node = typeof document !== "undefined"
            ? document.querySelector?.(`.osd-annotation-shape[data-annotation-id="${id}"]`)
            : null;
        try { node?.remove?.(); } catch (_error) { /* ignore */ }
        return true;
    }

    /** Remember the active OpenSeadragon viewer for mouse-nav + tracker binding. */
    /**
     * Rectangle fallback used to leave mouse-nav off. Nuclei overlays must not
     * keep pan/scroll disabled after segmentation.
     */
    static restoreViewerMouseNavUnlessModal(viewer) {
        const host = viewer || AnnotationAdapter.viewer;
        const drawing = Boolean(
            AnnotationAdapter.annotationEngine?.drawingEnabled
            || AnnotationAdapter.annotationSpike?.drawingEnabled
        );
        const measuring = Boolean(AnnotationAdapter.isMeasurementModeActive);
        if (drawing || measuring) return false;
        if (host && typeof host.setMouseNavEnabled === "function") {
            host.setMouseNavEnabled(true);
        }
        if (host?.gestureSettingsMouse) host.gestureSettingsMouse.scrollToZoom = true;
        return true;
    }

    /**
     * OpenSeadragon's built-in Navigator (the corner minimap) only ever raises a
     * "navigator-scroll" event and otherwise ignores it — by default, scrolling
     * over it neither zooms the navigator (it always shows the whole slide, so
     * that would be pointless) nor the main viewport. Wire it to zoom the *main*
     * viewport instead, centered on whatever point of the slide the cursor is
     * currently over inside the navigator (same reference-point convention as
     * scrolling over the main canvas, via {@link Viewport#zoomBy}'s second
     * argument). The navigator's native click-drag-to-pan keeps working
     * unmodified — drag and scroll are independent MouseTracker callbacks fed by
     * independent hardware inputs, so both fire freely at once. That combination
     * is the point: one hand drags the navigator's viewport box to a region while
     * the other scrolls to zoom into/out of exactly that spot, panning and
     * zooming simultaneously without ever having to move either hand to the main
     * canvas — like a glass slide under a scope, but better.
     */
    static bindNavigatorScrollZoom(viewer) {
        if (!viewer || typeof viewer.addHandler !== "function" || viewer._wsiNavigatorScrollZoomBound) {
            return false;
        }
        viewer.addHandler("navigator-scroll", event => {
            const viewport = viewer.viewport;
            const navigatorViewport = viewer.navigator?.viewport;
            if (!viewport || !navigatorViewport) return;
            if (viewer.gestureSettingsMouse && viewer.gestureSettingsMouse.scrollToZoom === false) return;
            const zoomPerScroll = Number(viewer.zoomPerScroll) || 1.2;
            const factor = Math.pow(zoomPerScroll, Number(event.scroll) || 0);
            let refPoint = null;
            try {
                refPoint = navigatorViewport.pointFromPixel(event.position, true);
            } catch (_error) {
                // Fall back to zooming on the current center instead of throwing.
            }
            viewport.zoomBy(factor, refPoint);
            viewport.applyConstraints();
            event.preventDefault = true;
        });
        viewer._wsiNavigatorScrollZoomBound = true;
        return true;
    }

    static setViewer(viewer) {
        AnnotationAdapter.ensureMeasurementDefaults();
        AnnotationAdapter.viewer = viewer || null;
        AnnotationAdapter.bindResetViewportHomeButton();
        AnnotationAdapter.bindAdvancedChannelPalette();
        AnnotationAdapter.bindFloatingAiLabsPalette();
        AnnotationAdapter.bindFloatingAdminPalette();
        AnnotationAdapter.bindFloatingZStackPalette();
        if (AnnotationAdapter.viewer) {
            AnnotationAdapter.bindViewportHomeOnOpen(AnnotationAdapter.viewer);
            AnnotationAdapter.bindNavigatorScrollZoom(AnnotationAdapter.viewer);
            AnnotationAdapter.bindAiVectorOverlayHandlers(AnnotationAdapter.viewer);
            AnnotationAdapter.bindOpenSeadragonCanvasKeyIntercept(AnnotationAdapter.viewer);
            AnnotationAdapter.bindQuPathZoomFitResize();
            // Defensive reset: OSD's viewport flip state is a toggle that persists on this
            // single reused viewer instance across every slide switch for the whole session.
            // Force it off here so a stray flip (however it happened) can never silently
            // carry forward and desync the tile image from annotation overlays, which are
            // positioned independently and are never affected by the flip transform.
            try {
                if (AnnotationAdapter.viewer.viewport
                    && typeof AnnotationAdapter.viewer.viewport.setFlip === "function") {
                    AnnotationAdapter.viewer.viewport.setFlip(false);
                }
            } catch (ignored) { }
        }
        AnnotationAdapter.bindMeasurementKeyboardEscape();
        AnnotationAdapter.bindSecondaryAnnotationToolbar();
        AnnotationAdapter.bindPrimaryUnifiedToolbar();
        AnnotationAdapter.bindAnnotationContextMenu();
        AnnotationAdapter.bindLayerVisibilityAndSanitizeControls();
        AnnotationAdapter.bindQuPathKeyboardShortcuts();
        AnnotationAdapter.ensureCurrentActiveTool(AnnotationAdapter.currentActiveTool || "move");
        AnnotationAdapter.installViewerToolAlias();
        AnnotationAdapter.bindGlobalUiTooltip();
        return AnnotationAdapter.viewer;
    }

    /**
     * 🏠 Home View — drop pan/zoom and restore the baseline OSD home snapshot.
     */
    static bindResetViewportHomeButton(root = null) {
        const doc = root
            || (typeof document !== "undefined" ? document : null);
        const button = doc?.getElementById?.("reset-viewport-home-btn");
        if (!button || button.dataset?.homeViewBound === "1") return button || null;
        button.addEventListener("click", event => {
            event.preventDefault();
            const viewer = AnnotationAdapter.viewer
                || (typeof window !== "undefined" ? window.viewer : null);
            if (viewer && viewer.viewport && typeof viewer.viewport.goHome === "function") {
                viewer.viewport.goHome(true);
            }
        });
        if (button.dataset) button.dataset.homeViewBound = "1";
        return button;
    }

    static BIT8_INTENSITY_SCALE = 255;
    static BIT16_INTENSITY_SCALE = 65535;
    /** Default 16-bit slider ceiling. Prefer {@link channelLevelScale} for the active image. */
    static CHANNEL_LEVEL_MAX = 65535;

    /**
     * Intensity range for B&C sliders, histogram, and the viewport window filter.
     * 8-bit RGB / brightfield series use 0–255; planar fluorescence uses 0–65535.
     * A leftover 58831 ceiling (one prior auto-window white point) made the
     * initial min/max thumbs sit at the far left of an 8-bit slide.
     */
    static channelLevelScale(source) {
        const metadata = source || AnnotationAdapter.imageMetadata;
        const series = Number.isFinite(Number(source?.series))
            ? Number(source.series)
            : AnnotationAdapter.currentSeries;
        const intensityMax = Number(metadata?.intensityMax);
        if (Number.isFinite(intensityMax) && intensityMax > 0) return intensityMax;
        if (AnnotationAdapter.isRgbSeriesView(metadata, series)) {
            return AnnotationAdapter.BIT8_INTENSITY_SCALE;
        }
        return AnnotationAdapter.BIT16_INTENSITY_SCALE;
    }
    static CHANNEL_PALETTE_LUT_COLORS = {
        BLUE: "#438cff",
        GREEN: "#3bd671",
        RED: "#ff5757",
        MAGENTA: "#ed62f5",
        CYAN: "#4de4e4",
        GRAY: "#b8c0ca",
        YELLOW: "#f4df52"
    };
    static displayController = null;
    static channelPaletteElement = null;
    static measurementPaletteElement = null;
    static channelPaletteHost = null;
    static channelPaletteSidebarSnapshot = null;
    static channelPaletteSelectedIndex = 0;
    static channelPaletteHistogram = null;
    static channelPaletteDrag = null;
    static channelPaletteLayout = "1";

    static setDisplayController(controller) {
        AnnotationAdapter.displayController = controller && typeof controller === "object"
            ? controller
            : null;
        AnnotationAdapter.syncFloatingChannelPalette();
        return AnnotationAdapter.displayController;
    }

    static placeholderPaletteChannels() {
        return [
            { index: 0, name: "Cyan", lut: "CYAN", visible: true, black: 0, white: AnnotationAdapter.channelLevelScale(), gamma: 1, opacity: 1 },
            { index: 1, name: "Green", lut: "GREEN", visible: true, black: 0, white: AnnotationAdapter.channelLevelScale(), gamma: 1, opacity: 1 },
            { index: 2, name: "Red", lut: "RED", visible: true, black: 0, white: AnnotationAdapter.channelLevelScale(), gamma: 1, opacity: 1 }
        ];
    }

    static paletteChannelList() {
        const display = AnnotationAdapter.displayController?.getDisplay?.();
        const channels = Array.isArray(display?.channels) ? display.channels : [];
        return channels.length ? channels : AnnotationAdapter.placeholderPaletteChannels();
    }

    static paletteSelectedChannel() {
        const channels = AnnotationAdapter.paletteChannelList();
        const index = Math.max(0, Math.min(channels.length - 1, Number(AnnotationAdapter.channelPaletteSelectedIndex) || 0));
        AnnotationAdapter.channelPaletteSelectedIndex = index;
        return channels[index] || null;
    }

    static resolvePaletteRoot(root = null) {
        return root
            || (AnnotationAdapter.channelPaletteElement && AnnotationAdapter.channelPaletteElement.ownerDocument)
            || (typeof document !== "undefined" ? document : null);
    }

    static resolvePaletteNode(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        return doc?.getElementById?.("floating-channel-palette")
            || AnnotationAdapter.channelPaletteElement
            || null;
    }

    static injectAdvancedChannelPaletteButton(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        if (!doc?.getElementById) return null;
        let button = doc.getElementById("show-advanced-channel-palette");
        if (button) return button;
        const home = doc.getElementById("home-view");
        const host = home?.parentNode
            || doc.querySelector?.(".toolbar-group.nav-group")
            || doc.querySelector?.(".right-column-top")
            || doc.getElementById("channels-panel");
        if (!host || typeof doc.createElement !== "function") return null;
        button = doc.createElement("button");
        button.id = "show-advanced-channel-palette";
        button.type = "button";
        button.className = "toolbar-button fcp-launch-btn";
        button.title = "Show Advanced Channel Palette";
        button.setAttribute("aria-label", "Show Advanced Channel Palette");
        button.setAttribute("aria-pressed", "false");
        button.textContent = "◐";
        if (home && home.nextSibling && typeof host.insertBefore === "function") {
            host.insertBefore(button, home.nextSibling);
        } else if (typeof host.append === "function") host.append(button);
        else host.appendChild?.(button);
        return button;
    }

    static bindAdvancedChannelPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        if (!doc?.getElementById) return null;
        const button = AnnotationAdapter.injectAdvancedChannelPaletteButton(doc);
        const palette = doc.getElementById("floating-channel-palette")
            || AnnotationAdapter.channelPaletteElement;
        if (palette) {
            AnnotationAdapter.channelPaletteElement = palette;
            if (palette.parentNode) AnnotationAdapter.channelPaletteHost = palette.parentNode;
            AnnotationAdapter.isolateFloatingPalettePointerEvents(palette);
        }
        AnnotationAdapter.bindBrightnessContrastLaunchers(doc);
        const closeBtn = palette?.querySelector?.("#floating-channel-palette-close")
            || doc.getElementById("floating-channel-palette-close");
        if (closeBtn && closeBtn.dataset?.fcpCloseBound !== "1") {
            closeBtn.addEventListener("click", event => {
                event.preventDefault();
                AnnotationAdapter.closeFloatingChannelPalette(doc);
            });
            if (closeBtn.dataset) closeBtn.dataset.fcpCloseBound = "1";
        }
        AnnotationAdapter.bindChannelPaletteDrag(doc);
        AnnotationAdapter.bindChannelPaletteControls(doc);
        AnnotationAdapter.bindFloatingPaletteResize(palette);
        AnnotationAdapter.bindFloatingPaletteEdgeResize(palette);
        AnnotationAdapter.bindChannelListSplitter(palette);
        AnnotationAdapter.applyChannelPaletteLayout(AnnotationAdapter.channelPaletteLayout, doc);
        return palette || button || null;
    }

    static isolateFloatingPalettePointerEvents(paletteDiv) {
        if (!paletteDiv?.addEventListener) return false;
        if (paletteDiv.dataset?.fcpEventIsolateBound === "1") return true;
        ['mousedown', 'mouseup', 'mousemove', 'click', 'mouseover', 'mouseout', 'wheel', 'mousewheel', 'DOMMouseScroll'].forEach(function(eventName) {
            paletteDiv.addEventListener(eventName, function(e) {
                e.stopPropagation();
            }, { passive: false });
        });
        ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'touchstart', 'touchmove', 'touchend'].forEach(function(eventName) {
            paletteDiv.addEventListener(eventName, function(e) {
                e.stopPropagation();
            }, { passive: false });
        });
        if (paletteDiv.dataset) paletteDiv.dataset.fcpEventIsolateBound = "1";
        return true;
    }

    static applyLiberatedFloatingStyle(element, options = {}) {
        if (!element?.style) return false;
        AnnotationAdapter.isolateFloatingPalettePointerEvents(element);
        element.style.position = "fixed";
        element.style.zIndex = String(options.zIndex || "9999");
        // Callers that supply their own custom multi-edge resize handles (e.g. the
        // keyboard shortcuts legend) pass resize: "none" so the browser's single
        // corner-only native resize grip (with its own implicit min-content floor)
        // doesn't fight with those handles or its own min-width/min-height below.
        const resizeMode = options.resize || "both";
        if (typeof element.style.setProperty === "function") {
            element.style.setProperty("resize", resizeMode, "important");
            element.style.setProperty("overflow", "hidden", "important");
        } else {
            element.style.resize = resizeMode;
            element.style.overflow = "hidden";
        }
        element.style.minWidth = options.minWidth || "17.5rem";
        element.style.minHeight = options.minHeight || "25rem";
        return true;
    }

    static mountFloatingPaletteToBody(palette, doc) {
        const body = doc?.body;
        AnnotationAdapter.isolateFloatingPalettePointerEvents(palette);
        if (!palette || !body || typeof body.appendChild !== "function") return false;
        if (typeof document !== "undefined" && doc === document && document.body) {
            document.body.appendChild(palette);
            return true;
        }
        if (palette.parentNode !== body) body.appendChild(palette);
        return true;
    }

    static bindLiberatedPaletteDrag(handle, palette) {
        if (!handle || !palette || handle.dataset?.fcpDragBound === "1") return false;

        const dragPanelLoop = function dragPanelLoop(event) {
            const panel = AnnotationAdapter.activeDraggingPanel || palette;
            const drag = panel?._fcpDrag;
            if (!AnnotationAdapter.isDraggingWindow || !panel?.style || !drag) return;
            const point = event?.touches?.[0] || event;
            panel.style.position = "fixed";
            panel.style.left = `${Number(point.clientX) - drag.dx}px`;
            panel.style.top = `${Number(point.clientY) - drag.dy}px`;
            panel.style.right = "auto";
            panel.style.bottom = "auto";
        };

        // Definitive floating window release tracking loop
        function handleWindowMouseUp(e) {
            let isDraggingWindow = false;
            let activeDraggingPanel = null;
            AnnotationAdapter.isDraggingWindow = isDraggingWindow;
            if (AnnotationAdapter.activeDraggingPanel) {
                AnnotationAdapter.activeDraggingPanel._fcpDrag = null;
            }
            if (palette) palette._fcpDrag = null;
            AnnotationAdapter.activeDraggingPanel = activeDraggingPanel;
            if (e && e.target && typeof e.target.releasePointerCapture === "function") {
                try {
                    e.target.releasePointerCapture(e.pointerId);
                } catch (_error) { /* pointer was not captured */ }
            }
            if (handle && typeof handle.releasePointerCapture === "function" && e?.pointerId != null) {
                try {
                    handle.releasePointerCapture(e.pointerId);
                } catch (_error) { /* ignore */ }
            }
            // Clear global window event hooks to ensure the cursor is 100% liberated
            if (typeof window !== "undefined") {
                window.removeEventListener("mousemove", dragPanelLoop);
                window.removeEventListener("mouseup", handleWindowMouseUp);
                window.removeEventListener("mousemove", dragPanelLoop, true);
                window.removeEventListener("mouseup", handleWindowMouseUp, true);
                window.removeEventListener("pointermove", dragPanelLoop, true);
                window.removeEventListener("pointerup", handleWindowMouseUp, true);
                window.removeEventListener("pointercancel", handleWindowMouseUp, true);
            }
            const viewer = AnnotationAdapter.viewer;
            if (viewer) {
                if (typeof viewer.setMouseNavEnabled === "function") {
                    viewer.setMouseNavEnabled(true); // Guarantees pan/zoom navigation returns to the tissue canvas
                }
                if (viewer.gestureSettingsMouse) viewer.gestureSettingsMouse.scrollToZoom = true;
            }
        }

        const beginWindowDrag = event => {
            if (event.button != null && event.button !== 0) return;
            if (event.target?.closest?.(".fcp-close, .fcp-minimize")) return;
            const rect = palette.getBoundingClientRect?.() || { left: 0, top: 0 };
            const point = event?.touches?.[0] || event;
            AnnotationAdapter.isDraggingWindow = true;
            AnnotationAdapter.activeDraggingPanel = palette;
            palette._fcpDrag = {
                dx: Number(point.clientX) - rect.left,
                dy: Number(point.clientY) - rect.top
            };
            if (palette.dataset) palette.dataset.fcpUserMoved = "1";
            const viewer = AnnotationAdapter.viewer;
            if (viewer && typeof viewer.setMouseNavEnabled === "function") {
                viewer.setMouseNavEnabled(false);
            }
            if (typeof window !== "undefined") {
                window.addEventListener("mousemove", dragPanelLoop);
                window.addEventListener("mouseup", handleWindowMouseUp);
                window.addEventListener("mousemove", dragPanelLoop, true);
                window.addEventListener("mouseup", handleWindowMouseUp, true);
                window.addEventListener("pointermove", dragPanelLoop, true);
                window.addEventListener("pointerup", handleWindowMouseUp, true);
                window.addEventListener("pointercancel", handleWindowMouseUp, true);
            }
            if (typeof handle.setPointerCapture === "function" && event.pointerId != null) {
                try {
                    handle.setPointerCapture(event.pointerId);
                } catch (_error) { /* ignore */ }
            }
            event.preventDefault?.();
            event.stopPropagation?.();
        };

        handle.addEventListener("pointerdown", beginWindowDrag);
        handle.addEventListener("mousedown", beginWindowDrag);
        handle.addEventListener("pointerup", handleWindowMouseUp);
        handle.addEventListener("mouseup", handleWindowMouseUp);
        palette.addEventListener?.("pointerdown", event => event.stopPropagation());
        AnnotationAdapter.isolateFloatingPalettePointerEvents(palette);
        if (handle.dataset) handle.dataset.fcpDragBound = "1";
        return true;
    }

    static bindFloatingPaletteResize(palette) {
        if (!palette || palette.dataset?.fcpResizeBound === "1" || typeof ResizeObserver !== "function") {
            return false;
        }
        const canvas = palette.querySelector?.("#floating-channel-histogram");
        const observer = new ResizeObserver(() => {
            if (!canvas) return;
            const wrap = canvas.parentElement;
            const width = Math.max(80, Math.floor((wrap?.clientWidth || palette.clientWidth || 340) - 8));
            if (canvas.width !== width) {
                canvas.width = width;
                AnnotationAdapter.drawChannelPaletteHistogram(palette.ownerDocument);
            }
        });
        observer.observe(palette);
        if (palette.dataset) palette.dataset.fcpResizeBound = "1";
        return true;
    }

    static bindFloatingPaletteEdgeResize(palette) {
        if (!palette || palette.dataset?.fcpEdgeResizeBound === "1") return false;
        const handles = palette.querySelectorAll?.(".fcp-edge-handle");
        if (!handles || !handles.length) return false;
        const minWidth = 340;
        const minHeight = 400;

        const endEdgeResize = function endEdgeResize(event) {
            palette._fcpEdgeResize = null;
            AnnotationAdapter.isResizingWindow = false;
            if (event && event.target && typeof event.target.releasePointerCapture === "function") {
                try { event.target.releasePointerCapture(event.pointerId); } catch (_error) { /* ignore */ }
            }
            if (typeof window !== "undefined") {
                window.removeEventListener("mousemove", moveEdgeResize);
                window.removeEventListener("mouseup", endEdgeResize);
                window.removeEventListener("pointermove", moveEdgeResize, true);
                window.removeEventListener("pointerup", endEdgeResize, true);
                window.removeEventListener("pointercancel", endEdgeResize, true);
            }
            const viewer = AnnotationAdapter.viewer;
            if (viewer) {
                if (typeof viewer.setMouseNavEnabled === "function") viewer.setMouseNavEnabled(true);
                if (viewer.gestureSettingsMouse) viewer.gestureSettingsMouse.scrollToZoom = true;
            }
        };

        const moveEdgeResize = function moveEdgeResize(event) {
            const state = palette._fcpEdgeResize;
            if (!state || !palette.style) return;
            const point = event?.touches?.[0] || event;
            const dx = Number(point.clientX) - state.startX;
            const dy = Number(point.clientY) - state.startY;
            const edge = state.edge || "";
            let width = state.startW;
            let height = state.startH;
            let left = state.startL;
            let top = state.startT;
            if (edge.includes("e")) width = Math.max(minWidth, state.startW + dx);
            if (edge.includes("s")) height = Math.max(minHeight, state.startH + dy);
            if (edge.includes("w")) {
                width = Math.max(minWidth, state.startW - dx);
                left = state.startL + (state.startW - width);
            }
            if (edge.includes("n")) {
                height = Math.max(minHeight, state.startH - dy);
                top = state.startT + (state.startH - height);
            }
            palette.style.width = `${width}px`;
            palette.style.height = `${height}px`;
            palette.style.left = `${left}px`;
            palette.style.top = `${top}px`;
            palette.style.right = "auto";
            palette.style.bottom = "auto";
        };

        const beginEdgeResize = function beginEdgeResize(event) {
            if (event.button != null && event.button !== 0) return;
            const handle = event.currentTarget;
            const rect = palette.getBoundingClientRect?.() || { left: 0, top: 0, width: minWidth, height: minHeight };
            const point = event?.touches?.[0] || event;
            AnnotationAdapter.isResizingWindow = true;
            palette._fcpEdgeResize = {
                edge: String(handle?.dataset?.edge || ""),
                startX: Number(point.clientX),
                startY: Number(point.clientY),
                startW: rect.width,
                startH: rect.height,
                startL: rect.left,
                startT: rect.top
            };
            const viewer = AnnotationAdapter.viewer;
            if (viewer && typeof viewer.setMouseNavEnabled === "function") {
                viewer.setMouseNavEnabled(false);
            }
            if (typeof window !== "undefined") {
                window.addEventListener("mousemove", moveEdgeResize);
                window.addEventListener("mouseup", endEdgeResize);
                window.addEventListener("pointermove", moveEdgeResize, true);
                window.addEventListener("pointerup", endEdgeResize, true);
                window.addEventListener("pointercancel", endEdgeResize, true);
            }
            if (typeof handle.setPointerCapture === "function" && event.pointerId != null) {
                try { handle.setPointerCapture(event.pointerId); } catch (_error) { /* ignore */ }
            }
            event.preventDefault?.();
            event.stopPropagation?.();
        };

        Array.from(handles).forEach(handle => {
            if (!handle?.addEventListener) return;
            handle.addEventListener("pointerdown", beginEdgeResize);
            handle.addEventListener("mousedown", beginEdgeResize);
        });
        if (palette.dataset) palette.dataset.fcpEdgeResizeBound = "1";
        return true;
    }

    static formatChannelPaletteLabel(channel) {
        const lut = String(channel?.lut || "").trim().toUpperCase();
        const lutTitle = lut ? lut.charAt(0) + lut.slice(1).toLowerCase() : "";
        const epitope = String(AnnotationAdapter.compactChannelName(channel) || "").trim();
        if (lutTitle && epitope && epitope.toUpperCase() !== lut) {
            return `${lutTitle} (${epitope})`;
        }
        return epitope || lutTitle || `Ch ${channel?.index ?? 0}`;
    }

    static applyChannelPaletteLayout(layout, root = null) {
        const mode = ["1", "2", "3", "wrap"].includes(String(layout)) ? String(layout) : "1";
        AnnotationAdapter.channelPaletteLayout = mode;
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = AnnotationAdapter.resolvePaletteNode(doc);
        const grid = palette?.querySelector?.("#floating-channel-palette-rows")
            || doc?.getElementById?.("floating-channel-palette-rows");
        if (grid) {
            grid.dataset.fcpLayout = mode;
            if (typeof grid.setAttribute === "function") grid.setAttribute("data-fcp-layout", mode);
        }
        const select = palette?.querySelector?.("#fcp-layout-select")
            || doc?.getElementById?.("fcp-layout-select");
        if (select && select.value !== mode) select.value = mode;
        return mode;
    }

    static bindChannelListSplitter(palette) {
        if (!palette || palette.dataset?.fcpListSplitterBound === "1") return false;
        const splitter = palette.querySelector?.("#fcp-list-splitter");
        const grid = palette.querySelector?.("#floating-channel-palette-rows");
        if (!splitter?.addEventListener || !grid) return false;

        const endSplit = function endSplit(event) {
            palette._fcpListSplit = null;
            splitter.classList?.remove?.("is-dragging");
            if (event && event.target && typeof event.target.releasePointerCapture === "function") {
                try { event.target.releasePointerCapture(event.pointerId); } catch (_error) { /* ignore */ }
            }
            if (typeof window !== "undefined") {
                window.removeEventListener("mousemove", moveSplit);
                window.removeEventListener("mouseup", endSplit);
                window.removeEventListener("pointermove", moveSplit, true);
                window.removeEventListener("pointerup", endSplit, true);
                window.removeEventListener("pointercancel", endSplit, true);
            }
            const viewer = AnnotationAdapter.viewer;
            if (viewer && typeof viewer.setMouseNavEnabled === "function") {
                viewer.setMouseNavEnabled(true);
            }
        };

        const moveSplit = function moveSplit(event) {
            const state = palette._fcpListSplit;
            if (!state || !grid.style) return;
            const point = event?.touches?.[0] || event;
            const dy = Number(point.clientY) - state.startY;
            const minH = 72;
            const paletteH = palette.getBoundingClientRect?.().height || 400;
            const maxH = Math.max(minH, paletteH - 220);
            const next = Math.max(minH, Math.min(maxH, state.startH + dy));
            grid.style.height = `${next}px`;
            grid.style.setProperty?.("--fcp-list-height", `${next}px`);
        };

        const beginSplit = function beginSplit(event) {
            if (event.button != null && event.button !== 0) return;
            const rect = grid.getBoundingClientRect?.() || { height: 152 };
            const point = event?.touches?.[0] || event;
            palette._fcpListSplit = {
                startY: Number(point.clientY),
                startH: rect.height
            };
            splitter.classList?.add?.("is-dragging");
            const viewer = AnnotationAdapter.viewer;
            if (viewer && typeof viewer.setMouseNavEnabled === "function") {
                viewer.setMouseNavEnabled(false);
            }
            if (typeof window !== "undefined") {
                window.addEventListener("mousemove", moveSplit);
                window.addEventListener("mouseup", endSplit);
                window.addEventListener("pointermove", moveSplit, true);
                window.addEventListener("pointerup", endSplit, true);
                window.addEventListener("pointercancel", endSplit, true);
            }
            if (typeof splitter.setPointerCapture === "function" && event.pointerId != null) {
                try { splitter.setPointerCapture(event.pointerId); } catch (_error) { /* ignore */ }
            }
            event.preventDefault?.();
            event.stopPropagation?.();
        };

        splitter.addEventListener("pointerdown", beginSplit);
        splitter.addEventListener("mousedown", beginSplit);
        if (palette.dataset) palette.dataset.fcpListSplitterBound = "1";
        return true;
    }

    static bindChannelPaletteDrag(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = AnnotationAdapter.resolvePaletteNode(doc);
        const handle = palette?.querySelector?.("#floating-channel-palette-handle")
            || doc?.getElementById?.("floating-channel-palette-handle");
        if (!palette || !handle || handle.dataset?.fcpDragBound === "1") return false;
        return AnnotationAdapter.bindLiberatedPaletteDrag(handle, palette);
    }

    static bindChannelPaletteControls(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = AnnotationAdapter.resolvePaletteNode(doc);
        if (!palette || palette.dataset?.fcpControlsBound === "1") return false;
        const min = palette.querySelector?.("#fcp-min") || doc?.getElementById?.("fcp-min");
        const max = palette.querySelector?.("#fcp-max") || doc?.getElementById?.("fcp-max");
        const gamma = palette.querySelector?.("#fcp-gamma") || doc?.getElementById?.("fcp-gamma");
        const autoBtn = palette.querySelector?.("#fcp-auto") || doc?.getElementById?.("fcp-auto");
        const resetBtn = palette.querySelector?.("#fcp-reset") || doc?.getElementById?.("fcp-reset");
        const layoutSelect = palette.querySelector?.("#fcp-layout-select") || doc?.getElementById?.("fcp-layout-select");
        const onSlide = () => {
            AnnotationAdapter.applyChannelPaletteWindowFromSliders(doc, { live: true });
        };
        for (const input of [min, max, gamma]) {
            if (!input?.addEventListener) continue;
            input.addEventListener("input", onSlide);
        }
        autoBtn?.addEventListener?.("click", event => {
            event.preventDefault();
            const controller = AnnotationAdapter.displayController;
            if (typeof controller?.recomputeAuto === "function") controller.recomputeAuto();
        });
        resetBtn?.addEventListener?.("click", event => {
            event.preventDefault();
            const controller = AnnotationAdapter.displayController;
            if (typeof controller?.resetDisplay === "function") controller.resetDisplay();
        });
        layoutSelect?.addEventListener?.("change", event => {
            AnnotationAdapter.applyChannelPaletteLayout(event.target?.value || "1", doc);
        });
        if (palette.dataset) palette.dataset.fcpControlsBound = "1";
        return true;
    }

    static isFloatingChannelPaletteOpen(root = null) {
        const palette = AnnotationAdapter.resolvePaletteNode(root);
        return Boolean(palette && palette.parentNode && !palette.hidden);
    }

    static toggleFloatingChannelPalette(root = null) {
        if (AnnotationAdapter.isFloatingChannelPaletteOpen(root)) {
            return AnnotationAdapter.closeFloatingChannelPalette(root);
        }
        return AnnotationAdapter.openFloatingChannelPalette(root);
    }

    static launchBrightnessContrastPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const opened = AnnotationAdapter.toggleFloatingChannelPalette(doc);
        if (AnnotationAdapter.isFloatingChannelPaletteOpen(doc)) {
            AnnotationAdapter.positionFloatingChannelPalette(doc);
        }
        AnnotationAdapter.syncBrightnessContrastButtons(
            AnnotationAdapter.isFloatingChannelPaletteOpen(doc),
            doc
        );
        return opened;
    }

    static syncBrightnessContrastButtons(pressed, root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        if (!doc?.getElementById) return false;
        const on = pressed === true;
        for (const id of ["show-advanced-channel-palette", "qp-tool-contrast"]) {
            const button = doc.getElementById(id);
            if (button?.setAttribute) button.setAttribute("aria-pressed", String(on));
        }
        return true;
    }

    static bindBrightnessContrastLaunchers(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        if (!doc?.getElementById) return false;
        let bound = false;
        for (const id of ["show-advanced-channel-palette", "qp-tool-contrast"]) {
            const button = doc.getElementById(id);
            if (!button || button.dataset?.fcpToggleBound === "1") {
                if (button) bound = true;
                continue;
            }
            button.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                AnnotationAdapter.launchBrightnessContrastPalette(doc);
            });
            if (button.dataset) button.dataset.fcpToggleBound = "1";
            bound = true;
        }
        return bound;
    }

    static snapshotChannelPaletteSidebar(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const channels = doc?.getElementById?.("channels");
        const header = doc?.querySelector?.("#channels-panel > .panel-header");
        const actions = header?.querySelector?.(".display-actions");
        AnnotationAdapter.channelPaletteSidebarSnapshot = {
            channelsHidden: Boolean(channels?.hidden),
            headerHidden: Boolean(header?.hidden),
            actionsHidden: Boolean(actions?.hidden)
        };
        return AnnotationAdapter.channelPaletteSidebarSnapshot;
    }

    static restoreChannelPaletteSidebar(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const snapshot = AnnotationAdapter.channelPaletteSidebarSnapshot;
        if (!doc || !snapshot) return false;
        const channels = doc.getElementById?.("channels");
        const header = doc.querySelector?.("#channels-panel > .panel-header");
        const actions = header?.querySelector?.(".display-actions");
        if (channels) channels.hidden = snapshot.channelsHidden;
        if (header) header.hidden = snapshot.headerHidden;
        if (actions) actions.hidden = snapshot.actionsHidden;
        AnnotationAdapter.channelPaletteSidebarSnapshot = null;
        return true;
    }

    static openFloatingChannelPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = AnnotationAdapter.resolvePaletteNode(doc);
        if (!doc || !palette) return false;
        if (!AnnotationAdapter.channelPaletteSidebarSnapshot) {
            AnnotationAdapter.snapshotChannelPaletteSidebar(doc);
        }
        AnnotationAdapter.mountFloatingPaletteToBody(palette, doc);
        AnnotationAdapter.applyLiberatedFloatingStyle(palette, { minWidth: "340px", minHeight: "400px" });
        palette.hidden = false;
        palette.removeAttribute?.("hidden");
        if (palette.style) palette.style.display = "flex";
        palette.setAttribute("aria-hidden", "false");
        AnnotationAdapter.channelPaletteElement = palette;
        AnnotationAdapter.channelPaletteHost = doc.body || palette.parentNode;
        AnnotationAdapter.syncBrightnessContrastButtons(true, doc);
        AnnotationAdapter.bindAdvancedChannelPalette(doc);
        AnnotationAdapter.syncFloatingChannelPalette(doc);
        AnnotationAdapter.refreshChannelPaletteHistogram(doc);
        const zDepth = doc.getElementById?.("z-depth-controls");
        if (zDepth && !zDepth.hidden) {
            AnnotationAdapter.setFloatingZStackPaletteVisible(true, doc);
        }
        AnnotationAdapter.positionFloatingChannelPalette(doc);
        const measPalette = AnnotationAdapter.resolveMeasurementPaletteNode(doc);
        if (measPalette && measPalette.dataset?.fcpUserMoved !== "1"
            && AnnotationAdapter.isFloatingPaletteVisible(measPalette)) {
            AnnotationAdapter.positionFloatingMeasurementPalette(doc);
        }
        return true;
    }

    static closeFloatingChannelPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = AnnotationAdapter.resolvePaletteNode(doc);
        if (palette) {
            AnnotationAdapter.channelPaletteElement = palette;
            if (palette.parentNode) AnnotationAdapter.channelPaletteHost = palette.parentNode;
            palette.hidden = true;
            palette.setAttribute("aria-hidden", "true");
            if (palette.style) palette.style.display = "none";
            if (palette.parentNode) palette.parentNode.removeChild(palette);
        }
        AnnotationAdapter.clearViewportTileContrastFilter(
            AnnotationAdapter.displayController?.getViewer?.() || AnnotationAdapter.viewer
        );
        AnnotationAdapter.restoreChannelPaletteSidebar(doc);
        AnnotationAdapter.syncBrightnessContrastButtons(false, doc);
        return true;
    }

    static bindFloatingAiLabsPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        if (!doc?.getElementById) return null;
        const palette = doc.getElementById("floating-ai-labs-palette")
            || AnnotationAdapter.aiLabsPaletteElement;
        if (palette) AnnotationAdapter.aiLabsPaletteElement = palette;
        AnnotationAdapter.isolateFloatingPalettePointerEvents(palette);
        const toggle = doc.getElementById("toggle-ai-labs-palette");
        if (toggle && toggle.dataset?.fcpToggleBound !== "1") {
            toggle.addEventListener("click", event => {
                event.preventDefault();
                AnnotationAdapter.toggleFloatingAiLabsPalette(doc);
            });
            if (toggle.dataset) toggle.dataset.fcpToggleBound = "1";
        }
        const closeBtn = palette?.querySelector?.("#floating-ai-labs-close")
            || doc.getElementById("floating-ai-labs-close");
        if (closeBtn && closeBtn.dataset?.fcpCloseBound !== "1") {
            closeBtn.addEventListener("click", event => {
                event.preventDefault();
                AnnotationAdapter.closeFloatingAiLabsPalette(doc);
            });
            if (closeBtn.dataset) closeBtn.dataset.fcpCloseBound = "1";
        }
        const handle = palette?.querySelector?.("#floating-ai-labs-handle")
            || doc.getElementById("floating-ai-labs-handle");
        if (palette && handle) AnnotationAdapter.bindLiberatedPaletteDrag(handle, palette);
        AnnotationAdapter.isolateFloatingPalettePointerEvents(palette);
        return palette || toggle || null;
    }

    static isFloatingAiLabsOpen(root = null) {
        const palette = AnnotationAdapter.resolvePaletteRoot(root)?.getElementById?.("floating-ai-labs-palette")
            || AnnotationAdapter.aiLabsPaletteElement;
        return Boolean(palette && palette.parentNode && !palette.hidden);
    }

    static toggleFloatingAiLabsPalette(root = null) {
        if (AnnotationAdapter.isFloatingAiLabsOpen(root)) {
            return AnnotationAdapter.closeFloatingAiLabsPalette(root);
        }
        return AnnotationAdapter.openFloatingAiLabsPalette(root);
    }

    static openFloatingAiLabsPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = doc?.getElementById?.("floating-ai-labs-palette")
            || AnnotationAdapter.aiLabsPaletteElement;
        if (!doc || !palette) return false;
        AnnotationAdapter.mountFloatingPaletteToBody(palette, doc);
        AnnotationAdapter.applyLiberatedFloatingStyle(palette, { minWidth: "20rem", minHeight: "25rem" });
        palette.hidden = false;
        palette.removeAttribute?.("hidden");
        if (palette.style) palette.style.display = "flex";
        palette.setAttribute("aria-hidden", "false");
        AnnotationAdapter.aiLabsPaletteElement = palette;
        const toggle = doc.getElementById?.("toggle-ai-labs-palette");
        if (toggle) toggle.setAttribute("aria-pressed", "true");
        const aiLabs = doc.getElementById?.("ai-labs-panel");
        if (aiLabs) {
            aiLabs.hidden = false;
            aiLabs.classList?.add?.("show");
        }
        const aiAnalytics = doc.getElementById?.("ai-analytics-panel");
        if (aiAnalytics) {
            aiAnalytics.hidden = false;
            aiAnalytics.open = true;
        }
        AnnotationAdapter.bindFloatingAiLabsPalette(doc);
        return true;
    }

    static closeFloatingAiLabsPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = doc?.getElementById?.("floating-ai-labs-palette")
            || AnnotationAdapter.aiLabsPaletteElement;
        if (palette) {
            AnnotationAdapter.aiLabsPaletteElement = palette;
            palette.hidden = true;
            palette.setAttribute("aria-hidden", "true");
            if (palette.style) palette.style.display = "none";
            if (palette.parentNode) palette.parentNode.removeChild(palette);
        }
        const toggle = doc?.getElementById?.("toggle-ai-labs-palette");
        if (toggle) toggle.setAttribute("aria-pressed", "false");
        const aiLabs = doc?.getElementById?.("ai-labs-panel") || palette?.querySelector?.("#ai-labs-panel");
        if (aiLabs) aiLabs.classList?.remove?.("show");
        return true;
    }

    static bindFloatingAdminPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        if (!doc?.getElementById) return null;
        const palette = doc.getElementById("floating-admin-palette")
            || AnnotationAdapter.adminPaletteElement;
        if (palette) AnnotationAdapter.adminPaletteElement = palette;
        const toggle = doc.getElementById("workstation-admin-tools-btn");
        if (toggle && toggle.dataset?.fcpToggleBound !== "1") {
            toggle.addEventListener("click", event => {
                event.preventDefault();
                AnnotationAdapter.toggleFloatingAdminPalette(doc);
            });
            if (toggle.dataset) toggle.dataset.fcpToggleBound = "1";
        }
        const closeBtn = palette?.querySelector?.("#floating-admin-close")
            || doc.getElementById("floating-admin-close");
        if (closeBtn && closeBtn.dataset?.fcpCloseBound !== "1") {
            closeBtn.addEventListener("click", event => {
                event.preventDefault();
                AnnotationAdapter.closeFloatingAdminPalette(doc);
            });
            if (closeBtn.dataset) closeBtn.dataset.fcpCloseBound = "1";
        }
        const handle = palette?.querySelector?.("#floating-admin-handle")
            || doc.getElementById("floating-admin-handle");
        if (palette && handle) AnnotationAdapter.bindLiberatedPaletteDrag(handle, palette);
        AnnotationAdapter.isolateFloatingPalettePointerEvents(palette);
        return palette || toggle || null;
    }

    static toggleFloatingAdminPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = doc?.getElementById?.("floating-admin-palette")
            || AnnotationAdapter.adminPaletteElement;
        const open = Boolean(palette && palette.parentNode && !palette.hidden);
        return open
            ? AnnotationAdapter.closeFloatingAdminPalette(doc)
            : AnnotationAdapter.openFloatingAdminPalette(doc);
    }

    static openFloatingAdminPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = doc?.getElementById?.("floating-admin-palette")
            || AnnotationAdapter.adminPaletteElement;
        if (!doc || !palette) return false;
        AnnotationAdapter.mountFloatingPaletteToBody(palette, doc);
        AnnotationAdapter.applyLiberatedFloatingStyle(palette, { minWidth: "17.5rem", minHeight: "25rem" });
        palette.hidden = false;
        palette.removeAttribute?.("hidden");
        if (palette.style) palette.style.display = "flex";
        palette.setAttribute("aria-hidden", "false");
        AnnotationAdapter.adminPaletteElement = palette;
        const toggle = doc.getElementById?.("workstation-admin-tools-btn");
        if (toggle) toggle.setAttribute("aria-pressed", "true");
        AnnotationAdapter.bindFloatingAdminPalette(doc);
        return true;
    }

    static closeFloatingAdminPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = doc?.getElementById?.("floating-admin-palette")
            || AnnotationAdapter.adminPaletteElement;
        if (palette) {
            AnnotationAdapter.adminPaletteElement = palette;
            palette.hidden = true;
            palette.setAttribute("aria-hidden", "true");
            if (palette.style) palette.style.display = "none";
            if (palette.parentNode) palette.parentNode.removeChild(palette);
        }
        const toggle = doc?.getElementById?.("workstation-admin-tools-btn");
        if (toggle) toggle.setAttribute("aria-pressed", "false");
        return true;
    }

    static resolveZStackPaletteNode(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        return doc?.getElementById?.("floating-zstack-palette") || AnnotationAdapter.zStackPaletteElement || null;
    }

    static bindFloatingZStackPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        if (!doc?.getElementById) return null;
        const palette = AnnotationAdapter.resolveZStackPaletteNode(doc);
        if (palette) AnnotationAdapter.zStackPaletteElement = palette;
        const closeBtn = palette?.querySelector?.("#floating-zstack-close")
            || doc.getElementById("floating-zstack-close");
        if (closeBtn && closeBtn.dataset?.fcpCloseBound !== "1") {
            closeBtn.addEventListener("click", event => {
                event.preventDefault();
                AnnotationAdapter.setFloatingZStackPaletteVisible(false, doc);
            });
            if (closeBtn.dataset) closeBtn.dataset.fcpCloseBound = "1";
        }
        const minimizeBtn = palette?.querySelector?.("#floating-zstack-minimize")
            || doc.getElementById("floating-zstack-minimize");
        if (minimizeBtn && minimizeBtn.dataset?.zstackMinBound !== "1") {
            minimizeBtn.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                AnnotationAdapter.toggleFloatingZStackMinimized(doc);
            });
            if (minimizeBtn.dataset) minimizeBtn.dataset.zstackMinBound = "1";
        }
        const handle = palette?.querySelector?.("#floating-zstack-handle")
            || doc.getElementById("floating-zstack-handle");
        if (palette && handle) AnnotationAdapter.bindLiberatedPaletteDrag(handle, palette);
        AnnotationAdapter.isolateFloatingPalettePointerEvents(palette);
        if (palette) AnnotationAdapter.mountFloatingPaletteToBody(palette, doc);
        return palette || null;
    }

    static positionZStackPaletteUpperLeft(palette, root = null) {
        const zStackPalette = palette || AnnotationAdapter.resolveZStackPaletteNode(root);
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        if (!zStackPalette?.style || !doc?.getElementById) return false;
        const viewerHost = doc.getElementById("openseadragon-viewer")
            || (typeof document !== "undefined" ? document.getElementById("openseadragon-viewer") : null)
            || doc.getElementById("viewer")
            || AnnotationAdapter.viewer?.element
            || AnnotationAdapter.viewer?.container
            || null;
        if (!viewerHost || typeof viewerHost.getBoundingClientRect !== "function") return false;
        let viewerRect = viewerHost.getBoundingClientRect();
        zStackPalette.style.left = (viewerRect.left + 10) + "px";
        zStackPalette.style.top = (viewerRect.top + 10) + "px";
        zStackPalette.style.right = "auto";
        zStackPalette.style.bottom = "auto";
        return true;
    }

    static setFloatingZStackPaletteVisible(visible, root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = AnnotationAdapter.resolveZStackPaletteNode(doc);
        if (!palette) return false;
        AnnotationAdapter.zStackPaletteElement = palette;
        AnnotationAdapter.bindFloatingZStackPalette(doc);
        if (visible) {
            AnnotationAdapter.mountFloatingPaletteToBody(palette, doc);
            AnnotationAdapter.applyLiberatedFloatingStyle(palette, { minWidth: "17.5rem", minHeight: "10rem" });
            palette.classList?.remove?.("zstack-minimized");
            palette.hidden = false;
            palette.removeAttribute?.("hidden");
            palette.setAttribute?.("aria-hidden", "false");
            if (palette.style) {
                palette.style.display = "block";
                palette.style.maxHeight = "none";
                palette.style.minHeight = "10rem";
            }
            AnnotationAdapter.positionZStackPaletteUpperLeft(palette, doc);
            AnnotationAdapter.syncFloatingZStackMinimizedUi(palette, doc);
            return true;
        }
        palette.hidden = true;
        palette.setAttribute?.("aria-hidden", "true");
        if (palette.style) palette.style.display = "none";
        return true;
    }

    static resolveMeasurementPaletteNode(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        return doc?.getElementById?.("floating-measurement-palette")
            || AnnotationAdapter.measurementPaletteElement
            || null;
    }

    static bindFloatingMeasurementPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        if (!doc?.getElementById) return null;
        const palette = AnnotationAdapter.resolveMeasurementPaletteNode(doc);
        if (palette) AnnotationAdapter.measurementPaletteElement = palette;
        AnnotationAdapter.isolateFloatingPalettePointerEvents(palette);
        const closeBtn = palette?.querySelector?.("#floating-measurement-close")
            || doc.getElementById("floating-measurement-close");
        if (closeBtn && closeBtn.dataset?.fcpCloseBound !== "1") {
            closeBtn.addEventListener("click", event => {
                event.preventDefault();
                AnnotationAdapter.closeFloatingMeasurementPalette(doc);
            });
            if (closeBtn.dataset) closeBtn.dataset.fcpCloseBound = "1";
        }
        const handle = palette?.querySelector?.("#floating-measurement-handle")
            || doc.getElementById("floating-measurement-handle");
        if (palette && handle) AnnotationAdapter.bindLiberatedPaletteDrag(handle, palette);
        const copyBtn = palette?.querySelector?.("#copy-all-measurements-btn")
            || palette?.querySelector?.("#measurement-copy-btn")
            || doc.getElementById("copy-all-measurements-btn")
            || doc.getElementById("measurement-copy-btn");
        if (copyBtn && copyBtn.dataset?.measureCopyBound !== "1") {
            copyBtn.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                AnnotationAdapter.copyMeasurementResults(doc);
                AnnotationAdapter.releaseMeasurementDrawingAfterExport();
            });
            if (copyBtn.dataset) copyBtn.dataset.measureCopyBound = "1";
        }
        const saveBtn = palette?.querySelector?.("#download-measurements-btn")
            || palette?.querySelector?.("#measurement-save-btn")
            || doc.getElementById("download-measurements-btn")
            || doc.getElementById("measurement-save-btn");
        if (saveBtn && saveBtn.dataset?.measureSaveBound !== "1") {
            saveBtn.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                AnnotationAdapter.saveMeasurementResults(doc);
                AnnotationAdapter.releaseMeasurementDrawingAfterExport();
            });
            if (saveBtn.dataset) saveBtn.dataset.measureSaveBound = "1";
        }
        if (palette) AnnotationAdapter.mountFloatingPaletteToBody(palette, doc);
        return palette || null;
    }

    static openFloatingMeasurementPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = AnnotationAdapter.resolveMeasurementPaletteNode(doc);
        if (!palette) return false;
        AnnotationAdapter.measurementPaletteElement = palette;
        const wasHidden = Boolean(palette.hidden)
            || palette.style?.display === "none"
            || palette.style?.display === ""
            || palette.style?.display == null;
        AnnotationAdapter.bindFloatingMeasurementPalette(doc);
        AnnotationAdapter.mountFloatingPaletteToBody(palette, doc);
        AnnotationAdapter.applyLiberatedFloatingStyle(palette, {
            minWidth: "21.25rem",
            minHeight: "12.5rem",
            zIndex: "9998"
        });
        if (palette.style) {
            palette.style.background = "#111";
            palette.style.color = "#fff";
            palette.style.border = "1px solid #444";
            palette.style.borderRadius = "0.5rem";
            palette.style.boxShadow = "0 0.25rem 0.75rem rgba(0,0,0,0.5)";
            palette.style.display = "block";
            palette.style.zIndex = "9998";
        }
        palette.hidden = false;
        palette.removeAttribute?.("hidden");
        palette.setAttribute?.("aria-hidden", "false");
        if (wasHidden) AnnotationAdapter.positionFloatingMeasurementPalette(doc);
        return true;
    }

    /**
     * Viewer-fixed launch origin: getBoundingClientRect of the OSD host plus 10px.
     * Same method as the Z-stack palette (not offsetParent cascade).
     */
    static viewerClientLaunchOrigin(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        if (!doc?.getElementById) return null;
        const viewerEl = doc.getElementById("openseadragon-viewer")
            || (typeof document !== "undefined" ? document.getElementById("openseadragon-viewer") : null)
            || doc.getElementById("viewer")
            || AnnotationAdapter.viewer?.element
            || AnnotationAdapter.viewer?.container
            || null;
        if (!viewerEl || typeof viewerEl.getBoundingClientRect !== "function") {
            return { left: 10, top: 10, viewerEl, doc };
        }
        const viewerRect = viewerEl.getBoundingClientRect();
        return {
            left: Number(viewerRect.left) + 10,
            top: Number(viewerRect.top) + 10,
            viewerEl,
            viewerRect,
            doc
        };
    }

    /**
     * Compact launch origin: upper-left of `#openseadragon-viewer` plus 15px,
     * using cascaded offsetParent geometry.
     */
    static viewerStageLaunchOrigin(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        if (!doc?.getElementById) return null;
        let viewerEl = doc.getElementById("openseadragon-viewer")
            || (typeof document !== "undefined" ? document.getElementById("openseadragon-viewer") : null)
            || doc.getElementById("viewer")
            || AnnotationAdapter.viewer?.element
            || AnnotationAdapter.viewer?.container
            || null;
        let left = 15;
        let top = 15;
        if (viewerEl) {
            left = viewerEl.offsetLeft + 15;
            top = viewerEl.offsetTop + 15;
            let offsetParent = viewerEl.offsetParent;
            while (offsetParent) {
                left += Number(offsetParent.offsetLeft) || 0;
                top += Number(offsetParent.offsetTop) || 0;
                offsetParent = offsetParent.offsetParent;
            }
        }
        return { left, top, viewerEl, doc };
    }

    static isFloatingPaletteVisible(el) {
        if (!el) return false;
        if (el.hidden) return false;
        if (el.style?.display === "none" || el.style?.visibility === "hidden") return false;
        if (el.getAttribute?.("aria-hidden") === "true") return false;
        return true;
    }

    static floatingPaletteBox(el, fallbackWidth = 340, fallbackHeight = 200) {
        if (!el) return null;
        const left = Number(el.offsetLeft) || parseFloat(el.style?.left) || 0;
        const top = Number(el.offsetTop) || parseFloat(el.style?.top) || 0;
        const width = Number(el.offsetWidth) || parseFloat(el.style?.width) || fallbackWidth;
        const height = Number(el.offsetHeight) || parseFloat(el.style?.height) || fallbackHeight;
        return { left, top, width, height };
    }

    static palettesOverlap(a, b) {
        if (!a || !b) return false;
        return a.left < b.left + b.width
            && a.left + a.width > b.left
            && a.top < b.top + b.height
            && a.top + a.height > b.top;
    }

    static floatingPaletteClientBox(el, fallbackWidth = 340, fallbackHeight = 200) {
        if (el && typeof el.getBoundingClientRect === "function") {
            try {
                const rect = el.getBoundingClientRect();
                if (rect && Number(rect.width) > 0 && Number(rect.height) > 0) {
                    return {
                        left: Number(rect.left),
                        top: Number(rect.top),
                        width: Number(rect.width),
                        height: Number(rect.height)
                    };
                }
            } catch (_error) { /* fall through to offset box */ }
        }
        return AnnotationAdapter.floatingPaletteBox(el, fallbackWidth, fallbackHeight);
    }

    /**
     * Collision-aware tiling with viewport clamping. Cascades below occupants,
     * then wraps into a new column when the box would clip the bottom edge,
     * and finally clamps to the visible browser window.
     */
    static getAntiOverlapPosition(defaultLeft, defaultTop, width, height, currentPanelId, root = null) {
        let panel = null;
        let left0 = defaultLeft;
        let top0 = defaultTop;
        let boxW = width;
        let boxH = height;
        let panelId = currentPanelId;
        let scope = root;
        if (defaultLeft && typeof defaultLeft === "object") {
            panel = defaultLeft;
            left0 = defaultTop;
            top0 = width;
            scope = height && typeof height === "object" ? height : root;
            panelId = panel.id || "";
            boxW = Number(panel.offsetWidth) || parseFloat(panel.style?.width) || 380;
            boxH = Number(panel.offsetHeight) || parseFloat(panel.style?.height) || 200;
        }

        const document = (scope && (typeof scope.querySelectorAll === "function" || typeof scope.getElementById === "function"))
            ? scope
            : AnnotationAdapter.resolvePaletteRoot(scope)
                || (typeof globalThis !== "undefined" && globalThis.document)
                || null;

        function getAntiOverlapPosition(defaultLeft, defaultTop, width, height, currentPanelId) {
            let finalLeft = defaultLeft;
            let finalTop = defaultTop;
            let overlapDetected = true;
            let safetyCounter = 0;

            // Get the current usable viewport limits (excluding edges)
            let maxViewportWidth = window.innerWidth - 20;
            let maxViewportHeight = window.innerHeight - 20;
            if (!Number.isFinite(maxViewportWidth) || maxViewportWidth <= 0) maxViewportWidth = 1900;
            if (!Number.isFinite(maxViewportHeight) || maxViewportHeight <= 0) maxViewportHeight = 1060;

            // Target all active visible floating panels
            let activePanels = [];
            if (document && typeof document.querySelectorAll === "function") {
                activePanels = Array.from(document.querySelectorAll('.floating-palette, [id^="floating-"], #floating-zstack-palette, #slide-overview'))
                    .filter(p => p !== panel && p.id !== currentPanelId && p.style.display !== 'none' && p.style.visibility !== 'hidden' && !p.hidden);
            } else if (document && typeof document.getElementById === "function") {
                const ids = [
                    "floating-channel-palette",
                    "floating-ai-labs-palette",
                    "floating-admin-palette",
                    "floating-zstack-palette",
                    "floating-measurement-palette",
                    "floating-wand-palette",
                    "slide-overview"
                ];
                activePanels = ids
                    .filter(id => id !== currentPanelId)
                    .map(id => document.getElementById(id))
                    .filter(p => p && p !== panel && p.id !== currentPanelId && p.style?.display !== "none" && p.style?.visibility !== "hidden");
            }

            while (overlapDetected && safetyCounter < 15) {
                overlapDetected = false;
                let currentRect = { left: finalLeft, top: finalTop, right: finalLeft + width, bottom: finalTop + height };

                // 1. Viewport Edge Boundary Enforcement: If a cascade pushes the box past the bottom screen edge, wrap it horizontally
                if (currentRect.bottom > maxViewportHeight) {
                    finalTop = defaultTop; // Reset to top vertical level
                    finalLeft += 240;      // Step rightward into a clean secondary column layout
                    overlapDetected = true;
                    safetyCounter++;
                    continue;
                }

                // 2. Window Intersection Detection Loop
                for (let occupant of activePanels) {
                    let r = null;
                    try {
                        r = typeof occupant.getBoundingClientRect === "function"
                            ? occupant.getBoundingClientRect()
                            : null;
                    } catch (_error) {
                        r = null;
                    }
                    if (!r || !Number.isFinite(Number(r.left))) {
                        const box = AnnotationAdapter.floatingPaletteClientBox(occupant);
                        if (!box) continue;
                        r = {
                            left: box.left,
                            top: box.top,
                            right: box.left + box.width,
                            bottom: box.top + box.height
                        };
                    }
                    if (!(currentRect.right < r.left || currentRect.left > r.right ||
                          currentRect.bottom < r.top || currentRect.top > r.bottom)) {
                        overlapDetected = true;
                        // Cascade down directly below this colliding block
                        finalTop = r.bottom + 12;
                        break;
                    }
                }
                safetyCounter++;
            }

            // Final Hard Safety Clamping Guard
            if (finalLeft + width > maxViewportWidth) finalLeft = maxViewportWidth - width;
            if (finalTop + height > maxViewportHeight) finalTop = maxViewportHeight - height;
            if (finalLeft < 0) finalLeft = 10;
            if (finalTop < 0) finalTop = 10;

            return { left: finalLeft, top: finalTop };
        }

        return getAntiOverlapPosition(
            Number(left0) || 0,
            Number(top0) || 0,
            Number(boxW) || 380,
            Number(boxH) || 200,
            String(panelId || "")
        );
    }

    /**
     * Enrolls the persistent "Slide Overview" thumbnail-navigator window into
     * the same anti-overlap cascade as the floating palettes, so opening it
     * never stacks it directly on top of an already-open palette (and vice
     * versa, since getAntiOverlapPosition's occupant scan also includes
     * #slide-overview). Uses the viewport-relative origin helper because the
     * window is position:fixed, matching the other floating palettes.
     */
    static positionSlideOverviewWindow(root = null) {
        const origin = AnnotationAdapter.viewerClientLaunchOrigin(root);
        if (!origin) return false;
        const doc = origin.doc;
        const panel = doc?.getElementById?.("slide-overview");
        if (!panel?.style) return false;
        const width = Number(panel.offsetWidth) || parseFloat(panel.style?.width) || 440;
        const height = Number(panel.offsetHeight) || parseFloat(panel.style?.height) || 300;
        const cascaded = AnnotationAdapter.getAntiOverlapPosition(
            origin.left,
            origin.top,
            width,
            height,
            "slide-overview",
            doc
        );
        panel.style.left = `${cascaded.left}px`;
        panel.style.top = `${cascaded.top}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        return true;
    }

    static positionFloatingChannelPalette(root = null) {
        const origin = AnnotationAdapter.viewerClientLaunchOrigin(root);
        if (!origin) return false;
        const palette = AnnotationAdapter.resolvePaletteNode(origin.doc);
        if (!palette?.style) return false;
        const width = Number(palette.offsetWidth) || parseFloat(palette.style?.width) || 340;
        const height = Number(palette.offsetHeight) || parseFloat(palette.style?.height) || 400;
        const cascaded = AnnotationAdapter.getAntiOverlapPosition(
            origin.left,
            origin.top,
            width,
            height,
            palette.id || "floating-channel-palette",
            origin.doc
        );
        palette.style.left = `${cascaded.left}px`;
        palette.style.top = `${cascaded.top}px`;
        palette.style.right = "auto";
        palette.style.bottom = "auto";
        if (palette.dataset) palette.dataset.fcpCompactLaunch = "1";
        return true;
    }

    /**
     * Upper-left of the image container, or stacked under an open Z-stack palette.
     * Uses cascaded offsetParent geometry (not getBoundingClientRect / body view rect).
     * Same path for fluorescence and brightfield.
     */
    static positionFloatingMeasurementPalette(root = null) {
        const origin = AnnotationAdapter.viewerStageLaunchOrigin(root);
        if (!origin) return false;
        const doc = origin.doc;
        let targetLeft = origin.left;
        let targetTop = origin.top;

        let zStack = doc.getElementById("floating-zstack-palette");
        if (zStack && zStack.style.display !== "none" && zStack.style.visibility !== "hidden") {
            const zOpen = !zStack.hidden
                && zStack.getAttribute?.("aria-hidden") !== "true"
                && (Number(zStack.offsetHeight) || 0) > 0;
            if (zOpen) {
                // If Z-controls are open, stack the measurements box perfectly aligned underneath its bottom edge border line
                targetTop = zStack.offsetTop + zStack.offsetHeight + 15;
                targetLeft = zStack.offsetLeft;
            }
        }

        let measPalette = doc.getElementById("floating-measurement-palette")
            || AnnotationAdapter.measurementPaletteElement;
        const bcPalette = doc.getElementById("floating-channel-palette")
            || AnnotationAdapter.channelPaletteElement;
        if (bcPalette && AnnotationAdapter.isFloatingPaletteVisible(bcPalette) && measPalette) {
            const measBox = {
                left: targetLeft,
                top: targetTop,
                width: Number(measPalette.offsetWidth) || parseFloat(measPalette.style?.width) || 380,
                height: Number(measPalette.offsetHeight) || parseFloat(measPalette.style?.height) || 200
            };
            const bcBox = AnnotationAdapter.floatingPaletteBox(bcPalette, 340, 400);
            if (AnnotationAdapter.palettesOverlap(measBox, bcBox)) {
                // Overlap Collide Detected! Cascade Saved Measurements cleanly below B&C.
                targetTop = bcBox.top + bcBox.height + 15;
                targetLeft = bcBox.left;
            }
        }
        if (measPalette) {
            const width = Number(measPalette.offsetWidth) || parseFloat(measPalette.style?.width) || 380;
            const height = Number(measPalette.offsetHeight) || parseFloat(measPalette.style?.height) || 200;
            const cascaded = AnnotationAdapter.getAntiOverlapPosition(
                targetLeft,
                targetTop,
                width,
                height,
                measPalette.id || "floating-measurement-palette",
                doc
            );
            targetLeft = cascaded.left;
            targetTop = cascaded.top;
        }

        if (!measPalette?.style) return false;
        measPalette.style.left = targetLeft + "px";
        measPalette.style.top = targetTop + "px";
        measPalette.style.right = "auto";
        measPalette.style.bottom = "auto";
        return true;
    }

    static closeFloatingMeasurementPalette(root = null) {
        const palette = AnnotationAdapter.resolveMeasurementPaletteNode(root);
        if (!palette) return false;
        AnnotationAdapter.measurementPaletteElement = palette;
        palette.hidden = true;
        palette.setAttribute?.("aria-hidden", "true");
        if (palette.style) palette.style.display = "none";
        return true;
    }

    static toggleFloatingZStackMinimized(root = null) {
        const palette = AnnotationAdapter.resolveZStackPaletteNode(root);
        if (!palette?.classList) return false;
        palette.classList.toggle("zstack-minimized");
        return AnnotationAdapter.syncFloatingZStackMinimizedUi(palette, root);
    }

    static syncFloatingZStackMinimizedUi(palette = null, root = null) {
        const node = palette || AnnotationAdapter.resolveZStackPaletteNode(root);
        if (!node) return false;
        const minimized = Boolean(node.classList?.contains?.("zstack-minimized"));
        const body = node.querySelector?.(".fcp-body");
        if (node.style) {
            node.style.maxHeight = minimized ? "2rem" : "none";
            node.style.minHeight = minimized ? "2rem" : "10rem";
            node.style.overflow = "hidden";
            if (!minimized && node.style.display === "none") {
                node.style.display = "block";
            }
        }
        if (body?.style) {
            body.style.maxHeight = minimized ? "0px" : "none";
            body.style.overflow = "hidden";
            if (body.style.display === "none") body.style.display = "";
        }
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const btn = node.querySelector?.("#floating-zstack-minimize")
            || doc?.getElementById?.("floating-zstack-minimize");
        if (btn) {
            btn.setAttribute("aria-pressed", String(minimized));
            btn.setAttribute("title", minimized ? "Expand" : "Minimize");
            btn.setAttribute("aria-label", minimized ? "Expand Z-stack controls" : "Minimize Z-stack controls");
            btn.textContent = "-";
        }
        return true;
    }

    static formatChannelLevel(value) {
        return Math.round(Number(value) || 0).toLocaleString();
    }

    static escapePaletteHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, ch => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[ch]));
    }

    static channelPaletteColor(channel) {
        const lut = String(channel?.lut || "").toUpperCase();
        return AnnotationAdapter.CHANNEL_PALETTE_LUT_COLORS[lut] || "#888";
    }

    static syncFloatingChannelPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = AnnotationAdapter.resolvePaletteNode(doc);
        if (!palette) return false;
        const channels = AnnotationAdapter.paletteChannelList();
        if (AnnotationAdapter.channelPaletteSelectedIndex >= channels.length) {
            AnnotationAdapter.channelPaletteSelectedIndex = 0;
        }
        const body = palette.querySelector?.("#floating-channel-palette-rows")
            || doc?.getElementById?.("floating-channel-palette-rows");
        if (body && typeof body.replaceChildren === "function") {
            const owner = palette.ownerDocument || doc;
            const rows = channels.map((channel, index) => {
                const row = owner.createElement("div");
                row.className = index === AnnotationAdapter.channelPaletteSelectedIndex
                    ? "bc-channel-cell is-selected"
                    : "bc-channel-cell";
                row.dataset.channelIndex = String(channel.index ?? index);
                const color = AnnotationAdapter.channelPaletteColor(channel);
                const name = AnnotationAdapter.escapePaletteHtml(
                    AnnotationAdapter.formatChannelPaletteLabel(channel)
                );
                row.innerHTML = `
                    <input type="checkbox" class="floating-channel-cb" data-fcp-visible ${channel.visible !== false ? "checked" : ""} aria-label="Toggle ${name}">
                    <span class="fcp-swatch" style="background:${color}"></span>
                    <span class="bc-channel-name" style="color:${color}">${name}</span>
                    <span class="bc-channel-range">${AnnotationAdapter.formatChannelLevel(channel.black)} – ${AnnotationAdapter.formatChannelLevel(channel.white)}</span>
                `;
                row.addEventListener("click", event => {
                    if (event.target?.closest?.("input, .floating-channel-cb")) return;
                    AnnotationAdapter.channelPaletteSelectedIndex = index;
                    AnnotationAdapter.syncFloatingChannelPalette(doc);
                    AnnotationAdapter.refreshChannelPaletteHistogram(doc);
                });
                const checkbox = row.querySelector("input[data-fcp-visible]");
                checkbox?.addEventListener("change", () => {
                    AnnotationAdapter.applyChannelPaletteVisibility(index, checkbox.checked, doc);
                });
                return row;
            });
            body.replaceChildren(...rows);
        }
        const selected = AnnotationAdapter.paletteSelectedChannel();
        if (selected) {
            const min = palette.querySelector?.("#fcp-min") || doc?.getElementById?.("fcp-min");
            const max = palette.querySelector?.("#fcp-max") || doc?.getElementById?.("fcp-max");
            const gamma = palette.querySelector?.("#fcp-gamma") || doc?.getElementById?.("fcp-gamma");
            const minOut = palette.querySelector?.("#fcp-min-value") || doc?.getElementById?.("fcp-min-value");
            const maxOut = palette.querySelector?.("#fcp-max-value") || doc?.getElementById?.("fcp-max-value");
            const gammaOut = palette.querySelector?.("#fcp-gamma-value") || doc?.getElementById?.("fcp-gamma-value");
            const scaleMax = AnnotationAdapter.channelLevelScale();
            if (min) {
                min.max = String(scaleMax);
                min.value = String(Math.max(0, Math.min(scaleMax, Number(selected.black) || 0)));
            }
            if (max) {
                max.max = String(scaleMax);
                max.value = String(Math.max(1, Math.min(scaleMax, Number(selected.white) || scaleMax)));
            }
            if (gamma) gamma.value = String(Number(selected.gamma) || 1);
            if (minOut) minOut.textContent = AnnotationAdapter.formatChannelLevel(min?.value || selected.black);
            if (maxOut) maxOut.textContent = AnnotationAdapter.formatChannelLevel(max?.value || selected.white);
            if (gammaOut) gammaOut.textContent = Number(gamma?.value || selected.gamma || 1).toFixed(2);
            const scaleMinLabel = palette.querySelector?.("#fcp-scale-min") || doc?.getElementById?.("fcp-scale-min");
            const scaleMaxLabel = palette.querySelector?.("#fcp-scale-max") || doc?.getElementById?.("fcp-scale-max");
            if (scaleMinLabel) scaleMinLabel.textContent = "0";
            if (scaleMaxLabel) scaleMaxLabel.textContent = AnnotationAdapter.formatChannelLevel(scaleMax);
            AnnotationAdapter.drawChannelPaletteHistogram(doc);
        }
        return true;
    }

    static applyChannelPaletteVisibility(index, visible, root = null) {
        const channels = AnnotationAdapter.paletteChannelList();
        const channel = channels[index];
        if (!channel) return false;
        const groupKey = AnnotationAdapter.channelVisibilityGroupKey(channel);
        for (const peer of channels) {
            if (AnnotationAdapter.channelVisibilityGroupKey(peer) !== groupKey) continue;
            peer.visible = Boolean(visible);
        }
        const viewer = AnnotationAdapter.displayController?.getViewer?.() || AnnotationAdapter.viewer;
        if (viewer?.world && typeof viewer.world.getItemAt === "function") {
            AnnotationAdapter.applyChannelLayerOpacities(
                viewer,
                channels,
                AnnotationAdapter.displayController?.getCurrentZ?.()
            );
        }
        AnnotationAdapter.applyViewportChannelDisplayFilter(viewer);
        AnnotationAdapter.displayController?.syncChannelControls?.();
        AnnotationAdapter.displayController?.scheduleDisplayUpdate?.({ reopen: false });
        AnnotationAdapter.syncFloatingChannelPalette(root);
        return true;
    }

    static readChannelPaletteSliders(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = AnnotationAdapter.resolvePaletteNode(doc);
        const scaleMax = AnnotationAdapter.channelLevelScale();
        let min = parseFloat(palette?.querySelector?.("#fcp-min")?.value
            ?? doc?.getElementById?.("fcp-min")?.value
            ?? 0);
        let max = parseFloat(palette?.querySelector?.("#fcp-max")?.value
            ?? doc?.getElementById?.("fcp-max")?.value
            ?? scaleMax);
        let gamma = parseFloat(palette?.querySelector?.("#fcp-gamma")?.value
            ?? doc?.getElementById?.("fcp-gamma")?.value
            ?? 1);
        if (!Number.isFinite(min)) min = 0;
        if (!Number.isFinite(max)) max = scaleMax;
        if (!Number.isFinite(gamma) || gamma <= 0) gamma = 1;
        min = Math.max(0, Math.min(scaleMax - 1, min));
        max = Math.max(min + (1 / scaleMax), Math.min(scaleMax, max));
        gamma = Math.max(0.2, Math.min(4, gamma));
        return { min, max, gamma };
    }

    static applyChannelPaletteWindowFromSliders(root = null, options = {}) {
        const { min, max, gamma } = AnnotationAdapter.readChannelPaletteSliders(root);
        const channel = AnnotationAdapter.paletteSelectedChannel();
        if (channel) {
            channel.black = min;
            channel.white = max;
            channel.gamma = gamma;
        }
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = AnnotationAdapter.resolvePaletteNode(doc);
        const minOut = palette?.querySelector?.("#fcp-min-value") || doc?.getElementById?.("fcp-min-value");
        const maxOut = palette?.querySelector?.("#fcp-max-value") || doc?.getElementById?.("fcp-max-value");
        const gammaOut = palette?.querySelector?.("#fcp-gamma-value") || doc?.getElementById?.("fcp-gamma-value");
        if (minOut) minOut.textContent = AnnotationAdapter.formatChannelLevel(min);
        if (maxOut) maxOut.textContent = AnnotationAdapter.formatChannelLevel(max);
        if (gammaOut) gammaOut.textContent = Number(gamma).toFixed(2);
        const viewer = AnnotationAdapter.displayController?.getViewer?.() || AnnotationAdapter.viewer;
        AnnotationAdapter.applyViewportChannelDisplayFilter(viewer, min, max, gamma);
        if (typeof viewer?.forceRedraw === "function") viewer.forceRedraw();
        if (!options.live) {
            AnnotationAdapter.drawChannelPaletteHistogram(doc);
        }
        if (options.live) {
            AnnotationAdapter.displayController?.syncChannelControls?.();
        }
        return { min, max, gamma };
    }

    static commitChannelPaletteWindow(root = null) {
        AnnotationAdapter.applyChannelPaletteWindowFromSliders(root);
        AnnotationAdapter.displayController?.scheduleDisplayUpdate?.({ reopen: true });
        return true;
    }

    /**
     * Map channel-window slider values onto the active image's intensity
     * baseline (0–255 for RGB, 0–65535 for 16-bit fluorescence) as float
     * multipliers for OpenSeadragon canvas filters.
     * Never pass raw integer slider strings into contrast()/brightness().
     */
    static mapChannelWindowToFloatFilter(min, max, gamma, scale) {
        const resolved = Number(scale) > 0 ? Number(scale) : AnnotationAdapter.channelLevelScale();
        const lo = Math.max(0, Math.min(1, parseFloat(min) / resolved));
        const hi = Math.max(lo + (1 / resolved), Math.min(1, parseFloat(max) / resolved));
        const slope = 1 / (hi - lo);
        const intercept = -lo * slope;
        const exponent = Math.max(0.2, Math.min(4, parseFloat(gamma) || 1));
        return { lo, hi, slope, intercept, exponent, scale: resolved };
    }

    static applyFloat16BitWindowProcessor(context, mapped) {
        if (!context?.canvas || typeof context.getImageData !== "function") return false;
        const width = Number(context.canvas.width) || 0;
        const height = Number(context.canvas.height) || 0;
        if (width < 1 || height < 1) return false;
        const image = context.getImageData(0, 0, width, height);
        const data = image.data;
        const scale = mapped.scale || AnnotationAdapter.BIT16_INTENSITY_SCALE;
        const lo16 = mapped.lo * scale;
        const range = Math.max(1, (mapped.hi - mapped.lo) * scale);
        const exponent = mapped.exponent || 1;
        for (let i = 0; i < data.length; i += 4) {
            for (let c = 0; c < 3; c += 1) {
                const v16 = data[i + c] * (scale / 255);
                let t = (v16 - lo16) / range;
                if (t < 0) t = 0;
                else if (t > 1) t = 1;
                data[i + c] = Math.pow(t, exponent) * 255;
            }
        }
        context.putImageData(image, 0, 0);
        return true;
    }

    /**
     * Per-channel 8-bit window + visibility for an RGB composite tile.
     * Canvas R/G/B are display channels 0/1/2. Hidden channels go to 0;
     * each visible channel uses its own min/max/gamma on a 0–255 scale.
     */
    static rgbCompositeChannelMaps(channels) {
        const scale = AnnotationAdapter.BIT8_INTENSITY_SCALE;
        const list = Array.isArray(channels) ? channels : [];
        return [0, 1, 2].map(index => {
            const channel = list.find(item => Number(item?.index) === index) || list[index];
            if (channel && channel.visible === false) {
                return { visible: false, lo: 0, range: scale, exponent: 1 };
            }
            const black = Math.max(0, Number(channel?.black) || 0);
            const white = Math.max(black + 1, Number(channel?.white) || scale);
            return {
                visible: true,
                lo: Math.min(scale, black),
                range: Math.max(1, Math.min(scale, white) - black),
                exponent: Math.max(0.2, Math.min(4, Number(channel?.gamma) || 1))
            };
        });
    }

    static applyRgbCompositeWindowProcessor(context, maps) {
        if (!context?.canvas || typeof context.getImageData !== "function") return false;
        const width = Number(context.canvas.width) || 0;
        const height = Number(context.canvas.height) || 0;
        if (width < 1 || height < 1) return false;
        const planes = Array.isArray(maps) && maps.length ? maps : AnnotationAdapter.rgbCompositeChannelMaps();
        const image = context.getImageData(0, 0, width, height);
        const data = image.data;
        for (let i = 0; i < data.length; i += 4) {
            for (let c = 0; c < 3; c += 1) {
                const map = planes[c] || planes[0];
                if (!map || map.visible === false) {
                    data[i + c] = 0;
                    continue;
                }
                let t = (data[i + c] - map.lo) / map.range;
                if (t < 0) t = 0;
                else if (t > 1) t = 1;
                data[i + c] = Math.pow(t, map.exponent || 1) * 255;
            }
        }
        context.putImageData(image, 0, 0);
        return true;
    }

    /**
     * RGB composite: window and show/hide each color independently.
     * Fluorescence: keep the selected-channel window as a viewport preview.
     */
    static applyViewportChannelDisplayFilter(viewer, min, max, gamma) {
        const host = viewer || AnnotationAdapter.displayController?.getViewer?.() || AnnotationAdapter.viewer;
        const metadata = AnnotationAdapter.displayController?.getMetadata?.() || AnnotationAdapter.imageMetadata;
        const series = AnnotationAdapter.displayController?.getCurrentSeries?.()
            ?? AnnotationAdapter.currentSeries;
        if (AnnotationAdapter.isRgbSeriesView(metadata, series)) {
            return AnnotationAdapter.applyViewportRgbChannelFilter(host);
        }
        let lo = min;
        let hi = max;
        let exp = gamma;
        if (!Number.isFinite(Number(lo)) || !Number.isFinite(Number(hi))) {
            const sliders = AnnotationAdapter.readChannelPaletteSliders();
            lo = sliders.min;
            hi = sliders.max;
            exp = sliders.gamma;
        }
        return AnnotationAdapter.applyViewportTileContrastFilter(host, lo, hi, exp);
    }

    static applyViewportRgbChannelFilter(viewer) {
        const canvas = viewer?.drawer?.canvas || viewer?.canvas?.querySelector?.("canvas") || viewer?.canvas;
        if (!canvas?.style) return false;
        const maps = AnnotationAdapter.rgbCompositeChannelMaps(AnnotationAdapter.paletteChannelList());
        const owner = canvas.ownerDocument || (typeof document !== "undefined" ? document : null);
        const svgIds = [
            ["fcp-window-func-r", "fcp-gamma-func-r", 0],
            ["fcp-window-func-g", "fcp-gamma-func-g", 1],
            ["fcp-window-func-b", "fcp-gamma-func-b", 2]
        ];
        for (const [windowId, gammaId, index] of svgIds) {
            const map = maps[index];
            const windowFn = owner?.getElementById?.(windowId);
            const gammaFn = owner?.getElementById?.(gammaId);
            if (windowFn?.setAttribute) {
                if (!map || map.visible === false) {
                    windowFn.setAttribute("type", "linear");
                    windowFn.setAttribute("slope", "0");
                    windowFn.setAttribute("intercept", "0");
                } else {
                    const slope = (255 / map.range).toFixed(8);
                    const intercept = (-map.lo / map.range).toFixed(8);
                    windowFn.setAttribute("type", "linear");
                    windowFn.setAttribute("slope", slope);
                    windowFn.setAttribute("intercept", intercept);
                }
            }
            if (gammaFn?.setAttribute) {
                gammaFn.setAttribute("type", "gamma");
                gammaFn.setAttribute("amplitude", "1");
                gammaFn.setAttribute("exponent", String((map && map.visible !== false ? map.exponent : 1) || 1));
                gammaFn.setAttribute("offset", "0");
            }
        }
        if (typeof viewer?.setFilterOptions === "function") {
            viewer.setFilterOptions({
                loadMode: "sync",
                filters: {
                    processors: [
                        (context, callback) => {
                            AnnotationAdapter.applyRgbCompositeWindowProcessor(context, maps);
                            if (typeof callback === "function") callback();
                        }
                    ]
                }
            });
            canvas.style.filter = "";
        } else {
            canvas.style.filter = "url(#fcp-gamma-filter)";
        }
        if (typeof viewer?.forceRedraw === "function") viewer.forceRedraw();
        return true;
    }

    static applyViewportTileContrastFilter(viewer, min, max, gamma) {
        const canvas = viewer?.drawer?.canvas || viewer?.canvas?.querySelector?.("canvas") || viewer?.canvas;
        if (!canvas?.style) return false;
        const mapped = AnnotationAdapter.mapChannelWindowToFloatFilter(min, max, gamma);
        const owner = canvas.ownerDocument || (typeof document !== "undefined" ? document : null);
        const slope = mapped.slope.toFixed(8);
        const intercept = mapped.intercept.toFixed(8);
        const exponent = mapped.exponent.toFixed(8);
        for (const id of ["fcp-window-func-r", "fcp-window-func-g", "fcp-window-func-b"]) {
            const fn = owner?.getElementById?.(id);
            if (!fn?.setAttribute) continue;
            fn.setAttribute("type", "linear");
            fn.setAttribute("slope", slope);
            fn.setAttribute("intercept", intercept);
        }
        for (const id of ["fcp-gamma-func-r", "fcp-gamma-func-g", "fcp-gamma-func-b"]) {
            const fn = owner?.getElementById?.(id);
            if (!fn?.setAttribute) continue;
            fn.setAttribute("type", "gamma");
            fn.setAttribute("amplitude", "1");
            fn.setAttribute("exponent", exponent);
            fn.setAttribute("offset", "0");
        }
        if (typeof viewer?.setFilterOptions === "function") {
            viewer.setFilterOptions({
                loadMode: "sync",
                filters: {
                    processors: [
                        (context, callback) => {
                            AnnotationAdapter.applyFloat16BitWindowProcessor(context, mapped);
                            if (typeof callback === "function") callback();
                        }
                    ]
                }
            });
            canvas.style.filter = "";
        } else {
            canvas.style.filter = "url(#fcp-gamma-filter)";
        }
        if (typeof viewer?.forceRedraw === "function") viewer.forceRedraw();
        return true;
    }

    static clearViewportTileContrastFilter(viewer) {
        const host = viewer || AnnotationAdapter.displayController?.getViewer?.() || AnnotationAdapter.viewer;
        const canvas = host?.drawer?.canvas || host?.canvas?.querySelector?.("canvas") || host?.canvas;
        if (canvas?.style) canvas.style.filter = "";
        return true;
    }

    static histogramBinsFromPixelBlock(block, channelIndex, binCount = 256) {
        const bins = new Array(binCount).fill(0);
        if (!block || !Array.isArray(block.values) || !block.width || !block.height) return bins;
        const plane = Math.max(0, Number(block.width) * Number(block.height));
        const channels = Math.max(1, Number(block.channels) || 1);
        const channel = Math.max(0, Math.min(channels - 1, Number(channelIndex) || 0));
        const start = channel * plane;
        const scale = AnnotationAdapter.channelLevelScale();
        for (let i = 0; i < plane; i += 1) {
            const value = Number(block.values[start + i]) || 0;
            const bin = Math.max(0, Math.min(binCount - 1, Math.floor((value / scale) * binCount)));
            bins[bin] += 1;
        }
        return bins;
    }

    static async refreshChannelPaletteHistogram(root = null) {
        const controller = AnnotationAdapter.displayController;
        const image = controller?.getSelectedImage?.();
        const viewer = controller?.getViewer?.() || AnnotationAdapter.viewer;
        const selected = AnnotationAdapter.paletteSelectedChannel();
        if (!image?.id || typeof controller?.requestPixelBlock !== "function" || !viewer?.world?.getItemAt) {
            AnnotationAdapter.channelPaletteHistogram = null;
            AnnotationAdapter.drawChannelPaletteHistogram(root);
            return null;
        }
        try {
            const item = viewer.world.getItemAt(0);
            const bounds = viewer.viewport?.getBounds?.();
            const center = bounds && item?.viewportToImageCoordinates
                ? item.viewportToImageCoordinates(bounds.getCenter())
                : { x: 0, y: 0 };
            const size = 64;
            const x = Math.max(0, Math.floor((Number(center.x) || 0) - size / 2));
            const y = Math.max(0, Math.floor((Number(center.y) || 0) - size / 2));
            const series = Number(controller.getCurrentSeries?.() || 0);
            const block = await controller.requestPixelBlock(image.id, x, y, size, series);
            AnnotationAdapter.channelPaletteHistogram = AnnotationAdapter.histogramBinsFromPixelBlock(
                block,
                selected?.index ?? 0
            );
            AnnotationAdapter.drawChannelPaletteHistogram(root);
            return AnnotationAdapter.channelPaletteHistogram;
        } catch (_error) {
            AnnotationAdapter.channelPaletteHistogram = null;
            AnnotationAdapter.drawChannelPaletteHistogram(root);
            return null;
        }
    }

    static syntheticHistogram(channel, binCount = 256) {
        const bins = new Array(binCount).fill(0);
        const black = Math.max(0, Number(channel?.black) || 0);
        const scale = AnnotationAdapter.channelLevelScale();
        const white = Math.max(black + 1, Number(channel?.white) || scale);
        const peak = Math.max(1, Math.min(binCount - 2, Math.floor((black / scale) * binCount) + 8));
        for (let i = 0; i < binCount; i += 1) {
            const t = (i - peak) / 18;
            const spread = (i - peak) / 70;
            bins[i] = Math.exp(-t * t) * 120 + (i > peak ? Math.exp(-(spread * spread)) * 40 : 0);
            if (i < Math.floor((black / scale) * binCount)
                || i > Math.floor((white / scale) * binCount)) {
                bins[i] *= 0.35;
            }
        }
        return bins;
    }

    static drawChannelPaletteHistogram(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = AnnotationAdapter.resolvePaletteNode(doc);
        const canvas = palette?.querySelector?.("#floating-channel-histogram")
            || doc?.getElementById?.("floating-channel-histogram");
        if (!canvas || typeof canvas.getContext !== "function") return false;
        const ctx = canvas.getContext("2d");
        if (!ctx) return false;
        const width = canvas.width || 340;
        const height = canvas.height || 88;
        const channel = AnnotationAdapter.paletteSelectedChannel();
        const bins = AnnotationAdapter.channelPaletteHistogram
            || AnnotationAdapter.syntheticHistogram(channel);
        const maxBin = Math.max(1, ...bins);
        const color = AnnotationAdapter.channelPaletteColor(channel);
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = color;
        const barWidth = width / bins.length;
        for (let i = 0; i < bins.length; i += 1) {
            const h = (bins[i] / maxBin) * (height - 2);
            ctx.fillRect(i * barWidth, height - h, Math.max(1, barWidth), h);
        }
        const scale = AnnotationAdapter.channelLevelScale();
        const minX = ((Number(channel?.black) || 0) / scale) * width;
        const maxX = ((Number(channel?.white) || scale) / scale) * width;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(minX, 0);
        ctx.lineTo(minX, height);
        ctx.moveTo(maxX, 0);
        ctx.lineTo(maxX, height);
        ctx.stroke();
        return true;
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
        AnnotationAdapter.setMeasurementEntryMode(enabled ? "multiple" : "single");
        const v = AnnotationAdapter.viewer;
        if (v && typeof v.setMouseNavEnabled === "function") {
            v.setMouseNavEnabled(!enabled);
        }
        if (enabled) {
            AnnotationAdapter.hideAnnotationEditorPopup();
            AnnotationAdapter.ensureMeasureOverlay();
            AnnotationAdapter.clearMeasureVector({ remove: false, keepDragState: true });
            AnnotationAdapter.resetMeasurementDragState();
        } else {
            AnnotationAdapter.clearMeasureVector({ remove: false });
        }
        AnnotationAdapter.setMeasureTracking(enabled);
        AnnotationAdapter.syncMeasurementModeChrome(enabled);
        return AnnotationAdapter.isMeasurementModeActive;
    }

    /** OSD MouseTracker must stay off unless measure mode is active. */
    static setMeasureTracking(enabled) {
        const tracker = AnnotationAdapter.measureMouseTracker;
        if (!tracker) return false;
        try {
            if (typeof tracker.setTracking === "function") tracker.setTracking(!!enabled);
            else if (typeof tracker.setEnabled === "function") tracker.setEnabled(!!enabled);
        } catch (_error) {
            return false;
        }
        return !!enabled;
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
            startDisabled: true,
            pressHandler: (event) => AnnotationAdapter._measurePressHandler(event),
            dragHandler: (event) => AnnotationAdapter._measureDragHandler(event),
            releaseHandler: (event) => AnnotationAdapter._measureReleaseHandler(event),
            // Some OSD builds only fire dragEnd — treat it like release.
            dragEndHandler: (event) => AnnotationAdapter._measureReleaseHandler(event)
        });
        AnnotationAdapter.setMeasureTracking(AnnotationAdapter.isMeasurementModeActive);
        AnnotationAdapter.ensureMeasurementPopupOverlay();
        AnnotationAdapter.bindMeasurementPointerUnlock();
        AnnotationAdapter.bindMeasurementKeyboardEscape();
        return AnnotationAdapter.measureMouseTracker;
    }

    static bindMeasurementPointerUnlock() {
        if (typeof window === "undefined" || window._wsiMeasurePointerUnlockBound) return false;
        const onUp = event => {
            if (!AnnotationAdapter.isDragging && !AnnotationAdapter.isDrawing) return;
            AnnotationAdapter._measureReleaseHandler({
                originalEvent: event,
                pointerId: event?.pointerId,
                position: event?.position
            });
        };
        window.addEventListener("pointerup", onUp, false);
        window.addEventListener("mouseup", onUp, false);
        window._wsiMeasurePointerUnlockBound = true;
        AnnotationAdapter.bindMeasurementKeyboardEscape();
        return true;
    }

    /**
     * Enter / Return while in multiple-entry measure mode: commit the current
     * vector to the Saved Measurements table, then drop pointer capture.
     */
    static bindMeasurementKeyboardEscape() {
        if (typeof window === "undefined" || window._wsiMeasureKeyboardEscapeBound) return false;
        window.addEventListener("keydown", function handleKeyboardEscape(e) {
            AnnotationAdapter.handleMeasurementKeyboardEscape(e);
        }, true);
        window._wsiMeasureKeyboardEscapeBound = true;
        return true;
    }

    static handleMeasurementKeyboardEscape(e) {
        if (!e || e.isComposing) return false;
        const selector = typeof document !== "undefined"
            ? document.getElementById("measurement-mode-selector")
            : AnnotationAdapter.measurementModeSelectorEl();
        const currentMode = String(selector?.value || AnnotationAdapter.measurementEntryMode())
            .toLowerCase();
        if ((e.key === "Enter" || e.key === "Return") && currentMode === "multiple") {
            const tag = String(e.target?.tagName || "").toLowerCase();
            const typing = tag === "input" || tag === "textarea" || Boolean(e.target?.isContentEditable);
            if (typing && !AnnotationAdapter.isDrawing && !AnnotationAdapter.isDragging) return false;
            if (typeof e.preventDefault === "function") e.preventDefault();
            // Force complete mouse pointer release and exit multiple entry tracking mode
            AnnotationAdapter.commitActiveMeasurementSegment(e);
            if (selector) selector.value = "single";
            let isDrawing = false;
            AnnotationAdapter.isDrawing = isDrawing;
            const measurementTracker = AnnotationAdapter.measureMouseTracker;
            const viewer = AnnotationAdapter.viewer;
            const lastPointerId = e.pointerId
                ?? e.originalEvent?.pointerId
                ?? AnnotationAdapter.lastPointerId;
            if (measurementTracker) measurementTracker.setTracking(false);
            if (viewer && viewer.canvas) {
                try { viewer.canvas.releasePointerCapture(lastPointerId); } catch (_error) { /* ignore */ }
            }
            if (viewer && typeof viewer.setMouseNavEnabled === "function") {
                viewer.setMouseNavEnabled(true);
            }
            AnnotationAdapter.escapeMeasurementMultipleMode(e);
            AnnotationAdapter.activateQuPathTool("move");
            return true;
        }
        if (e.key === "Escape" || e.key === "Esc") {
            const tag = String(e.target?.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || Boolean(e.target?.isContentEditable)) return false;
            if (typeof e.preventDefault === "function") e.preventDefault();
            AnnotationAdapter.releaseMeasurementDrawingAfterExport();
            AnnotationAdapter.cancelQuPathDrawSession();
            AnnotationAdapter.activateQuPathTool("move");
            return true;
        }
        const drawingTool = AnnotationAdapter.currentActiveTool || AnnotationAdapter.activeImageJTool;
        if ((e.key === "Enter" || e.key === "Return")
            && (drawingTool === "polygon" || drawingTool === "polyline" || drawingTool === "multipoint" || drawingTool === "wand" || drawingTool === "text" || drawingTool === "points")) {
            if (AnnotationAdapter.finishQuPathClickPath(e)) {
                if (typeof e.preventDefault === "function") e.preventDefault();
                return true;
            }
            if (typeof e.preventDefault === "function") e.preventDefault();
            AnnotationAdapter.releaseMeasurementPointerLock(e);
            AnnotationAdapter.activateQuPathTool("move");
            return true;
        }
        return false;
    }

    static bindSecondaryAnnotationToolbar(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root);
        if (!doc?.getElementById) return false;
        const toggle = doc.getElementById("toggle-secondary-annotation-toolbar");
        if (toggle && toggle.dataset?.ijToggleBound !== "1") {
            toggle.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                AnnotationAdapter.toggleSecondaryAnnotationToolbar(doc);
            });
            if (toggle.dataset) toggle.dataset.ijToggleBound = "1";
        }
        const bar = doc.getElementById("secondary-annotation-toolbar");
        if (bar && bar.dataset?.ijBarBound !== "1") {
            bar.addEventListener("click", event => {
                const btn = event.target?.closest?.(".qp-tool, .ij-tool");
                if (!btn) return;
                event.preventDefault();
                event.stopPropagation();
                const tool = btn.getAttribute("data-qp-tool") || btn.getAttribute("data-ij-tool");
                if (String(tool || "").toLowerCase() === "contrast") {
                    AnnotationAdapter.launchBrightnessContrastPalette(doc);
                    return;
                }
                if (String(tool || "").toLowerCase() === "zoomfit") {
                    AnnotationAdapter.toggleQuPathZoomFit(doc);
                    return;
                }
                AnnotationAdapter.activateQuPathTool(tool, {
                    button: btn,
                    event
                });
            });
            if (bar.dataset) bar.dataset.ijBarBound = "1";
        }
        AnnotationAdapter.ensureCurrentActiveTool("move");
        AnnotationAdapter.bindQuPathToolPointers();
        AnnotationAdapter.bindWandConfigDropdown(doc);
        AnnotationAdapter.bindBrightnessContrastLaunchers(doc);
        AnnotationAdapter.bindQuPathMagnificationControl(doc);
        AnnotationAdapter.installViewerToolAlias();
        AnnotationAdapter.bindGlobalUiTooltip(doc);
        return true;
    }

    /**
     * Wires the new always-visible primary toolbar (Row 1). QuPath drawing-tool buttons
     * are duplicated with `primary-` prefixed ids but the exact same `data-qp-tool`
     * values, and reuse activateQuPathTool()/syncQuPathToolChrome() so both toolbars'
     * button sets stay in lockstep. The case/slide selector plus browser toggle are the
     * same original elements simply relocated into this row (not duplicated), so their
     * existing bindings are untouched. The layer-visibility/AI-Labs proxies that used to
     * live here were removed (cleanup pass) — those controls now live exclusively in the
     * sandboxed legacy toolbars; see #developer-sandbox-container.
     */
    static bindPrimaryUnifiedToolbar(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root);
        if (!doc?.getElementById) return false;

        const helpBtn = doc.getElementById("primary-help-directory-link");
        if (helpBtn && helpBtn.dataset?.primaryHelpBound !== "1") {
            helpBtn.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                if (event.shiftKey) {
                    // Chromium (and some other engines) treat a window.open() call made
                    // synchronously inside a Shift-held click as an explicit "open in a new
                    // WINDOW" request — a documented, unfixable-from-script browser quirk
                    // (see Mozilla bug 1873330; multiple Chromium bug reports) that fires
                    // even though no window "features" string is passed here. Deferring the
                    // call by a tick decouples it from that shift-click input event, so the
                    // browser falls back to its normal default: a new tab.
                    setTimeout(() => {
                        if (typeof window !== "undefined" && typeof window.open === "function") {
                            window.open("/help/help-directory.html", "_blank");
                        }
                    }, 0);
                    return;
                }
                AnnotationAdapter.openFloatingShortcutsLegend(doc);
            });
            if (helpBtn.dataset) helpBtn.dataset.primaryHelpBound = "1";
        }

        const primaryBar = doc.getElementById("primary-unified-toolbar");
        if (primaryBar && primaryBar.dataset?.qpBarBound !== "1") {
            primaryBar.addEventListener("click", event => {
                const btn = event.target?.closest?.(".qp-tool, .ij-tool");
                if (!btn) return;
                event.preventDefault();
                event.stopPropagation();
                const tool = btn.getAttribute("data-qp-tool") || btn.getAttribute("data-ij-tool");
                if (String(tool || "").toLowerCase() === "contrast") {
                    AnnotationAdapter.launchBrightnessContrastPalette(doc);
                    return;
                }
                if (String(tool || "").toLowerCase() === "zoomfit") {
                    AnnotationAdapter.toggleQuPathZoomFit(doc);
                    return;
                }
                AnnotationAdapter.activateQuPathTool(tool, { button: btn, event });
            });
            if (primaryBar.dataset) primaryBar.dataset.qpBarBound = "1";
        }

        AnnotationAdapter.bindGlobalUiTooltip(doc);
        AnnotationAdapter.bindExportOverviewProxyButtons(doc);
        return true;
    }

    /**
     * The primary toolbar and the sandboxed legacy toolbar each need their own "Vis" /
     * "Ant" / "Ovw" export & overview buttons, but there is exactly one real, working
     * implementation of each action (`#export-visible-region`, `#export-selected-annotation`,
     * `#slide-overview-button` — native-resolution server-backed export, already wired to
     * the live native-OSD annotation selection state). Rather than re-implement a second,
     * divergent client-side screenshot/crop pipeline, every new button below is a thin proxy
     * that forwards its click to the real button and mirrors its disabled/aria-pressed chrome,
     * so both rows always reflect one single source of truth.
     */
    static EXPORT_OVERVIEW_PROXY_MAP = {
        "primary-export-visible-btn": "export-visible-region",
        "sandbox-export-visible-btn": "export-visible-region",
        "secondary-export-visible-btn": "export-visible-region",
        "primary-export-annotation-btn": "export-selected-annotation",
        "sandbox-export-annotation-btn": "export-selected-annotation",
        "secondary-export-annotation-btn": "export-selected-annotation",
        "primary-slide-overview-btn": "slide-overview-button",
        "sandbox-slide-overview-btn": "slide-overview-button",
        "secondary-slide-overview-btn": "slide-overview-button"
    };

    static syncExportOverviewProxyChrome(proxyId, targetId, doc) {
        const proxy = doc?.getElementById?.(proxyId);
        const target = doc?.getElementById?.(targetId);
        if (!proxy || !target) return false;
        proxy.disabled = Boolean(target.disabled);
        const pressed = target.getAttribute?.("aria-pressed");
        if (pressed != null) proxy.setAttribute?.("aria-pressed", pressed);
        return true;
    }

    static bindExportOverviewProxyButtons(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        if (!doc?.getElementById) return false;

        const targetsSeen = new Set();
        for (const [proxyId, targetId] of Object.entries(AnnotationAdapter.EXPORT_OVERVIEW_PROXY_MAP)) {
            const proxy = doc.getElementById(proxyId);
            const target = doc.getElementById(targetId);
            if (!proxy || !target) continue;

            if (proxy.dataset?.exportProxyBound !== "1") {
                proxy.addEventListener("click", event => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (target.disabled) return;
                    target.click();
                    AnnotationAdapter.syncExportOverviewProxyChrome(proxyId, targetId, doc);
                });
                if (proxy.dataset) proxy.dataset.exportProxyBound = "1";
            }
            AnnotationAdapter.syncExportOverviewProxyChrome(proxyId, targetId, doc);
            targetsSeen.add(targetId);
        }

        // A single MutationObserver per real target keeps every proxy pointed at it
        // (primary + sandbox) in sync whenever the host page enables/disables it or
        // flips its pressed state (image load, annotation selection change, overview
        // toggle), without needing to touch that page's own call sites.
        if (typeof MutationObserver === "function") {
            for (const targetId of targetsSeen) {
                const target = doc.getElementById(targetId);
                if (!target || target.dataset?.exportProxyObserved === "1") continue;
                const observer = new MutationObserver(() => {
                    for (const [pId, tId] of Object.entries(AnnotationAdapter.EXPORT_OVERVIEW_PROXY_MAP)) {
                        if (tId === targetId) AnnotationAdapter.syncExportOverviewProxyChrome(pId, tId, doc);
                    }
                });
                observer.observe(target, { attributes: true, attributeFilter: ["disabled", "aria-pressed"] });
                if (target.dataset) target.dataset.exportProxyObserved = "1";
            }
        }
        return true;
    }

    /**
     * Shows/hides the `#developer-sandbox-container` wrapper holding both legacy
     * staging toolbars (the old always-on main bar and the old hidden-by-default
     * QuPath bar). There is no dedicated toolbar button for this anymore (removed in
     * the toolbar cleanup pass) — it is reachable only via Ctrl-Shift-T (see
     * bindQuPathKeyboardShortcuts). Purely a display toggle on the wrapper; every
     * control inside keeps its own independent state/bindings exactly as before.
     */
    static toggleDeveloperSandbox(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const container = doc?.getElementById?.("developer-sandbox-container");
        if (!container) return false;
        const opening = !container.style || container.style.display === "none" || container.style.display === "";
        if (container.style) container.style.display = opening ? "flex" : "none";
        AnnotationAdapter.relayoutViewerAfterToolbarChange();
        return opening;
    }

    /**
     * Draggable "?" quick-reference card listing every active keyboard shortcut. Kept
     * separate from the full help directory (Shift-click on the same button opens that
     * in a new tab) so a pathologist can glance at hotkeys without leaving the slide.
     */
    static bindFloatingShortcutsLegend(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const palette = doc?.getElementById?.("floating-shortcuts-legend");
        if (!palette) return null;
        AnnotationAdapter.isolateFloatingPalettePointerEvents(palette);
        const handle = palette.querySelector(".legend-header");
        // The close button must carry the .fcp-close class (checked by
        // bindLiberatedPaletteDrag's beginWindowDrag) so clicking it doesn't get
        // hijacked into starting a window-drag/pointer-capture on the header first —
        // that hijack was why the button previously appeared to do nothing.
        if (handle) AnnotationAdapter.bindLiberatedPaletteDrag(handle, palette);
        const closeBtn = palette.querySelector("#floating-shortcuts-legend-close")
            || doc?.getElementById?.("floating-shortcuts-legend-close");
        if (closeBtn && closeBtn.dataset?.legendCloseBound !== "1") {
            closeBtn.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                AnnotationAdapter.closeFloatingShortcutsLegend(doc);
            });
            if (closeBtn.dataset) closeBtn.dataset.legendCloseBound = "1";
        }
        const minimizeBtn = palette.querySelector("#floating-shortcuts-legend-minimize")
            || doc?.getElementById?.("floating-shortcuts-legend-minimize");
        if (minimizeBtn && minimizeBtn.dataset?.legendMinimizeBound !== "1") {
            minimizeBtn.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                AnnotationAdapter.toggleFloatingShortcutsLegendMinimized(doc);
            });
            if (minimizeBtn.dataset) minimizeBtn.dataset.legendMinimizeBound = "1";
        }
        AnnotationAdapter.bindFloatingShortcutsLegendResize(palette);
        // Scale the reference table's text with the panel's own size (now driven by the
        // custom multi-edge resize handles above, not the old corner-only native grip),
        // instead of a fixed 0.8rem that either overflows or stays tiny/oversized as a
        // pathologist drags the window to a very different size.
        if (typeof ResizeObserver === "function" && palette.dataset?.legendResizeBound !== "1") {
            const body = palette.querySelector(".legend-body");
            const baseWidth = 340;
            const baseHeight = 420;
            const baseFontRem = 0.8;
            const observer = new ResizeObserver(entries => {
                const entry = entries?.[0];
                const width = entry?.contentRect?.width || palette.clientWidth || baseWidth;
                const height = entry?.contentRect?.height || palette.clientHeight || baseHeight;
                const scale = Math.min(width / baseWidth, height / baseHeight);
                const clamped = Math.max(0.35, Math.min(2.5, scale));
                if (body?.style) body.style.fontSize = `${(baseFontRem * clamped).toFixed(3)}rem`;
            });
            observer.observe(palette);
            if (palette.dataset) palette.dataset.legendResizeBound = "1";
        }
        return palette;
    }

    static toggleFloatingShortcutsLegendMinimized(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const palette = doc?.getElementById?.("floating-shortcuts-legend");
        if (!palette?.classList) return false;
        palette.classList.toggle("legend-minimized");
        return AnnotationAdapter.syncFloatingShortcutsLegendMinimizedUi(palette, doc);
    }

    /** Collapses the legend to just its header strip (mirrors the existing z-stack
     *  palette's minimize pattern) by clamping max-height rather than touching the
     *  actual width/height style — so whatever size the custom resize handles left it
     *  at is exactly what comes back on expand, with nothing to snapshot/restore. */
    static syncFloatingShortcutsLegendMinimizedUi(palette = null, root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const node = palette || doc?.getElementById?.("floating-shortcuts-legend");
        if (!node) return false;
        const minimized = Boolean(node.classList?.contains?.("legend-minimized"));
        const header = node.querySelector?.(".legend-header");
        const headerHeight = header?.offsetHeight || 34;
        if (node.style) {
            node.style.maxHeight = minimized ? `${headerHeight}px` : "none";
            node.style.overflow = "hidden";
        }
        const body = node.querySelector?.(".legend-body");
        if (body?.style) body.style.display = minimized ? "none" : "";
        // Height-adjusting handles (top/bottom/corners) are moot while collapsed to a
        // header strip; leave the two side handles live so width stays adjustable.
        const handles = node.querySelectorAll?.(".legend-resize-handle") || [];
        handles.forEach?.(hnd => {
            const edge = hnd.getAttribute?.("data-edge") || "";
            const affectsHeight = edge.includes("n") || edge.includes("s");
            if (hnd.style) hnd.style.display = (minimized && affectsHeight) ? "none" : "";
        });
        const btn = doc?.getElementById?.("floating-shortcuts-legend-minimize");
        if (btn) {
            btn.setAttribute("aria-pressed", String(minimized));
            btn.setAttribute("title", minimized ? "Expand" : "Minimize");
            btn.setAttribute("aria-label", minimized ? "Expand keyboard shortcuts legend" : "Minimize keyboard shortcuts legend");
            btn.textContent = minimized ? "+" : "–";
        }
        return true;
    }

    /**
     * Custom multi-edge/corner resize for the shortcuts legend, replacing the native
     * CSS `resize: both` (which only offers a single bottom-right grip and refuses to
     * shrink below the element's implicit min-content floor). Deliberately does not
     * clamp position to the viewport, matching the same "let the user drag it wherever,
     * including partially off-screen" philosophy as bindLiberatedPaletteDrag.
     */
    static bindFloatingShortcutsLegendResize(palette, options = {}) {
        if (!palette || palette.dataset?.legendResizeDragBound === "1") return false;
        const MIN_WIDTH = Number(options.minWidth) || 140;
        const MIN_HEIGHT = Number(options.minHeight) || 50;
        const handles = palette.querySelectorAll?.(".legend-resize-handle") || [];
        handles.forEach(handle => {
            const edge = String(handle.getAttribute?.("data-edge") || "");
            let start = null;

            const onMove = event => {
                if (!start || !palette.style) return;
                const point = event?.touches?.[0] || event;
                const dx = Number(point.clientX) - start.x;
                const dy = Number(point.clientY) - start.y;
                let width = start.width;
                let height = start.height;
                if (edge.includes("e")) width = start.width + dx;
                if (edge.includes("w")) width = start.width - dx;
                if (edge.includes("s")) height = start.height + dy;
                if (edge.includes("n")) height = start.height - dy;
                width = Math.max(MIN_WIDTH, width);
                height = Math.max(MIN_HEIGHT, height);
                // Re-derive left/top from the clamped width/height so the OPPOSITE edge
                // stays put once the min-size floor kicks in, instead of jumping.
                const left = edge.includes("w") ? (start.left + start.width - width) : start.left;
                const top = edge.includes("n") ? (start.top + start.height - height) : start.top;
                if (edge.includes("w") || edge.includes("n")) {
                    palette.style.left = `${left}px`;
                    palette.style.top = `${top}px`;
                    palette.style.right = "auto";
                    palette.style.bottom = "auto";
                }
                if (edge.includes("e") || edge.includes("w")) palette.style.width = `${width}px`;
                if (edge.includes("n") || edge.includes("s")) palette.style.height = `${height}px`;
            };

            const onUp = event => {
                start = null;
                if (typeof window !== "undefined") {
                    window.removeEventListener("pointermove", onMove, true);
                    window.removeEventListener("pointerup", onUp, true);
                    window.removeEventListener("pointercancel", onUp, true);
                    window.removeEventListener("mousemove", onMove, true);
                    window.removeEventListener("mouseup", onUp, true);
                }
                if (typeof handle.releasePointerCapture === "function" && event?.pointerId != null) {
                    try { handle.releasePointerCapture(event.pointerId); } catch (_error) { /* ignore */ }
                }
            };

            const onDown = event => {
                if (event.button != null && event.button !== 0) return;
                const rect = palette.getBoundingClientRect?.();
                if (!rect) return;
                const point = event?.touches?.[0] || event;
                start = {
                    x: Number(point.clientX), y: Number(point.clientY),
                    left: rect.left, top: rect.top, width: rect.width, height: rect.height
                };
                if (typeof window !== "undefined") {
                    window.addEventListener("pointermove", onMove, true);
                    window.addEventListener("pointerup", onUp, true);
                    window.addEventListener("pointercancel", onUp, true);
                    window.addEventListener("mousemove", onMove, true);
                    window.addEventListener("mouseup", onUp, true);
                }
                if (typeof handle.setPointerCapture === "function" && event.pointerId != null) {
                    try { handle.setPointerCapture(event.pointerId); } catch (_error) { /* ignore */ }
                }
                event.preventDefault?.();
                event.stopPropagation?.();
            };

            handle.addEventListener("pointerdown", onDown);
            handle.addEventListener("mousedown", onDown);
        });
        if (palette.dataset) palette.dataset.legendResizeDragBound = "1";
        return true;
    }

    static openFloatingShortcutsLegend(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const palette = doc?.getElementById?.("floating-shortcuts-legend");
        if (!doc || !palette) return false;
        AnnotationAdapter.mountFloatingPaletteToBody(palette, doc);
        // Deliberately low CSS min-width/min-height (not the usual larger per-palette
        // default) plus resize: "none" — this window ships its own custom multi-edge
        // resize handles below, which can shrink it much further than the native
        // corner-only grip would ever have allowed.
        AnnotationAdapter.applyLiberatedFloatingStyle(palette, {
            minWidth: "160px",
            minHeight: "56px",
            resize: "none"
        });
        if (palette.style) palette.style.flexDirection = "column";
        const cascaded = AnnotationAdapter.getAntiOverlapPosition(100, 100, 340, 420, "floating-shortcuts-legend", doc);
        if (palette.style) {
            palette.style.left = `${cascaded.left}px`;
            palette.style.top = `${cascaded.top}px`;
            palette.style.right = "auto";
            palette.style.bottom = "auto";
            palette.style.display = "flex";
        }
        palette.hidden = false;
        palette.removeAttribute?.("hidden");
        palette.setAttribute?.("aria-hidden", "false");
        AnnotationAdapter.bindFloatingShortcutsLegend(doc);
        return true;
    }

    static closeFloatingShortcutsLegend(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const palette = doc?.getElementById?.("floating-shortcuts-legend");
        if (!palette) return false;
        if (palette.style) palette.style.display = "none";
        palette.hidden = true;
        palette.setAttribute?.("aria-hidden", "true");
        return true;
    }

    static bindQuPathKeyboardShortcuts(root = null) {
        AnnotationAdapter.bindOpenSeadragonCanvasKeyIntercept(
            AnnotationAdapter.viewer
            || (typeof globalThis !== "undefined" ? globalThis.viewer : null)
        );
        if (typeof window === "undefined" || window._wsiQuPathShortcutsBound) return Boolean(window?._wsiQuPathShortcutsBound);
        window.addEventListener("keydown", function(e) {
            const active = typeof document !== "undefined" ? document.activeElement : null;
            // Ignore shortcut tracking if a pathologist is typing an annotation title
            // or any other form line text box.
            if (active && (active.id === "annotation-name-input"
                || (typeof active.closest === "function" && active.closest("#annotation-editor-popup")))) {
                return;
            }
            if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
                return;
            }
            if (e.isComposing || !e.key) return;

            // Ctrl-Shift-T (Control, not Command) reveals the hidden developer
            // sandbox / extra toolbars. Handled before the modifier early-return
            // below so ordinary Ctrl/Cmd combinations still do not fire A/N/D/…
            let key = String(e.key || "").toLowerCase();
            if (key === "t" && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                AnnotationAdapter.toggleDeveloperSandbox();
                return;
            }
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            // Enter/Return finishing an in-progress polygon/polyline/wand shape is handled by
            // handleMeasurementKeyboardEscape's window keydown listener, which is registered with
            // { capture: true } and always bound alongside this one (see bindSecondaryAnnotationToolbar).
            // Capture-phase listeners on window fire before bubble-phase ones, so by the time this
            // handler runs, Enter has already been handled — don't duplicate that check here.

            switch(key) {
                case "a": // QuPath: Toggle annotations visibility (A / a)
                    e.preventDefault();
                    let vecBtn = document.getElementById("toggle-annotations-visibility-btn");
                    if (vecBtn) vecBtn.click();
                    break;

                case "n": // QuPath: Toggle annotation names/labels visibility (N / n)
                    e.preventDefault();
                    let lblBtn = document.getElementById("toggle-labels-visibility-btn");
                    if (lblBtn) lblBtn.click();
                    break;

                case "d": // Toggle detected nuclei/objects visibility (D / d)
                    e.preventDefault();
                    let detBtn = document.getElementById("toggle-detections-visibility-btn");
                    if (detBtn) detBtn.click();
                    break;

                case "f": // Interior fill toggle: plain F = detections (nuclei), Shift+F =
                          // annotations. Distinct from "d" above, which hides/shows the
                          // whole detection marker (outline included), not just its fill.
                    e.preventDefault();
                    if (e.shiftKey) AnnotationAdapter.toggleAnnotationFill();
                    else AnnotationAdapter.toggleDetectionFill();
                    break;

                case "h": // QuPath: Hide/Show left side browser panel panel space
                    e.preventDefault();
                    let sideBtn = document.getElementById("toggle-sidebar-btn")
                        || document.getElementById("toggle-left");
                    if (sideBtn) sideBtn.click();
                    break;

                case "_": // QuPath: Browser
                case "-":
                    e.preventDefault();
                    let browserBtn = document.getElementById("qp-tool-browser");
                    if (browserBtn) browserBtn.click();
                    break;

                case "m": // Move / pan — restore native navigation on both toolbars
                    e.preventDefault();
                    if (typeof window.setViewerTool === "function") window.setViewerTool("move");
                    else AnnotationAdapter.setViewerTool("move");
                    break;

                case "r": // QuPath: Rectangle
                    e.preventDefault();
                    let rectBtn = document.getElementById("qp-tool-rectangle");
                    if (rectBtn) rectBtn.click();
                    break;

                case "o": // QuPath: Ellipse
                    e.preventDefault();
                    let ellipseBtn = document.getElementById("qp-tool-ellipse");
                    if (ellipseBtn) ellipseBtn.click();
                    break;

                case "l": // QuPath: Line
                    e.preventDefault();
                    let lineBtn = document.getElementById("qp-tool-line");
                    if (lineBtn) lineBtn.click();
                    break;

                case "p": // QuPath: Polygon
                    e.preventDefault();
                    let polygonBtn = document.getElementById("qp-tool-polygon");
                    if (polygonBtn) polygonBtn.click();
                    break;

                case "v": // QuPath: Polyline
                    e.preventDefault();
                    let polylineBtn = document.getElementById("qp-tool-polyline");
                    if (polylineBtn) polylineBtn.click();
                    break;

                case "b": // QuPath: Brush (previously mis-bound to Brightness & Contrast, which
                          // has its own tooltip/shortcut on "c" below — see qp-tool-brush's
                          // tooltip, which has always advertised "(B)" for this tool)
                    e.preventDefault();
                    let brushBtn = document.getElementById("qp-tool-brush");
                    if (brushBtn) brushBtn.click();
                    break;

                case "w": // QuPath: Wand
                    e.preventDefault();
                    let wandBtn = document.getElementById("qp-tool-wand");
                    if (wandBtn) wandBtn.click();
                    break;

                case ".": // QuPath: Points
                    e.preventDefault();
                    let pointsBtn = document.getElementById("qp-tool-points");
                    if (pointsBtn) pointsBtn.click();
                    break;

                case "s": // QuPath: Selection
                    e.preventDefault();
                    let selectionBtn = document.getElementById("qp-tool-selection");
                    if (selectionBtn) selectionBtn.click();
                    break;

                case "c": // Brightness & Contrast palette (matches qp-tool-contrast's own
                          // "(C)" tooltip, which "b" used to shadow before the fix above)
                    e.preventDefault();
                    AnnotationAdapter.launchBrightnessContrastPalette();
                    break;

                case "z": // QuPath: Zoom
                    e.preventDefault();
                    let zoomBtn = document.getElementById("qp-tool-zoom");
                    if (zoomBtn) zoomBtn.click();
                    break;
            }
        });
        window._wsiQuPathShortcutsBound = true;
        return true;
    }

    static bindOpenSeadragonCanvasKeyIntercept(viewer) {
        if (!viewer || typeof viewer.addHandler !== "function" || viewer._wsiQuPathCanvasKeyBound) {
            return Boolean(viewer?._wsiQuPathCanvasKeyBound);
        }
        viewer.addHandler("canvas-key", function(event) {
            let key = event.originalEvent?.key?.toLowerCase?.() || "";
            // "f" and "r"/"R" are also OSD's own built-in shortcuts for flip/rotate — block
            // them outright (not just redirected to a toolbar button like the others below)
            // so a stray keypress can never silently mirror or rotate the tile image out
            // from under annotations, which are positioned independently and never move.
            if (key === "f") {
                event.preventDefaultAction = true;
                if (typeof event.originalEvent?.preventDefault === "function") {
                    event.originalEvent.preventDefault();
                }
                return;
            }
            if (key === "t" && event.originalEvent?.ctrlKey && event.originalEvent?.shiftKey) {
                event.preventDefaultAction = true;
                if (typeof event.originalEvent?.preventDefault === "function") {
                    event.originalEvent.preventDefault();
                }
                return;
            }
            if (["a", "n", "d", "h", "b", "m", "r", "o", "l", "p", "v", "w", "s", "c", "z", "_", "-", "."].includes(key)) {
                event.preventDefaultAction = true; // Suppresses OSD's default pan/zoom behavior on these keys
                if (typeof event.originalEvent?.preventDefault === "function") {
                    event.originalEvent.preventDefault();
                }
            }
        });
        viewer._wsiQuPathCanvasKeyBound = true;
        return true;
    }

    static QUPATH_TOOL_ALIASES = {
        pan: "move",
        oval: "ellipse",
        multipoint: "points",
        ruler: "line"
    };

    static QUPATH_NAV_TOOLS = {
        move: true,
        selection: true,
        browser: true,
        contrast: true
    };

    static ensureCurrentActiveTool(name = "move") {
        const tool = String(name || "move").toLowerCase();
        AnnotationAdapter.currentActiveTool = tool;
        if (typeof window !== "undefined") window.currentActiveTool = tool;
        if (typeof globalThis !== "undefined") globalThis.currentActiveTool = tool;
        return tool;
    }

    static setViewerTool(tool, options = {}) {
        return AnnotationAdapter.activateQuPathTool(tool, options);
    }

    static installViewerToolAlias() {
        const fn = function(tool, options) {
            return AnnotationAdapter.setViewerTool(tool, options);
        };
        if (typeof window !== "undefined") window.setViewerTool = fn;
        if (typeof globalThis !== "undefined") globalThis.setViewerTool = fn;
        return fn;
    }

    static bindGlobalUiTooltip(root = null) {
        const doc = root && typeof root.createElement === "function"
            ? root
            : (typeof document !== "undefined" ? document : null);
        const body = doc?.body;
        if (!doc || !body || typeof body.appendChild !== "function") return false;
        if (doc._wsiGlobalTooltipBound) return true;
        let globalTooltip = doc.getElementById("global-ui-tooltip");
        if (!globalTooltip) {
            globalTooltip = doc.createElement("div");
            globalTooltip.id = "global-ui-tooltip";
            globalTooltip.style.cssText = "position: fixed; display: none; background: rgba(0, 0, 0, 0.95); color: #fff; padding: 6px 12px; border-radius: 4px; font-size: 0.8rem; font-weight: bold; pointer-events: none; z-index: 200000; box-shadow: 0 4px 12px rgba(0,0,0,0.6); border: 1px solid #444; font-family: sans-serif; white-space: pre-line;";
            body.appendChild(globalTooltip);
        }
        AnnotationAdapter.globalUiTooltipEl = globalTooltip;
        body.addEventListener("mouseover", function(e) {
            let target = e.target?.closest?.("[data-tooltip]");
            if (target) {
                globalTooltip.innerHTML = target.getAttribute("data-tooltip") || "";
                globalTooltip.style.display = "block";
            }
        });
        body.addEventListener("mousemove", function(e) {
            if (globalTooltip.style.display === "block") {
                const width = Number(globalTooltip.offsetWidth) || 0;
                const height = Number(globalTooltip.offsetHeight) || 0;
                let left = e.clientX - (width / 2);
                let top = e.clientY - height - 25;
                const viewW = typeof window !== "undefined" ? window.innerWidth : 1024;
                const viewH = typeof window !== "undefined" ? window.innerHeight : 768;
                if (top < 8) top = e.clientY + 18;
                if (top + height > viewH - 8) top = Math.max(8, e.clientY - height - 25);
                left = Math.max(8, Math.min(left, viewW - width - 8));
                globalTooltip.style.left = `${left}px`;
                globalTooltip.style.top = `${top}px`;
            }
        });
        body.addEventListener("mouseout", function(e) {
            const from = e.target?.closest?.("[data-tooltip]");
            const to = e.relatedTarget && typeof e.relatedTarget.closest === "function"
                ? e.relatedTarget.closest("[data-tooltip]")
                : null;
            if (from && from !== to) globalTooltip.style.display = "none";
        });
        doc._wsiGlobalTooltipBound = true;
        return true;
    }

    static activateQuPathTool(tool, options = {}) {
        const raw = String(tool || "").toLowerCase();
        const name = AnnotationAdapter.QUPATH_TOOL_ALIASES[raw] || raw;
        if (!name) return false;
        AnnotationAdapter.ensureCurrentActiveTool(name);
        AnnotationAdapter.activeImageJTool = name === "move" ? "pan" : name;
        AnnotationAdapter.syncQuPathToolChrome(name);
        AnnotationAdapter.cancelQuPathDrawSession({ keepTool: true });
        // Switching to the Move tool is the deliberate "step away from editing" gesture,
        // so it also clears any lingering annotation selection (single or multi-select).
        if (name === "move") AnnotationAdapter.deselectNativeAnnotationShape();
        if (name === "wand") {
            try { AnnotationAdapter.hideAnnotationEditorPopup(null, { commit: false }); } catch (_error) { /* ignore */ }
            AnnotationAdapter.openFloatingWandPalette();
        }

        if (name === "browser") {
            const side = (typeof document !== "undefined" && document.getElementById)
                ? (document.getElementById("toggle-left") || document.getElementById("toggle-sidebar-btn"))
                : null;
            if (side && typeof side.click === "function") side.click();
            return true;
        }
        if (name === "contrast") {
            AnnotationAdapter.launchBrightnessContrastPalette();
            return true;
        }

        const engine = options.annotationEngine
            || options.annotationSpike
            || AnnotationAdapter.annotationEngine
            || AnnotationAdapter.annotationSpike;
        const viewer = AnnotationAdapter.viewer;
        if (name !== "line") {
            try { AnnotationAdapter.releaseMeasurementPointerLock(options.event || {}); } catch (_error) { /* ignore */ }
        }
        if (engine) {
            const drawing = !AnnotationAdapter.QUPATH_NAV_TOOLS[name]
                && name !== "selection" && name !== "browser" && name !== "contrast" && name !== "zoom";
            engine.drawingEnabled = drawing;
            engine.toggleButton?.setAttribute?.("aria-pressed", String(name === "rectangle"));
        }

        const navOn = Boolean(AnnotationAdapter.QUPATH_NAV_TOOLS[name]);
        if (viewer && typeof viewer.setMouseNavEnabled === "function") {
            viewer.setMouseNavEnabled(navOn);
        }
        if (navOn) AnnotationAdapter.setMeasureTracking(false);
        return true;
    }

    static activateImageJTool(tool, options = {}) {
        return AnnotationAdapter.activateQuPathTool(tool, options);
    }

    static syncQuPathToolChrome(tool) {
        const doc = typeof document !== "undefined" ? document : null;
        // Covers both the always-visible primary toolbar's duplicate tool buttons and the
        // sandboxed secondary toolbar's originals so their pressed/active chrome never
        // drifts out of sync with each other, whichever one the user actually clicked.
        // "Zoom to Fit" is an independent lock toggle (like real QuPath), not a mutually
        // exclusive drawing tool, so it's excluded here — see bindQuPathZoomFitToggle,
        // which owns its own aria-pressed state instead.
        const buttons = doc?.querySelectorAll?.(
            "#secondary-annotation-toolbar .qp-tool:not(.qp-zoomfit-toggle), #secondary-annotation-toolbar .ij-tool, "
            + "#primary-unified-toolbar .qp-tool:not(.qp-zoomfit-toggle), #primary-unified-toolbar .ij-tool"
        );
        if (!buttons) return false;
        for (const btn of buttons) {
            const id = btn.getAttribute("data-qp-tool") || btn.getAttribute("data-ij-tool");
            const mapped = AnnotationAdapter.QUPATH_TOOL_ALIASES[id] || id;
            if (mapped === "contrast" || mapped === "browser") {
                btn.setAttribute("aria-pressed", "false");
                continue;
            }
            btn.setAttribute("aria-pressed", String(mapped === tool));
        }
        return true;
    }

    /**
     * "Zoom to Fit" — matched from real QuPath's toolbar: an independent lock toggle
     * (not a mutually-exclusive drawing tool) that snaps to the home view and disables
     * manual scroll-wheel zoom while active. Both toolbar instances share one boolean
     * via `.qp-zoomfit-toggle` rather than participating in syncQuPathToolChrome's
     * single-active-tool bookkeeping.
     */
    static zoomFitActive = false;

    static toggleQuPathZoomFit(doc = null) {
        const document_ = AnnotationAdapter._documentFromRoot(doc);
        AnnotationAdapter.zoomFitActive = !AnnotationAdapter.zoomFitActive;
        const active = AnnotationAdapter.zoomFitActive;
        document_?.querySelectorAll?.(".qp-zoomfit-toggle")?.forEach(btn => {
            btn.setAttribute("aria-pressed", String(active));
        });
        const viewer = AnnotationAdapter.viewer;
        if (viewer?.viewport) {
            if (active) {
                try { viewer.viewport.goHome(true); } catch (_error) { /* ignore */ }
            }
            [viewer.gestureSettingsMouse, viewer.gestureSettingsTouch, viewer.gestureSettingsPen].forEach(settings => {
                if (settings) settings.scrollToZoom = !active;
            });
        }
        return active;
    }

    /** Keeps the "Zoom to Fit" lock honest across container/window resizes. */
    static bindQuPathZoomFitResize() {
        const viewer = AnnotationAdapter.viewer;
        if (!viewer || typeof viewer.addHandler !== "function" || viewer._wsiZoomFitResizeBound) return false;
        viewer.addHandler("resize", () => {
            if (!AnnotationAdapter.zoomFitActive) return;
            try { viewer.viewport.goHome(true); } catch (_error) { /* ignore */ }
        });
        viewer._wsiZoomFitResizeBound = true;
        return true;
    }

    /** Matches real QuPath's "10.0x"-style magnification readout format. */
    static formatMagnificationLabel(viewer) {
        const activeViewer = viewer || AnnotationAdapter.viewer;
        if (!activeViewer?.viewport) return null;
        const currentZoom = activeViewer.viewport.getZoom(true);
        const homeZoom = activeViewer.viewport.getHomeZoom();
        if (!(homeZoom > 0) || !Number.isFinite(currentZoom)) return null;
        const displayZoom = currentZoom / homeZoom;
        return `${displayZoom.toFixed(displayZoom < 10 ? 2 : 1)}x`;
    }

    /** Called on every zoom/pan/open tick (see index.html's updateViewerStatus). */
    static refreshMagnificationLabels(viewer) {
        const doc = typeof document !== "undefined" ? document : null;
        if (!doc?.querySelectorAll) return;
        const label = AnnotationAdapter.formatMagnificationLabel(viewer);
        if (label == null) return;
        doc.querySelectorAll(".qp-magnification:not(.is-editing)").forEach(el => {
            el.textContent = label;
        });
    }

    /**
     * QuPath's "Magnification" box: double-click opens an inline numeric editor; Enter
     * jumps the viewer to that exact magnification (relative to the fitted home zoom),
     * Escape/blur cancels/commits respectively. See docs: double-click the "10.0x" box.
     */
    static bindQuPathMagnificationControl(doc = null) {
        const document_ = AnnotationAdapter._documentFromRoot(doc);
        if (!document_?.querySelectorAll) return false;
        document_.querySelectorAll(".qp-magnification").forEach(el => {
            if (el.dataset && el.dataset.magBound === "1") return;
            el.addEventListener("dblclick", event => {
                event.preventDefault();
                AnnotationAdapter.beginMagnificationEdit(el);
            });
            if (el.dataset) el.dataset.magBound = "1";
        });
        return true;
    }

    static beginMagnificationEdit(button) {
        if (!button || button.classList.contains("is-editing")) return false;
        const viewer = AnnotationAdapter.viewer;
        if (!viewer?.viewport) return false;
        const doc = button.ownerDocument || document;
        const currentText = String(button.textContent || "").replace(/x$/i, "").trim();
        button.classList.add("is-editing");
        button.textContent = "";
        const input = doc.createElement("input");
        input.type = "text";
        input.inputMode = "decimal";
        input.className = "qp-magnification-input";
        input.value = currentText;
        button.appendChild(input);
        input.focus();
        input.select();

        let settled = false;
        const finish = commit => {
            if (settled) return;
            settled = true;
            if (commit) {
                const parsed = parseFloat(input.value);
                const homeZoom = viewer.viewport.getHomeZoom();
                if (Number.isFinite(parsed) && parsed > 0 && homeZoom > 0) {
                    try { viewer.viewport.zoomTo(parsed * homeZoom); } catch (_error) { /* ignore */ }
                }
            }
            button.classList.remove("is-editing");
            button.textContent = AnnotationAdapter.formatMagnificationLabel(viewer) || `${currentText}x`;
        };
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") { event.preventDefault(); finish(true); }
            else if (event.key === "Escape") { event.preventDefault(); finish(false); }
        });
        input.addEventListener("blur", () => finish(true));
        return true;
    }

    static bindQuPathToolPointers() {
        if (typeof document === "undefined" || document._wsiQuPathPointersBound) return false;
        document.addEventListener("mousedown", event => {
            AnnotationAdapter.onQuPathPointerDown(event);
        }, true);
        document.addEventListener("mousemove", event => {
            AnnotationAdapter.onQuPathPointerMove(event);
        }, true);
        document.addEventListener("mouseup", event => {
            AnnotationAdapter.onQuPathPointerUp(event);
        }, true);
        document.addEventListener("click", event => {
            const tool = AnnotationAdapter.currentActiveTool || "move";
            if (tool === "polygon" || tool === "polyline") return;
            const hit = event.target?.closest?.(".osd-annotation-shape, .annotation-shape-overlay");
            if (hit) {
                event.preventDefault();
                event.stopPropagation();
                AnnotationAdapter.selectNativeAnnotationShape(hit.getAttribute("data-annotation-id"), {
                    additive: Boolean(event.shiftKey)
                });
                return;
            }
            // Clicking away (in the viewer, but not on a shape) reverts the selection highlight,
            // as long as this was a genuine click and not the mouseup end of a pan/drag.
            const hasSelection = Boolean(AnnotationAdapter.selectedNativeAnnotationId)
                || Boolean(AnnotationAdapter.selectedNativeAnnotationIds?.size);
            if (hasSelection
                && AnnotationAdapter.quPathEventOnViewer(event)
                && !AnnotationAdapter.wasQuPathClickADrag(event)) {
                AnnotationAdapter.deselectNativeAnnotationShape();
            }
        }, true);
        document.addEventListener("dblclick", event => {
            AnnotationAdapter.onQuPathDoubleClick(event);
        }, true);
        document._wsiQuPathPointersBound = true;
        return true;
    }

    static quPathEventOnViewer(event) {
        if (!event) return false;
        if (event.target?.closest?.("#secondary-annotation-toolbar, header, aside, #annotation-editor-popup, #floating-wand-palette, #floating-shortcuts-legend, input, textarea, select, button")) {
            return false;
        }
        const host = AnnotationAdapter.viewer?.element || AnnotationAdapter.viewer?.canvas;
        if (!host) return false;
        if (typeof host.contains === "function" && event.target && !host.contains(event.target)
            && !event.target?.closest?.(".osd-annotation-shape, .osd-svg-overlay")) {
            return false;
        }
        return true;
    }

    static quPathClientPoint(event) {
        const host = AnnotationAdapter.viewer?.element || AnnotationAdapter.viewer?.canvas;
        const rect = host?.getBoundingClientRect?.();
        const x = Number(event?.clientX);
        const y = Number(event?.clientY);
        if (!rect || !Number.isFinite(x) || !Number.isFinite(y)) {
            return { overlayX: x, overlayY: y, image: null };
        }
        const overlayX = x - rect.left;
        const overlayY = y - rect.top;
        let image = null;
        let viewportX = overlayX;
        let viewportY = overlayY;
        try {
            const viewer = AnnotationAdapter.viewer;
            if (viewer?.viewport) {
                const OSD = AnnotationAdapter._openSeadragon();
                const pixel = OSD ? new OSD.Point(overlayX, overlayY) : { x: overlayX, y: overlayY };
                const vp = viewer.viewport.pointFromPixel(pixel, true);
                viewportX = Number(vp?.x);
                viewportY = Number(vp?.y);
            }
            image = AnnotationAdapter.screenPixelToImagePoint(AnnotationAdapter.viewer, overlayX, overlayY);
        } catch (_error) { /* keep overlay point */ }
        return { overlayX, overlayY, viewportX, viewportY, image };
    }

    /**
     * Single click on an existing shape only selects it (sets selectedNativeAnnotationId and
     * applies a highlight class); it does NOT open the name popup. Double-click
     * (onQuPathDoubleClick) is what opens the name popup.
     */
    /** Clears the highlight class from every element carrying it, regardless of whether it
     *  matches selectedNativeAnnotationId — a real DOM can end up with the class on a node
     *  other than the one the id-based lookup expects (e.g. after a redraw/re-render), so a
     *  full sweep is the only way to reliably guarantee no stale highlight is left behind. */
    static clearNativeAnnotationHighlights() {
        const doc = typeof document !== "undefined" ? document : null;
        const nodes = doc?.querySelectorAll?.(".is-annotation-selected") || [];
        nodes.forEach?.(node => node.classList?.remove?.("is-annotation-selected"));
    }

    /**
     * Plain click (options.additive falsy) replaces the whole selection with just `id`.
     * Shift-click (options.additive true) adds `id` to the existing selection, or — if it
     * is already selected — removes just that one shape, leaving the rest selected (the
     * standard multi-select toggle convention).
     */
    static selectNativeAnnotationShape(id, options = {}) {
        if (!id) return false;
        if (!(AnnotationAdapter.selectedNativeAnnotationIds instanceof Set)) {
            AnnotationAdapter.selectedNativeAnnotationIds = new Set();
        }
        const doc = typeof document !== "undefined" ? document : null;
        const set = AnnotationAdapter.selectedNativeAnnotationIds;
        const additive = Boolean(options.additive);

        if (additive && set.has(id)) {
            set.delete(id);
            doc?.querySelector?.(`[data-annotation-id="${id}"]`)?.classList?.remove?.("is-annotation-selected");
            const remaining = set.size ? set.values().next().value : null;
            AnnotationAdapter.selectedNativeAnnotationId = remaining;
            AnnotationAdapter.refreshExportSelectedAnnotationButtonState();
            return true;
        }

        if (!additive) {
            AnnotationAdapter.clearNativeAnnotationHighlights();
            set.clear();
        }
        set.add(id);
        AnnotationAdapter.selectedNativeAnnotationId = id;
        doc?.querySelector?.(`[data-annotation-id="${id}"]`)?.classList?.add?.("is-annotation-selected");
        AnnotationAdapter.refreshExportSelectedAnnotationButtonState();
        return true;
    }

    /** Reverts every selection highlight (single or multi) and clears both
     *  selectedNativeAnnotationId and selectedNativeAnnotationIds. */
    static deselectNativeAnnotationShape() {
        const hasSelection = Boolean(AnnotationAdapter.selectedNativeAnnotationId)
            || Boolean(AnnotationAdapter.selectedNativeAnnotationIds?.size);
        if (!hasSelection) return false;
        AnnotationAdapter.clearNativeAnnotationHighlights();
        AnnotationAdapter.selectedNativeAnnotationId = null;
        AnnotationAdapter.selectedNativeAnnotationIds?.clear?.();
        AnnotationAdapter.refreshExportSelectedAnnotationButtonState();
        return true;
    }

    /** Lazily hydrates lockedAnnotationIds from localStorage exactly once. */
    static ensureLockedAnnotationIdsLoaded() {
        if (AnnotationAdapter._lockedAnnotationsLoaded) return AnnotationAdapter.lockedAnnotationIds;
        AnnotationAdapter._lockedAnnotationsLoaded = true;
        try {
            const raw = typeof localStorage !== "undefined"
                ? localStorage.getItem(AnnotationAdapter.LOCKED_ANNOTATIONS_STORAGE_KEY)
                : null;
            const list = raw ? JSON.parse(raw) : [];
            if (Array.isArray(list)) list.forEach(id => AnnotationAdapter.lockedAnnotationIds.add(id));
        } catch (_error) { /* ignore corrupt/unavailable storage */ }
        return AnnotationAdapter.lockedAnnotationIds;
    }

    static persistLockedAnnotationIds() {
        try {
            if (typeof localStorage !== "undefined") {
                localStorage.setItem(
                    AnnotationAdapter.LOCKED_ANNOTATIONS_STORAGE_KEY,
                    JSON.stringify(Array.from(AnnotationAdapter.lockedAnnotationIds))
                );
            }
        } catch (_error) { /* ignore quota/availability errors */ }
    }

    static isAnnotationLocked(id) {
        if (!id) return false;
        AnnotationAdapter.ensureLockedAnnotationIdsLoaded();
        return AnnotationAdapter.lockedAnnotationIds.has(id);
    }

    /** Locks/unlocks position-drag for exactly one annotation id, without touching any
     *  other annotation's lock state. Mirrors the change onto that shape's DOM node
     *  (visual "is-annotation-locked" class) and persists it to localStorage. */
    static setAnnotationLocked(id, locked) {
        if (!id) return false;
        AnnotationAdapter.ensureLockedAnnotationIdsLoaded();
        if (locked) AnnotationAdapter.lockedAnnotationIds.add(id);
        else AnnotationAdapter.lockedAnnotationIds.delete(id);
        AnnotationAdapter.persistLockedAnnotationIds();
        const doc = typeof document !== "undefined" ? document : null;
        doc?.querySelector?.(`[data-annotation-id="${id}"]`)
            ?.classList?.toggle?.("is-annotation-locked", Boolean(locked));
        return true;
    }

    static toggleAnnotationLocked(id) {
        if (!id) return false;
        AnnotationAdapter.setAnnotationLocked(id, !AnnotationAdapter.isAnnotationLocked(id));
        return true;
    }

    /** Positions and reveals the right-click "Lock/Unlock Position" menu for one or more
     *  annotation ids (a plain right-click targets just that one shape; right-clicking a
     *  shape that is part of the current multi-selection targets the whole group instead —
     *  see the contextmenu listener in attachAnnotationShapeOverlay). The button label
     *  reflects whether every targeted id is already locked ("all locked" → offers to
     *  unlock all; anything else → offers to lock all, including the already-locked ones,
     *  which is a harmless no-op for those). */
    static openAnnotationContextMenu(ids, clientX, clientY, root = null) {
        const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
        if (!list.length) return false;
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const menu = doc?.getElementById?.("annotation-context-menu");
        if (!menu) return false;
        if (menu.dataset) menu.dataset.targetAnnotationIds = JSON.stringify(list);
        const toggleBtn = doc.getElementById("annotation-context-menu-lock-toggle");
        if (toggleBtn) {
            const allLocked = list.every(id => AnnotationAdapter.isAnnotationLocked(id));
            const suffix = list.length > 1 ? ` (${list.length} Selected)` : "";
            toggleBtn.textContent = (allLocked ? "🔓 Unlock Position" : "🔒 Lock Position") + suffix;
        }
        if (menu.style) {
            menu.style.display = "block";
            const vw = doc.documentElement?.clientWidth
                || (typeof window !== "undefined" ? window.innerWidth : 0) || 0;
            const vh = doc.documentElement?.clientHeight
                || (typeof window !== "undefined" ? window.innerHeight : 0) || 0;
            const width = menu.offsetWidth || 190;
            const height = menu.offsetHeight || 40;
            const left = Math.max(0, Math.min(Number(clientX) || 0, vw - width - 4));
            const top = Math.max(0, Math.min(Number(clientY) || 0, vh - height - 4));
            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
        }
        return true;
    }

    static closeAnnotationContextMenu(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const menu = doc?.getElementById?.("annotation-context-menu");
        if (!menu) return false;
        if (menu.style) menu.style.display = "none";
        if (menu.dataset) delete menu.dataset.targetAnnotationIds;
        return true;
    }

    static bindAnnotationContextMenu(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const menu = doc?.getElementById?.("annotation-context-menu");
        if (!menu || menu.dataset?.contextMenuBound === "1") return false;
        const toggleBtn = doc.getElementById("annotation-context-menu-lock-toggle");
        if (toggleBtn) {
            toggleBtn.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                let ids = [];
                try { ids = JSON.parse(menu.dataset?.targetAnnotationIds || "[]"); } catch (_error) { ids = []; }
                if (Array.isArray(ids) && ids.length) {
                    const allLocked = ids.every(id => AnnotationAdapter.isAnnotationLocked(id));
                    const nextLocked = !allLocked;
                    ids.forEach(id => AnnotationAdapter.setAnnotationLocked(id, nextLocked));
                }
                AnnotationAdapter.closeAnnotationContextMenu(doc);
            });
        }
        doc.addEventListener("click", event => {
            if (!menu.style || menu.style.display === "none") return;
            if (event.target?.closest?.("#annotation-context-menu")) return;
            AnnotationAdapter.closeAnnotationContextMenu(doc);
        }, true);
        doc.addEventListener("contextmenu", event => {
            if (!menu.style || menu.style.display === "none") return;
            if (event.target?.closest?.(".osd-annotation-shape, .annotation-shape-overlay, #annotation-context-menu")) return;
            AnnotationAdapter.closeAnnotationContextMenu(doc);
        }, true);
        doc.addEventListener("keydown", event => {
            if (event.key === "Escape") AnnotationAdapter.closeAnnotationContextMenu(doc);
        });
        if (menu.dataset) menu.dataset.contextMenuBound = "1";
        return true;
    }

    /** The click-to-select flow above only toggles a highlight class + the static
     *  selectedNativeAnnotationId — it deliberately does NOT call the annotation
     *  engine's own notifySelectionChanged() (that also pops open the name editor,
     *  which would reintroduce the "popup on single click" regression fixed earlier).
     *  So the "Export Annotation" toolbar button's disabled state, which index.html
     *  only recomputes via that same notifySelectionChanged() callback, never learns
     *  about clicks made through this path. This mirrors just that one piece of state
     *  directly onto the real button, which — via the export/overview MutationObserver
     *  proxy wiring — also keeps every duplicate button (primary/sandbox/secondary) in sync. */
    static refreshExportSelectedAnnotationButtonState() {
        const doc = typeof document !== "undefined" ? document : null;
        const button = doc?.getElementById?.("export-selected-annotation");
        if (!button) return false;
        const engine = AnnotationAdapter.annotationEngine || AnnotationAdapter.annotationSpike;
        const selectedCount = engine?.getSelectedAnnotations?.()?.length ?? 0;
        const visible = engine ? Boolean(engine.annotationsVisible) : Boolean(AnnotationAdapter.vectorOutlinesVisible);
        button.disabled = !(visible && selectedCount === 1);
        return true;
    }

    /** True if the pointer moved more than a small threshold between mousedown and this click
     *  (i.e. this "click" is really the tail end of a pan/drag, not a deliberate click).
     *  15px accounts for real mouse/trackpad jitter on an intentional click, which easily
     *  exceeds a few pixels and would otherwise get misclassified as a drag. */
    static wasQuPathClickADrag(event, thresholdPx = 15) {
        const start = AnnotationAdapter._qpMouseDownPoint;
        if (!start) return false;
        const dx = Number(event?.clientX) - start.x;
        const dy = Number(event?.clientY) - start.y;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
        return ((dx * dx) + (dy * dy)) > (thresholdPx * thresholdPx);
    }

    static onQuPathPointerDown(event) {
        AnnotationAdapter._qpMouseDownPoint = { x: Number(event?.clientX), y: Number(event?.clientY) };
        const tool = AnnotationAdapter.currentActiveTool || "move";
        if (tool === "polygon" || tool === "polyline") {
            return AnnotationAdapter.handleQuPathClickPathInput(event, {
                finish: Number(event.detail) >= 2
            });
        }
        const hit = event.target?.closest?.(".osd-annotation-shape, .annotation-shape-overlay");
        if (hit) {
            // Skip the shift-held case here: the document "click" handler right below is the
            // single place that runs the additive add/remove toggle, so it doesn't get invoked
            // twice per shift-click (mousedown + click on the same shape), which would otherwise
            // add-then-immediately-remove it. A plain (non-shift) select is idempotent, so it is
            // safe/harmless to also pre-select here on mousedown (keeps a fast click+drag feeling
            // instantly responsive).
            if (!event.shiftKey) {
                AnnotationAdapter.selectNativeAnnotationShape(hit.getAttribute("data-annotation-id"));
            }
            return true;
        }
        if (tool === "move" || tool === "selection" || tool === "browser" || tool === "contrast") {
            return false;
        }
        if (!AnnotationAdapter.quPathEventOnViewer(event) || event.button !== 0) return false;
        const point = AnnotationAdapter.quPathClientPoint(event);
        const shiftKey = Boolean(event.shiftKey || event.originalEvent?.shiftKey);
        if (tool === "rectangle" || tool === "ellipse" || tool === "line" || tool === "brush") {
            if (typeof event.preventDefault === "function") event.preventDefault();
            AnnotationAdapter.qpDrawSession = {
                tool,
                dragging: true,
                shiftKey,
                start: point,
                current: AnnotationAdapter.applyQuPathShiftConstraint(point, point, tool, shiftKey),
                vertices: [{ ...point }]
            };
            AnnotationAdapter.redrawQuPathPreview();
            return true;
        }
        if (tool === "points") {
            AnnotationAdapter.commitQuPathShape({
                type: "points",
                vertices: [point],
                start: point,
                current: point
            }, event);
            return true;
        }
        if (tool === "wand") {
            if (event.target?.closest?.("#qp-tool-wand, #wand-config-dropdown, #floating-wand-palette, #floating-shortcuts-legend, #secondary-annotation-toolbar, header, aside, button, select")) {
                return false;
            }
            if (typeof event.preventDefault === "function") event.preventDefault();
            return AnnotationAdapter.beginWandDrawSession(event);
        }
        if (tool === "zoom") {
            AnnotationAdapter.handleImageJZoomClick(event);
            return true;
        }
        return false;
    }

    static onQuPathPointerMove(event) {
        const session = AnnotationAdapter.qpDrawSession;
        if (!session) return false;
        const shiftKey = Boolean(event.shiftKey || event.originalEvent?.shiftKey);
        session.shiftKey = shiftKey;
        const point = AnnotationAdapter.quPathClientPoint(event);
        if (session.tool === "polygon" || session.tool === "polyline") {
            session.current = point;
            session.dragging = false;
            AnnotationAdapter.redrawQuPathPreview();
            return true;
        }
        if (session.tool === "wand") {
            return AnnotationAdapter.growWandDrawSession(event);
        }
        session.current = AnnotationAdapter.applyQuPathShiftConstraint(
            session.start,
            point,
            session.tool,
            shiftKey
        );
        if (session.tool === "brush" && session.dragging) {
            session.vertices.push(session.current);
        }
        AnnotationAdapter.redrawQuPathPreview();
        return true;
    }

    static polygonVerticesTooClose(a, b) {
        if (!a || !b) return false;
        const overlayDx = Number(a.overlayX) - Number(b.overlayX);
        const overlayDy = Number(a.overlayY) - Number(b.overlayY);
        if (Number.isFinite(overlayDx) && Number.isFinite(overlayDy)) {
            return ((overlayDx * overlayDx) + (overlayDy * overlayDy)) < 64;
        }
        const dx = AnnotationAdapter.shapeCoordX(a) - AnnotationAdapter.shapeCoordX(b);
        const dy = AnnotationAdapter.shapeCoordY(a) - AnnotationAdapter.shapeCoordY(b);
        return ((dx * dx) + (dy * dy)) < 1e-6;
    }

    static handleQuPathClickPathInput(event, options = {}) {
        const tool = AnnotationAdapter.currentActiveTool || "move";
        if (tool !== "polygon" && tool !== "polyline") return false;
        if (!AnnotationAdapter.quPathEventOnViewer(event)) return false;
        if (event.button != null && event.button !== 0) return false;
        if (typeof event.preventDefault === "function") event.preventDefault();
        const point = AnnotationAdapter.quPathClientPoint(event);
        const finish = Boolean(options.finish) || Number(event.detail) >= 2;
        AnnotationAdapter.appendPolygonTraceVertex(point, tool);
        if (finish) return AnnotationAdapter.finishQuPathClickPath(event);
        return true;
    }

    static onQuPathDoubleClick(event) {
        const hit = event.target?.closest?.(".osd-annotation-shape, .annotation-shape-overlay");
        if (hit) {
            AnnotationAdapter.openAnnotationNamePanelForShape(
                hit.getAttribute("data-annotation-id"),
                event
            );
            return true;
        }
        const tool = AnnotationAdapter.currentActiveTool || "move";
        if (tool === "polygon" || tool === "polyline") {
            return AnnotationAdapter.handleQuPathClickPathInput(event, { finish: true });
        }
        // Double-click on empty canvas space (no shape hit, not mid polygon/polyline trace)
        // is the other deliberate "deselect everything" gesture.
        const hasSelection = Boolean(AnnotationAdapter.selectedNativeAnnotationId)
            || Boolean(AnnotationAdapter.selectedNativeAnnotationIds?.size);
        if (hasSelection && AnnotationAdapter.quPathEventOnViewer(event)) {
            AnnotationAdapter.deselectNativeAnnotationShape();
        }
        return false;
    }

    static appendPolygonTraceVertex(point, tool) {
        const name = tool || "polygon";
        const session = AnnotationAdapter.qpDrawSession?.tool === name
            ? AnnotationAdapter.qpDrawSession
            : { tool: name, dragging: false, start: point, current: point, vertices: [] };
        const last = session.vertices[session.vertices.length - 1];
        if (last && AnnotationAdapter.polygonVerticesTooClose(last, point)) {
            AnnotationAdapter.qpDrawSession = session;
            AnnotationAdapter.redrawQuPathPreview();
            return true;
        }
        session.vertices.push(point);
        session.start = session.vertices[0];
        session.current = point;
        session.dragging = false;
        AnnotationAdapter.qpDrawSession = session;
        AnnotationAdapter.redrawQuPathPreview();
        return true;
    }

    static onQuPathPointerUp(event) {
        const session = AnnotationAdapter.qpDrawSession;
        if (!session || !session.dragging) return false;
        const shiftKey = Boolean(event.shiftKey || event.originalEvent?.shiftKey);
        session.shiftKey = shiftKey;
        session.current = AnnotationAdapter.applyQuPathShiftConstraint(
            session.start,
            AnnotationAdapter.quPathClientPoint(event),
            session.tool,
            shiftKey
        );
        session.dragging = false;
        if (session.tool === "rectangle" || session.tool === "ellipse" || session.tool === "line" || session.tool === "brush") {
            AnnotationAdapter.commitQuPathShape({
                type: session.tool,
                start: session.start,
                current: session.current,
                vertices: session.vertices,
                shiftKey
            }, event);
            AnnotationAdapter.qpDrawSession = null;
            AnnotationAdapter.clearQuPathPreview();
        }
        if (session.tool === "wand") {
            return AnnotationAdapter.finishWandDrawSession(event);
        }
        return true;
    }

    static finishQuPathClickPath(event = null) {
        const session = AnnotationAdapter.qpDrawSession;
        if (!session || (session.tool !== "polygon" && session.tool !== "polyline")) return false;
        const min = session.tool === "polygon" ? 3 : 2;
        if (!Array.isArray(session.vertices) || session.vertices.length < min) return false;
        AnnotationAdapter.commitQuPathShape({
            type: session.tool,
            vertices: session.vertices.slice(),
            start: session.vertices[0],
            current: session.vertices[session.vertices.length - 1]
        }, event);
        AnnotationAdapter.qpDrawSession = null;
        AnnotationAdapter.clearQuPathPreview();
        return true;
    }

    static applyQuPathShiftConstraint(start, current, tool, shiftKey) {
        if (!shiftKey || !start || !current || (tool !== "rectangle" && tool !== "ellipse")) {
            return current;
        }
        let deltaX = Math.abs(AnnotationAdapter.shapeCoordX(current) - AnnotationAdapter.shapeCoordX(start));
        let deltaY = Math.abs(AnnotationAdapter.shapeCoordY(current) - AnnotationAdapter.shapeCoordY(start));
        const signX = AnnotationAdapter.shapeCoordX(current) >= AnnotationAdapter.shapeCoordX(start) ? 1 : -1;
        const signY = AnnotationAdapter.shapeCoordY(current) >= AnnotationAdapter.shapeCoordY(start) ? 1 : -1;
        if (tool === "rectangle") {
            let side = Math.max(deltaX, deltaY);
            deltaX = side;
            deltaY = side;
        } else {
            // Ellipse: force rx and ry identical from the maximum pointer displacement.
            let side = Math.max(deltaX, deltaY);
            deltaX = side;
            deltaY = side;
        }
        const next = {
            ...current,
            overlayX: Number(start.overlayX) + signX * Math.max(
                Math.abs(Number(current.overlayX) - Number(start.overlayX)),
                Math.abs(Number(current.overlayY) - Number(start.overlayY))
            ),
            overlayY: Number(start.overlayY) + signY * Math.max(
                Math.abs(Number(current.overlayX) - Number(start.overlayX)),
                Math.abs(Number(current.overlayY) - Number(start.overlayY))
            ),
            viewportX: AnnotationAdapter.shapeCoordX(start) + signX * deltaX,
            viewportY: AnnotationAdapter.shapeCoordY(start) + signY * deltaY
        };
        if (start.image && current.image) {
            let imgDx = Math.abs(Number(current.image.x) - Number(start.image.x));
            let imgDy = Math.abs(Number(current.image.y) - Number(start.image.y));
            const imgSignX = Number(current.image.x) >= Number(start.image.x) ? 1 : -1;
            const imgSignY = Number(current.image.y) >= Number(start.image.y) ? 1 : -1;
            const imgSide = Math.max(imgDx, imgDy);
            next.image = {
                ...current.image,
                x: Number(start.image.x) + imgSignX * imgSide,
                y: Number(start.image.y) + imgSignY * imgSide
            };
        }
        return next;
    }

    static cancelQuPathDrawSession(options = {}) {
        AnnotationAdapter.qpDrawSession = null;
        AnnotationAdapter.clearQuPathPreview();
        if (!options.keepTool) return true;
        return true;
    }

    static ensureQuPathDrawOverlay() {
        const viewer = AnnotationAdapter.viewer;
        AnnotationAdapter.installSvgOverlayPlugin();
        let root = null;
        try {
            if (viewer && typeof viewer.svgOverlay === "function") {
                root = viewer.svgOverlay()?.node?.();
            }
        } catch (_error) { /* fall through */ }
        if (!root) {
            const doc = typeof document !== "undefined" ? document : null;
            const container = viewer?.element || viewer?.container || viewer?.canvas
                || doc?.getElementById?.("viewer");
            if (!doc || !container) return AnnotationAdapter.qpDrawOverlayEl;
            root = AnnotationAdapter.qpDrawOverlayEl;
            if (!root) {
                root = AnnotationAdapter._svgEl("svg");
                root.setAttribute("class", "osd-svg-overlay wsi-qp-draw-overlay");
                root.setAttribute("aria-hidden", "true");
                if (root.style) {
                    root.style.position = "absolute";
                    root.style.left = "0";
                    root.style.top = "0";
                    root.style.width = "100%";
                    root.style.height = "100%";
                    root.style.pointerEvents = "none";
                    root.style.overflow = "visible";
                }
            }
            if (root.parentElement !== container && typeof container.appendChild === "function") {
                container.appendChild(root);
            }
        }
        if (root && !root.querySelector?.("[data-qp-committed]")) {
            const committed = AnnotationAdapter._svgEl("g");
            committed.setAttribute("data-qp-committed", "1");
            const preview = AnnotationAdapter._svgEl("g");
            preview.setAttribute("data-qp-preview", "1");
            preview.style.pointerEvents = "none";
            if (typeof root.appendChild === "function") {
                root.appendChild(committed);
                root.appendChild(preview);
            }
        }
        AnnotationAdapter.qpDrawOverlayEl = root;
        return root;
    }

    static quPathPreviewGroup() {
        const svg = AnnotationAdapter.ensureQuPathDrawOverlay();
        return svg?.querySelector?.("[data-qp-preview]") || null;
    }

    static quPathCommittedGroup() {
        const svg = AnnotationAdapter.ensureQuPathDrawOverlay();
        return svg?.querySelector?.("[data-qp-committed]") || null;
    }

    static clearQuPathPreview() {
        const group = AnnotationAdapter.quPathPreviewGroup();
        if (group) group.innerHTML = "";
        return true;
    }

    static redrawQuPathPreview() {
        const session = AnnotationAdapter.qpDrawSession;
        const group = AnnotationAdapter.quPathPreviewGroup();
        if (!session || !group) return false;
        group.innerHTML = "";
        const node = AnnotationAdapter.buildQuPathSvgShape(session.tool, session);
        if (node) {
            if (node.style) node.style.pointerEvents = "none";
            node.setAttribute?.("pointer-events", "none");
            group.appendChild(node);
        }
        return true;
    }

    static buildPolygonTracePreview(type, vertices, current) {
        const xOf = pt => AnnotationAdapter.shapeCoordX(pt);
        const yOf = pt => AnnotationAdapter.shapeCoordY(pt);
        const list = Array.isArray(vertices) ? vertices : [];
        const g = AnnotationAdapter._svgEl("g");
        if (!list.length) return AnnotationAdapter.applyOsdAnnotationStyle(g, { filled: false });
        let d = "";
        list.forEach((vertex, index) => {
            d += `${index === 0 ? "M" : "L"}${xOf(vertex)} ${yOf(vertex)}`;
        });
        if (type === "polygon" && list.length > 2 && !current) d += "Z";
        const path = AnnotationAdapter._svgEl("path");
        path.setAttribute("d", d);
        AnnotationAdapter.applyOsdAnnotationStyle(path, { filled: type === "polygon" && list.length > 2 && !current });
        if (type !== "polygon" || current || list.length < 3) path.setAttribute("fill", "none");
        g.appendChild(path);
        const last = list[list.length - 1];
        if (current && last) {
            const guide = AnnotationAdapter._svgEl("line");
            guide.setAttribute("x1", String(xOf(last)));
            guide.setAttribute("y1", String(yOf(last)));
            guide.setAttribute("x2", String(xOf(current)));
            guide.setAttribute("y2", String(yOf(current)));
            AnnotationAdapter.applyOsdAnnotationStyle(guide, { filled: false });
            guide.setAttribute("stroke-dasharray", "4 3");
            g.appendChild(guide);
        }
        return AnnotationAdapter.applyOsdAnnotationStyle(g, { filled: false });
    }

    static buildQuPathSvgShape(type, payload) {
        const start = payload?.start || payload?.vertices?.[0];
        const current = payload?.current || payload?.vertices?.[payload?.vertices?.length - 1];
        const vertices = Array.isArray(payload?.vertices) ? payload.vertices : [];
        const xOf = pt => AnnotationAdapter.shapeCoordX(pt);
        const yOf = pt => AnnotationAdapter.shapeCoordY(pt);
        if (type === "rectangle" && start && current) {
            const constrained = AnnotationAdapter.applyQuPathShiftConstraint(
                start, current, "rectangle", Boolean(payload?.shiftKey)
            );
            const x = Math.min(xOf(start), xOf(constrained));
            const y = Math.min(yOf(start), yOf(constrained));
            const width = Math.abs(xOf(constrained) - xOf(start));
            const height = Math.abs(yOf(constrained) - yOf(start));
            const rect = AnnotationAdapter._svgEl("rect");
            rect.setAttribute("x", String(x));
            rect.setAttribute("y", String(y));
            rect.setAttribute("width", String(width));
            rect.setAttribute("height", String(height));
            return AnnotationAdapter.applyOsdAnnotationStyle(rect);
        }
        if (type === "ellipse" && start && current) {
            const constrained = AnnotationAdapter.applyQuPathShiftConstraint(
                start, current, "ellipse", Boolean(payload?.shiftKey)
            );
            let rx = Math.abs(xOf(constrained) - xOf(start)) / 2;
            let ry = Math.abs(yOf(constrained) - yOf(start)) / 2;
            if (payload?.shiftKey) {
                const r = Math.max(rx, ry);
                rx = r;
                ry = r;
            }
            const ellipse = AnnotationAdapter._svgEl("ellipse");
            ellipse.setAttribute("cx", String((xOf(start) + xOf(constrained)) / 2));
            ellipse.setAttribute("cy", String((yOf(start) + yOf(constrained)) / 2));
            ellipse.setAttribute("rx", String(rx));
            ellipse.setAttribute("ry", String(ry));
            return AnnotationAdapter.applyOsdAnnotationStyle(ellipse);
        }
        if (type === "line" && start && current) {
            const line = AnnotationAdapter._svgEl("line");
            line.setAttribute("x1", String(xOf(start)));
            line.setAttribute("y1", String(yOf(start)));
            line.setAttribute("x2", String(xOf(current)));
            line.setAttribute("y2", String(yOf(current)));
            return AnnotationAdapter.applyOsdAnnotationStyle(line, { filled: false });
        }
        if ((type === "polygon" || type === "polyline" || type === "brush") && vertices.length) {
            return AnnotationAdapter.buildPolygonTracePreview(type, vertices, current);
        }
        if (type === "points" && vertices.length) {
            const g = AnnotationAdapter._svgEl("g");
            AnnotationAdapter.applyOsdAnnotationStyle(g);
            vertices.forEach(v => {
                const c = AnnotationAdapter._svgEl("circle");
                c.setAttribute("cx", String(xOf(v)));
                c.setAttribute("cy", String(yOf(v)));
                c.setAttribute("r", "4");
                AnnotationAdapter.applyOsdAnnotationStyle(c);
                g.appendChild(c);
            });
            return g;
        }
        if (type === "wand" && vertices.length >= 3) {
            return AnnotationAdapter.buildPolygonTracePreview("polygon", vertices, null);
        }
        if (type === "wand" && start) {
            const c = AnnotationAdapter._svgEl("circle");
            c.setAttribute("cx", String(xOf(start)));
            c.setAttribute("cy", String(yOf(start)));
            c.setAttribute("r", "6");
            return AnnotationAdapter.applyOsdAnnotationStyle(c);
        }
        return null;
    }

    static commitQuPathShape(shape, event = null) {
        if (!shape?.type) return false;
        if (String(shape.type).toLowerCase() === "wand" && !AnnotationAdapter.quPathEventOnViewer(event)) {
            return false;
        }
        const id = (typeof crypto !== "undefined" && crypto.randomUUID)
            ? crypto.randomUUID()
            : `qp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const entry = AnnotationAdapter.buildUnifiedAnnotationRecord(shape, id);
        const list = Array.isArray(AnnotationAdapter.savedAnnotationsArray)
            ? AnnotationAdapter.savedAnnotationsArray
            : [];
        list.push(entry);
        AnnotationAdapter.setSavedAnnotations(list);
        const adapter = AnnotationAdapter.annotationEngine?.adapter
            || AnnotationAdapter.annotationSpike?.adapter;
        if (adapter?.metadataById && typeof adapter.metadataById.set === "function") {
            adapter.metadataById.set(id, { ...entry });
        }
        const group = AnnotationAdapter.quPathCommittedGroup();
        const node = AnnotationAdapter.buildQuPathSvgShape(shape.type, shape);
        if (group && node) {
            AnnotationAdapter.attachAnnotationShapeOverlay(node, id);
            if (typeof group.appendChild === "function") group.appendChild(node);
        }
        try {
            if (adapter && typeof adapter.annotationCreated === "function") {
                adapter.annotationCreated(AnnotationAdapter.unifiedRecordToW3c(entry));
            }
        } catch (_error) { /* overlay already stored */ }
        // A freshly committed shape becomes the sole selection (clears any prior multi-select).
        AnnotationAdapter.selectNativeAnnotationShape(id);
        const fromToolbar = Boolean(event?.target?.closest?.(
            "#secondary-annotation-toolbar, header, #qp-tool-wand, #wand-config-dropdown, #floating-wand-palette, button.qp-tool, button.toolbar-btn"
        ));
        if (!fromToolbar) AnnotationAdapter.openAnnotationNamePanelForShape(id, event);
        return entry;
    }

    static buildUnifiedAnnotationRecord(shape, id) {
        const start = shape.start || shape.vertices?.[0] || null;
        const current = shape.current || shape.vertices?.[shape.vertices?.length - 1] || start;
        const vertices = Array.isArray(shape.vertices) ? shape.vertices : [];
        let x = null;
        let y = null;
        let width = null;
        let height = null;
        const ax = start?.image?.x;
        const ay = start?.image?.y;
        const bx = current?.image?.x;
        const by = current?.image?.y;
        if ([ax, ay, bx, by].every(Number.isFinite)) {
            x = Math.min(ax, bx);
            y = Math.min(ay, by);
            width = Math.abs(bx - ax);
            height = Math.abs(by - ay);
        } else if (vertices.length) {
            const xs = vertices.map(v => Number(v?.image?.x ?? v?.x ?? v?.[0])).filter(Number.isFinite);
            const ys = vertices.map(v => Number(v?.image?.y ?? v?.y ?? v?.[1])).filter(Number.isFinite);
            if (xs.length && ys.length) {
                x = Math.min(...xs);
                y = Math.min(...ys);
                width = Math.max(...xs) - x;
                height = Math.max(...ys) - y;
            }
        }
        if ((!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) && vertices.length) {
            const xs = vertices.map(v => Number(v?.overlayX ?? v?.viewportX)).filter(Number.isFinite);
            const ys = vertices.map(v => Number(v?.overlayY ?? v?.viewportY)).filter(Number.isFinite);
            if (xs.length && ys.length) {
                x = Math.min(...xs);
                y = Math.min(...ys);
                width = Math.max(1, Math.max(...xs) - x);
                height = Math.max(1, Math.max(...ys) - y);
            }
        }
        return {
            id,
            type: shape.type,
            name: null,
            visible: true,
            x,
            y,
            width,
            height,
            start: start || null,
            current: current || null,
            vertices,
            shiftKey: Boolean(shape.shiftKey)
        };
    }

    static attachAnnotationShapeOverlay(node, id) {
        if (!node) return node;
        node.setAttribute("data-annotation-id", id);
        AnnotationAdapter.applyOsdAnnotationStyle(node, {
            filled: String(node.getAttribute("fill") || "") !== "none"
        });
        if (node.classList && typeof node.classList.add === "function") {
            node.classList.add("annotation-shape-overlay");
            node.classList.add("osd-annotation-shape");
            if (AnnotationAdapter.isAnnotationLocked(id)) node.classList.add("is-annotation-locked");
        }
        if (node.style) {
            node.style.pointerEvents = "auto";
            node.style.cursor = "pointer";
        }
        if (typeof node.addEventListener === "function") {
            node.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                AnnotationAdapter.selectNativeAnnotationShape(id);
            });
            // Right-click (or Ctrl-click/two-finger-tap, which browsers already translate
            // into this same native "contextmenu" DOM event on one-button trackpads — no
            // extra wiring needed for that) targets the whole current multi-selection when
            // this shape is already part of a shift-clicked group of 2+; otherwise it falls
            // back to targeting (and selecting) just this one shape, as before.
            node.addEventListener("contextmenu", event => {
                event.preventDefault();
                event.stopPropagation();
                const selectedIds = AnnotationAdapter.selectedNativeAnnotationIds;
                const isPartOfGroup = selectedIds instanceof Set && selectedIds.size > 1 && selectedIds.has(id);
                const targetIds = isPartOfGroup ? Array.from(selectedIds) : [id];
                if (!isPartOfGroup) AnnotationAdapter.selectNativeAnnotationShape(id);
                AnnotationAdapter.openAnnotationContextMenu(targetIds, event.clientX, event.clientY);
            });
        }
        const list = Array.isArray(AnnotationAdapter.savedAnnotationsArray)
            ? AnnotationAdapter.savedAnnotationsArray
            : [];
        const shapeObject = list.find(item => item && item.id === id) || { id, type: "rectangle" };
        shapeObject.node = node;
        AnnotationAdapter.bindQuPathShapeDragTracker(node, shapeObject);
        return node;
    }

    static bindQuPathShapeDragTracker(elementNode, shapeObject) {
        const viewer = AnnotationAdapter.viewer
            || (typeof globalThis !== "undefined" ? globalThis.viewer : null);
        const OSD = AnnotationAdapter._openSeadragon();
        if (!elementNode || !viewer?.viewport || typeof OSD?.MouseTracker !== "function") return null;
        const type = String(shapeObject?.type || "").toLowerCase();
        if (!["ellipse", "polygon", "polyline", "line", "rectangle", "brush", "points", "wand"].includes(type)) {
            return null;
        }
        const tracker = new OSD.MouseTracker({
            element: elementNode,
            dragHandler: function(event) {
                // "move" is the default/most commonly active tool, and clicking directly on an
                // existing shape never starts a new drawing (onQuPathPointerDown always intercepts
                // shape hits first), so dragging a shape is safe to allow in both "move" and the
                // dedicated "selection" tool — not "selection" only.
                if (window.currentActiveTool !== "selection" && window.currentActiveTool !== "move") return;
                if (AnnotationAdapter.isAnnotationLocked(shapeObject?.id)) return;
                let delta = viewer.viewport.deltaPointsFromPixels(event.delta);
                AnnotationAdapter.updateShapeGeometryPosition(shapeObject, delta, event.delta);
            }
        });
        if (!Array.isArray(AnnotationAdapter.qpShapeTrackers)) AnnotationAdapter.qpShapeTrackers = [];
        AnnotationAdapter.qpShapeTrackers.push(tracker);
        return tracker;
    }

    static viewportDeltaToImageDelta(delta) {
        const viewer = AnnotationAdapter.viewer;
        const tiled = AnnotationAdapter.primaryTiledImage?.(viewer);
        if (!tiled || !delta) return { x: 0, y: 0 };
        try {
            const origin = tiled.viewportToImageCoordinates(0, 0);
            const moved = tiled.viewportToImageCoordinates(Number(delta.x) || 0, Number(delta.y) || 0);
            return {
                x: Number(moved?.x) - Number(origin?.x) || 0,
                y: Number(moved?.y) - Number(origin?.y) || 0
            };
        } catch (_error) {
            return { x: 0, y: 0 };
        }
    }

    static updateShapeGeometryPosition(shapeObject, delta, pixelDelta) {
        if (!shapeObject) return null;
        const dx = Number(pixelDelta?.x ?? 0);
        const dy = Number(pixelDelta?.y ?? 0);
        const dvpX = Number(delta?.x ?? 0);
        const dvpY = Number(delta?.y ?? 0);
        const img = AnnotationAdapter.viewportDeltaToImageDelta(delta);
        const shiftPt = (pt) => {
            if (!pt) return pt;
            const next = {
                ...pt,
                overlayX: Number(pt.overlayX) + dx,
                overlayY: Number(pt.overlayY) + dy,
                viewportX: Number(pt.viewportX ?? pt.overlayX) + dvpX,
                viewportY: Number(pt.viewportY ?? pt.overlayY) + dvpY
            };
            if (pt.image && Number.isFinite(Number(pt.image.x))) {
                next.image = {
                    ...pt.image,
                    x: Number(pt.image.x) + img.x,
                    y: Number(pt.image.y) + img.y
                };
            }
            return next;
        };
        shapeObject.start = shiftPt(shapeObject.start);
        shapeObject.current = shiftPt(shapeObject.current);
        if (Array.isArray(shapeObject.vertices)) {
            shapeObject.vertices = shapeObject.vertices.map(shiftPt);
        }
        if (Number.isFinite(Number(shapeObject.x))) shapeObject.x = Number(shapeObject.x) + img.x;
        if (Number.isFinite(Number(shapeObject.y))) shapeObject.y = Number(shapeObject.y) + img.y;
        AnnotationAdapter.syncQuPathShapeNode(shapeObject);
        return shapeObject;
    }

    static syncQuPathShapeNode(shapeObject) {
        const node = shapeObject?.node;
        if (!node || typeof node.setAttribute !== "function") return false;
        const type = String(shapeObject.type || "").toLowerCase();
        const start = shapeObject.start;
        const current = shapeObject.current;
        const vertices = Array.isArray(shapeObject.vertices) ? shapeObject.vertices : [];
        const xOf = pt => AnnotationAdapter.shapeCoordX(pt);
        const yOf = pt => AnnotationAdapter.shapeCoordY(pt);
        if ((type === "rectangle") && start && current) {
            node.setAttribute("x", String(Math.min(xOf(start), xOf(current))));
            node.setAttribute("y", String(Math.min(yOf(start), yOf(current))));
            node.setAttribute("width", String(Math.abs(xOf(current) - xOf(start))));
            node.setAttribute("height", String(Math.abs(yOf(current) - yOf(start))));
            return true;
        }
        if (type === "ellipse" && start && current) {
            node.setAttribute("cx", String((xOf(start) + xOf(current)) / 2));
            node.setAttribute("cy", String((yOf(start) + yOf(current)) / 2));
            node.setAttribute("rx", String(Math.abs(xOf(current) - xOf(start)) / 2));
            node.setAttribute("ry", String(Math.abs(yOf(current) - yOf(start)) / 2));
            return true;
        }
        if (type === "line" && start && current) {
            node.setAttribute("x1", String(xOf(start)));
            node.setAttribute("y1", String(yOf(start)));
            node.setAttribute("x2", String(xOf(current)));
            node.setAttribute("y2", String(yOf(current)));
            return true;
        }
        if ((type === "polygon" || type === "polyline" || type === "brush" || type === "wand") && vertices.length) {
            if (node.tagName === "g" || node.children?.length) {
                const path = node.querySelector?.("path") || node;
                let d = "";
                vertices.forEach((vertex, index) => {
                    d += `${index === 0 ? "M" : "L"}${xOf(vertex)} ${yOf(vertex)}`;
                });
                if (type === "polygon" || type === "wand") d += "Z";
                if (path.setAttribute) path.setAttribute("d", d);
                else node.setAttribute("points", vertices.map(v => `${xOf(v)},${yOf(v)}`).join(" "));
                return true;
            }
            node.setAttribute("points", vertices.map(v => `${xOf(v)},${yOf(v)}`).join(" "));
            return true;
        }
        if (type === "points" && vertices.length && node.children) {
            for (let i = 0; i < vertices.length && i < node.children.length; i += 1) {
                const child = node.children[i];
                child.setAttribute?.("cx", String(xOf(vertices[i])));
                child.setAttribute?.("cy", String(yOf(vertices[i])));
            }
            return true;
        }
        return false;
    }

    static openAnnotationNamePanelForShape(id, event = null) {
        if (!id) return false;
        const list = Array.isArray(AnnotationAdapter.savedAnnotationsArray)
            ? AnnotationAdapter.savedAnnotationsArray
            : [];
        const entry = list.find(item => item && item.id === id) || { id, type: "rectangle", name: null };
        // Opening the name editor for a shape makes it the sole selection too (clears any
        // prior multi-select) — editing one annotation's name at a time is unambiguous.
        AnnotationAdapter.selectNativeAnnotationShape(id);
        const annotation = AnnotationAdapter.quPathEntryToAnnotationStub(entry);
        const editor = AnnotationAdapter.annotationEngine?.nameEditor
            || AnnotationAdapter.annotationSpike?.nameEditor;
        if (editor) {
            try { editor.setSelection([annotation], true); } catch (_error) { /* keep popup usable */ }
        }
        const host = AnnotationAdapter.viewer?.element || AnnotationAdapter.viewer?.canvas;
        const rect = host?.getBoundingClientRect?.();
        const overlayX = Number(entry.current?.overlayX ?? entry.start?.overlayX);
        const overlayY = Number(entry.current?.overlayY ?? entry.start?.overlayY);
        const clientX = Number.isFinite(Number(event?.clientX))
            ? Number(event.clientX)
            : (rect && Number.isFinite(overlayX) ? rect.left + overlayX : null);
        const clientY = Number.isFinite(Number(event?.clientY))
            ? Number(event.clientY)
            : (rect && Number.isFinite(overlayY) ? rect.top + overlayY : null);
        return AnnotationAdapter.showAnnotationEditorForShape(annotation, AnnotationAdapter.viewer, {
            clientX,
            clientY
        });
    }

    static quPathEntryToAnnotationStub(entry) {
        const x = Number(entry?.x);
        const y = Number(entry?.y);
        const width = Number(entry?.width);
        const height = Number(entry?.height);
        const hasBox = [x, y, width, height].every(Number.isFinite);
        return {
            id: entry?.id,
            type: entry?.type || "rectangle",
            name: entry?.name || null,
            target: {
                selector: {
                    type: entry?.type === "ellipse" ? "ELLIPSE" : "RECTANGLE",
                    geometry: hasBox
                        ? {
                            x,
                            y,
                            w: width,
                            h: height,
                            bounds: { minX: x, minY: y, maxX: x + width, maxY: y + height }
                        }
                        : (entry?.start?.image
                            ? {
                                x: Number(entry.start.image.x),
                                y: Number(entry.start.image.y),
                                w: 1,
                                h: 1,
                                bounds: {
                                    minX: Number(entry.start.image.x),
                                    minY: Number(entry.start.image.y),
                                    maxX: Number(entry.start.image.x) + 1,
                                    maxY: Number(entry.start.image.y) + 1
                                }
                            }
                            : null)
                }
            }
        };
    }

    static tryCommitQuPathToAnnotorious(_shape, _id) {
        return false;
    }

    static bindLayerVisibilityAndSanitizeControls(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root);
        if (!doc?.getElementById) return false;
        const vecBtn = doc.getElementById("toggle-annotations-visibility-btn");
        if (vecBtn && vecBtn.dataset?.vecVisBound !== "1") {
            vecBtn.addEventListener("click", event => {
                event.preventDefault();
                AnnotationAdapter.toggleVectorOutlineVisibility(doc);
            });
            if (vecBtn.dataset) vecBtn.dataset.vecVisBound = "1";
        }
        const lblBtn = doc.getElementById("toggle-labels-visibility-btn");
        if (lblBtn && lblBtn.dataset?.lblVisBound !== "1") {
            lblBtn.addEventListener("click", event => {
                event.preventDefault();
                AnnotationAdapter.toggleAnnotationLabelVisibility(doc);
            });
            if (lblBtn.dataset) lblBtn.dataset.lblVisBound = "1";
        }
        const detBtn = doc.getElementById("toggle-detections-visibility-btn");
        if (detBtn && detBtn.dataset?.detVisBound !== "1") {
            detBtn.addEventListener("click", event => {
                event.preventDefault();
                AnnotationAdapter.setNucleiOverlaysVisible(!AnnotationAdapter.nucleiOverlaysRendered());
            });
            if (detBtn.dataset) detBtn.dataset.detVisBound = "1";
        }
        const clearDetBtn = doc.getElementById("clear-detections-only-btn");
        if (clearDetBtn && clearDetBtn.dataset?.clearDetBound !== "1") {
            clearDetBtn.addEventListener("click", event => {
                event.preventDefault();
                AnnotationAdapter.clearAiNucleiOverlay({ remove: true, viewer: AnnotationAdapter.viewer });
                AnnotationAdapter.setAiStatus("AI Pipeline: Detections cleared.", doc);
            });
            if (clearDetBtn.dataset) clearDetBtn.dataset.clearDetBound = "1";
        }
        const clearBtn = doc.getElementById("clear-all-annotations-btn");
        if (clearBtn && clearBtn.dataset?.sanitizeBound !== "1") {
            clearBtn.addEventListener("click", function(e) {
                e.preventDefault();
                let proceed = confirm("WARNING: This deletion is completely irreversible. Proceeding will permanently wipe all active shapes and annotation names from the current image session. Do you want to proceed?");
                if (proceed) {
                    // Forceful data clearing sequence
                    if (typeof viewer !== "undefined" && viewer.clearOverlays) {
                        viewer.clearOverlays(); // Wipes SVG overlays off the active canvas area
                    }
                    let labels = document.querySelectorAll(".annotation-text-label, .annotation-marker-node");
                    labels.forEach(l => l.remove()); // Wipes floating name tags entirely

                    // Flush local memory tracking arrays and update tables
                    AnnotationAdapter.setSavedAnnotations([]);
                    let tableBody = document.getElementById("measurement-results-body");
                    if (tableBody) tableBody.innerHTML = "";

                    AnnotationAdapter.sanitizeCanvasAnnotations(doc);
                    alert("Canvas successfully sanitized.");
                }
            });
            if (clearBtn.dataset) clearBtn.dataset.sanitizeBound = "1";
        }
        return true;
    }

    static toggleVectorOutlineVisibility(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        AnnotationAdapter.vectorOutlinesVisible = !AnnotationAdapter.vectorOutlinesVisible;
        const opacity = AnnotationAdapter.vectorOutlinesVisible ? "1" : "0";
        const outlines = doc?.querySelectorAll?.(
            ".osd-annotation-shape, .osd-svg-overlay .osd-annotation-shape"
        ) || [];
        outlines.forEach(el => {
            if (el?.style) el.style.opacity = opacity;
        });
        const viewerEl = doc?.getElementById?.("viewer")
            || AnnotationAdapter.viewer?.element;
        viewerEl?.classList?.toggle?.("annotations-hidden", !AnnotationAdapter.vectorOutlinesVisible);
        const engine = AnnotationAdapter.annotationEngine || AnnotationAdapter.annotationSpike;
        if (engine) engine.annotationsVisible = AnnotationAdapter.vectorOutlinesVisible;
        const btn = doc?.getElementById?.("toggle-annotations-visibility-btn");
        btn?.setAttribute?.("aria-pressed", String(AnnotationAdapter.vectorOutlinesVisible));
        return AnnotationAdapter.vectorOutlinesVisible;
    }

    static toggleAnnotationLabelVisibility(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        AnnotationAdapter.annotationLabelsVisible = !AnnotationAdapter.annotationLabelsVisible;
        const display = AnnotationAdapter.annotationLabelsVisible ? "block" : "none";
        const labels = doc?.querySelectorAll?.(
            ".annotation-text-label, .annotation-marker-node, .annotation-name-label, .annotation-name-layer"
        ) || [];
        labels.forEach(el => {
            if (el?.style) el.style.display = display;
            if (typeof el?.removeAttribute === "function" && display === "block") {
                el.removeAttribute("hidden");
            } else if (display === "none" && el) {
                el.hidden = true;
            }
        });
        try {
            const engine = AnnotationAdapter.annotationEngine || AnnotationAdapter.annotationSpike;
            engine?.labelLayer?.setNamesVisible?.(
                AnnotationAdapter.annotationLabelsVisible
            );
        } catch (_error) { /* ignore */ }
        const btn = doc?.getElementById?.("toggle-labels-visibility-btn");
        btn?.setAttribute?.("aria-pressed", String(AnnotationAdapter.annotationLabelsVisible));
        return AnnotationAdapter.annotationLabelsVisible;
    }

    /**
     * Shift+F: toggles whether annotation shapes (rectangle/ellipse/closed polygon) show
     * a colored interior or just their outline. Only touches `fill-opacity` — never the
     * `fill` color attribute itself — so it composes cleanly with per-shape coloring and
     * doesn't need to remember/restore anything. Independent of vectorOutlinesVisible
     * (which hides shapes entirely) and of detectionFillEnabled (nuclei/detections, "F").
     */
    static toggleAnnotationFill(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        AnnotationAdapter.annotationFillEnabled = !AnnotationAdapter.annotationFillEnabled;
        const opacity = AnnotationAdapter.annotationFillEnabled ? "1" : "0";
        const shapes = doc?.querySelectorAll?.(`.${AnnotationAdapter.OSD_ANNOTATION_SHAPE_CLASS}`) || [];
        shapes.forEach(el => el?.setAttribute?.("fill-opacity", opacity));
        const btn = doc?.getElementById?.("toggle-annotation-fill-btn");
        btn?.setAttribute?.("aria-pressed", String(AnnotationAdapter.annotationFillEnabled));
        return AnnotationAdapter.annotationFillEnabled;
    }

    static sanitizeCanvasAnnotations(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root);
        const viewer = AnnotationAdapter.viewer
            || (typeof globalThis !== "undefined" ? globalThis.viewer : undefined);
        // Forceful data clearing sequence
        if (typeof viewer !== "undefined" && viewer && viewer.clearOverlays) {
            viewer.clearOverlays(); // Wipes SVG overlays off the active canvas area
        }
        let labels = doc?.querySelectorAll?.(".annotation-text-label, .annotation-marker-node, .annotation-name-label") || [];
        labels.forEach(l => l.remove()); // Wipes floating name tags entirely

        try { (AnnotationAdapter.annotationEngine || AnnotationAdapter.annotationSpike)?.labelLayer?.clear?.(); } catch (_error) { /* ignore */ }
        const annotator = (AnnotationAdapter.annotationEngine || AnnotationAdapter.annotationSpike)?.annotator;
        if (annotator && typeof annotator.clearAnnotations === "function") {
            try { annotator.clearAnnotations(); } catch (_error) { /* ignore */ }
        }

        // Flush local memory tracking arrays and update tables
        const store = AnnotationAdapter.annotationSpike?.adapter?.store;
        if (store && store.currentCollection) {
            store.updateCollection({
                ...store.currentCollection,
                annotations: []
            });
        }
        AnnotationAdapter.measurementSessionList = [];
        AnnotationAdapter.setSavedAnnotations([]);
        let tableBody = doc?.getElementById?.("measurement-results-body");
        if (tableBody) tableBody.innerHTML = "";
        AnnotationAdapter.clearMeasurementResultsTable(doc);
        return true;
    }

    static toggleSecondaryAnnotationToolbar(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const bar = doc?.getElementById?.("secondary-annotation-toolbar");
        const toggle = doc?.getElementById?.("toggle-secondary-annotation-toolbar");
        if (!bar) return false;
        const opening = bar.style.display === "none"
            || bar.hidden
            || !bar.classList?.contains?.("is-open");
        if (opening) {
            bar.hidden = false;
            bar.removeAttribute?.("hidden");
            bar.classList?.add?.("is-open");
            if (bar.style) bar.style.display = "flex";
        } else {
            bar.classList?.remove?.("is-open");
            bar.hidden = true;
            bar.setAttribute?.("hidden", "");
            if (bar.style) bar.style.display = "none";
        }
        if (toggle?.setAttribute) toggle.setAttribute("aria-pressed", String(opening));
        AnnotationAdapter.relayoutViewerAfterToolbarChange();
        return opening;
    }

    static relayoutViewerAfterToolbarChange() {
        const viewer = AnnotationAdapter.viewer;
        if (viewer?.viewport && typeof viewer.viewport.resize === "function") {
            try { viewer.viewport.resize(); } catch (_error) { /* ignore */ }
        }
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
            try { window.dispatchEvent(new Event("resize")); } catch (_error) { /* ignore */ }
        }
        return true;
    }

    static handleImageJZoomClick(event) {
        const viewer = AnnotationAdapter.viewer;
        if (!viewer?.viewport) return false;
        const host = viewer.element || viewer.canvas;
        const rect = host?.getBoundingClientRect?.();
        if (!rect) return false;
        const x = Number(event.clientX) - rect.left;
        const y = Number(event.clientY) - rect.top;
        let viewportPoint = null;
        try {
            const OSD = AnnotationAdapter._openSeadragon();
            const pt = OSD?.Point ? new OSD.Point(x, y) : { x, y };
            if (typeof viewer.viewport.pointFromPixel === "function") {
                viewportPoint = viewer.viewport.pointFromPixel(pt, true);
            }
        } catch (_error) { /* ignore */ }
        const factor = event.altKey || event.shiftKey ? 0.8 : 1.25;
        if (typeof viewer.viewport.zoomBy === "function") {
            viewer.viewport.zoomBy(factor, viewportPoint);
        }
        if (typeof viewer.viewport.applyConstraints === "function") {
            viewer.viewport.applyConstraints();
        }
        return true;
    }

    static defaultWandConfig() {
        return {
            preset: "default",
            radius: AnnotationAdapter.WAND_DEFAULT_RADIUS,
            delta: AnnotationAdapter.WAND_DEFAULT_DELTA,
            minFillPixels: AnnotationAdapter.WAND_DEFAULT_MIN_FILL,
            connectivity: AnnotationAdapter.WAND_DEFAULT_CONNECTIVITY,
            colorMetric: AnnotationAdapter.WAND_DEFAULT_COLOR_METRIC,
            maxContourVertices: AnnotationAdapter.WAND_DEFAULT_MAX_VERTICES,
            fallbackVertices: AnnotationAdapter.WAND_DEFAULT_FALLBACK_VERTICES
        };
    }

    static loadWandConfig() {
        let stored = null;
        try {
            const raw = typeof localStorage !== "undefined"
                ? localStorage.getItem(AnnotationAdapter.WAND_CONFIG_STORAGE_KEY)
                : null;
            stored = raw ? JSON.parse(raw) : null;
        } catch (_error) {
            stored = null;
        }
        const defaults = AnnotationAdapter.defaultWandConfig();
        const cfg = { ...defaults, ...(stored && typeof stored === "object" ? stored : {}) };
        return AnnotationAdapter.normalizeWandConfig(cfg);
    }

    static normalizeWandConfig(raw = {}) {
        const preset = String(raw.preset || "default").toLowerCase();
        return {
            preset: preset === "tissue" || preset === "custom" ? preset : "default",
            radius: Math.max(4, Math.min(80, Number(raw.radius) || AnnotationAdapter.WAND_DEFAULT_RADIUS)),
            delta: Math.max(1, Math.min(80, Number(raw.delta) || AnnotationAdapter.WAND_DEFAULT_DELTA)),
            minFillPixels: Math.max(1, Math.min(400, Number(raw.minFillPixels) || AnnotationAdapter.WAND_DEFAULT_MIN_FILL)),
            connectivity: Number(raw.connectivity) === 8 ? 8 : 4,
            colorMetric: String(raw.colorMetric || "").toLowerCase() === "euclidean" ? "euclidean" : "chebyshev",
            maxContourVertices: Math.max(8, Math.min(128, Number(raw.maxContourVertices) || AnnotationAdapter.WAND_DEFAULT_MAX_VERTICES)),
            fallbackVertices: Math.max(8, Math.min(64, Number(raw.fallbackVertices) || AnnotationAdapter.WAND_DEFAULT_FALLBACK_VERTICES))
        };
    }

    static saveWandConfig(cfg) {
        const next = AnnotationAdapter.normalizeWandConfig(cfg || AnnotationAdapter.readWandThresholds());
        AnnotationAdapter.wandPreset = next.preset;
        AnnotationAdapter.wandLookupRadiusPx = next.radius;
        AnnotationAdapter.wandColorDelta = next.delta;
        AnnotationAdapter.wandMinFillPixels = next.minFillPixels;
        AnnotationAdapter.wandConnectivity = next.connectivity;
        AnnotationAdapter.wandColorMetric = next.colorMetric;
        AnnotationAdapter.wandMaxContourVertices = next.maxContourVertices;
        AnnotationAdapter.wandFallbackVertices = next.fallbackVertices;
        try {
            if (typeof localStorage !== "undefined") {
                localStorage.setItem(AnnotationAdapter.WAND_CONFIG_STORAGE_KEY, JSON.stringify(next));
            }
        } catch (_error) { /* ignore quota */ }
        return next;
    }

    static beginWandDrawSession(event) {
        if (!AnnotationAdapter.quPathEventOnViewer(event)) return false;
        const cfg = AnnotationAdapter.readWandThresholds();
        const seed = AnnotationAdapter.quPathClientPoint(event);
        seed.clientX = Number(event?.clientX);
        seed.clientY = Number(event?.clientY);
        const vertices = AnnotationAdapter.traceWandContour(seed, cfg) || [];
        AnnotationAdapter.qpDrawSession = {
            tool: "wand",
            dragging: true,
            seed,
            start: vertices[0] || seed,
            current: vertices[vertices.length - 1] || seed,
            vertices,
            cfg,
            baseRadius: cfg.radius
        };
        AnnotationAdapter.redrawQuPathPreview();
        return true;
    }

    static growWandDrawSession(event) {
        const session = AnnotationAdapter.qpDrawSession;
        if (!session || session.tool !== "wand" || !session.dragging) return false;
        const point = AnnotationAdapter.quPathClientPoint(event);
        const dx = Number(point.overlayX) - Number(session.seed?.overlayX);
        const dy = Number(point.overlayY) - Number(session.seed?.overlayY);
        const dragPx = Number.isFinite(dx) && Number.isFinite(dy) ? Math.sqrt((dx * dx) + (dy * dy)) : 0;
        const radius = Math.max(4, Math.min(80, Number(session.baseRadius) + dragPx));
        const cfg = { ...session.cfg, radius };
        const apply = () => {
            session._wandRaf = 0;
            const vertices = AnnotationAdapter.traceWandContour(session.seed, cfg) || [];
            session.cfg = cfg;
            session.vertices = vertices;
            session.current = vertices[vertices.length - 1] || session.seed;
            AnnotationAdapter.redrawQuPathPreview();
        };
        if (typeof requestAnimationFrame === "function") {
            if (session._wandRaf) return true;
            session._wandRaf = requestAnimationFrame(apply);
            return true;
        }
        apply();
        return true;
    }

    static finishWandDrawSession(event = null) {
        const session = AnnotationAdapter.qpDrawSession;
        if (!session || session.tool !== "wand") return false;
        if (session._wandRaf && typeof cancelAnimationFrame === "function") {
            try { cancelAnimationFrame(session._wandRaf); } catch (_error) { /* ignore */ }
        }
        session.dragging = false;
        const vertices = Array.isArray(session.vertices) ? session.vertices : [];
        AnnotationAdapter.qpDrawSession = null;
        AnnotationAdapter.clearQuPathPreview();
        if (vertices.length < 3) return false;
        AnnotationAdapter.commitQuPathShape({
            type: "wand",
            vertices,
            start: vertices[0],
            current: vertices[vertices.length - 1]
        }, event);
        return true;
    }

    static wandPresetValues(preset) {
        const name = String(preset || "default").toLowerCase();
        if (name === "tissue") return { radius: 48, delta: 28 };
        if (name === "custom") {
            return {
                radius: Number(AnnotationAdapter.wandLookupRadiusPx) || AnnotationAdapter.WAND_DEFAULT_RADIUS,
                delta: Number(AnnotationAdapter.wandColorDelta) || AnnotationAdapter.WAND_DEFAULT_DELTA
            };
        }
        return {
            radius: AnnotationAdapter.WAND_DEFAULT_RADIUS,
            delta: AnnotationAdapter.WAND_DEFAULT_DELTA
        };
    }

    static readWandThresholds(root = null) {
        const stored = AnnotationAdapter.loadWandConfig();
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const select = doc?.getElementById?.("wand-config-dropdown");
        const preset = String(select?.value || stored.preset || AnnotationAdapter.wandPreset || "default");
        const mapped = AnnotationAdapter.wandPresetValues(preset);
        const next = AnnotationAdapter.normalizeWandConfig({
            ...stored,
            preset,
            radius: Number(AnnotationAdapter.wandLookupRadiusPx) || mapped.radius || stored.radius,
            delta: Number(AnnotationAdapter.wandColorDelta) || mapped.delta || stored.delta
        });
        AnnotationAdapter.saveWandConfig(next);
        return next;
    }

    static applyWandPreset(preset, root = null) {
        const name = String(preset || "default").toLowerCase();
        const current = AnnotationAdapter.loadWandConfig();
        const mapped = AnnotationAdapter.wandPresetValues(name);
        const next = AnnotationAdapter.saveWandConfig({
            ...current,
            preset: name,
            radius: name === "custom" ? current.radius : mapped.radius,
            delta: name === "custom" ? current.delta : mapped.delta
        });
        AnnotationAdapter.syncFloatingWandPalette(root);
        AnnotationAdapter.openFloatingWandPalette(root);
        return next;
    }

    static bindWandConfigDropdown(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        AnnotationAdapter.bindFloatingWandPalette(doc);
        const select = doc?.getElementById?.("wand-config-dropdown");
        if (!select || select.dataset?.wandConfigBound === "1") return Boolean(select);
        const stop = event => event.stopPropagation();
        select.addEventListener("mousedown", stop);
        select.addEventListener("click", stop);
        select.addEventListener("change", event => {
            event.stopPropagation();
            AnnotationAdapter.applyWandPreset(select.value, doc);
        });
        if (select.dataset) select.dataset.wandConfigBound = "1";
        const cfg = AnnotationAdapter.loadWandConfig();
        select.value = cfg.preset || "default";
        AnnotationAdapter.saveWandConfig(cfg);
        AnnotationAdapter.syncFloatingWandPalette(doc);
        return true;
    }

    static resolveWandPaletteNode(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        return doc?.getElementById?.("floating-wand-palette") || AnnotationAdapter.wandPaletteElement || null;
    }

    static bindFloatingWandPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        if (!doc?.getElementById) return null;
        const palette = AnnotationAdapter.resolveWandPaletteNode(doc);
        if (palette) AnnotationAdapter.wandPaletteElement = palette;
        AnnotationAdapter.isolateFloatingPalettePointerEvents(palette);
        const closeBtn = palette?.querySelector?.("#floating-wand-close")
            || doc.getElementById("floating-wand-close");
        if (closeBtn && closeBtn.dataset?.fcpCloseBound !== "1") {
            closeBtn.addEventListener("click", event => {
                event.preventDefault();
                AnnotationAdapter.closeFloatingWandPalette(doc);
            });
            if (closeBtn.dataset) closeBtn.dataset.fcpCloseBound = "1";
        }
        const handle = palette?.querySelector?.("#floating-wand-handle")
            || doc.getElementById("floating-wand-handle");
        if (palette && handle) AnnotationAdapter.bindLiberatedPaletteDrag(handle, palette);
        const preset = palette?.querySelector?.("#wand-preset-select") || doc.getElementById("wand-preset-select");
        if (preset && preset.dataset?.wandControlBound !== "1") {
            preset.addEventListener("change", () => AnnotationAdapter.applyWandPreset(preset.value, doc));
            if (preset.dataset) preset.dataset.wandControlBound = "1";
        }
        const ids = [
            "wand-radius", "wand-delta", "wand-min-fill",
            "wand-connectivity", "wand-color-metric", "wand-max-vertices", "wand-fallback-vertices"
        ];
        ids.forEach(id => {
            const control = palette?.querySelector?.(`#${id}`) || doc.getElementById(id);
            if (!control || control.dataset?.wandControlBound === "1") return;
            control.addEventListener("change", () => AnnotationAdapter.readWandPaletteControls(doc));
            control.addEventListener("input", () => AnnotationAdapter.readWandPaletteControls(doc));
            if (control.dataset) control.dataset.wandControlBound = "1";
        });
        return palette || null;
    }

    static readWandPaletteControls(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const valueOf = id => doc?.getElementById?.(id)?.value;
        const next = AnnotationAdapter.saveWandConfig({
            preset: "custom",
            radius: valueOf("wand-radius"),
            delta: valueOf("wand-delta"),
            minFillPixels: valueOf("wand-min-fill"),
            connectivity: valueOf("wand-connectivity"),
            colorMetric: valueOf("wand-color-metric"),
            maxContourVertices: valueOf("wand-max-vertices"),
            fallbackVertices: valueOf("wand-fallback-vertices")
        });
        const select = doc?.getElementById?.("wand-config-dropdown");
        if (select) select.value = next.preset;
        AnnotationAdapter.syncFloatingWandPalette(doc);
        return next;
    }

    static syncFloatingWandPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const cfg = AnnotationAdapter.loadWandConfig();
        const setVal = (id, value) => {
            const el = doc?.getElementById?.(id);
            if (el && String(el.value) !== String(value)) el.value = String(value);
        };
        const setOut = (id, value) => {
            const el = doc?.getElementById?.(id);
            if (el) el.textContent = String(value);
        };
        setVal("wand-preset-select", cfg.preset);
        setVal("wand-config-dropdown", cfg.preset);
        setVal("wand-radius", cfg.radius);
        setOut("wand-radius-value", cfg.radius);
        setVal("wand-delta", cfg.delta);
        setOut("wand-delta-value", cfg.delta);
        setVal("wand-min-fill", cfg.minFillPixels);
        setOut("wand-min-fill-value", cfg.minFillPixels);
        setVal("wand-connectivity", cfg.connectivity);
        setVal("wand-color-metric", cfg.colorMetric);
        setVal("wand-max-vertices", cfg.maxContourVertices);
        setOut("wand-max-vertices-value", cfg.maxContourVertices);
        setVal("wand-fallback-vertices", cfg.fallbackVertices);
        setOut("wand-fallback-vertices-value", cfg.fallbackVertices);
        return cfg;
    }

    static openFloatingWandPalette(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root);
        const palette = AnnotationAdapter.resolveWandPaletteNode(doc);
        if (!doc || !palette) return false;
        AnnotationAdapter.mountFloatingPaletteToBody(palette, doc);
        AnnotationAdapter.applyLiberatedFloatingStyle(palette, { minWidth: "17.5rem", minHeight: "12rem" });
        palette.hidden = false;
        palette.removeAttribute?.("hidden");
        if (palette.style) palette.style.display = "flex";
        palette.setAttribute("aria-hidden", "false");
        AnnotationAdapter.wandPaletteElement = palette;
        AnnotationAdapter.bindFloatingWandPalette(doc);
        AnnotationAdapter.syncFloatingWandPalette(doc);
        AnnotationAdapter.positionFloatingWandPalette(doc);
        return true;
    }

    static closeFloatingWandPalette(root = null) {
        const palette = AnnotationAdapter.resolveWandPaletteNode(root);
        if (!palette) return false;
        palette.hidden = true;
        palette.setAttribute("aria-hidden", "true");
        if (palette.style) palette.style.display = "none";
        return true;
    }

    static positionFloatingWandPalette(root = null) {
        const origin = AnnotationAdapter.viewerClientLaunchOrigin(root);
        if (!origin) return false;
        const palette = AnnotationAdapter.resolveWandPaletteNode(origin.doc);
        if (!palette?.style) return false;
        const width = Number(palette.offsetWidth) || parseFloat(palette.style?.width) || 280;
        const height = Number(palette.offsetHeight) || parseFloat(palette.style?.height) || 360;
        const cascaded = AnnotationAdapter.getAntiOverlapPosition(
            origin.left,
            origin.top,
            width,
            height,
            palette.id || "floating-wand-palette",
            origin.doc
        );
        palette.style.left = `${cascaded.left}px`;
        palette.style.top = `${cascaded.top}px`;
        palette.style.right = "auto";
        palette.style.bottom = "auto";
        return true;
    }

    static viewerDrawingCanvas(viewer = AnnotationAdapter.viewer) {
        if (viewer?.drawer?.canvas) return viewer.drawer.canvas;
        const host = viewer?.canvas;
        if (host && String(host.tagName || "").toLowerCase() === "canvas") return host;
        return host?.querySelector?.("canvas") || null;
    }

    static overlayOffsetPoint(base, dx, dy) {
        const overlayX = Number(base?.overlayX) + Number(dx || 0);
        const overlayY = Number(base?.overlayY) + Number(dy || 0);
        const viewer = AnnotationAdapter.viewer;
        let viewportX = Number(base?.viewportX);
        let viewportY = Number(base?.viewportY);
        let image = null;
        try {
            if (viewer?.viewport) {
                const OSD = AnnotationAdapter._openSeadragon();
                const pixel = OSD ? new OSD.Point(overlayX, overlayY) : { x: overlayX, y: overlayY };
                const vp = viewer.viewport.pointFromPixel(pixel, true);
                viewportX = Number(vp?.x);
                viewportY = Number(vp?.y);
            }
            image = AnnotationAdapter.screenPixelToImagePoint(viewer, overlayX, overlayY);
        } catch (_error) { /* keep overlay offset */ }
        return { overlayX, overlayY, viewportX, viewportY, image };
    }

    static wandSeedClientXY(seedOrEvent, rect) {
        const clientX = Number(seedOrEvent?.clientX);
        const clientY = Number(seedOrEvent?.clientY);
        if (Number.isFinite(clientX) && Number.isFinite(clientY)) return { clientX, clientY };
        const overlayX = Number(seedOrEvent?.overlayX);
        const overlayY = Number(seedOrEvent?.overlayY);
        if (rect && Number.isFinite(overlayX) && Number.isFinite(overlayY)) {
            return { clientX: rect.left + overlayX, clientY: rect.top + overlayY };
        }
        return { clientX, clientY };
    }

    static wandFallbackContour(seedOrEvent, cfg) {
        const origin = seedOrEvent?.overlayX != null
            ? seedOrEvent
            : AnnotationAdapter.quPathClientPoint(seedOrEvent);
        const radius = Math.max(4, Number(cfg?.radius) || AnnotationAdapter.WAND_DEFAULT_RADIUS);
        const steps = Math.max(8, Number(cfg?.fallbackVertices) || AnnotationAdapter.WAND_DEFAULT_FALLBACK_VERTICES);
        const vertices = [];
        for (let i = 0; i < steps; i += 1) {
            const angle = (i / steps) * Math.PI * 2;
            vertices.push(AnnotationAdapter.overlayOffsetPoint(
                origin,
                Math.cos(angle) * radius,
                Math.sin(angle) * radius
            ));
        }
        return vertices;
    }

    static wandColorWithinDelta(dr, dg, db, delta, metric) {
        if (metric === "euclidean") {
            return Math.sqrt((dr * dr) + (dg * dg) + (db * db)) <= delta;
        }
        return Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db)) <= delta;
    }

    static traceWandContour(seedOrEvent, cfg) {
        const radius = Math.max(4, Math.min(80, Number(cfg?.radius) || AnnotationAdapter.WAND_DEFAULT_RADIUS));
        const delta = Math.max(1, Math.min(80, Number(cfg?.delta) || AnnotationAdapter.WAND_DEFAULT_DELTA));
        const minFill = Math.max(1, Number(cfg?.minFillPixels) || AnnotationAdapter.WAND_DEFAULT_MIN_FILL);
        const connectivity = Number(cfg?.connectivity) === 8 ? 8 : 4;
        const metric = String(cfg?.colorMetric || AnnotationAdapter.WAND_DEFAULT_COLOR_METRIC).toLowerCase();
        const maxVerts = Math.max(8, Number(cfg?.maxContourVertices) || AnnotationAdapter.WAND_DEFAULT_MAX_VERTICES);
        const canvas = AnnotationAdapter.viewerDrawingCanvas();
        const host = AnnotationAdapter.viewer?.element || AnnotationAdapter.viewer?.canvas;
        const rect = host?.getBoundingClientRect?.();
        if (!canvas || typeof canvas.getContext !== "function" || !rect) {
            return AnnotationAdapter.wandFallbackContour(seedOrEvent, { ...cfg, radius, delta });
        }
        const { clientX, clientY } = AnnotationAdapter.wandSeedClientXY(seedOrEvent, rect);
        const scaleX = (Number(canvas.width) || rect.width) / Math.max(1, rect.width);
        const scaleY = (Number(canvas.height) || rect.height) / Math.max(1, rect.height);
        const sx = Math.round((clientX - rect.left) * scaleX);
        const sy = Math.round((clientY - rect.top) * scaleY);
        const radiusCanvas = Math.max(4, Math.round(radius * Math.max(scaleX, scaleY)));
        const x0 = Math.max(0, sx - radiusCanvas);
        const y0 = Math.max(0, sy - radiusCanvas);
        const width = Math.max(1, Math.min(canvas.width - x0, (sx + radiusCanvas) - x0));
        const height = Math.max(1, Math.min(canvas.height - y0, (sy + radiusCanvas) - y0));
        let data;
        try {
            data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(x0, y0, width, height);
        } catch (_error) {
            return AnnotationAdapter.wandFallbackContour(seedOrEvent, { ...cfg, radius, delta });
        }
        const pixels = data.data;
        const seedIndex = ((sy - y0) * width + (sx - x0)) * 4;
        if (seedIndex < 0 || seedIndex + 3 >= pixels.length) {
            return AnnotationAdapter.wandFallbackContour(seedOrEvent, { ...cfg, radius, delta });
        }
        const seed = [pixels[seedIndex], pixels[seedIndex + 1], pixels[seedIndex + 2]];
        const filled = new Uint8Array(width * height);
        const queue = [sx - x0, sy - y0];
        filled[(sy - y0) * width + (sx - x0)] = 1;
        let count = 1;
        const maxPixels = Math.floor(Math.PI * radiusCanvas * radiusCanvas);
        const radius2 = radiusCanvas * radiusCanvas;
        const neighbors4 = [1, 0, -1, 0, 0, 1, 0, -1];
        const neighbors8 = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];
        const neighbors = connectivity === 8 ? neighbors8 : neighbors4;
        while (queue.length) {
            const x = queue.shift();
            const y = queue.shift();
            for (let i = 0; i < neighbors.length; i += 2) {
                const nx = x + neighbors[i];
                const ny = y + neighbors[i + 1];
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const dx = (nx + x0) - sx;
                const dy = (ny + y0) - sy;
                if ((dx * dx) + (dy * dy) > radius2) continue;
                const idx = ny * width + nx;
                if (filled[idx]) continue;
                const pi = idx * 4;
                const dr = pixels[pi] - seed[0];
                const dg = pixels[pi + 1] - seed[1];
                const db = pixels[pi + 2] - seed[2];
                if (!AnnotationAdapter.wandColorWithinDelta(dr, dg, db, delta, metric)) continue;
                filled[idx] = 1;
                count += 1;
                if (count >= maxPixels) break;
                queue.push(nx, ny);
            }
            if (count >= maxPixels) break;
        }
        if (count < minFill) return AnnotationAdapter.wandFallbackContour(seedOrEvent, { ...cfg, radius, delta });
        const edge = [];
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                if (!filled[y * width + x]) continue;
                const border = x === 0 || y === 0 || x === width - 1 || y === height - 1
                    || !filled[y * width + x + 1]
                    || !filled[y * width + x - 1]
                    || !filled[(y + 1) * width + x]
                    || !filled[(y - 1) * width + x];
                if (border) edge.push({ x, y });
            }
        }
        if (edge.length < 3) return AnnotationAdapter.wandFallbackContour(seedOrEvent, { ...cfg, radius, delta });
        const cx = edge.reduce((sum, p) => sum + p.x, 0) / edge.length;
        const cy = edge.reduce((sum, p) => sum + p.y, 0) / edge.length;
        edge.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, a.x - cx));
        const step = Math.max(1, Math.floor(edge.length / maxVerts));
        const origin = seedOrEvent?.overlayX != null
            ? seedOrEvent
            : AnnotationAdapter.quPathClientPoint(seedOrEvent);
        const vertices = [];
        for (let i = 0; i < edge.length; i += step) {
            const px = x0 + edge[i].x;
            const py = y0 + edge[i].y;
            vertices.push(AnnotationAdapter.overlayOffsetPoint(
                origin,
                (px / scaleX) - (clientX - rect.left),
                (py / scaleY) - (clientY - rect.top)
            ));
        }
        return vertices.length >= 3
            ? vertices
            : AnnotationAdapter.wandFallbackContour(seedOrEvent, { ...cfg, radius, delta });
    }

    /**
     * Measurement-icon click: activate, toggle off, or escape an in-progress
     * multiple-entry draw (commit the vector first).
     */
    static onMeasureModeButtonClick(event = null, options = {}) {
        AnnotationAdapter.ensureMeasurementDefaults();
        const currentMode = AnnotationAdapter.measurementEntryMode();
        // Double-click toggle escape routine
        if (currentMode === "multiple") {
            if (AnnotationAdapter.isDrawing || AnnotationAdapter.isDragging) {
                AnnotationAdapter.commitActiveMeasurementSegment(event);
                const selector = typeof document !== "undefined"
                    ? document.getElementById("measurement-mode-selector")
                    : AnnotationAdapter.measurementModeSelectorEl();
                if (selector) selector.value = "single";
                let isDrawing = false;
                AnnotationAdapter.isDrawing = isDrawing;
                const measurementTracker = AnnotationAdapter.measureMouseTracker;
                const viewer = AnnotationAdapter.viewer;
                const lastPointerId = event?.pointerId
                    ?? event?.originalEvent?.pointerId
                    ?? AnnotationAdapter.lastPointerId;
                if (measurementTracker) measurementTracker.setTracking(false);
                if (viewer && viewer.canvas) {
                    try { viewer.canvas.releasePointerCapture(lastPointerId); } catch (_error) { /* ignore */ }
                }
                if (viewer && typeof viewer.setMouseNavEnabled === "function") {
                    viewer.setMouseNavEnabled(true); // Returns full pan/zoom control instantly
                }
                AnnotationAdapter.escapeMeasurementMultipleMode(event);
                return false;
            }
        }
        const next = !AnnotationAdapter.isMeasurementModeActive;
        const engine = options.annotationEngine || options.annotationSpike
            || AnnotationAdapter.annotationEngine || AnnotationAdapter.annotationSpike;
        if (next && engine) {
            engine.drawingEnabled = false;
            engine.toggleButton?.setAttribute?.("aria-pressed", "false");
            if (AnnotationAdapter.currentActiveTool === "rectangle"
                || AnnotationAdapter.currentActiveTool === "ellipse") {
                AnnotationAdapter.activateQuPathTool("move");
            }
        }
        if (next) {
            const doc = typeof document !== "undefined" ? document : null;
            const annotationModeButton = doc?.getElementById?.("annotation-mode");
            if (annotationModeButton?.getAttribute?.("aria-pressed") === "true"
                && typeof annotationModeButton.click === "function") {
                annotationModeButton.click();
            }
        }
        AnnotationAdapter.setMeasurementModeActive(next);
        return AnnotationAdapter.isMeasurementModeActive;
    }

    /**
     * Forcefully deactivate multiple-entry measure mode and restore pan/zoom.
     * Call {@link commitActiveMeasurementSegment} first so the table is current.
     */
    static escapeMeasurementMultipleMode(event = null) {
        const e = event?.originalEvent || event || {};
        const selector = typeof document !== "undefined"
            ? document.getElementById("measurement-mode-selector")
            : AnnotationAdapter.measurementModeSelectorEl();
        if (selector) selector.value = "single";
        AnnotationAdapter.setMeasurementEntryMode("single");
        let isDrawing = false;
        AnnotationAdapter.isDrawing = isDrawing;
        const measurementTracker = AnnotationAdapter.measureMouseTracker;
        const viewer = AnnotationAdapter.viewer;
        const lastPointerId = e.pointerId
            ?? event?.pointerId
            ?? AnnotationAdapter.lastPointerId;
        if (measurementTracker) measurementTracker.setTracking(false);
        if (viewer && viewer.canvas) {
            try {
                viewer.canvas.releasePointerCapture(lastPointerId);
            } catch (_error) { /* pointer was not captured on the OSD canvas host */ }
        }
        if (viewer && typeof viewer.setMouseNavEnabled === "function") {
            viewer.setMouseNavEnabled(true); // Returns full pan/zoom control instantly
        }
        AnnotationAdapter.releaseMeasurementPointerLock(event);
        return false;
    }

    /**
     * Forceful complete pointer release and navigation un-lock sequence.
     * Always safe to call: missing capture / tracker methods are ignored.
     */
    static releaseMeasurementPointerLock(event) {
        const e = event?.originalEvent || event || {};
        const viewer = AnnotationAdapter.viewer;
        const measurementTracker = AnnotationAdapter.measureMouseTracker;
        // Forceful complete pointer release and navigation un-lock sequence
        let isDrawing = false;
        AnnotationAdapter.isDrawing = isDrawing;
        if (viewer && viewer.canvas) {
            try {
                viewer.canvas.releasePointerCapture(e.pointerId);
            } catch (_error) { /* pointer was not captured on the OSD canvas host */ }
        }
        const innerCanvas = viewer?.drawer?.canvas || viewer?.canvas?.querySelector?.("canvas") || e.target;
        if (innerCanvas && innerCanvas !== viewer?.canvas && typeof innerCanvas.releasePointerCapture === "function") {
            try {
                innerCanvas.releasePointerCapture(e.pointerId);
            } catch (_error) { /* ignore */ }
        }
        if (measurementTracker) {
            measurementTracker.setTracking(false); // Shuts down active line calculation hooks
        }
        if (viewer && typeof viewer.setMouseNavEnabled === "function") {
            viewer.setMouseNavEnabled(true); // Restores native mouse pan and wheel zoom instantly
        }
        if (viewer?.gestureSettingsMouse) viewer.gestureSettingsMouse.scrollToZoom = true;
        AnnotationAdapter.isMeasurementModeActive = false;
        AnnotationAdapter.setMeasurementEntryMode("single");
        AnnotationAdapter.resetMeasurementDragState();
        AnnotationAdapter.syncMeasurementModeChrome(false);
        return true;
    }

    static syncMeasurementModeChrome(enabled) {
        const doc = typeof document !== "undefined" ? document : null;
        const button = doc?.getElementById?.("measure-mode");
        if (button?.setAttribute) button.setAttribute("aria-pressed", String(Boolean(enabled)));
        const stage = doc?.querySelector?.(".viewer-stage");
        stage?.classList?.toggle?.("measure-mode-active", Boolean(enabled));
        return Boolean(enabled);
    }

    static _documentFromRoot(root = null) {
        return root
            || (typeof document !== "undefined" ? document : null);
    }

    static _appendToBody(node, doc) {
        if (!node || !doc) return false;
        const body = doc.body;
        if (!body || typeof body.appendChild !== "function") return false;
        if (node.parentNode !== body) body.appendChild(node);
        return true;
    }

    static annotationImageBounds(annotation) {
        const spike = AnnotationAdapter.annotationSpike;
        if (spike && typeof spike.getAnnotationBounds === "function") {
            try {
                const bounds = spike.getAnnotationBounds(annotation);
                if (bounds && Number.isFinite(Number(bounds.x)) && Number.isFinite(Number(bounds.y))) {
                    return bounds;
                }
            } catch (_error) { /* fall through to local geometry */ }
        }
        const geometry = annotation?.target?.selector?.geometry;
        const box = geometry?.bounds;
        const minX = Number(box?.minX ?? geometry?.x);
        const minY = Number(box?.minY ?? geometry?.y);
        const maxX = Number(box?.maxX ?? (Number(geometry?.x) + Number(geometry?.w ?? geometry?.width)));
        const maxY = Number(box?.maxY ?? (Number(geometry?.y) + Number(geometry?.h ?? geometry?.height)));
        if ([minX, minY, maxX, maxY].every(Number.isFinite) && maxX >= minX && maxY >= minY) {
            return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        }
        return null;
    }

    static imagePointToClient(imageX, imageY, viewer = AnnotationAdapter.viewer) {
        const mapped = AnnotationAdapter.imagePointToViewerElement([imageX, imageY], viewer);
        if (!mapped || !Number.isFinite(Number(mapped.x)) || !Number.isFinite(Number(mapped.y))) {
            return null;
        }
        const host = viewer?.element || viewer?.canvas || viewer?.container;
        const rect = host?.getBoundingClientRect?.();
        if (!rect) return { x: Number(mapped.x), y: Number(mapped.y) };
        return { x: rect.left + Number(mapped.x), y: rect.top + Number(mapped.y) };
    }

    static annotationShapeClientAnchor(annotation, viewer = AnnotationAdapter.viewer) {
        const bounds = AnnotationAdapter.annotationImageBounds(annotation);
        if (!bounds) return null;
        const right = AnnotationAdapter.imagePointToClient(
            Number(bounds.x) + Number(bounds.width || 0),
            Number(bounds.y),
            viewer
        );
        if (right) return right;
        return AnnotationAdapter.imagePointToClient(Number(bounds.x), Number(bounds.y), viewer);
    }

    static applyAnnotationEditorPopupStyle(popup) {
        if (!popup?.style) return popup;
        popup.style.position = "fixed";
        popup.style.background = "#1e1e1e";
        popup.style.border = "1px solid #444";
        popup.style.borderRadius = "0.5rem";
        popup.style.padding = "0.625rem";
        popup.style.zIndex = "10001";
        popup.style.boxShadow = "0 0.25rem 0.75rem rgba(0,0,0,0.5)";
        if (!popup.style.display || popup.style.display === "") {
            popup.style.display = "none";
        }
        return popup;
    }

    static ensureAnnotationEditorPopup(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root);
        if (!doc) return null;
        let popup = doc.getElementById?.("annotation-editor-popup")
            || AnnotationAdapter.annotationEditorPopupEl;
        if (!popup && typeof doc.createElement === "function") {
            popup = doc.createElement("div");
            popup.id = "annotation-editor-popup";
            if (typeof popup.setAttribute === "function") {
                popup.setAttribute("role", "dialog");
                popup.setAttribute("aria-label", "Annotation name");
            }
            popup.innerHTML = '<input type="text" id="annotation-name-input" placeholder="Enter annotation name...">'
                + '<div class="annotation-editor-actions">'
                + '<button type="button" id="annotation-editor-cancel">Cancel</button>'
                + '<button type="button" id="annotation-editor-save">Save</button>'
                + "</div>";
        }
        if (!popup) return null;
        AnnotationAdapter.annotationEditorPopupEl = popup;
        AnnotationAdapter.applyAnnotationEditorPopupStyle(popup);
        AnnotationAdapter._appendToBody(popup, doc);
        AnnotationAdapter.bindAnnotationEditorPopup(popup, doc);
        return popup;
    }

    static bindAnnotationEditorPopup(popup, root = null) {
        if (!popup || popup._wsiAnnotationEditorBound) return popup;
        if (typeof popup.addEventListener !== "function") return popup;
        popup._wsiAnnotationEditorBound = true;
        const stop = event => event.stopPropagation();
        popup.addEventListener("pointerdown", stop);
        popup.addEventListener("mousedown", stop);
        popup.addEventListener("click", stop);
        popup.addEventListener("wheel", stop);
        const save = popup.querySelector?.("#annotation-editor-save");
        const cancel = popup.querySelector?.("#annotation-editor-cancel");
        const input = popup.querySelector?.("#annotation-name-input");
        cancel?.addEventListener("mousedown", event => event.preventDefault());
        input?.addEventListener("keydown", event => {
            if (event.key !== "Enter" || event.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            AnnotationAdapter.commitAnnotationNameFromInput(root);
            AnnotationAdapter.hideAnnotationEditorPopup(root, { commit: false });
        });
        save?.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            AnnotationAdapter.commitAnnotationNameFromInput(root);
            AnnotationAdapter.hideAnnotationEditorPopup(root, { commit: false });
        });
        cancel?.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            const editor = AnnotationAdapter.annotationSpike?.nameEditor;
            if (editor?.input) {
                editor.input.value = editor.storedValue;
                if (typeof editor.input.setCustomValidity === "function") {
                    editor.input.setCustomValidity("");
                }
            }
            AnnotationAdapter.hideAnnotationEditorPopup(root, { commit: false });
        });
        return popup;
    }

    /**
     * Only wires up the popup's viewport-follow behavior (so it tracks the shape while panning/
     * zooming). This used to also open the name popup on every pointerup whenever exactly one
     * annotation was selected — but selection (single click) and opening the popup (double click,
     * see onQuPathDoubleClick/openAnnotationNamePanelForShape) are now deliberately decoupled, so
     * that reopen-on-every-click behavior was removed.
     */
    static bindAnnotationShapeEditorLoop(viewer, _root = null) {
        AnnotationAdapter.bindAnnotationEditorViewportFollow(viewer);
        return true;
    }

    static bindAnnotationEditorViewportFollow(viewer) {
        if (!viewer || viewer._wsiAnnotationEditorViewportBound) return false;
        if (typeof viewer.addHandler !== "function") return false;
        viewer._wsiAnnotationEditorViewportBound = true;
        const follow = () => AnnotationAdapter.syncAnnotationEditorPopupPosition(viewer);
        viewer.addHandler("update-viewport", follow);
        viewer.addHandler("animation", follow);
        return true;
    }

    static syncAnnotationEditorPopupPosition(viewer = AnnotationAdapter.viewer) {
        const popup = AnnotationAdapter.annotationEditorPopupEl
            || AnnotationAdapter._documentFromRoot()?.getElementById?.("annotation-editor-popup");
        if (!popup || popup.style?.display === "none" || popup.hidden) return false;
        const annotation = AnnotationAdapter._annotationEditorAnnotation
            || AnnotationAdapter.annotationSpike?.getSelectedAnnotations?.()?.[0];
        if (!annotation) return false;
        const anchor = AnnotationAdapter.annotationShapeClientAnchor(annotation, viewer);
        if (!anchor) return false;
        AnnotationAdapter._placeAnnotationEditorPopup(popup, anchor.x + 12, anchor.y);
        return true;
    }

    static _placeAnnotationEditorPopup(popup, left, top) {
        if (!popup?.style) return false;
        const width = Number(popup.offsetWidth) || 280;
        const height = Number(popup.offsetHeight) || 96;
        const viewW = typeof window !== "undefined" ? window.innerWidth : 1024;
        const viewH = typeof window !== "undefined" ? window.innerHeight : 768;
        const maxLeft = Math.max(8, viewW - width - 8);
        const maxTop = Math.max(8, viewH - height - 8);
        popup.style.left = `${Math.min(maxLeft, Math.max(8, Number(left) || 8))}px`;
        popup.style.top = `${Math.min(maxTop, Math.max(8, Number(top) || 8))}px`;
        popup.style.right = "auto";
        popup.style.bottom = "auto";
        return true;
    }

    static showAnnotationEditorForShape(annotation, viewer = AnnotationAdapter.viewer, options = {}) {
        if (!annotation) return AnnotationAdapter.hideAnnotationEditorPopup(options.root);
        const popup = AnnotationAdapter.ensureAnnotationEditorPopup(options.root);
        if (!popup) return false;
        AnnotationAdapter._annotationEditorAnnotation = annotation;
        const anchor = AnnotationAdapter.annotationShapeClientAnchor(
            annotation,
            viewer || AnnotationAdapter.viewer
        );
        let left;
        let top;
        if (anchor) {
            left = anchor.x + 12;
            top = anchor.y;
        } else if (Number.isFinite(Number(options.clientX)) && Number.isFinite(Number(options.clientY))) {
            left = Number(options.clientX) + 12;
            top = Number(options.clientY) + 12;
        } else {
            left = 24;
            top = 80;
        }
        popup.hidden = false;
        popup.removeAttribute?.("hidden");
        if (popup.style) popup.style.display = "block";
        AnnotationAdapter._placeAnnotationEditorPopup(popup, left, top);
        AnnotationAdapter.bindAnnotationEditorViewportFollow(viewer || AnnotationAdapter.viewer);
        const input = popup.querySelector?.("#annotation-name-input")
            || AnnotationAdapter._documentFromRoot(options.root)?.getElementById?.("annotation-name-input");
        if (input && !input.disabled) {
            queueMicrotask(() => {
                try { input.focus(); } catch (_error) { /* ignore */ }
            });
        }
        return true;
    }

    static hideAnnotationEditorPopup(root = null, options = {}) {
        if (options.commit !== false) {
            AnnotationAdapter.commitAnnotationNameFromInput(root);
        }
        const doc = AnnotationAdapter._documentFromRoot(root);
        const popup = doc?.getElementById?.("annotation-editor-popup")
            || AnnotationAdapter.annotationEditorPopupEl;
        AnnotationAdapter._annotationEditorAnnotation = null;
        if (!popup) return false;
        popup.hidden = true;
        if (popup.style) popup.style.display = "none";
        return true;
    }

    static commitAnnotationNameFromInput(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root);
        const input = doc?.getElementById?.("annotation-name-input")
            || AnnotationAdapter.annotationSpike?.nameEditor?.input
            || AnnotationAdapter.annotationEditorPopupEl?.querySelector?.("#annotation-name-input");
        const value = String(input?.value ?? "");
        const editor = AnnotationAdapter.annotationSpike?.nameEditor;
        if (editor?.selectedId && typeof editor.commit === "function") {
            const id = editor.selectedId;
            editor.commit();
            AnnotationAdapter.applyCommittedAnnotationName(id, editor.storedValue ?? value);
            return true;
        }
        const annotation = AnnotationAdapter._annotationEditorAnnotation
            || AnnotationAdapter.annotationSpike?.getSelectedAnnotations?.()?.[0];
        const clientId = annotation?.id;
        if (!clientId) return false;
        const adapter = AnnotationAdapter.annotationSpike?.adapter;
        adapter?.setAnnotationName?.(clientId, value);
        AnnotationAdapter.applyCommittedAnnotationName(clientId, value);
        return true;
    }

    static applyCommittedAnnotationName(clientId, rawValue) {
        if (!clientId) return false;
        const name = String(rawValue || "").trim();
        let list = Array.isArray(AnnotationAdapter.savedAnnotationsArray)
            ? AnnotationAdapter.savedAnnotationsArray
            : [];
        let entry = list.find(item => item && item.id === clientId);
        if (!entry) {
            entry = { id: clientId, name };
            list = list.concat(entry);
        } else {
            entry.name = name || null;
        }
        AnnotationAdapter.setSavedAnnotations(list);

        const spike = AnnotationAdapter.annotationSpike;
        const annotation = spike?.annotator?.getAnnotations?.()?.find(item => item?.id === clientId)
            || (AnnotationAdapter._annotationEditorAnnotation?.id === clientId
                ? AnnotationAdapter._annotationEditorAnnotation
                : null);
        if (annotation) {
            try { spike?.labelLayer?.syncAnnotation?.(annotation); } catch (_error) { /* ignore */ }
        }
        const doc = typeof document !== "undefined" ? document : null;
        const labeled = doc?.querySelectorAll?.(
            `[data-annotation-id="${clientId}"], [data-annotation-name-for="${clientId}"]`
        ) || [];
        labeled.forEach(node => {
            if (node && "textContent" in node) node.textContent = name;
        });
        return true;
    }

    static syncSavedAnnotationsArray(adapter = null) {
        const inst = adapter
            || AnnotationAdapter.annotationEngine?.adapter
            || AnnotationAdapter.annotationSpike?.adapter;
        let backendList = [];
        try {
            backendList = inst?.toBackendCollection?.()?.annotations || [];
        } catch (_error) {
            backendList = inst?.store?.currentCollection?.annotations || [];
        }
        const existing = Array.isArray(AnnotationAdapter.savedAnnotationsArray)
            ? AnnotationAdapter.savedAnnotationsArray
            : [];
        const byId = new Map();
        existing.forEach(entry => {
            if (entry?.id) byId.set(entry.id, entry);
        });
        const merged = (Array.isArray(backendList) ? backendList : []).map(backend => {
            const prev = backend?.id ? byId.get(backend.id) : null;
            if (prev && Array.isArray(prev.vertices) && prev.vertices.length) {
                return {
                    ...prev,
                    name: backend.name ?? prev.name,
                    visible: backend.visible !== false,
                    type: prev.type || backend.type,
                    vertices: prev.vertices,
                    x: Number.isFinite(Number(backend.x)) ? Number(backend.x) : prev.x,
                    y: Number.isFinite(Number(backend.y)) ? Number(backend.y) : prev.y,
                    width: Number.isFinite(Number(backend.width)) ? Number(backend.width) : prev.width,
                    height: Number.isFinite(Number(backend.height)) ? Number(backend.height) : prev.height
                };
            }
            const points = Array.isArray(backend?.vertices) ? backend.vertices : [];
            return {
                ...(prev || {}),
                ...backend,
                type: backend?.type || prev?.type || "rectangle",
                vertices: points.length
                    ? points.map(pt => AnnotationAdapter.imagePointToShapePoint({
                        x: Number(Array.isArray(pt) ? pt[0] : pt?.x),
                        y: Number(Array.isArray(pt) ? pt[1] : pt?.y)
                    }))
                    : (prev?.vertices || [])
            };
        });
        existing.forEach(entry => {
            if (entry?.id && !merged.some(item => item?.id === entry.id)) merged.push(entry);
        });
        return AnnotationAdapter.setSavedAnnotations(merged);
    }

    static ensureMeasurementPopupOverlay(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root);
        if (!doc) return null;
        let popup = doc.getElementById?.("measurement-popup-overlay")
            || AnnotationAdapter.measurementPopupEl;
        if (!popup && typeof doc.createElement === "function") {
            popup = doc.createElement("div");
            popup.id = "measurement-popup-overlay";
            if (typeof popup.setAttribute === "function") {
                popup.setAttribute("role", "status");
                popup.setAttribute("aria-live", "polite");
            }
        }
        if (!popup) return null;
        AnnotationAdapter.measurementPopupEl = popup;
        if (popup.style) {
            popup.style.position = "fixed";
            popup.style.pointerEvents = "none";
            popup.style.zIndex = "10002";
            popup.style.background = "rgba(0, 0, 0, 0.9)";
            popup.style.color = "#00FF00";
            popup.style.fontFamily = "monospace";
            popup.style.padding = "0.25rem 0.5rem";
            popup.style.borderRadius = "0.25rem";
            popup.style.border = "1px solid #333";
            if (!popup.style.display || popup.style.display === "") {
                popup.style.display = "none";
            }
        }
        AnnotationAdapter.ensureMeasurementPopupChrome(popup, doc);
        AnnotationAdapter._appendToBody(popup, doc);
        return popup;
    }

    static ensureMeasurementPopupChrome(popup, root = null) {
        if (!popup) return null;
        const doc = popup.ownerDocument || AnnotationAdapter._documentFromRoot(root);
        let label = popup.querySelector?.("#measurement-popup-label");
        if (!label && doc?.createElement) {
            label = doc.createElement("span");
            label.id = "measurement-popup-label";
            if (typeof popup.insertBefore === "function") {
                popup.insertBefore(label, popup.firstChild);
            } else if (typeof popup.appendChild === "function") {
                popup.appendChild(label);
            }
        }
        let close = popup.querySelector?.("#measurement-popup-close");
        if (!close && doc?.createElement) {
            close = doc.createElement("button");
            close.id = "measurement-popup-close";
            close.type = "button";
            if (typeof close.setAttribute === "function") {
                close.setAttribute("aria-label", "Close measurement");
            }
            close.textContent = "×";
            if (typeof popup.appendChild === "function") popup.appendChild(close);
        }
        if (close?.style) {
            close.style.pointerEvents = "auto";
            close.style.marginLeft = "0.5rem";
            close.style.cursor = "pointer";
            close.style.color = "#00FF00";
            close.style.background = "transparent";
            close.style.border = "0";
            close.style.font = "inherit";
            close.style.lineHeight = "1";
            close.style.padding = "0 0.15em";
        }
        if (close && close.dataset && close.dataset.wsiMeasureCloseBound !== "1") {
            close.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                AnnotationAdapter.hideMeasurementPopup(root);
                AnnotationAdapter.clearMeasureVector({ remove: false, keepDragState: false });
            });
            close.dataset.wsiMeasureCloseBound = "1";
        }
        return popup;
    }

    static setMeasurementPopupLabel(overlay, text) {
        if (!overlay) return false;
        AnnotationAdapter.ensureMeasurementPopupChrome(overlay);
        const label = overlay.querySelector?.("#measurement-popup-label");
        if (label) label.textContent = String(text || "");
        else overlay.textContent = String(text || "");
        return true;
    }

    static persistMeasurementPopup(root = null) {
        const overlay = AnnotationAdapter.ensureMeasurementPopupOverlay(root);
        if (!overlay) return false;
        overlay.hidden = false;
        overlay.removeAttribute?.("hidden");
        if (overlay.style) overlay.style.display = "block";
        const close = overlay.querySelector?.("#measurement-popup-close");
        if (close) close.hidden = false;
        return true;
    }

    static updateMeasurementPopup(text, event = null, root = null) {
        const popup = AnnotationAdapter.ensureMeasurementPopupOverlay(root);
        if (!popup) return false;
        const options = text && typeof text === "object" ? text : null;
        const pointerEvent = options?.event || event;
        const microns = options ? options.microns : null;
        const pixels = options ? options.pixels : null;
        if (options && (Number.isFinite(Number(microns)) || Number.isFinite(Number(pixels)))) {
            return AnnotationAdapter.placeMeasurementPopupAtCursor(
                pointerEvent,
                microns,
                pixels,
                options.root || root
            );
        }
        const label = String(text || "").trim();
        if (!label) {
            return AnnotationAdapter.hideMeasurementPopup(root);
        }
        AnnotationAdapter.setMeasurementPopupLabel(popup, label);
        popup.hidden = false;
        popup.removeAttribute?.("hidden");
        if (popup.style) popup.style.display = "block";
        const src = pointerEvent?.originalEvent || pointerEvent;
        const x = Number(src?.clientX);
        const y = Number(src?.clientY);
        if (popup.style && Number.isFinite(x) && Number.isFinite(y)) {
            popup.style.left = (x + 15) + "px";
            popup.style.top = (y + 15) + "px";
            popup.style.right = "auto";
            popup.style.bottom = "auto";
        }
        return true;
    }

    static placeMeasurementPopupAtCursor(event, calculatedMicrons, calculatedPixels, root = null) {
        let overlay = AnnotationAdapter._documentFromRoot(root)?.getElementById?.("measurement-popup-overlay")
            || AnnotationAdapter.measurementPopupEl;
        if (!overlay) overlay = AnnotationAdapter.ensureMeasurementPopupOverlay(root);
        if (!overlay) return false;
        overlay.style.display = "block";
        overlay.hidden = false;
        overlay.removeAttribute?.("hidden");
        const pointer = event?.originalEvent || event;
        const clientX = Number(pointer?.clientX);
        const clientY = Number(pointer?.clientY);
        if (Number.isFinite(clientX) && Number.isFinite(clientY) && overlay.style) {
            overlay.style.left = (clientX + 15) + "px";
            overlay.style.top = (clientY + 15) + "px";
            overlay.style.right = "auto";
            overlay.style.bottom = "auto";
        }
        const px = Number.isFinite(Number(calculatedPixels)) ? Math.round(Number(calculatedPixels)) : 0;
        const text = Number.isFinite(Number(calculatedMicrons))
            ? `📏 ${Number(calculatedMicrons).toFixed(2)} µm (${px} px)`
            : `📏 ${px} px`;
        AnnotationAdapter.setMeasurementPopupLabel(overlay, text);
        const close = overlay.querySelector?.("#measurement-popup-close");
        if (close) close.hidden = true;
        return true;
    }

    static hideMeasurementPopup(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root);
        const popup = doc?.getElementById?.("measurement-popup-overlay")
            || AnnotationAdapter.measurementPopupEl;
        if (!popup) return false;
        popup.hidden = true;
        if (popup.style) popup.style.display = "none";
        return true;
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
            const primaryTiledImage = AnnotationAdapter.primaryTiledImage(viewer);
            if (primaryTiledImage && typeof primaryTiledImage.viewportToImageCoordinates === "function") {
                imagePoint = primaryTiledImage.viewportToImageCoordinates(viewportPoint);
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

        AnnotationAdapter.hideMeasurementPopup();
        AnnotationAdapter.isDragging = true;
        AnnotationAdapter.lastPointerId = event?.pointerId
            ?? event?.originalEvent?.pointerId
            ?? AnnotationAdapter.lastPointerId;
        AnnotationAdapter.measureStartX = overlayPoint.x;
        AnnotationAdapter.measureStartY = overlayPoint.y;
        AnnotationAdapter.measureStartImageX = imagePoint.x;
        AnnotationAdapter.measureStartImageY = imagePoint.y;
        AnnotationAdapter.measureEndX = overlayPoint.x;
        AnnotationAdapter.measureEndY = overlayPoint.y;
        AnnotationAdapter.measureEndImageX = imagePoint.x;
        AnnotationAdapter.measureEndImageY = imagePoint.y;
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

        const calculatedMicrons = AnnotationAdapter.measureLengthMicrons(
            AnnotationAdapter.measureStartImageX,
            AnnotationAdapter.measureStartImageY,
            imagePoint.x,
            imagePoint.y
        );
        const calculatedPixels = Math.hypot(
            imagePoint.x - AnnotationAdapter.measureStartImageX,
            imagePoint.y - AnnotationAdapter.measureStartImageY
        );
        AnnotationAdapter.measureEndX = overlayPoint.x;
        AnnotationAdapter.measureEndY = overlayPoint.y;
        AnnotationAdapter.measureEndImageX = imagePoint.x;
        AnnotationAdapter.measureEndImageY = imagePoint.y;
        AnnotationAdapter.lastPointerId = event?.pointerId
            ?? event?.originalEvent?.pointerId
            ?? AnnotationAdapter.lastPointerId;
        AnnotationAdapter.updateMeasureVector(
            AnnotationAdapter.measureStartX,
            AnnotationAdapter.measureStartY,
            overlayPoint.x,
            overlayPoint.y,
            ""
        );
        let overlay = typeof document !== "undefined"
            ? document.getElementById("measurement-popup-overlay")
            : null;
        if (!overlay) overlay = AnnotationAdapter.ensureMeasurementPopupOverlay();
        if (overlay) {
            overlay.style.display = "block";
            const pointer = event?.originalEvent || event;
            overlay.style.left = (pointer.clientX + 15) + "px";
            overlay.style.top = (pointer.clientY + 15) + "px";
            const text = Number.isFinite(Number(calculatedMicrons))
                ? `📏 ${Number(calculatedMicrons).toFixed(2)} µm (${Math.round(calculatedPixels)} px)`
                : `📏 ${Math.round(calculatedPixels)} px`;
            AnnotationAdapter.setMeasurementPopupLabel(overlay, text);
            const close = overlay.querySelector?.("#measurement-popup-close");
            if (close) close.hidden = true;
            overlay.hidden = false;
            overlay.removeAttribute?.("hidden");
        }
    }

    /**
     * Persist the in-progress ruler to the Saved Measurements Copy/Save table.
     * Must run before pointer capture is dropped.
     */
    static commitActiveMeasurementSegment(event = null) {
        const wasDragging = Boolean(AnnotationAdapter.isDragging || AnnotationAdapter.isDrawing);
        if (!wasDragging) return null;
        if (AnnotationAdapter.measureStartImageX == null
            || AnnotationAdapter.measureStartImageY == null) {
            return null;
        }

        const position = event?.position;
        const imagePoint = AnnotationAdapter.trackerPositionToImage(position);
        const overlayPoint = AnnotationAdapter.trackerPositionToOverlay(position);

        const startImageX = AnnotationAdapter.measureStartImageX;
        const startImageY = AnnotationAdapter.measureStartImageY;
        const startOverlayX = AnnotationAdapter.measureStartX;
        const startOverlayY = AnnotationAdapter.measureStartY;

        const endImageX = Number.isFinite(imagePoint?.x)
            ? imagePoint.x
            : (Number.isFinite(AnnotationAdapter.measureEndImageX)
                ? AnnotationAdapter.measureEndImageX
                : startImageX);
        const endImageY = Number.isFinite(imagePoint?.y)
            ? imagePoint.y
            : (Number.isFinite(AnnotationAdapter.measureEndImageY)
                ? AnnotationAdapter.measureEndImageY
                : startImageY);
        const endOverlayX = Number.isFinite(overlayPoint?.x)
            ? overlayPoint.x
            : (Number.isFinite(AnnotationAdapter.measureEndX)
                ? AnnotationAdapter.measureEndX
                : startOverlayX);
        const endOverlayY = Number.isFinite(overlayPoint?.y)
            ? overlayPoint.y
            : (Number.isFinite(AnnotationAdapter.measureEndY)
                ? AnnotationAdapter.measureEndY
                : startOverlayY);

        const microns = AnnotationAdapter.measureLengthMicrons(
            startImageX, startImageY, endImageX, endImageY
        );
        const lengthLabel = microns == null
            ? "Not calibrated"
            : AnnotationAdapter.formatMicrons(microns);

        const calculatedPixels = Math.hypot(
            Number(endImageX) - Number(startImageX),
            Number(endImageY) - Number(startImageY)
        );
        const overlay = AnnotationAdapter.ensureMeasurementPopupOverlay();
        if (overlay) {
            const text = Number.isFinite(Number(microns))
                ? `📏 ${Number(microns).toFixed(2)} µm (${Math.round(calculatedPixels)} px)`
                : `📏 ${Math.round(calculatedPixels)} px`;
            AnnotationAdapter.setMeasurementPopupLabel(overlay, text);
        }
        AnnotationAdapter.persistMeasurementPopup();
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
            lengthPixels: Number.isFinite(calculatedPixels) ? calculatedPixels : null,
            lengthLabel
        };

        let entry = null;
        const hasLength = (Number.isFinite(calculatedPixels) && calculatedPixels > 0)
            || AnnotationAdapter.lastMeasuredMicrons != null;
        if (hasLength) {
            entry = AnnotationAdapter.saveMeasurementToSession({
                lengthMicrons: AnnotationAdapter.lastMeasuredMicrons,
                lengthPixels: calculatedPixels,
                label: AnnotationAdapter.nextSequentialMeasurementLabel(
                    AnnotationAdapter.lastMeasuredMicrons
                ),
                imageId: typeof AnnotationAdapter.getActiveImageId === "function"
                    ? AnnotationAdapter.getActiveImageId()
                    : null
            });
        }

        if (typeof AnnotationAdapter.onMeasurementComplete === "function" && entry) {
            try {
                AnnotationAdapter.onMeasurementComplete(
                    AnnotationAdapter.lastMeasuredMicrons,
                    { ...snapshot, entry }
                );
            } catch (error) {
                console.warn("Measurement complete callback failed", error);
            }
        }

        AnnotationAdapter.isDrawing = false;
        return entry;
    }

    static _measureReleaseHandler(event) {
        const wasDragging = Boolean(AnnotationAdapter.isDragging || AnnotationAdapter.isDrawing);
        if (wasDragging) {
            AnnotationAdapter.commitActiveMeasurementSegment(event);
        }

        AnnotationAdapter.clearMeasureVector({ remove: false, keepDragState: true });
        const currentMode = AnnotationAdapter.measurementEntryMode();
        if (currentMode === "multiple" && AnnotationAdapter.isMeasurementModeActive) {
            AnnotationAdapter.resetMeasurementDragState();
            AnnotationAdapter.setMeasureTracking(true);
            const viewer = AnnotationAdapter.viewer;
            if (viewer && typeof viewer.setMouseNavEnabled === "function") {
                viewer.setMouseNavEnabled(false);
            }
            return;
        }
        AnnotationAdapter.releaseMeasurementPointerLock(event);
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
            ""
        );
        if (labelText) AnnotationAdapter.updateMeasurementPopup(labelText);
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
                ""
            );
        }

        AnnotationAdapter.persistMeasurementPopup();
        AnnotationAdapter.resetMeasurementDragState();
        AnnotationAdapter.releaseMeasurementPointerLock({ originalEvent: null });
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
        const doc = (typeof document !== "undefined") ? document : null;
        if (doc && typeof doc.createElementNS === "function") {
            return doc.createElementNS("http://www.w3.org/2000/svg", name);
        }
        const node = {
            tagName: name,
            attrs: Object.create(null),
            style: {},
            children: [],
            setAttribute(key, value) { this.attrs[key] = String(value); },
            getAttribute(key) { return this.attrs[key] ?? null; },
            appendChild(child) { this.children.push(child); return child; },
            querySelector() { return this.children[0] || null; }
        };
        return node;
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
            label.style.font = "700 0.75rem/1.2 ui-sans-serif, system-ui, sans-serif";

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
        AnnotationAdapter.hideMeasurementPopup();
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

    static saveMeasurementToSession({ lengthMicrons, lengthPixels, label = "", imageId = null } = {}) {
        AnnotationAdapter.ensureMeasurementDefaults();
        const microns = Number(lengthMicrons);
        const pixels = Number(lengthPixels);
        const hasMicrons = Number.isFinite(microns) && microns >= 0;
        const hasPixels = Number.isFinite(pixels) && pixels >= 0;
        if (!hasMicrons && !hasPixels) return null;
        const entry = {
            id: String(AnnotationAdapter.measurementSessionList.length + 1),
            lengthMicrons: hasMicrons ? microns : null,
            lengthPixels: hasPixels ? pixels : null,
            lengthLabel: hasMicrons
                ? AnnotationAdapter.formatMicrons(microns)
                : `${Math.round(pixels)} px`,
            label: String(label || "").trim(),
            imageId: imageId || null,
            series: Number(AnnotationAdapter.currentSeries) || 0,
            z: Number(AnnotationAdapter.currentZ) || 0,
            savedAt: new Date().toISOString()
        };
        AnnotationAdapter.measurementSessionList.push(entry);
        AnnotationAdapter.openFloatingMeasurementPalette();
        if (typeof AnnotationAdapter.onSessionListChange === "function") {
            try {
                AnnotationAdapter.onSessionListChange(
                    AnnotationAdapter.measurementSessionList.slice(),
                    entry
                );
            } catch (error) {
                console.warn("Session list change callback failed", error);
                AnnotationAdapter.appendMeasurementResultRow(entry);
            }
        } else {
            AnnotationAdapter.appendMeasurementResultRow(entry);
        }
        return entry;
    }

    static measurementResultsBody(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        return doc?.getElementById?.("measurement-results-body") || null;
    }

    static clearMeasurementResultsTable(root = null) {
        const body = AnnotationAdapter.measurementResultsBody(root);
        if (body && typeof body.replaceChildren === "function") body.replaceChildren();
        else if (body) body.innerHTML = "";
        return true;
    }

    static appendMeasurementResultRow(entry, root = null) {
        const body = AnnotationAdapter.measurementResultsBody(root);
        const doc = body?.ownerDocument
            || AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        if (!body || !doc?.createElement || !entry) return false;
        const tr = doc.createElement("tr");
        tr.className = "measurement-row";
        const idCell = doc.createElement("td");
        const umCell = doc.createElement("td");
        const pxCell = doc.createElement("td");
        const micronsVal = Number.isFinite(Number(entry.lengthMicrons))
            ? Number(entry.lengthMicrons).toFixed(2)
            : "—";
        const pixelsVal = Number.isFinite(Number(entry.lengthPixels))
            ? String(Math.round(Number(entry.lengthPixels)))
            : "—";
        idCell.textContent = String(entry.id ?? "");
        umCell.textContent = micronsVal;
        pxCell.textContent = pixelsVal;
        tr.appendChild(idCell);
        tr.appendChild(umCell);
        tr.appendChild(pxCell);
        body.appendChild(tr);
        return true;
    }

    static measurementExportFormat(root = null) {
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const select = doc?.getElementById?.("measurement-export-format");
        const value = String(select?.value || "csv").toLowerCase();
        if (value === "tsv" || value === "json") return value;
        return "csv";
    }

    static formatMeasurementExport(list = AnnotationAdapter.measurementSessionList, format = "csv") {
        const rows = Array.isArray(list) ? list : [];
        const cells = rows.map(entry => ({
            id: String(entry?.id ?? ""),
            microns: Number.isFinite(Number(entry?.lengthMicrons))
                ? Number(entry.lengthMicrons).toFixed(2)
                : "",
            pixels: Number.isFinite(Number(entry?.lengthPixels))
                ? String(Math.round(Number(entry.lengthPixels)))
                : ""
        }));
        if (format === "json") return JSON.stringify(cells, null, 2);
        const sep = format === "tsv" ? "\t" : ",";
        const header = ["ID", "Microns", "Pixels"].join(sep);
        const lines = cells.map(row => [row.id, row.microns, row.pixels].join(sep));
        return [header, ...lines].join("\n");
    }

    static copyMeasurementResults(root = null) {
        const format = AnnotationAdapter.measurementExportFormat(root);
        const text = AnnotationAdapter.formatMeasurementExport(
            AnnotationAdapter.measurementSessionList,
            format
        );
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        const btn = doc?.getElementById?.("copy-all-measurements-btn")
            || doc?.getElementById?.("measurement-copy-btn");
        const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : null;
        if (clipboard && typeof clipboard.writeText === "function") {
            navigator.clipboard.writeText(text).then(() => {
                if (btn) {
                    btn.innerText = "✓ Copied";
                    setTimeout(() => { btn.innerText = "📋 Copy"; }, 1500);
                }
            });
        }
        AnnotationAdapter.releaseMeasurementDrawingAfterExport();
        return text;
    }

    static saveMeasurementResults(root = null) {
        const format = AnnotationAdapter.measurementExportFormat(root);
        const text = AnnotationAdapter.formatMeasurementExport(
            AnnotationAdapter.measurementSessionList,
            format
        );
        const mime = format === "json" ? "application/json" : "text/plain";
        const ext = format === "tsv" ? "tsv" : format === "json" ? "json" : "csv";
        const doc = AnnotationAdapter.resolvePaletteRoot(root)
            || (typeof document !== "undefined" ? document : null);
        if (!doc?.createElement) {
            AnnotationAdapter.releaseMeasurementDrawingAfterExport();
            return text;
        }
        const blob = typeof Blob === "function" ? new Blob([text], { type: `${mime};charset=utf-8` }) : null;
        const url = blob && typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(blob)
            : `data:${mime},${encodeURIComponent(text)}`;
        const link = doc.createElement("a");
        link.href = url;
        link.download = `measurements.${ext}`;
        link.rel = "noopener";
        if (typeof link.click === "function") link.click();
        else if (doc.body && typeof doc.body.appendChild === "function") {
            doc.body.appendChild(link);
            link.click();
            link.remove?.();
        }
        if (blob && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        AnnotationAdapter.releaseMeasurementDrawingAfterExport();
        return text;
    }

    /**
     * Forceful tool deactivation and cursor liberation after Copy / Save.
     * Serialization must already have finished.
     */
    static releaseMeasurementDrawingAfterExport() {
        const doc = typeof document !== "undefined" ? document : null;
        const selector = doc?.getElementById?.("measurement-mode-selector");
        // Forceful tool deactivation and cursor liberation loop
        if (selector) selector.value = "single";
        AnnotationAdapter.setMeasurementEntryMode("single");
        let isDrawing = false;
        AnnotationAdapter.isDrawing = isDrawing;
        const measurementTracker = AnnotationAdapter.measureMouseTracker;
        const viewer = AnnotationAdapter.viewer;
        const lastPointerId = AnnotationAdapter.lastPointerId;
        if (measurementTracker) {
            measurementTracker.setTracking(false); // Freezes active vector calculations
        }
        if (viewer && viewer.canvas) {
            // Shatter any lingering pointer capture event locks on the OpenSeadragon canvas
            if (typeof viewer.canvas.releasePointerCapture === "function") {
                try {
                    viewer.canvas.releasePointerCapture(lastPointerId);
                } catch (_error) { /* pointer was not captured on the OSD canvas host */ }
            }
        }
        if (viewer && typeof viewer.setMouseNavEnabled === "function") {
            viewer.setMouseNavEnabled(true); // Re-enables fluid mouse wheel zoom and trackpad panning instantly
        }
        AnnotationAdapter.releaseMeasurementPointerLock({
            pointerId: lastPointerId
        });
        return true;
    }

    static renderMeasurementResultsTable(list = AnnotationAdapter.measurementSessionList, root = null) {
        AnnotationAdapter.clearMeasurementResultsTable(root);
        const rows = Array.isArray(list) ? list : [];
        for (const entry of rows) {
            AnnotationAdapter.appendMeasurementResultRow(entry, root);
        }
        if (rows.length) AnnotationAdapter.openFloatingMeasurementPalette(root);
        return rows.length;
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
        AnnotationAdapter.syncSavedAnnotationsArray(this);
    }

    getAnnotationName(clientId) {
        const value = this.metadataById.get(clientId)?.name;
        return typeof value === "string" ? value : "";
    }

    setAnnotationName(clientId, value) {
        if (!clientId) return false;
        let existing = this.metadataById.get(clientId);
        if (!existing) {
            existing = { id: clientId, name: null };
            this.metadataById.set(clientId, existing);
        }
        const name = value === null || value === undefined ? null : String(value).trim() || null;
        const previous = typeof existing.name === "string" && existing.name.length > 0
            ? existing.name
            : null;
        if (name === previous) {
            AnnotationAdapter.applyCommittedAnnotationName(clientId, name || "");
            return false;
        }

        const updated = { ...existing, name };
        this.metadataById.set(clientId, updated);
        const backendId = this.backendIdByClientId.get(clientId);
        if (backendId) this.metadataById.set(backendId, updated);
        this.collectionEdited();
        AnnotationAdapter.applyCommittedAnnotationName(clientId, name || "");
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

        await this.replaceDisplayedAnnotations(displayed);
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
        return Boolean(AnnotationAdapter.FREEFORM_BACKEND_TYPES[type]);
    }

    replaceDisplayedAnnotations(annotations) {
        const safeAnnotations = (Array.isArray(annotations) ? annotations : [])
            .filter(annotation => annotation && typeof annotation === "object")
            .map(annotation => ({
                ...annotation,
                bodies: Array.isArray(annotation.bodies)
                    ? annotation.bodies.filter(body => body && typeof body === "object")
                    : []
            }));

        const replacement = this.replacementQueue.then(async () => {
            this.suppressEvents = true;
            try {
                if (typeof this.annotator?.setAnnotations === "function") {
                    await this.annotator.setAnnotations(safeAnnotations, true);
                } else {
                    AnnotationAdapter.mountW3cAnnotationsOnOverlay(safeAnnotations);
                }
            } finally {
                this.suppressEvents = false;
            }
        });
        this.replacementQueue = replacement.catch(() => {});
        return replacement;
    }

    replaceAnnotoriousAnnotations(annotations) {
        return this.replaceDisplayedAnnotations(annotations);
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
            throw new Error("Annotation has invalid geometry.");
        }

        const existing = this.metadataById.get(annotation.id);
        const selectorType = String(annotation?.target?.selector?.type || "RECTANGLE").toUpperCase();
        const rawType = String(annotation?.type || existing?.type || "").toLowerCase();
        const type = AnnotationAdapter.FREEFORM_BACKEND_TYPES[rawType]
            ? rawType
            : selectorType === "ELLIPSE" ? "ellipse"
            : selectorType === "POLYGON" ? "polygon"
            : selectorType === "POLYLINE" ? "polyline"
            : selectorType === "LINE" ? "line"
            : "rectangle";
        const vertexSource = Array.isArray(geometry?.points) && geometry.points.length
            ? geometry.points
            : (Array.isArray(existing?.vertices) ? existing.vertices : []);
        const vertices = vertexSource.map(pt => AnnotationAdapter.vertexToImagePair(pt)).filter(pair =>
            Number.isFinite(pair[0]) && Number.isFinite(pair[1])
        );

        const backend = {
            ...existing,
            // Client-generated IDs are not guaranteed to be UUIDs. Sending
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
                : (Array.isArray(existing?.bodies) ? existing.bodies : []),
            vertices
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
        const selectorType = type === "ellipse" || type === "circle" ? "ELLIPSE"
            : type === "polygon" || type === "wand" ? "POLYGON"
            : type === "polyline" || type === "brush" ? "POLYLINE"
            : type === "line" ? "LINE"
            : "RECTANGLE";
        const points = Array.isArray(annotation.vertices)
            ? annotation.vertices.map(pt => AnnotationAdapter.vertexToImagePair(pt)).filter(pair =>
                Number.isFinite(pair[0]) && Number.isFinite(pair[1])
            )
            : [];

        return {
            id: annotation.id,
            type,
            name: annotation.name || null,
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
                        h: height,
                        points
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

    static AI_STATUS_IDLE = "AI Pipeline: Idle";
    static AI_STATUS_EXTRACTING = "AI Pipeline: Extracting canvas pixels...";
    static AI_NUCLEI_STROKE = "#39FF14";
    static AI_DEFAULT_PROBABILITY = 0.5;
    static AI_DEFAULT_NMS = 0.4;
    static AI_DEFAULT_MAX_NUCLEUS_RADIUS = 6;
    static AI_DEFAULT_RAY_COUNT = 32;
    static AI_DEFAULT_BOUNDARY_TIGHTNESS = 0.82;
    static AI_DEFAULT_MODEL_OVERRIDE = "auto";
    static AI_HIGH_DENSITY_PROB_DELTA = 0.15;
    static AI_HIGH_DENSITY_NMS_DELTA = 0.15;
    static AI_HIGH_DENSITY_VARIANCE_LIMIT = 0.045;
    static AI_HIGH_DENSITY_TILE_FRACTION = 0.42;
    static aiNucleiOverlayEl = null;
    static aiOverlayVisible = true;
    static aiBaselineProbability = 0.5;
    static aiBaselineNms = 0.4;
    static AI_VECTOR_OVERLAY_ID = "ai-vector-overlay-layer";
    static NUCLEUS_TILE_SIZE = 1024;
    static NUCLEUS_TILE_OVERLAP = 96;
    static NUCLEUS_TILE_MAX = 1024;
    static NUCLEUS_MAX_TILES = 80;
    static NUCLEUS_MAX_COUNT = 2500;
    static NUCLEUS_FETCH_CONCURRENCY = 3;
    static lastNucleiCircles = [];
    static lastPluginStatsOverlay = null;
    static aiNucleusOverlayParts = [];
    static AI_NUCLEUS_DEFAULT_FILL = "rgba(0,255,0,.15)";
    static AI_NUCLEUS_DEFAULT_STROKE = "#00FF00";
    /** Interior fill of detection markers (nuclei outlines/circles) starts OFF for the
     *  same reason as annotationFillEnabled above; toggled by the plain "F" key (no
     *  modifier — Shift+F is reserved for annotationFillEnabled instead). Outlines are
     *  always shown regardless of this flag. */
    static detectionFillEnabled = false;
    static heatMapActive = false;

    static get ocrAutoBaseline() { return ocrAutoBaseline; }
    static get localizedCellObjects() { return localizedCellObjects; }

    static tfEngine() {
        if (typeof globalThis !== "undefined" && globalThis.tf) return globalThis.tf;
        if (typeof window !== "undefined" && window.tf) return window.tf;
        return null;
    }

    /** Non-blocking WebGL backend hook; no-ops when TensorFlow.js is absent. */
    static initAiMlBackend() {
        try {
            const tf = AnnotationAdapter.tfEngine();
            if (!tf || typeof tf.setBackend !== "function") return false;
            const result = tf.setBackend('webgl');
            if (result && typeof result.then === "function") {
                result.catch(() => {});
            }
            return true;
        } catch (_error) {
            return false;
        }
    }

    static scheduleAiMlBackendInit() {
        const later = (typeof setTimeout === "function")
            ? setTimeout
            : (typeof window !== "undefined" && typeof window.setTimeout === "function")
                ? window.setTimeout.bind(window)
                : null;
        if (later) {
            later(() => {
                try { AnnotationAdapter.initAiMlBackend(); } catch (_error) { /* ignore */ }
            }, 0);
            return;
        }
        AnnotationAdapter.initAiMlBackend();
    }

    static setAiStatus(text, root) {
        const host = root || (typeof document !== "undefined" ? document : null);
        const el = host && typeof host.getElementById === "function"
            ? host.getElementById("ai-status-output")
            : null;
        if (el) el.textContent = text;
        return text;
    }

    static clampAiParam(value, fallback, min = 0.1, max = 1) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    static readAiLabConfig(root, options = {}) {
        const host = root || (typeof document !== "undefined" ? document : null);
        const get = (id) => (host && typeof host.getElementById === "function")
            ? host.getElementById(id)
            : null;
        const channelEl = get("ai-seg-channel");
        const probEl = get("ai-prob-threshold");
        const nmsEl = get("ai-nms-threshold");
        const overlayEl = get("ai-overlay-visible");
        const targetEl = get("ai-seg-target");
        const maxNucleusRadiusEl = get("ai-max-nucleus-radius");
        const rayCountEl = get("ai-ray-count");
        const boundaryTightnessEl = get("ai-boundary-tightness");
        const modelOverrideEl = get("ai-model-override");
        const channel = options.channel ?? channelEl?.value ?? "default";
        const segTarget = options.segTarget ?? targetEl?.value ?? "viewport";
        const probability = AnnotationAdapter.clampAiParam(
            options.probability ?? options.probabilityThreshold ?? probEl?.value,
            AnnotationAdapter.AI_DEFAULT_PROBABILITY
        );
        const nms = AnnotationAdapter.clampAiParam(
            options.nms ?? options.overlapSuppression ?? nmsEl?.value,
            AnnotationAdapter.AI_DEFAULT_NMS
        );
        const maxNucleusRadius = AnnotationAdapter.clampAiParam(
            options.maxNucleusRadius ?? maxNucleusRadiusEl?.value,
            AnnotationAdapter.AI_DEFAULT_MAX_NUCLEUS_RADIUS,
            2,
            40
        );
        const rayCount = Math.round(AnnotationAdapter.clampAiParam(
            options.rayCount ?? rayCountEl?.value,
            AnnotationAdapter.AI_DEFAULT_RAY_COUNT,
            8,
            128
        ));
        const boundaryTightness = AnnotationAdapter.clampAiParam(
            options.boundaryTightness ?? boundaryTightnessEl?.value,
            AnnotationAdapter.AI_DEFAULT_BOUNDARY_TIGHTNESS,
            0.4,
            0.98
        );
        const rawModelOverride = options.modelOverride ?? modelOverrideEl?.value ?? AnnotationAdapter.AI_DEFAULT_MODEL_OVERRIDE;
        const modelOverride = ["auto", "fluorescence", "he"].includes(rawModelOverride)
            ? rawModelOverride
            : AnnotationAdapter.AI_DEFAULT_MODEL_OVERRIDE;
        const overlayVisible = options.overlayVisible ?? (overlayEl ? overlayEl.checked !== false : AnnotationAdapter.aiOverlayVisible);
        return {
            channel, probability, nms, overlayVisible, segTarget,
            maxNucleusRadius, rayCount, boundaryTightness, modelOverride,
            channelEl, probEl, nmsEl, overlayEl, targetEl,
            maxNucleusRadiusEl, rayCountEl, boundaryTightnessEl, modelOverrideEl
        };
    }

    static writeAiLabSlider(inputEl, value, outputId, root) {
        if (!inputEl) return;
        const formatted = Number(value).toFixed(2);
        inputEl.value = formatted;
        const host = root || (typeof document !== "undefined" ? document : null);
        const output = (outputId && host && typeof host.getElementById === "function")
            ? host.getElementById(outputId)
            : null;
        if (output) output.textContent = formatted;
        const sibling = inputEl.parentElement?.querySelector?.("output");
        if (sibling && sibling !== output) sibling.textContent = formatted;
    }

    static ensureAiLabResetCard(root) {
        const host = root || (typeof document !== "undefined" ? document : null);
        if (!host || typeof host.getElementById !== "function") return null;
        const existing = host.getElementById("ai-reset-baseline-btn");
        if (existing) return existing;
        const stack = host.getElementById("ai-status-stack")
            || host.getElementById("ai-lab-config")
            || host.getElementById("ai-analytics-panel");
        if (!stack) return null;
        const markup = '<div style="margin-top: 0.625rem; display: flex; gap: 0.3em;">'
            + '<button id="ai-reset-baseline-btn" style="font-size: 0.9rem; background-color: #445566; color: #ffffff; border: 1px solid #667788; padding: 0.4em 0.8em; cursor: pointer; border-radius: 0.5em; height: auto; max-height: none;">↺ Reset to Auto-Tuned Baseline</button>'
            + "</div>";
        if (typeof stack.insertAdjacentHTML === "function") {
            stack.insertAdjacentHTML("beforeend", markup);
        } else if (typeof stack.appendChild === "function" && typeof host.createElement === "function") {
            const wrap = host.createElement("div");
            wrap.style.cssText = "margin-top: 0.625rem; display: flex; gap: 0.3em;";
            const button = host.createElement("button");
            button.id = "ai-reset-baseline-btn";
            button.style.cssText = "font-size: 0.9rem; background-color: #445566; color: #ffffff; border: 1px solid #667788; padding: 0.4em 0.8em; cursor: pointer; border-radius: 0.5em; height: auto; max-height: none;";
            button.textContent = "↺ Reset to Auto-Tuned Baseline";
            wrap.appendChild(button);
            stack.appendChild(wrap);
        }
        return host.getElementById("ai-reset-baseline-btn");
    }

    static dispatchAiSliderInput(el) {
        if (!el || typeof el.dispatchEvent !== "function") return;
        try {
            if (typeof Event === "function") {
                el.dispatchEvent(new Event("input"));
                el.dispatchEvent(new Event("change"));
                return;
            }
        } catch (_error) { /* fall through */ }
        try {
            el.dispatchEvent({ type: "input" });
        } catch (_error) { /* ignore */ }
    }

    static bindAiLabControls(root) {
        const host = root || (typeof document !== "undefined" ? document : null);
        if (!host || typeof host.getElementById !== "function") return false;
        AnnotationAdapter.ensureAiLabResetCard(host);
        const bindSlider = (inputId, outputId) => {
            const input = host.getElementById(inputId);
            if (!input || typeof input.addEventListener !== "function" || input.dataset?.aiBound === "1") return;
            const sync = () => AnnotationAdapter.writeAiLabSlider(input, input.value, outputId, host);
            input.addEventListener("input", sync);
            input.addEventListener("change", sync);
            if (input.dataset) input.dataset.aiBound = "1";
            sync();
        };
        bindSlider("ai-prob-threshold", "ai-prob-threshold-value");
        bindSlider("ai-nms-threshold", "ai-nms-threshold-value");
        bindSlider("ai-max-nucleus-radius", "ai-max-nucleus-radius-value");
        bindSlider("ai-ray-count", "ai-ray-count-value");
        bindSlider("ai-boundary-tightness", "ai-boundary-tightness-value");
        // "ai-model-override" (like "ai-seg-target") is read live via readAiLabConfig()
        // at click time; it needs no dedicated listener/binding of its own.
        const toggle = host.getElementById("ai-overlay-visible");
        if (toggle && typeof toggle.addEventListener === "function" && toggle.dataset?.aiBound !== "1") {
            toggle.addEventListener("change", () => {
                AnnotationAdapter.setNucleiOverlaysVisible(!!toggle.checked);
            });
            if (toggle.dataset) toggle.dataset.aiBound = "1";
            AnnotationAdapter.aiOverlayVisible = toggle.checked !== false;
        }
        const nucleiButton = host.getElementById("ai-nuclei-visible");
        if (nucleiButton && typeof nucleiButton.addEventListener === "function"
            && nucleiButton.dataset?.aiBound !== "1") {
            nucleiButton.addEventListener("click", () => {
                AnnotationAdapter.setNucleiOverlaysVisible(!AnnotationAdapter.nucleiOverlaysRendered());
            });
            if (nucleiButton.dataset) nucleiButton.dataset.aiBound = "1";
            AnnotationAdapter.setNucleiOverlaysVisible(AnnotationAdapter.aiOverlayVisible !== false);
        }
        const resetBtn = host.getElementById("ai-reset-baseline-btn");
        if (resetBtn && typeof resetBtn.addEventListener === "function" && resetBtn.dataset?.aiBound !== "1") {
            resetBtn.addEventListener("click", () => {
                const probEl = host.getElementById("ai-prob-threshold");
                const nmsEl = host.getElementById("ai-nms-threshold");
                if (probEl) {
                    AnnotationAdapter.writeAiLabSlider(probEl, ocrAutoBaseline.prob, "ai-prob-threshold-value", host);
                    AnnotationAdapter.dispatchAiSliderInput(probEl);
                }
                if (nmsEl) {
                    AnnotationAdapter.writeAiLabSlider(nmsEl, ocrAutoBaseline.nms, "ai-nms-threshold-value", host);
                    AnnotationAdapter.dispatchAiSliderInput(nmsEl);
                }
                AnnotationAdapter.heatMapActive = false;
                AnnotationAdapter.syncHeatMapButton(host);
                void AnnotationAdapter.segmentCellNuclei({
                    root: host,
                    viewer: AnnotationAdapter.viewer,
                    probability: ocrAutoBaseline.prob,
                    nms: ocrAutoBaseline.nms,
                    skipAutoTune: true
                });
            });
            if (resetBtn.dataset) resetBtn.dataset.aiBound = "1";
        }
        const runSelectedPlugin = () => {
            const selector = host.getElementById("plugin-selector");
            const pluginId = String(selector && selector.value ? selector.value : "");
            if (pluginId === "per-object-pixel-quantifier") {
                void AnnotationAdapter.runPerObjectPixelQuantifier({
                    root: host,
                    viewer: AnnotationAdapter.viewer
                });
                return;
            }
            if (pluginId === "ihc-pixel-quantifier") {
                void AnnotationAdapter.runIhcColorDeconvolution({
                    root: host,
                    viewer: AnnotationAdapter.viewer
                });
                return;
            }
            if (pluginId === "quantify-nuclei-pixel") {
                void AnnotationAdapter.runPixelIntensityPlugin({
                    root: host,
                    viewer: AnnotationAdapter.viewer
                });
            }
        };
        const pluginRunButton = host.getElementById("ai-run-plugin");
        if (pluginRunButton && typeof pluginRunButton.addEventListener === "function"
            && pluginRunButton.dataset?.aiBound !== "1") {
            pluginRunButton.addEventListener("click", runSelectedPlugin);
            if (pluginRunButton.dataset) pluginRunButton.dataset.aiBound = "1";
        }
        const heatMapButton = host.getElementById("ai-heatmap-toggle");
        if (heatMapButton && typeof heatMapButton.addEventListener === "function"
            && heatMapButton.dataset?.aiBound !== "1") {
            heatMapButton.addEventListener("click", () => {
                void AnnotationAdapter.toggleHeatMap({ root: host, viewer: AnnotationAdapter.viewer });
            });
            if (heatMapButton.dataset) heatMapButton.dataset.aiBound = "1";
            AnnotationAdapter.syncHeatMapButton(host);
        }
        const pluginButton = host.getElementById("ai-run-pixel-plugin");
        if (pluginButton && typeof pluginButton.addEventListener === "function"
            && pluginButton.dataset?.aiBound !== "1") {
            pluginButton.addEventListener("click", () => {
                void AnnotationAdapter.runPixelIntensityPlugin({
                    root: host,
                    viewer: AnnotationAdapter.viewer
                });
            });
            if (pluginButton.dataset) pluginButton.dataset.aiBound = "1";
        }
        const objectPluginButton = host.getElementById("ai-quantify-objects");
        if (objectPluginButton && typeof objectPluginButton.addEventListener === "function"
            && objectPluginButton.dataset?.aiBound !== "1") {
            objectPluginButton.addEventListener("click", () => {
                void AnnotationAdapter.runPerObjectPixelQuantifier({
                    root: host,
                    viewer: AnnotationAdapter.viewer
                });
            });
            if (objectPluginButton.dataset) objectPluginButton.dataset.aiBound = "1";
        }
        return true;
    }

    static rememberAiBaseline(probability, nms) {
        AnnotationAdapter.aiBaselineProbability = AnnotationAdapter.clampAiParam(
            probability,
            AnnotationAdapter.AI_DEFAULT_PROBABILITY
        );
        AnnotationAdapter.aiBaselineNms = AnnotationAdapter.clampAiParam(
            nms,
            AnnotationAdapter.AI_DEFAULT_NMS
        );
        ocrAutoBaseline.prob = AnnotationAdapter.aiBaselineProbability;
        ocrAutoBaseline.nms = AnnotationAdapter.aiBaselineNms;
        return {
            probability: AnnotationAdapter.aiBaselineProbability,
            nms: AnnotationAdapter.aiBaselineNms
        };
    }

    static resetAiLabBaseline(root, options = {}) {
        const host = root || (typeof document !== "undefined" ? document : null);
        const config = AnnotationAdapter.readAiLabConfig(host, {});
        const probability = ocrAutoBaseline.prob;
        const nms = ocrAutoBaseline.nms;
        AnnotationAdapter.writeAiLabSlider(config.probEl, probability, "ai-prob-threshold-value", host);
        AnnotationAdapter.writeAiLabSlider(config.nmsEl, nms, "ai-nms-threshold-value", host);
        AnnotationAdapter.dispatchAiSliderInput(config.probEl);
        AnnotationAdapter.dispatchAiSliderInput(config.nmsEl);
        if (options.rerun !== false) {
            void AnnotationAdapter.segmentCellNuclei({
                root: host,
                viewer: options.viewer || AnnotationAdapter.viewer,
                probability,
                nms,
                skipAutoTune: true
            });
        }
        return { probability, nms };
    }

    static setAiOverlayVisible(visible) {
        return AnnotationAdapter.setNucleiOverlaysVisible(visible);
    }

    static nucleiOverlaysRendered() {
        return AnnotationAdapter.aiOverlayVisible !== false
            && (AnnotationAdapter.aiNucleusOverlayElements || []).length > 0;
    }

    static syncNucleiVisibilityButton(root) {
        const host = root || (typeof document !== "undefined" ? document : null);
        const getById = host && typeof host.getElementById === "function"
            ? (id) => host.getElementById(id)
            : () => null;
        const showing = AnnotationAdapter.nucleiOverlaysRendered();
        const button = getById("ai-nuclei-visible");
        if (button) {
            const label = showing ? "Hide" : "Show";
            button.textContent = label;
            button.title = label;
            button.setAttribute("aria-label", label);
            button.setAttribute("aria-pressed", String(showing));
        }
        // Independent toolbar toggle (works even when the AI Labs panel is closed);
        // keeps its static "👁️ Det" label and only reflects state via aria-pressed.
        const toolbarToggle = getById("toggle-detections-visibility-btn");
        toolbarToggle?.setAttribute?.("aria-pressed", String(showing));
        return showing;
    }

    static setNucleiOverlaysVisible(visible) {
        AnnotationAdapter.aiOverlayVisible = !!visible;
        const overlay = AnnotationAdapter.aiNucleiOverlayEl;
        if (overlay && overlay.style) overlay.style.display = visible ? "block" : "none";
        for (const element of AnnotationAdapter.aiNucleusOverlayElements || []) {
            if (element?.style) element.style.display = visible ? "" : "none";
        }
        const host = typeof document !== "undefined" ? document : null;
        const toggle = host && typeof host.getElementById === "function"
            ? host.getElementById("ai-overlay-visible")
            : null;
        if (toggle && toggle.checked !== !!visible) toggle.checked = !!visible;
        if (visible) {
            if (typeof AnnotationAdapter.renderSynchronizedCellObjects === "function") {
                AnnotationAdapter.renderSynchronizedCellObjects();
            }
            if ((AnnotationAdapter.aiNucleusOverlayElements || []).length === 0
                && (AnnotationAdapter.lastNucleiCircles || []).length) {
                AnnotationAdapter.paintNucleiCircleOverlays(
                    AnnotationAdapter.viewer,
                    AnnotationAdapter.lastNucleiCircles
                );
            }
        }
        AnnotationAdapter.syncNucleiVisibilityButton(host);
        return AnnotationAdapter.aiOverlayVisible;
    }

    /**
     * Plain "F" (no modifier — Shift+F is annotationFillEnabled instead): toggles whether
     * detection markers (nuclei outlines/circles) show a colored interior or just their
     * outline. Covers both live rendering paths: the SVG polygon layer painted by
     * paintStarConvexNucleiLayer (toggle fill-opacity on each tracked part, same trick as
     * toggleAnnotationFill — never touches "fill" itself, so heat-map/IHC colors survive)
     * and the canvas-drawn circles from renderSynchronizedCellObjects (force a redraw so
     * the ctx.fill() gate there picks up the new state immediately).
     */
    static toggleDetectionFill(root = null) {
        const doc = AnnotationAdapter._documentFromRoot(root)
            || (typeof document !== "undefined" ? document : null);
        AnnotationAdapter.detectionFillEnabled = !AnnotationAdapter.detectionFillEnabled;
        const opacity = AnnotationAdapter.detectionFillEnabled ? "1" : "0";
        for (const part of AnnotationAdapter.aiNucleusOverlayParts || []) {
            part?.setAttribute?.("fill-opacity", opacity);
        }
        if (typeof AnnotationAdapter.renderSynchronizedCellObjects === "function") {
            AnnotationAdapter.renderSynchronizedCellObjects();
        }
        const btn = doc?.getElementById?.("toggle-detection-fill-btn");
        btn?.setAttribute?.("aria-pressed", String(AnnotationAdapter.detectionFillEnabled));
        return AnnotationAdapter.detectionFillEnabled;
    }

    static isAiOverlayVisible(root) {
        const host = root || (typeof document !== "undefined" ? document : null);
        const toggle = host && typeof host.getElementById === "function"
            ? host.getElementById("ai-overlay-visible")
            : null;
        if (toggle && typeof toggle.checked === "boolean") return toggle.checked;
        return AnnotationAdapter.aiOverlayVisible !== false;
    }

    /** Rapid pre-flight histogram + localized spatial variance scanner. */
    static scanChannelDensity(gray, width, height, options = {}) {
        const pixels = gray || [];
        const count = pixels.length;
        let sum = 0;
        for (let i = 0; i < count; i += 1) sum += pixels[i];
        const mean = count ? sum / count : 0;
        let varianceAcc = 0;
        const bins = new Uint32Array(16);
        for (let i = 0; i < count; i += 1) {
            const v = pixels[i];
            const d = v - mean;
            varianceAcc += d * d;
            const bin = Math.min(15, Math.max(0, Math.floor(v * 16)));
            bins[bin] += 1;
        }
        const variance = count ? varianceAcc / count : 0;

        const tile = Number(options.tileSize) > 0 ? Number(options.tileSize) : 8;
        const tileVarLimit = Number(options.tileVarianceLimit);
        const highTileVar = Number.isFinite(tileVarLimit) ? tileVarLimit : 0.02;
        let localVarSum = 0;
        let tileCount = 0;
        let highVarTiles = 0;
        let minTileVar = Infinity;
        let maxTileVar = 0;
        const w = Number(width) || 0;
        const h = Number(height) || 0;
        for (let ty = 0; ty < h; ty += tile) {
            for (let tx = 0; tx < w; tx += tile) {
                let tSum = 0;
                let tN = 0;
                const y1 = Math.min(h, ty + tile);
                const x1 = Math.min(w, tx + tile);
                for (let y = ty; y < y1; y += 1) {
                    const row = y * w;
                    for (let x = tx; x < x1; x += 1) {
                        tSum += pixels[row + x] || 0;
                        tN += 1;
                    }
                }
                const tMean = tN ? tSum / tN : 0;
                let tVar = 0;
                for (let y = ty; y < y1; y += 1) {
                    const row = y * w;
                    for (let x = tx; x < x1; x += 1) {
                        const d = (pixels[row + x] || 0) - tMean;
                        tVar += d * d;
                    }
                }
                tVar = tN ? tVar / tN : 0;
                localVarSum += tVar;
                tileCount += 1;
                if (tVar > highTileVar) highVarTiles += 1;
                if (tVar < minTileVar) minTileVar = tVar;
                if (tVar > maxTileVar) maxTileVar = tVar;
            }
        }
        const localVariance = tileCount ? localVarSum / tileCount : 0;
        const highVarFraction = tileCount ? highVarTiles / tileCount : 0;
        const varianceLimit = Number(options.varianceLimit);
        const limit = Number.isFinite(varianceLimit)
            ? varianceLimit
            : AnnotationAdapter.AI_HIGH_DENSITY_VARIANCE_LIMIT;
        const fractionLimit = Number(options.tileFractionLimit);
        const fracLimit = Number.isFinite(fractionLimit)
            ? fractionLimit
            : AnnotationAdapter.AI_HIGH_DENSITY_TILE_FRACTION;
        const highDensity = (localVariance >= limit && highVarFraction >= fracLimit) || variance >= 0.18;
        return {
            mean,
            variance,
            localVariance,
            highVarFraction,
            minTileVar: Number.isFinite(minTileVar) ? minTileVar : 0,
            maxTileVar,
            varianceLimit: limit,
            histogram: bins,
            highDensity
        };
    }

    static autoTuneDenseTissue(probability, nms) {
        const nextProb = AnnotationAdapter.clampAiParam(
            probability - AnnotationAdapter.AI_HIGH_DENSITY_PROB_DELTA,
            AnnotationAdapter.AI_DEFAULT_PROBABILITY
        );
        const nextNms = AnnotationAdapter.clampAiParam(
            nms + AnnotationAdapter.AI_HIGH_DENSITY_NMS_DELTA,
            AnnotationAdapter.AI_DEFAULT_NMS
        );
        return { probability: nextProb, nms: nextNms };
    }

    static bboxIou(a, b) {
        const x1 = Math.max(a.minX, b.minX);
        const y1 = Math.max(a.minY, b.minY);
        const x2 = Math.min(a.maxX, b.maxX);
        const y2 = Math.min(a.maxY, b.maxY);
        const iw = Math.max(0, x2 - x1);
        const ih = Math.max(0, y2 - y1);
        const inter = iw * ih;
        const areaA = Math.max(0, (a.maxX - a.minX) * (a.maxY - a.minY));
        const areaB = Math.max(0, (b.maxX - b.minX) * (b.maxY - b.minY));
        const union = areaA + areaB - inter;
        return union > 0 ? inter / union : 0;
    }

    static suppressOverlappingNuclei(nuclei, nms) {
        const strength = AnnotationAdapter.clampAiParam(nms, AnnotationAdapter.AI_DEFAULT_NMS);
        const iouCut = Math.max(0.05, 1 - strength);
        const sorted = [...(nuclei || [])].sort((a, b) => (b.area || 0) - (a.area || 0));
        const kept = [];
        for (const candidate of sorted) {
            const overlaps = kept.some((item) => AnnotationAdapter.bboxIou(candidate, item) > iouCut);
            if (!overlaps) kept.push(candidate);
        }
        return kept;
    }

    static createOffscreenSurface(width, height, rootDocument) {
        if (typeof OffscreenCanvas !== "undefined") {
            return new OffscreenCanvas(width, height);
        }
        const doc = rootDocument || (typeof document !== "undefined" ? document : null);
        if (doc && typeof doc.createElement === "function") {
            const canvas = doc.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            return canvas;
        }
        return null;
    }

    static resolveViewportCanvas(viewer) {
        if (!viewer) return null;
        if (viewer.drawer && viewer.drawer.canvas) return viewer.drawer.canvas;
        const host = viewer.canvas || viewer.element;
        if (host && typeof host.querySelector === "function") {
            return host.querySelector("canvas");
        }
        return null;
    }

    static captureViewportPixels(viewer, rootDocument) {
        const source = AnnotationAdapter.resolveViewportCanvas(viewer);
        if (!source || !source.width || !source.height) return null;
        const width = source.width;
        const height = source.height;
        try {
            const surface = AnnotationAdapter.createOffscreenSurface(width, height, rootDocument);
            if (surface && typeof surface.getContext === "function") {
                const ctx = surface.getContext("2d", { willReadFrequently: true });
                if (ctx && typeof ctx.drawImage === "function" && typeof ctx.getImageData === "function") {
                    ctx.drawImage(source, 0, 0, width, height);
                    return { imageData: ctx.getImageData(0, 0, width, height), width, height, canvas: source };
                }
            }
            if (typeof source.getContext === "function") {
                const ctx = source.getContext("2d");
                if (ctx && typeof ctx.getImageData === "function") {
                    return { imageData: ctx.getImageData(0, 0, width, height), width, height, canvas: source };
                }
            }
        } catch (_error) {
            return null;
        }
        return null;
    }

    static normalizeSegChannel(channel) {
        const raw = channel == null ? "default" : String(channel).trim().toLowerCase();
        if (raw === "1" || raw === "blue" || raw === "dapi") return 1;
        if (raw === "2" || raw === "green") return 2;
        if (raw === "3" || raw === "red") return 3;
        return 0;
    }

    static imageDataToNormalizedFloat32(imageData, options = {}) {
        const width = Number(imageData?.width) || 0;
        const height = Number(imageData?.height) || 0;
        const pixels = imageData?.data;
        const gray = new Float32Array(Math.max(0, width * height));
        const channel = AnnotationAdapter.normalizeSegChannel(options.channel);
        const preferBrightField = options.nuclear !== false && channel === 0;
        if (pixels && gray.length) {
            for (let i = 0, p = 0; i < pixels.length && p < gray.length; i += 4, p += 1) {
                if (channel === 1) {
                    gray[p] = pixels[i + 2] / 255;
                } else if (channel === 2) {
                    gray[p] = pixels[i + 1] / 255;
                } else if (channel === 3) {
                    gray[p] = pixels[i] / 255;
                } else if (preferBrightField) {
                    gray[p] = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) / 255;
                } else {
                    gray[p] = (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) / 255;
                }
            }
        }
        let tensor = null;
        const tf = AnnotationAdapter.tfEngine();
        if (tf && typeof tf.tensor === "function" && gray.length) {
            try {
                tensor = tf.tensor(gray, [height, width], "float32");
            } catch (_error) {
                tensor = null;
            }
        }
        return { gray, width, height, tensor };
    }

    static sobelMagnitude(gray, width, height) {
        const mag = new Float32Array(width * height);
        for (let y = 1; y < height - 1; y += 1) {
            for (let x = 1; x < width - 1; x += 1) {
                let gx = 0;
                let gy = 0;
                const i00 = (y - 1) * width + (x - 1);
                const i01 = i00 + 1;
                const i02 = i00 + 2;
                const i10 = y * width + (x - 1);
                const i12 = i10 + 2;
                const i20 = (y + 1) * width + (x - 1);
                const i21 = i20 + 1;
                const i22 = i20 + 2;
                gx += -gray[i00] + gray[i02] - 2 * gray[i10] + 2 * gray[i12] - gray[i20] + gray[i22];
                gy += -gray[i00] - 2 * gray[i01] - gray[i02] + gray[i20] + 2 * gray[i21] + gray[i22];
                mag[y * width + x] = Math.hypot(gx, gy);
            }
        }
        return mag;
    }

    static laplacianMagnitude(gray, width, height) {
        const mag = new Float32Array(width * height);
        for (let y = 1; y < height - 1; y += 1) {
            for (let x = 1; x < width - 1; x += 1) {
                const c = gray[y * width + x];
                const lap = gray[(y - 1) * width + x] + gray[(y + 1) * width + x]
                    + gray[y * width + (x - 1)] + gray[y * width + (x + 1)] - 4 * c;
                mag[y * width + x] = Math.abs(lap);
            }
        }
        return mag;
    }

    static _edgeThreshold(magnitude) {
        let sum = 0;
        let max = 0;
        for (let i = 0; i < magnitude.length; i += 1) {
            const v = magnitude[i];
            sum += v;
            if (v > max) max = v;
        }
        const mean = magnitude.length ? sum / magnitude.length : 0;
        return Math.max(mean * 2.2, max * 0.22, 0.08);
    }

    static localizeNucleiFromEdges(magnitude, width, height, options = {}) {
        const minArea = Number(options.minArea) > 0 ? Number(options.minArea) : 8;
        const maxArea = Number(options.maxArea) > 0 ? Number(options.maxArea) : 2400;
        const threshold = Number(options.threshold);
        const probability = Number(options.probability);
        const baseCut = Number.isFinite(threshold) ? threshold : AnnotationAdapter._edgeThreshold(magnitude);
        const cut = Number.isFinite(probability)
            ? baseCut * (probability / AnnotationAdapter.AI_DEFAULT_PROBABILITY)
            : baseCut;
        const seen = new Uint8Array(width * height);
        const nuclei = [];
        const stack = [];
        for (let i = 0; i < magnitude.length; i += 1) {
            if (seen[i] || magnitude[i] < cut) continue;
            stack.length = 0;
            stack.push(i);
            seen[i] = 1;
            const points = [];
            while (stack.length) {
                const idx = stack.pop();
                const x = idx % width;
                const y = (idx - x) / width;
                points.push([x, y]);
                for (let dy = -1; dy <= 1; dy += 1) {
                    for (let dx = -1; dx <= 1; dx += 1) {
                        if (!dx && !dy) continue;
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        const nidx = ny * width + nx;
                        if (seen[nidx] || magnitude[nidx] < cut) continue;
                        seen[nidx] = 1;
                        stack.push(nidx);
                    }
                }
            }
            if (points.length < minArea || points.length > maxArea) continue;
            const hull = AnnotationAdapter.convexHull(points);
            if (hull.length < 3) continue;
            let minX = hull[0][0];
            let minY = hull[0][1];
            let maxX = hull[0][0];
            let maxY = hull[0][1];
            let sx = 0;
            let sy = 0;
            for (const [px, py] of hull) {
                sx += px;
                sy += py;
                if (px < minX) minX = px;
                if (py < minY) minY = py;
                if (px > maxX) maxX = px;
                if (py > maxY) maxY = py;
            }
            nuclei.push({
                x: sx / hull.length,
                y: sy / hull.length,
                minX,
                minY,
                maxX,
                maxY,
                area: points.length,
                points: hull
            });
        }
        return nuclei;
    }

    static downsampleGray(gray, width, height, maxSide = 960) {
        const w = Math.max(1, Number(width) || 1);
        const h = Math.max(1, Number(height) || 1);
        const scale = Math.max(w, h) / Math.max(1, maxSide);
        if (!(scale > 1.15) || !gray) return { gray, width: w, height: h, scale: 1 };
        const tw = Math.max(1, Math.round(w / scale));
        const th = Math.max(1, Math.round(h / scale));
        const out = new Float32Array(tw * th);
        for (let y = 0; y < th; y += 1) {
            const sy = Math.min(h - 1, Math.round(y * scale));
            for (let x = 0; x < tw; x += 1) {
                const sx = Math.min(w - 1, Math.round(x * scale));
                out[y * tw + x] = gray[sy * w + sx];
            }
        }
        return { gray: out, width: tw, height: th, scale };
    }

    static localizeNucleiFromIntensity(gray, width, height, options = {}) {
        const maxSide = Number(options.maxSide) > 0
            ? Number(options.maxSide)
            : AnnotationAdapter.NUCLEUS_TILE_SIZE;
        const sampled = AnnotationAdapter.downsampleGray(gray, width, height, maxSide);
        const src = sampled.gray;
        const w = sampled.width;
        const h = sampled.height;
        const scale = sampled.scale || 1;
        const probability = Number(options.probability);
        const minArea = Number(options.minArea) > 0 ? Number(options.minArea) : 8;
        const maxArea = Number(options.maxArea) > 0 ? Number(options.maxArea) : 1600;
        let sum = 0;
        let count = 0;
        let max = 0;
        for (let i = 0; i < src.length; i += 1) {
            const v = src[i];
            if (v > 0.05) {
                sum += v;
                count += 1;
            }
            if (v > max) max = v;
        }
        if (max < 0.08 || count < minArea) return [];
        const mean = count ? sum / count : 0;
        const strict = Number.isFinite(probability) ? probability : AnnotationAdapter.AI_DEFAULT_PROBABILITY;
        const cut = Math.max(0.12, mean + (0.14 + strict * 0.42) * Math.max(0.04, max - mean));
        const blurred = AnnotationAdapter.blurGray3(src, w, h);
        const peaks = AnnotationAdapter.findStarDistPeaks(blurred, w, h, cut);
        const nuclei = [];
        for (const peak of peaks) {
            const polygon = AnnotationAdapter.traceStarConvexPolygon(
                blurred,
                w,
                h,
                peak.x,
                peak.y,
                cut,
                Math.max(10, peak.radius * 2.6)
            );
            let minX = peak.x;
            let minY = peak.y;
            let maxX = peak.x;
            let maxY = peak.y;
            for (const [px, py] of polygon) {
                if (px < minX) minX = px;
                if (py < minY) minY = py;
                if (px > maxX) maxX = px;
                if (py > maxY) maxY = py;
            }
            const bw = Math.max(1, maxX - minX);
            const bh = Math.max(1, maxY - minY);
            const area = Math.max(minArea, bw * bh * 0.6);
            if (area > maxArea * 4) continue;
            const radius = Math.max(3, Math.min(bw, bh) * 0.5, peak.radius);
            nuclei.push({
                x: peak.x * scale,
                y: peak.y * scale,
                minX: minX * scale,
                minY: minY * scale,
                maxX: maxX * scale,
                maxY: maxY * scale,
                area: area * scale * scale,
                radius: radius * scale,
                score: peak.score,
                polygon: polygon.map(([px, py]) => [px * scale, py * scale])
            });
        }
        return nuclei;
    }

    static blurGray3(src, width, height) {
        const out = new Float32Array(src.length);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                let sum = 0;
                let n = 0;
                for (let dy = -1; dy <= 1; dy += 1) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= height) continue;
                    for (let dx = -1; dx <= 1; dx += 1) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= width) continue;
                        sum += src[yy * width + xx];
                        n += 1;
                    }
                }
                out[y * width + x] = n ? sum / n : src[y * width + x];
            }
        }
        return out;
    }

    /**
     * StarDist-style object centers: local maxima on the DAPI intensity
     * field, then 32-ray star-convex outlines. Same post-process geometry
     * as 2D_versatile_fluo, run on full-resolution tiles.
     */
    static findStarDistPeaks(gray, width, height, threshold) {
        const cut = Math.max(0.08, Number(threshold) || 0.14);
        const radius = 2;
        const minDist = 5;
        const peaks = [];
        for (let y = radius; y < height - radius; y += 1) {
            for (let x = radius; x < width - radius; x += 1) {
                const v = gray[y * width + x];
                if (v < cut) continue;
                let isMax = true;
                for (let dy = -radius; dy <= radius && isMax; dy += 1) {
                    for (let dx = -radius; dx <= radius; dx += 1) {
                        if (!dx && !dy) continue;
                        if (gray[(y + dy) * width + (x + dx)] > v) {
                            isMax = false;
                            break;
                        }
                    }
                }
                if (!isMax) continue;
                peaks.push({ x, y, score: v, radius: 6 });
            }
        }
        peaks.sort((a, b) => b.score - a.score);
        const kept = [];
        const minDist2 = minDist * minDist;
        for (const peak of peaks) {
            const near = kept.some((item) => {
                const dx = item.x - peak.x;
                const dy = item.y - peak.y;
                return (dx * dx + dy * dy) < minDist2;
            });
            if (!near) kept.push(peak);
        }
        return kept;
    }

    /**
     * StarDist-style star-convex outline: 32 rays from the DAPI centroid
     * stop at the local intensity falloff. This is the StarDist output
     * geometry, not the pretrained 2D_versatile_fluo CNN.
     */
    static STARDIST_RAYS = 32;

    static traceStarConvexPolygon(gray, width, height, cx, cy, threshold, maxRadius) {
        const rays = AnnotationAdapter.STARDIST_RAYS;
        const cut = Math.max(0.05, Number(threshold) * 0.82);
        const limit = Math.max(4, Number(maxRadius) || 12);
        const ring = [];
        for (let i = 0; i < rays; i += 1) {
            const angle = (i / rays) * Math.PI * 2;
            const dx = Math.cos(angle);
            const dy = Math.sin(angle);
            let last = 1.5;
            for (let r = 1; r <= limit; r += 1) {
                const x = Math.round(cx + dx * r);
                const y = Math.round(cy + dy * r);
                if (x < 0 || y < 0 || x >= width || y >= height) break;
                if (gray[y * width + x] < cut) break;
                last = r;
            }
            ring.push([cx + dx * last, cy + dy * last]);
        }
        return ring;
    }

    static convexHull(points) {
        const unique = [];
        const seen = new Set();
        for (const point of points) {
            const key = `${point[0]},${point[1]}`;
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(point);
        }
        unique.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
        if (unique.length <= 2) return unique;
        const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lower = [];
        for (const p of unique) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
                lower.pop();
            }
            lower.push(p);
        }
        const upper = [];
        for (let i = unique.length - 1; i >= 0; i -= 1) {
            const p = unique[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
                upper.pop();
            }
            upper.push(p);
        }
        lower.pop();
        upper.pop();
        return lower.concat(upper);
    }

    static createAiVectorOverlayElement(rootDocument) {
        const existing = AnnotationAdapter.aiNucleiOverlayEl;
        if (existing && existing.id === AnnotationAdapter.AI_VECTOR_OVERLAY_ID) return existing;
        const doc = (rootDocument && typeof rootDocument.createElement === "function")
            ? rootDocument
            : (typeof document !== "undefined" ? document : null);
        let canvas = null;
        if (doc && typeof doc.getElementById === "function") {
            canvas = doc.getElementById(AnnotationAdapter.AI_VECTOR_OVERLAY_ID);
        }
        if (canvas && canvas.tagName && String(canvas.tagName).toLowerCase() !== "canvas") {
            if (typeof canvas.remove === "function") canvas.remove();
            canvas = null;
        }
        if (!canvas && doc && typeof doc.createElement === "function") {
            canvas = doc.createElement("canvas");
            canvas.id = AnnotationAdapter.AI_VECTOR_OVERLAY_ID;
        }
        if (!canvas) return existing || null;
        canvas.setAttribute?.("aria-hidden", "true");
        if (canvas.style) {
            canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:4;";
        }
        AnnotationAdapter.aiNucleiOverlayEl = canvas;
        return canvas;
    }

    static createAiNucleiOverlayElement() {
        return AnnotationAdapter.createAiVectorOverlayElement();
    }

    /** Canvas bitmap pixel → WSI image pixel via the current OSD viewport. */
    static canvasPixelToImageCoordinates(pixelX, pixelY, canvas, viewer) {
        const vp = viewer?.viewport;
        if (!vp) return null;
        let elementX = Number(pixelX);
        let elementY = Number(pixelY);
        if (![elementX, elementY].every(Number.isFinite)) return null;
        try {
            if (canvas && typeof canvas.getBoundingClientRect === "function") {
                const canvasRect = canvas.getBoundingClientRect();
                const scaleX = canvas.width ? canvasRect.width / canvas.width : 1;
                const scaleY = canvas.height ? canvasRect.height / canvas.height : 1;
                elementX = pixelX * scaleX;
                elementY = pixelY * scaleY;
                const host = viewer.element || viewer.container;
                if (host && typeof host.getBoundingClientRect === "function") {
                    const hostRect = host.getBoundingClientRect();
                    elementX += canvasRect.left - hostRect.left;
                    elementY += canvasRect.top - hostRect.top;
                }
            }
            let viewportPoint = null;
            if (typeof vp.viewerElementToViewportCoordinates === "function") {
                viewportPoint = vp.viewerElementToViewportCoordinates({ x: elementX, y: elementY });
            } else if (typeof vp.pointFromPixel === "function") {
                viewportPoint = vp.pointFromPixel({ x: elementX, y: elementY }, true);
            }
            if (!viewportPoint) return null;
            const primaryTiledImage = AnnotationAdapter.primaryTiledImage(viewer);
            if (primaryTiledImage && typeof primaryTiledImage.viewportToImageCoordinates === "function") {
                return primaryTiledImage.viewportToImageCoordinates(viewportPoint);
            }
        } catch (_error) {
            return null;
        }
        return null;
    }

    static attachNucleiImageCoordinates(nuclei, canvas, viewer) {
        if (!Array.isArray(nuclei) || !viewer?.viewport) return nuclei;
        return nuclei.map((nucleus) => {
            const imagePoints = [];
            for (const point of nucleus.points || []) {
                const img = AnnotationAdapter.canvasPixelToImageCoordinates(point[0], point[1], canvas, viewer);
                if (!img || !Number.isFinite(Number(img.x)) || !Number.isFinite(Number(img.y))) {
                    return nucleus;
                }
                imagePoints.push([Number(img.x), Number(img.y)]);
            }
            return imagePoints.length ? { ...nucleus, imagePoints } : nucleus;
        });
    }

    static closeImageRing(points) {
        const ring = [];
        for (const point of points || []) {
            const x = Number(point?.[0]);
            const y = Number(point?.[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            ring.push([x, y]);
        }
        if (ring.length < 3) return null;
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            ring.push([first[0], first[1]]);
        }
        return ring;
    }

    static nucleiToLocalizedCellObjects(nuclei) {
        const objects = [];
        let id = 0;
        for (const nucleus of nuclei || []) {
            const ring = [];
            for (const point of nucleus.imagePoints || nucleus.points || []) {
                const x = Number(point?.[0]);
                const y = Number(point?.[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                ring.push([x, y]);
            }
            if (ring.length < 3) continue;
            id += 1;
            objects.push({
                id,
                type: "Polygon",
                imageCoordinates: ring,
                classification: "nucleus"
            });
        }
        return objects;
    }

    static replaceLocalizedCellObjects(next) {
        localizedCellObjects = Array.isArray(next) ? next : [];
        return localizedCellObjects;
    }

    static pinAiVectorOverlayToViewer(canvas, viewer) {
        if (!canvas) return;
        const wrap = canvas.parentElement;
        if (wrap && wrap.style && wrap !== viewer?.element && wrap !== viewer?.canvas) {
            wrap.style.transform = "none";
            wrap.style.webkitTransform = "none";
            wrap.style.left = "0";
            wrap.style.top = "0";
            wrap.style.width = "100%";
            wrap.style.height = "100%";
            wrap.style.margin = "0";
            wrap.style.position = "absolute";
            wrap.style.pointerEvents = "none";
            wrap.style.zIndex = "4";
        }
        if (canvas.style) {
            canvas.style.position = "absolute";
            canvas.style.left = "0";
            canvas.style.top = "0";
            canvas.style.width = "100%";
            canvas.style.height = "100%";
            canvas.style.pointerEvents = "none";
            canvas.style.transform = "none";
        }
    }

    static removeDetachedAiOverlayHosts(viewer, rootDocument) {
        const doc = rootDocument
            || (typeof document !== "undefined" ? document : null);
        if (doc && typeof doc.querySelectorAll === "function") {
            const leftover = doc.querySelectorAll(".wsi-ai-nuclei-overlay, [data-ai-geojson-overlay]");
            leftover.forEach((node) => {
                if (!node || node.id === AnnotationAdapter.AI_VECTOR_OVERLAY_ID) return;
                if (typeof node.remove === "function") node.remove();
            });
        }
        AnnotationAdapter.detachAiNucleiOverlay(viewer);
    }

    static bindAiVectorOverlayHandlers(viewer) {
        if (!viewer || typeof viewer.addHandler !== "function" || viewer._aiVectorOverlayBound) return;
        viewer.addHandler("viewport-change", renderSynchronizedCellObjects);
        if (typeof viewer.addHandler === "function") {
            viewer.addHandler("animation", renderSynchronizedCellObjects);
            viewer.addHandler("resize", renderSynchronizedCellObjects);
        }
        viewer._aiVectorOverlayBound = true;
    }

    static registerAiVectorOverlay(viewer, options = {}) {
        viewer = viewer || AnnotationAdapter.viewer;
        const canvas = options.canvas
            || AnnotationAdapter.createAiVectorOverlayElement(options.root || options.document);
        if (!canvas) return null;
        AnnotationAdapter.removeDetachedAiOverlayHosts(viewer, options.root || options.document);
        AnnotationAdapter.aiNucleiOverlayEl = canvas;
        const showOverlay = options.overlayVisible !== false
            && AnnotationAdapter.isAiOverlayVisible(options.root);
        if (canvas.style) canvas.style.display = showOverlay ? "block" : "none";
        let location = { x: 0, y: 0, width: 1, height: 1 };
        if (viewer && typeof viewer.addOverlay === "function") {
            const OpenSeadragon = AnnotationAdapter._openSeadragon();
            location = OpenSeadragon?.Rect ? new OpenSeadragon.Rect(0, 0, 1, 1) : location;
            const element = (typeof document !== "undefined" && document.getElementById)
                ? (document.getElementById("ai-vector-overlay-layer") || canvas)
                : canvas;
            viewer.addOverlay({
                element,
                location
            });
            AnnotationAdapter.bindAiVectorOverlayHandlers(viewer);
            AnnotationAdapter.pinAiVectorOverlayToViewer(canvas, viewer);
        }
        return { canvas, location };
    }

    static imagePointToViewerElement(point, viewer) {
        const x = Number(point?.[0]);
        const y = Number(point?.[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const vp = viewer?.viewport;
        if (!vp) return { x, y };
        let viewportPoint = { x, y };
        const primaryTiledImage = AnnotationAdapter.primaryTiledImage(viewer);
        if (primaryTiledImage && typeof primaryTiledImage.imageToViewportCoordinates === "function") {
            try {
                viewportPoint = primaryTiledImage.imageToViewportCoordinates(x, y) || viewportPoint;
            } catch (_error) { /* keep image point */ }
        }
        if (typeof vp.viewportToViewerElementCoordinates === "function") {
            try {
                const mapped = vp.viewportToViewerElementCoordinates(viewportPoint);
                if (mapped && Number.isFinite(Number(mapped.x)) && Number.isFinite(Number(mapped.y))) {
                    return { x: Number(mapped.x), y: Number(mapped.y) };
                }
            } catch (_error) { /* keep viewport point */ }
        }
        return {
            x: Number(viewportPoint.x),
            y: Number(viewportPoint.y)
        };
    }

    static renderSynchronizedCellObjects(viewerOverride) {
        const viewer = viewerOverride || AnnotationAdapter.viewer;
        const canvas = AnnotationAdapter.aiNucleiOverlayEl
            || (typeof document !== "undefined" && document.getElementById
                ? document.getElementById("ai-vector-overlay-layer")
                : null);
        if (!canvas) return null;
        AnnotationAdapter.pinAiVectorOverlayToViewer(canvas, viewer);
        const host = viewer?.container || viewer?.element || canvas.parentElement;
        const width = Math.max(
            1,
            Number(host?.clientWidth) || Number(canvas.clientWidth) || Number(canvas.width) || 1
        );
        const height = Math.max(
            1,
            Number(host?.clientHeight) || Number(canvas.clientHeight) || Number(canvas.height) || 1
        );
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
        if (!ctx) return canvas;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (AnnotationAdapter.aiOverlayVisible === false || (canvas.style && canvas.style.display === "none")) {
            return canvas;
        }
        ctx.strokeStyle = AnnotationAdapter.AI_NUCLEI_STROKE;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        for (const obj of localizedCellObjects) {
            if (obj?.type === "Circle" || Number.isFinite(Number(obj?.cx ?? obj?.x))) {
                const mapped = AnnotationAdapter.imagePointToViewerElement(
                    [obj.cx ?? obj.x, obj.cy ?? obj.y],
                    viewer
                );
                if (!mapped) continue;
                const radius = Math.max(4, Number(obj.r ?? obj.radius) || 12);
                ctx.beginPath();
                ctx.arc(mapped.x, mapped.y, radius, 0, Math.PI * 2);
                if (AnnotationAdapter.detectionFillEnabled) {
                    ctx.fillStyle = "rgba(57,255,20,.14)";
                    ctx.fill();
                }
                ctx.stroke();
                continue;
            }
            const ring = obj?.imageCoordinates || [];
            if (ring.length < 2) continue;
            ctx.beginPath();
            for (let i = 0; i < ring.length; i += 1) {
                const mapped = AnnotationAdapter.imagePointToViewerElement(ring[i], viewer);
                if (!mapped) continue;
                if (i === 0) ctx.moveTo(mapped.x, mapped.y);
                else ctx.lineTo(mapped.x, mapped.y);
            }
            ctx.closePath();
            ctx.stroke();
        }
        return canvas;
    }

    static detachAiNucleiOverlay(viewer) {
        const overlay = AnnotationAdapter.aiNucleiOverlayEl;
        const host = viewer || AnnotationAdapter.viewer;
        if (overlay && host && typeof host.removeOverlay === "function") {
            try { host.removeOverlay(overlay); } catch (_error) { /* already detached */ }
        }
    }

    static projectNucleiOverlay(nuclei, options = {}) {
        const objects = options.objects || AnnotationAdapter.nucleiToLocalizedCellObjects(nuclei);
        AnnotationAdapter.replaceLocalizedCellObjects(objects);
        const injected = AnnotationAdapter.registerAiVectorOverlay(options.viewer || AnnotationAdapter.viewer, options);
        AnnotationAdapter.renderSynchronizedCellObjects(options.viewer || AnnotationAdapter.viewer);
        return injected?.canvas || AnnotationAdapter.aiNucleiOverlayEl;
    }

    static clearAiNucleiOverlay({ remove = false, viewer = null } = {}) {
        const host = viewer || AnnotationAdapter.viewer;
        AnnotationAdapter.detachAiNucleiOverlay(host);
        AnnotationAdapter.clearNucleiCircleOverlays(host);
        const canvas = AnnotationAdapter.aiNucleiOverlayEl;
        if (canvas) {
            const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
            if (ctx && typeof ctx.clearRect === "function") {
                ctx.clearRect(0, 0, Number(canvas.width) || 0, Number(canvas.height) || 0);
            }
            if (canvas.style) canvas.style.display = "none";
            if (remove) {
                if (typeof canvas.remove === "function") canvas.remove();
                AnnotationAdapter.aiNucleiOverlayEl = null;
            }
        }
        if (remove) {
            localizedCellObjects = [];
            // Keep the "redraw on visibility toggle" cache (see setNucleiOverlaysVisible)
            // in sync with the backend-facing array above; otherwise a stale slide's
            // nuclei can reappear when the panel is reopened and visibility re-enabled.
            AnnotationAdapter.lastNucleiCircles = [];
            AnnotationAdapter.heatMapActive = false;
            AnnotationAdapter.syncHeatMapButton();
        }
    }

    static _analyzeViewport(options = {}) {
        const root = options.root || options.document || (typeof document !== "undefined" ? document : null);
        AnnotationAdapter.setAiStatus(AnnotationAdapter.AI_STATUS_EXTRACTING, root);
        const captured = options.imageData
            ? {
                imageData: options.imageData,
                width: options.imageData.width,
                height: options.imageData.height,
                canvas: options.canvas || null
            }
            : AnnotationAdapter.captureViewportPixels(options.viewer, root);
        if (!captured?.imageData) {
            AnnotationAdapter.setAiStatus("AI Pipeline: No viewport canvas available.", root);
            return null;
        }
        const config = AnnotationAdapter.readAiLabConfig(root, options);
        const payload = AnnotationAdapter.imageDataToNormalizedFloat32(captured.imageData, {
            channel: config.channel
        });
        const magnitude = AnnotationAdapter.sobelMagnitude(payload.gray, payload.width, payload.height);
        return { root, captured, payload, magnitude, config };
    }

    static aiNucleusOverlayElements = [];

    static canvasPixelToViewerPixel(pixelX, pixelY, canvas, viewer) {
        let elementX = Number(pixelX);
        let elementY = Number(pixelY);
        if (!Number.isFinite(elementX) || !Number.isFinite(elementY)) return null;
        if (canvas && typeof canvas.getBoundingClientRect === "function") {
            const canvasRect = canvas.getBoundingClientRect();
            const host = viewer?.element || viewer?.container;
            const hostRect = host && typeof host.getBoundingClientRect === "function"
                ? host.getBoundingClientRect()
                : canvasRect;
            const scaleX = canvas.width ? canvasRect.width / canvas.width : 1;
            const scaleY = canvas.height ? canvasRect.height / canvas.height : 1;
            elementX = pixelX * scaleX + (canvasRect.left - hostRect.left);
            elementY = pixelY * scaleY + (canvasRect.top - hostRect.top);
        }
        return { x: elementX, y: elementY };
    }

    static screenPixelToImagePoint(viewer, pixelX, pixelY, canvas) {
        const host = viewer || AnnotationAdapter.viewer;
        const viewport = host?.viewport;
        const OpenSeadragon = AnnotationAdapter._openSeadragon();
        if (!viewport || !OpenSeadragon?.Point) return null;
        if (typeof viewport.pointFromPixel !== "function") return null;
        const viewerPixel = canvas
            ? AnnotationAdapter.canvasPixelToViewerPixel(pixelX, pixelY, canvas, host)
            : { x: pixelX, y: pixelY };
        if (!viewerPixel) return null;
        // Force circle objects to bind natively to the slide's pixel matrix
        const viewportPoint = viewport.pointFromPixel(
            new OpenSeadragon.Point(viewerPixel.x, viewerPixel.y)
        );
        const primaryTiledImage = AnnotationAdapter.primaryTiledImage(host);
        if (!primaryTiledImage || typeof primaryTiledImage.viewportToImageCoordinates !== "function") {
            return null;
        }
        const imagePoint = primaryTiledImage.viewportToImageCoordinates(viewportPoint);
        const x = Number(imagePoint?.x);
        const y = Number(imagePoint?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { x, y, viewportPoint, imagePoint };
    }

    static imageToViewportWidth(viewer, imageWidth) {
        const host = viewer || AnnotationAdapter.viewer;
        const span = Number(imageWidth);
        if (!Number.isFinite(span)) return null;
        const primaryTiledImage = AnnotationAdapter.primaryTiledImage(host);
        if (primaryTiledImage && typeof primaryTiledImage.imageToViewportWidth === "function") {
            const width = Number(primaryTiledImage.imageToViewportWidth(span));
            if (Number.isFinite(width) && width > 0) return width;
        }
        if (!primaryTiledImage || typeof primaryTiledImage.imageToViewportCoordinates !== "function") {
            return null;
        }
        const OpenSeadragon = AnnotationAdapter._openSeadragon();
        const origin = primaryTiledImage.imageToViewportCoordinates(
            OpenSeadragon?.Point ? new OpenSeadragon.Point(0, 0) : 0,
            OpenSeadragon?.Point ? undefined : 0
        );
        const edge = primaryTiledImage.imageToViewportCoordinates(
            OpenSeadragon?.Point ? new OpenSeadragon.Point(span, 0) : span,
            OpenSeadragon?.Point ? undefined : 0
        );
        const width = Math.abs(Number(edge?.x) - Number(origin?.x));
        return Number.isFinite(width) && width > 0 ? width : null;
    }

    static readViewportImageBounds(viewer, options = {}) {
        const host = viewer || AnnotationAdapter.viewer;
        const meta = AnnotationAdapter.imageMetadata;
        const item = host?.world && typeof host.world.getItemAt === "function"
            ? host.world.getItemAt(0)
            : null;
        const sourceWidth = Number(item?.source?.width ?? meta?.width) || 0;
        const sourceHeight = Number(item?.source?.height ?? meta?.height) || 0;
        const element = host?.element || host?.canvas;
        const pixelWidth = Math.max(1, Number(element?.clientWidth) || 1);
        const pixelHeight = Math.max(1, Number(element?.clientHeight) || 1);
        const target = String(options.segTarget || AnnotationAdapter.readAiLabConfig(options.root).segTarget || "viewport");
        if (target === "annotation") {
            const selected = AnnotationAdapter.readSelectedAnnotationImageBounds();
            if (selected) {
                return {
                    ...selected,
                    sourceWidth,
                    sourceHeight,
                    pixelWidth,
                    pixelHeight
                };
            }
        }
        const topLeft = AnnotationAdapter.screenPixelToImagePoint(host, 0, 0);
        const bottomRight = AnnotationAdapter.screenPixelToImagePoint(host, pixelWidth, pixelHeight);
        if (topLeft && bottomRight) {
            return {
                x: Math.min(topLeft.x, bottomRight.x),
                y: Math.min(topLeft.y, bottomRight.y),
                width: Math.abs(bottomRight.x - topLeft.x),
                height: Math.abs(bottomRight.y - topLeft.y),
                sourceWidth,
                sourceHeight,
                pixelWidth,
                pixelHeight
            };
        }
        return {
            x: 0,
            y: 0,
            width: sourceWidth,
            height: sourceHeight,
            sourceWidth,
            sourceHeight,
            pixelWidth,
            pixelHeight
        };
    }

    static readSelectedAnnotationImageBounds() {
        const engine = AnnotationAdapter.annotationEngine || AnnotationAdapter.annotationSpike;
        const selected = engine?.getSelectedAnnotations?.()?.[0];
        if (!selected || typeof engine.getAnnotationBounds !== "function") return null;
        try {
            const bounds = engine.getAnnotationBounds(selected);
            const x = Number(bounds?.x);
            const y = Number(bounds?.y);
            const width = Number(bounds?.width);
            const height = Number(bounds?.height);
            if (![x, y, width, height].every(Number.isFinite) || !(width > 1) || !(height > 1)) {
                return null;
            }
            return { x, y, width, height };
        } catch (_error) {
            return null;
        }
    }

    static tileImageBounds(bounds, tileSize = AnnotationAdapter.NUCLEUS_TILE_SIZE, overlap = AnnotationAdapter.NUCLEUS_TILE_OVERLAP) {
        const x0 = Math.max(0, Math.floor(Number(bounds?.x) || 0));
        const y0 = Math.max(0, Math.floor(Number(bounds?.y) || 0));
        const width = Math.max(1, Math.ceil(Number(bounds?.width) || 1));
        const height = Math.max(1, Math.ceil(Number(bounds?.height) || 1));
        const x1 = x0 + width;
        const y1 = y0 + height;
        const size = Math.max(64, Number(tileSize) || AnnotationAdapter.NUCLEUS_TILE_SIZE);
        const step = Math.max(32, size - Math.max(0, Number(overlap) || 0));
        const tiles = [];
        for (let y = y0; y < y1; y += step) {
            for (let x = x0; x < x1; x += step) {
                const w = Math.min(size, x1 - x);
                const h = Math.min(size, y1 - y);
                tiles.push({
                    x,
                    y,
                    width: w,
                    height: h,
                    edgeLeft: x <= x0,
                    edgeTop: y <= y0,
                    edgeRight: x + w >= x1,
                    edgeBottom: y + h >= y1
                });
            }
        }
        return tiles;
    }

    static planNucleusTiles(bounds) {
        const overlap = AnnotationAdapter.NUCLEUS_TILE_OVERLAP;
        let tileSize = AnnotationAdapter.NUCLEUS_TILE_SIZE;
        let tiles = AnnotationAdapter.tileImageBounds(bounds, tileSize, overlap);
        while (tiles.length > AnnotationAdapter.NUCLEUS_MAX_TILES && tileSize < 8192) {
            tileSize *= 2;
            tiles = AnnotationAdapter.tileImageBounds(bounds, tileSize, overlap);
        }
        if (tiles.length > AnnotationAdapter.NUCLEUS_MAX_TILES) {
            tiles = tiles.slice(0, AnnotationAdapter.NUCLEUS_MAX_TILES);
        }
        return {
            tiles,
            tileSize,
            fullRes: tileSize <= AnnotationAdapter.NUCLEUS_TILE_SIZE
        };
    }

    static nucleusInTileInterior(nucleus, tile, margin) {
        const x = Number(nucleus?.x);
        const y = Number(nucleus?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        const pad = Math.max(0, Number(margin) || 0);
        const minX = tile.x + (tile.edgeLeft ? 0 : pad);
        const minY = tile.y + (tile.edgeTop ? 0 : pad);
        const maxX = tile.x + tile.width - (tile.edgeRight ? 0 : pad);
        const maxY = tile.y + tile.height - (tile.edgeBottom ? 0 : pad);
        return x >= minX && x < maxX && y >= minY && y < maxY;
    }

    static async fetchNativeRegionTile(imageId, tile, options = {}) {
        const series = Number(options.series ?? AnnotationAdapter.currentSeries) || 0;
        const z = Number(options.z ?? AnnotationAdapter.currentZ) || 0;
        const max = Number(options.max) > 0 ? Number(options.max) : AnnotationAdapter.NUCLEUS_TILE_MAX;
        const url = `/api/images/${encodeURIComponent(imageId)}/region.png`
            + `?x=${tile.x}&y=${tile.y}&width=${tile.width}&height=${tile.height}`
            + `&max=${max}&series=${series}&z=${z}`;
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (!blob || !blob.size) return null;
        const bitmap = (typeof createImageBitmap === "function")
            ? await createImageBitmap(blob)
            : await AnnotationAdapter.loadImageElementForOcrDraw(URL.createObjectURL(blob));
        if (!bitmap) return null;
        const rasterWidth = Number(bitmap.width || bitmap.naturalWidth) || 0;
        const rasterHeight = Number(bitmap.height || bitmap.naturalHeight) || 0;
        if (rasterWidth < 8 || rasterHeight < 8) return null;
        const surface = AnnotationAdapter.createOffscreenSurface(
            rasterWidth,
            rasterHeight,
            options.root || options.document
        );
        const ctx = surface && typeof surface.getContext === "function"
            ? surface.getContext("2d", { willReadFrequently: true })
            : null;
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0);
        if (typeof bitmap.close === "function") {
            try { bitmap.close(); } catch (_error) { /* ignore */ }
        }
        return {
            imageData: ctx.getImageData(0, 0, rasterWidth, rasterHeight),
            width: rasterWidth,
            height: rasterHeight,
            originX: tile.x,
            originY: tile.y,
            scaleX: tile.width / rasterWidth,
            scaleY: tile.height / rasterHeight,
            tile
        };
    }

    static async fetchNativeViewportRegion(viewer, options = {}) {
        const host = viewer || AnnotationAdapter.viewer;
        const imageId = options.imageId || AnnotationAdapter.currentImageId;
        const bounds = AnnotationAdapter.readViewportImageBounds(host);
        if (!imageId || !(bounds.width > 1) || !(bounds.height > 1)) return null;
        const x = Math.max(0, Math.floor(bounds.x));
        const y = Math.max(0, Math.floor(bounds.y));
        const width = Math.max(1, Math.ceil(bounds.width));
        const height = Math.max(1, Math.ceil(bounds.height));
        return AnnotationAdapter.fetchNativeRegionTile(imageId, { x, y, width, height }, {
            ...options,
            max: Number(options.max) > 0 ? Number(options.max) : 2048
        });
    }

    static async mapWithConcurrency(items, limit, worker) {
        const list = Array.isArray(items) ? items : [];
        const width = Math.max(1, Number(limit) || 1);
        const out = new Array(list.length);
        let cursor = 0;
        const run = async () => {
            while (cursor < list.length) {
                const index = cursor;
                cursor += 1;
                out[index] = await worker(list[index], index);
            }
        };
        await Promise.all(Array.from({ length: Math.min(width, list.length) }, () => run()));
        return out;
    }

    static nucleusVertexList(nucleus) {
        const raw = nucleus?.vertices || nucleus?.imageCoordinates || nucleus?.polygon || [];
        if (!Array.isArray(raw)) return [];
        const vertices = [];
        for (const point of raw) {
            if (Array.isArray(point)) {
                const x = Number(point[0]);
                const y = Number(point[1]);
                if (Number.isFinite(x) && Number.isFinite(y)) vertices.push({ x, y });
                continue;
            }
            const x = Number(point?.x);
            const y = Number(point?.y);
            if (Number.isFinite(x) && Number.isFinite(y)) vertices.push({ x, y });
        }
        return vertices;
    }

    static verticesToPointsString(vertices) {
        return AnnotationAdapter.nucleusVertexList({ vertices }).map((v) => `${v.x},${v.y}`).join(" ");
    }

    static starVerticesFromCircle(cx, cy, radius, rays = AnnotationAdapter.STARDIST_RAYS) {
        const count = Math.max(8, Number(rays) || AnnotationAdapter.STARDIST_RAYS);
        const r = Math.max(2, Number(radius) || 8);
        const ring = [];
        for (let i = 0; i < count; i += 1) {
            const angle = (i / count) * Math.PI * 2;
            ring.push({
                x: Number(cx) + Math.cos(angle) * r,
                y: Number(cy) + Math.sin(angle) * r
            });
        }
        return ring;
    }

    static mapPluginNucleiToOverlays(result) {
        const list = Array.isArray(result?.nuclei) ? result.nuclei : [];
        const overlays = [];
        for (const nucleus of list) {
            const vertices = AnnotationAdapter.nucleusVertexList(nucleus);
            const cx = Number(nucleus?.cx ?? nucleus?.centerX ?? nucleus?.x);
            const cy = Number(nucleus?.cy ?? nucleus?.centerY ?? nucleus?.y);
            if (vertices.length < 3 && !(Number.isFinite(cx) && Number.isFinite(cy))) continue;
            const ring = vertices.length >= 3
                ? vertices
                : AnnotationAdapter.starVerticesFromCircle(cx, cy, nucleus?.r ?? nucleus?.radius);
            overlays.push({
                id: overlays.length + 1,
                type: "Polygon",
                centerX: cx,
                centerY: cy,
                cx,
                cy,
                x: cx,
                y: cy,
                vertices: ring,
                imageCoordinates: ring.map((vertex) => [vertex.x, vertex.y]),
                classification: "nucleus"
            });
        }
        return overlays;
    }

    static mapRegionNucleiToImageCircles(nuclei, region) {
        const originX = Number(region?.originX) || 0;
        const originY = Number(region?.originY) || 0;
        const scaleX = Number(region?.scaleX) || 1;
        const scaleY = Number(region?.scaleY) || 1;
        const circles = [];
        let id = 0;
        for (const nucleus of nuclei || []) {
            const centerX = originX + Number(nucleus.x) * scaleX;
            const centerY = originY + Number(nucleus.y) * scaleY;
            const radius = Math.max(4, Number(nucleus.radius) * Math.min(scaleX, scaleY) || 8);
            if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) continue;
            const vertices = [];
            for (const point of AnnotationAdapter.nucleusVertexList(nucleus)) {
                const px = originX + point.x * scaleX;
                const py = originY + point.y * scaleY;
                if (Number.isFinite(px) && Number.isFinite(py)) vertices.push({ x: px, y: py });
            }
            const ring = vertices.length >= 3
                ? vertices
                : AnnotationAdapter.starVerticesFromCircle(centerX, centerY, radius);
            circles.push({
                id: (id += 1),
                type: "Polygon",
                centerX,
                centerY,
                cx: centerX,
                cy: centerY,
                x: centerX,
                y: centerY,
                r: radius,
                radius,
                vertices: ring,
                imageCoordinates: ring.map((vertex) => [vertex.x, vertex.y]),
                classification: "nucleus"
            });
        }
        return circles;
    }

    static mapDetectedNucleiToImageCircles(nuclei, canvas, viewer) {
        const host = viewer || AnnotationAdapter.viewer;
        const bounds = AnnotationAdapter.readViewportImageBounds(host);
        const sourceWidth = Number(bounds.sourceWidth || AnnotationAdapter.imageMetadata?.width);
        const sourceHeight = Number(bounds.sourceHeight || AnnotationAdapter.imageMetadata?.height);
        const circles = [];
        let id = 0;
        for (const nucleus of nuclei || []) {
            const pixelX = Number(nucleus.x);
            const pixelY = Number(nucleus.y);
            const screenRadius = Math.max(3, Number(nucleus.radius) || 8);
            const mapped = AnnotationAdapter.screenPixelToImagePoint(host, pixelX, pixelY, canvas);
            const radial = AnnotationAdapter.screenPixelToImagePoint(
                host,
                pixelX + screenRadius,
                pixelY,
                canvas
            );
            if (!mapped) continue;
            const centerX = mapped.x;
            const centerY = mapped.y;
            let radius = radial ? Math.abs(radial.x - mapped.x) : 0;
            if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) continue;
            if (sourceWidth > 0 && (centerX < 0 || centerX > sourceWidth)) continue;
            if (sourceHeight > 0 && (centerY < 0 || centerY > sourceHeight)) continue;
            if (!(radius > 0)) {
                radius = Math.max(6, screenRadius);
            }
            const vertices = [];
            for (const point of AnnotationAdapter.nucleusVertexList(nucleus)) {
                const vertex = AnnotationAdapter.screenPixelToImagePoint(
                    host,
                    Number(point.x),
                    Number(point.y),
                    canvas
                );
                if (!vertex) continue;
                vertices.push({ x: vertex.x, y: vertex.y });
            }
            const ring = vertices.length >= 3
                ? vertices
                : AnnotationAdapter.starVerticesFromCircle(centerX, centerY, radius);
            circles.push({
                id: (id += 1),
                type: "Polygon",
                centerX,
                centerY,
                cx: centerX,
                cy: centerY,
                x: centerX,
                y: centerY,
                r: radius,
                radius,
                vertices: ring,
                imageCoordinates: ring.map((vertex) => [vertex.x, vertex.y]),
                classification: "nucleus"
            });
        }
        return circles;
    }

    static nucleiFromGrayField(gray, width, height, options = {}) {
        const intensity = AnnotationAdapter.localizeNucleiFromIntensity(gray, width, height, {
            probability: options.probability,
            minArea: options.minArea || 8,
            maxArea: options.maxArea || 1600,
            maxSide: options.maxSide || AnnotationAdapter.NUCLEUS_TILE_SIZE
        });
        const cap = Number(options.maxCount) > 0
            ? Number(options.maxCount)
            : AnnotationAdapter.NUCLEUS_MAX_COUNT;
        return AnnotationAdapter.suppressOverlappingNuclei(intensity, options.nms).slice(0, cap);
    }

    static async buildTissueLockedNucleiCircles(viewer, options = {}) {
        const host = viewer || options.viewer || AnnotationAdapter.viewer;
        const root = options.root || options.document || (typeof document !== "undefined" ? document : null);
        const config = AnnotationAdapter.readAiLabConfig(root, options);
        const imageId = options.imageId || AnnotationAdapter.currentImageId;
        const bounds = AnnotationAdapter.readViewportImageBounds(host, {
            ...options,
            root,
            segTarget: config.segTarget
        });
        const plan = AnnotationAdapter.planNucleusTiles(bounds);
        if (imageId && plan.tiles.length) {
            AnnotationAdapter.setAiStatus(
                `AI Pipeline: StarDist tiles ${plan.tiles.length} full-res subareas…`,
                root
            );
            const margin = Math.floor(AnnotationAdapter.NUCLEUS_TILE_OVERLAP / 2);
            const mapped = [];
            try {
                const regions = await AnnotationAdapter.mapWithConcurrency(
                    plan.tiles,
                    AnnotationAdapter.NUCLEUS_FETCH_CONCURRENCY,
                    (tile) => AnnotationAdapter.fetchNativeRegionTile(imageId, tile, {
                        ...options,
                        root,
                        max: AnnotationAdapter.NUCLEUS_TILE_MAX
                    })
                );
                for (const region of regions) {
                    if (!region?.imageData) continue;
                    const payload = AnnotationAdapter.imageDataToNormalizedFloat32(region.imageData, {
                        channel: config.channel
                    });
                    const nuclei = AnnotationAdapter.nucleiFromGrayField(
                        payload.gray,
                        payload.width,
                        payload.height,
                        { ...config, maxSide: Math.max(payload.width, payload.height) }
                    );
                    const circles = AnnotationAdapter.mapRegionNucleiToImageCircles(nuclei, region);
                    for (const circle of circles) {
                        if (AnnotationAdapter.nucleusInTileInterior(circle, region.tile, margin)) {
                            mapped.push(circle);
                        }
                    }
                }
            } catch (_error) {
                mapped.length = 0;
            }
            if (mapped.length) {
                const merged = AnnotationAdapter.suppressOverlappingNuclei(
                    mapped.map((circle) => ({
                        ...circle,
                        minX: circle.centerX - circle.radius,
                        minY: circle.centerY - circle.radius,
                        maxX: circle.centerX + circle.radius,
                        maxY: circle.centerY + circle.radius,
                        area: Math.PI * circle.radius * circle.radius
                    })),
                    config.nms
                ).slice(0, AnnotationAdapter.NUCLEUS_MAX_COUNT);
                const outlined = merged.filter((item) => (item.imageCoordinates || []).length >= 3).length;
                const resNote = plan.fullRes ? "full-res" : "capped";
                return {
                    circles: merged,
                    status: `AI Pipeline: Locked ${merged.length} StarDist DAPI outlines from ${plan.tiles.length} ${resNote} tiles (${outlined} polygons).`
                };
            }
        }
        const analysis = AnnotationAdapter._analyzeViewport({ ...options, viewer: host, root });
        if (!analysis?.payload) return { circles: [], status: "AI Pipeline: No viewport canvas available." };
        const suppressed = AnnotationAdapter.nucleiFromGrayField(
            analysis.payload.gray,
            analysis.payload.width,
            analysis.payload.height,
            analysis.config
        );
        const circles = AnnotationAdapter.mapDetectedNucleiToImageCircles(
            suppressed,
            analysis.captured?.canvas,
            host
        );
        const outlined = circles.filter((item) => (item.imageCoordinates || []).length >= 3).length;
        const status = circles.length
            ? `AI Pipeline: Locked ${circles.length} star-convex DAPI outlines (${outlined} polygons).`
            : "AI Pipeline: No nuclei detected in the visible field.";
        return { circles, status };
    }

    static isNucleusVectorOverlayElement(element) {
        if (!element) return false;
        if (element.classList?.contains("nucleus-vector-ring")) return true;
        if (element.classList?.contains("nucleus-stardist-layer")) return true;
        if (element.classList?.contains("wsi-ai-nuclei-overlay")) return true;
        if (element.id === AnnotationAdapter.AI_VECTOR_OVERLAY_ID) return true;
        return element.getAttribute?.("data-ai-nucleus-overlay") === "1";
    }

    static clearNucleiCircleOverlays(viewer) {
        const host = viewer || AnnotationAdapter.viewer;
        const known = Array.isArray(AnnotationAdapter.aiNucleusOverlayElements)
            ? AnnotationAdapter.aiNucleusOverlayElements.slice()
            : [];
        if (host && Array.isArray(host.currentOverlays)) {
            for (const overlay of host.currentOverlays) {
                const element = overlay?.element;
                if (element && AnnotationAdapter.isNucleusVectorOverlayElement(element)
                    && !known.includes(element)) {
                    known.push(element);
                }
            }
        }
        if (host && typeof host.removeOverlay === "function") {
            for (const element of known) {
                try { host.removeOverlay(element); } catch (_error) { /* already gone */ }
                if (element && typeof element.remove === "function") element.remove();
            }
        }
        AnnotationAdapter.aiNucleusOverlayElements = [];
        AnnotationAdapter.aiNucleusOverlayParts = [];
        AnnotationAdapter.aiNucleiOverlayEl = null;
        AnnotationAdapter.syncNucleiVisibilityButton();
    }

    static paintNucleiCircleOverlays(viewer, circles) {
        const host = viewer || AnnotationAdapter.viewer;
        AnnotationAdapter.clearNucleiCircleOverlays(host);
        const list = Array.isArray(circles) ? circles : [];
        if (!host || typeof host.addOverlay !== "function" || !list.length) return 0;
        const doc = typeof document !== "undefined" ? document : null;
        if (!doc || typeof doc.createElement !== "function") return 0;
        const polygons = list.map((nucleus) => {
            const vertices = AnnotationAdapter.nucleusVertexList(nucleus);
            if (vertices.length >= 3) {
                return { ...nucleus, vertices, imageCoordinates: vertices.map((v) => [v.x, v.y]) };
            }
            const cx = Number(nucleus.centerX ?? nucleus.cx ?? nucleus.x);
            const cy = Number(nucleus.centerY ?? nucleus.cy ?? nucleus.y);
            const radius = Math.max(4, Number(nucleus.radius ?? nucleus.r) || 12);
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
            const ring = AnnotationAdapter.starVerticesFromCircle(cx, cy, radius);
            return { ...nucleus, vertices: ring, imageCoordinates: ring.map((v) => [v.x, v.y]) };
        }).filter(Boolean);
        return AnnotationAdapter.paintStarConvexNucleiLayer(host, polygons, doc);
    }

    static paintStarConvexNucleiLayer(viewer, nuclei, doc) {
        const host = viewer || AnnotationAdapter.viewer;
        const primaryTiledImage = AnnotationAdapter.primaryTiledImage(host);
        const mapper = (primaryTiledImage && typeof primaryTiledImage.imageToViewportRectangle === "function")
            ? primaryTiledImage
            : null;
        if (!mapper || typeof mapper.imageToViewportRectangle !== "function") return 0;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const nucleus of nuclei) {
            for (const point of AnnotationAdapter.nucleusVertexList(nucleus)) {
                if (point.x < minX) minX = point.x;
                if (point.y < minY) minY = point.y;
                if (point.x > maxX) maxX = point.x;
                if (point.y > maxY) maxY = point.y;
            }
        }
        if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return 0;
        const pad = Math.max(4, (maxX - minX) * 0.01);
        minX -= pad;
        minY -= pad;
        maxX += pad;
        maxY += pad;
        const width = maxX - minX;
        const height = maxY - minY;
        const svgNs = "http://www.w3.org/2000/svg";
        const svg = doc.createElementNS(svgNs, "svg");
        svg.setAttribute("class", "nucleus-vector-ring nucleus-stardist-layer");
        svg.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.style.overflow = "visible";
        svg.style.pointerEvents = "none";
        const polygons = new Array(nuclei.length);
        for (let index = 0; index < nuclei.length; index += 1) {
            const nucleus = nuclei[index];
            const ring = AnnotationAdapter.nucleusVertexList(nucleus);
            if (ring.length < 3) continue;
            const polygon = doc.createElementNS(svgNs, "polygon");
            const pointsString = AnnotationAdapter.verticesToPointsString(ring);
            polygon.setAttribute("points", pointsString);
            polygon.setAttribute("fill", "rgba(0,255,0,.15)");
            // Independent on/off knob (plain "F" key, see toggleDetectionFill) that never
            // touches the fill color itself, so heat-map/IHC recoloring (which sets "fill"
            // directly) keeps working no matter which state this is in.
            polygon.setAttribute("fill-opacity", AnnotationAdapter.detectionFillEnabled ? "1" : "0");
            polygon.setAttribute("stroke", "#00FF00");
            polygon.setAttribute("stroke-width", "2");
            polygon.setAttribute("vector-effect", "non-scaling-stroke");
            polygon.setAttribute("data-nucleus-index", String(index));
            svg.appendChild(polygon);
            polygons[index] = polygon;
        }
        let location;
        try {
            location = mapper.imageToViewportRectangle(minX, minY, width, height);
        } catch (_error) {
            return 0;
        }
        if (AnnotationAdapter.aiOverlayVisible === false) svg.style.display = "none";
        host.addOverlay({
            element: svg,
            location,
            checkResize: false
        });
        if (svg.style) svg.style.pointerEvents = "none";
        if (svg.parentElement?.style) svg.parentElement.style.pointerEvents = "none";
        AnnotationAdapter.aiNucleusOverlayElements = [svg];
        AnnotationAdapter.aiNucleusOverlayParts = polygons;
        AnnotationAdapter.syncNucleiVisibilityButton();
        return 1;
    }

    static async paintViewportNucleiCircles(options = {}) {
        const root = options.root || options.document || (typeof document !== "undefined" ? document : null);
        const viewer = options.viewer || AnnotationAdapter.viewer;
        AnnotationAdapter.setAiStatus("AI Pipeline: Fetching native-resolution field…", root);
        const detected = await AnnotationAdapter.buildTissueLockedNucleiCircles(viewer, { ...options, root });
        const circles = detected.circles || [];
        AnnotationAdapter.replaceLocalizedCellObjects(circles);
        AnnotationAdapter.lastNucleiCircles = circles;
        if (AnnotationAdapter.aiOverlayVisible !== false) {
            AnnotationAdapter.paintNucleiCircleOverlays(viewer, circles);
        } else {
            AnnotationAdapter.clearNucleiCircleOverlays(viewer);
        }
        AnnotationAdapter.restoreViewerMouseNavUnlessModal(viewer);
        AnnotationAdapter.setAiStatus(detected.status, root);
        return {
            count: circles.length,
            nuclei: circles,
            objects: circles,
            localizedCellObjects: circles
        };
    }

    static visiblePluginChannels() {
        const names = AnnotationAdapter.FLUORESCENT_CHANNEL_NAMES.slice();
        const visibility = AnnotationAdapter.channelLayerState?.visibility;
        if (!visibility) return names;
        const selected = names.filter((name, index) =>
            visibility[name] !== false && visibility[index] !== false
        );
        return selected.length ? selected : names;
    }

    /**
     * Resolves the "Segmentation Channel" AI Labs dropdown (`#ai-seg-channel`) to the
     * channel list sent to the backend StarDist plugin. "default" preserves the prior
     * behavior of segmenting on whatever channels are currently visible in the
     * Brightness & Contrast panel; a specific "1"/"2"/"3" choice restricts detection to
     * that single channel by name so it survives BioFormatsTileService's channel
     * resolution unambiguously (a bare numeric token there is read as a raw 0-based
     * channel index, not this 1-based dropdown's index, so we must send the channel
     * *name* instead of the raw dropdown value).
     */
    static resolveSegmentationChannels(channelValue) {
        const raw = channelValue == null ? "default" : String(channelValue).trim().toLowerCase();
        const byDropdownValue = { "1": 0, "2": 1, "3": 2 };
        if (Object.prototype.hasOwnProperty.call(byDropdownValue, raw)) {
            const name = AnnotationAdapter.FLUORESCENT_CHANNEL_NAMES[byDropdownValue[raw]];
            if (name) return [name];
        }
        return AnnotationAdapter.visiblePluginChannels();
    }

    static nucleiFootprintsForPlugin(circles) {
        const list = Array.isArray(circles) ? circles : AnnotationAdapter.lastNucleiCircles || [];
        const footprints = [];
        for (const nucleus of list) {
            const cx = Number(nucleus?.centerX ?? nucleus?.cx ?? nucleus?.x);
            const cy = Number(nucleus?.centerY ?? nucleus?.cy ?? nucleus?.y);
            const radius = Number(nucleus?.radius ?? nucleus?.r);
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
            const vertices = AnnotationAdapter.nucleusVertexList(nucleus);
            footprints.push({
                cx,
                cy,
                r: Math.max(1, Number.isFinite(radius) ? radius : 12),
                vertices
            });
        }
        return footprints;
    }

    static pluginStatsTableHtml(result) {
        const channels = Array.isArray(result?.channels) ? result.channels : [];
        const rows = channels.map((channel) => {
            const name = String(channel?.name || "band");
            const mean = Number(channel?.mean) || 0;
            const std = Number(channel?.stdDev) || 0;
            const max = Number(channel?.maximum ?? channel?.max) || 0;
            const min = Number(channel?.minimum ?? channel?.min) || 0;
            return `<tr><th>${name}</th><td>${mean.toFixed(1)}</td><td>${std.toFixed(1)}</td><td>${max}</td><td>${min}</td></tr>`;
        }).join("");
        const n = Number(result?.sampleCount) || 0;
        const nuclei = Number(result?.nucleusCount) || 0;
        const caption = nuclei
            ? `n=${n} samples inside ${nuclei} nuclear circles`
            : `n=${n} samples across viewport footprint`;
        return `<table><caption>${caption}</caption><thead><tr><th>Band</th><th>Mean</th><th>SD</th><th>Max</th><th>Min</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    static renderPluginStatsTable(result, root) {
        const host = root || (typeof document !== "undefined" ? document : null);
        const mount = host && typeof host.getElementById === "function"
            ? host.getElementById("ai-plugin-stats")
            : null;
        if (!mount) return false;
        mount.innerHTML = AnnotationAdapter.pluginStatsTableHtml(result);
        mount.hidden = false;
        return true;
    }

    static clearPluginStatsOverlay(viewer) {
        const host = viewer || AnnotationAdapter.viewer;
        const element = AnnotationAdapter.lastPluginStatsOverlay;
        if (host && element && typeof host.removeOverlay === "function") {
            try { host.removeOverlay(element); } catch (_error) { /* already gone */ }
        }
        if (element && typeof element.remove === "function") element.remove();
        AnnotationAdapter.lastPluginStatsOverlay = null;
    }

    static paintPluginStatsOverlay(viewer, result) {
        const host = viewer || AnnotationAdapter.viewer;
        AnnotationAdapter.clearPluginStatsOverlay(host);
        const doc = typeof document !== "undefined" ? document : null;
        if (!host || !doc || typeof host.addOverlay !== "function" || !result) return false;
        const panel = doc.createElement("div");
        panel.className = "nucleus-plugin-stats";
        panel.setAttribute("data-ai-plugin-stats", "1");
        panel.innerHTML = AnnotationAdapter.pluginStatsTableHtml(result);
        const OpenSeadragon = AnnotationAdapter._openSeadragon();
        const primaryTiledImage = AnnotationAdapter.primaryTiledImage(host);
        const mapper = (primaryTiledImage && typeof primaryTiledImage.imageToViewportCoordinates === "function")
            ? primaryTiledImage
            : null;
        const x = Number(result.x) || 0;
        const y = Number(result.y) || 0;
        const width = Math.max(1, Number(result.width) || 1);
        const height = Math.max(1, Number(result.height) || 1);
        let location = { x: 0, y: 0 };
        try {
            if (OpenSeadragon?.Point && mapper && typeof mapper.imageToViewportCoordinates === "function") {
                location = mapper.imageToViewportCoordinates(
                    new OpenSeadragon.Point(x, y + height)
                );
            }
        } catch (_error) {
            location = { x: 0, y: 0 };
        }
        host.addOverlay({
            element: panel,
            location,
            placement: OpenSeadragon?.Placement?.TOP_LEFT || "TOP_LEFT",
            checkResize: false
        });
        if (panel.parentElement?.style) panel.parentElement.style.pointerEvents = "none";
        AnnotationAdapter.lastPluginStatsOverlay = panel;
        return true;
    }

    static async runPixelIntensityPlugin(options = {}) {
        const root = options.root || options.document || (typeof document !== "undefined" ? document : null);
        const viewer = options.viewer || AnnotationAdapter.viewer;
        const imageId = options.imageId || AnnotationAdapter.currentImageId;
        if (!imageId) {
            AnnotationAdapter.setAiStatus("AI Pipeline: Open a slide before running the pixel plugin.", root);
            return null;
        }
        const bounds = AnnotationAdapter.readViewportImageBounds(viewer, { root, ...options });
        const payload = {
            imageId,
            x: Math.max(0, Math.floor(Number(bounds?.x) || 0)),
            y: Math.max(0, Math.floor(Number(bounds?.y) || 0)),
            width: Math.max(1, Math.floor(Number(bounds?.width) || 1)),
            height: Math.max(1, Math.floor(Number(bounds?.height) || 1)),
            channels: AnnotationAdapter.visiblePluginChannels(),
            pluginId: "quantify-nuclei-pixel",
            series: Number(AnnotationAdapter.currentSeries) || 0,
            z: Number(AnnotationAdapter.currentZ) || 0,
            nuclei: AnnotationAdapter.nucleiFootprintsForPlugin(options.nuclei)
        };
        AnnotationAdapter.setAiStatus("AI Pipeline: Quantifying nuclear pixel intensity…", root);
        try {
            const csrf = (typeof window !== "undefined" && window.WsiCsrf)
                || (typeof globalThis !== "undefined" && globalThis.WsiCsrf)
                || null;
            const fetchFn = csrf && typeof csrf.csrfFetch === "function"
                ? csrf.csrfFetch.bind(csrf)
                : (typeof fetch === "function" ? fetch : null);
            if (!fetchFn) throw new Error("fetch is unavailable");
            const response = await fetchFn("/api/plugins/execute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (!response || !response.ok) {
                const text = response && typeof response.text === "function"
                    ? await response.text()
                    : "";
                throw new Error(text || `plugin ${response ? response.status : "failed"}`);
            }
            const result = await response.json();
            AnnotationAdapter.renderPluginStatsTable(result, root);
            AnnotationAdapter.paintPluginStatsOverlay(viewer, result);
            const n = Number(result?.sampleCount) || 0;
            AnnotationAdapter.setAiStatus(`AI Pipeline: Pixel plugin complete (n=${n}).`, root);
            return result;
        } catch (error) {
            AnnotationAdapter.setAiStatus(
                `AI Pipeline: Pixel plugin failed (${error?.message || error}).`,
                root
            );
            return null;
        }
    }

    static rainbowRgbFromNormalized(t) {
        const x = Math.max(0, Math.min(1, Number(t) || 0));
        const stops = [
            { t: 0, r: 0, g: 0, b: 255 },
            { t: 1 / 3, r: 0, g: 255, b: 0 },
            { t: 2 / 3, r: 255, g: 255, b: 0 },
            { t: 1, r: 255, g: 0, b: 0 }
        ];
        let index = 0;
        while (index < stops.length - 2 && x > stops[index + 1].t) index += 1;
        const start = stops[index];
        const end = stops[index + 1];
        const span = (end.t - start.t) || 1;
        const u = (x - start.t) / span;
        const r = Math.round(start.r + (end.r - start.r) * u);
        const g = Math.round(start.g + (end.g - start.g) * u);
        const b = Math.round(start.b + (end.b - start.b) * u);
        return `rgb(${r}, ${g}, ${b})`;
    }

    static rainbowColorFromKeys(value, min, max) {
        if (!Number.isFinite(value)) return AnnotationAdapter.rainbowRgbFromNormalized(0.5);
        if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
            return AnnotationAdapter.rainbowRgbFromNormalized(0.5);
        }
        return AnnotationAdapter.rainbowRgbFromNormalized((value - min) / (max - min));
    }

    static applyNucleusRainbowStyle(overlayElement, computedObjectColor) {
        if (!overlayElement || !computedObjectColor) return false;
        const tag = String(overlayElement.tagName || "").toLowerCase();
        const fill = computedObjectColor.replace("rgb", "rgba").replace(")", ", 0.25)");
        if (tag === "polygon") {
            overlayElement.setAttribute("stroke", computedObjectColor);
            overlayElement.setAttribute("fill", fill);
            return true;
        }
        if (!overlayElement.style) return false;
        overlayElement.style.border = `2px solid ${computedObjectColor}`;
        overlayElement.style.background = `${computedObjectColor.replace('rgb', 'rgba').replace(')', ', 0.25)')}`;
        return true;
    }

    static ihcRgbFromNormalized(t) {
        const x = Math.max(0, Math.min(1, Number(t) || 0));
        const r = Math.round(255 + (128 - 255) * x);
        const g = Math.round(255 * (1 - x));
        return `rgb(${r}, ${g}, 0)`;
    }

    static ihcColorFromKeys(value, min, max) {
        if (!Number.isFinite(value)) return AnnotationAdapter.ihcRgbFromNormalized(0.5);
        if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
            return AnnotationAdapter.ihcRgbFromNormalized(0.5);
        }
        return AnnotationAdapter.ihcRgbFromNormalized((value - min) / (max - min));
    }

    static applyObjectIhcColors(objects) {
        const list = Array.isArray(objects) ? objects : [];
        let min = Infinity;
        let max = -Infinity;
        for (const item of list) {
            const value = Number(item?.key);
            if (!Number.isFinite(value)) continue;
            if (value < min) min = value;
            if (value > max) max = value;
        }
        const parts = AnnotationAdapter.aiNucleusOverlayParts || [];
        for (const item of list) {
            const index = Number(item?.index);
            if (!Number.isInteger(index) || index < 0 || index >= parts.length) continue;
            const computedObjectColor = AnnotationAdapter.ihcColorFromKeys(Number(item.key), min, max);
            AnnotationAdapter.applyNucleusRainbowStyle(parts[index], computedObjectColor);
        }
        return list.length;
    }

    static applyObjectRainbowColors(objects) {
        const list = Array.isArray(objects) ? objects : [];
        let min = Infinity;
        let max = -Infinity;
        for (const item of list) {
            const value = Number(item?.key);
            if (!Number.isFinite(value)) continue;
            if (value < min) min = value;
            if (value > max) max = value;
        }
        const parts = AnnotationAdapter.aiNucleusOverlayParts || [];
        for (const item of list) {
            const index = Number(item?.index);
            if (!Number.isInteger(index) || index < 0 || index >= parts.length) continue;
            const computedObjectColor = AnnotationAdapter.rainbowColorFromKeys(Number(item.key), min, max);
            AnnotationAdapter.applyNucleusRainbowStyle(parts[index], computedObjectColor);
        }
        return list.length;
    }

    static resetNucleusOverlayColors() {
        const parts = AnnotationAdapter.aiNucleusOverlayParts || [];
        let touched = 0;
        for (const part of parts) {
            if (!part) continue;
            if (typeof part.setAttribute === "function") {
                part.setAttribute("fill", AnnotationAdapter.AI_NUCLEUS_DEFAULT_FILL);
                part.setAttribute("stroke", AnnotationAdapter.AI_NUCLEUS_DEFAULT_STROKE);
                touched += 1;
            } else if (part.style) {
                part.style.border = "";
                part.style.background = "";
                touched += 1;
            }
        }
        return touched;
    }

    static syncHeatMapButton(root) {
        const host = root || (typeof document !== "undefined" ? document : null);
        const button = host && typeof host.getElementById === "function"
            ? host.getElementById("ai-heatmap-toggle")
            : null;
        if (!button) return AnnotationAdapter.heatMapActive;
        button.setAttribute("aria-pressed", String(AnnotationAdapter.heatMapActive));
        button.textContent = AnnotationAdapter.heatMapActive ? "🌡️ Heat Map: ON" : "🌡️ Heat Map";
        return AnnotationAdapter.heatMapActive;
    }

    /**
     * Single-click Heat Map toggle: ON segments nuclei if needed (reusing the exact
     * same StarDist pipeline as the "1. Segment Nuclei" button) then color-codes them
     * via the real per-object signal quantifier (see runPerObjectPixelQuantifier /
     * PerObjectPixelQuantifierPlugin). OFF reverts every nucleus back to its original
     * uncolored outline — no dropdown/"Run" steps required either way.
     */
    static async toggleHeatMap(options = {}) {
        const root = options.root || options.document || (typeof document !== "undefined" ? document : null);
        const viewer = options.viewer || AnnotationAdapter.viewer;
        if (AnnotationAdapter.heatMapActive) {
            AnnotationAdapter.resetNucleusOverlayColors();
            AnnotationAdapter.heatMapActive = false;
            AnnotationAdapter.setAiStatus("AI Pipeline: Heat map cleared.", root);
            AnnotationAdapter.syncHeatMapButton(root);
            return false;
        }
        if (!(AnnotationAdapter.lastNucleiCircles || []).length) {
            await AnnotationAdapter.segmentCellNuclei({ root, viewer });
        }
        // runPerObjectPixelQuantifier already reports a specific status for every
        // failure mode (no slide open, no nuclei segmented, request failed); don't
        // stomp on that with a generic message here.
        const result = await AnnotationAdapter.runPerObjectPixelQuantifier({ root, viewer });
        AnnotationAdapter.heatMapActive = !!(result && (result.objects || []).length);
        AnnotationAdapter.syncHeatMapButton(root);
        return AnnotationAdapter.heatMapActive;
    }

    static async runPerObjectPixelQuantifier(options = {}) {
        const root = options.root || options.document || (typeof document !== "undefined" ? document : null);
        const viewer = options.viewer || AnnotationAdapter.viewer;
        const imageId = options.imageId || AnnotationAdapter.currentImageId;
        const nuclei = AnnotationAdapter.nucleiFootprintsForPlugin(options.nuclei);
        if (!imageId) {
            AnnotationAdapter.setAiStatus("AI Pipeline: Open a slide before color coding objects.", root);
            return null;
        }
        if (!nuclei.length) {
            AnnotationAdapter.setAiStatus("AI Pipeline: Segment nuclei before color coding objects.", root);
            return null;
        }
        const bounds = AnnotationAdapter.readViewportImageBounds(viewer, { root, ...options });
        const payload = {
            imageId,
            x: Math.max(0, Math.floor(Number(bounds?.x) || 0)),
            y: Math.max(0, Math.floor(Number(bounds?.y) || 0)),
            width: Math.max(1, Math.floor(Number(bounds?.width) || 1)),
            height: Math.max(1, Math.floor(Number(bounds?.height) || 1)),
            channels: AnnotationAdapter.visiblePluginChannels(),
            pluginId: "per-object-pixel-quantifier",
            series: Number(AnnotationAdapter.currentSeries) || 0,
            z: Number(AnnotationAdapter.currentZ) || 0,
            nuclei
        };
        AnnotationAdapter.setAiStatus("AI Pipeline: Color coding objects…", root);
        try {
            const csrf = (typeof window !== "undefined" && window.WsiCsrf)
                || (typeof globalThis !== "undefined" && globalThis.WsiCsrf)
                || null;
            const fetchFn = csrf && typeof csrf.csrfFetch === "function"
                ? csrf.csrfFetch.bind(csrf)
                : (typeof fetch === "function" ? fetch : null);
            if (!fetchFn) throw new Error("fetch is unavailable");
            const response = await fetchFn("/api/plugins/execute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (!response || !response.ok) {
                throw new Error("plugin request failed");
            }
            const result = await response.json();
            AnnotationAdapter.applyObjectRainbowColors(result?.objects);
            AnnotationAdapter.setAiStatus("AI Pipeline: Object color coding complete.", root);
            return result;
        } catch (_error) {
            AnnotationAdapter.setAiStatus("AI Pipeline: Object color coding failed.", root);
            return null;
        }
    }

    static async runIhcColorDeconvolution(options = {}) {
        const root = options.root || options.document || (typeof document !== "undefined" ? document : null);
        const viewer = options.viewer || AnnotationAdapter.viewer;
        const imageId = options.imageId || AnnotationAdapter.currentImageId;
        const nuclei = AnnotationAdapter.nucleiFootprintsForPlugin(options.nuclei);
        if (!imageId) {
            AnnotationAdapter.setAiStatus("AI Pipeline: Open a slide before IHC deconvolution.", root);
            return null;
        }
        if (!nuclei.length) {
            AnnotationAdapter.setAiStatus("AI Pipeline: Segment nuclei before IHC deconvolution.", root);
            return null;
        }
        const bounds = AnnotationAdapter.readViewportImageBounds(viewer, { root, ...options });
        const payload = {
            imageId,
            x: Math.max(0, Math.floor(Number(bounds?.x) || 0)),
            y: Math.max(0, Math.floor(Number(bounds?.y) || 0)),
            width: Math.max(1, Math.floor(Number(bounds?.width) || 1)),
            height: Math.max(1, Math.floor(Number(bounds?.height) || 1)),
            channels: ["R", "G", "B"],
            pluginId: "ihc-pixel-quantifier",
            series: Number(AnnotationAdapter.currentSeries) || 0,
            z: Number(AnnotationAdapter.currentZ) || 0,
            nuclei
        };
        AnnotationAdapter.setAiStatus("AI Pipeline: Color coding IHC expression…", root);
        try {
            const csrf = (typeof window !== "undefined" && window.WsiCsrf)
                || (typeof globalThis !== "undefined" && globalThis.WsiCsrf)
                || null;
            const fetchFn = csrf && typeof csrf.csrfFetch === "function"
                ? csrf.csrfFetch.bind(csrf)
                : (typeof fetch === "function" ? fetch : null);
            if (!fetchFn) throw new Error("fetch is unavailable");
            const response = await fetchFn("/api/plugins/execute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (!response || !response.ok) {
                throw new Error("plugin request failed");
            }
            const result = await response.json();
            AnnotationAdapter.applyObjectIhcColors(result?.objects);
            AnnotationAdapter.setAiStatus("AI Pipeline: IHC color coding complete.", root);
            return result;
        } catch (_error) {
            AnnotationAdapter.setAiStatus("AI Pipeline: IHC color coding failed.", root);
            return null;
        }
    }

    static pluginCsrfFetch() {
        const csrf = (typeof window !== "undefined" && window.WsiCsrf)
            || (typeof globalThis !== "undefined" && globalThis.WsiCsrf)
            || null;
        if (csrf && typeof csrf.csrfFetch === "function") return csrf.csrfFetch.bind(csrf);
        return typeof fetch === "function" ? fetch : null;
    }

    static async runStarDistSegmentation(options = {}) {
        const root = options.root || options.document || (typeof document !== "undefined" ? document : null);
        const viewer = options.viewer || AnnotationAdapter.viewer;
        const imageId = options.imageId || AnnotationAdapter.currentImageId;
        if (!imageId) {
            AnnotationAdapter.setAiStatus("AI Pipeline: Open a slide before segmenting nuclei.", root);
            return null;
        }
        const bounds = AnnotationAdapter.readViewportImageBounds(viewer, { root, ...options });
        // Read the probability/NMS sliders live at click time (not a cached snapshot) so a
        // second click with different values actually reaches the backend tensor engine —
        // see StarDistSegmentationPlugin#execute / StarDistTensorEngine#infer for the consumer.
        const config = AnnotationAdapter.readAiLabConfig(root, options);
        const payload = {
            imageId,
            x: Math.max(0, Math.floor(Number(bounds?.x) || 0)),
            y: Math.max(0, Math.floor(Number(bounds?.y) || 0)),
            width: Math.max(1, Math.floor(Number(bounds?.width) || 1)),
            height: Math.max(1, Math.floor(Number(bounds?.height) || 1)),
            channels: AnnotationAdapter.isRgbSeriesView(AnnotationAdapter.imageMetadata, AnnotationAdapter.currentSeries)
                ? ["R", "G", "B"]
                : AnnotationAdapter.resolveSegmentationChannels(config.channel),
            pluginId: "stardist-segmentation",
            series: Number(AnnotationAdapter.currentSeries) || 0,
            z: Number(AnnotationAdapter.currentZ) || 0,
            probability: config.probability,
            nms: config.nms,
            maxNucleusRadius: config.maxNucleusRadius,
            rayCount: config.rayCount,
            boundaryTightness: config.boundaryTightness,
            modelOverride: config.modelOverride
        };
        AnnotationAdapter.setAiStatus("AI Pipeline: Running StarDist nuclear contours…", root);
        try {
            const fetchFn = AnnotationAdapter.pluginCsrfFetch();
            if (!fetchFn) throw new Error("fetch is unavailable");
            const response = await fetchFn("/api/plugins/execute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (!response || !response.ok) {
                const text = response && typeof response.text === "function"
                    ? await response.text()
                    : "";
                throw new Error(text || `plugin ${response ? response.status : "failed"}`);
            }
            const result = await response.json();
            const polygons = AnnotationAdapter.mapPluginNucleiToOverlays(result);
            if (!polygons.length) throw new Error("no contours");
            AnnotationAdapter.replaceLocalizedCellObjects(polygons);
            AnnotationAdapter.lastNucleiCircles = polygons;
            if (AnnotationAdapter.aiOverlayVisible !== false) {
                AnnotationAdapter.paintNucleiCircleOverlays(viewer, polygons);
            } else {
                AnnotationAdapter.clearNucleiCircleOverlays(viewer);
            }
            AnnotationAdapter.restoreViewerMouseNavUnlessModal(viewer);
            const model = String(result?.title || "StarDist").replace(/^.*\(([^)]+)\).*$/, "$1");
            AnnotationAdapter.setAiStatus(
                `AI Pipeline: Locked ${polygons.length} StarDist polygons (${model}).`,
                root
            );
            return {
                count: polygons.length,
                nuclei: polygons,
                objects: polygons,
                localizedCellObjects: polygons,
                result
            };
        } catch (error) {
            AnnotationAdapter.setAiStatus(
                `AI Pipeline: StarDist plugin unavailable (${error?.message || error}); using local contours.`,
                root
            );
            return null;
        }
    }

    static async segmentCellNuclei(options = {}) {
        const plugin = await AnnotationAdapter.runStarDistSegmentation(options);
        if (plugin && plugin.count > 0) return plugin;
        return AnnotationAdapter.paintViewportNucleiCircles(options);
    }

    static async extractBreastTissueFeatures(options = {}) {
        try {
            const analysis = AnnotationAdapter._analyzeViewport(options);
            if (!analysis) return null;
            const { gray, width, height, tensor } = analysis.payload;
            let sum = 0;
            for (let i = 0; i < gray.length; i += 1) sum += gray[i];
            const mean = gray.length ? sum / gray.length : 0;
            let variance = 0;
            for (let i = 0; i < gray.length; i += 1) {
                const d = gray[i] - mean;
                variance += d * d;
            }
            const std = gray.length ? Math.sqrt(variance / gray.length) : 0;
            const cut = AnnotationAdapter._edgeThreshold(analysis.magnitude);
            let edgeCount = 0;
            for (let i = 0; i < analysis.magnitude.length; i += 1) {
                if (analysis.magnitude[i] >= cut) edgeCount += 1;
            }
            const edgeDensity = analysis.magnitude.length ? edgeCount / analysis.magnitude.length : 0;
            const regions = AnnotationAdapter.localizeNucleiFromEdges(
                analysis.magnitude,
                width,
                height,
                { minArea: 24, maxArea: 12000 }
            );
            if (tensor && typeof tensor.dispose === "function") tensor.dispose();
            const status = `AI Pipeline: Extracted BR tissue features (mean=${mean.toFixed(2)}, edges=${edgeDensity.toFixed(2)}, regions=${regions.length})`;
            AnnotationAdapter.setAiStatus(status, analysis.root);
            return { mean, std, edgeDensity, regions: regions.length, status };
        } catch (error) {
            const root = options.root || options.document || (typeof document !== "undefined" ? document : null);
            AnnotationAdapter.setAiStatus(`AI Pipeline: ${error?.message || "analysis failed"}`, root);
            return null;
        }
    }
}

class NativeOsdAnnotationEngine {
    constructor(options = {}) {
        this.viewer = options.viewer || null;
        this.adapter = options.adapter || null;
        this.annotator = options.annotator || AnnotationAdapter.createNativeAnnotatorFacade();
        this.labelLayer = options.labelLayer || null;
        this.nameEditor = options.nameEditor || null;
        this.toggleButton = options.toggleButton || null;
        this.visibilityButton = options.visibilityButton || null;
        this.namesButton = options.namesButton || null;
        this.getCurrentImageId = options.getCurrentImageId || (() => null);
        this.timingCallbacks = options.timingCallbacks || {};
        this.drawingEnabled = false;
        this.annotationsVisible = true;
    }

    bindChrome() {
        if (this.toggleButton && this.toggleButton.dataset?.nativeDrawBound !== "1") {
            this.toggleButton.addEventListener("click", () => {
                if (AnnotationAdapter.isMeasurementModeActive) {
                    try { AnnotationAdapter.setMeasurementModeActive(false); } catch (_error) { /* ignore */ }
                }
                AnnotationAdapter.setViewerTool("rectangle");
            });
            if (this.toggleButton.dataset) this.toggleButton.dataset.nativeDrawBound = "1";
        }
        if (this.visibilityButton && this.visibilityButton.dataset?.nativeVisBound !== "1") {
            this.visibilityButton.addEventListener("click", () => {
                this.setAnnotationsVisible(!this.annotationsVisible);
            });
            if (this.visibilityButton.dataset) this.visibilityButton.dataset.nativeVisBound = "1";
        }
        if (this.namesButton && this.namesButton.dataset?.nativeNamesBound !== "1") {
            this.namesButton.addEventListener("click", () => {
                const visible = !(this.labelLayer?.namesVisible);
                this.labelLayer?.setNamesVisible?.(visible);
                AnnotationAdapter.annotationLabelsVisible = Boolean(visible);
                this.updateNamesButton();
            });
            if (this.namesButton.dataset) this.namesButton.dataset.nativeNamesBound = "1";
        }
        this.updateNamesButton();
        if (this.visibilityButton) {
            this.visibilityButton.setAttribute("aria-pressed", String(this.annotationsVisible));
            this.visibilityButton.textContent = "Annotations";
            const action = this.annotationsVisible ? "Hide annotations" : "Show annotations";
            this.visibilityButton.title = action;
            this.visibilityButton.setAttribute("aria-label", action);
        }
        return this;
    }

    async handleViewerOpen() {
        const imageId = this.getCurrentImageId?.();
        this.timingCallbacks.open?.(imageId);
        this.setDrawingEnabled(false);
        this.nameEditor?.setSelection?.([], this.annotationsVisible);
        this.timingCallbacks.selectionChanged?.([]);
        try { AnnotationAdapter.hideAnnotationEditorPopup(); } catch (_error) { /* ignore */ }
        this.labelLayer?.beginImage?.(imageId);
        if (this.adapter && typeof this.adapter.loadCurrentImage === "function") {
            await this.adapter.loadCurrentImage(imageId);
        }
    }

    setDrawingEnabled(enabled) {
        this.drawingEnabled = Boolean(enabled) && this.annotationsVisible;
        if (this.drawingEnabled) {
            try { AnnotationAdapter.setMeasureTracking?.(false); } catch (_error) { /* ignore */ }
            if (AnnotationAdapter.isMeasurementModeActive) {
                try { AnnotationAdapter.setMeasurementModeActive(false); } catch (_error) { /* ignore */ }
            }
            AnnotationAdapter.activateQuPathTool("rectangle");
        } else if (AnnotationAdapter.currentActiveTool === "rectangle") {
            AnnotationAdapter.activateQuPathTool("move");
        }
        this.drawingEnabled = Boolean(enabled) && this.annotationsVisible;
        if (this.toggleButton) {
            this.toggleButton.disabled = !this.annotationsVisible;
            this.toggleButton.setAttribute("aria-pressed", String(this.drawingEnabled));
            this.toggleButton.title = this.drawingEnabled
                ? "Exit rectangle annotation mode"
                : "Draw rectangle annotation";
            this.toggleButton.setAttribute("aria-label", this.toggleButton.title);
        }
        return this.drawingEnabled;
    }

    setAnnotationsVisible(visible) {
        this.annotationsVisible = Boolean(visible);
        AnnotationAdapter.vectorOutlinesVisible = this.annotationsVisible;
        this.viewer?.element?.classList?.toggle?.("annotations-hidden", !this.annotationsVisible);
        this.labelLayer?.setAnnotationsVisible?.(this.annotationsVisible);
        const doc = typeof document !== "undefined" ? document : null;
        const outlines = doc?.querySelectorAll?.(".osd-annotation-shape") || [];
        outlines.forEach(el => {
            if (el?.style) el.style.opacity = this.annotationsVisible ? "1" : "0";
        });
        if (!this.annotationsVisible) this.setDrawingEnabled(false);
        if (this.toggleButton) this.toggleButton.disabled = !this.annotationsVisible;
        if (this.visibilityButton) {
            this.visibilityButton.setAttribute("aria-pressed", String(this.annotationsVisible));
            this.visibilityButton.textContent = "Annotations";
            const action = this.annotationsVisible ? "Hide annotations" : "Show annotations";
            this.visibilityButton.title = action;
            this.visibilityButton.setAttribute("aria-label", action);
        }
        this.notifySelectionChanged();
        return this.annotationsVisible;
    }

    updateNamesButton() {
        if (!this.namesButton) return;
        const shown = this.labelLayer?.namesVisible !== false;
        this.namesButton.setAttribute("aria-pressed", String(shown));
        this.namesButton.textContent = "Names";
        this.namesButton.title = shown ? "Hide annotation names" : "Show annotation names";
        this.namesButton.setAttribute("aria-label", this.namesButton.title);
    }

    getSelectedAnnotations() {
        const ids = (AnnotationAdapter.selectedNativeAnnotationIds instanceof Set
            && AnnotationAdapter.selectedNativeAnnotationIds.size)
            ? Array.from(AnnotationAdapter.selectedNativeAnnotationIds)
            : (AnnotationAdapter.selectedNativeAnnotationId ? [AnnotationAdapter.selectedNativeAnnotationId] : []);
        if (!ids.length) return [];
        const live = this.annotator?.getAnnotations?.() || [];
        return ids.map(id => live.find(item => item?.id === id)).filter(Boolean);
    }

    notifySelectionChanged() {
        const selected = this.getSelectedAnnotations();
        this.nameEditor?.setSelection?.(selected, this.annotationsVisible);
        if (selected.length === 1 && this.annotationsVisible) {
            AnnotationAdapter.showAnnotationEditorForShape(selected[0], this.viewer);
        } else {
            AnnotationAdapter.hideAnnotationEditorPopup(null, { commit: false });
        }
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
        throw new Error("The selected annotation has no exportable geometry.");
    }
}

// Cold-start / cleared-storage defaults for measurement state.
AnnotationAdapter.ensureMeasurementDefaults();
AnnotationAdapter.setSavedAnnotations(
    (typeof window !== "undefined" && Array.isArray(window.savedAnnotationsArray))
        ? window.savedAnnotationsArray
        : AnnotationAdapter.savedAnnotationsArray
);
AnnotationAdapter.scheduleAiMlBackendInit();
AnnotationAdapter.bindResetViewportHomeButton();
AnnotationAdapter.bindAdvancedChannelPalette();
AnnotationAdapter.bindFloatingAiLabsPalette();
AnnotationAdapter.bindFloatingAdminPalette();
AnnotationAdapter.bindFloatingZStackPalette();
AnnotationAdapter.bindFloatingMeasurementPalette();
AnnotationAdapter.bindFloatingWandPalette();
AnnotationAdapter.installViewerToolAlias();
AnnotationAdapter.bindGlobalUiTooltip();
if (typeof document !== "undefined" && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        AnnotationAdapter.bindResetViewportHomeButton();
        AnnotationAdapter.bindAdvancedChannelPalette();
        AnnotationAdapter.bindFloatingAiLabsPalette();
        AnnotationAdapter.bindFloatingAdminPalette();
        AnnotationAdapter.bindFloatingZStackPalette();
        AnnotationAdapter.bindFloatingMeasurementPalette();
        AnnotationAdapter.bindFloatingWandPalette();
        AnnotationAdapter.ensureMeasurementPopupOverlay();
        AnnotationAdapter.ensureAnnotationEditorPopup();
        AnnotationAdapter.bindGlobalUiTooltip();
    });
} else if (typeof document !== "undefined") {
    AnnotationAdapter.bindAdvancedChannelPalette();
    AnnotationAdapter.bindFloatingAiLabsPalette();
    AnnotationAdapter.bindFloatingAdminPalette();
    AnnotationAdapter.bindFloatingZStackPalette();
    AnnotationAdapter.bindFloatingMeasurementPalette();
    AnnotationAdapter.bindFloatingWandPalette();
    AnnotationAdapter.ensureMeasurementPopupOverlay();
    AnnotationAdapter.ensureAnnotationEditorPopup();
    AnnotationAdapter.bindGlobalUiTooltip();
}
