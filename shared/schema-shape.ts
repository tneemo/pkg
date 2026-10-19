/** Validate the structural JSON Schema subset used by our editor schema, without eval.
 * Ecosystem version/path semantics are additionally enforced by validateManifest.
 */
export function validateShape(value: unknown, schema: any, path = "pkg.json"): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: expected ${schema.enum.join(" or ")}`);
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && type !== schema.type) return [...errors, `${path}: expected ${schema.type}`];
  if (type === "string") {
    const s = value as string;
    if (s.length > (schema.maxLength ?? 4096) || s.length < (schema.minLength ?? 0) || (schema.pattern && !new RegExp(schema.pattern).test(s))) errors.push(`${path}: invalid text or length`);
  }
  if (type === "array") {
    const list = value as unknown[];
    if (list.length > (schema.maxItems ?? 100)) errors.push(`${path}: too many entries`);
    if (schema.items) list.forEach((v, i) => errors.push(...validateShape(v, schema.items, `${path}[${i}]`)));
  }
  if (type === "object") {
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length > (schema.maxProperties ?? 100)) errors.push(`${path}: too many properties`);
    for (const k of schema.required ?? []) if (!Object.hasOwn(object, k)) errors.push(`${path}.${k}: required`);
    for (const [k, v] of Object.entries(object)) {
      const field = schema.properties && Object.hasOwn(schema.properties, k) ? schema.properties[k] : undefined;
      if (field) errors.push(...validateShape(v, field, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: unknown property`);
      else if (typeof schema.additionalProperties === "object") errors.push(...validateShape(v, schema.additionalProperties, `${path}.${k}`));
    }
  }
  return errors;
}
