import bwipjs from 'bwip-js/node';
import PDFDocument from 'pdfkit';
import { LabelContent } from './label-content';

const MM_TO_PT = 72 / 25.4;
const PAGE: [number, number] = [100 * MM_TO_PT, 50 * MM_TO_PT];
const MARGIN = 8;

// One 100 x 50 mm page per label, ready for label printers or cutting.
export async function toPdf(labels: LabelContent[]): Promise<Buffer> {
  const barcodes = await Promise.all(
    labels.map((label) =>
      bwipjs.toBuffer({ bcid: 'code128', text: label.barcode, scale: 3, height: 12, includetext: true, textxalign: 'center' }),
    ),
  );

  const doc = new PDFDocument({ size: PAGE, margin: MARGIN, autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const width = PAGE[0] - MARGIN * 2;
  labels.forEach((label, index) => {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(18).text(label.title, MARGIN, MARGIN, { width, lineBreak: false, ellipsis: true });
    if (label.subtitle) {
      doc.font('Helvetica').fontSize(9).text(label.subtitle, MARGIN, MARGIN + 22, { width, lineBreak: false, ellipsis: true });
    }
    doc.image(barcodes[index], MARGIN, MARGIN + 38, { fit: [width, PAGE[1] - MARGIN * 2 - 38], align: 'center' });
  });
  doc.end();
  return finished;
}
