import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("build contains the AWS pet camera product surface", async () => {
  await access(new URL("../dist/server/index.js", import.meta.url));
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(layout, /title:\s*["']PETCAM \| 보호자 실시간 펫 카메라["']/i);
  assert.match(page, /AWS로 실시간 연결/);
  assert.match(page, /AWS 세션 만들기/);
  assert.match(page, /실시간 시청자/);
  assert.doesNotMatch(`${layout}\n${page}`, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("uses AWS KVS signaling without shipping credentials to the browser", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const client = await readFile(new URL("../app/lib/kvs-client.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/kvs/session/route.ts", import.meta.url), "utf8");
  const broker = await readFile(new URL("../infra/aws/kvs-broker/index.mjs", import.meta.url), "utf8");
  const hosting = JSON.parse(await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"));

  assert.match(page, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(client, /KVSWebRTC/);
  assert.match(client, /new RTCPeerConnection\(\{ iceServers: config\.iceServers \}\)/);
  assert.match(client, /\/api\/kvs\/session/);
  assert.match(route, /getAuthorizedSession/);
  assert.match(broker, /GetSignalingChannelEndpointCommand/);
  assert.match(broker, /GetIceServerConfigCommand/);
  assert.match(page, /audio:\s*false/);
  assert.match(page, /startPendingRef/);
  assert.match(page, /addEventListener\(\s*["']ended["']/);
  assert.match(page, /보호자 1명/);
  assert.match(page, /원본 저장 없음/);
  assert.match(page, /AWS KVS · PRIVATE/);
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, null);

  const browserSource = `${page}\n${client}`;
  assert.doesNotMatch(browserSource, /BroadcastChannel|LiveKit|MediaRecorder|localStorage/);
  assert.doesNotMatch(browserSource, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AKIA[0-9A-Z]{16}/);
});
