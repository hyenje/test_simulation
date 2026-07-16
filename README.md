# PETCAM

노트북 웹캠을 펫 로봇 카메라처럼 사용해 보호자가 다른 네트워크에서 실시간 영상과 양방향 음성을 확인하는 PETCAM 프로토타입입니다. 미디어는 Amazon Kinesis Video Streams WebRTC Storage Session으로 전송되고 7일간 저장됩니다. 사용자·기기·세션·녹화 권한은 Sites의 D1에 영속 저장합니다.

## 제공 기능

- 노트북 카메라와 마이크의 실시간 송출
- 보호자 화면의 로봇 영상·음성 재생
- 기본 음소거 상태의 보호자 `말하기` 기능
- AWS KVS 자동 녹화와 7일 보존
- 송출 권한 ID 전용 녹화 목록과 1시간 단위 HLS 재생
- 55분마다 새 자격정보로 WebRTC 연결 자동 갱신
- 송출 ID·기기 멤버십 확인
- 보호자 ID 로그인 + 6자리 코드 + 16자리 시청 비밀번호 확인
- 기존 P2P 채널로 되돌릴 수 있는 환경 변수 기반 폴백

## 구조

```text
카메라 노트북 (MASTER, H.264 + Opus)
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
└── recording_sessions
```

Storage Session에서는 MASTER와 VIEWER가 모두 AWS가 보내는 SDP offer에 answer합니다. MASTER는 카메라 영상과 로봇 쪽 마이크를 보내고 보호자 혼합 음성을 받습니다. VIEWER는 마이크 권한 없이 영상·음성부터 연결합니다. 사용자가 `마이크 연결`을 선택하면 권한을 요청하고 같은 viewer client ID로 재협상한 뒤, `말하기` 버튼으로 비활성 audio track만 켜고 끕니다.

브라우저나 Sites 런타임에는 AWS IAM Access Key를 저장하지 않습니다. Sites API가 로그인·세션·비밀번호·rate limit을 확인한 다음 HMAC으로 Lambda broker를 호출합니다. Lambda만 최소 권한 실행 역할을 사용해 WSS, TURN, Storage Session 참여, HLS URL을 발급합니다. 녹화 재생 시 AWS 세션 토큰은 짧게 만료되는 암호화·HttpOnly 쿠키에만 두고, 브라우저에는 Sites와 같은 origin의 불투명한 재생 주소를 제공합니다. Sites proxy가 HLS playlist와 MP4 fragment를 스트리밍해 브라우저 CORS 경계를 처리합니다.

## 권한 경계

- 세션 생성: `PETCAM_BROADCASTER_EMAILS` 등록 + D1의 `owner` 또는 `broadcaster` 멤버십
- 실시간 시청: 로그인 ID + 세션 코드 + 시청 비밀번호
- 녹화 목록·재생: 해당 기기의 `owner` 또는 `broadcaster`만 허용
- 비밀번호: URL·브라우저 저장소에 넣지 않고 D1에는 HMAC 검증값만 저장
- HLS 재생: 서버가 검증한 1시간 이하 구간에만 발급하고, AWS 세션 토큰은 JSON·클라이언트 URL·브라우저 저장소에 노출하지 않으며 암호화된 HttpOnly 쿠키로만 전달
- 잘못된 비밀번호: ID·세션별 분당 5회
- 연결·재생 요청: 목적별 분당 10회

녹화 행에는 당시 channel ARN과 stream ARN을 서버에서 스냅샷합니다. 이 값은 API 응답으로 노출하지 않습니다. 따라서 기존 기기의 P2P channel ARN을 변경하지 않고도 Storage 채널을 사용할 수 있고, `KVS_STREAM_ARN`을 제거하면 기존 P2P 경로로 돌아갈 수 있습니다.

## 환경 변수

`.env.example`을 기준으로 설정합니다. 실제 비밀값은 `.env`나 Git에 커밋하지 않습니다.

