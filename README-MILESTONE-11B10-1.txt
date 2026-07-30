Milestone 11B.10.1 — Pixel block compilation fix

Fixes a missing import in BioFormatsTileService:

    import wsi_server.api.PixelBlockResponse;

PixelBlockResponse.java was already included in Milestone 11B.10, but the
service class did not import it from the wsi_server.api package. This caused
javac to report "cannot find symbol: class PixelBlockResponse".

No API or frontend behavior changed. The 64x64 block-cached pixel sampling
from Milestone 11B.10 is preserved.
