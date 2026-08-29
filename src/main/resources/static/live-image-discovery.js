(function (root, factory) {
    const exported = factory();
    if (typeof module === "object" && module.exports) module.exports = exported;
    else root.LiveImageDiscovery = exported.LiveImageDiscovery;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const CONNECTION_REFUSED_LIMIT = 3;
    const BACKOFF_MS = 60000;

    function isConnectionRefused(error) {
        const text = String(error && error.message ? error.message : error || "").toLowerCase();
        return text.includes("failed to fetch")
            || text.includes("err_connection_refused")
            || text.includes("load failed")
            || text.includes("networkerror")
            || text.includes("network request failed");
    }

    class LiveImageDiscovery {
        constructor({document, request, applyImages, status, intervalMs = 30000, setIntervalFn, clearIntervalFn, nowFn}) {
            this.document = document;
            this.request = request;
            this.applyImages = applyImages;
            this.status = status;
            this.intervalMs = Math.max(5000, Math.min(intervalMs, 300000));
            this.setIntervalFn = setIntervalFn || globalThis.setInterval.bind(globalThis);
            this.clearIntervalFn = clearIntervalFn || globalThis.clearInterval.bind(globalThis);
            this.nowFn = nowFn || Date.now;
            this.running = false;
            this.timer = null;
            this.halted = false;
            this.backoffUntil = 0;
            this.consecutiveRefused = 0;
            this.onVisibility = () => {
                if (this.document.hidden) return;
                this.clearBackoff();
                void this.refresh(false);
            };
        }

        start() {
            this.halted = false;
            this.consecutiveRefused = 0;
            this.backoffUntil = 0;
            if (this.timer !== null) return;
            this.document.addEventListener("visibilitychange", this.onVisibility);
            this.timer = this.setIntervalFn(() => {
                if (this.document.hidden) return;
                void this.refresh(false);
            }, this.intervalMs);
        }

        stop() {
            if (this.timer !== null) this.clearIntervalFn(this.timer);
            this.timer = null;
            this.document.removeEventListener("visibilitychange", this.onVisibility);
        }

        clearBackoff() {
            this.halted = false;
            this.backoffUntil = 0;
            this.consecutiveRefused = 0;
        }

        async waitForDiscovery() {
            let discovery = await this.request("/api/images/discovery");
            for (let attempts = 0; discovery && discovery.running && attempts < 60; attempts++) {
                await new Promise(resolve => setTimeout(resolve, 250));
                discovery = await this.request("/api/images/discovery");
            }
        }

        async refresh(manual) {
            if (manual) {
                this.clearBackoff();
                if (this.timer === null) this.start();
            }
            if (this.running || this.document.hidden) return false;
            if (!manual && this.nowFn() < this.backoffUntil) return false;
            this.running = true;
            this.status("Checking for images…");
            try {
                // Automatic polls paint the current catalog immediately. Waiting
                // for discovery.running used to time out on a long filesystem
                // scan and never applyImages — the list then only updated on
                // a page reload, which does the same GET without waiting.
                if (manual) {
                    await this.request("/api/images/refresh", {method: "POST"});
                    await this.waitForDiscovery();
                }
                const result = await this.request("/api/images");
                const added = this.applyImages(result && result.images);
                this.status(added === 0 ? "No new images" : `${added} new image${added === 1 ? "" : "s"} available`);
                this.consecutiveRefused = 0;
                this.backoffUntil = 0;
                this.halted = false;
                return true;
            } catch (error) {
                if (isConnectionRefused(error)) {
                    this.consecutiveRefused += 1;
                    if (this.consecutiveRefused >= CONNECTION_REFUSED_LIMIT) {
                        this.backoffUntil = this.nowFn() + BACKOFF_MS;
                        this.halted = true;
                        this.status("Viewer unreachable; will retry");
                    } else {
                        this.status("Refresh failed; existing list retained");
                    }
                } else {
                    this.consecutiveRefused = 0;
                    this.status("Refresh failed; existing list retained");
                }
                return false;
            } finally {
                this.running = false;
            }
        }
    }
    return {LiveImageDiscovery};
});
