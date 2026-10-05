import { CustomFieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { applyCustomValues, FieldDefinition } from './custom-field-values';

const field = (key: string, type: CustomFieldType, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  key, label: key, type, options: [], required: false, ...extra,
});

const definitions = [
  field('color', CustomFieldType.select, { options: ['rojo', 'azul'] }),
  field('peso', CustomFieldType.number),
  field('fragil', CustomFieldType.boolean),
  field('revision', CustomFieldType.date),
  field('marca_origen', CustomFieldType.text, { required: true }),
];

describe('applyCustomValues', () => {
  it('accepts valid values of every type', () => {
    const input = { color: 'rojo', peso: 2.5, fragil: true, revision: '2026-12-31', marca_origen: 'ACME' };
    expect(applyCustomValues(definitions, {}, input, 'create')).toEqual({ values: input, errors: [] });
  });

  it('reports wrong types, unknown keys and missing required fields on create', () => {
    const { errors } = applyCustomValues(definitions, {}, { color: 'verde', peso: '2', revision: '31/12/2026', otro: 1 }, 'create');
    expect(errors.map((error) => error.key)).toEqual(['color', 'peso', 'revision', 'otro', 'marca_origen']);
  });

  it('merges updates, removes cleared values and only enforces required fields being cleared', () => {
    const current = { color: 'azul', peso: 1 };
    expect(applyCustomValues(definitions, current, { peso: null, fragil: false }, 'update')).toEqual({
      values: { color: 'azul', fragil: false },
      errors: [],
    });
    expect(applyCustomValues(definitions, { marca_origen: 'X' }, { marca_origen: '' }, 'update').errors).toHaveLength(1);
  });
});
