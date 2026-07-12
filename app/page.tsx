"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectKvsMaster,
  connectKvsViewer,
  createLiveSession,
  endLiveSession,
  type KvsConnection,
  type KvsConnectionState,
} from "./lib/kvs-client";

type Mode = "landing" | "broadcaster" | "viewer";
type ConnectionState =
  | "idle"
  | "preparing"
  | "waiting"
  | "connecting"
  | "live"
  | "offline"
  | "error";

const VIDEO_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 15, max: 20 },
  },
  audio: false,
};

const STATE_COPY: Record<ConnectionState, string> = {
  idle: "준비 전",
  preparing: "카메라 준비 중",
  waiting: "보호자 대기 중",
  connecting: "AWS 연결 중",
  live: "실시간 연결됨",
  offline: "연결 끊김",
  error: "연결 오류",
};

function normalizeRoomCode(value: string) {
  return value.replace(/[^A-HJ-NP-Z2-9]/gi, "").slice(0, 6).toUpperCase();
}

function viewerUrl(roomCode: string) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("role", "viewer");
  url.searchParams.set("room", roomCode);
  return url.toString();
}

function StatusBadge({ state }: { state: ConnectionState }) {
  return (
    <span className={`status-badge status-${state}`} data-testid="connection-status">
      <span className="status-dot" aria-hidden="true" />
      {STATE_COPY[state]}
    </span>
  );
}

