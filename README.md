# MyWay

Browser scripts that add features to the Azure DevOps web UI, installable as bookmarklets.

**Dashboard: https://jagantoe.github.io/MyWay/** - drag or copy a bookmarklet from there.

| Script | Page | What it does |
| --- | --- | --- |
| [`ado-favorite-prs.js`](extensions/ado-favorite-prs.js) | `.../_git/<repo>/pullrequests` (Mine / Active tabs) | Replaces the PR list with the active PRs of all your favorite repositories. Click again to turn it off. |
| [`ado-release-variables-insight.js`](extensions/ado-release-variables-insight.js) | Classic release definition or release | Side panel that compares variables per stage and shows references and issues. Click again to reload it. |

Each script's header comment explains what it does and how it works.

## Repository layout

| Path | Contents |
| --- | --- |
| `extensions/` | Readable, commented source of every extension. Add new extensions here. |
| `bookmarklets/` | **Generated** - don't edit. Per extension a `<name>.min.js` (plain JS, no comments) and a `<name>.bookmarklet.txt` (the `javascript:` URL), plus `manifest.json` that the dashboard reads. |
| `scripts/build-bookmarklets.mjs` | The converter from `extensions/` to `bookmarklets/`. |
| `index.html` | The dashboard served by GitHub Pages. It lists everything in `bookmarklets/manifest.json`, so it needs no edits for new extensions. |
| `.github/workflows/pages.yml` | CI: runs the converter, commits `bookmarklets/` and deploys the dashboard. |

## Adding an extension

