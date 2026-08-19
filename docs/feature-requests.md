# Feature Requests

This is the holding list for requests that have a clear user need but are not committed roadmap work. Entries stay here until they are accepted into a release plan or explicitly declined.

## Candidates

### Recent files

**Need:** Reopen recently edited Markdown files from the existing File menu.

**Why it fits:** This shortens the return path to active documents without introducing tabs or a persistent workspace.

**Constraints:** Store only a bounded list of canonical local paths. Missing files must be skipped or clearly unavailable. Do not add a permanent sidebar section or reopen documents automatically at launch.

### Export Word (.docx)

**Need:** Export the current Markdown document as an editable `.docx` file for collaborators who use office software.

**Why it fits:** It is a common delivery format, but requires a deliberate Markdown-to-Word mapping rather than a superficial file conversion.

**Constraints:** Large feature. Keep the entry in File menu. Define supported structures, image embedding, and degradation for HTML, math, and unsupported syntax before adding a conversion dependency.

### Export shareable images

**Need:** Export an article as an image with desktop and mobile reading presets.

**Why it fits:** It supports document sharing without changing the writing surface.

**Constraints:** Large feature. Start only with full-document PNG and fixed width presets; validate long-document memory use and output clarity before formats, selection export, custom sizing, or resolution controls.

### Import local images into the current document

**Need:** Pasting or dropping an image should copy it into a predictable folder next to the current Markdown file and insert a portable relative image reference.

**Why it fits:** ColaMD already renders local images and restores portable relative paths on save. This fills the missing creation workflow without changing the editor's content-first layout.

**Constraints:** Use an existing menu command or keyboard shortcut. Do not add a persistent toolbar control. Define collision handling, image naming, clipboard behavior, and the destination folder before implementation.

### Windows startup performance

**Need:** Windows users report that ColaMD starts noticeably slower than Typora.

**Plan:** Keep this as a performance optimization candidate for the weekly planning cycle. First measure cold and warm startup on comparable machines, then profile main-process startup, window creation, renderer loading, editor initialization, and time to first interaction.

**Constraints:** Optimize measured bottlenecks without adding persistent services, workspace state, or extra UI. Preserve file hot-reload, editor availability, and cross-platform behavior.

### Document outline

**Need:** Navigate long documents through their headings without losing the writing-focused layout.

**Why it fits:** This is useful for long-form Markdown, but it must remain secondary to writing.

**Constraints:** Do not add a permanent outline panel. Explore an on-demand, lightweight interaction only after validating that heading navigation cannot be served by existing editor behavior.

### Diagram rendering (Mermaid / mindmap)

**Need:** Render Mermaid and mindmap diagrams inside Markdown documents, which are common in technical notes and planning.

**Why it fits:** Diagram rendering is a frequent Markdown workflow. An earlier Mermaid integration caused high CPU usage and freezes, so it was removed in v1.8.1.

**Constraints:** Large feature. Reintroduce only with a stable, isolated renderer that never blocks editing or slows first launch. Native code blocks must remain editable.

### Footnote hover preview

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
