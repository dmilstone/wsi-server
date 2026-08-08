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

## Bounded deidentified VSI observation

An explicitly approved validation used one copied, deidentified compound VSI acquisition and its companion
directory in a dedicated private temporary image root, with a separate empty temporary annotation root. The
fixture aggregate was 9 regular files and 745,510,137 bytes, with no symbolic links and no identity in its
filename, embedded label/barcode, or metadata. The isolated diagnostic process was bound only to
`127.0.0.1:18085`, used temporary credentials, enabled diagnostic timing, and was stopped afterward. The source
fixture and all production/development image and annotation roots remained untouched. The viewer opened with
the expected channels and displayed genuine embedded label and overview images; no diagnostic pixels were
substituted.

The following milliseconds are a bounded three-run observation of this one VSI fixture, not a performance
guarantee for other files, formats, storage, hosts, JVM states, or Bio-Formats versions:

| Process-cold measurement | Run 1 | Run 2 | Run 3 | Median | Range |
| --- | ---: | ---: | ---: | ---: | ---: |
| Metadata `request_total` | 375.438500 | 455.428375 | 444.029208 | 444.029208 | 375.438500–455.428375 |
| Metadata `reader_create` | 113.877584 | 182.334375 | 148.746042 | 148.746042 | 113.877584–182.334375 |
| Metadata `set_id_metadata_parse` | 40.607167 | 39.606834 | 47.282750 | 40.607167 | 39.606834–47.282750 |
| Metadata `automatic_window_open_bytes` | 178.651000 | 176.458333 | 174.449459 | 176.458333 | 174.449459–178.651000 |
| Embedded label `open_bytes_decode` | 1276.367708 | 1510.635958 | 1321.158541 | 1321.158541 | 1276.367708–1510.635958 |
| Embedded macro `open_bytes_decode` | 2414.520958 | 2454.057709 | 2589.063042 | 2454.057709 | 2414.520958–2589.063042 |
| Embedded request/shared bundle total | 3837.502916 | 4111.127833 | 4065.132625 | 4065.132625 | 3837.502916–4111.127833 |

In the same process, warm metadata totals were 0.049875 ms and 0.023334 ms. Cached label and macro request totals
were each 0.004583 ms, with no repeated reader creation, `setId`, pixel decode, scaling, or PNG encoding. For this
fixture, cold embedded-image latency was dominated by genuine associated-pixel decoding—particularly macro
decoding—not series search, scaling, PNG encoding, or `setId`.

The effectively instantaneous repeat requests demonstrate the behavior of the existing same-process associated
byte cache. That cache remains unbounded and has no source-change invalidation, so it is **not** an acceptable
final cache design and these warm observations are not evidence that its lifecycle is safe.

### Bounded Bio-Formats thumbnail evaluation: negative result

Using the same previously approved copied, deidentified compound VSI fixture, a bounded three-run comparison
evaluated Bio-Formats 7.3.1 `BufferedImageReader.openThumbImage(0)` on the genuine label and overview series
already chosen by `AssociatedImageSelection`. The comparison used a private temporary image root, an empty
temporary annotation root, and an isolated loopback-only diagnostic process that was stopped afterward. No
production, development, or clinical image or annotation root was accessed, and no diagnostic pixels were
substituted.

Both strategies displayed visually equivalent genuine label and overview images. The selected associated-image
identity, orientation, crop, color, and legibility were correct in every run, and neither strategy produced an
error. Nevertheless, thumbnail decoding was consistently slower:

| Process-cold measurement | Thumbnail run 1 | Thumbnail run 2 | Thumbnail run 3 | Thumbnail median | Thumbnail range | Full-decode median | Difference |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Label pixel decode | 1785.371500 | 1818.689667 | 1727.034208 | 1785.371500 | 1727.034208–1818.689667 | 1321.158541 | 35.14% slower |
| Overview pixel decode | 3301.991583 | 3272.216792 | 3274.505959 | 3274.505959 | 3272.216792–3301.991583 | 2454.057709 | 33.43% slower |
| Shared request total (longer concurrent request) | 5109.803208 | 5143.937875 | 5052.663958 | 5109.803208 | 5052.663958–5143.937875 | 4065.132625 | 25.70% slower |

For this fixture, `openThumbImage` reduced the later scaling and PNG-encoding work but increased genuine
associated-pixel decoding enough to increase total latency. It is therefore rejected as the VSI optimization,
and no experimental runtime switch is retained. This is a bounded negative result for one VSI fixture—not a
general Bio-Formats performance conclusion, a guarantee for other VSI files, or an NDPI conclusion.

## Remaining validation and next optimization

Real-file NDPI validation remains outstanding. A later explicitly approved NDPI run should use the same isolated
procedure and keep process-cold, first-image, same-image warm, concurrent-first, and different-image cohorts
separate.

The next VSI optimization investigation should evaluate bounded, source-fingerprint-invalidated associated-image
storage or another decode approach. Any proposal must prove memory and disk bounds, concurrent-request safety,
reader isolation, source-change invalidation, and unchanged missing-image and decode-failure behavior before it
can replace the current path. It must never substitute or synthesize diagnostic pixels. No such design is
implemented here.
