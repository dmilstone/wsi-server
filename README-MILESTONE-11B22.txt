Milestone 11B.22 - Natural filename sorting

The image list in the left column now uses case-insensitive natural ordering.
Numeric runs inside filenames and relative paths are compared as numbers rather
than text, so image9.vsi appears before image10.vsi instead of image10.vsi
appearing next to image1.vsi.

Examples:
  Slide1.vsi
  Slide2.vsi
  Slide9.vsi
  Slide10.vsi
  Slide11.vsi

The recursive image scan, supported file formats, image identifiers, and backend
API response shape are unchanged.
