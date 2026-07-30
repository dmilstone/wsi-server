Milestone 11B.21 - Fluorescence acquisition designations
========================================================

Fluorescence channel labels now append an acquisition designation derived from
Bio-Formats/OME channel and Olympus VSI cube/filter metadata.

Examples:
  Channel 0 - DAPI
  Channel 1 - FITC
  Channel 2 - TRITC
  Channel 3 - Cy5

Metadata lookup order:
1. OME Channel Name
2. OME Channel Fluor
3. Channel-specific Bio-Formats series metadata
4. Channel-specific Bio-Formats global metadata

Common designations are normalized, including DAPI/Hoechst, FITC, TRITC,
Cy3, Cy5, Cy7, CFP, GFP, YFP, mCherry, and several common Olympus cube names.
When metadata contains a meaningful but unrecognized cube name, the original
name is appended. If no designation can be identified, the existing generic
label (Channel N) remains unchanged.

RGB/H&E images retain their existing channel behavior.