function Broadcaster({ roomCode, onExit }: { roomCode: string; onExit: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const connectionRef = useRef<KvsConnection | null>(null);
  const startRequestRef = useRef(0);
  const startPendingRef = useRef(false);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [isBroadcasting, setIsBroadcasting] = useState(false);

  const updateKvsState = useCallback((next: KvsConnectionState) => {
    setState(next);
  }, []);

  const connectMaster = useCallback(
    async (stream: MediaStream) => {
      connectionRef.current?.close();
      connectionRef.current = null;
      setError("");
      setState("connecting");
      const connection = await connectKvsMaster({
        roomCode,
        stream,
        callbacks: {
          onState: updateKvsState,
          onError: (reason) => {
            setError(reason.message || "AWS KVS 연결에 실패했습니다.");
            setState("error");
          },
        },
      });
      connectionRef.current = connection;
    },
    [roomCode, updateKvsState],
  );

  const stopBroadcast = useCallback(
    (notifyServer = true, updateState = true) => {
      startRequestRef.current += 1;
      startPendingRef.current = false;
      connectionRef.current?.close();
      connectionRef.current = null;
      const stream = streamRef.current;
      streamRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      if (notifyServer) void endLiveSession(roomCode);
      if (updateState) {
        setIsBroadcasting(false);
        setState("idle");
      }
    },
    [roomCode],
  );

  useEffect(() => () => stopBroadcast(false, false), [stopBroadcast]);

  const startBroadcast = async () => {
    if (startPendingRef.current || isBroadcasting) return;
    startPendingRef.current = true;
    const requestId = startRequestRef.current + 1;
    startRequestRef.current = requestId;
    setError("");
    setState("preparing");

    if (!navigator.mediaDevices?.getUserMedia) {
      startPendingRef.current = false;
      setError("이 브라우저는 카메라 접근을 지원하지 않습니다.");
      setState("error");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
      if (requestId !== startRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setIsBroadcasting(true);

      const videoTrack = stream.getVideoTracks()[0];
      videoTrack?.addEventListener(
        "ended",
        () => {
          if (streamRef.current !== stream) return;
          stopBroadcast();
          setError("카메라 입력이 종료되었습니다. 장치를 확인한 뒤 다시 시작해 주세요.");
          setState("error");
        },
        { once: true },
      );

      await connectMaster(stream);
    } catch (reason) {
      if (requestId !== startRequestRef.current) return;
      const fallback = "카메라 권한과 AWS 연결 상태를 확인한 뒤 다시 시도해 주세요.";
      stopBroadcast(false);
      setError(reason instanceof Error && reason.name !== "NotAllowedError" ? reason.message : fallback);
      setState("error");
    } finally {
      if (requestId === startRequestRef.current) startPendingRef.current = false;
    }
  };

  const reconnect = async () => {
    const stream = streamRef.current;
    if (!stream) return;
    try {
      await connectMaster(stream);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AWS KVS에 다시 연결하지 못했습니다.");
      setState("error");
    }
  };

  const copyViewerLink = async () => {
    await navigator.clipboard.writeText(viewerUrl(roomCode));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <main className="app-shell">
      <Header />
      <section className="session-heading">
        <div>
          <span className="eyebrow">CAMERA NODE · AWS MASTER</span>
          <h1>노트북 카메라 송출</h1>
          <p>카메라 영상을 서울 리전 KVS WebRTC 채널로 전송하고 보호자 연결을 기다립니다.</p>
        </div>
        <StatusBadge state={state} />
      </section>

      <section className="workspace-grid">
        <div className="video-panel">
          <div className="video-toolbar">
            <span>로봇 시점 미리보기</span>
            <span className="quality-label">720P TARGET · 15 FPS</span>
          </div>
          <div className="video-frame">
            <video ref={videoRef} autoPlay playsInline muted className="local-video" />
            {!isBroadcasting && (
              <div className="video-placeholder">
                <div className="lens" aria-hidden="true"><span /></div>
                <strong>카메라가 아직 꺼져 있어요</strong>
                <span>브라우저 권한을 허용하면 이곳에 미리보기가 나타납니다.</span>
              </div>
            )}
            {state === "live" && <span className="live-corner">LIVE</span>}
          </div>
          {error && <p className="error-message" role="alert">{error}</p>}
          <div className="button-row">
            {!isBroadcasting ? (
              <button
                className="button primary"
                onClick={startBroadcast}
                disabled={state === "preparing"}
                data-testid="start-camera"
              >
                {state === "preparing" ? "카메라 연결 중" : "카메라 켜기"}
              </button>
            ) : (
              <button className="button danger" onClick={() => stopBroadcast()}>
                송출 종료
              </button>
            )}
            {isBroadcasting && ["offline", "error"].includes(state) && (
              <button className="button secondary" onClick={reconnect}>AWS 다시 연결</button>
            )}
            <button
              className="button secondary"
              onClick={() => window.open(viewerUrl(roomCode), "_blank", "noopener,noreferrer")}
              disabled={!isBroadcasting}
            >
              보호자 화면 열기
            </button>
          </div>
        </div>

        <aside className="control-panel">
          <div className="panel-card room-card">
            <span className="card-label">활성 세션 코드</span>
            <strong className="room-code" data-testid="room-code">{roomCode}</strong>
            <p>코드는 세션을 찾는 값이며 권한 수단이 아닙니다. 로그인과 기기 소유권을 서버에서 확인합니다.</p>
            <button className="text-button" onClick={copyViewerLink}>
              {copied ? "링크를 복사했어요" : "보호자 링크 복사"}
            </button>
          </div>

          <div className="panel-card checklist-card">
            <span className="card-label">연결 상태</span>
            <ul>
              <li className={isBroadcasting ? "done" : ""}>브라우저 카메라 권한</li>
              <li className={["waiting", "connecting", "live"].includes(state) ? "done" : ""}>AWS KVS 시그널링</li>
              <li className={state === "live" ? "done" : ""}>보호자 영상 Track</li>
              <li>원본 영상 저장 안 함</li>
            </ul>
          </div>

          <button
            className="back-button"
            onClick={() => {
              stopBroadcast();
              onExit();
            }}
          >
            역할 선택으로 돌아가기
          </button>
        </aside>
      </section>
    </main>
  );
}

function Viewer({ roomCode, onExit }: { roomCode: string; onExit: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const connectionRef = useRef<KvsConnection | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const videoElement = videoRef.current;
    let remoteStream: MediaStream | null = null;

    connectKvsViewer({
      roomCode,
      onStream: (stream) => {
        if (!active || !videoElement) return;
        remoteStream = stream;
        videoElement.srcObject = stream;
        stream.getVideoTracks()[0]?.addEventListener(
          "ended",
          () => {
            if (videoElement.srcObject === stream) videoElement.srcObject = null;
            if (active) setState("offline");
          },
          { once: true },
        );
      },
      callbacks: {
        onState: (next) => {
          if (!active) return;
          if (next === "offline" && videoElement) videoElement.srcObject = null;
          if (next === "live" && videoElement && remoteStream) videoElement.srcObject = remoteStream;
          setState(next);
        },
        onError: (reason) => {
          if (!active) return;
          setError(reason.message || "AWS KVS 연결에 실패했습니다.");
          setState("error");
        },
      },
    })
      .then((connection) => {
        if (!active) connection.close();
        else connectionRef.current = connection;
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "보호자 화면에 연결하지 못했습니다.");
        setState("error");
      });

    return () => {
      active = false;
      connectionRef.current?.close();
      connectionRef.current = null;
      if (videoElement) videoElement.srcObject = null;
      remoteStream?.getTracks().forEach((track) => track.stop());
    };
  }, [attempt, roomCode]);

  return (
    <main className="app-shell viewer-shell">
      <Header />
      <section className="session-heading">
        <div>
          <span className="eyebrow">GUARDIAN VIEW · AWS VIEWER</span>
          <h1>보호자 실시간 보기</h1>
          <p>세션 <strong>{roomCode}</strong>의 KVS WebRTC 영상 신호를 기다리고 있습니다.</p>
        </div>
        <StatusBadge state={state} />
      </section>

      <section className="guardian-stage">
        <div className="video-panel guardian-video-panel">
          <div className="video-toolbar">
            <span>펫 로봇 카메라</span>
            <span className="quality-label">AWS KVS · PRIVATE</span>
          </div>
          <div className="video-frame guardian-frame">
            <video ref={videoRef} autoPlay playsInline data-testid="guardian-video" />
            {state !== "live" && (
              <div className="video-placeholder">
                <div className="signal-rings" aria-hidden="true"><span /></div>
                <strong>{state === "offline" ? "카메라 연결이 끊겼어요" : "카메라 신호를 기다리고 있어요"}</strong>
                <span>송출 노트북이 AWS 채널에 연결되면 영상이 자동으로 나타납니다.</span>
              </div>
            )}
            {state === "live" && <span className="live-corner">LIVE</span>}
          </div>
          {error && <p className="error-message" role="alert">{error}</p>}
          <div className="viewer-actions">
            <div className="privacy-note">
              <span className="privacy-dot" aria-hidden="true" />
              원본 영상은 녹화하거나 저장하지 않습니다.
            </div>
            <button
              className="button secondary compact"
              onClick={() => {
                setError("");
                setState("connecting");
                setAttempt((value) => value + 1);
              }}
            >
              다시 연결
            </button>
          </div>
        </div>

        <aside className="guardian-info">
          <div className="panel-card">
            <span className="card-label">세션 정보</span>
            <dl>
              <div><dt>세션 코드</dt><dd>{roomCode}</dd></div>
              <div><dt>오디오</dt><dd>꺼짐</dd></div>
              <div><dt>녹화</dt><dd>사용 안 함</dd></div>
              <div><dt>연결</dt><dd>AWS KVS WebRTC</dd></div>
            </dl>
          </div>
          <button className="back-button" onClick={onExit}>역할 선택으로 돌아가기</button>
        </aside>
      </section>
    </main>
  );
}

