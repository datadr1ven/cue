/**
 * Open a manual X compose draft (intent URL) + local review page.
 * Prefills text; collage still needs drag/paste into the composer.
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * @param {{ caption: string, intentUrl: string, collagePath: string, postHtmlPath: string }} opts
 */
export function openManualXDraft(opts) {
  const { caption, intentUrl, collagePath, postHtmlPath } = opts;
  const steps = [];

  const textCopy = copyTextBestEffort(caption);
  steps.push(textCopy.ok ? "caption → clipboard" : "caption clipboard skipped");

  let imgCopy = { ok: false };
  if (collagePath && existsSync(collagePath)) {
    imgCopy = copyImageBestEffort(collagePath);
    steps.push(
      imgCopy.ok
        ? "collage → clipboard"
        : "collage clipboard skipped (drag from review page)",
    );
  } else {
    steps.push("no collage (text-only)");
  }

  // Review page first so the collage is visible for drag-drop
  if (postHtmlPath && existsSync(postHtmlPath)) {
    openPath(postHtmlPath);
    steps.push(`opened ${postHtmlPath}`);
  }

  openPath(intentUrl);
  steps.push(`opened X compose intent`);

  return { ok: true, steps, intentUrl, textCopy, imgCopy };
}

function openPath(target) {
  // Termux: termux-open-url for https; termux-open for files
  if (process.env.TERMUX_VERSION || existsSync("/data/data/com.termux")) {
    if (/^https?:\/\//i.test(target)) {
      spawnSync("termux-open-url", [target], {
        detached: true,
        stdio: "ignore",
      });
      return;
    }
    spawnSync("termux-open", [target], { detached: true, stdio: "ignore" });
    return;
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
  spawnSync(opener, args, { detached: true, stdio: "ignore" });
}

function copyTextBestEffort(text) {
  const payload = String(text || "");
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
