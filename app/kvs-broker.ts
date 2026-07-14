import { env } from "cloudflare:workers";

export type KvsRole = "MASTER" | "VIEWER";

export type KvsBrokerSession = {
  role: KvsRole;
  region: string;
  channelArn: string;
  channelEndpoint: string;
  signedWssUrl: string;
  iceServers: RTCIceServer[];
  expiresAt: string;
};

export type KvsBrokerJoin = {
  joined: true;
  role: KvsRole;
  channelArn: string;
};

export type KvsBrokerPlayback = {
  playbackUrl: string;
  expiresAt: string;
  streamArn: string;
};

type BrokerEnv = {
  KVS_BROKER_URL?: string;
  KVS_BROKER_SECRET?: string;
};

export async function requestBrokerSession(input: {
  role: KvsRole;
  clientId?: string;
}): Promise<KvsBrokerSession> {
  const payload = (await requestBroker(input)) as Partial<KvsBrokerSession>;
  if (
    payload.role !== input.role ||
    typeof payload.region !== "string" ||
    typeof payload.channelArn !== "string" ||
    typeof payload.channelEndpoint !== "string" ||
    typeof payload.signedWssUrl !== "string" ||
    !Array.isArray(payload.iceServers) ||
    typeof payload.expiresAt !== "string"
  ) {
    throw new Error("KVS_BROKER_RESPONSE_INVALID");
  }

  return payload as KvsBrokerSession;
}

export async function requestBrokerJoinStorage(input: {
  role: KvsRole;
  clientId?: string;
}): Promise<KvsBrokerJoin> {
  const payload = (await requestBroker({
    action: "JOIN_STORAGE",
    role: input.role,
    ...(input.clientId ? { clientId: input.clientId } : {}),
  })) as Partial<KvsBrokerJoin>;
  if (
    payload.joined !== true ||
    payload.role !== input.role ||
    typeof payload.channelArn !== "string"
  ) {
    throw new Error("KVS_BROKER_RESPONSE_INVALID");
  }
  return payload as KvsBrokerJoin;
}

export async function requestBrokerPlayback(input: {
  streamArn: string;
  startAt: string;
  endAt: string;
  expiresSeconds: number;
}): Promise<KvsBrokerPlayback> {
  const payload = (await requestBroker({
    action: "HLS_PLAYBACK",
    streamArn: input.streamArn,
    startAt: input.startAt,
    endAt: input.endAt,
    expiresSeconds: input.expiresSeconds,
  })) as Partial<KvsBrokerPlayback>;
  if (
    typeof payload.playbackUrl !== "string" ||
    !payload.playbackUrl.startsWith("https://") ||
    typeof payload.expiresAt !== "string" ||
    payload.streamArn !== input.streamArn
  ) {
    throw new Error("KVS_BROKER_RESPONSE_INVALID");
  }
  return payload as KvsBrokerPlayback;
}

async function requestBroker(input: object) {
  const runtime = env as unknown as BrokerEnv;
  const brokerUrl = runtime.KVS_BROKER_URL;
  const secret = runtime.KVS_BROKER_SECRET;
  if (!brokerUrl || !secret) throw new Error("KVS_BROKER_NOT_CONFIGURED");
  if (!brokerUrl.startsWith("https://")) throw new Error("KVS_BROKER_URL_INVALID");

  const body = JSON.stringify(input);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await sign(`${timestamp}.${body}`, secret);
  const response = await fetch(brokerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-petcam-timestamp": timestamp,
      "x-petcam-signature": signature,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error(`KVS_BROKER_${response.status}`);
  return response.json();
}

async function sign(message: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
