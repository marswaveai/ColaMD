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

**Sources:** [#21](https://github.com/marswaveai/ColaMD/issues/21), [#27](https://github.com/marswaveai/ColaMD/issues/27)

**Status:** Adds a Files / Outline switch in the existing sidebar. Headings navigate in both visual and Markdown source modes.

### Windows startup performance

**Sources:** [#32](https://github.com/marswaveai/ColaMD/issues/32)

**Status:** Adds opt-in `COLAMD_STARTUP_TRACE=1` timing from main-process load through editor readiness. Export dependencies are dynamically loaded, reducing the main startup bundle from about 1.73 MB to 604 KB.

### Diagram rendering (Mermaid)

**Sources:** [#26](https://github.com/marswaveai/ColaMD/issues/26)

**Status:** Mermaid blocks render through a lazily created hidden iframe sandbox, isolated from the main bundle. Includes 400ms debounce, click-to-edit source mode, and a 15s timeout recovery. The earlier CPU-storm removal (v1.8.1) is addressed by ignoring view-internal DOM mutations in the node view.

## Candidates

### Import local images

**Source:** [#21](https://github.com/marswaveai/ColaMD/issues/21)

**Need:** Insert local images into Markdown without compromising editor stability or document content.

**Status:** Deferred. The initial menu, paste, and drag-and-drop implementation was removed before `v1.9.0` after it proved unreliable.

### Configurable default font

**Source:** User request

**Need:** Let users choose the default font used by the Markdown editor.

**Why it fits:** Typography is a core reading and writing preference, especially for users with different language, accessibility, or coding-font needs.

**Scope:** Persist the selected font and apply it consistently to the visual editor, source mode, and reading/export views where appropriate. Keep the default behavior unchanged when no font is selected.

**Status:** Planned for next week's development review.

### Multiple windows

**Source:** [#44](https://github.com/marswaveai/ColaMD/issues/44)

**Need:** Open a new editor window instead of replacing the current document, so users can view or edit multiple files side by side.

**Why it fits:** Keeps the single-document navigation model intact — no tabs — while removing the current cover-current-document limitation.

**Constraints:** Provide a File-menu (or shortcut) entry; each window keeps independent file, theme, and state. Resolve hot-reload and save conflicts when two windows watch the same file. Do not reintroduce tabs or a shared workspace.

### Publish ColaMD for iOS

**Source:** User request

**Need:** Publish the iOS app under the unified `ColaMD` product name so anyone can install it from the App Store.

**Scope:** Publish the main ColaMD app first: create the App Store Connect record, configure Release distribution signing, upload an archive, run internal and external TestFlight verification, prepare screenshots and store metadata, complete privacy and export-compliance declarations, submit App Review, and verify public installation plus `.md` / `.txt` opening after release. Defer the Share Extension until it has a clear user need; it is an optional later update, not a prerequisite for the first release.

**Signing note:** Development signing is only for registered test devices. App Store distribution signing is a separate profile that Xcode can create and manage automatically from the company Apple Developer Program account. No manual profile editing is planned.

**Status:** Deferred. First release scope is the main app only; Share Extension remains optional.

### Recent files and restore last session

**Source:** [#28](https://github.com/marswaveai/ColaMD/issues/28), [#45](https://github.com/marswaveai/ColaMD/issues/45)

**Need:** Reopen recently edited Markdown files from the existing File menu, and optionally reopen the last open document at launch so the app resumes where it closed.

**Why it fits:** This shortens the return path to active documents without introducing tabs or a persistent workspace.

**Constraints:** Store only a bounded list of canonical local paths. Missing files must be skipped or clearly unavailable. Restore-at-launch must stay opt-in-feeling: reopening the last document automatically at launch needs evaluation against users who prefer starting fresh.

### Visible save status hint

**Source:** [#49](https://github.com/marswaveai/ColaMD/issues/49)

**Need:** A subtle indicator showing that edits are auto-saved, so users do not assume content is lost because nothing visible confirms saving.

**Why it fits:** Auto-save exists (1s after input stops) but is invisible; the lack of any feedback makes users distrust persistence.

**Constraints:** Keep it quiet by design — a small status hint in the title bar area, not a modal or toast. Must never imply unsaved state incorrectly.

### Heading anchor navigation

**Source:** [#50](https://github.com/marswaveai/ColaMD/issues/50)

**Need:** Clicking `[text](#heading-anchor)` links inside the editor should scroll to the matching heading; auto anchors from headings plus explicit `{#id}`-style anchors should both resolve.

**Why it fits:** Long-document navigation is core reading/writing behavior and the outline panel only covers headings, not in-text links.

**Constraints:** Must work without hijacking normal link behavior for external URLs. Chinese heading slug generation must match the anchor resolution rules. Apply consistently between visual mode and source mode.

### Multiple windows

**Source:** [#44](https://github.com/marswaveai/ColaMD/issues/44)

**Need:** Open a second independent editor window via menu or shortcut, each with its own file, theme, and state.

**Why it fits:** Side-by-side comparison of two documents is a real workflow and cannot be covered by tabs or the single-window file switch.

**Constraints:** Large change. Every window keeps independent save queues, watchers, and unsaved-changes guards; same-file hot-reload conflicts need explicit strategy before implementation. No tabs.

### Merge Windows menu bar into title bar

**Source:** [#46](https://github.com/marswaveai/ColaMD/issues/46)

**Need:** On Windows, put menu items on the same row as the document title and window controls (like VS Code), reclaiming one row of vertical space.

**Why it fits:** Reduces top chrome on Windows where the separate native menu bar wastes height.

**Constraints:** Keep native minimize/maximize/close behavior, keyboard access to menus, existing shortcuts, and window dragging. Only affects Windows; macOS already integrates menus natively.

### Footnote hover preview

**Source:** [#25](https://github.com/marswaveai/ColaMD/issues/25)

**Need:** Hover a footnote reference to preview its definition in place, instead of jumping to the document bottom.

**Why it fits:** Standard GFM footnotes (`[^1]` / `[^1]:`) are already parsed. A hover preview improves navigation without adding new UI.

**Constraints:** Build on the existing footnote rendering with a lightweight hover interaction. Do not add a permanent panel.

## Declined

### Built-in translation

Translation introduces provider, configuration, privacy, and product-scope complexity outside ColaMD's focused Markdown editing role.

### Tabs and persistent multi-document workspace

ColaMD deliberately avoids workspace and tab-system complexity. Existing file opening and lightweight directory browsing remain the primary document navigation model.

### Resizable file panel

The file panel remains a fixed 220px lightweight list. Long names reveal themselves through hover scrolling, avoiding a persisted layout state and drag affordance.

## Known Issues

### Theme menu shows no selected state

After picking a theme, the theme menu gives no indication of which theme is active, so users can't tell what is currently selected. Add a checkmark/disabled state on the active entry in the application menu. (Reported 2026-08-21.)
