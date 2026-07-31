Milestone 12.1B.2 render fix

Backend annotations were being loaded into the Annotorious store, but the
programmatically reconstructed geometry omitted the required bounds object.
Annotorious therefore counted the annotations but could not reliably render
them after an image switch or reload.

This version adds geometry.bounds (minX, minY, maxX, maxY) when converting the
backend annotation model to the Annotorious native model.
