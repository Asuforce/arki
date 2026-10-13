const JST_OFFSET_MS = 9 * 3600 * 1000;

/** UTC の ISO 8601 を、`<input type="datetime-local">` の値（JST、分まで）にする。 */
export function toJstInput(iso: string): string {
  return new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString().slice(0, 16);
}

/** `datetime-local` の値（JST として読む）を、UTC の ISO 8601 にする。読めなければ null。 */
export function fromJstInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}:00Z`) - JST_OFFSET_MS;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
