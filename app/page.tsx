"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  HomecamDashboard,
  type HomecamDevice,
} from "./components/homecam-dashboard";
import {
  connectAuthorizedDeviceViewer,
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
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
};

const VIEWER_AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  video: false,
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
};

type Recording = {
  id: string;
  segment: number;
  deviceId: string;
  displayName: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
};

type RecordingPlaybackState = "loading" | "ready" | "autoplay-blocked" | "error";

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

function normalizeViewerPassword(value: string) {
  const raw = value.replace(/[^A-HJ-NP-Z2-9]/gi, "").slice(0, 16).toUpperCase();
  return raw.match(/.{1,4}/g)?.join("-") ?? raw;
}

function isCompleteViewerPassword(value: string) {
  return value.replace(/-/g, "").length === 16;
}

function viewerUrl(roomCode: string) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("role", "viewer");
  url.searchParams.set("room", roomCode);
  return url.toString();
}

function formatRecordingTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function markRecordingStarted(roomCode: string, shouldContinue: () => boolean) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!shouldContinue()) return false;
    if (attempt > 0) {
      await new Promise((resolve) =>
        window.setTimeout(resolve, attempt < 3 ? 2_000 : 30_000),
      );
      if (!shouldContinue()) return false;
    }

    const response = await fetch("/api/recordings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomCode }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (response?.ok) return true;
    if (response && response.status < 500 && response.status !== 429) {
      return false;
    }
  }
  return false;
}

function StatusBadge({ state }: { state: ConnectionState }) {
  return (
    <span className={`status-badge status-${state}`} data-testid="connection-status">
      <span className="status-dot" aria-hidden="true" />
      {STATE_COPY[state]}
    </span>
  );
}

