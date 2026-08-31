import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  ADMIN_TELEGRAM_ID: z.coerce.number().default(713914937),
  FIREBASE_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  DEVICE_PAGE_SIZE: z.coerce.number().int().positive().max(30).default(8)
});

export const config = envSchema.parse({
  ...process.env,
  DATABASE_URL: process.env["NEON_DATABASE_URL"] ?? process.env["DATABASE_URL"],
  ADMIN_TELEGRAM_ID: process.env["ADMIN_TELEGRAM_ID"] ?? "713914937",
  FIREBASE_SCAN_INTERVAL_MS: process.env["FIREBASE_SCAN_INTERVAL_MS"] ?? "15000",
  DEVICE_PAGE_SIZE: process.env["DEVICE_PAGE_SIZE"] ?? "8",
});