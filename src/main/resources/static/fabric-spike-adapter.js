"use strict";

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.FabricSpikeAdapter = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
    const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

    function geometryOf(annotation) {
        const geometry = annotation?.geometry || annotation?.target?.selector?.geometry || {};
        const x = Number(geometry.x ?? geometry.bounds?.minX);
        const y = Number(geometry.y ?? geometry.bounds?.minY);
        const width = Number(geometry.width ?? geometry.w ?? (geometry.bounds?.maxX - x));
        const height = Number(geometry.height ?? geometry.h ?? (geometry.bounds?.maxY - y));
        if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) {
            throw new Error("Annotation rectangle geometry is invalid");
        }
        return {x, y, width, height};
    }

    function fromApplication(annotation) {
        const original = copy(annotation);
        return {
            id: String(annotation.id),
            name: annotation.name ?? null,
            geometry: geometryOf(annotation),
            bodies: copy(annotation.bodies ?? annotation.body ?? []),
            created: annotation.created ?? null,
            updated: annotation.updated ?? null,
            visible: annotation.visible !== false,
            locked: annotation.locked ?? annotation.locking ?? null,
            original
        };
    }

    function toApplication(record) {
        const output = copy(record.original || {});
        output.id = record.id;
        output.name = record.name ?? null;
        output.bodies = copy(record.bodies ?? []);
        output.created = record.created ?? null;
        output.updated = record.updated ?? null;
        output.visible = record.visible !== false;
        if (record.locked !== null && record.locked !== undefined) output.locked = copy(record.locked);
        output.target = output.target || {};
        output.target.selector = output.target.selector || {};
        output.target.selector.geometry = {
            ...(output.target.selector.geometry || {}),
            x: record.geometry.x, y: record.geometry.y,
            w: record.geometry.width, h: record.geometry.height,
            bounds: {
                minX: record.geometry.x, minY: record.geometry.y,
                maxX: record.geometry.x + record.geometry.width,
                maxY: record.geometry.y + record.geometry.height
            }
        };
        delete output.geometry;
        return output;
    }

    function exportCollection(recordsByImage) {
        return JSON.stringify({version: 1, images: Object.fromEntries(
            [...recordsByImage].map(([imageId, records]) => [imageId, records.map(toApplication)])
        )}, null, 2);
    }

    function importCollection(text, destination) {
        const parsed = JSON.parse(text);
        if (parsed.version !== 1 || !parsed.images || Array.isArray(parsed.images)) throw new Error("Unsupported spike JSON");
        for (const [imageId, annotations] of Object.entries(parsed.images)) {
            if (!Array.isArray(annotations)) throw new Error("Image annotations must be an array");
            const unique = new Map();
            for (const annotation of annotations) {
                const record = fromApplication(annotation);
                unique.set(record.id, record);
            }
            destination.set(imageId, [...unique.values()]);
        }
        return destination;
    }

    return {geometryOf, fromApplication, toApplication, exportCollection, importCollection};
});
