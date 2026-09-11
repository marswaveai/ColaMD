# Feature Requests

This is the holding list for requests that have a clear user need but are not committed roadmap work. Entries stay here until they are accepted into a release plan or explicitly declined.

## Implemented On Main

These features are implemented on `main` and await release verification.

### Export Word (.docx)

**Sources:** [#31](https://github.com/marswaveai/ColaMD/issues/31)

**Status:** Exports GFM document structure, common inline formatting, lists, tables, links, code blocks, and standalone local images to `.docx`. HTML and unsupported syntax degrade to text.

### Export shareable images

**Sources:** [#35](https://github.com/marswaveai/ColaMD/issues/35)

**Status:** Exports desktop and mobile reading pages as separate PNG files. Longer documents continue as numbered pages, with the final page trimmed to its content.

### Document outline

**Sources:** [#21](https://github.com/marswaveai/ColaMD/issues/21), [#27](https://github.com/marswaveai/ColaMD/issues/27), [#64](https://github.com/marswaveai/ColaMD/issues/64)

**Status:** Adds a Files / Outline switch in the existing sidebar. Headings navigate in both visual and Markdown source modes. The outline doubles as a reading-progress view: the entry for the section at the top of the viewport is highlighted while scrolling (both modes), the active entry stays revealed in long documents, and jumping from the outline or an anchor link flashes the landing heading once so the arrival is visible. Colors derive from each theme's link color. Long headings expose their full text through a hover tooltip.

### Resizable file panel

**Sources:** [#64](https://github.com/marswaveai/ColaMD/issues/64)

**Status:** The panel's right edge offers a lightweight drag hot zone (no permanent handle icon, hover stripe only, per design.md) to resize between 180px and 420px. The choice persists locally, the default stays 220px, and the hot zone hides with the panel.

### Windows startup performance

**Sources:** [#32](https://github.com/marswaveai/ColaMD/issues/32)

**Status:** Adds opt-in `COLAMD_STARTUP_TRACE=1` timing from main-process load through editor readiness. Export dependencies are dynamically loaded, reducing the main startup bundle from about 1.73 MB to 604 KB.

### Diagram rendering (Mermaid)

**Sources:** [#26](https://github.com/marswaveai/ColaMD/issues/26)

**Status:** Mermaid blocks render through a lazily created hidden iframe, isolated from the main bundle (same-process iframe isolation, not a hardened browser sandbox). Includes 400ms debounce, click-to-edit source mode, and a 15s timeout recovery. The earlier CPU-storm removal (v1.8.1) is addressed by ignoring view-internal DOM mutations in the node view.

### Visible save status hint

**Source:** [#49](https://github.com/marswaveai/ColaMD/issues/49)

**Status:** A quiet `未保存 / 已保存` hint sits beside the filename in the title bar. `未保存` shows while edits are pending; `已保存` flashes after autosave or manual save, then fades out. No timestamps, no toasts.

### Heading anchor navigation

**Source:** [#50](https://github.com/marswaveai/ColaMD/issues/50)

**Status:** Plain clicks on `[text](#anchor)` links jump to the matching heading with a smooth scroll. Slug resolution follows GitHub rules: lowercase, punctuation stripped, CJK preserved, URL-encoded targets decoded, case-insensitive fallback, and `-1`/`-2` suffixes for repeated headings. External links keep the ⌘/Ctrl+click-to-open behavior; anchor clicks never move the caret.

### Theme menu selected state

**Status:** Theme menu entries are now checkboxes showing the active theme, including imported custom themes. The renderer reports the applied theme to the main process, which rebuilds the menu on change.

### Recent files and restore last session

**Source:** [#28](https://github.com/marswaveai/ColaMD/issues/28), [#45](https://github.com/marswaveai/ColaMD/issues/45)

**Status:** File → Open Recent lists the last 10 documents (stale paths pruned). Opening or Save-As records the file in `~/.colamd/recent.json`. At launch the app reopens the most recent document by default; a checkbox in the same submenu turns restore off, and Clear Recent wipes the list. The startup restore policy is queued for redesign; the desired default is a blank launch unless the previous session ended unexpectedly or the system restarted.

### Configurable editor font

**Source:** User request (#7752855)

**Status:** View → Editor Font… opens a settings dialog with font family and size plus a live preview. The preference is layered user > theme > defaults, overriding only the editor prose and source mode; code blocks and UI keep their theme fonts. Stored locally, synced across windows.

### Multiple windows

**Source:** [#44](https://github.com/marswaveai/ColaMD/issues/44)

**Status:** File → New Window opens an independent editor window; opening a file that is already open focuses its window, and an empty window is reused before spawning a new one. Each window keeps its own file, save queue, watcher, and unsaved-changes guard.

### Startup session restore policy

**Source:** User feedback (2026-08-28)

**Need:** Keep normal launches blank instead of automatically reopening the last document. Reopen documents only when there is a clear recovery context, such as an unexpected app exit or system restart.

**Scope:** Separate the recent-files list from session recovery, define how intentional quit differs from a crash or restart, and keep recovery explicit and predictable. Remove or redesign the current default-on "restore last document" behavior.

**Status:** Deferred. The current restore behavior remains in `v2.0.0`; do not change it in this release.

## Security Maintenance

### Upgrade Electron and transitive security dependencies

**Source:** `npm audit` (2026-08-28)

**Need:** Upgrade the Electron runtime and its transitive dependencies to versions that address the currently reported security advisories, without weakening the app's document and renderer security model.

**Scope:** Evaluate the required Electron major-version upgrade, then verify macOS code signing and notarization, Windows and Linux builds, auto-update manifests, Mermaid rendering, file opening, IPC boundaries, and unsaved-document protection on every supported platform.

**Status:** Planned. Do not mix this with issue #55, whose reported PostCSS version is outdated and is not present in the current dependency tree.

## Candidates

### Portable build (zip distribution)

**Sources:** [#63](https://github.com/marswaveai/ColaMD/issues/63)

Publish the existing mac zip artifact as a visible download alongside the dmg so the app can run unzipped without installation. Windows portable packaging TBD.

### Slow second-file open

**Sources:** [#63](https://github.com/marswaveai/ColaMD/issues/63)

Bug report: opening the first .md is fast, but opening another file while one is already open stalls for a long time. Profile the second-open path (window reuse, watcher re-establish, editor re-init) before optimizing; measure first per the Windows startup performance precedent.
### Temporary same-directory document switcher

**Source:** User feedback and the temporary design prototype ([`temporary-document-switcher-prototype.html`](temporary-document-switcher-prototype.html), 2026-09-01)

**Need:** Reduce repeated new-window creation when moving among a few Markdown files in the same directory, especially on Windows, without introducing a workspace model.

**Scope:** A quiet switcher below the title bar, shown only with two or more documents. Start with up to three same-directory documents; preserve each document's content, dirty state, scroll position, and source/visual mode while switching. Do not support cross-directory tabs, drag sorting, pinned tabs, persistence, or startup session restoration. Current-item distinction should rely on subtle light/dark surfaces，not an accent-color underline. Refine the left-side visual spacing before implementation.

**Status:** Candidate. Prototype accepted as direction; not scheduled.

### Tabs and multi-document workspace

**Sources:** [#59](https://github.com/marswaveai/ColaMD/issues/59)

Requested: keep documents from different paths open together in one window instead of replacing the current document.

Re-opened as a candidate on 2026-09-11, at the maintainer's request, instead of staying declined. `design.md` still states "no persistent workspace and no full file tree", so the design document must be updated before this is implemented. The shape is also undecided: a tab strip, an extension of the temporary same-directory switcher, or something else that avoids a permanent extra region.

### Plugin ecosystem

**Raised:** 2026-09-11, by the maintainer.

Let people write their own plugins, so ColaMD grows through an ecosystem instead of shipping every capability itself. Mermaid is the first candidate to be extracted into a plugin, which would prove the API and keep the core small.

Open questions before any implementation: what a plugin may touch (editor commands, menus, export pipeline, file I/O), how plugins are installed and updated, the security and permission model (plugins run in the renderer, so sandboxing matters), and how to keep a default install zero-configuration.

### Knap interop (data to Markdown templates)

**Raised:** 2026-09-11, after Obsidian's author released [Knap](https://github.com/obsidianmd/knap) (MIT, `obsidianmd/knap`), a template language that turns data into Markdown, shared by Obsidian Web Clipper and Importer.

ColaMD's thesis is Markdown as a database: fixed fields in `.md`, many views on top. Knap is the mirror step, data into Markdown, so it is closer to an ingestion standard than a competitor. Two shapes worth considering, neither committed:

- Point users at Knap instead of inventing a template language: `npx knap render template.md --data article.json --output note.md` writes a file that ColaMD already hot-reloads, which makes ColaMD the live view for generated Markdown.
- Later, treat Knap as the structured-input path for the database workflow (fields in, Markdown out) and keep HTML templates as the view layer.

Interop is cheap because Knap is an AST interpreter with no `eval` and ships a CLI; reimplementing a templating language would not be.

The maintainer also raised the mirror idea on 2026-09-11: ColaMD itself could ship as a plugin for another host, so the product is both a host for templates and guests in other ecosystems. Tracked here as direction only, with no scope decided.

### Markdown formatting shortcuts

**Source:** [#58](https://github.com/marswaveai/ColaMD/issues/58)

**Need:** Provide discoverable shortcuts for common Markdown formatting such as bold, italic, links, lists, strikethrough, and inline code.

**Scope:** First evaluate the common commands and conflicts with editor/browser shortcuts. Keep shortcut customization and disable controls out of the initial implementation; they require a broader preferences/keybinding system.

**Status:** Candidate.

### Import local images

**Source:** [#21](https://github.com/marswaveai/ColaMD/issues/21)

**Need:** Insert local images into Markdown without compromising editor stability or document content.

**Status:** Deferred. The initial menu, paste, and drag-and-drop implementation was removed before `v1.9.0` after it proved unreliable.

**Scope constraint (2026-09-11):** two complete image pipelines were declined this day (see Declined → Rich image pipelines). If this is ever restarted it must stay minimal: zero configuration by default, images written next to the document as relative references, no new menu, settings panel, floating toolbar, or other persistent UI.

### Publish ColaMD for iOS

**Source:** User request

**Need:** Publish the iOS app under the unified `ColaMD` product name so anyone can install it from the App Store.

**Scope:** Publish the main ColaMD app first: create the App Store Connect record, configure Release distribution signing, upload an archive, run internal and external TestFlight verification, prepare screenshots and store metadata, complete privacy and export-compliance declarations, submit App Review, and verify public installation plus `.md` / `.txt` opening after release. Defer the Share Extension until it has a clear user need; it is an optional later update, not a prerequisite for the first release.

**Signing note:** Development signing is only for registered test devices. App Store distribution signing is a separate profile that Xcode can create and manage automatically from the company Apple Developer Program account. No manual profile editing is planned.

**Status:** Deferred. First release scope is the main app only; Share Extension remains optional.

### Merge Windows menu bar into title bar

**Source:** [#46](https://github.com/marswaveai/ColaMD/issues/46)

**Need:** On Windows, put menu items on the same row as the document title and window controls (like VS Code), reclaiming one row of vertical space.

**Why it fits:** Reduces top chrome on Windows where the separate native menu bar wastes height.

**Constraints:** Keep native minimize/maximize/close behavior, keyboard access to menus, existing shortcuts, and window dragging. Only affects Windows; macOS already integrates menus natively.

### AI-assisted features (scope undecided)

**Raised:** 2026-09-11, by the maintainer, without a chosen scope (translation mentioned as one example).

No decision yet on which AI capabilities belong in the editor, and therefore no commitment. The earlier notes on built-in translation still describe the cost of getting this wrong (provider, configuration, privacy, product scope). Any concrete proposal should start from a narrow, zero-configuration shape that does not add persistent UI, and be reviewed against the same principles as everything else.

### Footnote hover preview

**Source:** [#25](https://github.com/marswaveai/ColaMD/issues/25)

**Need:** Hover a footnote reference to preview its definition in place, instead of jumping to the document bottom.

**Why it fits:** Standard GFM footnotes (`[^1]` / `[^1]:`) are already parsed. A hover preview improves navigation without adding new UI.

**Constraints:** Build on the existing footnote rendering with a lightweight hover interaction. Do not add a permanent panel.

## Declined

### Built-in translation

Translation introduces provider, configuration, privacy, and product-scope complexity outside ColaMD's focused Markdown editing role.

### Resizable file panel

Implemented in the `2.0.2` candidate: the file panel width can be adjusted and is retained locally.

### Rich image pipelines

**Sources:** [#73](https://github.com/marswaveai/ColaMD/pull/73), [#74](https://github.com/marswaveai/ColaMD/pull/74)

Two full image workflows were declined: a configurable import pipeline (Image menu, seven folder choices, copy/reference/embed modes) and a paste pipeline with a Feishu-style floating toolbar, lightbox, and base64 migration. Both add persistent UI, settings, or image-management subsystems, and the product keeps the interface to title bar, editor, and file panel，one setting screen is already too much, and a default that needs configuring is the wrong default.

### Heuristic agent activity indicator

The status dot driven by file-watcher timing was removed on 2026-09-11. It could not distinguish an agent from any other external write (a checkout, a sync tool, another editor), so its "Agent is editing" label was a guess; and it duplicated the signal the hot reload already gives, since the document visibly updates. A real agent indicator would require an actual session handshake，an agent runtime telling the app which document it is editing，and is a separate feature, not a watcher heuristic.

### Ultrawide paged reading layouts

**Source:** [#67](https://github.com/marswaveai/ColaMD/pull/67)

Two- and three-page reading layouts for ultrawide displays were declined. ColaMD is an editor, not a paginated reader; the feature costs ~480 lines of pagination logic, hijacks wheel/trackpad/page keys, and sits on the known-fragile CSS multicol + contenteditable ground (IME, cross-column selection, position loss after external reload) for a single edge-case scenario.
