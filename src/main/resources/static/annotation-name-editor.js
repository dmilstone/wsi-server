/** Compact, selection-aware editor for the canonical annotation `name` field. */
class AnnotationNameEditor {
    static MAX_LENGTH = 200;

    constructor(input, adapter) {
        this.input = input;
        this.adapter = adapter;
        this.selectedId = null;
        this.storedValue = "";
        this.visible = true;

        input.addEventListener("keydown", event => {
            // Handle editor keys here so they never reach viewer drawing shortcuts.
            if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                this.commit();
                input.blur();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                input.value = this.storedValue;
                input.setCustomValidity("");
            }
        });
        input.addEventListener("input", () => this.validate());
        input.addEventListener("blur", () => this.commit());
    }

    setSelection(annotations, visible = this.visible) {
        this.visible = Boolean(visible);
        const selected = this.visible && Array.isArray(annotations) && annotations.length === 1
            ? annotations[0]
            : null;
        const nextId = selected?.id || null;

        // Deliberately discard the draft before changing selection/image.
        this.selectedId = nextId;
        this.storedValue = nextId ? this.adapter.getAnnotationName(nextId) : "";
        this.input.value = this.storedValue;
        this.input.disabled = !nextId;
        this.input.placeholder = nextId ? "Unnamed annotation" : "Select one annotation";
        this.input.setCustomValidity("");
        this.input.setAttribute("aria-invalid", "false");
        this.input.title = "";
    }

    setVisible(visible, annotations) {
        this.setSelection(annotations, visible);
    }

    validate() {
        const tooLong = Array.from(this.input.value.trim()).length > AnnotationNameEditor.MAX_LENGTH;
        this.input.setCustomValidity(tooLong ? "Name must be at most 200 Unicode characters." : "");
        this.input.setAttribute("aria-invalid", String(tooLong));
        this.input.title = tooLong ? "Name must be at most 200 Unicode characters." : "";
        return !tooLong;
    }

    commit() {
        if (!this.selectedId || this.input.disabled || !this.validate()) return false;
        const value = this.input.value.trim();
        if (value === this.storedValue) return false;
        const changed = this.adapter.setAnnotationName(this.selectedId, value || null);
        if (changed) this.storedValue = value;
        this.input.value = this.storedValue;
        return changed;
    }
}
