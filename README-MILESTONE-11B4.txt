Milestone 11B.4 — Live Pixel Values
===================================

Adds raw full-resolution UINT16 pixel sampling to the pointer status display.

Status bar output:
  Image X 12,345 Y 6,789 | Pixel C0 125 · C1 4,820 · C2 31

The values are the original channel intensities at the full-resolution image
coordinate, before display windows, gamma, opacity, LUT coloring, or compositing.

Implementation:
- GET /api/images/{imageId}/pixel?x={x}&y={y}
- Reads one 1 x 1 pixel from every channel at Bio-Formats resolution 0.
- Pointer requests are delayed by 75 ms and stale requests are cancelled.

Files changed:
- src/main/java/wsi_server/ImageApiController.java
- src/main/java/wsi_server/BioFormatsTileService.java
- src/main/java/wsi_server/api/PixelSampleResponse.java
- src/main/resources/static/index.html

Install replacement package:
Copy the included src directory over the project src directory, preserving paths.
Then run:
  ./mvnw clean test
  ./mvnw spring-boot:run

Hard-refresh the browser after restarting.
