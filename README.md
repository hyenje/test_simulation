# PETCAM / MALBUT Homecam PoC

가정용 이동 로봇의 홈캠 기능을 검증하는 모바일 PWA와 백엔드입니다. 보호자는 다른 네트워크에서 실시간 영상과 로봇 음성을 확인하고 PTT로 말할 수 있습니다. 모니터링을 켜면 Amazon Kinesis Video Streams WebRTC Storage Session으로 영상을 7일간 저장하고, 사람·개·고양이·움직임 이벤트를 타임라인에서 확인합니다. 사용자·기기·가족·세션·이벤트 권한은 Sites의 D1에 영속 저장합니다.

## 제공 기능

- 모바일 PWA의 장치 상태, `LIVE`·`REC`·카메라·마이크 표시
- 보호자 화면의 실시간 영상·로봇 음성 재생과 단일 사용자 PTT
- 모니터링 ON일 때 AWS KVS 연속 녹화와 7일 보존
- `motion`·`person`·`dog`·`cat` 이벤트 필터와 발생 시각 재생
- 사진을 포함하지 않는 Web Push와 앱 내 이벤트 타임라인
- 소유자·가족 역할, 가족 초대·해제, 접근 감사 로그
- 장치별 bearer token, 전용 P2P·Storage channel/stream과 채널 한정 15분 STS 자격 정보
- Storage 연결을 55분마다 재참가하고, 장치 STS 자격정보는 만료 5분 전에 갱신
- 기존 6자리 코드와 시청 비밀번호 공유 경로를 레거시로 보존

## 구조

```text
Gazebo 또는 Jetson 홈캠 에이전트 (MASTER, H.264 + Opus)
        │
        ├── WSS signaling ── Sites API ── HMAC ── Lambda broker
        │
        ▼
AWS KVS WebRTC Storage Session
        ├── 실시간 혼합 영상·음성 ── 보호자 브라우저 (VIEWER)
        └── Kinesis Video Stream ── 7일 보존 ── 1시간 이하 HLS 구간
                                      └── Sites same-origin proxy ── 녹화 재생

D1
├── devices / device_memberships
├── stream_sessions / stream_session_access
├── recording_sessions / homecam_events / homecam_push_outbox
├── device_credentials / device_state
├── push_subscriptions / talk_leases
└── access_audit_log
```

Storage Session에서는 MASTER와 VIEWER가 모두 AWS가 보내는 SDP offer에 answer합니다. MASTER는 카메라 영상과 로봇 쪽 마이크를 보내고 보호자 혼합 음성을 받습니다. VIEWER는 마이크 권한 없이 영상·음성부터 연결합니다. 사용자가 `마이크 연결`을 선택하면 권한을 요청하고 같은 viewer client ID로 재협상한 뒤, `말하기` 버튼으로 비활성 audio track만 켜고 끕니다.

브라우저나 Sites 런타임에는 AWS IAM Access Key를 저장하지 않습니다. Sites API가 로그인·세션·비밀번호·rate limit을 확인한 다음 HMAC으로 Lambda broker를 호출합니다. Lambda만 최소 권한 실행 역할을 사용해 WSS, TURN, Storage Session 참여, HLS URL을 발급합니다. 녹화 재생 시 AWS 세션 토큰은 짧게 만료되는 암호화·HttpOnly 쿠키에만 두고, 브라우저에는 Sites와 같은 origin의 불투명한 재생 주소를 제공합니다. Sites proxy가 HLS playlist와 MP4 fragment를 스트리밍해 브라우저 CORS 경계를 처리합니다.

## 권한 경계

- 소유자: 실시간 보기·PTT·재생·이벤트와 가족·프라이버시·장치 자격 증명 관리
- 가족: 실시간 보기·PTT·재생·이벤트만 허용
- 가족 해제: 신규 스트리밍 자격 정보와 이후 HLS·API 접근을 즉시 차단하고,
  공식 PWA의 기존 라이브 연결은 최대 5초 안에 닫음
- 레거시 공유: 로그인 ID + 세션 코드 + 시청 비밀번호로 별도 진입
- 비밀번호: URL·브라우저 저장소에 넣지 않고 D1에는 HMAC 검증값만 저장
- HLS 재생: 서버가 검증한 1시간 이하 구간에만 발급하고, AWS 세션 토큰은 JSON·클라이언트 URL·브라우저 저장소에 노출하지 않으며 암호화된 HttpOnly 쿠키로만 전달
- 잘못된 비밀번호: ID·세션별 분당 5회
- 연결·재생 요청: 목적별 분당 10회

