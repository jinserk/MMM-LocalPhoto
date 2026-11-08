/* MMM-LocalPhoto node helper
 *
 * Scans a local folder (recursively) for photos and videos, serves them over
 * MagicMirror's web server and pushes the list to the browser. The list is
 * refreshed when files change (fs.watch) and on a periodic rescan.
 *
 * The media folder comes from this module's config in config.js, read on the
 * server side (global.config). It is never taken from the browser, so a client
 * cannot point the file server at another directory.
 */
const NodeHelper = require("node_helper");
const Log = require("logger");
const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// Keep in sync with MMM-LocalPhoto.js
const VIDEO_EXTS = new Set(["mp4", "webm", "ogg", "ogv", "mov", "m4v", "mkv"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg"]);
const MEDIA_ROUTE = "/MMM-LocalPhoto/media";
const DEFAULTS = { mediaDir: "media", rescanIntervalSeconds: 300 };
// A file is listed only once it hasn't changed for this long, so a file that
// is still being copied (plain `cp`) is not shown half-written.
const SETTLE_MS = 3000;
// Optional per-file info (capture date, place) written by tools such as
// photo-sync: { "version": 1, "items": { "<key>": { "taken": ISO, "place": "..." } } }
const INFO_FILE = ".mmm-localphoto.json";

module.exports = NodeHelper.create({
	start () {
		this.media = [];
		this.signature = "";
		this.scanning = null;
		this.watchers = [];
		this.rescanTimer = null;
		this.debounceTimer = null;

		const cfg = this.readServerConfig();
		this.mediaDir = path.resolve(this.path, cfg.mediaDir);
		this.rescanIntervalSeconds = Math.max(0, Number(cfg.rescanIntervalSeconds) || 0);
		Log.info(`${this.name}: media folder ${this.mediaDir}`);

		// Serve the media folder (Range requests work, so videos can seek/stream).
		this.expressApp.use(MEDIA_ROUTE, express.static(this.mediaDir, {
			dotfiles: "deny",
			index: false,
			redirect: false,
			maxAge: "1h"
		}));

		this.watch();
		if (this.rescanIntervalSeconds > 0) {
			this.rescanTimer = setInterval(() => this.refresh("periodic rescan"), this.rescanIntervalSeconds * 1000);
		}
		this.refresh("startup");
	},

	stop () {
		clearInterval(this.rescanTimer);
		clearTimeout(this.debounceTimer);
		clearTimeout(this.recheckTimer);
		for (const w of this.watchers) w.close();
		this.watchers = [];
	},

	/** This module's config from config.js (server side, trusted). */
	readServerConfig () {
		const mod = (global.config?.modules || []).find((m) => m.module === this.name && !m.disabled);
		return { ...DEFAULTS, ...(mod?.config || {}) };
	},

	socketNotificationReceived (notification) {
		if (notification === "GET_MEDIA") {
			// Answer the asking client right away (also re-sends to other clients).
			this.scan()
				.then(() => this.sendSocketNotification("MEDIA_UPDATED", this.media))
				.catch((err) => this.sendSocketNotification("MEDIA_ERROR", err.message));
		}
	},

	/** Rescan; notify clients only if the set of files changed. */
	async refresh (reason) {
		try {
			const before = this.signature;
			await this.scan();
			if (this.signature !== before) {
				Log.info(`${this.name}: ${this.media.length} media files (${reason})`);
				this.sendSocketNotification("MEDIA_UPDATED", this.media);
			}
		} catch (err) {
			Log.error(`${this.name}: scan failed (${reason}):`, err.message);
			this.sendSocketNotification("MEDIA_ERROR", err.message);
		}
	},

	/** Walk mediaDir; one scan at a time. */
	scan () {
		if (!this.scanning) {
			this.scanning = Promise.all([this.walk(this.mediaDir), this.readInfo()])
				.then(([files, info]) => {
					files.sort((a, b) => a.key.localeCompare(b.key));
					for (const f of files) {
						if (info[f.key]) f.info = info[f.key];
					}
					this.media = files;
					this.signature = files.map((f) => `${f.key}:${f.size}:${f.lastModified}:${JSON.stringify(f.info || "")}`).join("|");
				})
				.finally(() => {
					this.scanning = null;
				});
		}
		return this.scanning;
	},

	/** INFO_FILE in the media folder; only short "taken"/"place" strings are kept. */
	async readInfo () {
		let data;
		try {
			data = JSON.parse(await fsp.readFile(path.join(this.mediaDir, INFO_FILE), "utf8"));
		} catch (err) {
			if (err.code !== "ENOENT") Log.warn(`${this.name}: ignoring ${INFO_FILE}: ${err.message}`);
			return {};
		}
		const out = {};
		for (const [key, v] of Object.entries(data?.items || {})) {
			if (!v || typeof v !== "object") continue;
			const info = {};
			for (const field of ["taken", "place"]) {
				if (typeof v[field] === "string" && v[field].length <= 200) info[field] = v[field];
			}
			if (Object.keys(info).length) out[key] = info;
		}
		return out;
	},

	async walk (dir, prefix = "") {
		let entries;
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch (err) {
			if (err.code === "ENOENT" && prefix === "") {
				Log.warn(`${this.name}: media folder ${dir} does not exist`);
				return [];
			}
			throw err;
		}
		const out = [];
		for (const e of entries) {
			if (e.name.startsWith(".")) continue; // hidden files, partial uploads, .gitkeep
			const full = path.join(dir, e.name);
			const key = prefix ? `${prefix}/${e.name}` : e.name;
			if (e.isDirectory()) {
				out.push(...await this.walk(full, key));
			} else if (e.isFile() || e.isSymbolicLink()) {
				const ext = e.name.toLowerCase().split(".").pop();
				const type = VIDEO_EXTS.has(ext) ? "video" : IMAGE_EXTS.has(ext) ? "image" : null;
				if (!type) continue;
				try {
					const st = await fsp.stat(full);
					if (!st.isFile() || st.size === 0) continue;
					if (Date.now() - st.mtimeMs < SETTLE_MS) {
						// still being written: look again once it has settled
						this.recheckSoon();
						continue;
					}
					out.push({
						key,
						type,
						// ?v= changes when the file is replaced, so browsers don't show a cached old copy
						url: `${MEDIA_ROUTE}/${key.split("/").map(encodeURIComponent).join("/")}?v=${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(36)}`,
						lastModified: st.mtime.toISOString(),
						size: st.size
					});
				} catch {
					// vanished between readdir and stat (e.g. being moved): skip
				}
			}
		}
		return out;
	},

	/** Rescan after a file that was still being written has settled. */
	recheckSoon () {
		if (this.recheckTimer) return;
		this.recheckTimer = setTimeout(() => {
			this.recheckTimer = null;
			this.refresh("file settled");
		}, SETTLE_MS + 500);
	},

	/** Watch for changes; a short debounce batches bulk copies. */
	watch () {
		const onChange = () => {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => this.refresh("files changed"), 2000);
		};
		try {
			this.watchers.push(fs.watch(this.mediaDir, { recursive: true }, onChange));
		} catch (err) {
			Log.warn(`${this.name}: cannot watch ${this.mediaDir} (${err.message}); relying on periodic rescan`);
		}
	}
});
