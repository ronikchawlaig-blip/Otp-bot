import crypto from "node:crypto";
import type { Device } from "./types.js";

const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const DEVICE_COLLECTION_KEYS = new Set([
  "devices", "device", "clients", "client", "phones", "records",
  "devicelist", "clientlist", "allclients", "all devices"
].map(compactKey));
const ONLINE_DEVICE_COLLECTION_KEYS = new Set([
  "online", "onlinenumber", "onlinenumbers", "onlinedevices",
  "onlineclients", "activedevices", "activeclients", "connecteddevices"
].map(compactKey));
const OFFLINE_COLLECTION_KEYS = new Set(["offline", "offlinenumber", "offlinenumbers", "offlinedevices"]);
const EVENT_COLLECTION_KEYS = new Set([
  "events", "event", "logs", "messages", "message", "history",
  "sms", "smses", "smslist", "smsmessages", "smslogs",
  "inbox", "received", "receivedmessages", "notifications"
].map(compactKey));
const DEVICE_ID_KEYS = ["deviceId", "device_id", "deviceID", "serial", "imei", "id"];
const NUMBER_KEYS = [
  "number", "phone", "phoneNumber", "phone_number", "mobile", "mobileNumber",
  "mobile_number", "mobileNo", "mobile_no", "mobNo", "mob_no", "msisdn",
  "subscriberNumber", "simNumber", "sim_no", "contactNumber", "contactNo",
  "phoneNum", "phone_num", "simPhone", "simPhoneNumber", "sim_phone_number",
  "telephone", "tel", "msisdnNumber"
];
const PHONE_CONTAINER_KEYS = new Set([
  "action", "actions", "command", "commands", "message", "messages",
  "siminfo", "deviceinfo", "deviceinformation", "info", "details", "metadata"
]);
const STATUS_KEYS = [
  "status", "online", "isOnline", "connected", "connectionStatus",
  "deviceStatus", "device_state", "deviceState", "connectionState",
  "connection_state", "isActive", "is_active", "active"
];
const BATTERY_KEYS = ["battery", "batteryPercentage", "battery_percent", "batteryLevel", "battery_level"];
const LAST_SEEN_KEYS = ["lastSeen", "last_seen", "updatedAt", "updated_at", "timestamp", "lastActive"];

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

