"use strict";
/* Fabric OSD Overlay 1.0.0 - first-party isolated spike integration. */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.FabricOsdOverlay = api.FabricOsdOverlay;
    root.FabricOsdCoordinates = api.coordinates;
})(typeof globalThis === "object" ? globalThis : this, function () {
    const coordinates = {
        imageRectToCanvas(viewer, geometry) {
            const a = viewer.viewport.imageToViewerElementCoordinates({x: geometry.x, y: geometry.y});
            const b = viewer.viewport.imageToViewerElementCoordinates({x: geometry.x + geometry.width, y: geometry.y + geometry.height});
            return {left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y};
        },
        canvasRectToImage(viewer, rectangle) {
            const left = rectangle.left, top = rectangle.top;
            const width = rectangle.width * rectangle.scaleX, height = rectangle.height * rectangle.scaleY;
            const a = viewer.viewport.viewerElementToImageCoordinates({x: left, y: top});
            const b = viewer.viewport.viewerElementToImageCoordinates({x: left + width, y: top + height});
            return {x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y};
        }
    };

    class FabricOsdOverlay {
        constructor(viewer, fabricApi, callbacks = {}) {
            this.viewer = viewer;
            this.fabric = fabricApi;
            this.callbacks = callbacks;
            this.handlers = [];
            this.synchronizing = false;
            this.canvasElement = document.createElement("canvas");
            this.canvasElement.className = "fabric-spike-overlay";
            viewer.element.append(this.canvasElement);
            this.canvas = new fabricApi.Canvas(this.canvasElement, {preserveObjectStacking: true, selection: false});
            this.canvas.wrapperEl?.classList.add("fabric-spike-overlay");
            this.install();
            this.resize();
        }
        on(source, name, handler) { source.addHandler ? source.addHandler(name, handler) : source.on(name, handler); this.handlers.push([source, name, handler]); }
        install() {
            const refresh = () => { this.resize(); this.callbacks.viewportChanged?.(); };
            ["animation", "resize", "open", "full-screen"].forEach(name => this.on(this.viewer, name, refresh));
            ["object:moving", "object:scaling"].forEach(name => this.on(this.canvas, name, event => {
                if (!this.synchronizing && event.target?.spikeType === "rectangle") this.callbacks.continuous?.(name, event.target);
            }));
            this.on(this.canvas, "object:modified", event => {
                if (!this.synchronizing && event.target?.spikeType === "rectangle") this.callbacks.modified?.(event.target);
            });
            ["selection:created", "selection:updated", "selection:cleared", "object:added", "object:removed"].forEach(name =>
                this.on(this.canvas, name, event => { if (!this.synchronizing) this.callbacks.event?.(name, event); }));
        }
        resize() {
            const width = this.viewer.element.clientWidth, height = this.viewer.element.clientHeight;
            if (width && height && (this.canvas.getWidth() !== width || this.canvas.getHeight() !== height)) {
                this.canvas.setDimensions({width, height});
            }
            this.canvas.requestRenderAll();
        }
        withSync(action) { this.synchronizing = true; try { return action(); } finally { this.synchronizing = false; } }
        destroy() {
            for (const [source, name, handler] of this.handlers) source.removeHandler ? source.removeHandler(name, handler) : source.off(name, handler);
            this.handlers = [];
            this.canvas.dispose();
            this.canvasElement.remove();
        }
    }
    return {FabricOsdOverlay, coordinates};
});
