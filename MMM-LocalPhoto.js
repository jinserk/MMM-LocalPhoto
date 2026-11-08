/* MMM-LocalPhoto
 *
 * Photo and video slideshow from a local folder for MagicMirror².
 * Display code is based on MMM-S3Photos by uphillcheddar (MIT):
 * https://github.com/uphillcheddar/MMM-S3Photos
 */
const LOCALPHOTO_VIDEO_EXTS = new Set(["mp4", "webm", "ogg", "ogv", "mov", "m4v", "mkv"]);
const LOCALPHOTO_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg"]);

Module.register("MMM-LocalPhoto", {
	defaults: {
		// Server side: folder to scan, relative to this module or absolute.
		mediaDir: "media",
		rescanIntervalSeconds: 300, // fallback rescan; file changes are picked up immediately anyway

		mode: "all", // what to show: "all", "photosOnly" or "videosOnly"
		// How photos are drawn: "css" (background image) or "canvas". A browser can
		// override this with ?photoRenderer=canvas in its own URL, so one display
		// (e.g. a Raspberry Pi kiosk) can switch without affecting other clients.
		photoRenderer: "css",

		displayDurationSeconds: 30, // how long each photo is shown
		transitionDurationSeconds: 2, // fade-in duration
		displayStyle: "wallpaper", // "wallpaper" (cover screen), "fill" (cover region), "fit-display" (whole image), "absolute"
		absoluteOptions: {
			enabled: false,
			side: "horizontal", // "horizontal" or "vertical"
			size: 400,
			blurContainer: { width: 500, height: 500 }
		},
		applyBlur: false, // blurred copy of the photo behind it (fills empty space)
		displayOrder: "random_dedupe", // "random", "random_dedupe" (all once before repeating), "newest_first", "oldest_first"
		video: {
			autoplay: true,
			muted: true, // browsers only autoplay muted videos
			loop: false,
			controls: false,
			preload: "metadata",
			maxDurationSeconds: 300 // a video plays to its end, but at most this long
		},
		// Date/place of each item (from .mmm-localphoto.json in the media folder,
		// e.g. written by photo-sync). Lines in this order: "date", "since", "place".
		showImageInfo: false,
		imageInfo: ["date", "place"],
		imageInfoDateFormat: "LL", // moment.js format, e.g. "MMMM D, YYYY"
		imageInfoCorner: "bottom-right", // "top-left", "top-right", "bottom-left", "bottom-right"
		attribution: {
			enabled: false,
			attributions: {}, // { "<top-level folder>": "text shown for its files" }
			position: "static", // "static" or "dynamic" (rotates corners)
			corner: "bottom-right",
			relativeTo: "display" // "display" or "image"
		}
	},

	getStyles () {
		return ["MMM-LocalPhoto.css"];
	},

	start () {
		// MagicMirror merges config with defaults shallowly: `video: { muted: true }`
		// would drop every other video default. Merge the nested groups here.
		for (const group of ["video", "attribution", "absoluteOptions"]) {
			this.config[group] = { ...this.defaults[group], ...(this.config[group] || {}) };
		}
		this.config.absoluteOptions.blurContainer = {
			...this.defaults.absoluteOptions.blurContainer,
			...(this.config.absoluteOptions.blurContainer || {})
		};

		this.mediaMode = this.normalizeMode();
		this.renderer = this.resolveRenderer();
		this.bitmap = null; // last photo drawn in canvas mode (for redraw on resize)
		if (this.renderer === "canvas") {
			let t = null;
			window.addEventListener("resize", () => {
				clearTimeout(t);
				t = setTimeout(() => this.bitmap && this.drawPhoto(this.bitmap), 300);
			});
		}

		this.media = [];
		this.loaded = false;
		this.errorMessage = null;
		this.currentIndex = -1;
		this.current = null;
		this.timer = null;
		this.playToken = 0;
		this.dedupeQueue = this.loadState("dedupeQueue", []);
		this.shownKeys = new Set(this.loadState("shownKeys", []));
	},

	/** "css" or "canvas": ?photoRenderer= in this page's URL, else the config. */
	resolveRenderer () {
		const fromUrl = new URLSearchParams(location.search).get("photoRenderer");
		const r = (fromUrl || this.config.photoRenderer || "css").toLowerCase();
		if (r === "css" || r === "canvas") return r;
		Log.warn(`${this.name}: unknown photoRenderer "${r}" (use "css" or "canvas"); using css`);
		return "css";
	},

	/** The configured mode; anything else falls back to "all". */
	normalizeMode () {
		const mode = this.config.mode;
		if (["all", "photosOnly", "videosOnly"].includes(mode)) return mode;
		Log.warn(`${this.name}: unknown mode "${mode}" (use "all", "photosOnly" or "videosOnly"); showing all`);
		return "all";
	},

	notificationReceived (notification) {
		if (notification === "ALL_MODULES_STARTED") {
			this.sendSocketNotification("GET_MEDIA");
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "MEDIA_UPDATED") {
			this.setMedia(Array.isArray(payload) ? payload : []);
		} else if (notification === "MEDIA_ERROR") {
			this.errorMessage = String(payload || "Failed to read the media folder");
			this.loaded = true;
			this.updateDom(0);
		}
	},

	setMedia (list) {
		const keep = { all: ["image", "video"], photosOnly: ["image"], videosOnly: ["video"] }[this.mediaMode];
		let media = list.filter((m) => keep.includes(this.getMediaType(m.key)));

		const byTime = (dir) => (a, b) => dir * (new Date(a.lastModified) - new Date(b.lastModified));
		if (this.config.displayOrder === "newest_first") media.sort(byTime(-1));
		else if (this.config.displayOrder === "oldest_first") media.sort(byTime(1));

		const wasEmpty = this.media.length === 0;
		const hadError = Boolean(this.errorMessage);
		this.media = media;
		if (this.config.displayOrder === "random_dedupe") this.reconcileDedupeQueue();

		// keep the sequential position on the item that is showing now
		if (this.current) this.currentIndex = this.media.findIndex((m) => m.key === this.current.key);

		const firstLoad = !this.loaded;
		this.loaded = true;
		this.errorMessage = null;

		if (firstLoad || hadError || wasEmpty !== (media.length === 0)) {
			// (re)build the DOM, then start showing
			this.updateDom(0);
			setTimeout(() => this.next(), 50);
		} else if (this.current && !this.media.some((m) => m.key === this.current.key)) {
			// the item on screen was deleted: move on
			this.next();
		}
		// otherwise the new list is used from the next item on; the current one keeps playing
	},

	getMediaType (key) {
		const ext = String(key).toLowerCase().split(".").pop();
		if (LOCALPHOTO_VIDEO_EXTS.has(ext)) return "video";
		if (LOCALPHOTO_IMAGE_EXTS.has(ext)) return "image";
		return "unknown";
	},

	mediaUrl (item) {
		const base = (globalThis.config?.basePath || "/").replace(/\/$/, "");
		return base + item.url;
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = `MMM-LocalPhoto ${this.config.displayStyle}${this.renderer === "canvas" ? " canvas-renderer" : ""}`;
		wrapper.style.setProperty("--transition-duration", `${this.config.transitionDurationSeconds || 2}s`);
		this.wrapper = wrapper;

		if (!this.loaded || this.errorMessage || this.media.length === 0) {
			const msg = document.createElement("div");
			msg.className = "localphoto-message dimmed small";
			const what = { all: "photos or videos", photosOnly: "photos", videosOnly: "videos" }[this.mediaMode];
			msg.textContent = this.errorMessage || (this.loaded ? `No ${what} in the media folder` : "");
			wrapper.appendChild(msg);
			return wrapper;
		}

		let host = wrapper;
		if (this.config.displayStyle === "absolute" && this.config.absoluteOptions?.enabled) {
			const opts = this.config.absoluteOptions;
			wrapper.classList.add(opts.side);
			wrapper.style.setProperty(opts.side === "horizontal" ? "--absolute-width" : "--absolute-height", `${opts.size || 400}px`);
			if (this.config.applyBlur) {
				host = document.createElement("div");
				host.className = "blur-enabled";
				if (opts.blurContainer) {
					host.style.setProperty("--blur-width", `${opts.blurContainer.width}px`);
					host.style.setProperty("--blur-height", `${opts.blurContainer.height}px`);
				}
				wrapper.appendChild(host);
			}
		}

		const photoBack = document.createElement("div");
		photoBack.className = "photo-back";
		if (!this.config.applyBlur) photoBack.style.visibility = "hidden";
		const photoCurrent = document.createElement("div");
		photoCurrent.className = "photo-current";
		const video = document.createElement("video");
		video.className = "video-current";
		video.style.display = "none";
		video.preload = this.config.video.preload;
		video.muted = this.config.video.muted;
		if (this.config.video.muted) video.setAttribute("muted", ""); // needed for autoplay
		video.controls = this.config.video.controls;
		video.setAttribute("playsinline", "");
		if (this.renderer === "canvas") {
			// Chromium in low-memory mode (<= 512 MB RAM) draws page content with
			// 16 shades per channel; canvases keep full 8-bit colour.
			const pc = document.createElement("canvas");
			pc.className = "photo-canvas";
			photoCurrent.appendChild(pc);
			const bc = document.createElement("canvas");
			bc.className = "photo-canvas";
			photoBack.appendChild(bc);
			this.bitmap = null;
		}
		host.append(photoBack, photoCurrent, video);

		const info = document.createElement("div");
		info.className = `photo-info ${this.config.imageInfoCorner || "bottom-right"}`;
		info.style.display = "none";
		wrapper.appendChild(info);

		const attr = document.createElement("div");
		attr.className = "attribution-container";
		attr.style.display = "none";
		const attrText = document.createElement("div");
		attrText.className = "attribution";
		attr.appendChild(attrText);
		wrapper.appendChild(attr);

		return wrapper;
	},

	/** Pick the next item and show it. */
	next () {
		clearTimeout(this.timer);
		if (!this.media.length || !this.wrapper?.querySelector(".photo-current")) return;

		let idx;
		if (this.config.displayOrder === "random_dedupe") {
			if (this.dedupeQueue.length === 0) {
				this.shownKeys = new Set();
				this.dedupeQueue = this.shuffle(this.media.map((m) => m.key));
			}
			const key = this.dedupeQueue.shift();
			this.shownKeys.add(key);
			this.persistState();
			idx = this.media.findIndex((m) => m.key === key);
			if (idx < 0) idx = Math.floor(Math.random() * this.media.length);
		} else if (this.config.displayOrder === "random") {
			idx = Math.floor(Math.random() * this.media.length);
			if (this.media.length > 1 && this.current && this.media[idx].key === this.current.key) {
				idx = (idx + 1) % this.media.length;
			}
		} else {
			idx = (this.currentIndex + 1) % this.media.length;
		}

		this.currentIndex = idx;
		this.current = this.media[idx];
		if (this.getMediaType(this.current.key) === "video") this.showVideo(this.current);
		else this.showPhoto(this.current);
	},

	/** Schedule next() for the item identified by `token` only. */
	advanceAfter (ms, token) {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			if (token === this.playToken) this.next();
		}, ms);
	},

	showVideo (item) {
		const token = ++this.playToken;
		const w = this.wrapper;
		const video = w.querySelector(".video-current");
		const photoCurrent = w.querySelector(".photo-current");
		const photoBack = w.querySelector(".photo-back");
		const v = this.config.video;
		const capMs = Math.max(5, Number(v.maxDurationSeconds) || 300) * 1000;

		// Fallback in case the video never loads or reports no duration.
		this.advanceAfter(this.config.displayDurationSeconds * 1000, token);

		video.onloadedmetadata = () => {
			if (token !== this.playToken) return;
			// let it play to the end (or loop) up to the cap
			const durMs = Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : this.config.displayDurationSeconds * 1000;
			this.advanceAfter(v.loop ? Math.min(Math.max(durMs, this.config.displayDurationSeconds * 1000), capMs) : Math.min(durMs + 1000, capMs), token);
		};
		video.onloadeddata = () => {
			if (token !== this.playToken) return;
			photoCurrent.style.display = "none";
			photoBack.style.display = "none";
			video.style.display = "block";
			this.updateAttribution(item);
			this.updateInfo(item);
			if (v.autoplay) video.play().catch(() => {});
		};
		video.onended = () => {
			if (token === this.playToken && !v.loop) this.next();
		};
		video.onerror = () => {
			if (token !== this.playToken) return;
			Log.error(`${this.name}: cannot play ${item.key}`);
			this.advanceAfter(1000, token);
		};

		video.autoplay = v.autoplay;
		video.loop = v.loop;
		video.src = this.mediaUrl(item);
		video.load();

		if (this.config.displayStyle === "absolute" && this.config.absoluteOptions?.enabled) {
			const size = `${this.config.absoluteOptions.size || 400}px`;
			if (this.config.absoluteOptions.side === "horizontal") Object.assign(video.style, { maxWidth: size, width: "100%", height: "auto" });
			else Object.assign(video.style, { maxHeight: size, height: "100%", width: "auto" });
		}
	},

	showPhoto (item) {
		const token = ++this.playToken;
		const w = this.wrapper;
		const video = w.querySelector(".video-current");
		const photoCurrent = w.querySelector(".photo-current");
		const photoBack = w.querySelector(".photo-back");
		const url = this.mediaUrl(item);
		const img = new Image();

		img.onload = () => {
			if (token !== this.playToken) return;
			video.pause();
			video.removeAttribute("src");
			video.load(); // release the decoder
			video.style.display = "none";
			photoCurrent.style.display = "block";
			photoBack.style.display = "block";

			if (this.config.displayStyle === "absolute" && this.config.absoluteOptions?.enabled) {
				const { side, size = 400 } = this.config.absoluteOptions;
				const ratio = img.width / img.height;
				photoCurrent.style.width = side === "horizontal" ? `${size}px` : `${Math.round(size * ratio)}px`;
				photoCurrent.style.height = side === "horizontal" ? `${Math.round(size / ratio)}px` : `${size}px`;
			}

			if (this.renderer === "canvas") {
				this.paintCanvas(item, img, token);
				this.advanceAfter(this.config.displayDurationSeconds * 1000, token);
				return;
			}

			const css = `url("${url.replace(/"/g, "%22")}")`;
			photoBack.style.backgroundImage = css;
			requestAnimationFrame(() => {
				photoCurrent.classList.remove("animated");
				void photoCurrent.offsetWidth; // restart the fade-in
				photoCurrent.style.backgroundImage = css;
				photoCurrent.style.backgroundSize = this.config.displayStyle === "absolute"
					? "100% 100%"
					: this.config.displayStyle === "wallpaper" || this.config.displayStyle === "fill" ? "cover" : "contain";
				photoCurrent.classList.add("animated");
				this.updateAttribution(item);
				this.updateInfo(item);
			});
			this.advanceAfter(this.config.displayDurationSeconds * 1000, token);
		};
		img.onerror = () => {
			if (token !== this.playToken) return;
			Log.error(`${this.name}: cannot load ${item.key}`);
			this.advanceAfter(1000, token);
		};
		img.src = url;
	},

	/** Canvas renderer: decode, then swap the photo in one frame and restart the fade. */
	async paintCanvas (item, img, token) {
		let src = img;
		try {
			if (typeof createImageBitmap === "function") src = await createImageBitmap(img); // decoded off the main thread
		} catch {
			src = img;
		}
		if (token !== this.playToken) {
			if (src.close) src.close();
			return;
		}
		requestAnimationFrame(() => {
			if (token !== this.playToken) return;
			const pc = this.wrapper.querySelector(".photo-current");
			pc.classList.remove("animated");
			void pc.offsetWidth; // restart the fade-in
			if (this.bitmap && this.bitmap !== src && this.bitmap.close) this.bitmap.close();
			this.bitmap = src;
			this.drawPhoto(src);
			pc.classList.add("animated");
			this.updateAttribution(item);
			this.updateInfo(item);
		});
	},

	/** Draw `src` into the photo canvas (same fit as the CSS renderer) and the backdrop. */
	drawPhoto (src) {
		const w = this.wrapper;
		const pc = w?.querySelector(".photo-current canvas");
		if (!pc) return;
		const dpr = window.devicePixelRatio || 1;
		const box = pc.getBoundingClientRect();
		const cw = Math.max(1, Math.min(4096, Math.round(box.width * dpr)));
		const ch = Math.max(1, Math.min(4096, Math.round(box.height * dpr)));
		if (pc.width !== cw || pc.height !== ch) {
			pc.width = cw;
			pc.height = ch;
		}
		const iw = src.width, ih = src.height;
		const style = this.config.displayStyle;
		let dw = cw, dh = ch;
		if (!(style === "absolute" && this.config.absoluteOptions?.enabled)) {
			const k = style === "wallpaper" || style === "fill" ? Math.max(cw / iw, ch / ih) : Math.min(cw / iw, ch / ih);
			dw = iw * k;
			dh = ih * k;
		}
		const ctx = pc.getContext("2d");
		ctx.clearRect(0, 0, cw, ch);
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh);

		// blurred, darkened copy behind it (applyBlur), drawn small and scaled up by CSS
		const bc = w.querySelector(".photo-back canvas");
		if (bc && this.config.applyBlur) {
			const bb = bc.getBoundingClientRect();
			const bw = Math.max(1, Math.round(bb.width / 4)), bh = Math.max(1, Math.round(bb.height / 4));
			bc.width = bw;
			bc.height = bh;
			const b = bc.getContext("2d");
			const k = Math.max(bw / iw, bh / ih);
			b.filter = "blur(3px) brightness(40%)";
			b.drawImage(src, (bw - iw * k) / 2, (bh - ih * k) / 2, iw * k, ih * k);
			b.filter = "none";
		}
	},

	/** Date / "x ago" / place of the item, one per line (only lines with data). */
	updateInfo (item) {
		const el = this.wrapper?.querySelector(".photo-info");
		if (!el) return;
		const info = item.info || {};
		const lines = [];
		if (this.config.showImageInfo) {
			// keep the camera's own UTC offset ("…-04:00"): show the time as it was there
			const m = info.taken && typeof moment === "function"
				? (/[+-]\d\d:?\d\d$|Z$/.test(info.taken) ? moment.parseZone(info.taken) : moment(info.taken))
				: null;
			for (const field of this.config.imageInfo || []) {
				if (field === "date" && m?.isValid()) lines.push(m.format(this.config.imageInfoDateFormat));
				else if (field === "since" && m?.isValid()) lines.push(m.fromNow());
				else if ((field === "place" || field === "geo") && info.place) lines.push(info.place);
			}
		}
		el.replaceChildren(...lines.map((text) => {
			const line = document.createElement("div");
			line.textContent = text; // text only, never HTML
			return line;
		}));
		el.style.display = lines.length ? "block" : "none";
	},

	updateAttribution (item) {
		const container = this.wrapper?.querySelector(".attribution-container");
		const textEl = this.wrapper?.querySelector(".attribution");
		if (!container || !textEl) return;
		const a = this.config.attribution;
		const text = a?.enabled && a.attributions?.[item.key.split("/")[0]];
		if (!text) {
			container.style.display = "none";
			return;
		}
		textEl.textContent = text;
		container.className = "attribution-container";
		container.setAttribute("data-relative", a.relativeTo || "display");
		if (a.position === "dynamic") {
			const order = ["top-left", "top-right", "bottom-right", "bottom-left"];
			this.corner = order[(order.indexOf(this.corner) + 1) % order.length];
			container.classList.add(this.corner);
		} else {
			container.classList.add(a.corner || "bottom-right");
		}
		container.style.display = "block";
	},

	// ---- random_dedupe state (kept across page reloads) ----
	reconcileDedupeQueue () {
		const keys = this.media.map((m) => m.key);
		const all = new Set(keys);
		this.dedupeQueue = this.dedupeQueue.filter((k) => all.has(k));
		this.shownKeys = new Set([...this.shownKeys].filter((k) => all.has(k)));
		const queued = new Set(this.dedupeQueue);
		const fresh = keys.filter((k) => !queued.has(k) && !this.shownKeys.has(k));
		if (fresh.length) this.dedupeQueue = this.shuffle(fresh).concat(this.dedupeQueue); // new files first
		this.persistState();
	},

	shuffle (arr) {
		const a = arr.slice();
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
	},

	loadState (name, fallback) {
		try {
			const v = JSON.parse(localStorage.getItem(`MMM-LocalPhoto_${name}`));
			return Array.isArray(v) ? v : fallback;
		} catch {
			return fallback;
		}
	},

	persistState () {
		clearTimeout(this.persistTimer);
		this.persistTimer = setTimeout(() => {
			try {
				localStorage.setItem("MMM-LocalPhoto_dedupeQueue", JSON.stringify(this.dedupeQueue));
				localStorage.setItem("MMM-LocalPhoto_shownKeys", JSON.stringify([...this.shownKeys]));
			} catch {
				// storage full or disabled: dedupe just restarts after a reload
			}
		}, 500);
	}
});
