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

// One label per box: client on top, order and box count below, and the tracking number (or the
// order reference) as barcode so the box can be scanned at dispatch.
export const shippingLabels = (packing: {
  reference: string;
  client: string;
  boxes: { label: string }[];
  trackingNumber?: string | null;
}): LabelContent[] => {
  const boxes = packing.boxes.length > 0 ? packing.boxes : [{ label: 'Caja' }];
  return boxes.map((box, index) => ({
    title: packing.client.slice(0, MAX_SUBTITLE),
    subtitle: `${packing.reference} · ${box.label} (${index + 1}/${boxes.length})`.slice(0, MAX_SUBTITLE),
    barcode: packing.trackingNumber || packing.reference,
  }));
};

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
