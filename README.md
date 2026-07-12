# PETCAM

노트북 웹캠을 펫 로봇 카메라로 사용해 보호자가 다른 네트워크에서 실시간으로 확인하는 비공개 알파입니다. 미디어와 시그널링은 Amazon Kinesis Video Streams WebRTC를 사용하고, 사용자–기기 소유권과 활성 세션은 D1에 영속 저장합니다.

## 구조

- 카메라 노트북: AWS KVS `MASTER`
- 보호자 브라우저: AWS KVS `VIEWER`
- AWS Lambda broker: 실행 역할로 역할별 WSS URL과 TURN 설정 발급
- Sites API: 로그인 사용자와 D1 기기 소유권 검사
- D1: 기기, 멤버십, 스트리밍 세션 메타데이터 저장
- 원본 영상: 녹화하거나 저장하지 않음

브라우저와 Sites 런타임에는 AWS IAM Access Key를 저장하지 않습니다. Sites는 HMAC으로 Lambda broker를 호출하고, Lambda가 약 5분 동안 연결에 사용할 수 있는 KVS WSS URL을 발급합니다.

## 로컬 실행

`.env.example`을 기준으로 로컬 런타임 값을 준비한 뒤 실행합니다. 실제 비밀값은 `.env` 파일이나 커밋에 넣지 않습니다.

```bash
npm install
npm run dev
```

1. `AWS 세션 만들기`를 선택합니다.
2. `카메라 켜기`를 누르고 카메라 권한을 허용합니다.
3. 보호자 링크를 다른 브라우저나 노트북에서 엽니다.
4. 같은 계정으로 로그인하고 상태가 `실시간 연결됨`으로 바뀌는지 확인합니다.

## AWS 리소스

- 리전: `ap-northeast-2`
- KVS signaling channel: `soma-aiot-pet-laptop-01`
- 채널은 시청할 때마다 만들지 않고 기기와 함께 계속 재사용합니다.
- `infra/aws/kvs-broker`의 Lambda는 `GetSignalingChannelEndpoint`, `GetIceServerConfig`, `ConnectAsMaster`, `ConnectAsViewer`만 허용한 실행 역할을 사용합니다.

## 현재 범위

- 노트북 웹캠 1대
- 보호자 동시 시청 1명
- 720p / 15fps 목표
- 영상만 전송, 오디오 꺼짐
- AWS STUN/TURN 자동 적용
- 서버 측 로그인 및 기기 소유권 확인
- D1 영속 세션
- 원본 영상 녹화 없음

실제 펫 로봇으로 옮길 때는 웹 MASTER 대신 AWS KVS WebRTC C SDK를 사용하는 기기 프로세스로 교체합니다. 보호자 페이지와 D1 데이터 구조는 유지합니다.

## 검증

```bash
npm run lint
npm test
```
