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
  assert.match(page, /양방향 음성/);
  assert.match(page, /클라우드 7일 보관/);
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
  const authRoute = await readFile(
    new URL("../app/api/auth/me/route.ts", import.meta.url),
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
  assert.match(client, /connectKvsStorageParticipant/);
  assert.match(client, /storageMode/);
  assert.match(client, /STORAGE_PEER_CONNECT_TIMEOUT_MS = 30_000/);
  assert.match(client, /sendSdpOffer/);
  assert.match(client, /sendSdpAnswer/);
  assert.doesNotMatch(client, /globalThis\.RTCPeerConnection/);
  assert.doesNotMatch(client, /new RTCPeerConnection\(/);
  assert.match(client, /\/api\/kvs\/session/);
  assert.match(client, /\/api\/kvs\/join/);
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
  assert.match(database, /recording_sessions/);
  assert.match(database, /eq\(streamSessions\.startedBy, userEmail\)/);
  assert.doesNotMatch(database, /INSERT INTO device_memberships/);
  assert.match(broker, /GetSignalingChannelEndpointCommand/);
  assert.match(broker, /GetIceServerConfigCommand/);
  assert.match(broker, /JoinStorageSessionCommand/);
  assert.match(broker, /JoinStorageSessionAsViewerCommand/);
  assert.match(page, /echoCancellation:\s*true/);
  assert.match(page, /localAudioStream/);
  assert.match(page, /startPendingRef/);
  assert.match(page, /addEventListener\(\s*["']ended["']/);
  assert.match(page, /addEventListener\(["']loadeddata["']/);
  assert.match(page, /onPointerDown/);
  assert.match(page, /window\.addEventListener\(["']pointerup["']/);
  assert.match(page, /말하기/);
  assert.match(page, /7일간 저장/);
  assert.match(page, /AWS KVS · PRIVATE/);
  assert.match(page, /시청 비밀번호/);
  assert.match(page, /코드\+비밀번호 시청/);
  assert.match(page, /ID 로그인/);
  assert.match(page, /로그아웃/);
  assert.match(page, /fetch\(["']\/api\/auth\/me["']/);
  assert.match(page, /\/signout-with-chatgpt\?return_to=/);
  assert.match(page, /authenticated\s*\?\s*["']로그아웃["']\s*:\s*["']ID 로그인["']/);
  assert.match(authRoute, /getRequestUserEmail/);
  assert.match(authRoute, /authenticated:\s*Boolean/);
  assert.match(authRoute, /cache-control["']:\s*["']no-store/);
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

test("protects cloud recordings and issues short-lived HLS playback", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const joinRoute = await readFile(new URL("../app/api/kvs/join/route.ts", import.meta.url), "utf8");
  const recordingsRoute = await readFile(
    new URL("../app/api/recordings/route.ts", import.meta.url),
    "utf8",
  );
  const playbackRoute = await readFile(
    new URL("../app/api/recordings/[recordingId]/playback/route.ts", import.meta.url),
    "utf8",
  );
  const playbackProxyRoute = await readFile(
    new URL(
      "../app/api/recordings/[recordingId]/hls/[playbackId]/[resource]/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const playbackProxy = await readFile(
    new URL("../app/recording-playback-proxy.ts", import.meta.url),
    "utf8",
  );
  const database = await readFile(new URL("../db/petcam.ts", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../drizzle/0003_recording_sessions.sql", import.meta.url),
    "utf8",
  );
  const broker = await readFile(new URL("../infra/aws/kvs-broker/index.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(joinRoute, /getAuthorizedMasterSession/);
  assert.match(joinRoute, /getPasswordAuthorizedViewerSession/);
  assert.match(joinRoute, /storage-join/);
  assert.match(joinRoute, /cache-control["']:\s*["']no-store/);
  assert.match(recordingsRoute, /listAuthorizedRecordingSessions/);
  assert.match(recordingsRoute, /markRecordingStarted/);
  assert.match(recordingsRoute, /RECORDING_SEGMENT_MS/);
  assert.match(recordingsRoute, /retentionCutoff/);
  assert.match(recordingsRoute, /flatMap\(segmentRecording\)/);
  assert.match(playbackRoute, /getAuthorizedRecordingSession/);
  assert.match(playbackRoute, /expiresSeconds/);
  assert.match(playbackRoute, /segmentDurationSeconds/);
  assert.match(playbackRoute, /404/);
  assert.match(playbackRoute, /cache-control["']:\s*["']no-store/);
  assert.match(playbackRoute, /createRecordingPlaybackProxy/);
  assert.match(playbackRoute, /set-cookie/);
  assert.match(playbackProxyRoute, /resolveRecordingPlaybackProxy/);
  assert.match(playbackProxyRoute, /redirect:\s*["']manual["']/);
  assert.match(playbackProxyRoute, /private, no-store/);
  assert.match(playbackProxyRoute, /cross-origin-resource-policy/);
  assert.doesNotMatch(playbackProxyRoute, /getAuthorizedRecordingSession|consumeRequestRateLimit/);
  assert.match(playbackProxy, /\.kinesisvideo\\\.ap-northeast-2\\\.amazonaws\\\.com/);
  assert.match(playbackProxy, /AES-GCM/);
  assert.match(playbackProxy, /HKDF/);
  assert.match(playbackProxy, /HttpOnly/);
  assert.match(playbackProxy, /SameSite=Strict/);
  assert.match(playbackProxy, /rewriteRecordingPlaylist/);
  assert.match(playbackProxy, /searchParams\.delete\(["']SessionToken["']\)/);
  assert.match(database, /inArray\(deviceMemberships\.role, BROADCAST_ROLES\)/);
  assert.match(database, /isNotNull\(recordingSessions\.startedAt\)/);
  assert.match(database, /isNull\(recordingSessions\.endedAt\)/);
  assert.match(migration, /FOREIGN KEY.*stream_sessions/);
  assert.match(broker, /GET_HLS_STREAMING_SESSION_URL/);
  assert.match(broker, /PlaybackMode:\s*["']ON_DEMAND["']/);
  assert.match(broker, /maxHlsPlaybackRangeMs = 60 \* 60 \* 1000/);
  assert.match(broker, /payload\.expiresSeconds > 43_200/);
  assert.match(broker, /Expires:\s*expiresSeconds/);
  assert.match(broker, /MaxMediaPlaylistFragmentResults:\s*5000/);
  assert.match(broker, /ResourceNotFoundException/);
  assert.match(page, /import\(["']hls\.js["']\)/);
  assert.match(page, /Hls\.Events\.ERROR/);
  assert.match(page, /Hls\.Events\.MANIFEST_PARSED/);
  assert.match(page, /Hls\.ErrorTypes\.NETWORK_ERROR/);
  assert.match(page, /data\.fatal/);
  assert.match(page, /NotAllowedError/);
  assert.match(page, /addEventListener\(["']canplay["']/);
  assert.match(page, /addEventListener\(["']error["']/);
  assert.match(page, /녹화 영상을 불러오는 중입니다/);
  assert.match(page, /재생하기/);
  assert.doesNotMatch(page, /video\.play\(\)\.catch\(\(\) => undefined\)/);
  assert.match(page, /각 1시간 이하 구간마다/);
  assert.match(page, /마이크 연결/);
  assert.match(page, /visibilitychange/);
  assert.equal(packageJson.dependencies["hls.js"], "1.6.12");
});
