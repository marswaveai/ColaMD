# Feature Requests

This is the holding list for requests that have a clear user need but are not committed roadmap work. Entries stay here until they are accepted into a release plan or explicitly declined.

**Issue lifecycle rule (2026-09-15)** — the GitHub issue tracker is a work queue, not an archive. Keep `open` count at zero; do not let issues linger:

1. **Fixed in code** → comment with root cause + verification, then close. The commit message references the issue number.
2. **Big or unscheduled feature requests** → record them here (with need, scope and status), reply pointing to the entry, then close the issue. The list is the tracker; the issue is not.
3. **Outdated or unreproducible reports** (old version, no reply, needs a machine we do not have) → close as not planned, and state exactly what a reopen requires (e.g. reproduce on the latest version + document/platform details).
4. Requests that are declined for good go in this list under `Declined` with the reason — never silently closed.

**How to read the labels**

- `Help wanted` — we cannot finish it alone: it needs hardware, an environment, or a reproduction we do not have. Please comment on the linked issue; Chinese or English both fine.
- `In progress` — someone is building it right now. Comment on the issue instead of starting a second implementation.
- `Candidate` — free to pick up. Say so on the issue first so two people do not meet in the same file.
- `Declined` — not planned, with the reason recorded.

## Help wanted / 急需帮助

The two items below are the ones actually blocking us. Everything else on this page is either being built by the maintainer or is simply not scheduled yet — these are the ones where an outside hand changes the outcome.

### Windows input stutter while typing

