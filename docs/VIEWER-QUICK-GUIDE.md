# WSI Viewer Quick Guide

Use the production address supplied by your administrator. Development and
staging sites display a warning banner and are for validation only.

Click **?** in the viewer for the live keyboard shortcuts legend. Shift-click
**?** for the Help directory.

## 1. Open and navigate an image

1. Search or filter cases in the upper left, then choose a slide from the list.
2. Drag the image to pan. Scroll or pinch to zoom. Home resets to the fitted view.
3. Each open pane shows its own scale bar when the slide is calibrated.
4. Press **H** to hide or show the left image browser. Its tabs are **Slides**,
   **Image**, **Annotations**, and **Hierarchy**.

## 2. Adjust the displayed channels

Press **C** or open **Brightness & Contrast**. Channel controls change
presentation only; they do not modify the source image.

- Use each channel checkbox to show or hide that channel. An empty colored
  outline means the channel is off; a × inside the outline means it is on. The
  box is never filled with the channel color.
- Select a LUT color and adjust min/max, gamma, and opacity as needed.
- Drag the white min/max lines on the histogram, or the Channel min/max
  sliders. Double-click **Channel min** or **Channel max** to type a value.
- **Reset display** restores the saved/default display.
- **Recompute auto** recalculates automatic intensity settings for the current
  image.
- **View ▸ Show channel viewer** opens a detached window of each visible channel
  plus Composite. It follows the cursor by default. Right-click that window to
  sync to cursor or viewer center, change zoom, or show all channels.

## 3. Multi-view

Right-click the image (not an annotation) or use the **View** menu. The tree
matches QuPath: **Multi-view**, **Cell display**, **Display** (Show analysis,
Brightness/Contrast, overlay 400%–1%), and **Set tool**. Nested lists fly left
or right from the pointer so only one branch is open.

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

## 4. Classify

- Use the **Classify** menu (same tree as QuPath).
- **Object classification** trains, saves, loads, and applies classifiers to
  detections. Draw classified annotations over detections, or right-click an
  annotation and choose **Set class**. Shortcut **Ctrl+Shift+D** / **⌘⇧D**.
- **Pixel classification** trains, saves, loads, and applies classifiers to
  annotations, or creates a thresholder. Shortcut **Ctrl+Shift+P** / **⌘⇧P**.
- **Training images** creates region annotations, stores a training-image
  record, duplicates regions per channel, and splits the catalog into
  train/validation/test.

## 5. Work with annotations

- Use **Annotations** (**A**) to show or hide annotation geometry.
- Use **Names** (**N**) to show or hide annotation names on the image.
- Use **D** to show or hide automated cell detections. **F** and **Shift+F**
  toggle detection and annotation interior fills.
- **View ▸ Cell display** switches detections among nuclei & cell boundaries,
  nuclei only, cell boundaries only, and cell centroids only. In AI Labs, each
  detector (StarDist, Cellpose, QuPath Cell Detection) has a cell-expansion
  method and amount. **Selected annotation** limits detections to the annotation
  outline (not its bounding box). Choose whether nuclei that cross that outline
  are excluded, included in full, or truncated to the border. For fluorescence
  StarDist, leave **Nuclear channel (recommended)**. After Quantify or
  color-coding, **Heat Map** shows those measurement colors.
- Select one annotation to display and edit its name. Enter or leave the name
  field to save a change; Escape cancels an unfinished name edit.
- Tool keys: **M** move, **S** select, **R** rectangle, **O** ellipse, **L**
  line, **P** polygon, **V** polyline, **B** brush, **W** wand, **.** points,
  **Z** zoom. Enter seals a polygon, polyline, or wand.
- Click-drag a **locked** annotation to pan the image; annotations and
  detections stay in register. Unlocked annotations still move.
- Select one annotation, or Shift-click several, then press Delete/Backspace,
  use **Delete**, or right-click the annotation for Lock/Delete or **Set class**.
  If the annotation has detections or other objects inside it, **Yes** keeps
  those descendants, **No** deletes them too, **Cancel** leaves everything.
  Deletion cannot be undone.
- The **Hierarchy** tab lists the image, annotations, and detections as a tree.
  Expand or collapse branches, lock the image or an annotation, and inspect the
  selected object under **Measurements** or **Description**. Filter the table by
  key.

**Important:** annotation saving is asynchronous. After creating, moving,
renaming, or deleting an annotation, pause several seconds before refreshing,
closing the page, or switching images. Visible Saving/Saved feedback is planned
but is not yet available.

## 6. Export, Z-stack, and overview

- **Selected annotation** exports the selected annotation region.
- **Entire View** currently exports the region visible in the viewer. It does
  not necessarily export the entire native slide.
- Native exports are limited to **16,000,000 pixels**. If a visible-region
  export produces no file, zoom in and try again.
- Z-stacks: **View ▸ Open Z-stack controller** (or image right-click) reopens
  the focal-plane window. **Alt+wheel** or arrow keys change focal plane.
  **Ovw** opens the slide-overview thumbnail navigator.
- Double-click the magnification readout to type an exact value.
- Your browser or operating system may ask where to save the exported PNG.
- Confirm that the downloaded file opens before relying on it.

## 7. Environment and safety

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
