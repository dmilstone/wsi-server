"use strict";

(function () {
    class FabricSpike {
        constructor() {
            this.records = new Map();
            this.image = null;
            this.metadata = null;
            this.generation = 0;
            this.sequence = 0;
            this.drawing = false;
            this.geometryVisible = true;
            this.namesVisible = true;
            this.counters = new Map();
            this.viewer = OpenSeadragon({
                id: "fabric-viewer", prefixUrl: "https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/",
                showNavigator: true, animationTime: 0, blendTime: 0, constrainDuringPan: true,
                gestureSettingsMouse: {clickToZoom: false, dblClickToZoom: false}
            });
            this.overlay = new FabricOsdOverlay(this.viewer, fabric, {
                continuous: (event, object) => this.continuous(event, object),
                modified: object => this.modified(object),
                viewportChanged: () => this.render(),
                event: event => this.count(event)
            });
            this.canvas = this.overlay.canvas;
            this.bindControls();
            this.bindDrawing();
            this.loadImages();
        }
        count(name) {
            this.counters.set(name, (this.counters.get(name) || 0) + 1);
            const id = `counter-${name.replaceAll(":", "-")}`;
            const output = document.getElementById(id);
            if (output) output.textContent = this.counters.get(name);
        }
        currentRecords() {
            if (!this.image) return [];
            if (!this.records.has(this.image.id)) this.records.set(this.image.id, []);
            return this.records.get(this.image.id);
        }
        recordFor(object) { return this.currentRecords().find(record => record.id === object.spikeId); }
        continuous(event, object) {
            this.count(event);
            const record = this.recordFor(object);
            if (!record) return;
            record.geometry = FabricOsdCoordinates.canvasRectToImage(this.viewer, object);
            this.positionLabel(record, object);
            this.canvas.requestRenderAll();
        }
        modified(object) {
            this.count("object:modified");
            const record = this.recordFor(object);
            if (!record) return;
            record.geometry = FabricOsdCoordinates.canvasRectToImage(this.viewer, object);
            object.set({width: object.width * object.scaleX, height: object.height * object.scaleY, scaleX: 1, scaleY: 1});
            record.updated = new Date().toISOString();
            this.positionLabel(record, object);
            this.count("logical:commit");
            this.updateSelection();
        }
        rectangle(record) { return this.canvas.getObjects().find(item => item.spikeType === "rectangle" && item.spikeId === record.id); }
        label(record) { return this.canvas.getObjects().find(item => item.spikeType === "label" && item.spikeId === record.id); }
        positionLabel(record, rectangle) {
            const label = this.label(record);
            if (label) label.set({left: rectangle.left, top: rectangle.top - 22, text: record.name || ""}).setCoords();
        }
        render() {
            if (!this.image || !this.viewer.world.getItemCount()) return;
            this.overlay.withSync(() => {
                const selectedId = this.canvas.getActiveObject()?.spikeId;
                this.canvas.clear();
                for (const record of this.currentRecords()) {
                    const box = FabricOsdCoordinates.imageRectToCanvas(this.viewer, record.geometry);
                    const rectangle = new fabric.Rect({
                        ...box, fill: "rgba(255,205,0,.08)", stroke: "#ffcd00", strokeWidth: 2,
                        transparentCorners: false, cornerColor: "#fff", cornerStrokeColor: "#111",
                        visible: this.geometryVisible && record.visible !== false,
                        selectable: !record.locked, hasRotatingPoint: false, lockRotation: true,
                        spikeType: "rectangle", spikeId: record.id
                    });
                    const label = new fabric.Text(record.name || "", {
                        left: box.left, top: box.top - 22, fontSize: 16, fill: "#fff",
                        backgroundColor: "rgba(0,0,0,.72)", selectable: false, evented: false,
                        visible: this.namesVisible && record.visible !== false,
                        spikeType: "label", spikeId: record.id
                    });
                    this.canvas.add(rectangle, label);
                    if (selectedId === record.id) this.canvas.setActiveObject(rectangle);
                }
                this.canvas.requestRenderAll();
            });
            this.updateSelection();
        }
        bindDrawing() {
            this.drawingLifecycle = new FabricSpikeDrawing(
                this.canvas,
                fabric,
                this.overlay,
                preview => FabricOsdCoordinates.canvasRectToImage(this.viewer, preview),
                {
                    modeChanged: active => {
                        this.drawing = active;
                        document.getElementById("draw").setAttribute("aria-pressed", String(active));
                        this.viewer.setMouseNavEnabled(!active);
                    },
                    created: geometry => {
                        const now = new Date().toISOString();
                        this.currentRecords().push({id: `fabric-${++this.sequence}`, name: null, geometry, bodies: [], created: now, updated: now, visible: true, locked: null, original: {}});
                        this.count("object:added");
                        this.count("logical:commit");
                        this.render();
                    }
                }
            );
        }
        updateSelection() {
            const object = this.canvas.getActiveObject();
            const record = object?.spikeType === "rectangle" ? this.recordFor(object) : null;
            const input = document.getElementById("annotation-name");
            input.disabled = !record;
            input.value = record?.name || "";
            document.getElementById("delete").disabled = !record;
        }
        bindControls() {
            this.canvas.on("selection:created", () => this.updateSelection());
            this.canvas.on("selection:updated", () => this.updateSelection());
            this.canvas.on("selection:cleared", () => this.updateSelection());
            document.getElementById("draw").addEventListener("click", event => {
                this.canvas.discardActiveObject();
                this.drawingLifecycle.setActive(!this.drawingLifecycle.active);
            });
            document.getElementById("delete").addEventListener("click", () => {
                const object = this.canvas.getActiveObject(); if (!object) return;
                const records = this.currentRecords(), index = records.findIndex(record => record.id === object.spikeId);
                if (index >= 0) records.splice(index, 1);
                this.overlay.withSync(() => { const label = this.canvas.getObjects().find(item => item.spikeType === "label" && item.spikeId === object.spikeId); this.canvas.remove(object, label); });
                this.count("object:removed"); this.count("logical:commit"); this.updateSelection();
            });
            document.getElementById("annotation-name").addEventListener("change", event => {
                const object = this.canvas.getActiveObject(), record = object && this.recordFor(object); if (!record) return;
                record.name = event.target.value.trim() || null; record.updated = new Date().toISOString();
                this.positionLabel(record, object); this.count("logical:commit");
            });
            document.getElementById("geometry-visible").addEventListener("change", event => { this.geometryVisible = event.target.checked; this.render(); });
            document.getElementById("names-visible").addEventListener("change", event => { this.namesVisible = event.target.checked; this.render(); });
            document.getElementById("export").addEventListener("click", () => { document.getElementById("json").value = FabricSpikeAdapter.exportCollection(this.records); });
            document.getElementById("import").addEventListener("click", () => {
                try { FabricSpikeAdapter.importCollection(document.getElementById("json").value, this.records); this.render(); this.status("JSON imported in memory"); }
                catch (error) { this.status(error.message, true); }
            });
        }
        status(message, error = false) { const node = document.getElementById("status"); node.textContent = message; node.classList.toggle("error", error); }
        async loadImages() {
            try {
                const response = await fetch("/api/images"); if (!response.ok) throw new Error("Unable to discover images");
                const {images} = await response.json(), select = document.getElementById("images");
                for (const image of images) { const option = document.createElement("option"); option.value = image.id; option.textContent = image.name; select.append(option); }
                select.addEventListener("change", () => this.openImage(images.find(image => image.id === select.value)));
                if (images[0]) await this.openImage(images[0]); else this.status("No sample images found", true);
            } catch (error) { this.status(error.message, true); }
        }
        async openImage(image) {
            const generation = ++this.generation;
            this.canvas.discardActiveObject();
            this.overlay.withSync(() => this.canvas.clear());
            this.image = image; this.status("Opening image…");
            const response = await fetch(`/api/images/${encodeURIComponent(image.id)}`);
            if (!response.ok) throw new Error("Unable to load image metadata");
            const metadata = await response.json(); if (generation !== this.generation) return;
            this.metadata = metadata;
            this.viewer.open({width: metadata.width, height: metadata.height, tileSize: metadata.tileSize, tileOverlap: 0, minLevel: 0, maxLevel: metadata.resolutionCount - 1,
                getTileUrl: (level, x, y) => `/tile/${encodeURIComponent(image.id)}/composite/${level}/${x}/${y}.png`});
            this.viewer.addOnceHandler("open", () => { if (generation === this.generation) { this.render(); this.status("Ready — annotations exist only in this tab"); } });
        }
        destroy() { this.generation++; this.drawingLifecycle.destroy(); this.overlay.destroy(); this.viewer.destroy(); }
    }
    window.addEventListener("DOMContentLoaded", () => { window.fabricAnnotationSpike = new FabricSpike(); });
})();
