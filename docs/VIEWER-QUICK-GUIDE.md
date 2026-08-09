# WSI Viewer Quick Guide

Use the production address supplied by your administrator.

## Header and toolbar

- All viewer tools are compact icon buttons in one header toolbar row. Hover or
  focus a button to see its name and short description.
- **Help** (the rightmost `?` icon) opens the in-viewer quick guide.

## 1. Open and navigate an image

1. Choose an image in **Sample images** on the left.
2. Use the **Images** toolbar icon to show or hide the image browser. There is
   no separate Open button.
3. Drag the slide to pan; scroll or pinch to zoom.
4. Use **Zoom in**, **Zoom out**, or **Home** (reset to the initial home zoom).
5. Collapse the side panels when you need more viewing space.

## 2. Adjust the displayed channels

Use the **Settings** toolbar icon to show or hide the **Channels** panel on the
right.

- Use each channel checkbox to show or hide that channel.
- Select a LUT color and adjust **Opacity** as needed.
- **Reset display** restores the saved/default display.
- **Recompute auto** recalculates automatic intensity settings for the current
  image.

## 3. Create, select, and edit annotations

- Click **Rectangle** to draw a rectangular annotation; click again to stop
  drawing.
- Click an annotation directly to select it.
- Press **Delete** or **Backspace** to remove the selected annotation.
- Use **Annotations** and **Names** in the toolbar to show or hide geometry and
  on-slide name labels.
- With one annotation selected, click its on-slide name label to edit inline.
  Enter or leave the name field to save a change; **Escape** cancels an
  unfinished name edit.

**Important:** annotation saving is asynchronous. After creating, moving,
renaming, or deleting an annotation, pause several seconds before refreshing,
closing the page, or switching images. Visible Saving/Saved feedback is planned
but is not yet available. Annotations are stored per image and should persist
when you switch away and return.

## 4. Export an image region

Use the two export icons in the header toolbar:

- **Export visible region** exports the area currently visible in the viewer at
  native resolution. It does not necessarily export the entire native slide.
- **Export selected annotation** exports the selected rectangle (select exactly
  one annotation first).

Download filenames use the slide name plus `-region.png`, or
`-annotation-name.png` when the annotation has a name.

Native exports are limited to **16,000,000 pixels**. If the region is too large,
the viewer shows an actionable **Export failed** dialog asking you to zoom in or
choose a smaller region. Reduced-resolution export fallback is planned but not
yet available.

Your browser or operating system may ask where to save the exported PNG.
Confirm that the downloaded file opens before relying on it.

## 5. Slide overview, full screen, and presentation

- **Slide overview** opens the slide label and whole-slide thumbnail when
  available for the current image.
- **Full screen** enters or exits browser full-screen mode.
- **Presentation** hides the header, toolbar, side panels, and status bar so the
  slide uses more of the window. Click **Exit presentation** or press
  **Escape** to leave. This is not yet a dedicated clean-view layout (future
  roadmap).

## 6. Environment and safety

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
