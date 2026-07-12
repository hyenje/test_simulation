"use client";

export type KvsConnectionState = "waiting" | "connecting" | "live" | "offline";

type KvsRole = "MASTER" | "VIEWER";

type KvsSessionConfig = {
  role: KvsRole;
  region: string;
  channelArn: string;
  channelEndpoint: string;
  signedWssUrl: string;
  iceServers: RTCIceServer[];
  expiresAt: string;
  roomCode: string;
  clientId: string | null;
};

type KvsSignalingClient = {
  on(event: "open", callback: () => void): void;
  on(event: "close", callback: () => void): void;
  on(event: "error", callback: (error: Error) => void): void;
  on(
    event: "sdpOffer",
    callback: (offer: RTCSessionDescriptionInit, senderClientId: string) => void,
  ): void;
  on(
    event: "sdpAnswer",
    callback: (answer: RTCSessionDescriptionInit) => void,
  ): void;
  on(
    event: "iceCandidate",
    callback: (candidate: RTCIceCandidateInit, senderClientId?: string) => void,
  ): void;
  open(): void;
  close(): void;
  sendSdpOffer(offer: RTCSessionDescription): void;
  sendSdpAnswer(answer: RTCSessionDescription, recipientClientId: string): void;
  sendIceCandidate(candidate: RTCIceCandidate, recipientClientId?: string): void;
  drainPendingIceCandidates(clientId?: string): void;
};

type KvsSdk = {
  Role: { MASTER: "MASTER"; VIEWER: "VIEWER" };
  SignalingClient: new (config: {
    channelARN: string;
    channelEndpoint: string;
    clientId?: string;
    role: KvsRole;
    region: string;
    requestSigner: {
      getSignedURL: () => Promise<string>;
    };
    enableEarlyIceCandidateBuffering: boolean;
  }) => KvsSignalingClient;
};

type ConnectionCallbacks = {
  onState: (state: KvsConnectionState) => void;
  onError: (error: Error) => void;
};

export type KvsConnection = {
  close: () => void;
};

let sdkPromise: Promise<KvsSdk> | null = null;

export async function createLiveSession() {
  const response = await fetch("/api/live-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const payload = (await response.json()) as {
    session?: { roomCode: string };
    error?: string;
  };
  if (!response.ok || !payload.session) {
    throw new Error(payload.error ?? "스트리밍 세션을 만들지 못했습니다.");
  }
  return payload.session;
}

export async function endLiveSession(roomCode: string) {
  await fetch("/api/live-sessions", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomCode }),
    keepalive: true,
  }).catch(() => undefined);
}

export async function connectKvsMaster(input: {
  roomCode: string;
  stream: MediaStream;
  callbacks: ConnectionCallbacks;
}): Promise<KvsConnection> {
  const [sdk, config] = await Promise.all([
    loadKvsSdk(),
    requestKvsSession(input.roomCode, "MASTER"),
  ]);
  let closed = false;
  let peer: RTCPeerConnection | null = null;
  let remoteClientId: string | null = null;
  const queuedCandidates: Array<{ candidate: RTCIceCandidateInit; sender?: string }> = [];

  const signaling = new sdk.SignalingClient({
    channelARN: config.channelArn,
    channelEndpoint: config.channelEndpoint,
    role: sdk.Role.MASTER,
    region: config.region,
    requestSigner: { getSignedURL: async () => config.signedWssUrl },
    enableEarlyIceCandidateBuffering: true,
  });

  const closePeer = () => {
    peer?.close();
    peer = null;
    remoteClientId = null;
    queuedCandidates.length = 0;
  };

  signaling.on("open", () => {
    if (!closed) input.callbacks.onState("waiting");
  });

  signaling.on("sdpOffer", async (offer, senderClientId) => {
    if (closed || !senderClientId) return;
    closePeer();
    remoteClientId = senderClientId;
    input.callbacks.onState("connecting");

    const nextPeer = new RTCPeerConnection({ iceServers: config.iceServers });
    peer = nextPeer;
    input.stream.getTracks().forEach((track) => nextPeer.addTrack(track, input.stream));

    nextPeer.onicecandidate = ({ candidate }) => {
      if (candidate && remoteClientId === senderClientId) {
        signaling.sendIceCandidate(candidate, senderClientId);
      }
    };
    nextPeer.onconnectionstatechange = () => {
      if (nextPeer !== peer || closed) return;
      if (nextPeer.connectionState === "connected") input.callbacks.onState("live");
      if (["failed", "disconnected"].includes(nextPeer.connectionState)) {
        input.callbacks.onState("waiting");
      }
    };

    try {
      await nextPeer.setRemoteDescription(offer);
      signaling.drainPendingIceCandidates(senderClientId);
      for (const entry of queuedCandidates.splice(0)) {
        if (!entry.sender || entry.sender === senderClientId) {
          await nextPeer.addIceCandidate(entry.candidate);
        }
      }
      const answer = await nextPeer.createAnswer();
      await nextPeer.setLocalDescription(answer);
      if (nextPeer.localDescription) {
        signaling.sendSdpAnswer(nextPeer.localDescription, senderClientId);
      }
    } catch (error) {
      input.callbacks.onError(toError(error, "보호자 연결 요청을 처리하지 못했습니다."));
    }
  });

  signaling.on("iceCandidate", (candidate, senderClientId) => {
    if (closed || (senderClientId && remoteClientId && senderClientId !== remoteClientId)) return;
    if (peer?.remoteDescription) {
      peer.addIceCandidate(candidate).catch(() => undefined);
    } else {
      queuedCandidates.push({ candidate, sender: senderClientId });
    }
  });

  signaling.on("close", () => {
    if (!closed) input.callbacks.onState("offline");
  });
  signaling.on("error", (error) => {
    if (!closed) input.callbacks.onError(error);
  });
  signaling.open();

  return {
    close() {
      closed = true;
      closePeer();
      signaling.close();
    },
  };
}

