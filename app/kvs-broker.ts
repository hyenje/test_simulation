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

type BrokerEnv = {
  KVS_BROKER_URL?: string;
  KVS_BROKER_SECRET?: string;
};

export async function requestBrokerSession(input: {
  role: KvsRole;
  clientId?: string;
}): Promise<KvsBrokerSession> {
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
  const payload = (await response.json()) as Partial<KvsBrokerSession>;
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
