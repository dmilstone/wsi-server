/** Compact, selection-aware editor for the canonical annotation `name` field. */
class AnnotationNameEditor {
    static MAX_LENGTH = 200;

    constructor(input, adapter, nameCommitted = () => {}, editingEnded = () => {}) {
        this.input = input;
        this.adapter = adapter;
        this.nameCommitted = nameCommitted;
        this.editingEnded = editingEnded;
        this.selectedId = null;
        this.storedValue = "";
        this.visible = true;
        this.hostElement = null;
        this.editing = false;

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
                input.blur();
            }
        });
        input.addEventListener("input", () => this.validate());
        input.addEventListener("blur", () => {
            this.commit();
            this.endInlineEdit();
        });
        input.addEventListener("click", event => event.stopPropagation());
        input.addEventListener("pointerdown", event => event.stopPropagation());
    }

    setSelection(annotations, visible = this.visible) {
        this.visible = Boolean(visible);
        const selected = this.visible && Array.isArray(annotations) && annotations.length === 1
            ? annotations[0]
            : null;
        const nextId = selected?.id || null;

        if (this.editing && nextId !== this.selectedId) {
            this.commit();
            this.endInlineEdit();
        }

        // Deliberately discard the draft before changing selection/image.
        this.selectedId = nextId;
        this.storedValue = nextId ? this.adapter.getAnnotationName(nextId) : "";
        this.input.value = this.storedValue;
        this.input.disabled = !nextId;
        this.input.placeholder = nextId ? "Unnamed annotation" : "Select one annotation";
        this.input.setCustomValidity("");
        this.input.setAttribute("aria-invalid", "false");
        this.input.title = "";
        if (!nextId) this.endInlineEdit();
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

    beginEdit() {
        if (!this.selectedId || this.input.disabled) return false;
        this.input.focus?.();
        this.input.select?.();
        return true;
    }

    beginInlineEdit(hostElement) {
        if (!this.selectedId || this.input.disabled || !hostElement) return false;
        if (this.editing && this.hostElement === hostElement) {
            return this.beginEdit();
        }
        if (this.editing) {
            this.commit();
            this.endInlineEdit();
        }
        this.hostElement = hostElement;
        this.editing = true;
        hostElement.classList.add("is-editing");
        hostElement.replaceChildren(this.input);
        this.input.hidden = false;
        this.input.disabled = false;
        this.input.value = this.storedValue;
        this.beginEdit();
        return true;
    }

    endInlineEdit() {
        if (!this.editing && !this.hostElement) {
            this.input.hidden = true;
            return;
        }
        const host = this.hostElement;
        const wasEditing = this.editing;
        this.editing = false;
        this.hostElement = null;
        if (this.input.parentElement) this.input.remove();
        this.input.hidden = true;
        host?.classList.remove("is-editing");
        if (wasEditing) this.editingEnded(this.selectedId);
    }

    commit() {
        if (!this.selectedId || this.input.disabled || !this.validate()) return false;
        const value = this.input.value.trim();
        if (value === this.storedValue) return false;
        const changed = this.adapter.setAnnotationName(this.selectedId, value || null);
        if (changed) {
            this.storedValue = value;
            this.nameCommitted(this.selectedId);
        }
        this.input.value = this.storedValue;
        return changed;
    }
}
