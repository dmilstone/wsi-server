Milestone 12.1B.1 — Load backend annotations into Annotorious

Changes:
- Adds static/annotation-adapter.js.
- Loads GET /api/images/{imageId}/annotations whenever OpenSeadragon opens an image.
- Converts backend rectangle/square and ellipse/circle geometry to Annotorious geometry.
- Ignores stale responses when the user switches images quickly.
- Keeps create/update/delete browser-only for this read-only integration step.

Verification:
1. Start the application and open a slide.
2. Confirm the browser network panel shows a successful annotations GET request.
3. Confirm the console reports AnnotationAdapter: loaded N annotations.
4. Confirm drawing, moving, resizing, and keyboard deletion still work.
