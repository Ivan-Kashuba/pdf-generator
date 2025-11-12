# PDF Generator Setup

Generate a Figma-inspired HTML statement from JSON data and convert it into a PDF with WeasyPrint.

## Prerequisites

- Node.js 18+
- Python 3.9+ with `weasyprint` installed and available on `PATH`

## Usage

1. Install dependencies:
   ```sh
   npm install
   ```
2. Populate `data.json` with the values to merge into the template.
3. Build the HTML preview:

   ```sh
   npm run build:html
   ```

   - Outputs `dist/output.html` along with copied styles.

4. Build HTML and PDF in one step:

   ```sh
   npm run build:pdf
   ```

   - Requires the `weasyprint` CLI; emits `dist/output.pdf`.

## Project Layout

- `src/template.html` – HTML mockup aligned with the Figma reference.
- `styles/variables.css` – Shared design tokens (points-based units).
- `styles/style.css` – Layout and print styles that consume the variables.
- `assets/qr-code.svg` – Placeholder asset referenced by the template QR image.
- `data.json` – Dynamic data source for populating the template.
- `src/index.ts` – TypeScript script that merges JSON into HTML and optionally runs WeasyPrint.

### Dual Footers

- `document.legalNotice` supplies the compact legal footer that appears on every page.
- `document.extendedLegalNotice` supplies the extended footer content that is added on the final page (and in the single-page case).
- The generator automatically treats the document as single-page when there are ≤16 transactions; when that happens the combined footer (standard + extended) is used for the single page.
- The HTML ships with two hidden runners (`legal-runner-container` for the default footer and `combined-legal-runner` for the last-page version). Adjust their styling in `styles/style.css` if the Figma design evolves.

### Configuring WeasyPrint

- The script first tries the `WEASYPRINT_BIN` environment variable (set it to a full path or custom command).
- If unset, it attempts `weasyprint`, then `py -m weasyprint`, and finally `python -m weasyprint`.
- Ensure the chosen command is on the system `PATH` or set `WEASYPRINT_BIN` before running `npm run build:pdf`.

## Notes

- All spacing, sizing, and typography use point units to stay print-ready.
- Add new placeholder markers to the template with the form `{{path.to.value}}` and provide matching keys in `data.json`.
# pdf-generator