export async function connectKvsViewer(input: {
  roomCode: string;
  onStream: (stream: MediaStream) => void;
  callbacks: ConnectionCallbacks;
}): Promise<KvsConnection> {
  const clientId = `petcam-${crypto.randomUUID()}`;
  const [sdk, config] = await Promise.all([
    loadKvsSdk(),
    requestKvsSession(input.roomCode, "VIEWER", clientId),
  ]);
  let closed = false;
  const queuedCandidates: RTCIceCandidateInit[] = [];
  const peer = new RTCPeerConnection({ iceServers: config.iceServers });
  peer.addTransceiver("video", { direction: "recvonly" });

  const signaling = new sdk.SignalingClient({
    channelARN: config.channelArn,
    channelEndpoint: config.channelEndpoint,
    clientId,
    role: sdk.Role.VIEWER,
    region: config.region,
    requestSigner: { getSignedURL: async () => config.signedWssUrl },
    enableEarlyIceCandidateBuffering: true,
  });

  peer.onicecandidate = ({ candidate }) => {
    if (candidate && !closed) signaling.sendIceCandidate(candidate);
  };
  peer.ontrack = (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    input.onStream(stream);
  };
  peer.onconnectionstatechange = () => {
    if (closed) return;
    if (peer.connectionState === "connected") input.callbacks.onState("live");
    if (["failed", "disconnected"].includes(peer.connectionState)) {
      input.callbacks.onState("offline");
    }
  };

  signaling.on("open", async () => {
    if (closed) return;
    input.callbacks.onState("connecting");
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.localDescription) signaling.sendSdpOffer(peer.localDescription);
    } catch (error) {
      input.callbacks.onError(toError(error, "AWS 연결 제안을 만들지 못했습니다."));
    }
  });

  signaling.on("sdpAnswer", async (answer) => {
    if (closed) return;
    try {
      await peer.setRemoteDescription(answer);
      signaling.drainPendingIceCandidates();
      for (const candidate of queuedCandidates.splice(0)) {
        await peer.addIceCandidate(candidate);
      }
    } catch (error) {
      input.callbacks.onError(toError(error, "카메라 응답을 처리하지 못했습니다."));
    }
  });

  signaling.on("iceCandidate", (candidate) => {
    if (closed) return;
    if (peer.remoteDescription) {
      peer.addIceCandidate(candidate).catch(() => undefined);
    } else {
      queuedCandidates.push(candidate);
    }
  });
  signaling.on("close", () => {
    if (!closed) input.callbacks.onState("offline");
  });
  signaling.on("error", (error) => {
    if (!closed) input.callbacks.onError(error);
  });
  signaling.open();

  return {
    close() {
      closed = true;
      signaling.close();
      peer.close();
    },
  };
}

async function requestKvsSession(roomCode: string, role: KvsRole, clientId?: string) {
  const response = await fetch("/api/kvs/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomCode, role, clientId }),
  });
  const payload = (await response.json()) as KvsSessionConfig & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "AWS 연결 정보를 받지 못했습니다.");
  return payload;
}

async function loadKvsSdk(): Promise<KvsSdk> {
  if (!sdkPromise) {
    sdkPromise = new Promise<KvsSdk>((resolve, reject) => {
      const current = (window as typeof window & { KVSWebRTC?: KvsSdk }).KVSWebRTC;
      if (current) {
        resolve(current);
        return;
      }

      const script = document.createElement("script");
      script.src = "/vendor/kvs-webrtc.min.js";
      script.async = true;
      script.onload = () => {
        const sdk = (window as typeof window & { KVSWebRTC?: KvsSdk }).KVSWebRTC;
        if (sdk) resolve(sdk);
        else reject(new Error("AWS KVS WebRTC SDK를 불러오지 못했습니다."));
      };
      script.onerror = () => reject(new Error("AWS KVS WebRTC SDK 파일을 불러오지 못했습니다."));
      document.head.appendChild(script);
    });
  }
  return sdkPromise;
}

function toError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}
