(function (root) {
    "use strict";

    const STORAGE_KEY = "wsi.pilot-feedback.drafts";

    function isEditableTarget(target) {
        if (!target) return false;
        const tag = String(target.tagName || "").toUpperCase();
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(target.isContentEditable);
    }

    function readDrafts() {
        try {
            const raw = root.localStorage ? root.localStorage.getItem(STORAGE_KEY) : "[]";
            const parsed = JSON.parse(raw || "[]");
            return Array.isArray(parsed) ? parsed : [];
        } catch (_error) {
            return [];
        }
    }

    function writeDrafts(drafts) {
        try {
            if (root.localStorage) {
                root.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts.slice(-40)));
            }
        } catch (_error) {
            // Ignore quota / private-mode failures.
        }
    }

    function field(doc, name, label, type) {
        const wrap = doc.createElement("label");
        wrap.className = "wsi-pilot-field";
        const title = doc.createElement("span");
        title.textContent = label;
        let input;
        if (type === "textarea") {
            input = doc.createElement("textarea");
            input.rows = 5;
        } else if (type === "select") {
            input = doc.createElement("select");
            for (const option of ["Issue", "Usability", "Performance", "Documentation", "Other"]) {
                const opt = doc.createElement("option");
                opt.value = option;
                opt.textContent = option;
                input.append(opt);
            }
        } else {
            input = doc.createElement("input");
            input.type = type || "text";
        }
        input.name = name;
        wrap.append(title, input);
        return { wrap, input };
    }

    const WsiPilotFeedback = {
        SHORTCUT_KEY: "F",

        // Ctrl+Shift+F exactly (no Alt/Meta). Plain "F" and Shift+F are reserved for the
        // detection/annotation fill toggles in annotation-adapter.js (toggleDetectionFill /
        // toggleAnnotationFill), so this shortcut moved to a modifier combo those never use.
        shouldHandleShortcut(event) {
            if (!event || event.altKey || event.metaKey) return false;
            if (!event.ctrlKey || !event.shiftKey) return false;
            if (isEditableTarget(event.target)) return false;
            return String(event.key || "").toUpperCase() === WsiPilotFeedback.SHORTCUT_KEY;
        },

        mountForm(container, options = {}) {
            if (!container) return null;
            const doc = container.ownerDocument || root.document;
            if (!doc) return null;
            container.replaceChildren();
            const form = doc.createElement("form");
            form.className = "wsi-pilot-form" + (options.compact ? " is-compact" : "");
            form.setAttribute("novalidate", "novalidate");

            const note = doc.createElement("p");
            note.className = "wsi-pilot-note";
            note.textContent = "Stored on this workstation only. Do not include protected health information.";
            form.append(note);

            const category = field(doc, "category", "Category", "select");
            const summary = field(doc, "summary", "Summary", "text");
            const details = field(doc, "details", "What happened", "textarea");
            const imageName = field(doc, "imageName", "Image name (optional)", "text");
            form.append(category.wrap, summary.wrap, details.wrap, imageName.wrap);

            const status = doc.createElement("p");
            status.className = "wsi-pilot-status";
            status.setAttribute("role", "status");

            const actions = doc.createElement("div");
            actions.className = "wsi-pilot-actions";
            const submit = doc.createElement("button");
            submit.type = "submit";
            submit.textContent = "Save locally";
            actions.append(submit);

            if (options.showReturnLinks) {
                const full = doc.createElement("a");
                full.href = "/pilot-feedback/";
                full.textContent = "Open full page";
                actions.append(full);
            }

            form.append(actions, status);
            form.addEventListener("submit", event => {
                event.preventDefault();
                const record = {
                    at: new Date().toISOString(),
                    category: category.input.value,
                    summary: String(summary.input.value || "").trim(),
                    details: String(details.input.value || "").trim(),
                    imageName: String(imageName.input.value || "").trim()
                };
                if (!record.summary) {
                    status.textContent = "Add a short summary before saving.";
                    summary.input.focus();
                    return;
                }
                const drafts = readDrafts();
                drafts.push(record);
                writeDrafts(drafts);
                form.reset();
                status.textContent = "Saved on this workstation.";
            });
            container.append(form);
            return form;
        }
    };

    root.WsiPilotFeedback = WsiPilotFeedback;
}(typeof window !== "undefined" ? window : globalThis));
