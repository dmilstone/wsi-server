Milestone 11B.10 — Block-cached pixel sampling

Changes
-------
- Replaced one-HTTP-request-per-pixel sampling with 64 x 64 full-resolution
  pixel-block requests.
- Each returned block contains the raw UINT16 values for every channel.
- The browser caches up to 128 blocks and performs pixel lookup locally.
- Once a block is loaded, pixel values update immediately for every pointer
  movement inside that block, without another HTTP request or Bio-Formats read.
- Duplicate requests for the same block are coalesced.
- Existing click-to-zoom disabling, zoom behavior, and fixed-width status layout
  are preserved.

Remaining limitation
--------------------
The first pointer entry into an uncached 64 x 64 block still requires one
Bio-Formats read and one local HTTP response. This initial load cannot be
strictly zero-latency because the source data has not yet been decoded. All
subsequent samples within the cached block are local and immediate.
