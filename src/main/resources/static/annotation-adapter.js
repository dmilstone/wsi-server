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
    static slideLabelThumbsEnabled = false;
    /** Invalidates in-flight sidebar OCR when the case list is rebuilt. */
    static sidebarOcrBatchGeneration = 0;
    static slideLabelThumbGeneration = 0;
    static sidebarOcrInFlight = typeof Set !== "undefined" ? new Set() : null;

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
        const aiPanel = root.getElementById("ai-analytics-panel");
        if (aiPanel) aiPanel.hidden = true;
        AnnotationAdapter.clearAiNucleiOverlay({ remove: true });
        AnnotationAdapter.setAiStatus("AI Pipeline: Idle", root);

        const measureList = root.getElementById("measure-session-list");
        if (measureList) measureList.replaceChildren();
        AnnotationAdapter.measurementSessionList = [];
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
        return `/api/images/${encodeURIComponent(imageId)}/label.png`;
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
        for (const button of scope.querySelectorAll(".image-button")) {
            button.classList.remove("has-slide-label-thumb");
        }
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

                wrap.append(thumb);
                slot.append(wrap, rotate);
                AnnotationAdapter.ensureRowOcrScanButton(slot, button, doc);
                const ocrRow = button.querySelector(".ocr-result-text");
                if (ocrRow) ocrRow.after(slot);
                else button.append(slot);
                AnnotationAdapter.applySlideLabelThumbRotation(
                    wrap,
                    AnnotationAdapter.getSlideLabelRotation(imageId)
                );
            } else {
                const legacyScan = slot.querySelector(":scope > .ocr-test-btn");
                if (legacyScan) legacyScan.remove();
                AnnotationAdapter.ensureRowOcrScanButton(slot, button, doc);
                AnnotationAdapter.applySlideLabelThumbRotation(
                    wrap,
                    AnnotationAdapter.getSlideLabelRotation(imageId)
                );
            }

            const thumb = wrap.querySelector(".slide-label-thumb");
            if (!thumb) continue;
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
            if (thumb.src !== url) thumb.src = url;
            if (thumb.complete && (thumb.naturalWidth || 0) > 0) {
                AnnotationAdapter.revealSlideLabelThumb(button, slot, wrap, thumb);
            }
        }
        return generation;
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
        return match ? match[0] : "";
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
    static clearAllOcrResultText(root = null, options = {}) {
        const includeSidebar = options.includeSidebar === true;
        const scope = root
            || (typeof document !== "undefined" ? document : null);
        if (!scope?.querySelectorAll) return;
        for (const node of scope.querySelectorAll(".ocr-result-text")) {
            if (!includeSidebar && node.closest?.(".image-button")) continue;
            node.textContent = "";
            if (typeof node.classList?.remove === "function") {
                node.classList.remove("ocr-result-pending");
                node.classList.remove("ocr-result-raw");
            }
        }
    }

    /**
     * Place a permanent compressed {@code if.<epitope>} row under the filename.
     */
    static renderOcrClinicalMarker(targetNode, text) {
        if (!targetNode) return;
        const marker = AnnotationAdapter.extractIfEpitopeMarker(text);
        targetNode.hidden = false;
        if (typeof targetNode.classList?.remove === "function") {
            targetNode.classList.remove("ocr-result-pending");
            targetNode.classList.remove("ocr-result-raw");
        }
        targetNode.textContent = marker;
        AnnotationAdapter.enableOcrResultTextSelection(targetNode);
    }

    /** Miss path: show unfiltered Tesseract text so the angle can be diagnosed. */
    static renderOcrRawDebug(targetNode, rawText) {
        if (!targetNode) return;
        const flat = AnnotationAdapter.flattenRawOcrText(rawText) || "(empty)";
        targetNode.hidden = false;
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
        targetNode.hidden = false;
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
    static ensureRowOcrScanButton(slot, rowButton, doc) {
        if (!slot || !doc) return null;
        let scan = slot.querySelector(":scope > .ocr-row-scan-btn");
        if (scan) return scan;
        scan = doc.createElement("button");
        scan.type = "button";
        scan.className = "ocr-row-scan-btn";
        scan.title = "Force OCR Scan";
        scan.setAttribute("aria-label", "Force OCR Scan");
        scan.textContent = "🔍 Scan";
        scan.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            const degrees = AnnotationAdapter.readRowLabelRotation(rowButton);
            void AnnotationAdapter.runManualRowOcrScan(rowButton, scan, degrees);
        });
        slot.append(scan);
        return scan;
    }

    /**
     * Manual row OCR at the on-screen rotation. Marker hits lock into
     * {@link OcrSessionCache}; misses dump flattened raw Tesseract text.
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
        AnnotationAdapter.beginOcrPendingDisplay(targetNode);
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
            AnnotationAdapter.renderOcrRawDebug(targetNode, raw);
            return "";
        } catch (error) {
            console.error("[wsi-ocr] manual rotation-synced scan failed", cacheKey, error);
            AnnotationAdapter.renderOcrRawDebug(targetNode, String(error?.message || error || ""));
            return "";
        } finally {
            if (scanBtn) {
                scanBtn.disabled = false;
                scanBtn.removeAttribute("aria-busy");
            }
        }
    }

    static ensureSidebarOcrResultNode(button, doc) {
        if (!button || !doc) return null;
        let result = button.querySelector(".ocr-result-text");
        if (result) {
            AnnotationAdapter.enableOcrResultTextSelection(result);
            return result;
        }
        result = doc.createElement("span");
        result.className = "ocr-result-text";
        result.textContent = "";
        const label = button.querySelector(".image-button-label");
        if (label) label.after(result);
        else button.append(result);
        AnnotationAdapter.enableOcrResultTextSelection(result);
        return result;
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
     * Catalog marker only — never cache empty values here (empty must stay
     * eligible for browser-tier OCR fallback).
     */
    static clinicalMarkerFromImage(image) {
        if (!image || typeof image !== "object") return "";
        const fromApi = AnnotationAdapter.extractIfEpitopeMarker(
            image.clinicalMarker || image.clinical_marker || ""
        );
        const cacheKey = AnnotationAdapter.sidebarOcrCacheKey(image);
        if (fromApi) {
            AnnotationAdapter.writeOcrSessionCache(cacheKey, fromApi);
            return fromApi;
        }
        if (AnnotationAdapter.hasOcrSessionCacheEntry(cacheKey)) {
            return AnnotationAdapter.readOcrSessionCache(cacheKey) || "";
        }
        return "";
    }

    /**
     * Hybrid catalog loop: paint backend markers instantly; queue browser OCR
     * for any row still missing a marker (safe-catch for legacy inventory).
     */
    static applyCatalogClinicalMarkers(container, images = [], options = {}) {
        if (!container || typeof container.querySelectorAll !== "function") return 0;
        const doc = typeof document !== "undefined" ? document : null;
        // Browser fallback is the default safe-catch; callers may opt out.
        const allowBrowserFallback = options.allowBrowserFallback !== false;
        const byId = new Map();
        for (const image of Array.isArray(images) ? images : []) {
            const key = AnnotationAdapter.sidebarOcrCacheKey(image);
            if (!key) continue;
            byId.set(key, AnnotationAdapter.clinicalMarkerFromImage(image));
        }
        const missing = [];
        let painted = 0;
        for (const button of container.querySelectorAll(".image-button")) {
            const key = AnnotationAdapter.sidebarOcrCacheKey(button);
            const targetNode = AnnotationAdapter.ensureSidebarOcrResultNode(button, doc)
                || button.querySelector(".ocr-result-text");
            if (!targetNode) continue;
            const existing = AnnotationAdapter.extractIfEpitopeMarker(targetNode.textContent || "");
            let marker = "";
            if (byId.has(key) && byId.get(key)) marker = byId.get(key);
            else if (existing) marker = existing;
            else if (AnnotationAdapter.hasOcrSessionCacheEntry(key)) {
                marker = AnnotationAdapter.readOcrSessionCache(key) || "";
            }
            if (marker) {
                AnnotationAdapter.renderOcrClinicalMarker(targetNode, marker);
            } else if (targetNode.classList?.contains?.("ocr-result-raw")) {
                // Keep manual-scan RAW debug until a real marker arrives.
            } else if (AnnotationAdapter.hasOcrSessionCacheEntry(key)) {
                // Already scanned this session — keep the compact row, no retry loop.
                if (!existing) AnnotationAdapter.renderOcrClinicalMarker(targetNode, "");
            } else if (allowBrowserFallback) {
                if (!targetNode.classList?.contains?.("ocr-result-pending")) {
                    AnnotationAdapter.beginOcrPendingDisplay(targetNode);
                }
                missing.push(button);
            } else if (!existing) {
                AnnotationAdapter.renderOcrClinicalMarker(targetNode, "");
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
        const generation = AnnotationAdapter.sidebarOcrBatchGeneration;
        const inFlight = AnnotationAdapter.sidebarOcrInFlight;
        const doc = typeof document !== "undefined" ? document : null;
        const list = Array.isArray(buttons) ? buttons : [];
        for (const button of list) {
            if (generation !== AnnotationAdapter.sidebarOcrBatchGeneration) return;
            const cacheKey = AnnotationAdapter.sidebarOcrCacheKey(button);
            const targetNode = AnnotationAdapter.ensureSidebarOcrResultNode(button, doc)
                || button.querySelector(".ocr-result-text");
            if (!targetNode || !cacheKey) continue;
            if (AnnotationAdapter.hasOcrSessionCacheEntry(cacheKey)) {
                AnnotationAdapter.renderOcrClinicalMarker(
                    targetNode,
                    AnnotationAdapter.readOcrSessionCache(cacheKey)
                );
                continue;
            }
            if (inFlight?.has?.(cacheKey)) continue;
            if (typeof Tesseract === "undefined" || typeof Tesseract.recognize !== "function") {
                AnnotationAdapter.writeOcrSessionCache(cacheKey, "");
                AnnotationAdapter.renderOcrClinicalMarker(targetNode, "");
                continue;
            }
            if (!targetNode.classList?.contains?.("ocr-result-pending")) {
                AnnotationAdapter.beginOcrPendingDisplay(targetNode);
            }
            const thumb = button.querySelector?.(".slide-label-thumb");
            const source = (thumb && thumb.src)
                ? thumb
                : AnnotationAdapter.slideLabelFullResUrl(cacheKey);
            if (!source) {
                AnnotationAdapter.writeOcrSessionCache(cacheKey, "");
                AnnotationAdapter.renderOcrClinicalMarker(targetNode, "");
                continue;
            }
            inFlight?.add?.(cacheKey);
            try {
                const result = await AnnotationAdapter.recognizeLabelImage(source);
                if (generation !== AnnotationAdapter.sidebarOcrBatchGeneration) return;
                const marker = AnnotationAdapter.extractIfEpitopeMarker(
                    result?.marker || result?.rawText || result?.text || ""
                );
                AnnotationAdapter.writeOcrSessionCache(cacheKey, marker);
                AnnotationAdapter.renderOcrClinicalMarker(targetNode, marker);
            } catch (error) {
                if (generation !== AnnotationAdapter.sidebarOcrBatchGeneration) return;
                console.error("[wsi-ocr] browser Tesseract fallback failed", cacheKey, error);
                AnnotationAdapter.writeOcrSessionCache(cacheKey, "");
                AnnotationAdapter.renderOcrClinicalMarker(targetNode, "");
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
        AnnotationAdapter.renderOcrClinicalMarker(
            controls.result,
            AnnotationAdapter.clinicalMarkerFromImage(image)
        );
    }

    /**
     * Multi-plane Z stack: world item index == focal plane index.
     * Active plane opacity 1; all others opacity 0 with preload so tiles stay warm.
     */
    static zStackPlaneCount = 0;
    static zStackActiveIndex = 0;

    static applyZStackLayerOpacities(viewer, activeZ) {
        if (!viewer?.world || typeof viewer.world.getItemCount !== "function") return 0;
        const count = viewer.world.getItemCount();
        const active = Math.max(0, Number(activeZ) || 0);
        AnnotationAdapter.zStackActiveIndex = active;
        AnnotationAdapter.zStackPlaneCount = count;
        for (let index = 0; index < count; index += 1) {
            const item = viewer.world.getItemAt(index);
            if (!item || typeof item.setOpacity !== "function") continue;
            item.setOpacity(index === active ? 1 : 0);
        }
        if (typeof viewer.forceRedraw === "function") viewer.forceRedraw();
        return count;
    }

    /**
     * Open plane 0, then addTiledImage for every remaining Z with preload:true.
     * Depth changes later only flip opacities — never reopen the viewer.
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

        const firstSource = build(0);
        viewer.open({
            tileSource: firstSource,
            opacity: activeZ === 0 ? 1 : 0,
            preload: true
        });

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

            if (planeCount <= 1) {
                AnnotationAdapter.applyZStackLayerOpacities(viewer, activeZ);
                if (typeof options.onReady === "function") options.onReady(viewer);
                return;
            }

            let remaining = planeCount - 1;
            const finishOne = () => {
                remaining -= 1;
                if (remaining > 0) return;
                AnnotationAdapter.applyZStackLayerOpacities(viewer, activeZ);
                if (typeof options.onReady === "function") options.onReady(viewer);
            };

            for (let z = 1; z < planeCount; z += 1) {
                viewer.addTiledImage({
                    tileSource: build(z),
                    opacity: z === activeZ ? 1 : 0,
                    preload: true,
                    success: finishOne,
                    error: finishOne
                });
            }
        });
        return true;
    }

    /**
     * Focal depth via Alt+wheel or ArrowUp/ArrowDown only.
     * Does not bind a canvas wheel interceptor — native OSD scroll-zoom stays free.
     */
    static bindZStackWheel(viewer, hooks = {}) {
        if (!viewer || viewer._wsiZStackFocalBound) return false;

        if (viewer.gestureSettingsMouse) {
            viewer.gestureSettingsMouse.scrollToZoom = true;
        }

        const resolveMaxZ = () => Math.max(0, Number(
            typeof hooks.getMaxZ === "function" ? hooks.getMaxZ() : 0
        ) || 0);

        const resolveCurrentZ = () => Math.max(0, Number(
            typeof hooks.getZ === "function"
                ? hooks.getZ()
                : AnnotationAdapter.zStackActiveIndex
        ) || 0);

        const applyDelta = delta => {
            const maxZ = resolveMaxZ();
            if (maxZ < 1 || !delta) return false;
            if (AnnotationAdapter.isMeasurementModeActive) return false;
            const current = resolveCurrentZ();
            const next = Math.max(0, Math.min(maxZ, current + delta));
            if (next === current) return false;
            if (typeof hooks.onZChange === "function") hooks.onZChange(next);
            else AnnotationAdapter.applyZStackLayerOpacities(viewer, next);
            return true;
        };

        const onCanvasScroll = event => {
            const original = event?.originalEvent;
            if (!original?.altKey) return;
            const maxZ = resolveMaxZ();
            if (maxZ < 1) return;
            if (AnnotationAdapter.isMeasurementModeActive) return;
            event.preventDefaultAction = true;
            if (typeof original.preventDefault === "function") original.preventDefault();
            const deltaY = Number(original.deltaY);
            const scroll = Number(event.scroll);
            const delta = Number.isFinite(deltaY) && deltaY !== 0
                ? (deltaY > 0 ? 1 : -1)
                : (Number.isFinite(scroll) && scroll !== 0 ? (scroll > 0 ? -1 : 1) : 0);
            applyDelta(delta);
        };

        const onKeyDown = event => {
            if (event.altKey || event.metaKey || event.ctrlKey) return;
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            const target = event.target;
            if (target && (
                target.tagName === "INPUT"
                || target.tagName === "TEXTAREA"
                || target.tagName === "SELECT"
                || target.isContentEditable
            )) return;
            const maxZ = resolveMaxZ();
            if (maxZ < 1) return;
            if (AnnotationAdapter.isMeasurementModeActive) return;
            event.preventDefault();
            const delta = event.key === "ArrowUp" ? -1 : 1;
            applyDelta(delta);
        };

        if (typeof viewer.addHandler === "function") {
            viewer.addHandler("canvas-scroll", onCanvasScroll);
        }
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            window.addEventListener("keydown", onKeyDown);
            viewer._wsiZStackKeyHandler = onKeyDown;
        }
        viewer._wsiZStackFocalBound = true;
        return true;
    }

    /** Quietly pre-load adjacent Z-plane tiles — superseded by opacity stack preload. */
    static zTilePrefetchUrls = typeof Set !== "undefined" ? new Set() : null;
    static zTilePrefetchImageId = null;
    static zTilePrefetchTimer = null;
    static Z_TILE_PREFETCH_PAUSE_MS = 120;

    static resetZTilePrefetchCache(imageId = null) {
        if (AnnotationAdapter.zTilePrefetchTimer != null) {
            clearTimeout(AnnotationAdapter.zTilePrefetchTimer);
            AnnotationAdapter.zTilePrefetchTimer = null;
        }
        if (AnnotationAdapter.zTilePrefetchUrls?.clear) {
            AnnotationAdapter.zTilePrefetchUrls.clear();
        }
        AnnotationAdapter.zTilePrefetchImageId = imageId || null;
    }

    static prefetchTileUrl(_url) {
        // No-op: multi-plane opacity stack preloads via OSD tiled images.
    }

    static prefetchAdjacentZPlaneTiles(options = {}) {
        const viewer = options.viewer || AnnotationAdapter.viewer;
        if (!viewer?.world) return 0;
        // Keep active plane opaque; neighbors already preloaded at opacity 0.
        return AnnotationAdapter.applyZStackLayerOpacities(
            viewer,
            options.z ?? AnnotationAdapter.currentZ
        );
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
            // Hybrid OCR: catalog markers first, browser Tesseract for gaps.
            AnnotationAdapter.applyCatalogClinicalMarkers(scope, [], {
                allowBrowserFallback: true
            });
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
                const button = doc.createElement("button");
                button.type = "button";
                button.className = "image-button image-button-flat";
                button.dataset.imageId = image.id;
                button.dataset.imageName = image.name || "";
                button.dataset.imagePath = image.relativePath || "";
                button.dataset.slideLabel = title;
                const label = doc.createElement("span");
                label.className = "image-button-label";
                label.textContent = title;
                button.append(label);
                AnnotationAdapter.ensureSidebarOcrResultNode(button, doc);
                button.title = image.relativePath || image.name || "";
                button.addEventListener("click", () => onSelect(image));
                container.append(button);
            }
            // Thumbs optional; catalog markers always; browser OCR fills gaps.
            if (AnnotationAdapter.slideLabelThumbsEnabled) {
                AnnotationAdapter.loadSlideLabelThumbs(container);
            }
            AnnotationAdapter.applyCatalogClinicalMarkers(container, matched, {
                allowBrowserFallback: true
            });
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
                const button = doc.createElement("button");
                button.type = "button";
                button.className = "image-button";
                button.dataset.imageId = image.id;
                button.dataset.imageName = image.name || "";
                button.dataset.imagePath = image.relativePath || "";
                const label = doc.createElement("span");
                label.className = "image-button-label";
                label.textContent = title;
                button.title = image.relativePath || image.name || "";
                button.append(label);
                AnnotationAdapter.ensureSidebarOcrResultNode(button, doc);
                button.addEventListener("click", () => onSelect(image));
                contents.append(button);
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
        // Catalog markers for the full inventory; skip browser OCR spam on All Slides.
        AnnotationAdapter.applyCatalogClinicalMarkers(container, list, {
            allowBrowserFallback: false
        });
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
        if (AnnotationAdapter.viewer) {
            AnnotationAdapter.bindAiVectorOverlayHandlers(AnnotationAdapter.viewer);
        }
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
        const doc = (typeof document !== "undefined") ? document : null;
        if (doc && typeof doc.createElementNS === "function") {
            return doc.createElementNS("http://www.w3.org/2000/svg", name);
        }
        const node = {
            attrs: Object.create(null),
            style: {},
            setAttribute(key, value) { this.attrs[key] = String(value); }
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

    static AI_STATUS_IDLE = "AI Pipeline: Idle";
    static AI_STATUS_EXTRACTING = "AI Pipeline: Extracting canvas pixels...";
    static AI_NUCLEI_STROKE = "#39FF14";
    static AI_DEFAULT_PROBABILITY = 0.5;
    static AI_DEFAULT_NMS = 0.4;
    static AI_HIGH_DENSITY_PROB_DELTA = 0.15;
    static AI_HIGH_DENSITY_NMS_DELTA = 0.15;
    static AI_HIGH_DENSITY_VARIANCE_LIMIT = 0.045;
    static AI_HIGH_DENSITY_TILE_FRACTION = 0.42;
    static aiNucleiOverlayEl = null;
    static aiOverlayVisible = true;
    static aiBaselineProbability = 0.5;
    static aiBaselineNms = 0.4;
    static AI_VECTOR_OVERLAY_ID = "ai-vector-overlay-layer";

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
        const channel = options.channel ?? channelEl?.value ?? "default";
        const probability = AnnotationAdapter.clampAiParam(
            options.probability ?? options.probabilityThreshold ?? probEl?.value,
            AnnotationAdapter.AI_DEFAULT_PROBABILITY
        );
        const nms = AnnotationAdapter.clampAiParam(
            options.nms ?? options.overlapSuppression ?? nmsEl?.value,
            AnnotationAdapter.AI_DEFAULT_NMS
        );
        const overlayVisible = options.overlayVisible ?? (overlayEl ? overlayEl.checked !== false : AnnotationAdapter.aiOverlayVisible);
        return { channel, probability, nms, overlayVisible, channelEl, probEl, nmsEl, overlayEl };
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
        const markup = '<div style="margin-top: 10px; display: flex; gap: 5px;">'
            + '<button id="ai-reset-baseline-btn" style="font-size: 0.8rem; background-color: #445566; color: #ffffff; border: 1px solid #667788; padding: 4px 8px; cursor: pointer; border-radius: 3px;">↺ Reset to Auto-Tuned Baseline</button>'
            + "</div>";
        if (typeof stack.insertAdjacentHTML === "function") {
            stack.insertAdjacentHTML("beforeend", markup);
        } else if (typeof stack.appendChild === "function" && typeof host.createElement === "function") {
            const wrap = host.createElement("div");
            wrap.style.cssText = "margin-top: 10px; display: flex; gap: 5px;";
            const button = host.createElement("button");
            button.id = "ai-reset-baseline-btn";
            button.style.cssText = "font-size: 0.8rem; background-color: #445566; color: #ffffff; border: 1px solid #667788; padding: 4px 8px; cursor: pointer; border-radius: 3px;";
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
        const toggle = host.getElementById("ai-overlay-visible");
        if (toggle && typeof toggle.addEventListener === "function" && toggle.dataset?.aiBound !== "1") {
            toggle.addEventListener("change", () => {
                AnnotationAdapter.setAiOverlayVisible(!!toggle.checked);
            });
            if (toggle.dataset) toggle.dataset.aiBound = "1";
            AnnotationAdapter.aiOverlayVisible = toggle.checked !== false;
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
        AnnotationAdapter.aiOverlayVisible = !!visible;
        const overlay = AnnotationAdapter.aiNucleiOverlayEl;
        if (overlay && overlay.style) overlay.style.display = visible ? "block" : "none";
        if (visible) AnnotationAdapter.renderSynchronizedCellObjects();
        return AnnotationAdapter.aiOverlayVisible;
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
        if (pixels && gray.length) {
            for (let i = 0, p = 0; i < pixels.length && p < gray.length; i += 4, p += 1) {
                if (channel === 1) {
                    gray[p] = pixels[i + 2] / 255;
                } else if (channel === 2) {
                    gray[p] = pixels[i + 1] / 255;
                } else if (channel === 3) {
                    gray[p] = pixels[i] / 255;
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
            if (viewer.world?.getItemCount?.() > 0) {
                return viewer.world.getItemAt(0).viewportToImageCoordinates(viewportPoint);
            }
            if (typeof vp.viewportToImageCoordinates === "function") {
                return vp.viewportToImageCoordinates(viewportPoint);
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
        if (typeof vp.imageToViewportCoordinates === "function") {
            try {
                viewportPoint = vp.imageToViewportCoordinates(x, y) || viewportPoint;
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
        if (remove) localizedCellObjects = [];
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

    static async segmentCellNuclei(options = {}) {
        try {
            const root = options.root || options.document || (typeof document !== "undefined" ? document : null);
            const config = AnnotationAdapter.readAiLabConfig(root, options);
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
                return { count: 0, nuclei: [] };
            }
            const payload = AnnotationAdapter.imageDataToNormalizedFloat32(captured.imageData, {
                channel: config.channel
            });
            const density = AnnotationAdapter.scanChannelDensity(
                payload.gray,
                payload.width,
                payload.height
            );
            let probability = config.probability;
            let nms = config.nms;
            let autoTuned = false;
            if (density.highDensity && !options.skipAutoTune) {
                const tuned = AnnotationAdapter.autoTuneDenseTissue(probability, nms);
                probability = tuned.probability;
                nms = tuned.nms;
                autoTuned = true;
                ocrAutoBaseline.prob = probability;
                ocrAutoBaseline.nms = nms;
                AnnotationAdapter.writeAiLabSlider(config.probEl, probability, "ai-prob-threshold-value", root);
                AnnotationAdapter.writeAiLabSlider(config.nmsEl, nms, "ai-nms-threshold-value", root);
                AnnotationAdapter.setAiStatus(
                    `[AI Status: High-Density Tissue Detected. Auto-tuned parameters: Prob=${probability.toFixed(2)}, NMS=${nms.toFixed(2)}]`,
                    root
                );
            }
            const magnitude = AnnotationAdapter.sobelMagnitude(payload.gray, payload.width, payload.height);
            const localized = AnnotationAdapter.localizeNucleiFromEdges(
                magnitude,
                payload.width,
                payload.height,
                { ...options, probability, nms }
            );
            const nuclei = AnnotationAdapter.attachNucleiImageCoordinates(
                AnnotationAdapter.suppressOverlappingNuclei(localized, nms),
                captured.canvas,
                options.viewer || AnnotationAdapter.viewer
            );
            AnnotationAdapter.rememberAiBaseline(probability, nms);
            const objects = AnnotationAdapter.replaceLocalizedCellObjects(
                AnnotationAdapter.nucleiToLocalizedCellObjects(nuclei)
            );
            if (options.viewer || options.overlayHost || options.overlayCanvas || AnnotationAdapter.viewer) {
                AnnotationAdapter.registerAiVectorOverlay(options.viewer || AnnotationAdapter.viewer, {
                    viewer: options.viewer,
                    canvas: options.overlayCanvas,
                    root,
                    overlayVisible: config.overlayVisible
                });
                AnnotationAdapter.renderSynchronizedCellObjects(options.viewer || AnnotationAdapter.viewer);
            }
            if (payload.tensor && typeof payload.tensor.dispose === "function") {
                payload.tensor.dispose();
            }
            const status = autoTuned
                ? `[AI Status: High-Density Tissue Detected. Auto-tuned parameters: Prob=${probability.toFixed(2)}, NMS=${nms.toFixed(2)}]`
                : `AI Pipeline: Successfully localized ${nuclei.length} cellular nuclei coordinates!`;
            AnnotationAdapter.setAiStatus(status, root);
            return {
                count: nuclei.length,
                nuclei,
                objects,
                localizedCellObjects: objects,
                status,
                autoTuned,
                probability,
                nms,
                density
            };
        } catch (error) {
            const root = options.root || options.document || (typeof document !== "undefined" ? document : null);
            AnnotationAdapter.setAiStatus(`AI Pipeline: ${error?.message || "analysis failed"}`, root);
            return { count: 0, nuclei: [], error };
        }
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

// Cold-start / cleared-storage defaults for measurement state.
AnnotationAdapter.ensureMeasurementDefaults();
AnnotationAdapter.scheduleAiMlBackendInit();