녹화 행에는 당시 channel ARN과 stream ARN을 서버에서 스냅샷합니다. 이 값은 API 응답으로 노출하지 않습니다. Sites와 Lambda에는 동일한 `KVS_DEVICE_CHANNELS_JSON`을 서버 환경 변수로 설정하며, 로그인·장치 토큰 검증이 끝난 단일 `deviceId`의 ARN만 선택합니다. 매핑 전체는 브라우저나 장치 응답으로 보내지 않습니다.

## 환경 변수

`.env.example`을 기준으로 설정합니다. 실제 비밀값은 `.env`나 Git에 커밋하지 않습니다.

```text
PETCAM_DEV_USER_EMAIL        # 로컬 개발용 로그인 ID
PETCAM_BROADCASTER_EMAILS    # 쉼표로 구분한 송출 허용 ID
PETCAM_DEVICE_ID             # D1에 등록된 기기 ID
PETCAM_SHARE_SECRET          # 시청 비밀번호 HMAC용 비밀값
KVS_DEVICE_CHANNELS_JSON     # deviceId별 P2P·Storage channel과 stream의 서버 전용 JSON
KVS_CHANNEL_ARN              # PETCAM_DEVICE_ID 한 대에만 허용되는 레거시 channel
KVS_P2P_CHANNEL_ARN          # PETCAM_DEVICE_ID 한 대의 레거시 P2P channel
KVS_STORAGE_CHANNEL_ARN      # PETCAM_DEVICE_ID 한 대의 레거시 Storage channel
KVS_STREAM_ARN               # PETCAM_DEVICE_ID 한 대의 레거시 stream
KVS_BROKER_URL               # Storage 전용 Lambda Function URL
KVS_BROKER_SECRET            # Sites ↔ Lambda 요청 HMAC 비밀값
PUSH_BROKER_URL              # Web Push 암호화·전송 서비스의 HTTPS endpoint
PUSH_BROKER_SECRET           # Sites ↔ Push broker 요청 HMAC 비밀값
PUSH_VAPID_PUBLIC_KEY        # 브라우저 PushManager 구독에 사용하는 base64url 공개키
MAINTENANCE_SECRET           # retention/outbox 정기 작업 endpoint용 임의 비밀값
```

장치 매핑은 다음처럼 한 줄 JSON으로 설정합니다. 각 장치는 서로 다른 두
channel과 stream을 가져야 하며 세 ARN은 같은 AWS partition·region·account에
속해야 합니다. 서로 다른 장치가 ARN 하나라도 공유하거나 JSON에 알 수 없는
필드가 있으면 Sites와 Lambda가 모두 fail-closed합니다.

```json
{
  "homecam-01": {
    "p2pChannelArn": "arn:aws:kinesisvideo:ap-northeast-2:000000000000:channel/homecam-01-p2p/0000000000000",
    "storageChannelArn": "arn:aws:kinesisvideo:ap-northeast-2:000000000000:channel/homecam-01-storage/0000000000000",
    "streamArn": "arn:aws:kinesisvideo:ap-northeast-2:000000000000:stream/homecam-01-archive/0000000000000"
  }
}
```

Lambda broker에는 동일한 `KVS_DEVICE_CHANNELS_JSON`과 별도로
`KVS_DEVICE_ROLE_ARN`을 설정합니다. 이 역할은
선택된 signaling channel에 대한
`DescribeSignalingChannel`, `GetSignalingChannelEndpoint`,
`GetIceServerConfig`, `ConnectAsMaster`와 Storage 모드의
`DescribeMediaStorageConfiguration`, `JoinStorageSession`, 그리고 선택된
stream에 대한 `GetDataEndpoint`, `DescribeStream`, `PutMedia`만 허용합니다.
Lambda가 발급하는 STS inline policy도 같은 channel/stream ARN으로 다시
제한됩니다. Sites는 HMAC으로 broker를 호출하고,
broker는 인증된 장치 API 요청에만 15분짜리 STS 자격 정보를 반환합니다.
장치 bearer token과 AWS 장기 Access Key는 서로 대체하지 않으며, AWS 장기
키는 장치·D1·브라우저 어디에도 저장하지 않습니다.

전역 `KVS_*_ARN` fallback은 `PETCAM_DEVICE_ID`가 명시된 단일 레거시
장치에만 적용됩니다. 요청의 `deviceId`가 다르면 사용하지 않으며,
`PETCAM_DEVICE_ID` 없이 전역 ARN만 설정하면 broker는 시작 요청을
거부합니다. 신규 장치는 전역 fallback 대신 장치 매핑에 추가합니다.

