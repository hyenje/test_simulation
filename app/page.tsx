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
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const video = videoRef.current;
    let dispose = () => undefined;

    if (!video) return () => controller.abort();

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
          dispose = () => {
            video.pause();
            video.removeAttribute("src");
            video.load();
          };
        } else {
          const { default: Hls } = await import("hls.js");
          if (controller.signal.aborted) return;
          if (!Hls.isSupported()) throw new Error("이 브라우저는 HLS 녹화 재생을 지원하지 않습니다.");
          const player = new Hls({ enableWorker: true });
          player.loadSource(payload.playbackUrl);
          player.attachMedia(video);
          dispose = () => player.destroy();
        }

        await video.play().catch(() => undefined);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "녹화를 재생하지 못했습니다.");
        }
      }
    })();

    return () => {
      controller.abort();
      dispose();
    };
  }, [recording.id, recording.segment]);

  return (
    <div className="recording-player" role="region" aria-label="클라우드 녹화 재생">
      <div className="recording-player-heading">
        <div>
          <span className="card-label">CLOUD PLAYBACK</span>
          <strong>{formatRecordingTime(recording.startedAt)} 녹화</strong>
        </div>
        <button className="text-button" onClick={onClose}>닫기</button>
      </div>
      <video ref={videoRef} controls playsInline data-testid="recording-video" />
      {error && <p className="error-message" role="alert">{error}</p>}
      <p className="recording-token-note">각 1시간 이하 구간마다 재생 시간과 여유 시간만큼 유효한 비공개 AWS 주소를 새로 발급합니다.</p>
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
  onExit,
}: {
  roomCode: string;
  viewerPassword: string;
  onExit: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const connectionRef = useRef<KvsConnection | null>(null);
  const viewerClientIdRef = useRef("");
  const viewerMountedRef = useRef(true);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [microphoneAvailable, setMicrophoneAvailable] = useState(false);
  const [microphonePending, setMicrophonePending] = useState(false);
  const [microphoneNotice, setMicrophoneNotice] = useState(
    "영상은 바로 연결하고, 말하기를 누를 때만 보호자 마이크 권한을 요청합니다.",
  );
  const [talking, setTalking] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(true);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [storageMode, setStorageMode] = useState<boolean | null>(null);

  const silenceMicrophone = useCallback(() => {
    const track = microphoneRef.current?.getAudioTracks()[0];
    if (track) track.enabled = false;
    setTalking(false);
  }, []);

  useEffect(() => {
    viewerMountedRef.current = true;
    return () => {
      viewerMountedRef.current = false;
      microphoneRef.current?.getTracks().forEach((track) => track.stop());
      microphoneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") silenceMicrophone();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", silenceMicrophone);
    window.addEventListener("pagehide", silenceMicrophone);
    window.addEventListener("pointerup", silenceMicrophone);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", silenceMicrophone);
      window.removeEventListener("pagehide", silenceMicrophone);
      window.removeEventListener("pointerup", silenceMicrophone);
    };
  }, [silenceMicrophone]);

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
    if (!viewerClientIdRef.current) {
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
        const connection = await connectKvsViewer({
          roomCode,
          viewerPassword,
          clientId: viewerClientIdRef.current,
          localAudioStream,
          onStream: (stream) => {
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
                  silenceMicrophone();
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
                    silenceMicrophone();
                    setState("offline");
                  }
                },
                { once: true },
              );
            }
          },
          callbacks: {
            onState: (next) => {
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
              silenceMicrophone();
              setState(next);
            },
            onError: (reason) => {
              if (!active) return;
              transportLive = false;
              mediaReady = false;
              silenceMicrophone();
              setError(reason.message || "AWS KVS 연결에 실패했습니다.");
              setState("error");
            },
          },
        });
        localConnection = connection;
        if (!active) {
          connection.close();
        } else {
          setStorageMode(connection.storageMode);
          if (!connection.storageMode) {
            if (localAudioStream) {
              localAudioStream.getTracks().forEach((track) => track.stop());
              if (microphoneRef.current === localAudioStream) microphoneRef.current = null;
              setMicrophoneAvailable(false);
            }
            setMicrophoneNotice("P2P 폴백 모드는 영상 시청만 지원합니다.");
          } else if (localAudioStream) {
            setMicrophoneNotice("마이크가 연결되었습니다. 말하기 버튼을 누르는 동안만 전송됩니다.");
          }
          connectionRef.current = connection;
        }
      } catch (reason) {
        if (!active) return;
        silenceMicrophone();
        setError(reason instanceof Error ? reason.message : "보호자 화면에 연결하지 못했습니다.");
        setState("error");
      }
    })();

    return () => {
      active = false;
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
  }, [attempt, roomCode, silenceMicrophone, viewerPassword]);

  const prepareMicrophone = async () => {
    if (microphonePending || state !== "live" || storageMode !== true) return;
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

  const startTalking = () => {
    const track = microphoneRef.current?.getAudioTracks()[0];
    if (!track || state !== "live" || storageMode !== true) return;
    track.enabled = true;
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
          <h1>보호자 실시간 보기</h1>
          <p>세션 <strong>{roomCode}</strong>의 영상·음성을 보고, 필요할 때 로봇에게 말할 수 있습니다.</p>
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
            <video ref={videoRef} autoPlay playsInline muted={speakerMuted} data-testid="guardian-video" />
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
                disabled={microphonePending || state !== "live" || storageMode !== true}
                onClick={() => {
                  if (!microphoneAvailable) void prepareMicrophone();
                }}
                onPointerDown={(event) => {
                  if (!microphoneAvailable) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  startTalking();
                }}
                onPointerUp={silenceMicrophone}
                onPointerCancel={silenceMicrophone}
                onPointerLeave={silenceMicrophone}
                onBlur={silenceMicrophone}
                onKeyDown={(event) => {
                  if (
                    microphoneAvailable &&
                    !event.repeat &&
                    (event.key === " " || event.key === "Enter")
                  ) {
                    event.preventDefault();
                    startTalking();
                  }
                }}
                onKeyUp={(event) => {
                  if (event.key === " " || event.key === "Enter") {
                    event.preventDefault();
                    silenceMicrophone();
                  }
                }}
                aria-pressed={talking}
              >
                {microphonePending
                  ? "마이크 권한 확인 중"
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
                  silenceMicrophone();
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
              <div><dt>세션 코드</dt><dd>{roomCode}</dd></div>
              <div><dt>접근 확인</dt><dd>코드 + 비밀번호</dd></div>
              <div><dt>내 마이크</dt><dd>{storageMode === false ? "P2P 미지원" : !microphoneAvailable ? "미연결" : talking ? "전송 중" : "기본 음소거"}</dd></div>
              <div><dt>녹화</dt><dd>{storageMode === false ? "사용 안 함" : "7일 보관"}</dd></div>
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
      <div className="header-actions">
        <span className="prototype-chip">AWS KVS WEBRTC · PRIVATE ALPHA</span>
        <a
          className="login-link"
          href="/signin-with-chatgpt?return_to=%2F"
          onClick={(event) => {
            event.preventDefault();
            const returnTo = `${window.location.pathname}${window.location.search}`;
            window.location.assign(
              `/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`,
            );
          }}
        >
          ID 로그인
        </a>
      </div>
    </header>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("landing");
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [viewerPassword, setViewerPassword] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const [landingError, setLandingError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedMode = params.get("role");
    const requestedRoom = normalizeRoomCode(params.get("room") ?? "");
    if (requestedMode === "viewer" && requestedRoom.length === 6) {
      window.queueMicrotask(() => {
        setJoinCode(requestedRoom);
      });
    }
  }, []);

  const reset = () => {
    window.history.replaceState({}, "", window.location.pathname);
    setMode("landing");
    setRoomCode("");
    setViewerPassword("");
    setJoinPassword("");
    setLandingError("");
  };

  if (mode === "broadcaster") {
    return <Broadcaster roomCode={roomCode} viewerPassword={viewerPassword} onExit={reset} />;
  }
  if (mode === "viewer") {
    return <Viewer roomCode={roomCode} viewerPassword={viewerPassword} onExit={reset} />;
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

  const joinBroadcast = () => {
    const code = normalizeRoomCode(joinCode);
    const password = normalizeViewerPassword(joinPassword);
    if (code.length !== 6 || !isCompleteViewerPassword(password)) return;
    setRoomCode(code);
    setViewerPassword(password);
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
            저지연 영상과 양방향 음성을 전송하고, 클라우드 녹화는 7일간 안전하게 보관합니다.
          </p>
          <div className="hero-meta">
            <span><strong>01</strong> 카메라 1대</span>
            <span><strong>02</strong> 양방향 음성</span>
            <span><strong>03</strong> 클라우드 7일 보관</span>
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
              <p>공개 권한을 받은 ID만 세션을 만들고, 실시간 송출·양방향 음성·클라우드 녹화를 시작합니다.</p>
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
              <p>ID 로그인 후 전달받은 세션 코드와 시청 비밀번호를 모두 입력합니다.</p>
            </div>
            <div className="join-fields">
              <div className="join-row">
                <label>
                  <span className="sr-only">세션 코드</span>
                  <input
                    value={joinCode}
                    onChange={(event) => setJoinCode(normalizeRoomCode(event.target.value))}
                    placeholder="6자리 코드"
                    aria-label="세션 코드"
                    autoComplete="one-time-code"
                    maxLength={6}
                  />
                </label>
                <label className="password-input">
                  <span className="sr-only">시청 비밀번호</span>
                  <input
                    value={joinPassword}
                    onChange={(event) =>
                      setJoinPassword(normalizeViewerPassword(event.target.value))
                    }
                    onKeyDown={(event) => event.key === "Enter" && joinBroadcast()}
                    placeholder="시청 비밀번호"
                    aria-label="시청 비밀번호"
                    autoComplete="off"
                    maxLength={19}
                  />
                </label>
              </div>
              <button
                className="button dark"
                onClick={joinBroadcast}
                disabled={joinCode.length !== 6 || !isCompleteViewerPassword(joinPassword)}
              >
                입장
              </button>
            </div>
          </article>
        </div>
      </section>

      <RecordingArchive />

      <footer className="site-footer">
        <span>PRIVATE ALPHA 01</span>
        <p>AWS KVS WebRTC · 송출 ID 권한 · 코드+비밀번호 시청 · 양방향 음성 · 7일 클라우드 녹화</p>
      </footer>
    </main>
  );
}
