/** Accessible annotation persistence feedback and browser-exit protection. */
class AnnotationSaveStateFeedback {

    constructor(store, statusElement, retryButton, browserWindow = window) {
        this.store = store;
        this.statusElement = statusElement;
        this.retryButton = retryButton;
        this.browserWindow = browserWindow;
        this.beforeUnloadRegistered = false;
        this.beforeUnload = event => {
            event.preventDefault();
            event.returnValue = "";
            return "";
        };

        this.unsubscribe = store.subscribe("saveStateChanged", detail => this.render(detail));
        retryButton.addEventListener("click", () => void store.retrySave());
        this.render({ saveState: store.saveState, dirty: store.dirty });
    }

    render({ saveState, dirty }) {
        const presentation = {
            loading: ["Loading", "loading"],
            dirty: ["Unsaved", "unsaved"],
            saving: ["Saving…", "saving"],
            saved: ["Saved", "saved"],
            error: ["Save failed", "failed"]
        }[saveState];

        this.statusElement.hidden = !presentation;
        this.statusElement.textContent = presentation?.[0] || "";
        if (presentation) this.statusElement.dataset.state = presentation[1];
        else delete this.statusElement.dataset.state;
        this.retryButton.hidden = saveState !== "error";

        const protectNavigation = dirty || ["dirty", "saving", "error"].includes(saveState);
        if (protectNavigation && !this.beforeUnloadRegistered) {
            this.browserWindow.addEventListener("beforeunload", this.beforeUnload);
            this.beforeUnloadRegistered = true;
        } else if (!protectNavigation && this.beforeUnloadRegistered) {
            this.browserWindow.removeEventListener("beforeunload", this.beforeUnload);
            this.beforeUnloadRegistered = false;
        }
    }
}
