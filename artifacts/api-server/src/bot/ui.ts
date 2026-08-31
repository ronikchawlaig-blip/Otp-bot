import type { InlineKeyboardMarkup } from "telegraf/types";
import type {
  AdminConnection, AdminUser, DeviceSummary, FirebaseConnection,
  FreeFirebasePanel, ReferralStats, RequiredChannel
} from "./types.js";

export const homeKeyboard = (showAdmin = false): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [{ text: "✨ Free Panels", callback_data: "free_panels" }, { text: "📱 Devices", callback_data: "devices" }],
    [{ text: "➕ Add Firebase", callback_data: "add_firebase" }, { text: "🗂 My Firebase", callback_data: "my_firebase" }],
    [{ text: "🔄 Refresh", callback_data: "home" }],
    [{ text: "ℹ️ Help", callback_data: "help" }],
    ...(showAdmin ? [[{ text: "👑 Admin Panel", callback_data: "admin" }]] : [])
  ]
});

export const navKeyboard = (backData = "back"): InlineKeyboardMarkup => ({
  inline_keyboard: [[{ text: "⬅️ Back", callback_data: backData }, { text: "🏠 Home", callback_data: "home" }]]
});

export function homeText(summary: { connections: number; devices: DeviceSummary }, firebaseLimit = 10) {
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "🔥 DEVICE MANAGER",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "Your secure control center for connected Firebase databases and authorized devices.",
    "",
    "📊 ACCOUNT OVERVIEW",
    `🔥 Firebase: ${summary.connections}/${firebaseLimit}`,
    `📱 Devices: ${summary.devices.total}`,
    `🟢 Online: ${summary.devices.online}  ·  🔴 Offline: ${summary.devices.offline}`,
    "",
    "Choose an action below to continue.",
    "",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function firebaseListText(connections: FirebaseConnection[], summaries: Map<string, DeviceSummary>, firebaseLimit = 10) {
  const lines = ["━━━━━━━━━━━━━━━━━━━━", "🔥 MY FIREBASE", "━━━━━━━━━━━━━━━━━━━━", "", `Connections: ${connections.length}/${firebaseLimit}`, ""];
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
      [{ text: "🎁 Free Access", callback_data: "admin_free" }],
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

export function adminSettingsText(firebaseLimit: number, maintenanceEnabled: boolean): string {
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "⚙️ ADMIN SETTINGS",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `🛠 Maintenance mode: ${maintenanceEnabled ? "ON" : "OFF"}`,
    `🔥 Firebase connection limit: ${firebaseLimit}`,
    "",
    "Choose a connection limit below. This applies to all users.",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function adminSettingsKeyboard(firebaseLimit: number, maintenanceEnabled: boolean): InlineKeyboardMarkup {
  const options = [2, 5, 10, 20];
  return {
    inline_keyboard: [
      options.map(limit => ({ text: `${limit === firebaseLimit ? "✅ " : ""}${limit}`, callback_data: `admin_limit:${limit}` })),
      [{ text: `🛠 Maintenance ${maintenanceEnabled ? "OFF" : "ON"}`, callback_data: "maintenance" }],
      [{ text: "⬅️ Admin Dashboard", callback_data: "admin" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function freePanelText(
  stats: ReferralStats,
  minimumReferrals: number,
  channels: RequiredChannel[],
  joined: Map<string, boolean>,
  availablePanels: number,
  referralLink?: string,
  claimed?: FreeFirebasePanel
): string {
  const qualified = stats.qualified;
  const remaining = Math.max(0, minimumReferrals - qualified);
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    "✨ FREE PANELS",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `👥 Tere refers: ${qualified}/${minimumReferrals}`,
    `📈 Total referred: ${stats.total}`,
    "",
    "🎯 UNLOCK kaise kare?",
    "1️⃣ Neeche wala REFER link dosto ko bhejo",
    "2️⃣ Wo bot start kare + SAARE channels join kare",
    "3️⃣ Referral verify hone ke baad free Firebase claim karo",
    ""
  ];
  if (claimed) {
    lines.push("✅ FREE FIREBASE ALREADY CLAIMED", "", `🔥 ${claimed.displayName}`, `🔗 ${claimed.firebaseUrl}`, "", "Ye reward tumhare account me add kar diya gaya hai.");
  } else if (remaining > 0) {
    lines.push(`⏳ ${remaining} qualified referral${remaining === 1 ? "" : "s"} aur chahiye.`);
  } else if (!availablePanels) {
    lines.push("✅ Referral target complete hai.", "", "⏳ Admin pool me abhi koi free Firebase available nahi hai.");
  } else {
    lines.push("✅ Referral target complete hai.", "", "🎁 Ab tum free Firebase claim kar sakte ho.");
  }
  if (channels.length) {
    lines.push("", "📣 REQUIRED CHANNELS");
    for (const channel of channels) lines.push(`${joined.get(channel.id) ? "✅" : "❌"} ${channel.title}`);
  }
  if (referralLink) lines.push("", `🔗 Your referral link:\n${referralLink}`);
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

export function adminFreeAccessText(minimumReferrals: number, panels: FreeFirebasePanel[], channels: RequiredChannel[]): string {
  const available = panels.filter(panel => panel.active && !panel.assignedTo).length;
  const assigned = panels.filter(panel => panel.assignedTo).length;
  return [
    "━━━━━━━━━━━━━━━━━━━━",
    "🎁 FREE ACCESS CONTROL",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `🎯 Minimum qualified referrals: ${minimumReferrals}`,
    `🔥 Free Firebase pool: ${available} available · ${assigned} assigned`,
    `📣 Required channels: ${channels.length}`,
    "",
    "Admin yahan se referral target, reward Firebase pool, aur channel gate control kar sakta hai.",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function adminFreeAccessKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🎯 Minimum Referrals", callback_data: "admin_referral_min" }],
      [{ text: "🔥 Manage Free Firebase", callback_data: "admin_free_pool" }],
      [{ text: "📣 Manage Required Channels", callback_data: "admin_channels" }],
      [{ text: "⬅️ Admin Dashboard", callback_data: "admin" }, { text: "🏠 Home", callback_data: "home" }]
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
    "Qualified referral ka matlab: referred user ne bot start karke required channels verify kiye hain.",
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
    "🔥 FREE FIREBASE POOL",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "Available Firebase reward panels:"
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
      [{ text: "➕ Add Free Firebase", callback_data: "admin_free_pool_add" }],
      ...panels.map(panel => [{
        text: `🗑 Remove ${panel.displayName}`,
        callback_data: `admin_free_pool_remove:${panel.id}`
      }]),
      [{ text: "⬅️ Free Access", callback_data: "admin_free" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}

export function adminChannelsText(channels: RequiredChannel[]): string {
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    "📣 REQUIRED CHANNELS",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "Users must join and verify every channel before their referral counts.",
  ];
  if (!channels.length) lines.push("", "No required channels configured. Referrals qualify after bot start.");
  channels.forEach((channel, index) => {
    lines.push("", `${index + 1}. ${channel.title}`, `🆔 ${channel.chatId}`, `🔗 ${channel.inviteLink ?? "No invite link"}`);
  });
  lines.push("", "━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

export function adminChannelsKeyboard(channels: RequiredChannel[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "➕ Add Required Channel", callback_data: "admin_channel_add" }],
      ...channels.map(channel => [{
        text: `🗑 Remove ${channel.title}`,
        callback_data: `admin_channel_remove:${channel.id}`
      }]),
      [{ text: "⬅️ Free Access", callback_data: "admin_free" }, { text: "🏠 Home", callback_data: "home" }]
    ]
  };
}