import { CellValue, Workbook } from 'exceljs';
import { CsvRow, parseCsv, RowError } from './csv';

export const IMPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// XLSX files are zip archives; anything else is read as CSV text.
export function detectFormat(content: Buffer, fileName = ''): ImportFormat {
  if (content.subarray(0, 4).equals(ZIP_SIGNATURE) || fileName.toLowerCase().endsWith('.xlsx')) return 'xlsx';
  return 'csv';
}

export const FORMAT_CONTENT_TYPES: Record<ImportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const pad = (value: number) => String(value).padStart(2, '0');

// Excel stores dates as instants at UTC midnight; ISO dates are what the CSV import accepts.
const isoDate = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

export function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return isoDate(value);
  if (typeof value === 'boolean') return value ? 'si' : 'no';
  if (typeof value !== 'object') return String(value).trim();
  if ('richText' in value) return value.richText.map((part) => part.text).join('').trim();
  if ('text' in value) return String(value.text).trim();
  if ('result' in value) return cellText(value.result);
  if ('error' in value) return '';
  return '';
}

// Reads the first worksheet: row 1 holds the column names.
export async function parseXlsx(content: Buffer): Promise<CsvRow[]> {
  const workbook = new Workbook();
  await workbook.xlsx.load(content as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const header: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => {
    header[column - 1] = cellText(cell.value);
  });

  const rows: CsvRow[] = [];
  for (let index = 2; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index);
    const record: CsvRow = {};
    let hasValue = false;
    header.forEach((name, column) => {
      if (!name) return;
      const text = cellText(row.getCell(column + 1).value);
      record[name] = text;
      hasValue ||= text !== '';
    });
    if (hasValue) rows.push(record);
  }
  return rows;
}

export function readSpreadsheet(content: Buffer, format: ImportFormat): Promise<CsvRow[]> {
  return format === 'xlsx' ? parseXlsx(content) : Promise.resolve(parseCsv(content));
}

// The CSV template is the single source of the columns and example rows.
export async function xlsxTemplate(csvTemplate: string): Promise<Buffer> {
  const rows = parseCsv(csvTemplate);
  const columns = csvTemplate.split(/\r?\n/, 1)[0].split(',');
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Datos');
  sheet.addRow(columns);
  rows.forEach((row) => sheet.addRow(columns.map((column) => row[column] ?? '')));
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((column) => (column.width = 18));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const csvField = (value: string) => (/[",;\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

// The rows that failed, with their original columns plus the line and every message for it.
export function errorReportCsv(rows: CsvRow[], errors: RowError[]): string {
  const columns = Object.keys(rows[0] ?? {});
  const messages = new Map<number, string[]>();
  for (const { line, message } of errors) messages.set(line, [...(messages.get(line) ?? []), message]);

  const lines = [[...columns, 'linea', 'error'].map(csvField).join(',')];
  for (const [line, lineMessages] of [...messages].sort(([a], [b]) => a - b)) {
    const row = rows[line - 2] ?? {};
    lines.push([...columns.map((column) => row[column] ?? ''), String(line), lineMessages.join('; ')].map(csvField).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
