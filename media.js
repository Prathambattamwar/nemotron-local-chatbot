'use strict';

const path = require('node:path');
const AdmZip = require('adm-zip');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const WordExtractor = require('word-extractor');

const MAX_EXTRACTED_CHARS = 50000;
const MAX_PDF_PAGES_FOR_VISUAL_ANALYSIS = 6;
let pdfjsPromise;

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}

function extractXmlText(xml) {
  return [...String(xml || '').matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)]
    .map((match) => decodeXml(match[1].replace(/<[^>]+>/g, '')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeTextFile(fileName, mimeType) {
  const ext = path.extname(fileName).toLowerCase();
  const textExtensions = new Set([
    '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.html', '.htm',
    '.css', '.scss', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.cs',
    '.c', '.h', '.cpp', '.hpp', '.go', '.rs', '.php', '.rb', '.sql', '.sh', '.bat', '.ps1',
    '.yaml', '.yml', '.toml', '.ini', '.conf', '.log', '.env', '.properties', '.r', '.ipynb'
  ]);
  return textExtensions.has(ext) || /^text\//i.test(mimeType || '') || /(?:json|xml|javascript|yaml|toml)/i.test(mimeType || '');
}

function capText(text, note = '') {
  const normalized = String(text || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= MAX_EXTRACTED_CHARS) return normalized;
  return `${normalized.slice(0, MAX_EXTRACTED_CHARS)}\n\n[Text truncated at ${MAX_EXTRACTED_CHARS.toLocaleString()} characters${note ? `; ${note}` : ''}.]`;
}

async function getPdfJs() {
  if (!pdfjsPromise) {
    // pdf.js expects these browser canvas primitives in Node when rendering pages.
    const canvas = require('@napi-rs/canvas');
    for (const key of ['DOMMatrix', 'ImageData', 'Path2D']) {
      if (!globalThis[key] && canvas[key]) globalThis[key] = canvas[key];
    }
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

async function extractPdf(buffer) {
  const pdfjs = await getPdfJs();
  const { createCanvas } = require('@napi-rs/canvas');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true
  }).promise;

  const textParts = [];
  const scannedPageImages = [];
  const pageLimit = Math.min(document.numPages, 80);
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
    if (pageText) textParts.push(`[Page ${pageNumber}] ${pageText}`);
  }

  let text = capText(textParts.join('\n\n'), document.numPages > pageLimit ? `only the first ${pageLimit} pages were parsed` : '');
  // Render a small number of pages too, so charts, scanned pages and visual layout are available to Omni.
  // Text extraction covers more pages than the image sampling to control payload size.
  const imageLimit = Math.min(document.numPages, MAX_PDF_PAGES_FOR_VISUAL_ANALYSIS);
  for (let pageNumber = 1; pageNumber <= imageLimit; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewportAtOne = page.getViewport({ scale: 1 });
    const scale = Math.min(1.25, 1400 / Math.max(viewportAtOne.width, viewportAtOne.height));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    scannedPageImages.push({
      part_type: 'document_page',
      mime_type: 'image/jpeg',
      data: canvas.toBuffer('image/jpeg', 78),
      metadata: { pageNumber }
    });
  }
  const totalPages = document.numPages;
  await document.destroy();
  return {
    text,
    parser: 'pdfjs-dist',
    generatedParts: scannedPageImages,
    note: `${totalPages > pageLimit ? `Text extracted from first ${pageLimit} pages. ` : ''}${totalPages > imageLimit ? `Visual previews created for first ${imageLimit} pages only.` : ''}${!text ? 'No selectable PDF text found; Omni will use rendered page images for OCR.' : ''}`.trim()
  };
}

function parsePowerPoint(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName))
    .sort((a, b) => Number(a.entryName.match(/slide(\d+)/i)?.[1] || 0) - Number(b.entryName.match(/slide(\d+)/i)?.[1] || 0));
  const slides = entries.map((entry, index) => `Slide ${index + 1}: ${extractXmlText(entry.getData().toString('utf8'))}`).filter((line) => !/^Slide \d+:\s*$/.test(line));
  return capText(slides.join('\n\n'));
}

