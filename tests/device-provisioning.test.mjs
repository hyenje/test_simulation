import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

async function loadParser() {
  const source = await readFile(
    new URL("../db/homecam-provisioning-input.ts", import.meta.url),
    "utf8",
  );
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const commonJsModule = { exports: {} };
  runInNewContext(javascript, {
    module: commonJsModule,
    exports: commonJsModule.exports,
    Date,
    Object,
    Array,
    Boolean,
    Number,
    String,
    TextEncoder,
    Uint8Array,
    crypto: globalThis.crypto,
  });
  return commonJsModule.exports;
}

function validPayload() {
  return {
    deviceId: "gazebo-homecam",
    displayName: "Gazebo 홈캠",
    ownerEmail: "owner@example.com",
    sourceProfile: "sim",
    credential: {
      id: "a1bf0d3d-d84c-49e1-aaed-533328473dfb",
      label: "Production credential",
      tokenDigest:
        "e4a6776a63f7c9d33b819c7452fd903a9c128a442d06b649324bfeec4130a575",
      expiresAt: "2026-10-25T11:37:26.020Z",
    },
  };
}

test("one-time provisioning accepts only a bounded canonical payload", async () => {
  const {
    homecamProvisioningManifestSha256,
    parseHomecamProvisioningInput,
  } = await loadParser();
  const now = new Date("2026-07-27T00:00:00.000Z");
  assert.ok(parseHomecamProvisioningInput(validPayload(), now));
  assert.equal(
    parseHomecamProvisioningInput(
      { ...validPayload(), unexpected: true },
      now,
    ),
    null,
  );
  assert.equal(
    parseHomecamProvisioningInput(
      { ...validPayload(), sourceProfile: ["sim"] },
      now,
    ),
    null,
  );
  assert.match(
    await homecamProvisioningManifestSha256(validPayload()),
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    parseHomecamProvisioningInput(
      { ...validPayload(), ownerEmail: "OWNER@example.com" },
      now,
    ),
    null,
  );
  assert.equal(
    parseHomecamProvisioningInput(
      {
        ...validPayload(),
        kvsChannelArn:
          "arn:aws:kinesisvideo:ap-northeast-2:000000000000:channel/untrusted/1",
      },
      now,
    ),
    null,
  );
  assert.equal(
    parseHomecamProvisioningInput(
      {
        ...validPayload(),
        credential: {
          ...validPayload().credential,
          expiresAt: "2026-07-26T00:00:00.000Z",
        },
      },
      now,
    ),
    null,
  );
});

test("provisioning route never accepts or returns the plaintext device token", async () => {
  const [route, database] = await Promise.all([
    readFile(
      new URL(
        "../app/api/internal/device-provisioning/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../db/homecam-provisioning.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(route, /DEVICE_PROVISIONING_SECRET/);
  assert.match(route, /DEVICE_PROVISIONING_MANIFEST_SHA256/);
  assert.match(route, /DEVICE_PROVISIONING_EXPIRES_AT/);
  assert.match(route, /crypto\.subtle\.digest/);
  assert.match(route, /resources\.source !== "mapping"/);
  assert.doesNotMatch(route, /\btoken:\s/);
  assert.match(database, /token_digest/);
  assert.match(database, /HomecamProvisioningConflict/);
  assert.match(database, /await d1\.batch\(statements\)/);
  assert.match(database, /membershipSummary\.total === 1/);
  assert.match(database, /credentialSummary\.total === 1/);
});
