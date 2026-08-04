# WSI Viewer Quick Guide

Use the production address supplied by your administrator. Development and
staging sites display a warning banner and are for validation only.

## 1. Open and navigate an image

1. Choose an image in **Sample images** on the left.
2. Drag the image to pan.
3. Scroll or pinch to zoom.
4. Use the viewer controls to reset the view or enter fullscreen.
5. Collapse the side panels when you need more viewing space.

## 2. Adjust the displayed channels

The **Channels** panel controls presentation only; it does not modify the source
image.

- Use each channel checkbox to show or hide that channel.
- Select a LUT color and adjust **Opacity** as needed.
- **Reset display** restores the saved/default display.
- **Recompute auto** recalculates automatic intensity settings for the current
  image.

## 3. View and edit annotations

The lower floating palette contains annotation tools.

- Use **Annotations** to show or hide annotation geometry.
- Use **Names** to show or hide annotation names on the image.
- Select one annotation to display and edit its name.
- Enter or leave the name field to save a change; Escape cancels an unfinished
  name edit.
- Use the drawing tools to create annotations and the available delete control
  to remove the selected annotation.

**Important:** annotation saving is asynchronous. After creating, moving,
renaming, or deleting an annotation, pause several seconds before refreshing,
closing the page, or switching images. Visible Saving/Saved feedback is planned
but is not yet available.

## 4. Export an image region

Open **Export** in the upper floating palette.

- **Selected annotation** exports the selected annotation region.
- **Entire View** currently exports the region visible in the viewer. It does
  not necessarily export the entire native slide.
- Native exports are limited to **16,000,000 pixels**. If a visible-region
  export produces no file, zoom in and try again.
- Your browser or operating system may ask where to save the exported PNG.
- Confirm that the downloaded file opens before relying on it.

## 5. Environment and safety

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
