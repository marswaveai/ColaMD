# Image import and storage

Use the **Image** menu (**图片** in Chinese). **Image Settings…** is the only
settings entry point; there is no general preferences page or permanent toolbar.

The menu also offers **Import Images… / 导入图片…** (`Cmd/Ctrl+Shift+I`),
**Insert Image URL…**, **Copy Document Images to Folder…**, and **Show Image Folder**.
Images can also be pasted from the clipboard or dropped into the visual/source
editor. Clipboard screenshots do not need an existing filesystem path. Mixed
HTML pastes retain their surrounding text and formatting.

## Insertion behavior

Choose between copying files to the image folder, referring to their original
location, and embedding their bytes in Markdown. Copy is the default. Clipboard
images without an original file still use the selected folder in reference mode.
An untitled document is saved first; cancelling that save cancels the import.

Remote images remain URLs by default. Enable **Download remote images when
inserting** to save them locally. The explicit collection command downloads
remote images as well as copying local and embedded images. No upload service
or cloud account is involved.

## Folder choices

| Choice | Destination for `project/notes/example.md` |
| --- | --- |
| Document.assets (default) | `project/notes/example.assets/` |
| Beside document | `project/notes/` |
| assets | `project/notes/assets/` |
| .assets | `project/notes/.assets/` |
| .assets/document-name | `project/notes/.assets/example/` |
| Selected root | Chosen directory plus its configured subfolder; `.` means the root itself |
| Custom folder | An absolute path or a path relative to the Markdown document |

Custom folders support `${filename}` (document name without extension), `${year}`
and `${month}`. For example, `./${filename}.assets` and `../.assets/${year}/${month}`.
Selecting a root does not create a workspace or change how other documents open.

## Naming and paths

File imports and screenshots/downloads have separate naming preferences:

- Original filename (default for file imports).
- Millisecond timestamp (default for screenshots).
- Document name plus timestamp.
- Timestamp plus a random suffix.
- Content hash.
- Document name plus a sequence number.
- A custom template with `${name}`, `${documentName}`, `${timestamp}`, `${date}`,
  `${time}`, `${hash}`, `${random}`, and `${ext}`.

Timestamps use local insertion time, not an inferred capture date. `${timestamp}`
has the form `20260906-154812-327`. Extensions follow the actual image data;
templates cannot silently convert PNG bytes to JPEG. Existing filenames get
numeric suffixes instead of being overwritten. Optional content deduplication
compares complete bytes, including across concurrent imports into one directory.

Paths are relative to the Markdown document by default. Optional settings add a
`./` prefix, URL-encode path characters, or write absolute paths. Display URLs
stay separate from persisted Markdown, including on Save As. Save As retains
references to existing images; use the collection command to copy them into a
newly selected attachment directory. Ordinary saves never delete image files.

## Existing images

Click an image in the visual editor to reveal its editable Markdown/HTML source
**directly above that image, in the document flow**, while keeping the preview
visible. Clicking the same image again keeps that field, its text selection,
and the loaded preview unchanged. Clicking elsewhere collapses it. There is no
image-source dialog. The source displays saved relative
paths such as `![alt](path "title")`; the path is selected for easy editing.
Press **Enter** or click elsewhere to commit a valid edit, **Shift+Enter** to
insert a line break, or **Escape** to cancel. Invalid source stays visible with
an inline error and cannot replace the image. **Copy** copies the syntax.
**Replace image… / 替换图片…** imports one file using the current folder and
naming preferences, replaces that image and retains the original file and scale.
This works with Markdown images and standalone HTML `img` nodes. Arbitrary HTML
blocks with surrounding content remain editable in document source mode.
Switching documents or entering whole-document source mode removes the inline
field; unfinished source edits are discarded. Editor controls never become part
of the saved Markdown.

