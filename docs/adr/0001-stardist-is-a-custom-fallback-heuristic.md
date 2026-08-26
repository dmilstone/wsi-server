# ADR 0001: `StarDistTensorEngine` is a custom heuristic, not stock StarDist

- **Status:** Accepted (documenting existing, pre-existing behavior discovered during investigation)
- **Date:** 2026-08-25
- **Applies to:** `src/main/java/wsi_server/plugin/StarDistTensorEngine.java`,
  `src/main/java/wsi_server/plugin/StarDistSegmentationPlugin.java`

## Context

The `stardist-segmentation` plugin (`POST /api/plugins/execute` with
`pluginId: "stardist-segmentation"`) is named after, and its API surface is
modeled on, the published [StarDist](https://github.com/stardist/stardist)
nucleus-segmentation neural network (`stardist_2d_versatile_fluo` /
`stardist_2d_versatile_he` model names, per-nucleus star-convex polygon output,
etc.).

**It does not run that model.** `StarDistTensorEngine.runTensorEngine()` is
designed to attempt a real ONNX Runtime or TensorFlow Java inference call when
weights are present (`tryNativeSession()`), but that method is an
unimplemented detection stub: it only checks whether the `ai.onnxruntime.*` /
`org.tensorflow.*` classes are on the classpath and whether a plausible
weights file/directory exists at the resolved path. It never calls
`OrtSession.run(...)` or a `SavedModelBundle` runner. Both of its "success"
branches return `null` unconditionally, which the caller treats identically to
"no native model available." **Every segmentation request, in every
environment, regardless of whether weights are installed, runs the fallback:**
a from-scratch Java heuristic that finds local-maximum peaks in a blurred,
normalized intensity field and traces a 32-ray (configurable) star-convex
boundary outward from each peak.

This was discovered while investigating a reported "StarDist boundary
stretching / tile-seam distortion" bug (see git history around 2026-08-25).
The tile-seam framing turned out to be incorrect (no tiling/stitching
architecture exists in this codebase — each request processes one contiguous
sample region), but the underlying screenshots did reveal two real bugs in
this heuristic's peak-detection and boundary-tracing logic, which were fixed
in the same change that produced this ADR (see the class Javadoc and this
directory's git log for specifics: a peak-prominence gate, a peak-relative ray
cutoff, and a median-relative ray-length outlier clamp).

## Why this matters

Any tooling, script, or third-party integration that talks to
`/api/plugins/execute` with `pluginId: "stardist-segmentation"` and assumes it
is receiving output from the real, published StarDist model (e.g. for
accuracy benchmarking, reproducing a paper's results, or comparing against a
QuPath/StarDist reference pipeline) will draw incorrect conclusions if it
doesn't know this distinction. The custom heuristic is a reasonable
approximation for interactive use (fast, tunable, no GPU/model-file
dependency) but is **not** a substitute for the trained model's accuracy or
failure modes.

## Decision

1. Keep the custom heuristic as the default/only working engine for now (a
   real ONNX/TensorFlow integration is out of scope for this change; the hook
   point already exists in `runTensorEngine`/`tryNativeSession` for whenever
   that work happens).
2. Make the deviation **self-describing at the API level**, not just
   documented in prose that can go stale: `PluginResult.segmentationEngine()`
   is a new field, set by `StarDistSegmentationPlugin` to
   `StarDistTensorEngine.FALLBACK_ENGINE_LABEL` (`"stardist-fallback-heuristic"`)
   whenever `StarDistTensorEngine.NATIVE_MODEL_IMPLEMENTED` is `false` (i.e.
   always, today). Any caller — including unrelated future software — can
   inspect this field in the JSON response and know definitively which engine
   produced a given result, without trusting documentation to have stayed in
   sync with the code.
3. Mark the exact unimplemented boundary in code with a named boolean gate
   (`StarDistTensorEngine.NATIVE_MODEL_IMPLEMENTED`) rather than leaving it
   implicit in `tryNativeSession`'s control flow, and cross-reference it from
   both the Javadoc and a regression test
   (`StarDistSegmentationPluginTests.nativeModelImplementedConstantMustStayFalseUntilRealInferenceExists`)
   so flipping it silently (e.g. as a drive-by refactor) without also wiring a
   real forward pass gets caught.
4. Stop reporting the specific trained-weights filename
   (`stardist_2d_versatile_fluo`/`_he`) in the human-readable `title` field
   when the fallback heuristic actually ran, since that implied a specific
   named model produced the output. The title now reports
   `segmentationEngine`'s value instead.

## Consequences

- **Positive:** the deviation is discoverable both by a human reading the code
  (prominent Javadoc banner on the class) and programmatically by any API
  consumer (the `segmentationEngine` response field), rather than requiring
  someone to have read this file.
- **Positive:** if/when a real ONNX or TensorFlow inference path is
  implemented, there's a single, obvious, test-guarded switch
  (`NATIVE_MODEL_IMPLEMENTED`) to flip, and the API contract for distinguishing
  "real model" vs "heuristic" output already exists and does not need a
  breaking change.
- **Negative / follow-up work:** the custom heuristic's accuracy has not been
  benchmarked against the real StarDist model on any reference dataset. Users
  relying on this for anything beyond interactive/exploratory annotation
  should be aware detection quality is heuristic-driven, not learned.

## How to keep this doc in sync

If `tryNativeSession` is ever changed to genuinely execute a forward pass:

1. Flip `StarDistTensorEngine.NATIVE_MODEL_IMPLEMENTED` to `true` (this will
   make the guard test above fail on purpose, forcing this file to be
   revisited).
2. Update this ADR's Status/Context to describe the real model path instead
   of the heuristic, and note the heuristic's continued role (if any) as a
   fallback when weights are absent.
3. Confirm `PluginResult.segmentationEngine()` reports something meaningfully
   different (e.g. `"stardist-onnx"` / `"stardist-tensorflow"`) when the real
   model actually ran, versus `StarDistTensorEngine.FALLBACK_ENGINE_LABEL`
   when it still had to fall back (e.g. weights missing at runtime).