**Sources:** [#78](https://github.com/marswaveai/ColaMD/issues/78)

**Reported:** Windows 11, NVIDIA GPU, AMD CPU. Typing stalls roughly every six characters.

**Needed:** reproduction and profiling on Windows: does the stall follow IME composition, autosave, Mermaid rendering, or the renderer's paint loop? Is it the editor, the file watcher, or the GPU process?

**Why it is stuck:** the maintainer only has macOS hardware. Startup time is already instrumented (`COLAMD_STARTUP_TRACE=1`), so a Windows user can produce a comparable trace; nobody has been able to run it on a machine that shows the stall.

**How to help:** comment on [#78](https://github.com/marswaveai/ColaMD/issues/78) (closed pending data; reopen with it) or open a new issue, with your GPU and driver version, input method, document size, and whether the stutter changes when the document contains no Mermaid block or when autosave is off.

### Image export failures

**Sources:** [#88](https://github.com/marswaveai/ColaMD/issues/88)

**Reported:** export to image fails for some users, on both desktop and mobile export modes.

**Needed:** a document that reproduces it. Export shares one rendering path across the export options, so a failing file usually points straight at the cause.

**How to help:** comment on [#88](https://github.com/marswaveai/ColaMD/issues/88) with the failing document (or a cut-down version), the platform, the export option used, and whether the current release still fails.

## Implemented On Main

These features are implemented on `main` and await release verification.

### Footnote hover preview

**Source:** [#25](https://github.com/marswaveai/ColaMD/issues/25)

**Status:** hovering a footnote reference shows its definition in a floating card, read from the document itself. The card is part of the hover zone so a long definition can be scrolled, moving the pointer across the gap does not dismiss it, and multi-block definitions keep their paragraphs apart.

### Markdown formatting shortcuts

**Source:** [#58](https://github.com/marswaveai/ColaMD/issues/58)

**Status:** the Edit menu carries a Format submenu with bold, italic, inline code, strikethrough, link (URL from the clipboard), bullet list and ordered list, so the shortcuts are discoverable from the menu rather than only from documentation. Commands apply only while the editor has focus. Customising or disabling them stays a candidate below.

### Remember window size and view zoom

**Source:** [#95](https://github.com/marswaveai/ColaMD/issues/95)

**Status:** the window's position, size and view zoom are stored next to the other preferences and restored on the next launch. A stored position that no longer overlaps any attached display falls back to the default size, so unplugging a monitor cannot strand the window off screen.

### Themes as standalone files, with a guide for writing your own

**Source:** [#91](https://github.com/marswaveai/ColaMD/issues/91)

All twelve built-in themes already ship as standalone, commented CSS files in [`themes/`](../themes), and [`themes/README.md`](../themes/README.md) documents the variables, direct selectors, and the rule that omitted variables inherit the Light defaults. The request was filed because nobody could find them: the README named twelve themes without linking the folder. README and README_CN now link both files. Nothing else is owed here, so the issue is closed.

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

**Status:** The panel's right edge offers a lightweight drag hot zone (no permanent handle icon, hover stripe only, per design.md) to resize between 200px and 420px. The choice persists locally, the default stays 220px, and the hot zone hides with the panel. The floor is 200 because the window controls sit in this column's top row: at 180 the last button would land on the pixel where the tab strip starts.

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

### Reveal in file manager (hover on the document title)

**Sources:** [#83](https://github.com/marswaveai/ColaMD/issues/83), [#84](https://github.com/marswaveai/ColaMD/pull/84) by @moyu12-ae

The reveal button shipped in v2.0.4 and v2.0.5 was unreachable, but not because hover in the titlebar is unreliable. Commit `8dc5097` (stop undo from crossing documents) refactored `main.ts` and deleted every renderer hookup for the button: the element accessor, the `fileManagerName` state, `fileLocationLabel()`, `updateFileRevealButton()` and the click binding, while `index.html` kept its hardcoded `disabled`. The visibility rule is `#titlebar:hover #reveal-file-btn:not(:disabled)`, so a permanently disabled button can never match and stays at `opacity: 0`, which presents as a broken hover. The wiring is restored, and the button appears when the file name is hovered.

**Decision (2026-09-12):** the button stays hover-only. A constant fourth titlebar icon was considered and dropped: the hover reveal works, and the titlebar should stay as empty as possible.

### Tabs and multi-document workspace

**Sources:** [#59](https://github.com/marswaveai/ColaMD/issues/59)

**Status:** Shipped in `v2.1.0`. Keep several documents open in one window instead of replacing the current document. Each tab holds its own content, unsaved state, undo history and scroll position.

**In progress (maintainer).** The tab strip itself is actively being refined — chrome height, the hover `⌘W` affordance, tab widths and the title-bar relationship are all still moving ([#90](https://github.com/marswaveai/ColaMD/issues/90)). Do not start a parallel tab implementation; comment on the issue or open a PR against the maintainer's current work instead.

Re-opened as a candidate on 2026-09-11 instead of staying declined, then designed and built during 2026-09-13. The spec lives in `design.md` (section on tabs): user-created tabs only, no strip until there are two tabs, no persistence, no drag between windows. Creation entries are `⌘T`, File → New Tab, and the file panel's right-click Open in New Tab; there is deliberately no plus button in the chrome.

## Security Maintenance

### Upgrade Electron and transitive security dependencies

**Source:** `npm audit` (2026-08-28)

**Need:** Upgrade the Electron runtime and its transitive dependencies to versions that address the currently reported security advisories, without weakening the app's document and renderer security model.

**Scope:** Evaluate the required Electron major-version upgrade, then verify macOS code signing and notarization, Windows and Linux builds, auto-update manifests, Mermaid rendering, file opening, IPC boundaries, and unsaved-document protection on every supported platform.

**Status:** Planned. Do not mix this with issue #55, whose reported PostCSS version is outdated and is not present in the current dependency tree.

## Website feature cards (positioning)

**Decision (2026-09-13):** the nine cards on colamd.com are ordered by user demand, not by internal build order:

1. True WYSIWYG (真正的所见即所得)
2. Always in Sync (文件永远是最新的)
3. Export (导出)
4. Tabs (标签页)
5. Diagrams (图表)
6. Same-Directory Files (同目录文件管理)
7. Outline & Find (长文档导航)
8. Rich Text Copy (富文本复制)
9. Cross-Platform (跨平台)

Evidence used:

- **Our own issue tracker** (40 issues). By topic: 代码块 4 (#29, #30, #53, #54), 图表 3 (#40, #42, #51), 导出 3 (#31, #35, #71), 大纲 3 (#27, #37, #64), 保存与自动保存 3 (#34, #39, #49), 多文档 3 (#44, #59, #65), Windows 性能 2 (#32, #78), 最近文件与会话还原 2 (#28, #45).
- **Search suggestions.** Baidu's suggester returns queries ordered by popularity, and every one of these exists as a popular query: `markdown转word`, `markdown导出pdf`, `markdown实时预览`, `markdown所见即所得`, `markdown自动保存`, `markdown流程图`. Google's suggestion endpoint was unreachable from the build machine, so it was not used. `markdown大纲` drifts to 「大纲是什么意思」, meaning the term itself has low awareness: that is why card 7 says 「长文档导航」 rather than 「大纲」.

**Dropped: Clean by Design / 界面克制.** It is an identity, not a feature, and no issue asked for it. The feeling it carried (极简无负担) now lives in the hero description instead: "a quiet home: your text and a file list, no toolbar and nothing to configure".

**Added: Diagrams / 图表** (Mermaid, shipped in v2.0.0).

Rule kept: exactly nine cards. The order is documented in an HTML comment above the card list on the gh-pages branch.

## Candidates

### One row title bar with tabs

**Source:** [#90](https://github.com/marswaveai/ColaMD/issues/90)

Following the tab strip, the title bar and the strip cost two rows of vertical space. Chrome collapses them into one. ColaMD's title bar also carries a centred filename and three buttons on the right, so the merge needs a decision about where those go before it is a visual change.

### Tab reordering by drag

**Source:** [#59](https://github.com/marswaveai/ColaMD/issues/59)

Tabs can be opened and closed but not reordered. Not decided. Drag interactions have been declined elsewhere in the product (panel resize was replaced by fixed rules plus a narrow hot zone), so this needs the same question asked: does the value justify a drag affordance that appears nowhere else.

### Renderer costs found while measuring startup (#100)

**Source:** [#100](https://github.com/marswaveai/ColaMD/issues/100)

Measured, not guessed, and cheap enough to be worth listing:

- Word count runs three full-document regex passes about 200ms after typing stops, although the number is only shown on hover. Compute on demand or maintain incrementally.
- KaTeX sits on the startup path: 473KB is parsed even for a document with no math. Lazy-load it the way mermaid already is.
- `releaseMermaidRenderer()` destroys the sandbox iframe on every file open, so a document with diagrams rebuilds and recompiles them each time. Being checked together with [#94](https://github.com/marswaveai/ColaMD/issues/94).
- Windows-only compositing costs (`backdrop-filter`, several `box-shadow`) on integrated graphics, and documents between the source-mode threshold and "large". Measure before touching.

### Portable build (zip distribution)

**Sources:** [#63](https://github.com/marswaveai/ColaMD/issues/63), user feedback again on 2026-09-13

Publish the existing mac zip artifact as a visible download alongside the dmg so the app can run unzipped without installation. The mac side is already published.

**Decision (2026-09-13):** ship the `zip` target on Windows. A folder you unzip and run beats a self-extracting exe for an editor that has to feel immediate on launch, and someone will package it anyway if we do not. Settings stay in `%APPDATA%` like the installed build, so the green build leaves that folder behind; revisit if users ask for a fully self-contained folder.

Windows is the open half, and a Windows user asked again. Two shapes, and they are not equivalent:

- `zip` target: the unpacked app in an archive. Unzip anywhere and run, nothing touches the registry, "uninstall" is deleting the folder, and startup is unchanged. This is the classic green build.
- `portable` target: one self-extracting exe. Friendlier to hand around, but it unpacks to a temp folder on every launch, which costs startup time, and antivirus heuristics are less friendly to it.

Both lose what the installer provides: `.md` file association, a Start Menu entry, and automatic updates. A green build needs its own update path (tell the user a new version exists and send them to the download page). Settings location also needs a decision: keep them in `%APPDATA%` like the installed build, or keep them next to the executable for a fully self-contained folder.

### Slow second-file open

**Sources:** [#63](https://github.com/marswaveai/ColaMD/issues/63)

Bug report: opening the first .md is fast, but opening another file while one is already open stalls for a long time. Profile the second-open path (window reuse, watcher re-establish, editor re-init) before optimizing; measure first per the Windows startup performance precedent.


### Merge documents from different directories into one tab group

**Sources:** [#59](https://github.com/marswaveai/ColaMD/issues/59)

**Status:** partially addressed on `main` (#99): files arriving from the OS (double-click, second launch) now open as tabs of the existing window, and ⌘O / recent files open as tabs too. What remains is the in-app path: the file panel still browses only the active document's directory, so collecting documents from several folders into one window needs a panel-level decision (recents view, pinned folders, or a full picker). Not scheduled.



### Plugin ecosystem

**Raised:** 2026-09-11, by the maintainer.

Let people write their own plugins, so ColaMD grows through an ecosystem instead of shipping every capability itself. Mermaid is the first candidate to be extracted into a plugin, which would prove the API and keep the core small.

Requests already queued for this direction: image hosting such as PicGo ([#79](https://github.com/marswaveai/ColaMD/issues/79)), which is exactly the kind of integration that should not be built in.

Open questions before any implementation: what a plugin may touch (editor commands, menus, export pipeline, file I/O), how plugins are installed and updated, the security and permission model (plugins run in the renderer, so sandboxing matters), and how to keep a default install zero-configuration.

### Knap interop (data to Markdown templates)

**Raised:** 2026-09-11, after Obsidian's author released [Knap](https://github.com/obsidianmd/knap) (MIT, `obsidianmd/knap`), a template language that turns data into Markdown, shared by Obsidian Web Clipper and Importer.

ColaMD's thesis is Markdown as a database: fixed fields in `.md`, many views on top. Knap is the mirror step, data into Markdown, so it is closer to an ingestion standard than a competitor. Two shapes worth considering, neither committed:

- Point users at Knap instead of inventing a template language: `npx knap render template.md --data article.json --output note.md` writes a file that ColaMD already hot-reloads, which makes ColaMD the live view for generated Markdown.
- Later, treat Knap as the structured-input path for the database workflow (fields in, Markdown out) and keep HTML templates as the view layer.

Interop is cheap because Knap is an AST interpreter with no `eval` and ships a CLI; reimplementing a templating language would not be.

The maintainer also raised the mirror idea on 2026-09-11: ColaMD itself could ship as a plugin for another host, so the product is both a host for templates and guests in other ecosystems. Tracked here as direction only, with no scope decided.


### Shortcut customization (keybinding preferences)

**Source:** User request (2026-09-13), raised while reviewing the formatting shortcuts.

**Need:** Let users remap or disable shortcuts, starting with the format shortcuts.

**Scope:** This is a preferences subsystem, not a toggle: storage, conflict detection against existing accelerators, re-registration, and a settings dialog in the pattern of the editor-font dialog (the only preference UI in the app). macOS users can already remap any menu accelerator in System Settings → Keyboard → App Shortcuts without code; Windows and Linux have no such mechanism, which is where the real gap sits.

**Status:** Candidate. Explicitly out of #58's first version per its scope note. Revisit when the shortcut surface grows or Windows/Linux users ask.

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

**Need:** fenced code blocks currently render as plain monospace. Highlight common languages with a lightweight highlighter that stays out of the startup bundle, loaded lazily the way Mermaid is, so a document with no code still costs nothing.

### Code block syntax highlighting

**Sources:** [#54](https://github.com/marswaveai/ColaMD/issues/54)

Fenced code blocks currently render as plain styled text with a copy button, without language-aware colouring. Adding it means shipping a highlighter and deciding which languages to support, so it stays tracked rather than committed. The issue remains open.


## Declined

### Cross-directory file tree in the panel

**Source:** [#96](https://github.com/marswaveai/ColaMD/issues/96)

Declined (2026-09-15), after re-examining it rather than on first instinct. An expanding tree would bring expansion state, cached directory reads, and level navigation into a panel whose single job is the current document's folder, and the edge cases are exactly where such a tree gets expensive (deep paths in a 220px panel, hover and renaming per level, right-click menus at every depth). The user-facing answer is that a hierarchy is not being introduced for now. Tabs already hold documents from any path in one window, so cross-folder work has an answer that costs no new structure.


### System WebView shell (Tauri) migration

**Declined (2026-09-13).** On macOS a system-WebView shell would collapse the download from 82 MB to roughly Typora's 14 MB, because the OS supplies the browser. It does not pay off anywhere else: Typora's own Windows installer is 86 to 108 MB for the same reason ours is 115 MB, there is no dependable system WebView on Windows, and WebKitGTK on Linux carries real distro and rendering risk. A main-process rewrite for one of three platforms is not worth it. Revisit only if ColaMD ever becomes macOS-only.


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

### Temporary same-directory document switcher

**Superseded — do not build.** This was the 2026-09-01 direction for the same need as tabs ([#59](https://github.com/marswaveai/ColaMD/issues/59)): a quiet strip below the title bar holding up to three same-directory documents. The tab strip shipped in `v2.1.0` covers that need with an explicit model instead (open a tab when you want one, the file panel keeps replacing the current document), so the switcher is closed and the prototype in `temporary-document-switcher-prototype.html` is history rather than a plan.
