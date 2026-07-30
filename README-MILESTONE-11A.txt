WSI Server — Milestone 11A: Modernized User Interface

Scope
-----
This milestone changes only src/main/resources/static/index.html.
No Java classes, REST endpoints, tile-rendering logic, or persistence behavior are changed.

Main improvements
-----------------
- Clear application header and current-image context
- Larger, more readable system typography
- Higher-contrast neutral dark palette
- Wider image and display panels
- Better spacing and larger click targets
- Clear selected-image state
- Channel cards with prominent visibility controls
- Opacity kept visible; black, white, and gamma moved under Advanced controls
- Persistent bottom status bar
- Responsive single-column fallback for narrow screens
- Keyboard focus indicators and improved accessibility labels

Installation
------------
Replace this file in your project:

  src/main/resources/static/index.html

Then restart the Spring Boot application. A browser hard refresh may be needed:

  macOS Safari: Option-Command-R
  Chrome/Edge: Shift-Command-R or Ctrl-Shift-R

Rollback
--------
The software baseline is preserved by Git tag v1.0. You can also restore the previous
index.html from Git if needed.
