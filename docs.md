# Building Extensions for Axion

Axion supports two flavors of user-authored extensions:

- **Widgets** — render in fixed desktop slots (`top` / `right` / `bottom` / `left` / `center`).
- **Plugins** — open as windows in the workspace, like built-in apps.

Both run as sandboxed iframes at `axion-plugin://<your-extension-id>/<entry>` and talk to the host through a single object: `window.axion`. The same manifest can declare a widget presentation, a plugin presentation, or both — they share the same SDK, the same permission model, and the same lifecycle.

---

## Quick start

1. Open the **Plugins** app, copy the path next to **Extensions folder**.
2. Create a new folder there. The folder name must match the `id` you give your manifest.
3. Add `manifest.json` and `index.html` (see boilerplates below).
4. Click **Refresh** in the Plugins app — your extension appears in the list.

```
<extensions-folder>/my-extension/
├── manifest.json
└── index.html
```

That's it. No build step, no host rebuild, no app restart.

---

## Project structure

The two-file layout above is the *minimum*, not a ceiling. Your extension folder is served as a static-site root: anything under it is fetchable from the iframe at a relative URL. Split into folders however your project wants.

```
my-plugin/
├── manifest.json
├── index.html              ← entry from manifest.presentations.plugin.entry
├── css/
│   ├── reset.css
│   └── app.css
├── js/
│   ├── api.js
│   └── views/list.js
├── components/
│   └── header.html
├── assets/
│   └── logo.svg
└── docs.md
```

From `index.html`, every relative path Just Works:

```html
<link rel="stylesheet" href="css/app.css">
<script type="module" src="js/main.js"></script>
<img src="assets/logo.svg" alt="">
```

```js
// Native ESM imports — no bundler needed.
import { fetchStats } from './js/api.js'
import { renderList } from './js/views/list.js'

// Fetch sibling files (HTML fragments, JSON config, …) from your folder.
const tmpl = await fetch('components/header.html').then(r => r.text())
const cfg  = await fetch('config.json').then(r => r.json())
```

Two things to know:

- **Only the entry HTML gets the SDK auto-injected.** When the host serves an HTML file, it inserts a `<link>` to the host theme stylesheet and a `<script>` for the SDK runtime into `<head>`. Files you load via `fetch()` and inject into the DOM run inside the same iframe, so `window.axion` is already there — they don't need their own injection.
- **No build step is wired in.** You can ship plain JS+CSS and have it run unchanged. If you want TypeScript, JSX, SCSS, or a bundler, run them yourself before dropping the output into the extensions folder. The host doesn't watch source files; it serves what's on disk.

**Path traversal is blocked** — paths with `..` or absolute paths are rejected. Inside your folder, anything goes.

**MIME types** are handled for the common web file types (HTML, JS, MJS, CSS, JSON, PNG/JPG/GIF/WebP/SVG, WOFF/WOFF2/TTF, TXT). Anything else is served as `application/octet-stream`, which works for `fetch().then(r => r.arrayBuffer())` but won't auto-decode in `<img>` or `<script>`.

---

## Manifest reference

`manifest.json` describes your extension. The folder name must equal `id`.

```jsonc
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "author": "Your name",

  // Optional. One-line summary shown under the name in the Plugins app
  // and used for in-app search. Aim for ~80 characters.
  "description": "Tail systemd journals with one-click filters.",

  // Optional. Path inside your extension folder to an icon file (PNG,
  // SVG, or any image format the webview supports). Used in the dock,
  // the Apps launcher, the Plugins app, and the window header. Falls
  // back to a generic puzzle-piece glyph when omitted.
  "icon": "icon.svg",

  // At least one of `widget` or `plugin` is required.
  "presentations": {
    "widget": {
      "entry": "widget.html",
      "defaultSlot": "right",
      "defaultSize": "md",

      // Drop the default frosted-glass card around the widget so your
      // iframe paints directly onto the desktop wallpaper. Useful for
      // floating clocks / status pills / anything that should "blend
      // in" rather than sit on a panel. Defaults to false.
      "transparent": false
    },
    "plugin": {
      "entry": "index.html",
      "defaultSize": { "w": 720, "h": 520 },

      // File extensions this plugin handles when a user double-clicks
      // a file in the Files app. Only honored when the extension is
      // trusted. See "File associations" below.
      "fileExtensions": ["md", "markdown"]
    }
  },

  // Capabilities you want the host to grant. Calls to gated APIs reject
  // with E_PERMISSION_DENIED if not declared here.
  "permissions": [
    "ssh.exec",
    "sftp.read",
    "sftp.write"
  ],

  // Remote shell commands your extension needs. Checked once per session;
  // if any are missing, the host shows a "Missing on remote: ..." overlay
  // and never loads your iframe.
  "requirements": ["awk", "free"],

  // User-configurable variables. The host renders a settings modal from
  // these (gear icon on the row in the Plugins app), and the user's
  // chosen values are surfaced via `axion.settings`. See "Settings" below.
  "settings": [
    { "name": "apiUrl",   "title": "API URL",  "type": "string",  "default": "https://api.example.com" },
    { "name": "interval", "title": "Refresh",  "type": "number",  "default": 30, "min": 1, "max": 3600 },
    { "name": "compact",  "title": "Compact",  "type": "boolean", "default": false },
    { "name": "theme",    "title": "Theme",    "type": "select",  "default": "auto",
      "options": [
        { "value": "light", "label": "Light" },
        { "value": "dark",  "label": "Dark" },
        { "value": "auto",  "label": "Match host" }
      ]
    }
  ],

  "sdk": "1"
}
```

