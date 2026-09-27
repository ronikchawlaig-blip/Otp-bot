import assert from "node:assert/strict";
import { collectEvents, extractDevices } from "./firebase.js";

const snapshot = {
  devices: {
    alpha: {
      deviceId: "alpha",
      phoneNumber: "+91 90000 00001",
      online: true,
      battery: "87%",
      messages: {
        first: { body: "Your OTP is 123456", timestamp: "2026-09-27T10:00:00.000Z" }
      }
    },
    beta: {
      deviceId: "beta",
      phone: "+91 90000 00002",
      status: "online",
      battery: 63
    }
  },
  events: {
    alpha: {
      second: { text: "Your OTP is 654321", timestamp: "2026-09-27T10:01:00.000Z" }
    }
  }
};

const devices = extractDevices(snapshot);
assert.equal(devices.length, 2, "both online device records should be returned");
assert.deepEqual(
  devices.map(device => device.deviceId).sort(),
  ["alpha", "beta"]
);

const alpha = devices.find(device => device.deviceId === "alpha");
assert(alpha, "alpha device should be present");
const events = collectEvents(alpha, snapshot);
assert(events.length >= 2, "device-local and root-level SMS events should be collected");
assert(events.some(event => event.message.includes("123456")));
assert(events.some(event => event.message.includes("654321")));

console.log("firebase selftest passed");