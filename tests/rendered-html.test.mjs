import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

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
  const sessionsRoute = await readFile(
    new URL("../app/api/live-sessions/route.ts", import.meta.url),
    "utf8",
  );
  const database = await readFile(new URL("../db/petcam.ts", import.meta.url), "utf8");
  const broker = await readFile(new URL("../infra/aws/kvs-broker/index.mjs", import.meta.url), "utf8");
  const hosting = JSON.parse(await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"));

  assert.match(page, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(client, /KVSWebRTC/);
  assert.match(client, /browserWindow\.RTCPeerConnection/);
  assert.match(client, /browserWindow\.webkitRTCPeerConnection/);
  assert.match(client, /AdGuard 등 확장 프로그램의 WebRTC 차단을 끈 뒤 새로고침해 주세요/);
  assert.equal(
    client.match(/new PeerConnection\(\{ iceServers: config\.iceServers \}\)/g)?.length,
    2,
  );
  assert.doesNotMatch(client, /globalThis\.RTCPeerConnection/);
  assert.doesNotMatch(client, /new RTCPeerConnection\(/);
  assert.match(client, /\/api\/kvs\/session/);
  assert.match(route, /getAuthorizedMasterSession/);
  assert.match(route, /getPasswordAuthorizedViewerSession/);
  assert.match(route, /role === "MASTER"/);
  assert.match(route, /viewerPassword/);
  assert.match(route, /consumeRequestRateLimit/);
  assert.match(route, /limit: 5/);
  assert.match(route, /limit: 10/);
  assert.match(route, /"retry-after": "60"/);
  assert.match(sessionsRoute, /canBroadcastForConfiguredAccount/);
  assert.match(sessionsRoute, /PETCAM_SHARE_SECRET/);
  assert.match(database, /stream_session_access/);
  assert.match(database, /eq\(streamSessions\.startedBy, userEmail\)/);
  assert.doesNotMatch(database, /INSERT INTO device_memberships/);
  assert.match(broker, /GetSignalingChannelEndpointCommand/);
  assert.match(broker, /GetIceServerConfigCommand/);
  assert.match(page, /audio:\s*false/);
  assert.match(page, /startPendingRef/);
  assert.match(page, /addEventListener\(\s*["']ended["']/);
  assert.match(page, /보호자 1명/);
  assert.match(page, /원본 저장 없음/);
  assert.match(page, /AWS KVS · PRIVATE/);
  assert.match(page, /시청 비밀번호/);
  assert.match(page, /코드\+비밀번호 시청/);
  assert.match(page, /ID 로그인/);
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, null);

  const browserSource = `${page}\n${client}`;
  assert.doesNotMatch(browserSource, /BroadcastChannel|LiveKit|MediaRecorder|localStorage/);
  assert.doesNotMatch(browserSource, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AKIA[0-9A-Z]{16}/);
  const viewerUrlHelper = page.match(/function viewerUrl\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(viewerUrlHelper, /viewerPassword|시청 비밀번호/);

  const javascript = ts.transpileModule(client, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const helper = javascript.match(
    /function requireRtcPeerConnection\(\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(helper, "compiled WebRTC constructor resolver exists");

  const WindowPeerConnection = class WindowPeerConnection {};
  const WebkitPeerConnection = class WebkitPeerConnection {};
  const WrongGlobalPeerConnection = class WrongGlobalPeerConnection {};

  assert.equal(
    runInNewContext(`${helper}\nrequireRtcPeerConnection();`, {
      window: {
        RTCPeerConnection: WindowPeerConnection,
        webkitRTCPeerConnection: WebkitPeerConnection,
      },
      globalThis: { RTCPeerConnection: WrongGlobalPeerConnection },
    }),
    WindowPeerConnection,
  );
  assert.equal(
    runInNewContext(`${helper}\nrequireRtcPeerConnection();`, {
      window: { webkitRTCPeerConnection: WebkitPeerConnection },
      globalThis: { RTCPeerConnection: WrongGlobalPeerConnection },
    }),
    WebkitPeerConnection,
  );
});
