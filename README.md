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
| `attribution` | disabled | `{ enabled, attributions: { "<top folder>": "text" }, position: "static"\|"dynamic", corner, relativeTo }` |

## Media format tips

- **Photos:** use JPEG or WebP. **HEIC is not supported by browsers** (export iPhone photos as JPEG). Large photos (e.g. 4000×3000) work, but resizing to about the screen size saves memory on small devices like a Raspberry Pi.
- **Videos:** use **H.264 MP4** (or VP9 WebM). HEVC/H.265 `.mov` from phones usually won't play in Chromium. Keep the resolution near the screen's: 1080p on a Pi Zero 2 W can stutter.
- Files and folders starting with `.` are ignored, so copy to `.name.tmp` and rename when done to avoid half-copied files showing up.

## Security

- `mediaDir` is read from `config.js` on the server, never from the browser, so a client can't make the module serve another directory.
- Files are served at `/MMM-LocalPhoto/media/…` with dotfiles denied, behind MagicMirror's `ipWhitelist`.
- Anyone allowed to open the mirror can view everything in the folder.

## License

MIT, see [LICENSE](LICENSE).
