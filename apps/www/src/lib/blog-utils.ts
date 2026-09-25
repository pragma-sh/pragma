/** Sort dated content newest-first without mutating the source collection. */
export function publishedFirst<T extends { data: { date: string } }>(posts: T[]): T[] {
  return posts.toSorted((a, b) => b.data.date.localeCompare(a.data.date));
}

/** Human-readable publication date, independent of the server's timezone. */
export function blogDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}
