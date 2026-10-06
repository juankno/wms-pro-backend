// Accepts `?status=a,b` as well as repeated `?status=a&status=b` query parameters.
export const splitList = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : value;
