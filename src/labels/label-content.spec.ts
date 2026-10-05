import { describe, expect, it } from 'vitest';
import { locationLabel, productLabel, toZpl } from './label-content';

describe('label content', () => {
  it('uses the product barcode, falling back to its code', () => {
    expect(productLabel({ code: 'TOR-1', name: 'Tornillo', barcode: '7701' }).barcode).toBe('7701');
    expect(productLabel({ code: 'TOR-1', name: 'Tornillo', barcode: null }).barcode).toBe('TOR-1');
  });

  it('labels locations with their code and warehouse', () => {
    expect(locationLabel({ code: 'A-01-2', name: null }, 'BOG')).toEqual({ title: 'A-01-2', subtitle: 'BOG', barcode: 'A-01-2' });
    expect(locationLabel({ code: 'A', name: 'Pasillo A' }, 'BOG').subtitle).toBe('BOG · Pasillo A');
  });

  it('renders one ZPL label per item and strips command characters from data', () => {
    const zpl = toZpl([
      { title: 'A^1', subtitle: 'Caña~dulce', barcode: 'A1' },
      { title: 'B', barcode: 'B' },
    ]);
    expect(zpl.match(/\^XA/g)).toHaveLength(2);
    expect(zpl).toContain('^FDA 1^FS');
    expect(zpl).toContain('^FDCaña dulce^FS');
    expect(zpl).toContain('^BCN,180,Y,N,N^FDB^FS');
  });
});