### Field reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Stable identifier; **must equal the folder name** |
| `name` | yes | Display name |
| `version` | recommended | Semver string |
| `author` | optional | Your name or handle |
| `description` | optional | One-line summary shown under the name in the Plugins app and indexed by in-app search |
| `icon` | optional | Path inside your extension folder to an image used as the dock / launcher / window icon. See "Icons" |
| `presentations.widget.entry` | conditional | Path to widget HTML, relative to the folder |
| `presentations.widget.defaultSlot` | optional | `top` / `right` / `bottom` / `left` / `center` |
| `presentations.widget.defaultSize` | optional | `sm` / `md` / `lg` |
| `presentations.widget.transparent` | optional | When `true`, skip the host's frosted-glass card so your iframe paints directly on the wallpaper. Defaults to `false` |
| `presentations.plugin.entry` | conditional | Path to plugin HTML, relative to the folder |
| `presentations.plugin.defaultSize` | optional | `{ w, h }` initial window pixels |
| `presentations.plugin.fileExtensions` | optional | Array of file extensions this plugin opens (e.g. `["md"]`). See "File associations" |
| `permissions` | optional | Array of capability strings (see below) |
| `requirements` | optional | Remote commands your plugin will invoke. Doubles as the visibility contract — see "Requirements & the exec contract" |
| `settings` | optional | Array of user-configurable variables. See "Settings" |
| `sdk` | optional | Minimum SDK version your code depends on |

### Permissions

| Capability | Grants |
|------------|--------|
| `ssh.exec` | `axion.exec(...)` — *also requires every program you call to be listed in `requirements`*, see below |
| `ssh.sudo` | `axion.sudo(...)` — run a command as root via `sudo -S`. Same `requirements` drift guard as `ssh.exec`. Each call shows the user the command and asks for their sudo password before it runs. See "The sudo contract" |
| `sftp.read` | `axion.sftp.list / stat / read` |
| `sftp.write` | `axion.sftp.write / mkdir / rename / remove` |
| `files.show` | `axion.files.show(path)` — open the Files app at a folder |
| `editor.open` | `axion.editor.open(path)` — open a file in the Editor |
| `imageviewer.open` | `axion.imageViewer.open(path)` — open a file in the Image Viewer |
| `terminal.open` | `axion.terminal.openAt(path)` — open the Terminal `cd`'d to a folder |

`axion.storage.*` and `axion.ui.*` are always available; no permission required.

### Requirements & the exec contract

Axion can't sandbox your shell — interpreter binaries (`python`, `bash`, `sqlite3`, …) can always run arbitrary code as a side effect, and we'd defeat half the product if we blocked them. So instead of pretending to enforce a perimeter, we make the contract **visible**.

`requirements` is the list of programs your plugin will invoke through `axion.exec`. The host treats it as both:

1. **A presence check** — the iframe doesn't load until each command resolves on the remote (`command -v <name>`). Plugins that need `awk` and `free` won't silently misbehave on hosts where those aren't installed; they show a "Missing on remote: …" banner instead.

2. **A drift guard.** Every `axion.exec` call is parsed for its program name (the first non-env-var token), and the call is rejected with `E_NOT_DECLARED` if that name isn't in `requirements`. The user trusted the plugin based on this list — drift past it has to fail loudly.

```jsonc
"permissions": ["ssh.exec"],
"requirements": ["uptime", "df", "ls"]
```

```js
await axion.exec('uptime')        // ok
await axion.exec('df -h /var')    // ok
await axion.exec('ls -la /home')  // ok
await axion.exec('curl …')        // E_NOT_DECLARED (curl wasn't listed)
```

**Pipelines and compound commands.** The drift guard checks the *first* program in the command. Using shell features (`|`, `&&`, `$( )`) doesn't bypass anything — it just means the user's trust UI shows only the first program. If your plugin shells out to multiple binaries, declare every one in `requirements` so the user sees them all.

```jsonc
"requirements": ["df", "tail", "awk"]
```

```js
await axion.exec('df -h | tail -n 1 | awk "{print $5}"')   // ok — first token (df) declared
```

**The trust UI is built around this list.** When the user clicks Trust on your plugin, they see "Will run on the remote: `uptime` `df` `ls`" — concrete, scannable. The same pills appear on the row in the Plugins app so the contract stays visible after trust.

**Broad-power tools.** A curated set of binaries can run arbitrary shell as a side effect — `bash`, `python`, `sqlite3` (`.system`), `find` (`-exec`), `awk` (`system()`), `vi` (`:!`), `less` (`!`), `sudo`, `ssh`, etc. Declaring one of these is fine — sometimes you genuinely need it — but it shows up in the trust UI as **warn-tinted** and the modal explicitly says "this can run arbitrary shell as a side effect". The user can still trust it; we just refuse to lie about what it implies.

**The take-away for plugin authors.** Be honest in `requirements`. If you add a new command in your code, add it to the manifest in the same change — the digest invalidates, the user re-trusts, and they re-read the contract. That's the whole loop.

### The sudo contract

Some plugins need to run things as root — installing packages, restarting a service, editing a config under `/etc`. The `ssh.sudo` permission unlocks `axion.sudo(command)`, but the model is deliberately heavier than `axion.exec`:

1. **The user types their password into Axion, not into the plugin.** When `axion.sudo(...)` is called, the host shows a modal with the plugin's name, the exact command, and a password field. Plugin code never sees what was typed. Axion forwards `<password>\n` to `sudo -S` on the remote channel and the password buffer is dropped immediately after.

2. **No caching, no sudoers magic.** The host does not remember the password between calls — every `axion.sudo` reprompts. We don't issue `sudo -v` on your behalf or extend a timestamp. If the user wants passwordless sudo on the remote, that's a remote configuration choice; Axion does not nudge it.

