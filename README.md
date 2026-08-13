# Dolly

**Cinematic product demos in the browser.**

Dolly is a Chrome extension that turns a live web page into a product demo. Unlike a screen recorder, it doesn't record your screen. It renders the web page frame by frame.

## ![Dolly Demo](./Dolly_Product_Demo.gif)

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [How a shot is built](#how-a-shot-is-built)
- [The script API](#the-script-api)
- [Exporting](#exporting)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [How it works](#how-it-works)
- [Permissions](#permissions)
- [Development](#development)
- [Known limitations](#known-limitations)
- [Future enhancements](#future-enhancements)

---

## Features

**Rendered frames, not screen recordings.** Dolly builds every frame from the live page, applying CSS scale to it. This keeps text and UI sharp even when you zoom in 20× on a button.

**Timeline-based editor.** Add Focus Regions, cursor keyframes, and script keyframes to the timeline. Dolly automatically handles the zoom and pan between regions, so the camera smoothly moves instead of cutting between shots.

**High-quality exports.** Export up to 4K at 60fps, regardless of your monitor's resolution. Every frame is rendered separately, so a slow machine or a heavy page won't cause dropped frames.

**Scripted moments.** JavaScript keyframes run directly inside the page, with access to its DOM and globals. Dolly also includes `Dolly.type()` for typing effects and `Dolly.animate()` for animations using [animate.css](https://animate.style).

## Requirements

- **Google Chrome**, or another Chromium-based browser such as Brave, Edge, or Vivaldi. Dolly uses the Chrome DevTools Protocol to control and capture the page. Firefox does not provide the APIs needed for exporting.
- Nothing else is needed to install a release. Building from source requires **Node.js 22+** and **pnpm**.

## Installation

Dolly is not on the Chrome Web Store yet, so it needs to be installed as an unpacked extension.

### From a release

1. Download the latest version from the [Releases page](https://github.com/Divyesh06/Dolly/releases).
2. Unzip it somewhere you want to keep it. Chrome loads Dolly from this folder, so don't move or delete it afterwards.
3. Open `chrome://extensions` and turn on **Developer mode** in the top right.
4. Click **Load unpacked** and select the unzipped folder.

To update Dolly, download the new release, replace the old folder's contents, and click the reload button on Dolly's card in `chrome://extensions`.

### From source

```bash
git clone https://github.com/Divyesh06/Dolly.git
cd Dolly
pnpm install
pnpm build
```

Load `.output/chrome-mv3` using steps 3 and 4 above. `pnpm zip` creates the same ZIP file used for releases at `.output/dolly-<version>-chrome.zip`.

To update, run `git pull && pnpm build`, then click the reload button.

Either way, Dolly's icon will appear in the toolbar. Pin it so it's easy to access.

## Quick start

1. Open the page you want to demo. It must be a normal `http://`, `https://`, or `file://` page. Chrome doesn't allow extensions to run on `chrome://` pages, the Web Store, or built-in viewers.

2. Click the **Dolly** toolbar icon.

   Your tab is moved into a clean popup window without the address bar or tab strip. This window becomes the video frame, while the Dolly controller opens beside it. The tab itself is moved rather than reopened, so its current state is preserved.

3. Choose an aspect ratio: 16:9, 9:16, 1:1, or a custom size.

4. On the timeline, click **+ Focus Region**. A rectangle will appear on the page. Move and resize it around whatever you want the camera to show.

5. Add more regions. Dolly will smoothly move the camera between them.

6. Press **Play** to preview the demo.

7. Click **Export**, choose a resolution and frame rate, then click **Export Video**. The MP4 will be downloaded when the export finishes.

Closing the controller window ends the session. Dolly removes its overlay, restores the page, and moves the tab back to its original window.

## How a shot is built

The timeline has three tracks.

### Focus regions — the camera

A focus region tells Dolly what part of the page the camera should focus on. Dolly calculates the required zoom and position, then smoothly moves between consecutive regions.

Move a region on the timeline to change when it starts, or drag its edges to change how long it stays on screen.

Regions can also point to content that is outside the current viewport. Dolly moves the camera there without scrolling the page.

### Cursor — the pointer

Cursor keyframes add a pointer to the shot. The cursor smoothly moves between positions and can use one of four styles: arrow, pointer, click, or text.

The cursor is drawn inside the page, so it zooms along with the rest of the content.

The cursor is only visual. It does not generate real mouse events, so it won't trigger hover states on the page.

### Script — JavaScript keyframes

A script keyframe runs JavaScript inside the page when the playhead reaches it. It has access to the page's DOM and globals.

Double-click the diamond on the timeline to open the editor.

Scripts run at a single point in time and are **synchronous**. Once the script finishes, the shot continues. If you want something to happen later, put it on another keyframe.

For actions that happen over a period of time, use the helpers below.

## The script API

Script keyframes have access to a `Dolly` global. Both helpers start their work and return immediately. They stay synced with the shot even when an export takes much longer than the final video.

### `Dolly.type(target, text, ms, options?)`

Types text into an element one character at a time over `ms`.

```js
Dolly.type("#search", "wireless headphones", 1200);
Dolly.type(document.querySelector(".note"), "Hello", 800, { clear: true });
```

`target` can be a CSS selector or an element. It works with `<input>`, `<textarea>`, `contenteditable`, and normal elements.

Dolly uses the element's native setter and sends an `input` event, so frameworks such as React see the change correctly. A `change` event is sent once typing finishes.

| Option  | Default | Meaning                         |
| ------- | ------- | ------------------------------- |
| `clear` | `false` | Empty the element before typing |
| `focus` | `true`  | Focus the element before typing |

### `Dolly.animate(target, effect, ms, options?)`

Plays an [animate.css](https://animate.style) effect over `ms`.

```js
Dolly.animate(".price-tag", "bounceIn", 700);
Dolly.animate("#toast", "fadeOutUp", 500, { delay: 200 });
```

All 97 animate.css effects are supported. You can use their normal names with or without the `animate__` prefix.

The animate.css stylesheet is only added when a shot uses a script keyframe, so shots without scripts don't load it.

| Option   | Default    | Meaning                                                    |
| -------- | ---------- | ---------------------------------------------------------- |
| `delay`  | `0`        | Milliseconds to wait before starting                       |
| `repeat` | `1`        | Number of times to play, or `'infinite'`                   |
| `hold`   | exits only | Keep the final state of the animation instead of reverting |

`hold` defaults to `true` for exit animations (the `…Out` effects and `hinge`), so an element that fades out stays hidden. For other animations, it defaults to `false`.

## Exporting

Choose a resolution (720p, 1080p, 2K, or 4K) and a frame rate (30 or 60 fps).

The output dimensions depend on the selected resolution and aspect ratio. For example:

- 1080p at 16:9 → 1920×1080
- 1080p at 9:16 → 1080×1920

During an export, a curtain window covers the page. The page may flicker while Dolly captures frames, which is normal and is why the page is covered.

The curtain shows the export progress and includes a **Stop** button. You can also press <kbd>Esc</kbd> to stop the export.

Exporting takes longer than the final video's runtime because Dolly renders every frame separately instead of recording in real time. This is what prevents dropped frames, even when the page is heavy or your machine is slow.

The final video is encoded as H.264 in an MP4 and downloaded when the export finishes.

If an export is cancelled or fails, Dolly doesn't create a partial video.

**Close DevTools on the page you are recording.** Chrome only allows one debugger connection per tab, and Dolly needs that connection during export.

## Keyboard shortcuts

These work in both the controller and the page.

| Shortcut                                                                              | Action                           |
| ------------------------------------------------------------------------------------- | -------------------------------- |
| <kbd>Ctrl/Cmd</kbd>+<kbd>Z</kbd>                                                      | Undo                             |
| <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> or <kbd>Ctrl/Cmd</kbd>+<kbd>Y</kbd> | Redo                             |
| <kbd>Ctrl/Cmd</kbd>+<kbd>C</kbd> / <kbd>X</kbd> / <kbd>V</kbd>                        | Copy / cut / paste the selection |
| <kbd>Delete</kbd> or <kbd>Backspace</kbd>                                             | Delete the selection             |
| <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>→</kbd>                                            | Swap with the neighbouring clip  |
| <kbd>Esc</kbd>                                                                        | Stop an export                   |

## How it works

Here are the main technical ideas behind Dolly.

**The camera is a CSS transform on the page's root**, rather than a crop of a screenshot. Dolly sets the tab's viewport to the exact frame size and uses the required device scale for the output. This means a 4K export actually renders 4K pixels instead of taking a smaller screenshot and scaling it up. Frames are cropped, never resampled.

**The page's clock is controlled during export.** Exporting a video frame by frame is much slower than real time. Without controlling the page's clock, animations and other time-based code would run at the wrong speed.

Dolly replaces `performance.now`, `Date`, timers, and `requestAnimationFrame`, and also pauses and moves CSS animations and transitions to the correct point in time. The browser still renders each frame normally; only the time seen by the page is controlled.

**Dolly's UI runs separately from the page.** The editor is placed inside a shadow root in an isolated world. This prevents the page's CSS from affecting Dolly's UI and keeps the page's clock changes away from the capture loop.

**Every capture step has a timeout.** If a page stops responding, Dolly won't wait forever. The export continues as best it can and reports the problem in the controller's console.

## Permissions

| Permission        | Why                                                                         |
| ----------------- | --------------------------------------------------------------------------- |
| `debugger`        | Control the viewport, capture frames, and handle page dialogs during export |
| `scripting`       | Add Dolly's UI, run script keyframes, and control the page clock            |
| `tabs`, `storage` | Move the recorded tab into its own window and remember the session          |
| `<all_urls>`      | Allow Dolly to work on whatever page you want to demo                       |

The overlay is **not** added to every page automatically. Dolly only injects it when you start a session.

Nothing is sent anywhere. The page capture, video encoding, and final download all happen on your machine.

## Development

```bash
pnpm dev        # development build with hot reload
pnpm build      # production build into .output/chrome-mv3
pnpm compile    # typecheck (tsc --noEmit)
pnpm zip        # the release artifact,
 .output/dolly-<version>-chrome.zip
pnpm icons      # regenerate icon PNGs from logo.svg
```

Built with [WXT](https://wxt.dev), [Preact](https://preactjs.com), WebCodecs, and [mp4-muxer](https://github.com/Vanilagy/mp4-muxer).

Rough layout:

```text
entrypoints/     background worker, overlay content script, controller/editor/curtain pages
components/
  controller/    session, timeline state, capture, encoding, page-side clock and API
  overlay/       what Dolly draws inside the recorded page
  timeline/      the timeline UI
lib/             camera, cursor and track maths, protocol, shared helpers
```

## Known limitations

- **Chromium only.** The export pipeline depends on the Chrome DevTools Protocol.
- **One tab per session**, and DevTools must be closed on it.
- **`<video>`\*\*** elements and animated GIFs are not time-controlled.\*\* They play in real time, so they can run faster than expected during an export.
- **The cursor does not fire real mouse events**, so the page will not show hover or click reactions under it.
- **A page that busy-waits on the clock** (`while (Date.now() - t < n) {}`) can stall a frame during export. Dolly limits the wait and reports the problem, but that frame may be repeated.
- **The page clock can stay behind real time after an export** by however much the export was ahead of the video. Reloading the page resets it.

## Future enhancements

**A dedicated application instead of an extension.** An extension can control the page's view of time, but it can't control the browser's frame clock. Because of this, Dolly currently has to prepare and capture every frame separately. `HeadlessExperimental.beginFrame` can render a frame at an exact timestamp and return it in one call, which could make the entire export process deterministic. This would require bundling Chromium.

**Saving your work.** There is currently no way to save a session, so every shot has to be created from scratch.

**Type and animation effects on the timeline.** These are currently only available through script keyframes. They could eventually become their own timeline clips.
