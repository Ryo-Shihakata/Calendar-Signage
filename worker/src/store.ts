import type { DisplayLink, TenantData } from './types';

const TENANT_KEY = 'tenant:default';

function randomInviteId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createDefaultTenant(): TenantData {
  const profileId = 'p1';
  const inviteId = randomInviteId();
  return {
    version: 1,
    profiles: [{ id: profileId, name: 'メインサイネージ', calendars: [] }],
    settings: { theme: 'light', refreshMin: 5 },
    activeProfileId: profileId,
    displays: [{ inviteId, profileId }],
  };
}

export async function getTenant(kv: KVNamespace): Promise<TenantData | null> {
  const raw = await kv.get(TENANT_KEY, 'json');
  return raw as TenantData | null;
}

export async function putTenant(kv: KVNamespace, data: TenantData): Promise<void> {
  await kv.put(TENANT_KEY, JSON.stringify(data));
}

export async function getOrInitTenant(kv: KVNamespace): Promise<TenantData> {
  let t = await getTenant(kv);
  if (!t) {
    t = createDefaultTenant();
    await putTenant(kv, t);
  }
  return t;
}

export function findDisplay(tenant: TenantData, inviteId: string): DisplayLink | undefined {
  return tenant.displays.find((d) => d.inviteId === inviteId);
}

export function findProfile(tenant: TenantData, profileId: string) {
  return tenant.profiles.find((p) => p.id === profileId);
}
