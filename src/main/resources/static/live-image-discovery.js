(function (root, factory) {
    const exported = factory();
    if (typeof module === "object" && module.exports) module.exports = exported;
    else root.LiveImageDiscovery = exported.LiveImageDiscovery;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const CONNECTION_REFUSED_LIMIT = 3;

    function isConnectionRefused(error) {
        const text = String(error && error.message ? error.message : error || "").toLowerCase();
        return text.includes("failed to fetch")
            || text.includes("err_connection_refused")
            || text.includes("load failed")
            || text.includes("networkerror")
            || text.includes("network request failed");
    }

    class LiveImageDiscovery {
        constructor({document, request, applyImages, status, intervalMs = 30000, setIntervalFn, clearIntervalFn}) {
            this.document = document;
            this.request = request;
            this.applyImages = applyImages;
            this.status = status;
            this.intervalMs = Math.max(5000, Math.min(intervalMs, 300000));
            this.setIntervalFn = setIntervalFn || globalThis.setInterval.bind(globalThis);
            this.clearIntervalFn = clearIntervalFn || globalThis.clearInterval.bind(globalThis);
            this.running = false;
            this.timer = null;
            this.halted = false;
            this.consecutiveRefused = 0;
            this.onVisibility = () => {
                if (this.halted || this.document.hidden) return;
                void this.refresh(false);
            };
        }

        start() {
            this.halted = false;
            this.consecutiveRefused = 0;
            if (this.timer !== null) return;
            this.document.addEventListener("visibilitychange", this.onVisibility);
            this.timer = this.setIntervalFn(() => {
                if (this.halted || this.document.hidden) return;
                void this.refresh(false);
            }, this.intervalMs);
        }

        stop() {
            if (this.timer !== null) this.clearIntervalFn(this.timer);
            this.timer = null;
            this.document.removeEventListener("visibilitychange", this.onVisibility);
        }

        async refresh(manual) {
            if (manual && this.halted) this.start();
            if (this.halted || this.running || this.document.hidden) return false;
            this.running = true;
            this.status("Checking for images…");
            try {
                if (manual) await this.request("/api/images/refresh", {method: "POST"});
                else await this.request("/api/images"); // list discovery is the throttled trigger
                let discovery = await this.request("/api/images/discovery");
                for (let attempts = 0; discovery.running && attempts < 60; attempts++) {
                    await new Promise(resolve => setTimeout(resolve, 250));
                    discovery = await this.request("/api/images/discovery");
                }
                if (discovery.running) throw new Error("refresh timeout");
                if (discovery.failureCategory) throw new Error("refresh failed");
                const result = await this.request("/api/images");
                const added = this.applyImages(result.images);
                this.status(added === 0 ? "No new images" : `${added} new image${added === 1 ? "" : "s"} available`);
                this.consecutiveRefused = 0;
                return true;
            } catch (error) {
                if (isConnectionRefused(error)) {
                    this.consecutiveRefused += 1;
                    if (this.consecutiveRefused >= CONNECTION_REFUSED_LIMIT) {
                        this.halted = true;
                        this.stop();
                    }
                } else {
                    this.consecutiveRefused = 0;
                }
                this.status("Refresh failed; existing list retained");
                return false;
            } finally {
                this.running = false;
            }
        }
    }
    return {LiveImageDiscovery};
});
