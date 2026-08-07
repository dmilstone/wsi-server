# Bio-Formats metadata and embedded-image performance diagnosis

This diagnostic work measures the existing lifecycle; it does **not** claim an optimization and does not
complete the roadmap performance priority. No clinical image or annotation root is needed by its tests.

## Exact request and reader lifecycle

* Initial viewer load performs environment and CSRF initialization, `GET /api/images`, then concurrently
  requests `GET /api/images/{id}` and `GET /api/images/{id}/display`. Annotation prefetch is independent.
  Both image requests converge on `BioFormatsTileService.context`. The first creates one `ImageContext` under
  the contexts-map lock: `ImageReader` creation, OME-XML store setup, `setId` (Bio-Formats open and metadata
  parse), selection of series 2, metadata/channel extraction, and (for UINT16 data) up to 100 `openBytes`
  samples per channel for initial display windows. The second request waits for and reuses that same reader.
  OpenSeadragon subsequently requests tiles; each synchronizes on that context, selects a resolution,
  calls `openBytes`, renders, and PNG-encodes. Tile timing is intentionally not logged.
* `GET /api/images` only reads the in-memory discovery snapshot (and requests a throttled asynchronous file
  scan); it does not create a Bio-Formats reader. Its response currently includes configured-root and image
  naming information, so it is deliberately outside diagnostic logs.
* `GET /api/images/{id}` reuses the context reader after first construction, selects resolution zero, reads
  dimensions/resolutions and OME physical sizes, and returns metadata. It does not read diagnostic pixels
  except during first-context automatic-window sampling described above.
* `GET /api/images/{id}/associated-images` always creates and closes a separate `BufferedImageReader`, calls
  `setId`, searches associated series, and extracts series metadata. It does not decode or encode pixels.
* Opening the overview UI concurrently loads `label.png` and `thumbnail.png`. The latter is the macro/overview
  route despite its historical URL. Both converge on the associated-image bundle guarded by one map lock.
  A cold bundle creates a separate reader, calls `setId`, searches genuine names/thumbnail flags, decodes each
  available image with `openImage(0)` (which performs Bio-Formats pixel reads), scales it, PNG-encodes it, closes
  the reader, and stores the byte arrays. The other concurrent request waits and then uses the bundle. There is
  no distinct public macro URL and no distinct embedded-thumbnail response: `thumbnail.png` returns the genuine
  macro/overview/preview/thumbnail-associated series. Missing images retain the existing error behavior.

This maps three overlapping metadata parses on a fully exercised cold image: primary context initialization,
the associated-series catalog, and the embedded bundle. Ordinary viewer initialization does not request the
catalog or embedded images; opening the overview causes two overlapping HTTP requests but only one bundle
extraction. The cache lock is global, so first embedded-image work for different images is serialized. The
existing associated byte cache is unbounded and has no source-change invalidation; it is documented here, not
expanded or presented as an optimization.

## Timing records

Set `WSI_DIAGNOSTIC_TIMING=true` (equivalent to `wsi.diagnostic-timing.enabled=true`) only for a bounded local
diagnostic run. It is false by default. Logger `wsi.performance` emits one structured event per meaningful stage:

| Category | Stages |
| --- | --- |
| `image_list` | `snapshot_read` |
| `metadata` | `request_total`, `reader_create`, `set_id_metadata_parse`, `series_select`, `metadata_extract`, `automatic_window_open_bytes` |
| `associated_catalog` | `request_total`, `reader_create`, `set_id_metadata_parse`, `series_search` |
| `embedded_bundle` | `reader_create`, `set_id_metadata_parse`, `series_search` |
| `embedded_label`, `embedded_macro` | `request_total`, `open_bytes_decode`, `render_scale`, `png_encode` |

Every record contains category, stage, `process_cold`, `image_cold`, `image_warm`, or `concurrent_first` state,
a truncated SHA-256 correlation identifier, elapsed milliseconds, outcome, exception class on failure, and an
overlap flag. It never logs image names, supplied IDs, paths, metadata values, patient/specimen data, annotation
content, or credentials. Do not combine these records with access logs containing request URLs when exporting
diagnostic results. A process restart is required for a true server/process-cold run.

## Reproducible synthetic benchmark

Run `./mvnw -Dtest=DiagnosticTimingTests test`. The fixture uses controlled 12 ms/2 ms fake-operation delays,
temporary in-memory event sinks, and no reader or filesystem root. It proves cold/warm/different-image
classification, exactly-once attribution, visible concurrent duplicate work, safe failures, opaque output, and
transparent disabled results. Compare event `elapsed_ms` by category/stage; do not interpret scheduler-sensitive
wall time as Bio-Formats throughput. Synthetic sleeps cannot reproduce JVM class loading, native filesystem
caches, vendor parsers, compression, file layout, storage latency, or actual PNG complexity.

## Later approved real-file benchmark

Only after explicit approval, place nonclinical/deidentified VSI and NDPI fixtures in a dedicated temporary
image root (never the production image or annotation roots), configure a separate local process to that root,
and enable timing. For each format: (1) restart and capture initial viewer metadata; (2) repeat the same request;
(3) open the overview and repeat; (4) issue simultaneous first requests after another restart; (5) request a
different fixture without restart. Record several runs and compare medians and ranges stage-by-stage, keeping
process-cold, first-image, same-image warm, concurrent-first, and different-image cohorts separate. Verify the
associated-series catalog before accepting label or overview output.

Real VSI/NDPI validation remains outstanding. The next focused change should first measure those approved files,
then consider per-image single-flight/context lifecycle and a bounded, source-fingerprint-invalidated metadata or
embedded-byte cache. Any such work must prove discovery invalidation, memory bounds, reader isolation and
thread-safety, concurrency, and unchanged failures before claiming improvement.
