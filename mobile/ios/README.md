# ColaMD Reader MVP

`ColaMD Reader` is an iOS-only, offline Markdown reader. It imports `.md` files into its app container, renders them locally, and keeps a bounded list of recently opened documents.

## Current scope

- Files app import and registered Markdown document type
- GFM rendering, sanitized HTML, remote images, tables, code blocks, and heading outline
- Light, dark, sepia, system themes and four reading font sizes
- No editing, account, network sync, or analytics

## Development

Open `ColaMDReader.xcodeproj` in Xcode 26 or build the simulator target:

```bash
xcodebuild -project mobile/ios/ColaMDReader.xcodeproj \
  -scheme ColaMDReader \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

The project currently has no iOS signing identity or provisioning profile configured. It can be built for the simulator; physical-device, Files integration, and WeChat share-sheet validation require an iOS development/team provisioning setup.

## Rendering dependencies

The bundled renderer uses `marked` 15.0.12 (MIT) and DOMPurify 3.3.3 (MPL-2.0 or Apache-2.0). Their source files, licenses, and SHA-256 values are documented in `ThirdPartyNotices.md`.

## Known MVP boundary

Markdown files are copied into the app container on import. Remote and data-URI images render. Relative local image folders are not imported in this MVP, so those images are intentionally not rendered yet.
