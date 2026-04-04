import type { WireEvent } from './types';

/** パース・展開用の内部イベント（index.html 由来） */
export interface ParsedEvent {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  loc: string;
  color: string;
  calName: string;
  rrule: string | null;
}

export async function fetchIcalText(url: string, ms = 15000): Promise<string> {
  const norm = url.replace(/^webcal:/i, 'https:').trim();
  if (!/^https:\/\//i.test(norm)) {
    throw new Error('HTTPS の URL のみ許可されています');
  }
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(norm, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Calendar-Signage-Worker/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('レスポンスが iCal 形式ではありません');
    return text;
  } finally {
    clearTimeout(id);
  }
}

export function extractCalName(text: string): string | null {
  const m = text.match(/X-WR-CALNAME[;:]([^\r\n]+)/);
  if (!m) return null;
  let name = m[1].trim();
  const ci = name.indexOf(':');
  if (ci >= 0 && name.slice(0, ci).toUpperCase().includes('CHARSET')) name = name.slice(ci + 1).trim();
  return name || null;
}

export function parseIcal(text: string, color: string, calName: string): ParsedEvent[] {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\r[ \t]/g, '').split(/\r\n|\r|\n/);
  const evs: ParsedEvent[] = [];
  let ev: Record<string, string> | null = null;
  for (const raw of lines) {
    const l = raw.trim();
    if (l === 'BEGIN:VEVENT') {
      ev = {};
      continue;
    }
    if (l === 'END:VEVENT') {
      if (ev) {
        const r = toEv(ev, color, calName);
        if (r) evs.push(r);
      }
      ev = null;
      continue;
    }
    if (!ev) continue;
    const ci = l.indexOf(':');
    if (ci < 0) continue;
    const k = l.slice(0, ci).split(';')[0].toUpperCase();
    const v = l.slice(ci + 1);
    if (k === 'SUMMARY') ev.s = dv(v);
    else if (k === 'DTSTART') ev.ds = v;
    else if (k === 'DTEND') ev.de = v;
    else if (k === 'LOCATION') ev.loc = dv(v);
    else if (k === 'RRULE') ev.rr = v;
    else if (k === 'UID') ev.uid = v;
    else if (k === 'DURATION') ev.dur = v;
  }
  return evs;
}

function dv(v: string): string {
  return v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function toEv(ev: Record<string, string>, color: string, calName: string): ParsedEvent | null {
  try {
    const allDay = !!(ev.ds && ev.ds.replace(/^.*:/, '').length === 8);
    const s = pid(ev.ds);
    if (!s) return null;
    let e = ev.de ? pid(ev.de) : null;
    if (!e) {
      if (ev.dur) e = addDuration(s, ev.dur);
      else e = new Date(s.getTime() + (allDay ? 86400000 : 3600000));
    }
    if (!e) return null;
    return {
      uid: ev.uid || Math.random().toString(36),
      title: ev.s || '(無題)',
      start: s,
      end: e,
      allDay,
      loc: ev.loc || '',
      color,
      calName,
      rrule: ev.rr || null,
    };
  } catch {
    return null;
  }
}

function pid(s: string | undefined): Date | null {
  if (!s) return null;
  s = s.replace(/^[^:]*:/, '').trim();
  if (/^\d{8}$/.test(s)) {
    const y = +s.slice(0, 4);
    const m = +s.slice(4, 6) - 1;
    const d = +s.slice(6, 8);
    return new Date(y, m, d, 0, 0, 0);
  }
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    return m[7] === 'Z'
      ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
      : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  return null;
}

function addDuration(d: Date, dur: string): Date {
  const r = dur.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (!r) return new Date(d.getTime() + 3600000);
  const ms =
    ((+r[1] || 0) * 7 * 86400 + (+r[2] || 0) * 86400 + (+r[3] || 0) * 3600 + (+r[4] || 0) * 60 + (+r[5] || 0)) *
    1000;
  return new Date(d.getTime() + ms);
}

export function expand(ev: ParsedEvent, rs: Date, re: Date): ParsedEvent[] {
  if (!ev.rrule) return ev.end >= rs && ev.start <= re ? [ev] : [];
  const r: Record<string, string> = {};
  ev.rrule.split(';').forEach((p) => {
    const [k, v] = p.split('=');
    if (k && v) r[k] = v;
  });
  const freq = r.FREQ;
  const cnt = r.COUNT ? +r.COUNT : 400;
  const until = r.UNTIL ? pid(r.UNTIL) : null;
  const iv = r.INTERVAL ? +r.INTERVAL : 1;
  const dur = ev.end.getTime() - ev.start.getTime();
  const res: ParsedEvent[] = [];
  let cur = new Date(ev.start);
  let i = 0;
  while (i < cnt) {
    if (until && cur > until) break;
    if (cur > re) break;
    if (cur >= rs) {
      res.push({
        ...ev,
        start: new Date(cur),
        end: new Date(cur.getTime() + dur),
        uid: ev.uid + '_r' + i,
      });
    }
    if (freq === 'DAILY') cur = new Date(cur.getTime() + iv * 86400000);
    else if (freq === 'WEEKLY') cur = new Date(cur.getTime() + iv * 7 * 86400000);
    else if (freq === 'MONTHLY') {
      cur = new Date(cur);
      cur.setMonth(cur.getMonth() + iv);
    } else if (freq === 'YEARLY') {
      cur = new Date(cur);
      cur.setFullYear(cur.getFullYear() + iv);
    } else break;
    i++;
  }
  return res;
}

export function toWire(ev: ParsedEvent): WireEvent {
  return {
    uid: ev.uid,
    title: ev.title,
    start: ev.start.toISOString(),
    end: ev.end.toISOString(),
    allDay: ev.allDay,
    loc: ev.loc,
    color: ev.color,
    calName: ev.calName,
  };
}
