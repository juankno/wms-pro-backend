// Content shared by every output format: a big title, an optional subtitle and the barcode value.
export interface LabelContent {
  title: string;
  subtitle?: string;
  barcode: string;
}

const MAX_SUBTITLE = 40;

export const productLabel = (product: { code: string; name: string; barcode: string | null }): LabelContent => ({
  title: product.code,
  subtitle: product.name.slice(0, MAX_SUBTITLE),
  barcode: product.barcode || product.code,
});

export const locationLabel = (location: { code: string; name: string | null }, warehouseCode: string): LabelContent => ({
  title: location.code,
  subtitle: location.name ? `${warehouseCode} · ${location.name}`.slice(0, MAX_SUBTITLE) : warehouseCode,
  barcode: location.code,
});

// ^ and ~ start ZPL commands, so they cannot appear inside field data.
const zplText = (value: string) => value.replace(/[\^~]/g, ' ');

// 4 x 2 in label at 203 dpi; ^CI28 makes the printer read field data as UTF-8 (accents, ñ).
export function toZpl(labels: LabelContent[]): string {
  return labels
    .map((label) =>
      [
        '^XA',
        '^CI28',
        '^PW812',
        '^LL406',
        `^FO40,30^A0N,60,60^FD${zplText(label.title)}^FS`,
        label.subtitle ? `^FO40,100^A0N,32,32^FD${zplText(label.subtitle)}^FS` : '',
        `^FO40,160^BY3^BCN,180,Y,N,N^FD${zplText(label.barcode)}^FS`,
        '^XZ',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');
}