## 홈캠 장치 API

홈캠 에이전트는 소유자가 한 번 발급한 `hc1.<credential-id>.<secret>`
토큰을 `Authorization: Bearer` 헤더로 보냅니다. D1에는 토큰의 SHA-256
digest만 저장됩니다.

- `POST /api/device/v1/heartbeat`: 장치 상태 보고 및 카메라·마이크·모니터링 설정 수신
- `POST /api/device/v1/session`: C SDK용 채널 한정 STS 자격 정보 발급
- `DELETE /api/device/v1/session`: `{sessionId}`와 일치하는 장치 세션만 종료
- `POST /api/device/v1/events`: idempotency key가 있는 motion/person/dog/cat 이벤트 저장

사용자는 `GET /api/devices`로 멤버십 장치와 활성 세션을 조회합니다.
`POST /api/devices/:deviceId/live-session`은 owner/family 멤버십만으로
VIEWER 연결 정보를 발급하므로 세션 비밀번호를 노출하지 않습니다.
기존 6자리 코드와 시청 비밀번호 API는 레거시 공유 경로로 유지됩니다.

Web Push는 Sites가 endpoint에 직접 평문을 보내는 방식이 아닙니다. 이벤트와
동시에 D1 outbox 행을 만들고, `PUSH_BROKER_URL`로 구독 endpoint와 암호화 키,
사진이 없는 텍스트 알림 payload를 HMAC 서명해 전달합니다. 같은
idempotency key의 장치 재시도는 미완료 outbox를 다시 전송하며, 성공한
이벤트는 서비스 워커의 event ID tag로 중복 표시를 막습니다. Push broker는
VAPID 서명과 RFC 8291 암호화를 수행하고 구독별 HTTP status를
`{"results":[{"subscriptionId":"...","status":201}]}` 형태로 반환해야
합니다. Sites는 `404` 또는 `410`인 구독을 즉시 폐기합니다. broker 장애는
영상 이벤트 저장을 롤백하지 않고 outbox에 남기며 장치 API 응답의
`push.reason`에 실패 원인을 표시합니다.

배포 가능한 참조 구현은 `infra/aws/push-broker`에 있습니다. Node.js Lambda로
패키징한 뒤 Function URL을 `PUSH_BROKER_URL`로 설정합니다. Function URL이
공개 인증 방식이어도 애플리케이션 요청은 30초 허용 범위의 HMAC으로 다시
검증됩니다. Lambda 환경에는 `PUSH_VAPID_SUBJECT`,
`PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY`,
`BROKER_SHARED_SECRET`을 설정하며, Sites의 `PUSH_BROKER_SECRET`은
동일한 broker secret을 사용합니다. VAPID private key는 Lambda에만
존재해야 합니다.

레거시 장치에서 `KVS_STREAM_ARN`이 없으면 모니터링을 OFF로 유지해야 하며,
MASTER–VIEWER P2P 실시간 보기와 PTT만 사용할 수 있습니다. 신규 매핑 항목은
P2P channel, Storage channel, stream 세 값을 모두 요구합니다.

## AWS 리소스

- 리전: `ap-northeast-2`
- 기존 P2P channel: `soma-aiot-pet-laptop-01` — Media Storage `DISABLED`, 롤백 기준선
- Storage channel: `soma-aiot-pet-laptop-storage-dev`
- 7일 stream: `soma-aiot-pet-laptop-archive-dev`
- Storage broker: `petcam-kvs-storage-dev-broker`
- Broker role: `petcam-kvs-storage-dev-broker-role`

Storage channel만 archive stream에 연결합니다. 기존 P2P channel에는 Media Storage를 켜지 않습니다. Lambda Function URL 자체는 `NONE`이지만, 모든 애플리케이션 요청은 타임스탬프가 포함된 HMAC으로 한 번 더 인증합니다.

## 배포 체크리스트

1. D1에 `drizzle/0004_homecam_platform.sql`을 적용한다.
2. 각 장치에 전용 P2P·Storage channel과 stream을 만들고 서로 ARN이
   중복되지 않는 `KVS_DEVICE_CHANNELS_JSON`을 작성한다.
3. `infra/aws/kvs-broker`를 배포하고 같은 장치 매핑,
   `KVS_DEVICE_ROLE_ARN`과 broker secret을 설정한다.
4. `infra/aws/push-broker`를 배포하고 VAPID key·subject와 broker secret을
   설정한다.
5. Sites 런타임에 같은 `KVS_DEVICE_CHANNELS_JSON`, KVS·Push broker
   URL/secret, VAPID public key를 등록한다. JSON은 공개 클라이언트 환경
   변수로 등록하지 않는다.
