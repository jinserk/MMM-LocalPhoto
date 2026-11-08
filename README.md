# MMM-LocalPhoto

A [MagicMirror²](https://github.com/MagicMirrorOrg/MagicMirror) module that shows **photos and videos from a local folder** as a slideshow. You don't need a cloud account, S3 or API keys: copy files into the folder and they show up.

The display code is based on [MMM-S3Photos](https://github.com/uphillcheddar/MMM-S3Photos) by uphillcheddar (MIT). The AWS S3/Lambda part has been replaced by a local folder scanner.

## Features

- Photos (`jpg jpeg png gif webp avif bmp svg`) and videos (`mp4 webm ogg ogv mov m4v mkv`), including subfolders.
- **New, changed and deleted files are picked up automatically.** The folder is watched, with a periodic rescan as a fallback, and the item on screen keeps playing.
- **Videos play to the end** (up to `video.maxDurationSeconds`); photos show for `displayDurationSeconds`.
- Display styles: `wallpaper` (cover), `fill`, `fit-display` (whole image, optional blurred background), `absolute` (fixed size).
- Order: `random_dedupe` (everything once before repeating, kept across reloads), `random`, `newest_first`, `oldest_first`.
- Optional per-folder attribution text.
- No npm dependencies.

## Install

```sh
cd ~/MagicMirror/modules
git clone https://github.com/jinserk/MMM-LocalPhoto.git
```

Put your files in `MMM-LocalPhoto/media/`, or point `mediaDir` at any folder.

## Config

```js
{
	module: "MMM-LocalPhoto",
	position: "fullscreen_below",
	config: {
		mediaDir: "/home/pi/Pictures/mirror", // absolute, or relative to the module folder
		displayStyle: "fit-display",
		applyBlur: true,
		displayDurationSeconds: 30,
		displayOrder: "random_dedupe",
		video: { muted: true, maxDurationSeconds: 120 }
	}
}
```

| Option | Default | Description |
|---|---|---|
| `mediaDir` | `"media"` | Folder to scan (recursively). Relative paths are relative to the module folder. Read on the server only. |
| `rescanIntervalSeconds` | `300` | Fallback full rescan; `0` disables it. Changes are normally picked up within ~2 s via file watching. |
| `displayDurationSeconds` | `30` | How long each photo is shown. |
| `transitionDurationSeconds` | `2` | Fade-in duration. |
| `displayStyle` | `"wallpaper"` | `wallpaper`, `fill`, `fit-display` or `absolute`. |
| `applyBlur` | `false` | Blurred, dimmed copy of the photo behind it, filling empty space. |
| `absoluteOptions` | see source | `{ enabled, side: "horizontal"\|"vertical", size, blurContainer: { width, height } }` for `absolute`. |
| `displayOrder` | `"random_dedupe"` | `random_dedupe`, `random`, `newest_first`, `oldest_first` (by file modification time). |
| `video.enabled` | `true` | Include videos. |
| `video.muted` | `true` | Browsers only autoplay muted videos. |
| `video.loop` | `false` | Loop a video until `displayDurationSeconds` or the cap is reached, whichever is longer. |
| `video.maxDurationSeconds` | `300` | Longest time one video plays before moving on. |
| `video.videosOnly` | `false` | Show only videos. |
| `video.autoplay`, `video.controls`, `video.preload` | `true`, `false`, `"metadata"` | Passed to the `<video>` element. |
| `showImageInfo` | `false` | Show the date/place overlay (see below). |
| `imageInfo` | `["date", "place"]` | Lines to show, in order: `date`, `since`, `place`. |
| `imageInfoDateFormat` | `"LL"` | moment.js date format. |
| `imageInfoCorner` | `"bottom-right"` | `top-left`, `top-right`, `bottom-left`, `bottom-right`. |
| `attribution` | disabled | `{ enabled, attributions: { "<top folder>": "text" }, position: "static"\|"dynamic", corner, relativeTo }` |

## Date and place overlay

Set `showImageInfo: true` to show each item's date and place in a corner:

```js
showImageInfo: true,
imageInfo: ["date", "place"],      // any of "date", "since" ("2 weeks ago"), "place"
imageInfoDateFormat: "MMMM D, YYYY", // moment.js format (default "LL")
imageInfoCorner: "bottom-right"
```

The info comes from an optional **`.mmm-localphoto.json`** in the media folder. It's a hidden file, so it's never shown or served:

```json
{ "version": 1, "items": {
    "2026/IMG_3123.jpg": { "taken": "2026-10-24T11:28:18-04:00", "place": "Bar Harbor, Maine" } } }
```

- Keys are paths relative to the media folder.
- `taken` is an ISO date. With an offset, it's shown as the local time where the photo was taken.
- `place` is any short text.

Files without an entry show no overlay. The file is re-read on every change, so tools can update it while the slideshow runs. [photo-sync](https://github.com/jinserk/magicmirror/tree/main/photo-sync) writes it, using offline reverse geocoding (GeoNames) for the place names.

## Media format tips

- **Photos:** use JPEG or WebP. **HEIC is not supported by browsers** (export iPhone photos as JPEG). Large photos (e.g. 4000×3000) work, but resizing to about the screen size saves memory on small devices like a Raspberry Pi.
- **Videos:** use **H.264 MP4** (or VP9 WebM). HEVC/H.265 `.mov` from phones usually won't play in Chromium. Keep the resolution near the screen's: 1080p on a Pi Zero 2 W can stutter.
## Adding, replacing and deleting files while it runs

You can change the folder at any time; the slideshow keeps playing.

- **Add:** new files appear within a few seconds. A file is listed only after it has stopped changing for 3 s, so a large file being copied with plain `cp` isn't shown half-written.
- **Replace** (same name, new content): picked up the same way. Media URLs carry a version (`?v=` from modification time and size), so browsers fetch the new file instead of a cached copy.
- **Delete:** removed from the list. If the deleted item is on screen, the slideshow moves on.
- Files and folders starting with `.` are ignored. Copying to `.name.tmp` and renaming when done (as `rsync` does) is the safest way.

## How media reaches the browser

- **Photos** are downloaded whole, then shown.
- **Videos** are streamed: the browser fetches the start (`preload: "metadata"`) and then the rest in chunks while playing, using HTTP range requests. A long video never has to be fully downloaded first.
- Files are cached by the browser for up to 1 hour. A replaced file gets a new URL, so the cache never shows an old version.

## Security

- `mediaDir` is read from `config.js` on the server, never from the browser, so a client can't make the module serve another directory.
- Files are served at `/MMM-LocalPhoto/media/…` with dotfiles denied, behind MagicMirror's `ipWhitelist`.
- Anyone allowed to open the mirror can view everything in the folder.

## License

MIT, see [LICENSE](LICENSE).
