Milestone 11B.23 — Slide overview availability-message fix

Fixed the Slide overview popup so the unavailable messages are hidden whenever the corresponding label or macro image loads successfully.

Cause:
- The .overview-error CSS rule set display:grid.
- That author rule overrode the browser's default display:none behavior for elements carrying the hidden attribute.
- JavaScript correctly set errorElement.hidden = true, but the message remained visible.

Change:
- Added an explicit .overview-error[hidden] { display:none; } rule.
- Existing independent label/macro load handling and click-to-enlarge behavior are unchanged.
- No backend or API changes.