6. 소유자 membership이 있는 장치에서 bearer token을 한 번 발급해 장치의
   systemd credential에 저장한다.
7. 새 Sites version을 배포한 뒤 외부 네트워크에서 라이브·PTT·녹화·푸시를
   순서대로 smoke test한다.
8. 신뢰할 수 있는 scheduler가 `Authorization: Bearer
   $MAINTENANCE_SECRET`과 빈 JSON `{}`로
   `POST /api/internal/maintenance`를 정기 호출하게 구성해, 활동이 없는
   기간에도 이벤트 7일·감사 로그 30일 정리와 Push outbox 재시도가
   실행되는지 확인한다.

2026-07-26 확인 기준, 연결된 Sites 운영 환경에는 기존 KVS channel/stream
설정만 존재한다.
새 장치별 P2P·Storage·stream 매핑과 Push 설정, 새 Lambda 코드, D1 migration을 모두
적용하기 전에는 이 홈캠 변경본을 운영 배포하지 않는다.

## 로컬 실행

```bash
npm install
npm run dev
```

ROS2 장치 코드는 별도 저장소인
`/home/shin/ros2_ws/src/homecam_agent`에 있습니다. Gazebo에서는
`homecam_sim.launch.py`, Jetson·Aurora에서는 `homecam_aurora.launch.py`로
토픽과 인코더·오디오 장치를 주입합니다.

## 모바일·장치 smoke test

1. 소유자가 장치를 등록하고 장치 bearer token을 한 번 발급합니다.
2. 홈캠 에이전트에 `device_id`, `backend_url`, token을 설정해 실행합니다.
3. 외부 네트워크의 모바일 브라우저에서 소유자 또는 가족 계정으로 로그인합니다.
4. `LIVE` 상태와 실시간 H.264·Opus 영상 및 음성을 확인합니다.
5. PTT를 누르는 동안만 보호자 마이크가 전송되고 로봇에서 재생되는지 확인합니다.
6. 모니터링을 켜고 KVS stream의 fragment와 이벤트 타임라인을 확인합니다.
7. 이벤트를 선택해 해당 녹화 구간과 정확한 offset으로 재생되는지 확인합니다.
8. 가족 권한을 해제한 뒤 라이브·재생·이벤트 접근이 차단되는지 확인합니다.
9. 기존 P2P channel의 Media Storage가 계속 `DISABLED`인지 확인합니다.

코드·빌드 통과만으로 실기기 검증이 완료된 것은 아닙니다. ROS 에이전트의
C SDK 미디어 전송 어댑터는 구현되어 있으나, 완료 조건은 새 AWS 리소스와
D1 migration·Sites 설정을 배포한 뒤 외부 네트워크의 보호자 기기에서 실제
영상·양방향 음성·HLS 녹화까지 재생하는 것입니다.

## 검증

```bash
npm run lint
npm test
node --check infra/aws/kvs-broker/index.mjs
node --check infra/aws/kvs-broker/device-config.mjs
node --check infra/aws/push-broker/index.mjs
```

## 현재 한계

- AWS 브라우저 ingestion 검증 대상은 Chrome입니다.
- 녹화는 KVS 7일 보존이며 S3 영구 보관·다운로드·클립 추출은 아직 없습니다.
- HLS 재생은 AWS의 최대 5,000 fragments 범위를 넘기지 않도록 1시간 단위로 나눕니다. 각 구간은 별도 재생 항목으로 표시됩니다.
- `homecam_agent`는 SDK 활성 빌드에서 AWS KVS signaling·H.264/Opus 전송·원격 Opus 수신을 구현했습니다. SDK 비활성 기본 빌드는 의도적으로 fail-closed이며, 실제 AWS 외부망 종단 간 검증은 아직 수행하지 않았습니다.
- PTT lease는 user와 viewer client ID에 결속하지만 KVS peer 자체가 임의로
  오디오를 보내는 것을 장치 내부에서 암호학적으로 증명·차단하는 단계는
  후속 보강 항목입니다.
- 가족 해제 뒤 공식 PWA는 주기적 권한 확인으로 기존 peer를 닫습니다. 이미
  연결된 비협조적 커스텀 KVS client를 서버에서 즉시 강제 종료하는 기능은
  PoC 범위에 포함하지 않습니다.
- Aurora 930 Pro의 실제 RGB 토픽·오디오 장치명과 Jetson 하드웨어 인코더는 실물에서 확인한 값을 launch parameter로 주입해야 합니다.
