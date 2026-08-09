# Dolly

**Cinematic product demos in the browser.**

Dolly is a Chrome extension that turns a live web page into a cinematic product
demo. It takes a fundamentally different approach from a screen recorder: it
renders the page rather than filming it.

> **Screenshot / demo GIF goes here.**

---

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

**Rasterized frames, not screen recordings.** Every frame is composed from the
live DOM at the exact device density the output needs, so text stays sharp at 4K
even with the camera 20× into a button.

**Timeline-based editor.** Focus regions, cursor and script keyframes compose
into a single editable sequence. Draw a region over what matters and Dolly works
out the zoom and pan that frames it, easing between regions rather than cutting.

**High-quality exports.** Up to 4K at 60fps, whatever your machine's native
resolution. Frames are rendered one at a time rather than in real time, so
nothing is lost to a dropped frame or a slow machine.

**Scripted moments.** JavaScript keyframes run in the page's own world — full
access to its DOM and globals — edited in a CodeMirror window. Two helpers play
out over time and stay locked to the shot: `Dolly.type()` types character by
character, and `Dolly.animate()` plays any of 97
[animate.css](https://animate.style) effects.

## Requirements

- **Google Chrome**, or another Chromium browser — Brave, Edge, Vivaldi. Dolly
  drives the page through the Chrome DevTools Protocol, which Firefox has no
  equivalent for; the `dev:firefox` scripts exist, but the export pipeline will
  not work there.
- Nothing else, to install a release. Building from source additionally needs
  **Node.js 22+** and **pnpm** (WXT requires it).

## Installation

Dolly is not on the Chrome Web Store yet, so it installs unpacked. Chrome only
accepts an unpacked folder from outside the store — it refuses `.crx` files
dropped onto the extensions page — so both routes below end the same way.

### From a release

1. Download latest version from the
   [Releases page](https://github.com/Divyesh06/Dolly/releases).
2. Unzip it somewhere permanent. Chrome loads the extension from that folder
   every time it starts, so moving or deleting it later disables Dolly.
3. Open `chrome://extensions` (or click on puzzle icon in toolbar and then on Manage Extensions) and turn on **Developer mode**, top right.
4. Click **Load unpacked** and select the unzipped folder.

To update, download the new release, replace the folder's contents, and hit the
reload arrow on Dolly's card in `chrome://extensions`.

### From source

```bash
git clone https://github.com/Divyesh06/Dolly.git
cd Dolly
pnpm install
pnpm build
```

Load `.output/chrome-mv3` using steps 3 and 4 above. `pnpm zip` packages that
same build into `.output/dolly-<version>-chrome.zip`, which is exactly what a
release contains.

To update, `git pull && pnpm build`, then hit the reload arrow.

Either way, Dolly's icon now appears in the toolbar. Pin it — you start every
session from there.

## Quick start

1. Open the page you want to demo. It has to be an ordinary `http://`,
   `https://` or `file://` page — Chrome blocks extensions on `chrome://` URLs,
   the Web Store, and built-in viewers.
2. Click the **Dolly** toolbar icon.

   Your tab moves into a clean popup window with no omnibox or tab strip — that
   is the frame — and the Dolly controller opens beside it. The tab is _moved_,
   not reopened, so whatever state the page was in is preserved.

3. Pick an aspect ratio (16:9, 9:16, 1:1, or custom). The page window resizes so
   its viewport is exactly the frame.
4. On the timeline, click **+ Focus Region**. A rectangle appears on the page —
   drag and resize it over whatever the camera should be looking at.
5. Add a few more. Dolly eases the camera from one to the next in order.
6. Press **Play** to preview.
7. Click **Export**, choose a resolution and framerate, and hit **Export Video**.
   The MP4 downloads when it finishes.

Closing the controller window ends the session: the overlay is removed, the page
is put back the way it was, and your tab returns to the window it came from.

## How a shot is built

The timeline has three tracks.

### Focus regions — the camera

A focus region is a rectangle in _document_ space. Dolly works out the zoom and
pan that frames it and eases between consecutive regions, so the shot reads as a
camera move rather than a cut. Drag a region's bar on the timeline to change when
it happens, and its edges to change how long it holds.

Regions can sit anywhere in the document, including content scrolled out of
view — the camera pans there without the page scrolling.

### Cursor — the pointer

Cursor keyframes give the shot a pointer that glides between positions, with its
own size and one of four glyphs (arrow, pointer, click, text). It is drawn inside
the page, so the camera magnifies it along with the content.

The cursor is artwork: it does not generate real mouse events, so the page will
not show hover states under it.

### Script — JavaScript keyframes

A script keyframe runs a snippet in the page's own world at the instant the
playhead reaches it, with full access to the page's DOM and globals. Double-click
the diamond on the timeline to open the editor.

Snippets are **synchronous** — they run at one instant and the shot moves on. To
make something happen later, put it on its own keyframe at that time. For work
that needs to play out _over_ time, use the helpers below.

## The script API

Script keyframes get a `Dolly` global. Both helpers schedule their work and
return immediately, and both stay in step with the shot no matter how long the
export takes to render each frame.

### `Dolly.type(target, text, ms, options?)`

Types text into an element, one character at a time, over `ms`.

```js
Dolly.type("#search", "wireless headphones", 1200);
Dolly.type(document.querySelector(".note"), "Hello", 800, { clear: true });
```

`target` is a CSS selector or an element. Works with `<input>`, `<textarea>`,
`contenteditable`, and plain elements. Values are written through the native
setter and followed by an `input` event, so React and other frameworks that own
the field see the change instead of overwriting it; `change` fires once at the
end.

| Option  | Default | Meaning                                                 |
| ------- | ------- | ------------------------------------------------------- |
| `clear` | `false` | Empty the element first, instead of typing onto the end |
| `focus` | `true`  | Focus the element before typing                         |

### `Dolly.animate(target, effect, ms, options?)`

Plays an [animate.css](https://animate.style) effect over `ms`.

```js
Dolly.animate(".price-tag", "bounceIn", 700);
Dolly.animate("#toast", "fadeOutUp", 500, { delay: 200 });
```

All 97 effects are available, named exactly as they are on
[animate.style](https://animate.style), with or without the `animate__` prefix.
The stylesheet is injected on the first script keyframe of a take, so shots
without scripts pay nothing for it.

| Option   | Default    | Meaning                                            |
| -------- | ---------- | -------------------------------------------------- |
| `delay`  | `0`        | Milliseconds to wait before starting               |
| `repeat` | `1`        | Iteration count, or `'infinite'`                   |
| `hold`   | exits only | Keep the effect's final state instead of reverting |

`hold` defaults to `true` for exit effects (the `…Out` family and `hinge`) so a
faded-out element stays gone, and `false` for everything else.

## Exporting

Choose a resolution (720p, 1080p, 2K, 4K) and framerate (30 or 60 fps). The
output dimensions come from the resolution and your aspect ratio — 1080p at 16:9
is 1920×1080, at 9:16 it is 1080×1920.

While an export runs, a curtain window covers the page. The page flickers as
frames are grabbed, which is why it is covered — you are not missing anything.
The curtain shows progress and a **Stop** button; <kbd>Esc</kbd> also stops.

Export takes considerably longer than the video's runtime: each frame is posed,
rendered and screenshotted individually rather than in real time. That is the
point — nothing is dropped, no matter how heavy the page.

The file is encoded as H.264 in an MP4 and downloaded when it completes. A
cancelled or failed export produces no file, deliberately: a partial video that
looks finished is worse than a clear failure.

**Close DevTools on the page you are recording.** Chrome allows only one debugger
per tab, and Dolly needs it for the export.

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

Four decisions worth knowing about if you are reading the source.

**The camera is a CSS transform on the page's root**, not a crop of a
screenshot. The tab's viewport is emulated to exactly the frame's CSS size at
whatever device scale the requested output needs, so a 4K export rasters real 4K
pixels rather than upscaling a 1080p grab. Frames are cropped, never resampled.

**Page time is virtualised during export.** A capture loop runs far slower than
real time — each frame costs as long as posing, rastering and screenshotting
take — so anything the page animates on its own clock would come out
fast-forwarded. Dolly installs a clock in the page's own JavaScript world that
replaces `performance.now`, `Date`, the timers and `requestAnimationFrame`, and
pauses and seeks every running CSS animation and transition by hand. The renderer
keeps running on real time, so it still commits, rasters and answers
screenshots — only the page's _view_ of time is stepped, one video frame at a
time.

**Dolly's editing UI lives in a shadow root in an isolated world**, so the page's
styles cannot leak into it and the page-side clock patch cannot touch its
`requestAnimationFrame` — which is what the capture loop uses to know a frame has
settled before grabbing it.

**Every step of the capture loop is bounded.** A page that stops answering
degrades the export into something slow and reports why, rather than hanging.
Stalls are named in the controller's console.

## Permissions

| Permission        | Why                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `debugger`        | Viewport and density emulation, per-frame screenshots, and answering the page's modal dialogs during a capture |
| `scripting`       | Injecting the overlay, the script keyframes, and the page-side clock                                           |
| `tabs`, `storage` | Moving the recorded tab into its own window and remembering the session                                        |
| `<all_urls>`      | Dolly has to work on whatever page you are demoing                                                             |

The overlay is **not** declared as a content script — it is injected only when
you start a session, so pages you are not recording never run Dolly's code.
Nothing is sent anywhere: the capture, the encoding and the download all happen
on your machine.

## Development

```bash
pnpm dev        # development build with hot reload
pnpm build      # production build into .output/chrome-mv3
pnpm compile    # typecheck (tsc --noEmit)
pnpm zip        # the release artifact, .output/dolly-<version>-chrome.zip
pnpm icons      # regenerate icon PNGs from logo.svg
```

Built with [WXT](https://wxt.dev), [Preact](https://preactjs.com), WebCodecs and
[mp4-muxer](https://github.com/Vanilagy/mp4-muxer).

Rough layout:

```
entrypoints/     background worker, overlay content script, controller/editor/curtain pages
components/
  controller/    session, timeline state, capture, encoding, page-side clock and API
  overlay/       what Dolly draws inside the recorded page
  timeline/      the timeline UI
lib/             camera, cursor and track maths, protocol, shared helpers
```

## Known limitations

- **Chromium only.** The export pipeline depends on the DevTools Protocol.
- **One tab per session**, and DevTools must be closed on it.
- **`<video>` elements and animated GIFs are not time-controlled.** They play on
  real time, so they will run fast in an export.
- **The cursor does not fire real mouse events**, so the page will not show hover
  or click reactions under it.
- **A page that busy-waits on the clock** (`while (Date.now() - t < n) {}`) can
  stall a frame during export; it is bounded and reported, but that frame may
  repeat.
- **Page clocks stay behind real time after an export** by however long the
  export outran the video, until the page is reloaded.

## Future enhancements

**A dedicated application instead of an extension.** An extension can control
the page's view of time, but not the browser's frame clock, so every frame still
has to be posed and screenshotted separately. `HeadlessExperimental.beginFrame`
renders a frame at an exact timestamp and returns it in one call, which would
make the whole pipeline deterministic. This would required a bundled chromium.

**Saving your work.** There is currently no way to save a session, so every shot
starts from scratch.

**Type and animation effects on the timeline.** Both are only reachable from a
script keyframe today; they belong on the timeline as first-class clips.
