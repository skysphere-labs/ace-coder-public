// Due-date logic for deck todo rows. Ported verbatim from the mobile Today
// surface (TodayTodos.tsx) so a date reads identically in both places: date-only
// strings parse as LOCAL midnight, so a "due today" item never reads as overdue.

export function parseDue(dueAt: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueAt);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(dueAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isOverdue(dueAt: string): boolean {
  const due = parseDue(dueAt);
  if (!due) return false;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return due.getTime() < startOfToday.getTime();
}

export function formatDue(dueAt: string): string {
  const due = parseDue(dueAt);
  if (!due) return '';
  const sameYear = due.getFullYear() === new Date().getFullYear();
  const hasTime = /\d{2}:\d{2}/.test(dueAt) && (due.getHours() !== 0 || due.getMinutes() !== 0);
  return due.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    ...(hasTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
}
