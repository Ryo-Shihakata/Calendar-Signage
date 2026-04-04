export interface CalendarSource {
  id: string;
  url: string;
  name: string;
  color: string;
  autoName?: boolean;
}

export interface Profile {
  id: string;
  name: string;
  calendars: CalendarSource[];
}

export interface TenantSettings {
  theme: 'light' | 'dark';
  refreshMin: number;
}

export interface DisplayLink {
  inviteId: string;
  profileId: string;
}

export interface TenantData {
  version: number;
  profiles: Profile[];
  settings: TenantSettings;
  activeProfileId: string;
  displays: DisplayLink[];
}

export interface WireEvent {
  uid: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  loc: string;
  color: string;
  calName: string;
}

export interface CalendarFetchStatus {
  id: string;
  ok: boolean;
  msg: string;
  count: number;
}
