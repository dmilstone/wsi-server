# WSI Viewer Quick Guide

Use the production address supplied by your administrator. Development and
staging sites display a warning banner and are for validation only.

Click **?** in the viewer for the live keyboard shortcuts legend. Shift-click
**?** for the Help directory.

## 1. Open and navigate an image

1. Search or filter cases in the upper left, then choose a slide from the list.
2. Drag the image to pan. Scroll or pinch to zoom. Home resets to the fitted view.
3. Each open pane shows its own scale bar when the slide is calibrated.
4. Press **H** to hide or show the left image browser.

## 2. Adjust the displayed channels

Press **C** or open **Brightness & Contrast**. Channel controls change
presentation only; they do not modify the source image.

- Use each channel checkbox to show or hide that channel.
- Select a LUT color and adjust min/max, gamma, and opacity as needed.
- **Reset display** restores the saved/default display.
- **Recompute auto** recalculates automatic intensity settings for the current
  image.
- **View ▸ Show channel viewer** opens a detached window of each visible channel
  plus Composite. It follows the cursor by default. Right-click that window to
  sync to cursor or viewer center, change zoom, or show all channels.

## 3. Multi-view

Right-click the image (not an annotation) or use the **View** menu.

- Set grid size (1×1, 1×2, 2×1, 2×2, 3×3), or add/remove a row or column. Close
  images in a row or column before removing it.
- Click a pane to make it active (red outline), then choose a slide or drag a
  slide from the list onto that pane.
- A newly opened image fits the pane it occupies. Changing the grid re-fits open
  images to their new cells.
- **Synchronize viewers** (**Ctrl+Shift+S** / **⌘⇧S** / **Ctrl+Alt+S**) turns on
  automatically when two or more panes have images. **Match viewer resolutions**
  matches magnification using pixel size.
- **Close viewer** clears the active pane. **Detach** / **Attach** moves a pane
  into its own window when the grid has more than one cell.

## 4. View and edit annotations

- Use **Annotations** (**A**) to show or hide annotation geometry.
- Use **Names** (**N**) to show or hide annotation names on the image.
- Use **D** to show or hide automated cell detections. **F** and **Shift+F**
  toggle detection and annotation interior fills.
- Select one annotation to display and edit its name.
- Enter or leave the name field to save a change; Escape cancels an unfinished
  name edit.
- Tool keys: **M** move, **S** select, **R** rectangle, **O** ellipse, **L**
  line, **P** polygon, **V** polyline, **B** brush, **W** wand, **.** points,
  **Z** zoom. Enter seals a polygon, polyline, or wand.
- Select one annotation, or Shift-click several, then press Delete/Backspace,
  use **Delete**, or right-click the annotation for Lock/Delete. Deletion cannot
  be undone.

**Important:** annotation saving is asynchronous. After creating, moving,
renaming, or deleting an annotation, pause several seconds before refreshing,
closing the page, or switching images. Visible Saving/Saved feedback is planned
but is not yet available.

## 5. Export, Z-stack, and overview

- **Selected annotation** exports the selected annotation region.
- **Entire View** currently exports the region visible in the viewer. It does
  not necessarily export the entire native slide.
- Native exports are limited to **16,000,000 pixels**. If a visible-region
  export produces no file, zoom in and try again.
- Z-stacks: **Alt+wheel** or arrow keys change focal plane. **Ovw** opens the
  slide-overview thumbnail navigator.
- Double-click the magnification readout to type an exact value.
- Your browser or operating system may ask where to save the exported PNG.
- Confirm that the downloaded file opens before relying on it.

## 6. Environment and safety

- Production normally has no environment warning banner.
- A **DEVELOPMENT** or **STAGING** banner means validation only and not clinical
  use.
- Use only images and annotations appropriate for the environment you were
  assigned.
- Do not copy sensitive production material into development or staging.

## If something goes wrong

Report the image name and approximate time—but do not send clinical or sensitive
image data unless your approved support process allows it—when you encounter:

- a blank or distorted image;
- missing or unexpectedly changed annotations;
- an export that fails or cannot be opened;
- a login or authorization error;
- an unusually long delay.

Before reporting a display problem, try one normal browser refresh. Do not
refresh while a recent annotation change may still be saving.