1. Create `extensions/<name>.js`. Follow the [rules for writing the source](#rules-for-writing-the-source).
2. Start the file with a block comment that contains the metadata for the dashboard. `@name` and `@description` are
   required, `@page` is optional. Each tag is one line:

   ```js
   /* Azure DevOps - Short title.
    *
    * @name My extension
    * @description One sentence about what it does. Click again to turn it off.
    * @page .../_git/<repo>/pullrequests
    *
    * What it does
    *   ...
    */
   (() => {
     'use strict';
     // ...
   })();
   ```

3. Run `npm run build` (see [Building the bookmarklets](#building-the-bookmarklets)) and test the result.
4. Push to `main`. CI regenerates `bookmarklets/` if needed and the extension shows up on the dashboard.

## Running from the console

Open DevTools (F12) > Console, paste the whole file from `extensions/` and press Enter. Use this while you are
developing a script. Error messages and stack traces are much easier to read than in the minified bookmarklet.
The dashboard also lists the raw GitHub URL of each source file for this purpose.

## How a bookmarklet works

A bookmarklet is a bookmark with a `javascript:<code>` URL instead of a web address. When you click it, the browser runs
the code in the current page, in the page's own JavaScript context. The code can use:

- the page's session cookie for same-origin `fetch` calls,
- page globals such as `window.require` (the ADO AMD loader, used to get an access token for the vsrm host),
- the DOM of the page.

The code runs only once per click. A full page reload removes it. Click the bookmarklet again after a reload.

## Rules for writing the source

Follow these rules in the `.js` source so the build output always works as a bookmarklet.

1. **One self-contained IIFE.** Put everything in `(() => { ... })();`. Don't use `import`/`export`, external libraries,
   or top-level `await`. `await` inside an `async` function is fine.
2. **The result must be `undefined`.** If a `javascript:` URL returns a value, the browser replaces the page with that
   value. The build adds `void` in front. Inside the IIFE, use `return;` and never `return something;` at top level.
3. **Handle a second click.** Store an instance on `window` (`window.__favPrs`, `window.__adoVarInsight`). On the next
   run, either toggle it off or destroy it and start again. Otherwise, UI, timers and observers get added twice.
4. **Clean up after yourself.** The disable/destroy function must remove every element, `<style>`, interval,
   `MutationObserver` and event listener the script added.
5. **Handle SPA navigation.** ADO changes pages without a full reload. Watch `location.href` with an interval or a
   `MutationObserver`, and show or hide the UI when the page changes.
6. **Content Security Policy (CSP).** Current Chrome, Edge and Firefox don't apply the page's CSP to the bookmarklet
   code itself. They do apply it to anything that code loads or creates. So:
   - don't inject `<script src=...>` and don't use a "loader" bookmarklet that downloads the real script. CSP blocks it,
     and it would also let whoever controls that URL run code in your ADO session,
   - don't use `eval`, `new Function` or string `setTimeout`,
   - don't use inline event attributes (`onclick="..."`). Use `addEventListener`,
   - build the DOM with `createElement` and `textContent`, not `innerHTML`. This also keeps API data from being
     injected as HTML, and it still works if the page enforces Trusted Types.
7. **Don't store secrets.** Bookmark URLs are stored in plain text and synced. Never put a PAT or token in the source.
   Use the page's session or token, or ask for a PAT at runtime and keep it in memory only.
8. **Use only read calls,** unless a script really needs to change something. Both current scripts only send `GET`
   requests.
9. **Comments and special characters are fine in the source.** The build handles the problems below, so you don't need
   to avoid them in the readable file:
   - When a URL is saved as a bookmark, line breaks are removed. A `// comment` would then comment out everything after
     it. The minifier removes comments.
   - The browser percent-decodes the URL before it runs the code. A bare `%` (`i % 6`, `'100%'`, `/%VAR%/`) breaks the
     code or changes it, so it must be encoded as `%25`. `#` is encoded as `%23`, so no browser treats it as the start
     of a fragment.
   - Non-ASCII characters (`…`, `›`, `•`) are written as `\uXXXX` escapes (`ascii_only`), so the URL is plain ASCII.
10. **Keep the size reasonable.** Minified, the variables insight is about 45 KB, and Chromium browsers handle that
    without problems. Other browsers and bookmark sync may have lower limits on URL length. If a bookmarklet is cut off,
    it fails with a syntax error. Always test the bookmark in the browser where you'll use it.

## Building the bookmarklets

Requirements: Node.js 18 or later. Run from the repo root:

```powershell
npm install       # once, installs terser
npm run build     # regenerates bookmarklets/ from extensions/
npm run check     # fails if bookmarklets/ is missing, outdated or has stale files
```

In PowerShell with a restricted execution policy, use `npm.cmd` instead of `npm`.

For every `extensions/<name>.js` the converter ([scripts/build-bookmarklets.mjs](scripts/build-bookmarklets.mjs)):

1. Reads `@name`, `@description` and `@page` from the header comment. The build fails if `@name` or `@description`
   is missing.
2. Minifies the code with [terser](https://terser.org/): removes comments, shortens local names and escapes non-ASCII
   characters. The result is written to `bookmarklets/<name>.min.js`.
3. Removes the trailing `;` and adds `void ` in front, so the URL returns `undefined`.
4. Percent-encodes `%`, `#` and any remaining line breaks (for example in a CSS template literal).
5. Adds `javascript:` in front and writes `bookmarklets/<name>.bookmarklet.txt`.
6. Checks that the URL decodes back to a single valid JavaScript expression, and warns when it is larger than 64 KB.

It then writes `bookmarklets/manifest.json` and deletes outputs whose source no longer exists.

## CI and GitHub Pages

[.github/workflows/pages.yml](.github/workflows/pages.yml) runs on every push to `main` (and manually):

1. `npm ci` and `npm run build`.
2. If `bookmarklets/` changed, it commits the update as `github-actions[bot]`. That commit doesn't start the workflow
   again.
3. It publishes `index.html`, `extensions/` and `bookmarklets/` to GitHub Pages.

One-time setup: in the repository, go to **Settings > Pages** and set **Source** to **GitHub Actions**.

You can still commit `bookmarklets/` yourself after `npm run build`; CI then has nothing to update.

## Installing a bookmarklet

The easiest way is the [dashboard](https://jagantoe.github.io/MyWay/): show the bookmarks bar (Ctrl+Shift+B) and drag
the blue button onto it. Or copy it by hand:

1. Click **Copy bookmarklet** on the dashboard, or open `bookmarklets/<name>.bookmarklet.txt` and copy its full
   content (it's one line).
2. Right-click the bookmarks bar and select **Add page...** (Edge: **Add favorite**).
3. Enter a name, paste the copied text into the **URL** field and save.

Don't paste the text into the address bar. For safety, browsers remove the `javascript:` prefix from pasted text.

After a script changes, replace the URL of the existing bookmark with the new version.

## Troubleshooting

- **Nothing happens:** open DevTools > Console and click the bookmark again. A `SyntaxError` usually means the URL was
  cut off or wasn't encoded. Copy the bookmarklet again from the dashboard. Managed (corporate) browsers can also
  block `javascript:` URLs by policy.
- **The page turns into a single line of text:** the code returned a value. Check that the URL starts with
  `javascript:void `.
- **Works in the console but not as a bookmarklet:** check the source against the rules above. The usual causes are
  step 2 (return value) and step 6 (CSP).
- **401 or 403 errors:** the script runs with your own ADO permissions. For the variables insight, enter a PAT with
  *Release (Read)*, *Variable Groups (Read)* and *Task Groups (Read)* when the panel asks for one.