```text
PETCAM_DEV_USER_EMAIL        # 로컬 개발용 로그인 ID
PETCAM_BROADCASTER_EMAILS    # 쉼표로 구분한 송출 허용 ID
PETCAM_DEVICE_ID             # D1에 등록된 기기 ID
PETCAM_SHARE_SECRET          # 시청 비밀번호 HMAC용 비밀값
KVS_CHANNEL_ARN              # Storage signaling channel ARN
KVS_STREAM_ARN               # 7일 보존 Kinesis Video Stream ARN
KVS_BROKER_URL               # Storage 전용 Lambda Function URL
KVS_BROKER_SECRET            # Sites ↔ Lambda 요청 HMAC 비밀값
```

`KVS_STREAM_ARN`이 없으면 녹화 API와 Storage join을 사용하지 않고 기존 MASTER–VIEWER P2P 흐름을 유지합니다.

## AWS 리소스

- 리전: `ap-northeast-2`
- 기존 P2P channel: `soma-aiot-pet-laptop-01` — Media Storage `DISABLED`, 롤백 기준선
- Storage channel: `soma-aiot-pet-laptop-storage-dev`
- 7일 stream: `soma-aiot-pet-laptop-archive-dev`
- Storage broker: `petcam-kvs-storage-dev-broker`
- Broker role: `petcam-kvs-storage-dev-broker-role`

Storage channel만 archive stream에 연결합니다. 기존 P2P channel에는 Media Storage를 켜지 않습니다. Lambda Function URL 자체는 `NONE`이지만, 모든 애플리케이션 요청은 타임스탬프가 포함된 HMAC으로 한 번 더 인증합니다.

## 로컬 실행

```bash
npm install
npm run dev
```

AWS의 브라우저 WebRTC ingestion 검증은 Chrome을 기준으로 합니다. 송출자는 카메라와 마이크를 모두 허용해야 합니다. 보호자 마이크는 거부해도 보기 전용으로 연결됩니다.

## 두 기기 smoke test

1. 송출 권한 ID로 로그인하고 `AWS 세션 만들기`를 선택합니다.
2. `카메라 켜기`를 누르고 카메라·마이크 권한을 허용합니다.
3. 다른 네트워크의 Chrome에서 보호자 ID로 로그인합니다.
4. 초대 링크, 6자리 코드, 시청 비밀번호를 입력합니다.
5. 두 화면이 `실시간 연결됨`으로 바뀌고 보호자 화면에 실제 영상이 보이는지 확인합니다.
6. 로봇 쪽 음성이 보호자에게 들리는지 확인합니다.
7. 보호자 `말하기`를 켜고 송출 노트북에서 음성이 들리는지 확인합니다.
8. AWS stream에 fragment가 생성되는지 확인합니다.
9. 송출을 종료하고 권한 ID의 `지난 영상`에서 1시간 단위 구간의 영상과 음성을 재생합니다.
10. 기존 P2P channel의 Media Storage가 계속 `DISABLED`인지 확인합니다.

코드·빌드 통과만으로 실기기 검증이 완료된 것은 아닙니다. 완료 조건은 다른 네트워크의 보호자 기기에서 실제 영상과 양방향 음성이 재생되고, 종료 뒤 HLS 녹화까지 재생되는 것입니다.

## 검증

```bash
npm run lint
npm test
node --check infra/aws/kvs-broker/index.mjs
```

## 현재 한계

- AWS 브라우저 ingestion 검증 대상은 Chrome입니다.
- 녹화는 KVS 7일 보존이며 S3 영구 보관·다운로드·클립 추출은 아직 없습니다.
- HLS 재생은 AWS의 최대 5,000 fragments 범위를 넘기지 않도록 1시간 단위로 나눕니다. 각 구간은 별도 재생 항목으로 표시됩니다.
- 실제 펫 로봇에서는 웹 MASTER 대신 AWS KVS WebRTC C SDK 기반 기기 프로세스로 교체해야 합니다. 보호자 페이지와 D1 권한 구조는 유지할 수 있습니다.