3. **Same drift guard as `axion.exec`.** The first program token must appear in `requirements`. Pipelines need every binary declared. The trust UI shows the same pill list — sudo doesn't widen the visibility contract, it adds an extra modal on top.

4. **`sudo` itself counts as a broad-power tool.** Whether you use `axion.sudo` or `axion.exec('sudo …')`, the broad-power flag in the trust UI lights up. Prefer `axion.sudo` — it gives the user the per-call confirmation and password prompt, instead of letting the plugin pipe a password through stdin itself.

```jsonc
"permissions": ["ssh.sudo"],
"requirements": ["apt-get"]
```

```js
const r = await axion.sudo('apt-get update')
//  →  modal: "MyPlugin wants to run a command as root: sudo apt-get update"
//     user types pw + Run → r is { stdout, stderr, exitCode }
//     user clicks Cancel  → throws { code: 'E_SUDO_CANCELLED' }
```

**Wrong password?** sudo prints `Sorry, try again.` to stderr and exits non-zero. The SDK returns that result verbatim — *the call doesn't reject*. Decide for yourself whether to call `axion.sudo` again to retry or surface the failure.

**The sudo call blocks as long as the user takes.** Every other SDK method has a 30 s safety timeout to keep a forgotten reply from stranding your code; `axion.sudo` opts out of it because the user is the one keeping the call open. Don't wrap it in your own short timeout — the modal's Cancel button is the real way the call ends.

**Be sparing with this permission.** A plugin that asks for `ssh.sudo` is asking for permission to shoulder-tap the user for credentials at any time. That's a different conversation than "let me read your free disk space" — write the description in your manifest accordingly, and only declare `ssh.sudo` if there's no `ssh.exec` shape that does the job.

### Icons

The `icon` field is an optional path inside your extension folder. It's used in four places: the dock pill (when the extension is pinned or running), the Apps launcher cell, the row in the Plugins app, and the window header (plugins only). When omitted, the host falls back to a generic puzzle-piece glyph so untouched extensions still get a recognizable mark.

```jsonc
{
  "icon": "icon.svg"          // any path inside the folder
}
```

```
<extensions-folder>/my-extension/
├── manifest.json
├── icon.svg                   // referenced from manifest
└── index.html
```

**Supported formats.** Anything the webview's `<img>` element can decode — SVG, PNG, JPEG, GIF, WebP. The icon is fetched through the same `axion-plugin://` scheme that serves your HTML, so subdirectories work too (`"icon": "assets/logo.png"`).

**SVG is the recommended format.** The same icon is rendered at three different sizes (14px in the window header, 20px in the dock, 32px in the Apps launcher). A single SVG stays crisp at every size; raster formats need to be sized somewhere close to their largest render target — a 128×128 PNG sampled down to 14px is noticeably softer than a 32×32 PNG would be. If you ship a PNG, around 64×64 is a reasonable balance.

**Graceful fallback.** If the path doesn't resolve (file missing, folder rename, typo), the host catches the load failure and quietly substitutes the puzzle-piece glyph in every place the icon would have appeared. You won't see a broken-image placeholder — but the manifest is still wrong, so check the row in the Plugins app if your icon isn't showing.

**Trust gate.** The icon loads regardless of the extension's trust state — it's just a static asset. Untrusted extensions still display their authored icon in the Plugins app, so a user can recognize what they're about to trust.

---

## The host SDK (`window.axion`)

The host injects `<script src="axion-plugin://_/sdk.js">` into every HTML response your extension serves, so `window.axion` is defined before any of your scripts run. **Don't include the SDK script yourself.**

### Session metadata

```js
window.axion.session
// { id: string, host: string, user: string }  — null if not connected
```

### Lifecycle events

```js
window.axion.on('ready', (info) => {
  // info = { extId, session, theme, permissions, openFile, settings }
  // Fired once the handshake completes — kick off your initial work here.
});

window.axion.on('session-change', (payload) => {
  // The active SSH session changed (reconnect, tab switch).
});

window.axion.on('theme-change', (theme) => {
  // The user changed accent or surface palette in Settings.
});
```

### Opened file

When the user double-clicks a file in the Files app and your plugin claims that file's extension via `presentations.plugin.fileExtensions`, the host launches a fresh window and exposes the path to your code:

```js
window.axion.openedFile
// { path: string }  — null if the plugin was launched from the dock or
//                     Plugins app instead of from a file
```

`openedFile` is populated synchronously after the `ready` event fires, so the typical pattern is:

```js
axion.on('ready', async () => {
  if (!axion.openedFile) {
    // Launched without a file — show your empty state, file picker, etc.
    return;
  }
  const bytes = await axion.sftp.read(axion.openedFile.path);
  render(new TextDecoder().decode(bytes));
});
```

### Remote shell

```js
const r = await window.axion.exec('uptime');
// r = { stdout: string, stderr: string, exitCode: number }
```

### SFTP

```js
const entries = await window.axion.sftp.list('/var/log');
const meta    = await window.axion.sftp.stat('/etc/hostname');
const bytes   = await window.axion.sftp.read('/etc/hostname'); // Uint8Array

await window.axion.sftp.write('/tmp/test.txt', new TextEncoder().encode('hello'));
await window.axion.sftp.mkdir('/tmp/foo');
await window.axion.sftp.rename('/tmp/foo', '/tmp/bar');
await window.axion.sftp.remove('/tmp/bar', { recursive: false });
```

### Per-extension storage

Key/value storage scoped to your extension id. Persisted to a file inside your extension folder. Always available — no permission required.

