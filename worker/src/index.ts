import { aggregateProfileEvents, previewCalendarUrl } from './aggregate';
import { findDisplay, findProfile, getOrInitTenant, getTenant, putTenant } from './store';
import type { TenantData } from './types';

export interface Env {
  DATA: KVNamespace;
  HOST_SECRET: string;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

function secureEq(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function getBearer(request: Request): string | null {
  const h = request.headers.get('Authorization');
  const m = h?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function authHost(request: Request, env: Env): boolean {
  const secret = env.HOST_SECRET;
  if (!secret) return false;
  const token = getBearer(request);
  if (!token) return false;
  return secureEq(token, secret);
}

function defaultRange(): { rs: Date; re: Date } {
  const rs = new Date();
  rs.setMonth(rs.getMonth() - 1);
  const re = new Date();
  re.setMonth(re.getMonth() + 4);
  return { rs, re };
}

function parseRange(url: URL): { rs: Date; re: Date } {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from && to) {
    const rs = new Date(from);
    const re = new Date(to);
    if (!Number.isNaN(rs.getTime()) && !Number.isNaN(re.getTime())) return { rs, re };
  }
  return defaultRange();
}

function randomInviteId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    try {
      if (path === '/api/public/display' && request.method === 'GET') {
        const invite = url.searchParams.get('invite')?.trim();
        if (!invite) return err('invite が必要です', 400);
        const tenant = await getTenant(env.DATA);
        if (!tenant) return err('未設定です', 404);
        const link = findDisplay(tenant, invite);
        if (!link) return err('無効な招待 ID です', 404);
        const profile = findProfile(tenant, link.profileId);
        if (!profile) return err('プロファイルが見つかりません', 404);
        return json({
          profileId: profile.id,
          profileName: profile.name,
          settings: tenant.settings,
          inviteId: invite,
        });
      }

      if (path === '/api/public/events' && request.method === 'GET') {
        const invite = url.searchParams.get('invite')?.trim();
        if (!invite) return err('invite が必要です', 400);
        const tenant = await getTenant(env.DATA);
        if (!tenant) return err('未設定です', 404);
        const link = findDisplay(tenant, invite);
        if (!link) return err('無効な招待 ID です', 404);
        const profile = findProfile(tenant, link.profileId);
        if (!profile) return err('プロファイルが見つかりません', 404);
        const { rs, re } = parseRange(url);
        const agg = await aggregateProfileEvents(profile, rs, re);
        return json({
          events: agg.events,
          calendars: agg.calendars,
          profileId: profile.id,
          profileName: profile.name,
          settings: tenant.settings,
        });
      }

      if (!env.HOST_SECRET) {
        if (path.startsWith('/api/host')) {
          return err('HOST_SECRET が Worker に設定されていません', 503);
        }
      }

      if (path === '/api/host/tenant' && request.method === 'GET') {
        if (!authHost(request, env)) return err('Unauthorized', 401);
        const tenant = await getOrInitTenant(env.DATA);
        return json(tenant);
      }

      if (path === '/api/host/tenant' && request.method === 'PUT') {
        if (!authHost(request, env)) return err('Unauthorized', 401);
        let body: TenantData;
        try {
          body = (await request.json()) as TenantData;
        } catch {
          return err('JSON が不正です', 400);
        }
        const cur = await getTenant(env.DATA);
        if (cur) {
          if (body.version !== cur.version) {
            return err('バージョン競合です。再読み込みしてください。', 409);
          }
        }
        const nextVersion = cur ? cur.version + 1 : 1;
        const next: TenantData = {
          ...body,
          version: nextVersion,
        };
        if (!next.profiles?.length) return err('profiles が空です', 400);
        await putTenant(env.DATA, next);
        return json(next);
      }

      if (path === '/api/host/events' && request.method === 'GET') {
        if (!authHost(request, env)) return err('Unauthorized', 401);
        const profileId = url.searchParams.get('profileId')?.trim();
        const suggestions = url.searchParams.get('suggestions') === '1';
        if (!profileId) return err('profileId が必要です', 400);
        const tenant = await getOrInitTenant(env.DATA);
        const profile = findProfile(tenant, profileId);
        if (!profile) return err('プロファイルが見つかりません', 404);
        const { rs, re } = parseRange(url);
        const agg = await aggregateProfileEvents(profile, rs, re, {
          includeSuggestions: suggestions,
        });
        return json({
          events: agg.events,
          calendars: agg.calendars,
          suggestedNames: agg.suggestedNames,
        });
      }

      if (path === '/api/host/calendar-preview' && request.method === 'POST') {
        if (!authHost(request, env)) return err('Unauthorized', 401);
        let urlField: string;
        try {
          const b = (await request.json()) as { url?: string };
          urlField = (b.url || '').trim();
        } catch {
          return err('JSON が不正です', 400);
        }
        if (!urlField) return err('url が必要です', 400);
        const r = await previewCalendarUrl(urlField);
        return json(r);
      }

      if (path === '/api/host/displays' && request.method === 'POST') {
        if (!authHost(request, env)) return err('Unauthorized', 401);
        let profileId: string;
        try {
          const b = (await request.json()) as { profileId?: string };
          profileId = (b.profileId || '').trim();
        } catch {
          return err('JSON が不正です', 400);
        }
        if (!profileId) return err('profileId が必要です', 400);
        const tenant = await getOrInitTenant(env.DATA);
        if (!findProfile(tenant, profileId)) return err('プロファイルが見つかりません', 404);
        const inviteId = randomInviteId();
        tenant.displays.push({ inviteId, profileId });
        tenant.version += 1;
        await putTenant(env.DATA, tenant);
        return json({ inviteId, profileId });
      }

      if (path.startsWith('/api/host/displays/') && request.method === 'DELETE') {
        if (!authHost(request, env)) return err('Unauthorized', 401);
        const inviteId = path.slice('/api/host/displays/'.length);
        if (!inviteId) return err('inviteId が必要です', 400);
        const tenant = await getOrInitTenant(env.DATA);
        const before = tenant.displays.length;
        tenant.displays = tenant.displays.filter((d) => d.inviteId !== inviteId);
        if (tenant.displays.length === before) return err('見つかりません', 404);
        if (tenant.displays.length === 0) {
          return err('最後の招待リンクは削除できません', 400);
        }
        tenant.version += 1;
        await putTenant(env.DATA, tenant);
        return json({ ok: true });
      }

      if (path === '/api/health' && request.method === 'GET') {
        return json({ ok: true });
      }

      return err('Not Found', 404);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(message, 500);
    }
  },
};