export function validateFirebaseUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (!["http:", "https:"].includes(url.protocol) ||
      !(url.hostname.endsWith("firebaseio.com") || url.hostname.endsWith("firebasedatabase.app"))) {
    throw new Error("Unsupported Firebase Realtime Database URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function readFirebase(url: string, timeoutMs = 12000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/.json`, { signal: controller.signal });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("Permission denied");
      if (response.status === 423) {
        throw new Error("Firebase database is deactivated. Reactivate this Firebase Realtime Database project and try again.");
      }
      throw new Error(`Firebase returned HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Network timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function valueFor(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  const wanted = new Set(keys.map(compactKey));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(compactKey(key)) && value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function safeText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text.length ? text : undefined;
  }
  if (isRecord(value)) {
    for (const key of ["value", "raw", "formatted", "text"]) {
      const nested = safeText(value[key]);
      if (nested) return nested;
    }
  }
  return undefined;
}

type PhoneCandidate = { value: string; quality: number };

function phoneCandidate(value: unknown, quality: number): PhoneCandidate | undefined {
  const text = safeText(value);
  return text ? { value: text, quality } : undefined;
}

function extractPhoneNumber(record: Record<string, unknown>): PhoneCandidate | undefined {
  // A number directly on the device record is authoritative. This prevents an
  // old message or command from winning over the current device metadata.
  const direct = phoneCandidate(valueFor(record, NUMBER_KEYS), 400);
  if (direct) return direct;

  const candidates: PhoneCandidate[] = [];
  const visit = (value: unknown, path: string[], depth: number): void => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...path, String(index)], depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const compact = compactKey(key);
      if (NUMBER_KEYS.some(numberKey => compactKey(numberKey) === compact)) {
        const containerPath = path.map(compactKey);
        const hasSimInfo = containerPath.includes("siminfo");
        const hasDeviceInfo = containerPath.some(item => PHONE_CONTAINER_KEYS.has(item) && item.includes("device"));
        const hasCommandOrMessage = containerPath.some(item =>
          ["action", "actions", "command", "commands", "message", "messages"].includes(item)
        );
        const quality = hasSimInfo ? 350 : hasDeviceInfo ? 325 : hasCommandOrMessage ? 300 : 250;
        const candidate = phoneCandidate(child, quality);
        if (candidate) candidates.push(candidate);
      }
      if (isRecord(child) || Array.isArray(child)) visit(child, [...path, key], depth + 1);
    }
  };
  visit(record, [], 0);
  return candidates.sort((a, b) => b.quality - a.quality)[0];
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizedPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 5 ? digits : normalize(value);
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function statusFromRecord(obj: Record<string, unknown>, lastSeen: unknown): "online" | "offline" {
  const explicit = nestedValueFor(obj, STATUS_KEYS);
  const explicitStatus = parseStatusValue(explicit);
  if (explicitStatus) return explicitStatus;
  const seen = timestampMs(lastSeen);
  return seen !== undefined && Date.now() - seen <= ONLINE_WINDOW_MS ? "online" : "offline";
}

function parseStatusValue(value: unknown, depth = 0): "online" | "offline" | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "boolean") return value ? "online" : "offline";
  if (typeof value === "number") return value === 1 ? "online" : value === 0 ? "offline" : undefined;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["online", "connected", "active", "true", "yes", "1"].includes(normalized)) return "online";
    if (["offline", "disconnected", "inactive", "false", "no", "0"].includes(normalized)) return "offline";
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["value", "state", "status", "online", "isOnline", "connected", "active"]) {
    const nested = parseStatusValue(value[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function batteryValue(value: unknown): number | undefined {
  const numeric = typeof value === "string" && value.trim().endsWith("%")
    ? Number(value.trim().slice(0, -1))
    : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100 ? Math.round(numeric) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nestedValueFor(value: unknown, keys: string[], depth = 0, allowMessageBranch = false): unknown {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const nested = nestedValueFor(child, keys, depth + 1, allowMessageBranch);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const direct = valueFor(value, keys);
  if (direct !== undefined) return direct;
  for (const [key, child] of Object.entries(value)) {
    const compact = compactKey(key);
    if ((EVENT_COLLECTION_KEYS.has(key.toLowerCase()) && !(allowMessageBranch && compact === "messages")) ||
        OFFLINE_COLLECTION_KEYS.has(compact)) continue;
    const nested = nestedValueFor(child, keys, depth + 1, allowMessageBranch);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function hasNestedSignal(value: unknown): boolean {
  return STATUS_KEYS.concat(NUMBER_KEYS, BATTERY_KEYS, LAST_SEEN_KEYS)
    .some(key => nestedValueFor(value, [key], 0, NUMBER_KEYS.includes(key)) !== undefined);
}

type DeviceCandidate = Device & { numberQuality: number };

function chooseRecord(previous: DeviceCandidate | undefined, next: DeviceCandidate): DeviceCandidate {
  if (!previous) return next;
  const previousSeen = timestampMs(previous.lastSeen) ?? -1;
  const nextSeen = timestampMs(next.lastSeen) ?? -1;
  const completeness = (device: Device) =>
    Number(Boolean(device.number)) + Number(device.battery !== undefined) +
    Number(Boolean(device.lastSeen)) + Number(Object.keys(device.payload).length > 0);
  const preferred = nextSeen > previousSeen || (nextSeen === previousSeen && completeness(next) >= completeness(previous))
    ? next
    : previous;
  const fallback = preferred === next ? previous : next;
  const numberSource = next.numberQuality > previous.numberQuality
    || (next.numberQuality === previous.numberQuality && nextSeen >= previousSeen)
    ? next
    : previous;
  return {
    ...preferred,
    // Keep a high-quality number even when a later duplicate has less data.
    number: numberSource.number ?? fallback.number,
    numberQuality: numberSource.number ? numberSource.numberQuality : preferred.numberQuality,
  };
}

export function extractDevices(root: unknown): Device[] {
  const devices = new Map<string, DeviceCandidate>();
  const onlineDevices = new Map<string, DeviceCandidate>();
  const visit = (value: unknown, path: string[], underEvents = false, underOnline = false): void => {
    const currentKey = path.at(-1)?.toLowerCase();
    const parentKey = path.at(-2)?.toLowerCase();
    const currentCategoryKey = compactKey(currentKey ?? "");
    const parentCategoryKey = compactKey(parentKey ?? "");
    const inOnlineBranch = underOnline || ONLINE_DEVICE_COLLECTION_KEYS.has(currentCategoryKey);
    if (OFFLINE_COLLECTION_KEYS.has(currentCategoryKey)) return;

    if (!isRecord(value)) {
      if (Array.isArray(value)) value.forEach((entry, index) => visit(entry, [...path, String(index)], underEvents, inOnlineBranch));
      if (inOnlineBranch && parentKey && ONLINE_DEVICE_COLLECTION_KEYS.has(parentCategoryKey) && currentKey && !/^\d+$/.test(currentKey)) {
        const number = safeText(value);
        if (number) {
          const device: DeviceCandidate = {
            deviceId: currentKey,
            normalizedDeviceId: normalize(currentKey),
            number,
            status: "online",
            payload: { number: value },
            numberQuality: 400,
          };
          onlineDevices.set(device.normalizedDeviceId, chooseRecord(onlineDevices.get(device.normalizedDeviceId), device));
        }
      }
      return;
    }

    const explicitId = safeText(valueFor(value, DEVICE_ID_KEYS));
    const pathId = currentKey && parentKey &&
      (DEVICE_COLLECTION_KEYS.has(parentCategoryKey) || ONLINE_DEVICE_COLLECTION_KEYS.has(parentCategoryKey)) &&
      !EVENT_COLLECTION_KEYS.has(currentKey) && !/^\d+$/.test(currentKey)
      ? currentKey
      : undefined;
    const deviceId = explicitId ?? pathId;
    const lastSeenValue = nestedValueFor(value, LAST_SEEN_KEYS);
    const recordStatus = statusFromRecord(value, lastSeenValue);
    // An authoritative online branch can contain a device ID and metadata
    // only. It is still a valid device and must not disappear just because it
    // has no phone, battery, or explicit status field.
    const validDeviceRecord = !underEvents && Boolean(deviceId) &&
      (inOnlineBranch || hasNestedSignal(value) || recordStatus === "online");

    if (validDeviceRecord) {
      const phone = extractPhoneNumber(value);
      const device: DeviceCandidate = {
        deviceId: deviceId!,
        normalizedDeviceId: normalize(deviceId!),
        number: phone?.value,
        status: inOnlineBranch ? "online" : recordStatus,
        battery: batteryValue(nestedValueFor(value, BATTERY_KEYS)),
        lastSeen: safeText(lastSeenValue),
        payload: value,
        numberQuality: phone?.quality ?? 0,
      };
      const target = inOnlineBranch ? onlineDevices : devices;
      target.set(device.normalizedDeviceId, chooseRecord(target.get(device.normalizedDeviceId), device));
    }

    for (const [key, child] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (OFFLINE_COLLECTION_KEYS.has(compactKey(lowerKey))) continue;
      visit(child, [...path, key], underEvents || EVENT_COLLECTION_KEYS.has(lowerKey), inOnlineBranch);
    }
  };
  visit(root, []);
  // Merge authoritative online branches with positively verified online
  // records from the main device/client branch. Some Firebase projects keep
  // only numbered devices in the online branch, so selecting that branch alone
  // silently drops online devices that have no number.
  const onlineById = new Map<string, DeviceCandidate>();
  for (const device of [
    ...onlineDevices.values(),
    ...[...devices.values()].filter(device => device.status === "online"),
  ]) {
    onlineById.set(device.normalizedDeviceId, chooseRecord(onlineById.get(device.normalizedDeviceId), device));
  }
  const selectedDevices = [...onlineById.values()];
  const deduplicatedByPhone = new Map<string, DeviceCandidate>();
  for (const device of selectedDevices) {
    const key = device.number ? normalizedPhone(device.number) : `device:${device.normalizedDeviceId}`;
    deduplicatedByPhone.set(key, chooseRecord(deduplicatedByPhone.get(key), device));
  }
  return [...deduplicatedByPhone.values()].map(({ numberQuality: _numberQuality, ...device }) => device).sort((a, b) => {
    const statusOrder = Number(b.status === "online") - Number(a.status === "online");
    return statusOrder || a.normalizedDeviceId.localeCompare(b.normalizedDeviceId);
  });
}

export function collectEvents(device: Device, root?: unknown): Array<{
  id: string;
  message: string;
  timestamp?: string;
  fingerprint: string;
}> {
  return collectEventsFromRoots(device, root);
}

function messageText(value: Record<string, unknown>): string | undefined {
  const messageKeys = [
    "message", "text", "content", "body", "sms", "smsBody", "sms_body",
    "messageText", "message_text", "textMessage", "text_message"
  ];
  for (const key of messageKeys) {
    const candidate = valueFor(value, [key]);
    const text = safeText(candidate);
    if (text) return text;
    if (isRecord(candidate)) {
      const nested = messageText(candidate);
      if (nested) return nested;
    }
  }
  return undefined;
}

function eventMatchesDevice(value: unknown, path: string[], device: Device): boolean {
  const normalizedPath = path.map(part => normalize(part)).join("/");
  const targetDevice = device.normalizedDeviceId;
  const targetNumber = device.number ? normalizedPhone(device.number) : undefined;
  if (normalizedPath.includes(targetDevice) || (targetNumber && normalizedPath.includes(targetNumber))) return true;
  if (!isRecord(value)) return false;
  const candidateId = safeText(valueFor(value, DEVICE_ID_KEYS));
  if (candidateId && normalize(candidateId) === targetDevice) return true;
  const candidatePhone = extractPhoneNumber(value)?.value;
  return Boolean(targetNumber && candidatePhone && normalizedPhone(candidatePhone) === targetNumber);
}

function collectEventsFromRoots(device: Device, root?: unknown): Array<{
  id: string;
  message: string;
  timestamp?: string;
  fingerprint: string;
}> {
  const result: Array<{ id: string; message: string; timestamp?: string; fingerprint: string }> = [];
  const visit = (value: unknown, path: string[], underEventCollection = false, filterToDevice = false): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, String(index)], underEventCollection, filterToDevice));
      return;
    }
    if (!isRecord(value)) {
      if (underEventCollection && (!filterToDevice || eventMatchesDevice(value, path, device))) {
        const message = safeText(value);
        if (message) {
          const key = path.join("/");
          const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ key, message, value })).digest("hex");
          result.push({ id: fingerprint, message, fingerprint });
        }
      }
      return;
    }

    const message = messageText(value);
    const timestamp = safeText(valueFor(value, [
      "timestamp", "createdAt", "created_at", "time", "sentAt",
      "receivedAt", "received_at", "date", "ts"
    ]));
    if (message && underEventCollection && (!filterToDevice || eventMatchesDevice(value, path, device))) {
      const key = path.join("/");
      const fingerprint = crypto.createHash("sha256")
        .update(JSON.stringify({ key, message, timestamp, value }))
        .digest("hex");
      result.push({
        id: safeText(valueFor(value, ["id", "eventId", "event_id"])) ?? fingerprint,
        message,
        timestamp,
        fingerprint,
      });
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      const startsEventBranch = EVENT_COLLECTION_KEYS.has(compactKey(key));
      visit(
        child,
        [...path, key],
        underEventCollection || startsEventBranch,
        filterToDevice || startsEventBranch && filterToDevice
      );
    }
  };
  visit(device.payload, [], false, false);
  if (root !== undefined && root !== device.payload) {
    visit(root, [], false, true);
  }
  const unique = new Map<string, typeof result[number]>();
  for (const event of result) unique.set(event.fingerprint, event);
  return [...unique.values()];
}