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
  /** RRULE がある場合のみ意味を持つ。この回は生成しない開始時刻（UTC ms 一致で判定） */
  exdates?: number[];
  /** このイベントが繰り返しの1回分を上書きする VEVENT の場合、元の開始時刻（UTC ms） */
  recurrenceId?: number | null;
  /** DTSTART の TZID。RRULE 展開時に毎回の実時刻を DST 込みで再計算するために使う */
  tzid?: string | null;
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

/** VEVENT 1個分の生プロパティ蓄積用（パラメータ付きヘッダーも保持し、後で TZID を取り出す） */
interface RawEvAcc {
  s?: string;
  ds?: string; dsHead?: string;
  de?: string; deHead?: string;
  dur?: string;
  loc?: string;
  rr?: string;
  uid?: string;
  exdate: Array<{ head: string; value: string }>;
  recId?: string; recIdHead?: string;
}

export function parseIcal(text: string, color: string, calName: string): ParsedEvent[] {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\r[ \t]/g, '').split(/\r\n|\r|\n/);
  const evs: ParsedEvent[] = [];
  let ev: RawEvAcc | null = null;
  for (const raw of lines) {
    const l = raw.trim();
    if (l === 'BEGIN:VEVENT') {
      ev = { exdate: [] };
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
    const head = l.slice(0, ci);
    const k = head.split(';')[0].toUpperCase();
    const v = l.slice(ci + 1);
    if (k === 'SUMMARY') ev.s = dv(v);
    else if (k === 'DTSTART') { ev.ds = v; ev.dsHead = head; }
    else if (k === 'DTEND') { ev.de = v; ev.deHead = head; }
    else if (k === 'LOCATION') ev.loc = dv(v);
    else if (k === 'RRULE') ev.rr = v;
    else if (k === 'UID') ev.uid = v;
    else if (k === 'DURATION') ev.dur = v;
    else if (k === 'EXDATE') {
      for (const part of v.split(',')) {
        const p = part.trim();
        if (p) ev.exdate.push({ head, value: p });
      }
    } else if (k === 'RECURRENCE-ID') { ev.recId = v; ev.recIdHead = head; }
  }
  return evs;
}

function dv(v: string): string {
  return v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** プロパティヘッダー（例 "DTSTART;TZID=Asia/Tokyo"）から TZID パラメータを取り出す */
function extractTzid(head: string | undefined): string | null {
  if (!head) return null;
  for (const part of head.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).toUpperCase() !== 'TZID') continue;
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v || null;
  }
  return null;
}

/** 指定タイムゾーンでの壁時計時刻に対応する UTC ミリ秒を求める（DST を含む往復変換） */
function zonedTimeToUtcMs(y: number, mo: number, d: number, h: number, mi: number, s: number, tzid: string): number | null {
  try {
    const guess = Date.UTC(y, mo, d, h, mi, s);
    const off1 = tzOffsetMs(tzid, guess);
    let utc = guess - off1;
    const off2 = tzOffsetMs(tzid, utc);
    if (off2 !== off1) utc = guess - off2;
    return utc;
  } catch {
    return null;
  }
}

/** タイムゾーンごとに Intl.DateTimeFormat を使い回す（RRULE 展開で1イベントあたり最大400回呼ばれるため） */
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function getDtf(tzid: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(tzid);
  if (!dtf) {
    // 不正な TZID はここで RangeError を投げる（呼び出し元で捕捉する）
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tzid, dtf);
  }
  return dtf;
}

/** ある UTC 時刻を、指定タイムゾーンでの壁時計時刻の年月日時分秒に変換する。TZID が不正なら例外を投げる */
function zonedParts(tzid: string, utcMs: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const dtf = getDtf(tzid);
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  let hour = +map.hour;
  if (hour === 24) hour = 0; // 一部ロケールが真夜中を24時と表記する対策
  return { y: +map.year, mo: +map.month, d: +map.day, h: hour, mi: +map.minute, s: +map.second };
}

function tzOffsetMs(tzid: string, utcMs: number): number {
  const p = zonedParts(tzid, utcMs);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - utcMs;
}