async function extractEmbeddedImages(buffer, prefix) {
  const zip = new AdmZip(buffer);
  const imageEntries = zip.getEntries().filter((entry) => {
    if (!entry.entryName.startsWith(prefix) || entry.isDirectory) return false;
    if (!/\.(?:jpe?g|png|gif|webp|bmp|tiff?)$/i.test(entry.entryName)) return false;
    // Avoid unexpectedly large decompressed members inside a small Office ZIP.
    return Number(entry.header?.size || 0) > 0 && Number(entry.header?.size || 0) <= 5 * 1024 * 1024;
  }).slice(0, 6);
  const parts = [];
  let totalBytes = 0;
  for (const entry of imageEntries) {
    try {
      const raw = entry.getData();
      if (!raw.length || raw.length > 5 * 1024 * 1024) continue;
      const sharp = require('sharp');
      const jpeg = await sharp(raw, { animated: false, limitInputPixels: 30000000 })
        .resize({ width: 1500, height: 1500, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      if (totalBytes + jpeg.length > 8 * 1024 * 1024) break;
      totalBytes += jpeg.length;
      parts.push({
        part_type: 'embedded_image',
        mime_type: 'image/jpeg',
        data: jpeg,
        metadata: { sourceEntry: entry.entryName }
      });
    } catch { /* An unsupported/invalid embedded image should not block document text extraction. */ }
  }
  return parts;
}

function parseOpenDocument(buffer) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry('content.xml');
  if (!entry) return '';
  const xml = entry.getData().toString('utf8');
  return capText(xml
    .replace(/<text:line-break\s*\/>/g, '\n')
    .replace(/<\/(?:text:p|text:h)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ').map(decodeXml).join(' '));
}

async function extractAttachmentContent(buffer, originalName, mimeType) {
  const ext = path.extname(originalName || '').toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  try {
    if (ext === '.pdf' || mime === 'application/pdf') return await extractPdf(buffer);
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ buffer });
      const generatedParts = await extractEmbeddedImages(buffer, 'word/media/');
      const noteParts = [];
      if (result.messages.length) noteParts.push('Some document features may not appear in extracted text.');
      if (generatedParts.length) noteParts.push(`${generatedParts.length} embedded image(s) are also included for visual analysis.`);
      return { text: capText(result.value), parser: 'mammoth-docx', generatedParts, note: noteParts.join(' ') };
    }
    if (ext === '.doc') {
      const extractor = new WordExtractor();
      const doc = await extractor.extract(buffer);
      return { text: capText(doc.getBody()), parser: 'word-extractor-doc', note: '' };
    }
    if (['.xlsx', '.xls', '.xlsm', '.ods'].includes(ext)) {
      if (ext === '.ods') {
        const generatedParts = await extractEmbeddedImages(buffer, 'Pictures/');
        return { text: parseOpenDocument(buffer), parser: 'odf-xml', generatedParts, note: generatedParts.length ? `${generatedParts.length} embedded image(s) are also included for visual analysis.` : '' };
      }
      const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellText: true });
      const sections = workbook.SheetNames.map((sheetName) => {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { blankrows: false });
        return `Sheet: ${sheetName}\n${csv}`;
      });
      const generatedParts = await extractEmbeddedImages(buffer, 'xl/media/');
      return { text: capText(sections.join('\n\n')), parser: 'xlsx', generatedParts, note: generatedParts.length ? `${generatedParts.length} embedded image(s) are also included for visual analysis.` : '' };
    }
    if (ext === '.pptx') {
      const generatedParts = await extractEmbeddedImages(buffer, 'ppt/media/');
      return { text: parsePowerPoint(buffer), parser: 'adm-zip-pptx', generatedParts, note: generatedParts.length ? `${generatedParts.length} embedded image(s) are also included for visual analysis.` : '' };
    }
    if (['.odt', '.odp'].includes(ext)) {
      const generatedParts = await extractEmbeddedImages(buffer, 'Pictures/');
      return { text: parseOpenDocument(buffer), parser: 'odf-xml', generatedParts, note: generatedParts.length ? `${generatedParts.length} embedded image(s) are also included for visual analysis.` : '' };
    }
    if (looksLikeTextFile(originalName, mime)) {
      let text = buffer.toString('utf8');
      if (ext === '.ipynb') {
        try {
          const notebook = JSON.parse(text);
          text = (notebook.cells || []).map((cell) => {
            const source = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
            return `Cell (${cell.cell_type || 'unknown'}):\n${source}`;
          }).join('\n\n');
        } catch { /* retain original contents for malformed notebooks */ }
      }
      return { text: capText(text), parser: 'utf8-text', note: '' };
    }
    return { text: '', parser: 'none', note: 'This format is stored locally but does not have a text extractor in this project.' };
  } catch (error) {
    return { text: '', parser: 'failed', note: `The file was stored, but its contents could not be parsed (${String(error.message || 'parse error').slice(0, 180)}).` };
  }
}

function decodeImageDataUrl(value) {
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(String(value || ''));
  if (!match) return null;
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 2 * 1024 * 1024) return null;
  return { mime_type: match[1].toLowerCase(), data };
}

function buildDerivedParts(derivedEntry) {
  const parts = [];
  if (!derivedEntry || !Array.isArray(derivedEntry.parts)) return parts;
  for (let index = 0; index < Math.min(derivedEntry.parts.length, 8); index += 1) {
    const part = derivedEntry.parts[index];
    const decoded = decodeImageDataUrl(part?.dataUrl);
    if (!decoded) continue;
    const partType = derivedEntry.kind === 'video' ? 'video_frame' : 'image';
    parts.push({
      part_type: partType,
      mime_type: decoded.mime_type,
      data: decoded.data,
      metadata: { frameIndex: index, timestampMs: Number.isFinite(Number(part?.timestampMs)) ? Number(part.timestampMs) : null }
    });
  }
  return parts;
}

module.exports = {
  extractAttachmentContent,
  buildDerivedParts,
  decodeImageDataUrl,
  capText,
  MAX_EXTRACTED_CHARS
};
