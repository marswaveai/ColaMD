# Feature Requests

This is the holding list for requests that have a clear user need but are not committed roadmap work. Entries stay here until they are accepted into a release plan or explicitly declined.

## Implemented On Main

These features are implemented on `main` and await release verification.

### Export Word (.docx)

**Sources:** [#31](https://github.com/marswaveai/ColaMD/issues/31)

**Status:** Exports GFM document structure, common inline formatting, lists, tables, links, code blocks, and standalone local images to `.docx`. HTML and unsupported syntax degrade to text.

### Export shareable images

**Sources:** [#35](https://github.com/marswaveai/ColaMD/issues/35)

**Status:** Exports a whole-document PNG using desktop (1200px) or mobile (414px) reading presets, rendered in a temporary isolated window.

### Import local images

**Sources:** [#21](https://github.com/marswaveai/ColaMD/issues/21)

**Status:** Supports menu selection, paste, and drag-and-drop for saved Markdown documents. Files copy to `assets/` beside the document, avoid overwrite with numeric suffixes, and save as portable relative paths.

### Document outline

**Sources:** [#21](https://github.com/marswaveai/ColaMD/issues/21), [#27](https://github.com/marswaveai/ColaMD/issues/27)

**Status:** Adds a Files / Outline switch in the existing sidebar. Headings navigate in both visual and Markdown source modes.

### Windows startup performance

**Sources:** [#32](https://github.com/marswaveai/ColaMD/issues/32)

**Status:** Adds opt-in `COLAMD_STARTUP_TRACE=1` timing from main-process load through editor readiness. Export dependencies are dynamically loaded, reducing the main startup bundle from about 1.73 MB to 604 KB.

## Candidates

### Recent files

**Source:** [#28](https://github.com/marswaveai/ColaMD/issues/28)

**Need:** Reopen recently edited Markdown files from the existing File menu.

**Why it fits:** This shortens the return path to active documents without introducing tabs or a persistent workspace.

**Constraints:** Store only a bounded list of canonical local paths. Missing files must be skipped or clearly unavailable. Do not add a permanent sidebar section or reopen documents automatically at launch.

### Diagram rendering (Mermaid / mindmap)

**Source:** [#26](https://github.com/marswaveai/ColaMD/issues/26)

**Need:** Render Mermaid and mindmap diagrams inside Markdown documents, which are common in technical notes and planning.

**Why it fits:** Diagram rendering is a frequent Markdown workflow. An earlier Mermaid integration caused high CPU usage and freezes, so it was removed in v1.8.1.

**Constraints:** Large feature. Reintroduce only with a stable, isolated renderer that never blocks editing or slows first launch. Native code blocks must remain editable.

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
