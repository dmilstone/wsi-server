"use strict";

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.FabricSpikeDrawing = api.FabricSpikeDrawing;
})(typeof globalThis === "object" ? globalThis : this, function () {
    class FabricSpikeDrawing {
        constructor(canvas, fabricApi, overlay, toImageGeometry, callbacks = {}) {
            this.canvas = canvas;
            this.fabric = fabricApi;
            this.overlay = overlay;
            this.toImageGeometry = toImageGeometry;
            this.callbacks = callbacks;
            this.active = false;
            this.origin = null;
            this.preview = null;
            this.handlers = {
                "mouse:down": event => this.mouseDown(event),
                "mouse:move": event => this.mouseMove(event),
                "mouse:up": () => this.mouseUp()
            };
            for (const [name, handler] of Object.entries(this.handlers)) canvas.on(name, handler);
        }
        setActive(active) {
            this.active = Boolean(active);
            if (!this.active) this.cancelPreview();
            this.callbacks.modeChanged?.(this.active);
        }
        mouseDown(event) {
            if (!this.active || event.target) return;
            this.origin = this.canvas.getPointer(event.e);
            this.preview = new this.fabric.Rect({
                left: this.origin.x, top: this.origin.y, width: 0, height: 0,
                fill: "rgba(255,205,0,.08)", stroke: "#ffcd00", strokeWidth: 2,
                selectable: false, evented: false
            });
            this.overlay.withSync(() => this.canvas.add(this.preview));
        }
        mouseMove(event) {
            if (!this.active || !this.origin || !this.preview) return;
            const point = this.canvas.getPointer(event.e);
            this.preview.set({
                left: Math.min(this.origin.x, point.x), top: Math.min(this.origin.y, point.y),
                width: Math.abs(point.x - this.origin.x), height: Math.abs(point.y - this.origin.y)
            });
            this.canvas.requestRenderAll();
        }
        mouseUp() {
            if (!this.active || !this.origin || !this.preview) return;
            const preview = this.preview;
            const geometry = this.toImageGeometry(preview);

            // End the custom interaction before rebuilding Fabric's object list.
            // In particular, do not call setActiveObject during Fabric's mouse:up dispatch:
            // Fabric 5 is still completing the transform associated with that pointer.
            this.origin = null;
            this.preview = null;
            this.active = false;
            this.overlay.withSync(() => this.canvas.remove(preview));
            this.canvas.discardActiveObject();
            this.callbacks.modeChanged?.(false);
            if (geometry.width >= 2 && geometry.height >= 2) this.callbacks.created?.(geometry);
        }
        cancelPreview() {
            const preview = this.preview;
            this.origin = null;
            this.preview = null;
            if (preview) this.overlay.withSync(() => this.canvas.remove(preview));
        }
        destroy() {
            this.cancelPreview();
            for (const [name, handler] of Object.entries(this.handlers)) this.canvas.off(name, handler);
        }
    }
    return {FabricSpikeDrawing};
});