/**
 * ある UTC 時刻に対応する、指定タイムゾーンでの壁時計時刻を「その値をそのまま UTC とみなした
 * Date」として返す（実時刻ではなく、繰り返し予定の日付計算専用の便宜表現）。
 * RRULE の DAILY/WEEKLY/MONTHLY/YEARLY ステップはこの壁時計表現の上で行い、
 * 毎回の実時刻は zonedTimeToUtcMs で改めて求める（DST をまたいでもズレないようにするため）。
 * TZID が不正・未知（例: IANA 名でない "Eastern Standard Time" 等）の場合は null を返す。
 */
function utcToWallDate(utcMs: number, tzid: string): Date | null {
  try {
    const p = zonedParts(tzid, utcMs);
    return new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s));
  } catch {
    return null;
  }
}

function toEv(ev: RawEvAcc, color: string, calName: string): ParsedEvent | null {
  try {
    const allDay = !!(ev.ds && ev.ds.length === 8);
    const s = pid(ev.ds, extractTzid(ev.dsHead));
    if (!s) return null;
    let e = ev.de ? pid(ev.de, extractTzid(ev.deHead)) : null;
    if (!e) {
      if (ev.dur) e = addDuration(s, ev.dur);
      else e = new Date(s.getTime() + (allDay ? 86400000 : 3600000));
    }
    if (!e) return null;
    const exdates = ev.exdate
      .map(({ head, value }) => pid(value, extractTzid(head)))
      .filter((d): d is Date => d != null)
      .map((d) => d.getTime());
    const recId = ev.recId ? pid(ev.recId, extractTzid(ev.recIdHead)) : null;
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
      exdates: exdates.length ? exdates : undefined,
      recurrenceId: recId ? recId.getTime() : null,
      tzid: extractTzid(ev.dsHead),
    };
  } catch {
    return null;
  }
}

/**
 * DTSTART 等の値をパースする。TZID が指定され解決できる場合はその地域の壁時計時刻として
 * UTC へ変換する。TZID なし・不明な TZID の場合は従来どおり「Worker のローカル時刻（=UTC）」
 * として扱う（後方互換のフォールバック）。
 */
function pid(s: string | undefined, tzid?: string | null): Date | null {
  if (!s) return null;
  s = s.replace(/^[^:]*:/, '').trim();
  if (/^\d{8}$/.test(s)) {
    const y = +s.slice(0, 4);
    const m = +s.slice(4, 6) - 1;
    const d = +s.slice(6, 8);
    return new Date(y, m, d, 0, 0, 0);
  }
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const Y = +m[1], Mo = +m[2] - 1, D = +m[3], H = +m[4], Mi = +m[5], S = +m[6];
  if (m[7] === 'Z') return new Date(Date.UTC(Y, Mo, D, H, Mi, S));
  if (tzid) {
    const ms = zonedTimeToUtcMs(Y, Mo, D, H, Mi, S, tzid);
    if (ms != null) return new Date(ms);
  }
  return new Date(Y, Mo, D, H, Mi, S);
}

function addDuration(d: Date, dur: string): Date {
  const r = dur.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (!r) return new Date(d.getTime() + 3600000);
  const ms =
    ((+r[1] || 0) * 7 * 86400 + (+r[2] || 0) * 86400 + (+r[3] || 0) * 3600 + (+r[4] || 0) * 60 + (+r[5] || 0)) *
    1000;
  return new Date(d.getTime() + ms);
}

/**
 * 1つの VEVENT を展開する。RRULE がある場合、EXDATE で除外された回をスキップし、
 * overrides（RECURRENCE-ID で該当回を上書きする VEVENT）があればその回を差し替える。
 */
