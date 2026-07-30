WSI Server — Milestone 11B
==========================

This milestone builds on the working Milestone 11A interface. It changes only
src/main/resources/static/index.html. No Java source, REST endpoint, image
reader, tile renderer, or server configuration has been changed.

New interaction features
------------------------
- Collapsible image-browser and display-control panels.
- Drag-resizable side panels, with widths saved in browser localStorage.
- Compact viewer toolbar with Home, Fit, and browser Full Screen controls.
- Presentation mode that hides the application chrome and side panels.
- Larger channel sliders with continuously updated, formatted values.
- Per-channel visual color indicators tied to the selected LUT.
- One-click reset for opacity and gamma.
- Dimmed channel cards when a channel is disabled.
- Image-information card showing dimensions, channels, resolution levels,
  and tile size.
- Status-bar zoom and image-coordinate readouts.

Preserved behavior
------------------
- Existing REST API and tile URL format.
- Per-session server display state.
- Browser localStorage display preferences.
- Existing response sequencing and stale-response protection.
- Existing object-identity fix for channel event handlers.

Testing
-------
The embedded JavaScript was parsed with Node.js successfully. This environment
could not perform a Maven build if the wrapper needed external downloads.
Because this milestone modifies only static HTML/CSS/JavaScript, test locally by
restarting Spring Boot and hard-refreshing the browser.

Suggested checks
----------------
1. Open several images and verify tile rendering.
2. Change visibility, LUT, opacity, black, white, and gamma.
3. Resize both side panels and refresh the page; widths should persist.
4. Collapse and restore each panel.
5. Test Home, Fit, Full Screen, and Presentation mode.
6. Move the pointer over the image and confirm image coordinates update.
7. Confirm a second browser session retains independent server display state.
