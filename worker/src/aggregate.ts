import { expand, extractCalName, fetchIcalText, parseIcal, toWire } from './ical';
import type { CalendarFetchStatus, Profile, WireEvent } from './types';

export interface AggregateResult {
  events: WireEvent[];
  calendars: CalendarFetchStatus[];
  /** cal.id -> X-WR-CALNAME（ホスト UI が保存前にマージする用） */
  suggestedNames?: Record<string, string>;
}

export async function aggregateProfileEvents(
  profile: Profile,
  rangeStart: Date,
  rangeEnd: Date,
  opts?: { includeSuggestions?: boolean }
): Promise<AggregateResult> {
  const calendars: CalendarFetchStatus[] = [];
  const allEvs: WireEvent[] = [];
  const suggestedNames: Record<string, string> = {};

  const tasks = profile.calendars.filter((c) => c.url?.trim());
  await Promise.all(
    tasks.map(async (cal) => {
      try {
        const text = await fetchIcalText(cal.url);
        const autoName = extractCalName(text);
        if (opts?.includeSuggestions && autoName) {
          suggestedNames[cal.id] = autoName;
        }
        const displayName = cal.name || autoName || cal.url;
        const raw = parseIcal(text, cal.color, displayName);
        let count = 0;
        for (const ev of raw) {
          for (const e of expand(ev, rangeStart, rangeEnd)) {
            allEvs.push(toWire(e));
            count++;
          }
        }
        calendars.push({ id: cal.id, ok: true, msg: `${count} 件`, count });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        calendars.push({ id: cal.id, ok: false, msg: msg.slice(0, 120), count: 0 });
      }
    })
  );

  // 元の並び順で calendars を揃える（並列完了順がバラつくため）
  const order = new Map(profile.calendars.map((c, i) => [c.id, i]));
  calendars.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  allEvs.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return {
    events: allEvs,
    calendars,
    suggestedNames: opts?.includeSuggestions ? suggestedNames : undefined,
  };
}

export async function previewCalendarUrl(url: string): Promise<{
  ok: boolean;
  name?: string;
  count?: number;
  error?: string;
}> {
  const rs = new Date();
  rs.setMonth(rs.getMonth() - 1);
  const re = new Date();
  re.setMonth(re.getMonth() + 4);
  try {
    const text = await fetchIcalText(url);
    const name = extractCalName(text) ?? undefined;
    const raw = parseIcal(text, '#1a73e8', name || url);
    let count = 0;
    for (const ev of raw) {
      count += expand(ev, rs, re).length;
    }
    return { ok: true, name, count };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, error };
  }
}
