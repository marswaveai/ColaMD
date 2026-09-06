# Image import and storage

Use the **Image** menu (**图片** in Chinese). **Image Settings…** is the only
settings entry point; there is no general preferences page or permanent toolbar.

The menu also offers **Insert Local Images…** (`Cmd/Ctrl+Shift+I`),
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

**Copy Document Images to Folder…** shows the image count before copying and
updating references using the current folder/naming settings. It handles Markdown
image nodes, HTML `img` nodes and Base64 images. Code examples are left intact.
Original files stay in place. Failed images retain their original references.

Settings apply to future imports, persist in `~/.colamd/images.json`, and are read
by all windows. Opening a new settings dialog always loads the current settings.
The preview shows the actual destination and the Markdown reference for a sample
screenshot. Image files are limited to 50 MB each, with up to 100 per import.

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
the app home, user data, settings, and documents; they do not use the system
clipboard. Their synthetic binary clipboard and drag events run through the real
renderer, preload and filesystem import pipeline. The Electron test output gives
the temporary location of screenshots for visual review.
