/** A timestamp from the API (ISO string) as local date and time; the raw text if it is not a date. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The first eight characters of an id, for a label where no name is available. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
