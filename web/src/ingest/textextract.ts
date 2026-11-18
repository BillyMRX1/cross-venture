import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/**
 * Extract the text layer from a document. PDFs use pdf.js text extraction
 * only (no OCR); unsupported extensions throw so the caller can toast.
 */
export async function extractTextFromFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';

  if (ext === '.txt' || ext === '.md' || ext === '.markdown' || ext === '.text') {
    return await file.text();
  }

  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;

    let result = '';
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();

      let pageText = '';
      for (const item of content.items) {
        if ('str' in item) {
          pageText += item.str;
          if (item.hasEOL) pageText += '\n';
        }
      }

      // Separator lines let the chunker keep page tracking for PDFs too.
      if (pageNumber > 1) result += `\n\n--- page ${pageNumber} ---\n`;
      result += pageText;
    }

    return result.trimEnd();
  }

  throw new Error(`Unsupported file type: ${file.name}`);
}