function RecordingPlayer({ recording, onClose }: { recording: Recording; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackRequestRef = useRef(0);
  const [playbackState, setPlaybackState] = useState<RecordingPlaybackState>("loading");
  const [error, setError] = useState("");

  const playRecording = useCallback(async (requestId = playbackRequestRef.current) => {
    const video = videoRef.current;
    if (!video || requestId !== playbackRequestRef.current) return;

    try {
      await video.play();
      if (requestId !== playbackRequestRef.current) return;
      setError("");
      setPlaybackState("ready");
    } catch (reason) {
      if (requestId !== playbackRequestRef.current) return;
      if (reason instanceof Error && reason.name === "AbortError") return;
      if (reason instanceof Error && reason.name === "NotAllowedError") {
        setPlaybackState("autoplay-blocked");
        return;
      }
      playbackRequestRef.current += 1;
      setError("녹화를 재생하지 못했습니다.");
      setPlaybackState("error");
    }
  }, []);

  useEffect(() => {
    const requestId = playbackRequestRef.current + 1;
    playbackRequestRef.current = requestId;
    const controller = new AbortController();
    const video = videoRef.current;
    let dispose: () => void = () => undefined;
    let loadTimer: number | undefined;

    if (!video) return () => controller.abort();

    const clearLoadTimer = () => {
      if (loadTimer === undefined) return;
      window.clearTimeout(loadTimer);
      loadTimer = undefined;
    };
    const fail = (message: string) => {
      if (requestId !== playbackRequestRef.current) return;
      playbackRequestRef.current += 1;
      clearLoadTimer();
      setError(message);
      setPlaybackState("error");
    };
    const armLoadTimer = () => {
      clearLoadTimer();
      loadTimer = window.setTimeout(() => {
        fail("녹화 영상을 불러오는 데 시간이 오래 걸리고 있습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.");
      }, 20_000);
    };
    const markReady = () => {
      if (requestId !== playbackRequestRef.current) return;
      clearLoadTimer();
      setError("");
      setPlaybackState((current) => current === "autoplay-blocked" ? current : "ready");
    };
    const handleCanPlay = () => {
      markReady();
      void playRecording(requestId);
    };
    const handlePlaying = () => {
      if (requestId !== playbackRequestRef.current) return;
      clearLoadTimer();
      setError("");
      setPlaybackState("ready");
    };
    const handleWaiting = () => {
      if (requestId !== playbackRequestRef.current || video.paused) return;
      setPlaybackState("loading");
      armLoadTimer();
    };
    const handleMediaError = () => {
      fail("녹화 영상을 불러오지 못했거나 이 브라우저가 영상 형식을 지원하지 않습니다.");
    };

    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("stalled", handleWaiting);
    video.addEventListener("error", handleMediaError);
    setError("");
    setPlaybackState("loading");
    armLoadTimer();

    void (async () => {
      try {
        const response = await fetch(`/api/recordings/${encodeURIComponent(recording.id)}/playback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ segment: recording.segment }),
          signal: controller.signal,
        });
        const payload = (await response.json()) as { playbackUrl?: string; error?: string };
        if (!response.ok || !payload.playbackUrl) {
          throw new Error(payload.error ?? "녹화 재생 주소를 만들지 못했습니다.");
        }
        if (controller.signal.aborted) return;

        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = payload.playbackUrl;
          video.load();
        } else {
          const { default: Hls } = await import("hls.js");
          if (controller.signal.aborted) return;
          if (!Hls.isSupported()) throw new Error("이 브라우저는 HLS 녹화 재생을 지원하지 않습니다.");
          const player = new Hls({ enableWorker: true });
          player.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal || controller.signal.aborted) return;
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              fail("녹화 데이터를 불러오지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.");
              return;
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              fail("이 브라우저에서 녹화 영상 형식을 해석하지 못했습니다.");
              return;
            }
            fail("녹화 재생 중 오류가 발생했습니다.");
          });
          player.on(Hls.Events.MANIFEST_PARSED, () => {
            void playRecording(requestId);
          });
          player.loadSource(payload.playbackUrl);
          player.attachMedia(video);
          dispose = () => player.destroy();
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          fail(reason instanceof Error ? reason.message : "녹화를 재생하지 못했습니다.");
        }
      }
    })();

    return () => {
      controller.abort();
      if (requestId === playbackRequestRef.current) playbackRequestRef.current += 1;
      clearLoadTimer();
      video.removeEventListener("canplay", handleCanPlay);
      video.removeEventListener("playing", handlePlaying);
      video.removeEventListener("waiting", handleWaiting);
      video.removeEventListener("stalled", handleWaiting);
      video.removeEventListener("error", handleMediaError);
      dispose();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [playRecording, recording.id, recording.segment]);

  return (
    <div
      className="recording-player"
      role="region"
      aria-label="클라우드 녹화 재생"
      aria-busy={playbackState === "loading"}
    >
      <div className="recording-player-heading">
        <div>
          <span className="card-label">CLOUD PLAYBACK</span>
          <strong>{formatRecordingTime(recording.startedAt)} 녹화</strong>
        </div>
        <button className="text-button" onClick={onClose}>닫기</button>
      </div>
      <video ref={videoRef} controls playsInline data-testid="recording-video" />
      {playbackState === "loading" && (
        <p className="recording-playback-status" role="status">녹화 영상을 불러오는 중입니다…</p>
      )}
      {playbackState === "autoplay-blocked" && (
        <div className="recording-playback-action">
          <p>브라우저가 자동 재생을 막았습니다.</p>
          <button type="button" className="button secondary compact" onClick={() => void playRecording()}>
            재생하기
          </button>
        </div>
      )}
      {playbackState === "error" && error && <p className="error-message" role="alert">{error}</p>}
      <p className="recording-token-note">각 1시간 이하 구간마다 재생 시간과 여유 시간만큼 유효한 비공개 재생 세션을 새로 발급합니다.</p>
    </div>
  );
}

function RecordingArchive() {
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [selected, setSelected] = useState<Recording | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/recordings", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) return null;
        const payload = (await response.json()) as { recordings?: Recording[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "녹화 목록을 불러오지 못했습니다.");
        return payload.recordings ?? [];
      })
      .then((items) => {
        if (!controller.signal.aborted) setRecordings(items);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "녹화 목록을 불러오지 못했습니다.");
        }
      });
    return () => controller.abort();
  }, []);

  if (recordings === null && !error) return null;

  return (
    <section className="recordings-section" aria-labelledby="recordings-title">
      <div className="section-heading recordings-heading">
        <div>
          <span className="eyebrow">PRIVATE CLOUD ARCHIVE</span>
          <h2 id="recordings-title">지난 영상</h2>
        </div>
        <p>송출 권한이 있는 ID만 최근 7일 녹화를 볼 수 있습니다.</p>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      {recordings?.length === 0 && (
        <div className="recording-empty">아직 재생할 수 있는 녹화가 없습니다.</div>
      )}
      {recordings && recordings.length > 0 && (
        <div className="recording-list">
          {recordings.map((recording) => (
            <article className="recording-row" key={`${recording.id}:${recording.segment}`}>
              <div>
                <strong>{recording.displayName}</strong>
                <span>
                  {formatRecordingTime(recording.startedAt)}
                  {recording.endedAt ? ` · ${formatRecordingTime(recording.endedAt)} 종료` : " · 녹화 중"}
                  {recording.endedAt ? ` · 구간 ${recording.segment + 1}` : ""}
                </span>
              </div>
              <button
                className="button secondary compact"
                disabled={!recording.endedAt}
                onClick={() => setSelected(recording)}
              >
                {recording.endedAt ? "재생" : "LIVE"}
              </button>
            </article>
          ))}
        </div>
      )}
      {selected && <RecordingPlayer recording={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}

function Broadcaster({
  roomCode,
  viewerPassword,
  onExit,
}: {
  roomCode: string;
  viewerPassword: string;
  onExit: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const guardianAudioRef = useRef<HTMLAudioElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const connectionRef = useRef<KvsConnection | null>(null);
  const connectionRequestRef = useRef(0);
  const startRequestRef = useRef(0);
  const startPendingRef = useRef(false);
  const recordingMarkedRef = useRef(false);
  const storageModeRef = useRef(false);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [speakerBlocked, setSpeakerBlocked] = useState(false);
  const [storageMode, setStorageMode] = useState<boolean | null>(null);

  const updateKvsState = useCallback((next: KvsConnectionState) => {
    setState(next);
    if (next === "live" && storageModeRef.current && !recordingMarkedRef.current) {
      recordingMarkedRef.current = true;
      void markRecordingStarted(
        roomCode,
        () => Boolean(streamRef.current && storageModeRef.current),
      ).then((started) => {
        if (!streamRef.current || !storageModeRef.current) {
          recordingMarkedRef.current = false;
          return;
        }
        recordingMarkedRef.current = started;
        setRecordingActive(started);
      });
    }
  }, [roomCode]);

  const connectMaster = useCallback(
    async (stream: MediaStream) => {
      const connectionRequest = connectionRequestRef.current + 1;
      connectionRequestRef.current = connectionRequest;
      connectionRef.current?.close();
      connectionRef.current = null;
      setError("");
      setState("connecting");
      try {
        const connection = await connectKvsMaster({
          roomCode,
          stream,
          onRemoteStream: (remoteStream) => {
            if (
              connectionRequestRef.current !== connectionRequest ||
              streamRef.current !== stream
            ) {
              return;
            }
            const audio = guardianAudioRef.current;
            if (!audio) return;
            audio.srcObject = remoteStream;
            void audio.play().catch(() => setSpeakerBlocked(true));
          },
          callbacks: {
            onState: (next) => {
              if (
                connectionRequestRef.current === connectionRequest &&
                streamRef.current === stream
              ) {
                updateKvsState(next);
              }
            },
            onError: (reason) => {
              if (
                connectionRequestRef.current !== connectionRequest ||
                streamRef.current !== stream
              ) {
                return;
              }
              setError(reason.message || "AWS KVS 연결에 실패했습니다.");
              setState("error");
            },
          },
        });
        if (
          connectionRequestRef.current !== connectionRequest ||
          streamRef.current !== stream
        ) {
          connection.close();
          return;
        }
        storageModeRef.current = connection.storageMode;
        setStorageMode(connection.storageMode);
        connectionRef.current = connection;
      } catch (reason) {
        if (
          connectionRequestRef.current === connectionRequest &&
          streamRef.current === stream
        ) {
          throw reason;
        }
      }
    },
    [roomCode, updateKvsState],
  );

  const stopBroadcast = useCallback(
    (notifyServer = true, updateState = true) => {
      startRequestRef.current += 1;
      connectionRequestRef.current += 1;
      startPendingRef.current = false;
      connectionRef.current?.close();
      connectionRef.current = null;
      recordingMarkedRef.current = false;
      storageModeRef.current = false;
      const stream = streamRef.current;
      streamRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      if (guardianAudioRef.current) guardianAudioRef.current.srcObject = null;
      if (notifyServer) void endLiveSession(roomCode);
      if (updateState) {
        setIsBroadcasting(false);
        setRecordingActive(false);
        setSpeakerBlocked(false);
        setStorageMode(null);
        setState("idle");
      }
    },
    [roomCode],
  );

  useEffect(() => () => stopBroadcast(false, false), [stopBroadcast]);

  useEffect(() => {
    const handlePageHide = () => {
      if (streamRef.current) void endLiveSession(roomCode);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [roomCode]);

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

      stream.getTracks().forEach((track) => {
        track.addEventListener(
          "ended",
          () => {
            if (streamRef.current !== stream) return;
            stopBroadcast();
            setError("카메라 또는 마이크 입력이 종료되었습니다. 장치를 확인해 주세요.");
            setState("error");
          },
          { once: true },
        );
      });

      await connectMaster(stream);
    } catch (reason) {
      if (requestId !== startRequestRef.current) return;
      const fallback = "카메라·마이크 권한과 AWS 연결 상태를 확인한 뒤 다시 시도해 주세요.";
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

  const toggleGuardianSpeaker = async () => {
    const audio = guardianAudioRef.current;
    if (!audio) return;
    const nextMuted = speakerBlocked ? false : !speakerMuted;
    audio.muted = nextMuted;
    setSpeakerMuted(nextMuted);
    if (!nextMuted) {
      try {
        await audio.play();
        setSpeakerBlocked(false);
      } catch {
        setSpeakerBlocked(true);
      }
    }
  };

  const copyViewerInvite = async () => {
    await navigator.clipboard.writeText(
      `${viewerUrl(roomCode)}\n세션 코드: ${roomCode}\n시청 비밀번호: ${viewerPassword}`,
    );
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
          <p>영상과 로봇 쪽 음성을 서울 리전으로 전송하고, 연결된 보호자 음성을 실시간으로 받습니다.</p>
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
            <audio ref={guardianAudioRef} autoPlay muted={speakerMuted} />
            {!isBroadcasting && (
              <div className="video-placeholder">
                <div className="lens" aria-hidden="true"><span /></div>
                <strong>카메라가 아직 꺼져 있어요</strong>
                <span>브라우저 권한을 허용하면 이곳에 미리보기가 나타납니다.</span>
              </div>
            )}
            {state === "live" && <span className="live-corner">{recordingActive ? "REC · LIVE" : "LIVE"}</span>}
          </div>
          <p className="recording-notice">
            {storageMode === false
              ? "현재 P2P 폴백 모드에서는 실시간 영상만 전송하며 녹화하지 않습니다."
              : "송출이 연결되면 영상과 양방향 음성이 AWS에 자동 녹화되며 7일 뒤 삭제됩니다."}
          </p>
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
            {isBroadcasting && (
              <button className="button secondary" onClick={toggleGuardianSpeaker}>
                {speakerBlocked ? "보호자 소리 재생" : `보호자 소리 ${speakerMuted ? "켜기" : "끄기"}`}
              </button>
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
            <span className="card-label">보호자 접속 정보</span>
            <strong className="room-code" data-testid="room-code">{roomCode}</strong>
            <span className="password-label">시청 비밀번호</span>
            <strong className="viewer-password" data-testid="viewer-password">
              {viewerPassword}
            </strong>
            <p>링크에는 코드만 포함됩니다. 보호자는 ID 로그인 후 코드와 비밀번호를 모두 입력해야 합니다.</p>
            <button className="text-button" onClick={copyViewerInvite}>
              {copied ? "초대 정보를 복사했어요" : "보호자 초대 정보 복사"}
            </button>
          </div>

          <div className="panel-card checklist-card">
            <span className="card-label">연결 상태</span>
            <ul>
              <li className={isBroadcasting ? "done" : ""}>브라우저 카메라 권한</li>
              <li className={isBroadcasting ? "done" : ""}>로봇 마이크 권한</li>
              <li className={["waiting", "connecting", "live"].includes(state) ? "done" : ""}>AWS KVS 시그널링</li>
              <li className={state === "live" ? "done" : ""}>보호자 영상·음성 연결</li>
              <li className={recordingActive ? "done" : ""}>
                {storageMode === false ? "P2P 폴백 · 녹화 안 함" : "클라우드 녹화 · 7일 보관"}
              </li>
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

function Viewer({
  roomCode,
  viewerPassword,
  deviceId,
  device,
  onExit,
}: {
  roomCode: string;
  viewerPassword: string;
  deviceId?: string;
  device?: HomecamDevice;
  onExit: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const connectionRef = useRef<KvsConnection | null>(null);
  const viewerClientIdRef = useRef("");
  const viewerMountedRef = useRef(true);
  const talkIntentRef = useRef(false);
  const talkLeaseRef = useRef("");
  const talkLeaseTimerRef = useRef<number | null>(null);
  const storageModeRef = useRef<boolean | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [microphoneAvailable, setMicrophoneAvailable] = useState(false);
  const [microphonePending, setMicrophonePending] = useState(false);
  const [microphoneNotice, setMicrophoneNotice] = useState(
    "영상은 바로 연결하고, 말하기를 누를 때만 보호자 마이크 권한을 요청합니다.",
  );
  const [talking, setTalking] = useState(false);
  const [talkLeasePending, setTalkLeasePending] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(true);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [storageMode, setStorageMode] = useState<boolean | null>(null);

  const releaseTalkLease = useCallback((notifyServer = true, updateState = true) => {
    talkIntentRef.current = false;
    const track = microphoneRef.current?.getAudioTracks()[0];
    if (track) track.enabled = false;
    if (talkLeaseTimerRef.current !== null) {
      window.clearTimeout(talkLeaseTimerRef.current);
      talkLeaseTimerRef.current = null;
    }
    const leaseId = talkLeaseRef.current;
    talkLeaseRef.current = "";
    if (notifyServer && deviceId && leaseId) {
      void fetch(`/api/devices/${encodeURIComponent(deviceId)}/talk-lease`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          leaseId,
          clientId: viewerClientIdRef.current,
        }),
        keepalive: true,
      }).catch(() => undefined);
    }
    if (updateState && viewerMountedRef.current) {
      setTalking(false);
      setTalkLeasePending(false);
    }
  }, [deviceId]);

  useEffect(() => {
    viewerMountedRef.current = true;
    return () => {
      viewerMountedRef.current = false;
      releaseTalkLease(true, false);
      microphoneRef.current?.getTracks().forEach((track) => track.stop());
      microphoneRef.current = null;
    };
  }, [releaseTalkLease]);

  useEffect(() => {
    const handleRelease = () => releaseTalkLease();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") releaseTalkLease();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleRelease);
    window.addEventListener("pagehide", handleRelease);
    window.addEventListener("pointerup", handleRelease);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleRelease);
      window.removeEventListener("pagehide", handleRelease);
      window.removeEventListener("pointerup", handleRelease);
    };
  }, [releaseTalkLease]);

  useEffect(() => {
    if (!deviceId) return;
    let active = true;
    const verifyAccess = async () => {
      try {
        const response = await fetch(
          `/api/devices/${encodeURIComponent(deviceId)}/live-session`,
          { cache: "no-store" },
        );
        if (!active || (response.status !== 401 && response.status !== 403)) {
          return;
        }
        releaseTalkLease();
        connectionRef.current?.close();
        connectionRef.current = null;
        microphoneRef.current?.getTracks().forEach((track) => track.stop());
        microphoneRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setState("offline");
        setError("홈캠 접근 권한이 해제되었습니다.");
      } catch {
        // Ignore transient access-check failures while healthy media is live.
      }
    };
    window.queueMicrotask(() => void verifyAccess());
    const interval = window.setInterval(() => void verifyAccess(), 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [deviceId, releaseTalkLease]);

  useEffect(() => {
    let active = true;
    const videoElement = videoRef.current;
    let remoteStream: MediaStream | null = null;
    let localConnection: KvsConnection | null = null;
    let observedVideoTrack: MediaStreamTrack | null = null;
    let transportLive = false;
    let mediaReady = false;
    const localAudioStream = microphoneRef.current ?? undefined;
    localAudioStream?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    // P2P reconnects use a fresh identity so the master cannot confuse the
    // new offer with a retiring peer. AWS Storage Session reconnects must
    // retain the same client ID while the service keeps its viewer quota.
    if (storageModeRef.current !== true || !viewerClientIdRef.current) {
      viewerClientIdRef.current = `petcam-${crypto.randomUUID()}`;
    }

    const markVideoReady = () => {
      if (
        !videoElement ||
        !observedVideoTrack ||
        observedVideoTrack.readyState !== "live" ||
        observedVideoTrack.muted ||
        videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        return;
      }
      mediaReady = true;
      if (active && transportLive) {
        setError("");
        setState("live");
      }
    };
    videoElement?.addEventListener("loadeddata", markVideoReady);

    void (async () => {
      try {
        const connectionInput = {
          clientId: viewerClientIdRef.current,
          localAudioStream,
          onStream: (stream: MediaStream) => {
            if (!active || !videoElement) return;
            remoteStream = stream;
            videoElement.srcObject = stream;
            void videoElement.play().catch(async () => {
              if (!active) return;
              videoElement.muted = true;
              setSpeakerMuted(true);
              try {
                await videoElement.play();
                if (active) setSoundBlocked(false);
              } catch {
                if (active) setSoundBlocked(true);
              }
            });

            const videoTrack = stream.getVideoTracks()[0];
            if (videoTrack && observedVideoTrack !== videoTrack) {
              observedVideoTrack = videoTrack;
              mediaReady = false;
              videoTrack.addEventListener("unmute", markVideoReady);
              markVideoReady();
              videoTrack.addEventListener("mute", () => {
                mediaReady = false;
                if (active && transportLive) {
                  releaseTalkLease();
                  setState("connecting");
                }
              });
              videoTrack.addEventListener(
                "ended",
                () => {
                  mediaReady = false;
                  transportLive = false;
                  if (videoElement.srcObject === stream) videoElement.srcObject = null;
                  if (active) {
                    releaseTalkLease();
                    setState("offline");
                  }
                },
                { once: true },
              );
            }
          },
          callbacks: {
            onState: (next: KvsConnectionState) => {
              if (!active) return;
              if (next === "live") {
                transportLive = true;
                if (videoElement && remoteStream) videoElement.srcObject = remoteStream;
                setState(mediaReady ? "live" : "connecting");
                return;
              }
              transportLive = false;
              mediaReady = false;
              if (next === "offline" && videoElement) videoElement.srcObject = null;
              releaseTalkLease();
              setState(next);
            },
            onError: (reason: Error) => {
              if (!active) return;
              transportLive = false;
              mediaReady = false;
              releaseTalkLease();
              setError(reason.message || "AWS KVS 연결에 실패했습니다.");
              setState("error");
            },
          },
        };
        const connection = deviceId
          ? await connectAuthorizedDeviceViewer({
              deviceId,
              ...connectionInput,
            })
          : await connectKvsViewer({
              roomCode,
              viewerPassword,
              ...connectionInput,
            });
        localConnection = connection;
        if (!active) {
          connection.close();
        } else {
          setStorageMode(connection.storageMode);
          storageModeRef.current = connection.storageMode;
          if (localAudioStream) {
            setMicrophoneNotice("마이크가 연결되었습니다. 말하기 버튼을 누르는 동안만 전송됩니다.");
          } else if (!connection.storageMode) {
            setMicrophoneNotice("P2P 실시간 보기입니다. 말하기를 누를 때만 보호자 마이크를 연결합니다.");
          }
          connectionRef.current = connection;
        }
      } catch (reason) {
        if (!active) return;
        releaseTalkLease();
        setError(reason instanceof Error ? reason.message : "보호자 화면에 연결하지 못했습니다.");
        setState("error");
      }
    })();

    return () => {
      active = false;
      releaseTalkLease(true, false);
      localAudioStream?.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      localConnection?.close();
      if (connectionRef.current === localConnection) connectionRef.current = null;
      if (videoElement) {
        videoElement.removeEventListener("loadeddata", markVideoReady);
        videoElement.srcObject = null;
      }
      remoteStream?.getTracks().forEach((track) => track.stop());
    };
  }, [attempt, deviceId, releaseTalkLease, roomCode, viewerPassword]);

  const prepareMicrophone = async () => {
    if (microphonePending || state !== "live") return;
    setMicrophonePending(true);
    setMicrophoneNotice("");

    try {
      let stream = microphoneRef.current;
      if (!stream) {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("이 브라우저는 마이크 접근을 지원하지 않습니다.");
        }
        stream = await navigator.mediaDevices.getUserMedia(VIEWER_AUDIO_CONSTRAINTS);
      }
      if (!viewerMountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error("사용할 수 있는 마이크를 찾지 못했습니다.");
      track.enabled = false;
      microphoneRef.current = stream;
      setMicrophoneAvailable(true);
      setTalking(false);
      setError("");
      setState("connecting");
      setStorageMode(null);
      setMicrophoneNotice("마이크를 연결하기 위해 AWS 세션을 다시 연결하고 있습니다.");
      setAttempt((value) => value + 1);
    } catch (reason) {
      if (viewerMountedRef.current) {
        setMicrophoneNotice(
          reason instanceof Error && reason.name !== "NotAllowedError"
            ? reason.message
            : "마이크 권한이 없어 보기 전용으로 유지합니다.",
        );
      }
    } finally {
      if (viewerMountedRef.current) setMicrophonePending(false);
    }
  };

  const startTalking = async () => {
    const track = microphoneRef.current?.getAudioTracks()[0];
    if (!track || state !== "live" || talkLeasePending || talking) return;
    talkIntentRef.current = true;

    if (deviceId) {
      setTalkLeasePending(true);
      try {
        const response = await fetch(
          `/api/devices/${encodeURIComponent(deviceId)}/talk-lease`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              clientId: viewerClientIdRef.current,
            }),
          },
        );
        const payload = (await response.json().catch(() => null)) as {
          lease?: { leaseId?: string; expiresAt?: string };
          error?: string;
        } | null;
        const leaseId = payload?.lease?.leaseId;
        if (!response.ok || !leaseId) {
          throw new Error(
            response.status === 409
              ? "다른 가족이 말하고 있어요. 잠시 후 다시 눌러 주세요."
              : payload?.error ?? "말하기 권한을 받지 못했습니다.",
          );
        }
        talkLeaseRef.current = leaseId;
        if (!talkIntentRef.current || !viewerMountedRef.current || state !== "live") {
          releaseTalkLease();
          return;
        }

        const renewLease = async () => {
          const currentLeaseId = talkLeaseRef.current;
          if (!currentLeaseId || !talkIntentRef.current || !viewerMountedRef.current) return;
          try {
            const renewal = await fetch(
              `/api/devices/${encodeURIComponent(deviceId)}/talk-lease`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  leaseId: currentLeaseId,
                  clientId: viewerClientIdRef.current,
                }),
              },
            );
            const renewalPayload = (await renewal.json().catch(() => null)) as {
              lease?: { leaseId?: string };
              error?: string;
            } | null;
            if (!renewal.ok || renewalPayload?.lease?.leaseId !== currentLeaseId) {
              throw new Error(renewalPayload?.error ?? "말하기 권한을 갱신하지 못했습니다.");
            }
            if (
              talkLeaseRef.current !== currentLeaseId ||
              !talkIntentRef.current ||
              !viewerMountedRef.current
            ) {
              return;
            }
            talkLeaseTimerRef.current = window.setTimeout(() => void renewLease(), 8_000);
          } catch (reason) {
            releaseTalkLease();
            setMicrophoneNotice(
              reason instanceof Error ? reason.message : "말하기 연결이 종료되었습니다.",
            );
          }
        };
        talkLeaseTimerRef.current = window.setTimeout(() => void renewLease(), 8_000);
      } catch (reason) {
        talkIntentRef.current = false;
        setTalkLeasePending(false);
        setMicrophoneNotice(
          reason instanceof Error ? reason.message : "말하기 권한을 받지 못했습니다.",
        );
        return;
      }
    }

    if (!talkIntentRef.current) {
      releaseTalkLease();
      return;
    }
    track.enabled = true;
    setTalkLeasePending(false);
    setMicrophoneNotice("");
    setTalking(true);
  };

  const toggleSpeaker = async () => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = soundBlocked ? false : !speakerMuted;
    video.muted = nextMuted;
    setSpeakerMuted(nextMuted);
    if (!nextMuted) {
      try {
        await video.play();
        setSoundBlocked(false);
      } catch {
        setSoundBlocked(true);
      }
    }
  };

  return (
    <main className="app-shell viewer-shell">
      <Header />
      <section className="session-heading">
        <div>
          <span className="eyebrow">GUARDIAN VIEW · AWS VIEWER</span>
          <h1>우리 집 실시간 보기</h1>
          <p>
            {deviceId
              ? "가족 계정으로 연결된 홈캠을 보고, 필요할 때 로봇에게 말할 수 있습니다."
              : <>세션 <strong>{roomCode}</strong>의 영상·음성을 보고, 필요할 때 로봇에게 말할 수 있습니다.</>}
          </p>
        </div>
        <StatusBadge state={state} />
      </section>

      <section className="guardian-stage">
        <div className="video-panel guardian-video-panel">
          <div className="video-toolbar">
            <span>우리 집 홈캠</span>
            <span className="quality-label">AWS KVS · PRIVATE</span>
          </div>
          <div className="video-frame guardian-frame">
            <video ref={videoRef} autoPlay playsInline muted={speakerMuted} data-testid="guardian-video" />
            <div className="homecam-viewer-state-row" aria-label="실시간 홈캠 상태">
              <span className={state === "live" ? "is-active" : ""}><i />LIVE</span>
              <span className={storageMode && state === "live" ? "is-active is-recording" : ""}><i />REC</span>
              <span className={state !== "offline" && (device?.cameraEnabled ?? true) ? "is-active" : ""}><i />CAM</span>
              <span className={(device?.microphoneEnabled ?? true) ? "is-active" : ""}><i />MIC</span>
            </div>
            {state !== "live" && (
              <div className="video-placeholder">
                <div className="signal-rings" aria-hidden="true"><span /></div>
                <strong>{state === "offline" ? "카메라 연결이 끊겼어요" : "카메라 신호를 기다리고 있어요"}</strong>
                <span>송출 노트북이 AWS 채널에 연결되면 영상이 자동으로 나타납니다.</span>
              </div>
            )}
            {state === "live" && (
              <span className="live-corner">{storageMode ? "REC · LIVE" : "LIVE"}</span>
            )}
          </div>
          {microphoneNotice && <p className="audio-notice">{microphoneNotice}</p>}
          {error && <p className="error-message" role="alert">{error}</p>}
          <div className="viewer-actions">
            <div className="privacy-note">
              <span className="privacy-dot" aria-hidden="true" />
              {storageMode === false
                ? "현재 P2P 폴백 모드에서는 영상을 저장하지 않습니다."
                : "이 세션의 영상과 양방향 음성은 AWS에 7일간 저장됩니다."}
            </div>
            <div className="viewer-control-row">
              <button
                className={`button compact ${talking ? "talking" : "secondary"}`}
                disabled={microphonePending || talkLeasePending || state !== "live"}
                onClick={() => {
                  if (!microphoneAvailable) void prepareMicrophone();
                }}
                onPointerDown={(event) => {
                  if (!microphoneAvailable) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  void startTalking();
                }}
                onPointerUp={() => releaseTalkLease()}
                onPointerCancel={() => releaseTalkLease()}
                onPointerLeave={() => releaseTalkLease()}
                onBlur={() => releaseTalkLease()}
                onKeyDown={(event) => {
                  if (
                    microphoneAvailable &&
                    !event.repeat &&
                    (event.key === " " || event.key === "Enter")
                  ) {
                    event.preventDefault();
                    void startTalking();
                  }
                }}
                onKeyUp={(event) => {
                  if (event.key === " " || event.key === "Enter") {
                    event.preventDefault();
                    releaseTalkLease();
                  }
                }}
                aria-pressed={talking}
              >
                {microphonePending
                  ? "마이크 권한 확인 중"
                  : talkLeasePending
                    ? "말하기 권한 확인 중"
                  : !microphoneAvailable
                    ? "마이크 연결"
                    : talking
                      ? "말하는 중 · 손을 떼면 음소거"
                      : "눌러서 말하기"}
              </button>
              <button className="button secondary compact" onClick={toggleSpeaker}>
                {soundBlocked ? "소리 재생" : `로봇 소리 ${speakerMuted ? "켜기" : "끄기"}`}
              </button>
              <button
                className="button secondary compact"
                disabled={state === "connecting" || microphonePending}
                onClick={() => {
                  releaseTalkLease();
                  setError("");
                  setState("connecting");
                  setSoundBlocked(false);
                  setStorageMode(null);
                  setAttempt((value) => value + 1);
                }}
              >
                다시 연결
              </button>
            </div>
          </div>
        </div>

        <aside className="guardian-info">
          <div className="panel-card">
            <span className="card-label">세션 정보</span>
            <dl>
              <div><dt>{deviceId ? "홈캠" : "세션 코드"}</dt><dd>{device?.displayName ?? (deviceId ? "등록된 기기" : roomCode)}</dd></div>
              <div><dt>접근 확인</dt><dd>{deviceId ? "소유자·가족 계정" : "코드 + 비밀번호"}</dd></div>
              <div><dt>내 마이크</dt><dd>{!microphoneAvailable ? "미연결" : talking ? "전송 중" : "기본 음소거"}</dd></div>
              <div><dt>녹화</dt><dd>{storageMode === false ? "사용 안 함" : "7일 보관"}</dd></div>
              <div><dt>연결</dt><dd>AWS KVS WebRTC</dd></div>
            </dl>
          </div>
          <button className="back-button" onClick={onExit}>{deviceId ? "홈캠 홈으로 돌아가기" : "역할 선택으로 돌아가기"}</button>
        </aside>
      </section>
    </main>
  );
}

function Header() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/api/auth/me", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const payload = (await response.json()) as { authenticated?: boolean };
        return payload.authenticated === true;
      })
      .then((isAuthenticated) => {
        if (!controller.signal.aborted) setAuthenticated(isAuthenticated);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAuthenticated(false);
      });

    return () => controller.abort();
  }, []);

  return (
    <header className="site-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">P</span>
        <span><strong>PETCAM</strong><small>LIVE LAB</small></span>
      </div>
      <div className="header-actions">
        <span className="prototype-chip">AWS KVS WEBRTC · PRIVATE ALPHA</span>
        {authenticated === null ? (
          <span className="login-link auth-loading" aria-live="polite">
            로그인 확인 중
          </span>
        ) : (
          <a
            className="login-link"
            href={
              authenticated
                ? "/signout-with-chatgpt?return_to=%2F"
                : "/signin-with-chatgpt?return_to=%2F"
            }
            onClick={(event) => {
              event.preventDefault();
              const returnTo = `${window.location.pathname}${window.location.search}`;
              const action = authenticated ? "signout" : "signin";
              window.location.assign(
                `/${action}-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`,
              );
            }}
            data-testid="auth-action"
          >
            {authenticated ? "로그아웃" : "ID 로그인"}
          </a>
        )}
      </div>
    </header>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("landing");
  const [roomCode, setRoomCode] = useState("");
  const [viewerPassword, setViewerPassword] = useState("");
  const [viewerDeviceId, setViewerDeviceId] = useState("");
  const [viewerDevice, setViewerDevice] = useState<HomecamDevice | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [landingError, setLandingError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedMode = params.get("role");
    const requestedRoom = normalizeRoomCode(params.get("room") ?? "");
    if (requestedMode === "viewer" && requestedRoom.length === 6) {
      window.history.replaceState({}, "", window.location.pathname);
      window.queueMicrotask(() => {
        setLandingError(
          `기존 세션 ${requestedRoom}의 시청 비밀번호를 ‘개발·이전 버전 연결’에서 입력해 주세요.`,
        );
      });
    }
  }, []);

  const reset = () => {
    window.history.replaceState({}, "", window.location.pathname);
    setMode("landing");
    setRoomCode("");
    setViewerPassword("");
    setViewerDeviceId("");
    setViewerDevice(null);
    setLandingError("");
  };

  if (mode === "broadcaster") {
    return <Broadcaster roomCode={roomCode} viewerPassword={viewerPassword} onExit={reset} />;
  }
  if (mode === "viewer") {
    return (
      <Viewer
        roomCode={roomCode}
        viewerPassword={viewerPassword}
        deviceId={viewerDeviceId || undefined}
        device={viewerDevice ?? undefined}
        onExit={reset}
      />
    );
  }

  const createBroadcast = async () => {
    if (creatingSession) return;
    setCreatingSession(true);
    setLandingError("");
    try {
      const session = await createLiveSession();
      setRoomCode(session.roomCode);
      setViewerPassword(session.viewerPassword);
      setMode("broadcaster");
    } catch (reason) {
      setLandingError(reason instanceof Error ? reason.message : "세션을 만들지 못했습니다.");
    } finally {
      setCreatingSession(false);
    }
  };

  const joinLegacyBroadcast = (legacyRoomCode: string, legacyPassword: string) => {
    const code = normalizeRoomCode(legacyRoomCode);
    const password = normalizeViewerPassword(legacyPassword);
    if (code.length !== 6 || !isCompleteViewerPassword(password)) return;
    setRoomCode(code);
    setViewerPassword(password);
    setViewerDeviceId("");
    setViewerDevice(null);
    setMode("viewer");
  };

  const openRegisteredDevice = async (device: HomecamDevice) => {
    setRoomCode(device.activeSession?.roomCode ?? "");
    // 등록된 소유자·가족은 공유 비밀번호가 아니라 로그인된 계정 권한으로 입장합니다.
    setViewerPassword("");
    setViewerDeviceId(device.id);
    setViewerDevice(device);
    setMode("viewer");
  };

  return (
    <HomecamDashboard
      onOpenLive={openRegisteredDevice}
      onCreateLegacyBroadcast={createBroadcast}
      onJoinLegacy={joinLegacyBroadcast}
      creatingLegacyBroadcast={creatingSession}
      externalError={landingError}
      legacyArchive={
        <>
          <p className="sr-only">
            이전 버전은 AWS로 실시간 연결하는 AWS 세션 만들기, 실시간 시청자,
            양방향 음성, 클라우드 7일 보관, 코드+비밀번호 시청 기능을 제공합니다.
          </p>
          <RecordingArchive />
        </>
      }
    />
  );
}
