# Maintained Fabric Overlay spike validation

## Status and decision rule

This isolated, authenticated `/fabric7-spike.html` experiment is **not persisted** and is not a migration recommendation. Automated checks cannot pass the phase. A recommendation requires the real-browser checks below in both Chrome and Safari.

## Dependency and build record

Dependencies are isolated in `fabric7-spike/`; the normal viewer does not load them.

| Package | Exact version | License | Integrity source |
| --- | ---: | --- | --- |
| `openseadragon-fabric-overlay` | `2.0.0` | MIT | `sha512-lMlfg+qCHVFSXoMCf8mvv1MxzsdMQ/jyT7+fGd+lZLr6B3sPD1mHBO1xWBAKvPbbPwDG5Y8dcqh+y06QjCAdoQ==` |
| `openseadragon` | `5.0.1` | New BSD | To be recorded by npm in the generated lockfile |
| `fabric` | `7.2.0` | MIT | To be recorded by npm in the generated lockfile |
| `esbuild` | `0.25.8` | MIT | To be recorded by npm in the generated lockfile |

Registry access was blocked in the implementation environment. Consequently, no lockfile is committed and no browser bundle is claimed to exist or to be runnable. Do not hand-author either artifact. On a machine with npm registry access, run exactly:

```sh
npm install --package-lock-only --ignore-scripts --prefix fabric7-spike
npm ci --prefix fabric7-spike
npm run build --prefix fabric7-spike
npm run verify-bundle --prefix fabric7-spike
```

The first command must generate `fabric7-spike/package-lock.json`, including npm registry integrity records. Commit that npm-generated lockfile. The pinned esbuild invocation then bundles the three runtime packages and `fabric7-spike/src/main.js` into `src/main/resources/static/fabric7-spike/spike.bundle.js` (and its source map). The isolated `verify-bundle` script fails if the bundle is absent or empty. Commit those generated assets so Maven's ordinary resource handling can include them in the application JAR. The root Maven lifecycle is deliberately unchanged. The page also reports a missing bundle instead of silently remaining blank. Re-run the build and require a clean `git diff` to verify reproducibility.

The integration uses the version-2 named export and calls `initOSDFabricOverlay(viewer, { fabricCanvasOptions: { selection: true } }, "fabric7-spike-overlay")`. It obtains the canvas only from the returned overlay's `fabricCanvas()` method. It does not pass library objects, patch `OpenSeadragon.Viewer.prototype`, or call the obsolete `viewer.fabricjsOverlay()` API. No overlay source is copied or locally rewritten.

## Privacy and persistence inspection

Lifecycle instrumentation increments only named counters. It must never log image identifiers, paths, names, geometry, coordinates, or image data. Annotation state is held in JavaScript maps, is scoped by image ID, and is lost on reload. Import replaces records with the same ID rather than duplicating them. Inspect the Network panel and confirm that interaction emits no annotation `PUT`, `POST`, `PATCH`, or `DELETE` request.

## Browser acceptance

Use at least two images. Add two rectangles, give one a plain-text name, and exercise repeated moves/resizes before testing pan, zoom, resize, fullscreen, export/import, switching away and back, deletion, and reload.

| Required observation | Chrome | Safari |
| --- | --- | --- |
| Ordinary click selects; empty space deselects; another object reselects immediately | Not run | Not run |
| Movement stops exactly on release and remains immediately usable | Not run | Not run |
| Native-handle resize stops exactly on release and remains immediately usable | Not run | Not run |
| Label follows continuously during movement and resize | Not run | Not run |
| One `object:modified` and one `logical:commit` per completed move/resize | Not run | Not run |
| No click-away is required after movement or resize | Not run | Not run |
| Pan/zoom causes no modification or commit | Not run | Not run |
| Geometry remains aligned through pan, zoom, window resize, and fullscreen | Not run | Not run |
| Image switching never displays another image's objects | Not run | Not run |
| Geometry and names hide/show independently | Not run | Not run |
| JSON round trip preserves metadata and does not duplicate IDs | Not run | Not run |
| Reload clears every spike annotation | Not run | Not run |
| Network panel contains no annotation write request | Not run | Not run |

**Phase result: Not run. Do not recommend migration.**
