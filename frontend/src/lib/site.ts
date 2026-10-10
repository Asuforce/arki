export const siteTitle: string = import.meta.env.PUBLIC_SITE_TITLE ?? "arki";

const dateFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 表示は JST。 */
export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso)).replaceAll("/", "-");
}

export function pageHref(page: number, basePath: string): string {
  if (basePath === "/") return page <= 1 ? "/" : `/page/${page}`;
  return page <= 1 ? basePath : `${basePath}?page=${page}`;
}
