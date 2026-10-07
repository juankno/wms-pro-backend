import { Workbook } from 'exceljs';
import { describe, expect, it } from 'vitest';
import { cellText, detectFormat, errorReportCsv, parseXlsx, xlsxTemplate } from './spreadsheet';

const xlsx = async (rows: unknown[][]) => {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Hoja');
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

describe('detectFormat', () => {
  it('recognizes XLSX by its zip signature even with a misleading name', async () => {
    expect(detectFormat(await xlsx([['code']]), 'datos.csv')).toBe('xlsx');
    expect(detectFormat(Buffer.from('code,name\n'), 'datos.csv')).toBe('csv');
    expect(detectFormat(Buffer.from(''), 'datos.XLSX')).toBe('xlsx');
  });
});

describe('cellText', () => {
  it('turns Excel values into the text the import expects', () => {
    expect(cellText(new Date(Date.UTC(2027, 5, 30)))).toBe('2027-06-30');
    expect(cellText(12)).toBe('12');
    expect(cellText(true)).toBe('si');
    expect(cellText({ richText: [{ text: 'Torn' }, { text: 'illo ' }] })).toBe('Tornillo');
    expect(cellText({ formula: 'A1*2', result: 24 })).toBe('24');
    expect(cellText({ text: 'Web', hyperlink: 'https://x.test' })).toBe('Web');
    expect(cellText(null)).toBe('');
  });
});

describe('parseXlsx', () => {
  it('reads the first sheet using row 1 as column names and skips empty rows', async () => {
    const content = await xlsx([
      ['code', 'name', 'expiresAt'],
      ['A1', 'Tornillo', new Date(Date.UTC(2027, 0, 5))],
      [],
      ['B2', 'Tuerca'],
    ]);

    expect(await parseXlsx(content)).toEqual([
      { code: 'A1', name: 'Tornillo', expiresAt: '2027-01-05' },
      { code: 'B2', name: 'Tuerca', expiresAt: '' },
    ]);
  });

  it('builds a template that reads back as its example rows', async () => {
    const template = await xlsxTemplate('code,name,category\nTOR-001,Tornillo 3/8,Ferretería\n');

    expect(await parseXlsx(template)).toEqual([{ code: 'TOR-001', name: 'Tornillo 3/8', category: 'Ferretería' }]);
  });
});

describe('errorReportCsv', () => {
  // Fields with "," or ";" are quoted so Excel in Spanish locales does not split them.
  it('lists the rejected rows with their line and every message', () => {
    const rows = [
      { code: 'A1', name: 'Bien' },
      { code: '', name: 'Sin código, "corto"' },
    ];
    const report = errorReportCsv(rows, [
      { line: 3, message: 'code es obligatorio' },
      { line: 3, message: 'name demasiado largo' },
    ]);

    expect(report.startsWith('\uFEFF')).toBe(true);
    expect(report.slice(1).split('\r\n')).toEqual([
      'code,name,linea,error',
      ',"Sin código, ""corto""",3,"code es obligatorio; name demasiado largo"',
      '',
    ]);
  });
});
