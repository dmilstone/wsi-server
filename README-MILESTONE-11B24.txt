Milestone 11B.24 — Slide overview synchronization on image selection

Changes
- Selecting a new slide immediately closes an open enlarged label or macro image.
- If the Slide Overview popup is open, its old previews are cleared immediately and replaced with the new slide's label and macro overview.
- Stale label/thumbnail load callbacks from the previous slide are ignored using a request-generation guard.
- Focus is not returned to an obsolete preview control when the lightbox closes because of slide selection.
- Existing manual close, Escape-key, caching, and click-to-enlarge behavior remain unchanged.

Backend APIs are unchanged.