```js
await window.axion.storage.set('lastQuery', 'foo');
const v = await window.axion.storage.get('lastQuery'); // any JSON value
await window.axion.storage.remove('lastQuery');
```

### Window controls (plugins only)

```js
window.axion.window.setTitle('Updated title');
window.axion.window.close();
```

### Widget controls (widgets only)

```js
// Tell the host how tall your widget body needs to be.
window.axion.widget.requestHeight(140);

// Same, but for width. Heights are independent — request either or
// both. Sensible bounds: 40–800px wide, 24–800px tall.
window.axion.widget.requestWidth(220);

// Set both at once (equivalent to a paired width + height call).
window.axion.widget.requestSize(220, 140);

// Convenience: install a ResizeObserver and report both dimensions
// back automatically. Call once on `ready`. The argument is the
// element to observe — pass a CSS selector or an Element. Defaults
// to <body>, but <body> always fills the iframe's width, so for
// content-hugging widgets you should point this at your inner
// content wrapper instead. Examples:
window.axion.widget.autoSize();              // body — height only useful
window.axion.widget.autoSize('.clock');      // measure the .clock pill
window.axion.widget.autoSize(document.getElementById('content'));

// Open the Plugins launcher with this extension highlighted.
window.axion.widget.openSettings();
```

The `defaultSize` enum in your manifest (`sm` / `md` / `lg`) is the *initial* width and height of the widget shell. As soon as your code calls any of the request methods above, the shell adopts whatever dimensions you reported — so the enum acts as a starting hint, not a cap. For floating chromeless widgets in particular (`transparent: true`), `autoSize()` is the cleanest way to make the widget hug your actual painted content.

### Transparent widgets

By default a widget renders inside a frosted-glass card with padding, a border, and a soft shadow — the host's chrome. If your widget is a simple visual that should blend into the wallpaper (a digital clock, a status pill, a one-line readout), set `presentations.widget.transparent: true` in the manifest. The host then drops the card entirely and your iframe paints directly on the desktop.

When you opt into transparency you take ownership of your own visuals — there is no panel behind your content, so:

- Pick text colors that read against any wallpaper. The injected theme stylesheet (`/_/theme.css`) gives you `--color-text-primary` and friends, but you may want a `text-shadow` or your own pill background for high-contrast scenes.
- Don't expect a click target outside your painted pixels. The widget's bounding box still sizes via `defaultSize` / `requestHeight`, but transparent areas inside the iframe pass clicks through to your own elements only.
- Loading, missing-requirement, error, and trust-gate states still render inside the chromed shell so their messages stay readable — transparency only kicks in once your iframe is actually mounted.

### Theme tokens

```js
const theme = window.axion.ui.theme();
// theme.tokens = {
//   accent, accentDeep, accentMid, onAccent,
//   bg0, bg1, bg2, surface1, surface2,
//   textPrimary, textSecondary, textMuted,
//   borderSubtle, borderStrong
// }
```

The simplest way to consume them is through the **stylesheet** the host injects into your iframe — see "Styling" below. The `ui.theme()` accessor is for runtime palette switches, where you want to react to a `theme-change` event without reloading.

```js
function applyTheme(theme) {
  const r = document.documentElement.style;
  const t = (theme && theme.tokens) || {};
  if (t.accent) r.setProperty('--color-accent', t.accent);
}
window.axion.on('ready', (info) => applyTheme(info && info.theme));
window.axion.on('theme-change', applyTheme);
```

### Toasts

Show a transient toast in the desktop's bottom-right stack. Useful for "Saved", "Copied to clipboard", error messages — anything you'd otherwise put in your own banner.

```js
window.axion.ui.notify('Query saved.');

// With a tone — controls the icon and accent color.
window.axion.ui.notify('Could not connect to MySQL.', { tone: 'error' });
window.axion.ui.notify('3 rows updated.', { tone: 'success' });
window.axion.ui.notify('Disk almost full.', { tone: 'warn' });
```

Tones: `info` (default) · `success` · `warn` · `error`. Toasts auto-dismiss after ~5s. The host owns the styling, position, and timing — your call returns immediately and you don't need to track the toast yourself.

`axion.ui.*` is always available, no permission required.

### Launching built-in apps

A plugin can hand a remote path off to one of the built-in apps in a fresh window. Useful for "open this log in the editor" / "show this file in the file manager" style buttons. Each surface is gated behind its own manifest permission so granting one doesn't grant the others.

```js
// Files app — open a folder.
await axion.files.show('/var/log');

// Editor — open a file for editing.
await axion.editor.open('/etc/hosts');

// Image Viewer — open an image. Non-image extensions show the
// "isn't an image" state; the viewer accepts the path either way.
await axion.imageViewer.open('/srv/static/cat.png');

// Terminal — open a new shell, then send `cd <path>`.
await axion.terminal.openAt('/srv/site');
```

Each call resolves to `null` when the launch is dispatched — the host doesn't wait for the new window to finish loading. Failures (missing permission, malformed path) reject with the usual error codes (`E_PERMISSION_DENIED`, `E_INVALID_ARG`).

**Cross-plugin launching is intentionally not exposed.** A plugin can launch the Files / Editor / Image Viewer / Terminal built-ins, but not other plugins — there's no `axion.launch('plugin:other-id')`. If you need to coordinate with another plugin, use `axion.storage` or external state.

---

## Styling

The host injects a stylesheet (`/_/theme.css`) into every plugin and widget iframe **before** any author CSS, so you get:

- The Aurora design tokens as plain CSS variables (`--color-accent`, `--color-surface-1`, `--radius-sm`, …)
- Roboto Light + the host's text color on the document body
- A transparent body background so the window's blur shows through
- A set of `ax-`-prefixed utility classes that match the host chrome

You don't need to import or link anything — drop into your HTML and reference the classes or vars. Plugin CSS still wins on conflict (the host stylesheet sits in `<head>` before yours).

### Design tokens as CSS variables

All available on `:root`. Use them anywhere — `background: var(--color-surface-1)`, `border-radius: var(--radius-sm)`, etc.

| Group | Variables |
|-------|-----------|
| Backgrounds | `--color-bg-0` `--color-bg-1` `--color-bg-2` |
| Glass surfaces | `--color-surface-1` `--color-surface-2` `--color-surface-3` `--color-popup-bg` |
| Borders | `--color-border-subtle` `--color-border-strong` |
| Text | `--color-text-primary` `--color-text-secondary` `--color-text-muted` |
| Accent | `--color-accent` `--color-accent-soft` `--color-accent-deep` `--color-accent-glow` `--color-accent-tint` `--color-on-accent` |
| Status | `--color-success` `--color-warn` `--color-error` |
| Gradient | `--gradient-primary` |
| Radii | `--radius-xs` `--radius-sm` `--radius-md` `--radius-lg` `--radius-xl` |
| Shadow / blur | `--shadow-glow` `--shadow-window` `--blur-glass` |
| Fonts | `--font-sans` `--font-mono` |

### Utility classes

All classes are namespaced with `ax-` so they never collide with selectors you author yourself. Mix and match.

#### Typography

| Class | Effect |
|-------|--------|
| `ax-h1` `ax-h2` `ax-h3` | Heading sizes, `ax-h2` is uppercase + accent |
| `ax-text` | 13px primary text |
| `ax-text-secondary` | Secondary text color |
| `ax-text-muted` | Muted text, slightly smaller |
| `ax-text-accent` `ax-text-success` `ax-text-warn` `ax-text-error` | Color helpers |
| `ax-mono` | Monospace, 12px |
| `ax-label` | Form-style uppercase mini-label |

#### Layout

| Class | Effect |
|-------|--------|
| `ax-container` | Standard 20px / 22px window padding |
| `ax-stack` | `display: flex; flex-direction: column; gap: 10px` |
| `ax-row` | `display: flex; align-items: center; gap: 10px` |
| `ax-divider` | 1px subtle horizontal rule |

#### Surfaces

| Class | Effect |
|-------|--------|
| `ax-surface` | Translucent glass panel — main content card |
| `ax-surface-raised` | One step lighter than `ax-surface` |
| `ax-glass` | Heavy frosted panel (uses `backdrop-filter`) — dialog-style |
| `ax-card` | Same as `ax-surface` with hover lift; for clickable rows |

#### Buttons

Pair the base `ax-btn` with one variant. `ax-btn-sm` shrinks any of them.

| Class | Effect |
|-------|--------|
| `ax-btn ax-btn-primary` | Solid accent — primary action |
| `ax-btn ax-btn-outline` | Bordered — secondary action |
| `ax-btn ax-btn-ghost` | Transparent — tertiary / icon row |
| `ax-btn ax-btn-danger` | Solid error red — destructive |
| `ax-btn ax-btn-sm` | Smaller padding + 12px text |

```html
<button class="ax-btn ax-btn-primary">Save</button>
<button class="ax-btn ax-btn-outline" disabled>Cancel</button>
<button class="ax-btn ax-btn-ghost ax-btn-sm">Refresh</button>
```

#### Inputs

| Class | Effect |
|-------|--------|
| `ax-input` | Text input — applies to `<input>` of any text-like type |
| `ax-textarea` | Same look, vertical resize, 80px min |
| `ax-select` | Native `<select>` styled to match |
| `ax-label` | The uppercase label that sits above the field |

```html
<label class="ax-label">Host</label>
<input class="ax-input" placeholder="example.com" />
```

#### Pills

For status badges, counts, tags. Sit at the end of a row.

```html
<span class="ax-pill">Idle</span>
<span class="ax-pill ax-pill-accent">Active</span>
<span class="ax-pill ax-pill-success">3 OK</span>
<span class="ax-pill ax-pill-warn">2 stale</span>
<span class="ax-pill ax-pill-error">1 failed</span>
```

#### Code & empty state

| Class | Effect |
|-------|--------|
| `ax-code` | `<pre>` styled like the host's code blocks (dark surface, mono, scroll on overflow) |
| `ax-empty` | Centered empty-state container |
| `ax-empty-title` | Stronger emphasis line inside `ax-empty` |

```html
<div class="ax-empty">
  <div class="ax-empty-title">No log entries</div>
  <div>Run a command to populate this view.</div>
</div>
```

### Putting it together

```html
<main class="ax-container ax-stack">
  <header class="ax-row" style="justify-content: space-between;">
    <h1 class="ax-h1">Disk usage</h1>
    <span class="ax-pill ax-pill-accent" id="status">idle</span>
  </header>

  <section class="ax-surface ax-stack">
    <label class="ax-label">Path</label>
    <input class="ax-input" id="path" value="/" />
    <div class="ax-row" style="justify-content: flex-end;">
      <button class="ax-btn ax-btn-ghost ax-btn-sm" id="reset">Reset</button>
      <button class="ax-btn ax-btn-primary" id="run">Run</button>
    </div>
  </section>

  <pre class="ax-code" id="out"></pre>
</main>
```

---

## Errors

Every SDK method returns a Promise. Rejections are `Error`-like objects with a structured `code`:

| Code | Meaning |
|------|---------|
| `E_PERMISSION_DENIED` | Capability not declared in `manifest.permissions` |
| `E_NO_SESSION` | No active SSH session right now |
| `E_TIMEOUT` | RPC took longer than 30 seconds |
| `E_UNKNOWN_METHOD` | Method name the host doesn't recognize |
| `E_UNKNOWN` | Anything else |

```js
try {
  await window.axion.exec('whoami');
} catch (e) {
  if (e.code === 'E_PERMISSION_DENIED') { /* ... */ }
}
```

---

## Boilerplates

### Minimal widget

`manifest.json`:

```json
{
  "id": "hello-widget",
  "name": "Hello",
  "version": "1.0.0",
  "description": "Shows the remote hostname.",
  "presentations": {
    "widget": { "entry": "index.html", "defaultSlot": "right", "defaultSize": "md" }
  },
  "permissions": ["ssh.exec"],
  "requirements": [],
  "sdk": "1"
}
```

`index.html`:

```html
<!doctype html>
<html>
<head>
<style>
  body { margin: 0; padding: 10px 14px; overflow: hidden; }
  /* font-variant-numeric so the value column doesn't jiggle as digits change */
  .val { color: var(--color-accent); font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
</style>
</head>
<body>
  <div class="ax-label">Hello</div>
  <div class="ax-row" style="justify-content: space-between;">
    <span class="ax-text-secondary">Hostname</span>
    <span class="val" id="host">—</span>
  </div>

<script>
  function fitToContent() {
    if (!window.axion?.widget?.requestHeight) return;
    const h = Math.ceil(document.body.getBoundingClientRect().height);
    if (h > 0) window.axion.widget.requestHeight(h);
  }

  async function refresh() {
    try {
      const r = await window.axion.exec('hostname');
      document.getElementById('host').textContent = (r.stdout || '').trim();
    } catch (e) { console.error(e); }
  }

  window.axion?.on('ready', () => { refresh(); fitToContent(); });
  setInterval(refresh, 5000);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(fitToContent).observe(document.body);
  }
</script>
</body>
</html>
```

### Minimal plugin

`manifest.json`:

```json
{
  "id": "hello-plugin",
  "name": "Hello",
  "version": "1.0.0",
  "description": "Runs `uptime` on the remote and prints the result.",
  "presentations": {
    "plugin": { "entry": "index.html", "defaultSize": { "w": 720, "h": 520 } }
  },
  "permissions": ["ssh.exec"],
  "requirements": [],
  "sdk": "1"
}
```

`index.html`:

```html
<!doctype html>
<html>
<head>
<style>body { margin: 0; }</style>
</head>
<body>
  <main class="ax-container ax-stack">
    <h1 class="ax-h1">Hello</h1>
    <div class="ax-row">
      <button class="ax-btn ax-btn-primary" id="run">Run uptime</button>
      <button class="ax-btn ax-btn-ghost" id="clear">Clear</button>
    </div>
    <pre class="ax-code" id="out">Click the button.</pre>
  </main>

<script>
  const out = document.getElementById('out');

  document.getElementById('run').addEventListener('click', async () => {
    out.textContent = 'Running…';
    try {
      const r = await window.axion.exec('uptime');
      out.textContent = (r.stdout || '').trim() || '(no output)';
    } catch (e) {
      out.textContent = 'Error: ' + (e.message || e);
    }
  });

  document.getElementById('clear').addEventListener('click', () => {
    out.textContent = '';
  });

  window.axion?.on('ready', () => window.axion.window?.setTitle('Hello'));
</script>
</body>
</html>
```

---

## Common patterns

### Auto-fit a widget to its content

Widgets pick their initial dimensions from the manifest's `defaultSize`, but you can shrink/grow them at runtime to exactly fit your content. The SDK ships an `autoSize(target)` helper that wires up a `ResizeObserver` on the element you pass and posts both width and height back to the host:

```html
<style>
  html, body { margin: 0; padding: 0; overflow: hidden; }
  /* Wrap your widget's content in an element you can measure. The
     body itself always fills the iframe width, so to hug the
     content's actual width you need an inner wrapper. */
  .pill { display: inline-block; padding: 6px 12px; }
</style>
<body>
  <div class="pill">Hello, world</div>
  <script>
    window.axion?.on('ready', () => {
      // Observe the inner pill — when its size changes the widget
      // shell follows. Without a target, autoSize() observes <body>
      // which always fills the iframe and only meaningfully tracks
      // height.
      window.axion.widget.autoSize('.pill');
    });
  </script>
</body>
```

Need finer control? Use `requestWidth` / `requestHeight` / `requestSize` directly — same wire format `autoSize()` uses internally.

### Polling at a sane cadence

```js
let timer = null;
function start() { void refresh(); timer = setInterval(refresh, 5000); }
function stop()  { if (timer) { clearInterval(timer); timer = null; } }
window.axion.on('ready', start);
```

### Detecting optional commands at runtime

`requirements` blocks the iframe from loading at all when commands are missing. For *optional* features (e.g., GPU stats on hosts that have `nvidia-smi`), probe at runtime instead:

```js
async function hasCommand(cmd) {
  try {
    const r = await window.axion.exec(
      "command -v " + JSON.stringify(cmd) + " >/dev/null 2>&1 && echo y || echo n"
    );
    return (r.stdout || '').trim() === 'y';
  } catch {
    return false;
  }
}
```

### Combining many remote calls into one round-trip

For a plugin that needs five separate commands' output, one `axion.exec` with `;`-joined commands and sentinel-marked sections is far cheaper than five round-trips:

```js
const SEP = '<<MARKER>>';
const cmd = [
  'echo "' + SEP + ':uname"',  'uname -a',
  'echo "' + SEP + ':uptime"', 'uptime',
  'echo "' + SEP + ':disk"',   'df -h',
].join(' ; ');

const r = await window.axion.exec(cmd);
// Split r.stdout on the sentinel and parse each block.
```

### Authoring a file-opener plugin

A minimal plugin that registers itself for `.md` files and renders the contents:

```jsonc
// manifest.json
{
  "id": "md-viewer",
  "name": "Markdown Viewer",
  "version": "1.0.0",
  "presentations": {
    "plugin": {
      "entry": "index.html",
      "fileExtensions": ["md", "markdown"]
    }
  },
  "permissions": ["sftp.read"],
  "sdk": "1"
}
```

```html
<!-- index.html -->
<!doctype html>
<html><body>
<pre id="out">Loading…</pre>
<script>
  axion.on('ready', async () => {
    const out = document.getElementById('out');
    if (!axion.openedFile) {
      out.textContent = 'Open a .md file from Files to view it here.';
      return;
    }
    try {
      const bytes = await axion.sftp.read(axion.openedFile.path);
      out.textContent = new TextDecoder().decode(bytes);
      axion.window.setTitle(axion.openedFile.path.split('/').pop());
    } catch (e) {
      out.textContent = 'Error: ' + (e.message || e);
    }
  });
</script>
</body></html>
```

After installing and **trusting** this plugin, double-clicking any `*.md` in the Files app launches it with the file already loaded.

---

## File associations

Plugins can register themselves as the default opener for specific file extensions. When a user double-clicks a matching file in the Files app, the host launches the plugin instead of the built-in Editor or Image Viewer.

**Declaring associations** — in your manifest:

```jsonc
"presentations": {
  "plugin": {
    "entry": "index.html",
    "fileExtensions": ["md", "markdown", "mdx"]
  }
}
```

Rules:

- Extensions are normalized at load time. `["MD", ".markdown"]` becomes `["md", "markdown"]` — write whichever feels natural.
- Only **trusted** plugins (state `trusted` or `builtin`) participate in dispatch. An `untrusted` or `tampered` plugin is ignored, even if the user installed it. This is intentional: a hostile manifest editing itself to claim `.json` shouldn't be enough to redirect the user's files.
- If multiple trusted plugins claim the same extension, the first match wins (in `extensions_list` order). Users can disambiguate by uninstalling the one they don't want — a richer "Open with…" picker may land later.
- Plugins always beat the built-in fallback. If your plugin claims `md`, the Editor stops being the default for `*.md`.
- The user can still open any file in the Editor by other means (the Editor app launched from the dock, copy-paste, etc.) — associations only affect double-click and search-result-click in Files.

**Receiving the path** — once the host launches your plugin, it forwards the absolute remote path through the bridge handshake and your SDK exposes it as `axion.openedFile`. See "Opened file" above for the consumption pattern.

**One window per file** — the host opens a fresh plugin window for each file. Plugins are not singletons by default; you don't need to reconcile multiple file paths in one instance.

### User overrides

The list you ship in `fileExtensions` is the *authored default*, not a hard rule. From the gear icon on your plugin's row in the Plugins app, the user can:

- **Disable any declared extension** — toggle it off and your plugin stops being the default for that file type without anyone editing the manifest. Useful when an SQLite plugin claims `.db` but the user has another tool that already owns `.db` files.
- **Add custom extensions** — extend the list with file types your manifest didn't claim. Useful when a plugin handles a generic format under multiple project-specific names (e.g. add `.sqlite3` and `.db3` on top of a manifest that only ships `.db`).

