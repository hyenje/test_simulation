import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("settings, event pagination, idempotency, push, and viewer grants stay hardened", async () => {
  const [database, migration, eventRoute, dashboard, pushBroker, liveRoute] =
    await Promise.all([
      readFile(new URL("../db/homecam.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../drizzle/0004_homecam_platform.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../app/api/devices/[deviceId]/events/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../app/components/homecam-dashboard.tsx", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../app/push-broker.ts", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../app/api/devices/[deviceId]/live-session/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

  assert.match(
    database,
    /monitoring_enabled = CASE[\s\S]*camera_enabled = CASE[\s\S]*microphone_enabled =[\s\S]*CASE/,
  );
  assert.match(
    database,
    /AND NOT \(\? = 1 AND COALESCE\(\?, camera_enabled\) = 0\)/,
  );
  assert.match(
    database,
    /occurred_at < \? OR \(occurred_at = \? AND id < \?\)/,
  );
  assert.match(database, /ORDER BY occurred_at DESC, id DESC LIMIT \?/);
  assert.match(eventRoute, /beforeId/);
  assert.match(dashboard, /params\.set\("beforeId", options\.before\.id\)/);

  assert.match(migration, /`request_fingerprint` text NOT NULL/);
  assert.match(database, /eventRequestFingerprint/);
  assert.match(database, /IDEMPOTENCY_CONFLICT/);
  assert.ok(
    database.indexOf("const duplicate = await getD1()") <
      database.indexOf("const state = await getDeviceSettings(deviceId)"),
    "idempotency lookup must precede current monitoring/session checks",
  );

  assert.match(pushBroker, /PUSH_BROKER_BATCH_SIZE = 100/);
  assert.match(
    pushBroker,
    /targets\.slice\(offset, offset \+ PUSH_BROKER_BATCH_SIZE\)/,
  );
  assert.match(liveRoute, /homecam-viewer-credentials/);
  assert.match(liveRoute, /homecam-storage-join/);
  assert.ok(
    liveRoute.lastIndexOf("userCanViewDevice(deviceId, userEmail)") >
      liveRoute.indexOf("requestBrokerSession"),
    "membership must be checked again after issuing broker credentials",
  );
});

test("local worker bindings include the maintenance scheduler secret", async () => {
  const viteConfig = await readFile(
    new URL("../vite.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(viteConfig, /"MAINTENANCE_SECRET"/);
});
