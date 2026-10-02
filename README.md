# MyWay

# Azure DevOps snippets

Browser scripts that add features to the Azure DevOps web UI. The `.js` files are the readable, commented source.
Run them from the DevTools console, or build them into a bookmarklet with the steps below.

| Script | Page | What it does |
| --- | --- | --- |
| `ado-favorite-prs.js` | `.../_git/<repo>/pullrequests` (Mine / Active tabs) | Replaces the PR list with the active PRs of all your favorite repositories. Click again to turn it off. |
| `ado-release-variables-insight.js` | Classic release definition or release | Side panel that compares variables per stage and shows references and issues. Click again to reload it. |

Each script's header comment explains what it does and how it works.

## Running from the console

Open DevTools (F12) > Console, paste the whole file and press Enter. Use this while you are developing a script.
Error messages and stack traces are much easier to read than in the minified bookmarklet.

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

## Building a bookmarklet

Requirements: Node.js. `npx` downloads [terser](https://terser.org/) on the first run.

Run this in PowerShell from the snippets folder. It creates `dist\<name>.min.js` and `dist\<name>.bookmarklet.txt` for
every script:

```powershell
New-Item -ItemType Directory -Force dist | Out-Null
foreach ($n in (Get-ChildItem *.js).BaseName) {
  npx --yes terser "$n.js" --compress --mangle --format ascii_only=true --output "dist\$n.min.js"
  node -e "const fs=require('fs');const [i,o]=process.argv.slice(1);const s=fs.readFileSync(i,'utf8').trim().replace(/;$/,'');fs.writeFileSync(o,'javascript:void '+s.replace(/[%#\r\n]/g,encodeURIComponent))" "dist\$n.min.js" "dist\$n.bookmarklet.txt"
}
```

What the build does:

1. `terser` minifies the code, removes comments, shortens local names and escapes non-ASCII characters.
2. The trailing `;` is removed and `void ` is added in front, so the URL returns `undefined`.
3. `%`, `#` and any remaining line breaks (for example in the CSS template literal) are percent-encoded.
4. `javascript:` is added in front.

Optional check that every generated bookmarklet decodes back to valid JavaScript:

```powershell
node -e "const fs=require('fs');for(const f of fs.readdirSync('dist').filter(f=>f.endsWith('.txt'))){new Function(decodeURIComponent(fs.readFileSync('dist/'+f,'utf8').slice(11)));console.log(f,'OK')}"
```

## Installing the bookmarklet

1. Open the generated `dist\<name>.bookmarklet.txt` and copy its full content (it's one line).
2. Show the bookmarks bar (Ctrl+Shift+B), right-click it and select **Add page...** (Edge: **Add favorite**).
3. Enter a name, paste the copied text into the **URL** field and save.

Don't paste the text into the address bar. For safety, browsers remove the `javascript:` prefix from pasted text.

After you change a script, rebuild it and replace the URL of the existing bookmark.

## Troubleshooting

- **Nothing happens:** open DevTools > Console and click the bookmark again. A `SyntaxError` usually means the URL was
  cut off or wasn't encoded. Rebuild the bookmarklet and paste the URL again. Managed (corporate) browsers can also
  block `javascript:` URLs by policy.
- **The page turns into a single line of text:** the code returned a value. Check that the URL starts with
  `javascript:void `.
- **Works in the console but not as a bookmarklet:** check the source against the rules above. The usual causes are
  step 2 (return value) and step 6 (CSP).
- **401 or 403 errors:** the script runs with your own ADO permissions. For the variables insight, enter a PAT with
  *Release (Read)*, *Variable Groups (Read)* and *Task Groups (Read)* when the panel asks for one.