export function expand(
  ev: ParsedEvent,
  rs: Date,
  re: Date,
  overrides?: Map<number, ParsedEvent>,
  consumed?: Set<string>
): ParsedEvent[] {
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
  const exdateSet = new Set(ev.exdates || []);
  const res: ParsedEvent[] = [];

  const pushOccurrence = (curMs: number, i: number) => {
    const cur = new Date(curMs);
    const override = overrides?.get(curMs);
    if (override) {
      if (consumed) consumed.add(`${ev.uid}:${curMs}`);
      if (override.end >= rs && override.start <= re) res.push(override);
    } else if (!exdateSet.has(curMs) && cur >= rs) {
      res.push({ ...ev, start: cur, end: new Date(curMs + dur), uid: ev.uid + '_r' + i });
    }
  };

  // TZID あり、かつ壁時計時刻へ変換できた場合のみ TZID 対応ステップを使う。
  // utcToWallDate は不正・未知の TZID（例: IANA 名でない "Eastern Standard Time" 等）で
  // null を返すので、その場合は例外を投げずに従来の UTC 直接ステップへフォールバックする。
  const wallStart = ev.tzid ? utcToWallDate(ev.start.getTime(), ev.tzid) : null;

  if (ev.tzid && wallStart) {
    // TZID あり: DTSTART と同じ壁時計時刻（y/m/d/h/mi/s）を基準にステップし、
    // 毎回その壁時計時刻を改めて TZID で UTC に変換する。UTC ミリ秒を直接ステップすると
    // DST をまたいだ回だけ実時刻が1時間ズレ、EXDATE/RECURRENCE-ID の照合も外れてしまうため。
    const tzid = ev.tzid;
    let wall = wallStart;
    let i = 0;
    while (i < cnt) {
      const curMs =
        zonedTimeToUtcMs(
          wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(),
          wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds(), tzid
        ) ?? wall.getTime();
      if (until && curMs > until.getTime()) break;
      if (curMs > re.getTime()) break;
      pushOccurrence(curMs, i);
      if (freq === 'DAILY') wall = new Date(wall.getTime() + iv * 86400000);
      else if (freq === 'WEEKLY') wall = new Date(wall.getTime() + iv * 7 * 86400000);
      else if (freq === 'MONTHLY') { wall = new Date(wall); wall.setUTCMonth(wall.getUTCMonth() + iv); }
      else if (freq === 'YEARLY') { wall = new Date(wall); wall.setUTCFullYear(wall.getUTCFullYear() + iv); }
      else break;
      i++;
    }
  } else {
    // TZID 無し（Z 付き、TZID 未指定のナイーブ値、または TZID 解決失敗時のフォールバック）:
    // 従来どおり UTC ミリ秒を直接ステップ
    let cur = new Date(ev.start);
    let i = 0;
    while (i < cnt) {
      if (until && cur > until) break;
      if (cur > re) break;
      pushOccurrence(cur.getTime(), i);
      if (freq === 'DAILY') cur = new Date(cur.getTime() + iv * 86400000);
      else if (freq === 'WEEKLY') cur = new Date(cur.getTime() + iv * 7 * 86400000);
      else if (freq === 'MONTHLY') { cur = new Date(cur); cur.setMonth(cur.getMonth() + iv); }
      else if (freq === 'YEARLY') { cur = new Date(cur); cur.setFullYear(cur.getFullYear() + iv); }
      else break;
      i++;
    }
  }
  return res;
}

/**
 * カレンダー1件分の全 VEVENT を展開する公開エントリポイント。
 * RECURRENCE-ID を持つ VEVENT はマスター（同じ UID の RRULE イベント）の該当回を上書きし、
 * マスターが見つからない/一致しない場合は取りこぼさず単独イベントとして表示する。
 */
export function expandAll(evs: ParsedEvent[], rs: Date, re: Date): ParsedEvent[] {
  const overridesByUid = new Map<string, Map<number, ParsedEvent>>();
  const masters: ParsedEvent[] = [];
  for (const ev of evs) {
    if (ev.recurrenceId != null) {
      let m = overridesByUid.get(ev.uid);
      if (!m) { m = new Map(); overridesByUid.set(ev.uid, m); }
      m.set(ev.recurrenceId, ev);
    } else {
      masters.push(ev);
    }
  }

  const res: ParsedEvent[] = [];
  const consumed = new Set<string>();

  for (const ev of masters) {
    res.push(...expand(ev, rs, re, overridesByUid.get(ev.uid), consumed));
  }

  for (const [uid, m] of overridesByUid) {
    for (const [recId, ov] of m) {
      if (consumed.has(`${uid}:${recId}`)) continue;
      if (ov.end >= rs && ov.start <= re) res.push(ov);
    }
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
