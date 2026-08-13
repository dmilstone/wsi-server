(function (global) {
    "use strict";

    const DRAFT_KEY = "wsi.pilot-feedback.draft.v1";
    const SHORTCUT_KEY = "F";
    const SUBMIT_ENDPOINT = "/api/pilot-feedback";

    const TASKS = [
        {id: "find_open_image", label: "Find/open image"},
        {id: "switch_images", label: "Switch images"},
        {id: "pan_zoom", label: "Pan/zoom"},
        {id: "adjust_channels_display", label: "Adjust channels/display"},
        {id: "create_annotation", label: "Create annotation"},
        {id: "select_annotation", label: "Select annotation"},
        {id: "rename_annotation", label: "Rename annotation"},
        {id: "move_annotation", label: "Move annotation"},
        {id: "switch_away_return_persistence", label: "Switch away/return verify persistence"},
        {id: "show_hide_annotations", label: "Show/hide annotations"},
        {id: "show_hide_names", label: "Show/hide names"},
        {id: "export_visible_region", label: "Export visible region"},
        {id: "export_selected_annotation", label: "Export selected annotation"},
        {id: "slide_overview", label: "Slide overview"},
        {id: "full_screen", label: "Full Screen"},
        {id: "presentation_mode", label: "Presentation mode"},
        {id: "find_use_help", label: "Find/use Help"}
    ];

    const TASK_OPTIONS = [
        {value: "COMPLETED_EASILY", label: "Completed easily"},
        {value: "COMPLETED_WITH_DIFFICULTY", label: "Completed with difficulty"},
        {value: "COULD_NOT_COMPLETE", label: "Could not complete"},
        {value: "DID_NOT_TRY", label: "Did not try"}
    ];

    const ROLES = [
        {value: "", label: "— Optional —"},
        {value: "PATHOLOGIST", label: "Pathologist"},
        {value: "RESEARCHER", label: "Researcher"},
        {value: "TECHNOLOGIST", label: "Technologist"},
        {value: "TRAINEE", label: "Trainee"},
        {value: "OTHER", label: "Other"}
    ];

    const EXPERIENCE = [
        {value: "", label: "— Optional —"},
        {value: "NONE", label: "None"},
        {value: "LIMITED", label: "Limited"},
        {value: "MODERATE", label: "Moderate"},
        {value: "EXTENSIVE", label: "Extensive"}
    ];

    const RATINGS = [
        {id: "image_navigation", label: "Image navigation", low: "Very difficult", high: "Very easy"},
        {id: "image_switching", label: "Image switching", low: "Very difficult", high: "Very easy"},
        {id: "responsiveness", label: "Responsiveness", low: "Very slow", high: "Very fast"},
        {id: "channel_display_controls", label: "Channel/display controls", low: "Very confusing", high: "Very clear"},
        {id: "annotation_workflow", label: "Annotation workflow", low: "Very difficult", high: "Very easy"},
        {id: "toolbar_clarity", label: "Toolbar clarity", low: "Very unclear", high: "Very clear"},
        {id: "export_workflow", label: "Export workflow", low: "Very difficult", high: "Very easy"},
        {id: "overall_ease", label: "Overall ease of use", low: "Very difficult", high: "Very easy"},
        {id: "confidence_without_assistance", label: "Confidence using viewer without assistance", low: "Not confident", high: "Very confident"}
    ];

    const TEXT_FIELDS = [
        {id: "mostUseful", label: "Most useful aspect", maxLength: 2000},
        {id: "mostConfusing", label: "Most confusing aspect", maxLength: 2000},
        {id: "expectedMissing", label: "Anything expected but missing", maxLength: 2000},
        {id: "otherComments", label: "Other comments", maxLength: 2000}
    ];

    function isTypingTarget(element) {
        if (!element) return false;
        const tag = element.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable;
    }

    function shouldHandleShortcut(event) {
        if (event.defaultPrevented) return false;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
        if (isTypingTarget(document.activeElement)) return false;
        const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
        return key === SHORTCUT_KEY || event.key === "Escape";
    }

    function readDraft() {
        try {
            const raw = sessionStorage.getItem(DRAFT_KEY) || localStorage.getItem(DRAFT_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_error) {
            return null;
        }
    }

    function writeDraft(data) {
        const serialized = JSON.stringify(data);
        sessionStorage.setItem(DRAFT_KEY, serialized);
        localStorage.setItem(DRAFT_KEY, serialized);
    }

    function clearDraft() {
        sessionStorage.removeItem(DRAFT_KEY);
        localStorage.removeItem(DRAFT_KEY);
    }

    function collectForm(form) {
        const data = {
            evaluatorAlias: form.querySelector('[name="evaluatorAlias"]')?.value?.trim() || null,
            role: form.querySelector('[name="role"]')?.value || null,
            wsiExperience: form.querySelector('[name="wsiExperience"]')?.value || null,
            taskCompletion: {},
            ratings: {},
            mostUseful: null,
            mostConfusing: null,
            expectedMissing: null,
            otherComments: null
        };
        if (!data.role) data.role = null;
        if (!data.wsiExperience) data.wsiExperience = null;
        for (const task of TASKS) {
            const field = form.querySelector(`[name="task-${task.id}"]:checked`);
            if (field) data.taskCompletion[task.id] = field.value;
        }
        for (const rating of RATINGS) {
            const field = form.querySelector(`[name="rating-${rating.id}"]:checked`);
            if (field) data.ratings[rating.id] = Number(field.value);
        }
        for (const textField of TEXT_FIELDS) {
            const value = form.querySelector(`[name="${textField.id}"]`)?.value?.trim();
            data[textField.id] = value || null;
        }
        return data;
    }

    function restoreForm(form, draft) {
        if (!draft) return;
        const alias = form.querySelector('[name="evaluatorAlias"]');
        if (alias) alias.value = draft.evaluatorAlias || "";
        const role = form.querySelector('[name="role"]');
        if (role) role.value = draft.role || "";
        const experience = form.querySelector('[name="wsiExperience"]');
        if (experience) experience.value = draft.wsiExperience || "";
        for (const task of TASKS) {
            const value = draft.taskCompletion?.[task.id];
            if (!value) continue;
            const field = form.querySelector(`[name="task-${task.id}"][value="${value}"]`);
            if (field) field.checked = true;
        }
        for (const rating of RATINGS) {
            const value = draft.ratings?.[rating.id];
            if (!value) continue;
            const field = form.querySelector(`[name="rating-${rating.id}"][value="${String(value)}"]`);
            if (field) field.checked = true;
        }
        for (const textField of TEXT_FIELDS) {
            const field = form.querySelector(`[name="${textField.id}"]`);
            if (field) field.value = draft[textField.id] || "";
        }
    }

    function validateClient(data) {
        for (const task of TASKS) {
            if (!data.taskCompletion[task.id]) return `Select a completion response for ${task.label}.`;
        }
        for (const rating of RATINGS) {
            const value = data.ratings[rating.id];
            if (!value || value < 1 || value > 5) return `Select a rating for ${rating.label}.`;
        }
        for (const textField of TEXT_FIELDS) {
            const value = data[textField.id];
            if (value && value.length > textField.maxLength) {
                return `${textField.label} must be at most ${textField.maxLength} characters.`;
            }
        }
        if (data.evaluatorAlias && data.evaluatorAlias.length > 80) {
            return "Evaluator alias must be at most 80 characters.";
        }
        return null;
    }

    function renderFormMarkup(options = {}) {
        const compact = Boolean(options.compact);
        const showReturnLinks = options.showReturnLinks !== false;
        const shortcutNote = `Keyboard shortcut: ${SHORTCUT_KEY} toggles this panel from the viewer.`;
        const taskRows = TASKS.map(task => `
            <fieldset class="pilot-task-fieldset">
                <legend>${task.label}</legend>
                <div class="pilot-option-row">${TASK_OPTIONS.map(option => `
                    <label class="pilot-option"><input type="radio" name="task-${task.id}" value="${option.value}"> ${option.label}</label>
                `).join("")}</div>
            </fieldset>`).join("");
        const ratingRows = RATINGS.map(rating => `
            <fieldset class="pilot-rating-fieldset">
                <legend>${rating.label}</legend>
                <div class="pilot-rating-scale" aria-label="${rating.label} rating from 1 to 5">
                    <span class="pilot-scale-end">${rating.low}</span>
                    ${[1, 2, 3, 4, 5].map(value => `
                        <label class="pilot-rating-option"><input type="radio" name="rating-${rating.id}" value="${value}"><span>${value}</span></label>
                    `).join("")}
                    <span class="pilot-scale-end">${rating.high}</span>
                </div>
            </fieldset>`).join("");
        const textRows = TEXT_FIELDS.map(field => `
            <label class="pilot-text-field">
                <span>${field.label}</span>
                <textarea name="${field.id}" rows="${compact ? 2 : 3}" maxlength="${field.maxLength}"></textarea>
            </label>`).join("");

        return `
            <form id="pilot-feedback-form" class="pilot-feedback-form${compact ? " compact" : ""}" novalidate>
                <div class="pilot-feedback-notice" role="note">
                    <strong>Privacy notice:</strong> Do not enter patient identifiers, PHI, or other sensitive clinical information.
                    Submissions record your authenticated account, a random browser/profile identifier, submission time,
                    browser information, and network address. These fields support pilot analysis but do not precisely identify a person.
                </div>
                <p class="pilot-feedback-meta">${shortcutNote}</p>
                ${showReturnLinks ? `<div class="pilot-feedback-nav"><a href="/">Return to Viewer</a>${compact ? `<a href="/pilot-feedback">Open full-page form</a>` : ""}</div>` : ""}
                <section class="pilot-section" aria-labelledby="pilot-profile-heading">
                    <h3 id="pilot-profile-heading">Optional profile</h3>
                    <label class="pilot-text-field"><span>Evaluator alias/code</span><input type="text" name="evaluatorAlias" maxlength="80" autocomplete="off"></label>
                    <label class="pilot-select-field"><span>Role</span><select name="role">${ROLES.map(role => `<option value="${role.value}">${role.label}</option>`).join("")}</select></label>
                    <label class="pilot-select-field"><span>WSI experience</span><select name="wsiExperience">${EXPERIENCE.map(item => `<option value="${item.value}">${item.label}</option>`).join("")}</select></label>
                </section>
                <section class="pilot-section" aria-labelledby="pilot-task-heading">
                    <h3 id="pilot-task-heading">Task completion</h3>
                    ${taskRows}
                </section>
                <section class="pilot-section" aria-labelledby="pilot-rating-heading">
                    <h3 id="pilot-rating-heading">Ratings (1 = low end, 5 = high end)</h3>
                    ${ratingRows}
                </section>
                <section class="pilot-section" aria-labelledby="pilot-text-heading">
                    <h3 id="pilot-text-heading">Comments</h3>
                    ${textRows}
                </section>
                <div class="pilot-feedback-actions">
                    <button type="submit" class="pilot-primary">Submit feedback</button>
                    <button type="button" class="pilot-secondary" data-action="clear-draft">Clear draft</button>
                    ${showReturnLinks ? `<a class="pilot-secondary-link" href="/">Return to Viewer</a>` : ""}
                </div>
                <p id="pilot-feedback-status" class="pilot-feedback-status" role="status" aria-live="polite"></p>
            </form>`;
    }

    function bindForm(root, options = {}) {
        const form = root.querySelector("#pilot-feedback-form");
        if (!form) return null;
        const status = form.querySelector("#pilot-feedback-status");
        restoreForm(form, readDraft());

        const persistDraft = () => writeDraft(collectForm(form));
        form.addEventListener("input", persistDraft);
        form.addEventListener("change", persistDraft);

        form.querySelector('[data-action="clear-draft"]')?.addEventListener("click", () => {
            form.reset();
            clearDraft();
            if (status) status.textContent = "Draft cleared.";
        });

        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const payload = collectForm(form);
            const validationError = validateClient(payload);
            if (validationError) {
                if (status) status.textContent = validationError;
                return;
            }
            if (status) status.textContent = "Submitting…";
            try {
                await global.WsiCsrf.initialize();
                const response = await global.WsiCsrf.csrfFetch(SUBMIT_ENDPOINT, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify(payload)
                });
                const body = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(body.detail || body.title || `${response.status} ${response.statusText}`);
                }
                clearDraft();
                form.reset();
                if (status) status.textContent = body.message || "Pilot feedback submitted. Thank you.";
                options.onSubmitted?.(body);
            } catch (error) {
                if (status) status.textContent = error.message || "Submission failed.";
            }
        });
        return form;
    }

    function mountForm(root, options = {}) {
        root.innerHTML = renderFormMarkup(options);
        return bindForm(root, options);
    }

    global.WsiPilotFeedback = {
        DRAFT_KEY,
        SHORTCUT_KEY,
        TASKS,
        RATINGS,
        shouldHandleShortcut,
        readDraft,
        writeDraft,
        clearDraft,
        collectForm,
        restoreForm,
        validateClient,
        renderFormMarkup,
        bindForm,
        mountForm
    };
})(window);
