import { parse } from 'csv-parse/sync';

export const MAX_IMPORT_ROWS = 5000;

export type CsvRow = Record<string, string>;

export interface RowError {
  line: number;
  message: string;
}

// Spreadsheets in Spanish locales export with ";"; pick whichever separator the header uses more.
export function detectDelimiter(text: string): ',' | ';' {
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  return (header.match(/;/g)?.length ?? 0) > (header.match(/,/g)?.length ?? 0) ? ';' : ',';
}

export function parseCsv(content: Buffer | string): CsvRow[] {
  const text = content.toString();
  return parse(text, {
    bom: true,
    columns: (header: string[]) => header.map((name) => name.trim()),
    delimiter: detectDelimiter(text),
    skip_empty_lines: true,
    trim: true,
  });
}

// First data row is line 2 because line 1 is the header.
export const lineOf = (index: number) => index + 2;

export function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (['si', 'sí', 'true', '1', 'yes', 'x'].includes(normalized)) return true;
  if (['no', 'false', '0'].includes(normalized)) return false;
  return undefined;
}

export function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

export function missingColumns(rows: CsvRow[], required: string[]): string[] {
  const present = new Set(Object.keys(rows[0] ?? {}));
  return required.filter((column) => !present.has(column));
}