Right-click an image to choose **25%, 50%, 75%, 100%, 150% or 200%**, or
**Reset to Original Size / 恢复原始大小**. The native menu marks the current scale.
Scaling changes the document, not the underlying image bytes. As in Typora, a
scaled image is saved as `<img src="…" style="zoom: 50%;">` because standard
Markdown image syntax has no size attribute. Its relative path, alt text, title
and scale survive saving and reopening. Reset removes the zoom style and restores
Markdown image syntax when no other HTML attributes need to be kept.

In ColaMD, percentages scale the normal fitted image: a 780px-wide preview becomes
390px at 50% and 195px at 25%, including for large screenshots. Values above 100%
can exceed the editor width and be scrolled horizontally. The HTML renderer
scales the maximum-width constraint alongside `zoom` so it cannot cancel the
visible size change. An explicit custom HTML `max-width` is respected. Other
viewers may fit images differently or ignore HTML zoom.

Interaction references: Typora's [official image demonstration](https://support.typora.io/media/about-image/drag-img.gif)
shows source above the selected image; its [Resize Images documentation](https://support.typora.io/Resize-Image/)
describes HTML image dimensions and zoom. Typora's application source is not
open source; this is an independent implementation of the documented interaction.

**Copy Document Images to Folder…** shows the image count before copying and
updating references using the current folder/naming settings. It handles Markdown
image nodes, HTML `img` nodes and Base64 images. Code examples are left intact.
Original files stay in place. Failed images retain their original references.

Settings apply to future imports, persist in `~/.colamd/images.json`, and are read
by all windows. Opening a new settings dialog always loads the current settings.
The preview shows the actual destination and the Markdown reference for a sample
screenshot. Image files are limited to 50 MB each, with up to 100 per import.

The menu, inline image controls and settings dialogs follow ColaMD's existing Chinese/English system-language
selection. macOS packages retain Electron's top-level `.lproj` directories, even
when built from a local `electronDist`, so a Chinese system does not unexpectedly
fall back to English. No separate language or general settings page is added.

This implementation focuses on local import/storage. It does not interpret
Typora YAML preferences, automatically move folders when a document is renamed,
or upload images. Standard relative references remain compatible with Typora.

## Validation

```sh
npm run test:images
npx tsc --noEmit -p tsconfig.main.json
npx tsc --noEmit -p tsconfig.preload.json
npx tsc --noEmit -p tsconfig.renderer.json
npm run check:theme-colors
npm run build
npm run test:images:electron
```

The filesystem tests use temporary directories. The Electron tests also isolate
the app home, user data, settings, and documents; by default they do not use the system
clipboard. The suite checks Enter/Escape, clicking away, source layout, document switching,
six exact displayed width/height ratios using a 1600×900 image, and repeated
Chromium mouse clicks on both Markdown and scaled HTML images. The latter check
asserts no panel/image replacement or removal, scroll movement, or text-selection
change, followed by collapse on an outside click. Its synthetic binary clipboard and drag events run through the real
renderer, preload and filesystem import pipeline. The Electron test output gives
the temporary location of screenshots for visual review.

For an opt-in check of the actual system clipboard, copy an image in Preview or
a screenshot tool and run `COLAMD_NATIVE_CLIPBOARD=1 npm run test:images:electron`.
This reads the existing clipboard without modifying it, invokes Chromium's native
paste command, and checks image rendering, timestamped storage, relative Markdown
and pixel equality. A text-only clipboard fails this check rather than passing
as an image test.

After macOS packaging, verify the language markers in the final application:

```sh
node scripts/check-mac-locales.cjs release/mac-arm64/ColaMD.app
```

For native macOS validation, launch the installed `.app` without a `--lang`
override, check the Image menu and settings language, and open a disposable saved
Markdown document. Capture an area with Control-Shift-Command-4 and paste using
Command-V. Confirm that a timestamped PNG appears in the selected folder, its
relative reference is saved, and the image renders after reopening. Also test
the real file picker with a space/Unicode filename, change the folder to `.assets`,
and verify the next import uses the new folder. These checks cover the native
clipboard and dialogs that the automated suite simulates.
