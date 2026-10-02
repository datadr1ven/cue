/**
 * Open a manual X compose draft (intent URL) + local review page.
 * Prefills text; collage still needs drag/paste into the composer.
 *
 * Termux/Android: only open the review page — auto-opening X right after
 * steals the foreground and the HTML viewer never sticks. User taps
 * “Open draft on X” on the review page instead.
 */

import { spawnSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { basename, join } from "path";

function isTermux() {
  return !!(
    process.env.TERMUX_VERSION || existsSync("/data/data/com.termux")
  );
}

/**
 * Copy collage into shared storage and media-scan so it appears in Gallery /
 * camera roll. Requires `termux-setup-storage` once.
 * @param {string} collagePath
 * @returns {{ ok: boolean, dest?: string, reason?: string, scanned?: boolean }}
 */
export function saveCollageToCameraRoll(collagePath) {
  if (!collagePath || !existsSync(collagePath)) {
    return { ok: false, reason: "no collage" };
  }
  if (!isTermux()) {
    return { ok: false, reason: "not termux" };
  }

  const home = process.env.HOME || homedir();
  const candidates = [
    join(home, "storage/dcim/Camera"),
    join(home, "storage/dcim"),
    join(home, "storage/pictures"),
    join(home, "storage/shared/DCIM/Camera"),
    join(home, "storage/shared/Pictures"),
  ];
  const base = candidates.find((d) => existsSync(d));
  if (!base) {
    return {
      ok: false,
      reason: "storage not linked — run: termux-setup-storage",
    };
  }

  const destDir = join(base, "TPlus");
  try {
    mkdirSync(destDir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: e.message || "mkdir failed" };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = join(destDir, `collage-${stamp}.jpg`);
  try {
    copyFileSync(collagePath, dest);
  } catch (e) {
    return { ok: false, reason: e.message || "copy failed" };
  }

  const scan = spawnSync("termux-media-scan", [dest], {
    encoding: "utf8",
  });
  const scanned = !scan.error && scan.status === 0;
  // Don't termux-open the jpg here — it would cover the review page again.

  return { ok: true, dest, scanned, name: basename(dest) };
}

/**
 * @param {{ caption: string, intentUrl: string, collagePath: string, postHtmlPath: string }} opts
 */
export function openManualXDraft(opts) {
  const { caption, intentUrl, collagePath, postHtmlPath } = opts;
  const steps = [];
  const termux = isTermux();

  const textCopy = copyTextBestEffort(caption);
  steps.push(textCopy.ok ? "caption → clipboard" : "caption clipboard skipped");

  /** @type {{ ok: boolean, dest?: string, reason?: string, scanned?: boolean }} */
  let gallery = { ok: false };
  let imgCopy = { ok: false };
  if (collagePath && existsSync(collagePath)) {
    if (termux) {
      gallery = saveCollageToCameraRoll(collagePath);
      steps.push(
        gallery.ok
          ? `collage → camera roll (${gallery.dest})`
          : `camera roll save failed (${gallery.reason || "unknown"})`,
      );
    } else {
      imgCopy = copyImageBestEffort(collagePath);
      steps.push(
        imgCopy.ok
          ? "collage → clipboard"
          : "collage clipboard skipped (drag from review page)",
      );
    }
  } else {
    steps.push("no collage (text-only)");
  }

  // Review page first so the collage is visible for drag-drop
  if (postHtmlPath && existsSync(postHtmlPath)) {
    const opened = openPath(postHtmlPath);
    if (opened.ok) {
      steps.push(`opened review (${opened.via})`);
    } else {
      steps.push(
        `review open failed — try: termux-open '${postHtmlPath}'`,
      );
    }
  } else {
    steps.push("no review page on disk");
  }

  if (termux) {
    // Opening https://x.com/intent/... immediately covers/cancels the HTML
    // viewer on Android. Leave X to the review page CTA.
    steps.push(
      'X not auto-opened on Termux — tap “Open draft on X” on the review page',
    );
  } else {
    const opened = openPath(intentUrl);
    steps.push(
      opened.ok
        ? `opened X compose (${opened.via})`
        : "X compose open failed",
    );
  }

  return { ok: true, steps, intentUrl, textCopy, imgCopy, gallery, termux };
}

/**
 * @param {string} target
 * @returns {{ ok: boolean, via?: string, status?: number|null }}
 */
function openPath(target) {
  if (isTermux()) {
    if (/^https?:\/\//i.test(target)) {
      const r = spawnSync("termux-open-url", [target], {
        detached: true,
        stdio: "ignore",
      });
      return {
        ok: !r.error && (r.status === 0 || r.status == null),
        via: "termux-open-url",
        status: r.status,
      };
    }
    // Local file: termux-open (FileProvider). Fallback file:// URL.
    let r = spawnSync("termux-open", [target], {
      detached: true,
      stdio: "ignore",
    });
    if (!r.error && (r.status === 0 || r.status == null)) {
      return { ok: true, via: "termux-open", status: r.status };
    }
    const fileUrl = target.startsWith("file:")
      ? target
      : `file://${target}`;
    r = spawnSync("termux-open-url", [fileUrl], {
      detached: true,
      stdio: "ignore",
    });
    return {
      ok: !r.error && (r.status === 0 || r.status == null),
      via: "termux-open-url/file",
      status: r.status,
    };
  }

  const opener =
    process.env.BROWSER_OPEN ||
    (process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open");
  const args =
    process.platform === "win32" ? ["/c", "start", "", target] : [target];
  const r = spawnSync(opener, args, { detached: true, stdio: "ignore" });
  return {
    ok: !r.error && (r.status === 0 || r.status == null),
    via: opener,
    status: r.status,
  };
}

function copyTextBestEffort(text) {
  const payload = String(text || "");
  if (isTermux()) {
    const r = spawnSync("termux-clipboard-set", [], {
      input: payload,
      encoding: "utf8",
    });
    if (!r.error && r.status === 0) {
      return { ok: true, via: "termux-clipboard-set" };
    }
  }
  // wl-copy
  let r = spawnSync("wl-copy", [], { input: payload, encoding: "utf8" });
  if (r.status === 0) return { ok: true, via: "wl-copy" };
  r = spawnSync("xclip", ["-selection", "clipboard"], {
    input: payload,
    encoding: "utf8",
  });
  if (r.status === 0) return { ok: true, via: "xclip" };
  // Gtk via python (common on desktop Linux)
  r = spawnSync(
    "python3",
    [
      "-c",
      `import sys
try:
  import gi
  gi.require_version('Gtk','3.0')
  from gi.repository import Gtk, Gdk
  c=Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
  c.set_text(sys.stdin.read(), -1)
  c.store()
except Exception:
  sys.exit(1)
`,
    ],
    { input: payload, encoding: "utf8" },
  );
  if (r.status === 0) return { ok: true, via: "gtk" };
  return { ok: false };
}

function copyImageBestEffort(imagePath) {
  if (!imagePath || !existsSync(imagePath)) return { ok: false };
  // wl-copy image
  let r = spawnSync(
    "wl-copy",
    ["--type", "image/jpeg"],
    { input: readFileSync(imagePath), encoding: "buffer" },
  );
  if (r.status === 0) return { ok: true, via: "wl-copy" };

  r = spawnSync(
    "xclip",
    ["-selection", "clipboard", "-t", "image/jpeg", "-i", imagePath],
  );
  if (r.status === 0) return { ok: true, via: "xclip" };

  // Try Gtk pixbuf load — may fail without GdkPixbuf jpeg; best-effort
  const py = `
import sys
path = sys.argv[1]
try:
  import gi
  gi.require_version('Gtk', '3.0')
  gi.require_version('Gdk', '3.0')
  from gi.repository import Gtk, Gdk, GdkPixbuf
  pb = GdkPixbuf.Pixbuf.new_from_file(path)
  c = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
  c.set_image(pb)
  c.store()
except Exception:
  sys.exit(1)
`;
  const script = join(tmpdir(), `tplus-clip-img-${process.pid}.py`);
  try {
    writeFileSync(script, py);
    r = spawnSync("python3", [script, imagePath]);
    if (r.status === 0) return { ok: true, via: "gtk-image" };
  } catch {
    /* ignore */
  }
  return { ok: false };
}
