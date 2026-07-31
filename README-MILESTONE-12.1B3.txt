Milestone 12.1B.3 — Annotation loading performance

Changes
- Starts the annotation GET as soon as an image is selected, in parallel with
  metadata and display-state requests.
- Reuses the prefetched result when OpenSeadragon reports that the image is open.
- Caches the most recent annotation collection per image during the browser
  session.
- Skips annotation clear/GET/rebuild when OpenSeadragon reopens the same image
  for a channel/LUT/display revision.
- Preserves the 12.1B.2 save-before-switch guarantee.
- Adds concise console timing for image selection, annotation GET, previous-save
  flushing, annotation clearing, and conversion/rendering.

Expected console entries
- Image selection performance {...}
- Annotation performance: GET N ms {...}
- Annotation performance {...}
- Annotation performance: same-image reload skipped {...}

Verification
1. Open several images and compare switching speed with 12.1B.2.
2. Create/edit an annotation, immediately switch images, and return.
3. Confirm the annotation persists and remains editable.
4. Change a display/channel setting on the same image and confirm annotations do
   not disappear or reload.
5. Review timing logs to identify any remaining dominant delay.

Validation performed
- node --check passed for annotation-adapter.js and annotorious-spike.js.
- Maven tests were not run because the wrapper could not download Maven from the
  external repository in this environment.
