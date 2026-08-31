export type DeviceStatus = "online" | "offline";

export interface Device {
  deviceId: string;
  normalizedDeviceId: string;
  number?: string;
  status: DeviceStatus;
  battery?: number;
  lastSeen?: string;
  payload: Record<string, unknown>;
}

export interface FirebaseConnection {
  id: string;
  telegramId: number;
  firebaseUrl: string;
  displayName: string;
  status: string;
  addedAt: string;
  lastChecked?: string;
}

export interface DeviceSummary {
  total: number;
  online: number;
  offline: number;
}

export interface AdminUser {
  telegramId: number;
  username?: string;
  firstName: string;
  joinedAt: string;
  lastActive: string;
  isBanned: boolean;
  connections: number;
}

export interface AdminConnection {
  id: string;
  firebaseUrl: string;
  displayName: string;
  status: string;
  lastChecked?: string;
  telegramId: number;
  username?: string;
  firstName: string;
  devices: number;
  online: number;
}

export interface ReferralStats {
  total: number;
  qualified: number;
  claimed: boolean;
}

export interface FreeFirebasePanel {
  id: string;
  firebaseUrl: string;
  displayName: string;
  active: boolean;
  assignedTo?: number;
  assignedAt?: string;
  addedAt: string;
}

export interface RequiredChannel {
  id: string;
  chatId: string;
  title: string;
  inviteLink?: string;
  addedAt: string;
}

export interface Session {
  screen: string;
  stack: string[];
  selectedFirebaseId?: string;
  selectedDeviceId?: string;
  page: number;
  awaiting?:
    | "firebase_url"
    | "broadcast"
    | "free_firebase_url"
    | "required_channel"
    | "referral_minimum"
    | "referral_message"
    | "maintenance_message"
    | "how_to_use_message";
  monitoring?: boolean;
}