The dispatcher (and the Files app's "Open with…" picker) reads the *effective* list — manifest minus disabled, plus user-added — so the user's choices take effect immediately. Your plugin code doesn't need to do anything; the manifest stays the source of truth, and overrides live in `<app_data_dir>/extensions-file-extensions.json` keyed by your extension id. Resetting to defaults from the same modal clears all overrides for that plugin.

A plugin with `fileExtensions: []` (or no `plugin` presentation) hides this section entirely. A plugin that ships an empty list but is configured to *only* match user-added extensions also works — the user can build the association themselves.

---

## Settings

Plugins and widgets can declare user-configurable variables in their manifest. The host renders a form for them (gear icon on the row in the Plugins app), persists user-set values, and surfaces resolved values back to the iframe through `axion.settings`.

**Declaring settings** — in your manifest's top-level `settings` array:

```jsonc
"settings": [
  { "name": "apiUrl",   "title": "API URL",        "type": "string",  "default": "https://api.example.com",
    "placeholder": "https://...", "description": "Where to send requests." },
  { "name": "interval", "title": "Refresh (sec)",  "type": "number",  "default": 30, "min": 1, "max": 3600, "step": 1 },
  { "name": "compact",  "title": "Compact layout", "type": "boolean", "default": false,
    "description": "Hide the header and tighten paddings." },
  { "name": "theme",    "title": "Theme",          "type": "select",  "default": "auto",
    "options": [
      { "value": "light", "label": "Light" },
      { "value": "dark",  "label": "Dark"  },
      { "value": "auto",  "label": "Match host" }
    ]
  }
]
```

### Setting fields

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Stable key — also the lookup key in `axion.settings[name]` |
| `title` | yes | Label rendered above the form field |
| `description` | optional | Helper text under the field |
| `type` | yes | `string` / `number` / `boolean` / `select` |
| `default` | optional | Type-appropriate JSON value (string for `string`/`select`, number for `number`, boolean for `boolean`) |
| `min` / `max` / `step` | `number` only | Soft bounds and increment for the input |
| `placeholder` | `string` only | Empty-state hint |
| `options` | `select` only | Array of `{ value, label }` choices |

### Reading values

After the SDK handshake finishes (the `ready` event), `axion.settings` is a frozen plain object keyed by your `name` fields:

```js
axion.on('ready', () => {
  const url = axion.settings.apiUrl;
  const intervalMs = axion.settings.interval * 1000;
  if (axion.settings.compact) document.body.classList.add('compact');

  const tick = () => fetch(url).then(...)
  tick();
  setInterval(tick, intervalMs);
});
```

**Resolved values, not just overrides** — `axion.settings` already merges manifest defaults with the user's explicit overrides, so you don't need to fall back to defaults yourself. If a setting hasn't been touched, you get its `default`. If no `default` is declared, you get `""` for strings/select, `0` for numbers, `false` for booleans.

### Save → reload lifecycle

When the user saves new values from the host's settings modal:

1. The host persists overrides to `<app_data_dir>/extensions-settings.json`.
2. **Every open window/widget instance of that extension is reloaded** (the iframe is re-keyed; a new handshake happens).
3. Your code sees the new values in `axion.settings` on the next `ready` event.

This means your plugin doesn't need to subscribe to "settings changed" events — fresh values always arrive via the standard handshake. Just read `axion.settings` whenever you'd normally read your config.

### Trust required

Like file associations, settings live behind the trust gate. **Untrusted** and **tampered** extensions don't get a settings UI in the Plugins app — the gear icon only appears once the user has trusted the extension's current digest. After a settings change, the digest is unchanged (settings live in host storage, not in the extension folder), so trust state stays the same.

### Reset to defaults

The settings modal has a **Reset to defaults** button that wipes all user overrides for that extension. This calls the same save path internally, so iframes reload and `axion.settings` reflects the manifest's `default` values.

---

## Sandbox & security

- Your iframe runs with `sandbox="allow-scripts"` only — **no** `allow-same-origin`. Your origin is opaque.
- You **cannot** read host cookies, the host DOM, or other extensions' storage.
- Every host capability goes through `window.axion`, which the host gates against your manifest's `permissions`.
- The sandbox blocks navigation outside `axion-plugin://`. Internal links across files within your own extension work; external `<a href="https://...">` does not.
- Plugins never see SSH passwords or private keys — those stay in the host's vault. The session metadata you receive is host / user only.

---

## Trust pinning

Every user-installed extension has a SHA-256 digest computed over its on-disk content (manifest + assets, excluding `.storage.json` and dotfiles). The host stores user-pinned digests in `<app_data_dir>/extensions-trust.json` and uses them to gate launching.

Each extension is in one of four trust states, surfaced as a pill in the Plugins app:

| State | Meaning | What the user sees |
|-------|---------|--------------------|
| `builtin` | Shipped with the host binary | No gate — launches freely |
| `untrusted` | Installed but not yet pinned | **Trust** button on the row; **Launch** is disabled. Plugin / widget bodies render a gate with a Trust action |
| `trusted` | Pinned digest matches current digest | No gate |
| `tampered` | Pinned digest no longer matches — files have been edited since the pin | Warning row with **Re-trust**; bodies refuse to render until re-pinned |

This is a **trust-on-first-use (TOFU)** model — the same shape as SSH host-key pinning. The host doesn't decide what's safe; the user does, and the digest catches drift.

**As an author**, this means:

- Edits to your manifest, HTML, JS, or CSS will flip your extension to `tampered` for anyone who already pinned it. Cut a new version and tell users to re-trust on update.
- `.storage.json` writes from your extension don't affect the digest, so runtime state changes are fine.
- During development, you'll need to re-trust after each edit — there's no auto-pin shortcut by design.

**As a user**, when an extension shows `tampered`, **read the diff before re-trusting**. The host has no way to tell whether a change is benign (the author shipped a fix) or hostile (someone edited an extension you already had).

---

## Reveal in folder

The Plugins app's toolbar has a **Reveal** button next to the extensions folder path. It opens the folder in your OS file manager (Explorer / Finder / xdg-open) and creates the directory first if it doesn't exist yet — useful for first-time authoring when the folder is otherwise empty.

---

## Troubleshooting

**"My extension doesn't show up after I add the folder."**

Check:
- The folder name matches `manifest.json`'s `id` exactly.
- The file is named `manifest.json` — Windows Notepad with hidden extensions can save it as `manifest.json.txt`. Enable "View → File name extensions" in Explorer to verify.
- The JSON is valid (no trailing commas, no missing quotes). If you launch from `bun run tauri:dev`, an invalid manifest prints `invalid manifest "...": <error>` in the terminal.
- You hit **Refresh** in the Plugins app after adding the folder.

**"My iframe shows 'Missing on remote: <cmd>'."**

The remote host doesn't have one of the commands you listed in `requirements`. Either install it on the host, or remove that command from `requirements` and probe at runtime instead.

**"My SDK call returned `E_PERMISSION_DENIED`."**

The capability isn't in your manifest's `permissions` array. Add it and reload (the requirements/permissions check runs once per mount).

**"My plugin window says 'isn't trusted' / 'files have changed'."**

The user hasn't pinned your extension's digest yet, or your files have changed since the last pin. Click **Trust this plugin** in the gate (or **Trust** on the row in the Plugins app) to pin the current digest. After every release, recipients will need to re-trust once.

---

## Distribution

For now, distribution is drop-in:

1. Zip your extension folder.
2. Send the recipient the zip.
3. They unzip into their extensions directory and click **Refresh** in the Plugins app.

Hot-reload during development, install-from-URL, signed marketplace bundles — all on the roadmap.
