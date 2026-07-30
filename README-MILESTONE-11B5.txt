Milestone 11B.5 — Immediate Motion and Pixel Readout
====================================================

Changes:
- Removes inertial/flick movement after mouse, touch, or pen panning.
- Removes animated spring settling after panning and zooming.
- Sets tile blending to immediate so newly loaded tiles do not fade into place.
- Removes the intentional 75 ms delay before pixel-value requests.
- Starts pixel sampling immediately when the pointer enters a new image pixel.
- Cancels stale requests and ignores late responses.
- Caches the most recent 512 sampled pixels for instant repeat display.

Pixel values still come from:
  GET /api/images/{imageId}/pixel?x={x}&y={y}

Only the browser UI file changed in this milestone:
  src/main/resources/static/index.html

After installation:
  ./mvnw clean test
  ./mvnw spring-boot:run

Then hard-refresh the browser.