function Header() {
  return (
    <header className="site-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">P</span>
        <span><strong>PETCAM</strong><small>LIVE LAB</small></span>
      </div>
      <span className="prototype-chip">AWS KVS WEBRTC · PRIVATE ALPHA</span>
    </header>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("landing");
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const [landingError, setLandingError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedMode = params.get("role");
    const requestedRoom = normalizeRoomCode(params.get("room") ?? "");
    if (requestedMode === "viewer" && requestedRoom.length === 6) {
      window.queueMicrotask(() => {
        setRoomCode(requestedRoom);
        setJoinCode(requestedRoom);
        setMode("viewer");
      });
    }
  }, []);

  const reset = () => {
    window.history.replaceState({}, "", window.location.pathname);
    setMode("landing");
    setRoomCode("");
    setLandingError("");
  };

  if (mode === "broadcaster") return <Broadcaster roomCode={roomCode} onExit={reset} />;
  if (mode === "viewer") return <Viewer roomCode={roomCode} onExit={reset} />;

  const createBroadcast = async () => {
    if (creatingSession) return;
    setCreatingSession(true);
    setLandingError("");
    try {
      const session = await createLiveSession();
      setRoomCode(session.roomCode);
      setMode("broadcaster");
    } catch (reason) {
      setLandingError(reason instanceof Error ? reason.message : "세션을 만들지 못했습니다.");
    } finally {
      setCreatingSession(false);
    }
  };

  const joinBroadcast = () => {
    const code = normalizeRoomCode(joinCode);
    if (code.length !== 6) return;
    setRoomCode(code);
    setMode("viewer");
  };

  return (
    <main className="landing-shell">
      <Header />
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">SOFTWARE MAESTRO · AIoT PET</span>
          <h1>노트북 캠에서 시작해<br /><em>AWS로 실시간 연결</em>합니다.</h1>
          <p>
            Amazon Kinesis Video Streams WebRTC를 통해 다른 네트워크의 보호자 화면으로
            저지연 영상을 전송합니다. 사용자·기기·세션 관계는 서버에 영속 저장됩니다.
          </p>
          <div className="hero-meta">
            <span><strong>01</strong> 카메라 1대</span>
            <span><strong>02</strong> 보호자 1명</span>
            <span><strong>03</strong> 원본 저장 없음</span>
          </div>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="robot-eye"><span /></div>
          <span className="orbit-label top">AWS KVS</span>
          <span className="orbit-label bottom">GUARDIAN</span>
        </div>
      </section>

      <section className="role-section">
        <div className="section-heading">
          <span className="eyebrow">CHOOSE A ROLE</span>
          <h2>어느 화면을 열까요?</h2>
        </div>
        {landingError && <p className="error-message" role="alert">{landingError}</p>}
        <div className="role-grid">
          <article className="role-card broadcaster-card">
            <span className="role-number">01</span>
            <div>
              <span className="card-label">노트북 또는 로봇 쪽</span>
              <h3>카메라 송출자</h3>
              <p>영속 세션을 만들고 웹캠을 AWS KVS의 MASTER로 연결합니다.</p>
            </div>
            <button
              className="button primary"
              onClick={createBroadcast}
              disabled={creatingSession}
              data-testid="create-broadcast"
            >
              {creatingSession ? "세션 만드는 중" : "AWS 세션 만들기"}
            </button>
          </article>

          <article className="role-card viewer-card">
            <span className="role-number">02</span>
            <div>
              <span className="card-label">보호자 쪽</span>
              <h3>실시간 시청자</h3>
              <p>로그인 후 활성 세션 코드를 입력해 허가된 펫 카메라를 확인합니다.</p>
            </div>
            <div className="join-row">
              <label>
                <span className="sr-only">세션 코드</span>
                <input
                  value={joinCode}
                  onChange={(event) => setJoinCode(normalizeRoomCode(event.target.value))}
                  onKeyDown={(event) => event.key === "Enter" && joinBroadcast()}
                  placeholder="6자리 코드"
                  aria-label="세션 코드"
                  maxLength={6}
                />
              </label>
              <button className="button dark" onClick={joinBroadcast} disabled={joinCode.length !== 6}>
                입장
              </button>
            </div>
          </article>
        </div>
      </section>

      <footer className="site-footer">
        <span>PRIVATE ALPHA 01</span>
        <p>AWS KVS WebRTC · 서버 측 권한 검사 · D1 영속 세션 · 영상 녹화 비활성화</p>
      </footer>
    </main>
  );
}
