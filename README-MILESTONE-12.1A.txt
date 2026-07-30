Milestone 12.1A - Backend Annotation Framework
==============================================

Scope
-----
This milestone adds the backend foundation only. It does not yet add drawing
controls or an annotation overlay to the browser.

Added
-----
- Versioned AnnotationCollection JSON documents.
- Rectangle, square, ellipse, and circle annotation types.
- Stable UUIDs, names, visibility, locking, color, line width, geometry,
  rotation reservation, and created/modified timestamps.
- Level-0 slide pixel coordinates.
- Per-user, per-slide filesystem persistence.
- Atomic JSON replacement to reduce the risk of partial files.
- GET and PUT REST endpoints.
- Validation and RFC 9457-style error responses.

REST API
--------
GET /api/images/{imageId}/annotations
PUT /api/images/{imageId}/annotations

The optional request header below selects the annotation owner:

    X-WSI-User: pathologist_1

Until authentication is added, a missing header uses the configured default
user. User IDs may contain letters, numbers, period, underscore, at-sign, and
hyphen.

Configuration
-------------
wsi.annotations.directory=${user.home}/.wsi-server/annotations
wsi.annotations.default-user=local

Storage layout
--------------
<annotation directory>/<user>/<SHA-256 of relative slide path>.json

The slide hash prevents special characters and duplicate filenames in separate
folders from colliding. The JSON document still records imageId and slidePath
for inspection and migration.

Example PUT body
----------------
{
  "version": 1,
  "annotations": [
    {
      "type": "rectangle",
      "name": "Tumor ROI",
      "visible": true,
      "locked": false,
      "color": "#ff3b30",
      "lineWidth": 2.0,
      "x": 1250.0,
      "y": 800.0,
      "width": 640.0,
      "height": 480.0,
      "rotation": 0.0
    }
  ]
}

The server supplies missing UUIDs and timestamps and overwrites imageId,
slidePath, userId, version, and document modifiedAt with authoritative values.

Validation
----------
- Coordinates are non-negative finite numbers.
- Width and height are positive finite numbers.
- Circle and square width/height must match within 0.001 pixels.
- Color uses #RRGGBB.
- Line width is greater than 0 and at most 100.
- Names are at most 256 characters.
- Existing IDs must be valid UUIDs and unique within the document.

Next milestone
--------------
12.1B will add the frontend annotation module, SVG overlay, loading/rendering,
and an annotation panel. Drawing and editing tools follow on that foundation.
