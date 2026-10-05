import { CustomFieldType } from '@prisma/client';

export type CustomValue = string | number | boolean;
export type CustomValues = Record<string, CustomValue>;

export interface FieldDefinition {
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[];
  required: boolean;
}

export interface FieldError {
  key: string;
  message: string;
}

const MAX_TEXT = 500;

function checkType(definition: FieldDefinition, value: unknown): string | null {
  switch (definition.type) {
    case CustomFieldType.text:
      return typeof value === 'string' && value.length <= MAX_TEXT ? null : `Debe ser texto de hasta ${MAX_TEXT} caracteres`;
    case CustomFieldType.number:
      return typeof value === 'number' && Number.isFinite(value) ? null : 'Debe ser un número';
    case CustomFieldType.boolean:
      return typeof value === 'boolean' ? null : 'Debe ser sí o no';
    case CustomFieldType.date:
      return typeof value === 'string' && isIsoDate(value) ? null : 'Debe ser una fecha AAAA-MM-DD';
    case CustomFieldType.select:
      return typeof value === 'string' && definition.options.includes(value)
        ? null
        : `Debe ser una de: ${definition.options.join(', ')}`;
  }
}

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === '';

// Merges `input` into `current` (null or '' removes a value). Required fields are enforced when
// creating, and on updates only for the keys being cleared, so adding a required field later
// does not block unrelated edits of existing records.
export function applyCustomValues(
  definitions: FieldDefinition[],
  current: CustomValues,
  input: Record<string, unknown> | undefined,
  mode: 'create' | 'update',
): { values: CustomValues; errors: FieldError[] } {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const errors: FieldError[] = [];
  const values: CustomValues = { ...current };

  for (const [key, value] of Object.entries(input ?? {})) {
    const definition = byKey.get(key);
    if (!definition) {
      errors.push({ key, message: 'Campo desconocido' });
      continue;
    }
    if (isEmpty(value)) {
      if (definition.required) errors.push({ key, message: `${definition.label} es obligatorio` });
      delete values[key];
      continue;
    }
    const problem = checkType(definition, value);
    if (problem) errors.push({ key, message: `${definition.label}: ${problem}` });
    else values[key] = value as CustomValue;
  }

  if (mode === 'create') {
    for (const definition of definitions) {
      if (definition.required && isEmpty(values[definition.key]) && !errors.some((error) => error.key === definition.key)) {
        errors.push({ key: definition.key, message: `${definition.label} es obligatorio` });
      }
    }
  }
  return { values, errors };
}
