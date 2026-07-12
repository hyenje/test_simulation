import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  GetSignalingChannelEndpointCommand,
  KinesisVideoClient,
} from "@aws-sdk/client-kinesis-video";
import {
  GetIceServerConfigCommand,
  KinesisVideoSignalingClient,
} from "@aws-sdk/client-kinesis-video-signaling";
const region = process.env.AWS_REGION;
const channelArn = process.env.KVS_CHANNEL_ARN;
const sharedSecret = process.env.BROKER_SHARED_SECRET;
const kinesisVideo = new KinesisVideoClient({ region });

export async function handler(event) {
  if (event.requestContext?.http?.method !== "POST") return response(405, { error: "Method not allowed" });
  if (!region || !channelArn || !sharedSecret) return response(503, { error: "Broker is not configured" });

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";
  if (!verifyRequest(event.headers ?? {}, rawBody, sharedSecret)) {
    return response(401, { error: "Unauthorized" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return response(400, { error: "Invalid JSON" });
  }

  const role = payload.role;
  const clientId = typeof payload.clientId === "string" ? payload.clientId.trim() : undefined;
  if (!['MASTER', 'VIEWER'].includes(role)) return response(400, { error: "Invalid role" });
  if (role === "VIEWER" && (!clientId || !/^(?!AWS_)[A-Za-z0-9_-]{1,128}$/.test(clientId))) {
    return response(400, { error: "Invalid client id" });
  }

  try {
    const endpointResult = await kinesisVideo.send(
      new GetSignalingChannelEndpointCommand({
        ChannelARN: channelArn,
        SingleMasterChannelEndpointConfiguration: {
          Protocols: ["WSS", "HTTPS"],
          Role: role,
        },
      }),
    );
    const endpoints = Object.fromEntries(
      (endpointResult.ResourceEndpointList ?? [])
        .filter((entry) => entry.Protocol && entry.ResourceEndpoint)
        .map((entry) => [entry.Protocol, entry.ResourceEndpoint]),
    );
    if (!endpoints.WSS || !endpoints.HTTPS) throw new Error("Missing KVS endpoint");

    const signaling = new KinesisVideoSignalingClient({ region, endpoint: endpoints.HTTPS });
    const iceResult = await signaling.send(
      new GetIceServerConfigCommand({ ChannelARN: channelArn }),
    );
    const iceServers = [
      { urls: `stun:stun.kinesisvideo.${region}.amazonaws.com:443` },
      ...(iceResult.IceServerList ?? []).map((server) => ({
        urls: server.Uris ?? [],
        username: server.Username,
        credential: server.Password,
      })),
    ];

    const credentials = await kinesisVideo.config.credentials();
    const queryParams = { "X-Amz-ChannelARN": channelArn };
    if (role === "VIEWER") queryParams["X-Amz-ClientId"] = clientId;
    const signedWssUrl = signKvsWebSocketUrl(
      endpoints.WSS,
      queryParams,
      credentials,
      region,
    );

    return response(200, {
      role,
      region,
      channelArn,
      channelEndpoint: endpoints.WSS,
      signedWssUrl,
      iceServers,
      expiresAt: new Date(Date.now() + 299_000).toISOString(),
    });
  } catch (error) {
    console.error("KVS broker request failed", error instanceof Error ? error.name : "UnknownError");
    return response(502, { error: "KVS session could not be created" });
  }
}

function signKvsWebSocketUrl(endpoint, queryParams, credentials, signingRegion) {
  const url = new URL(endpoint);
  if (url.protocol !== "wss:" || url.search) throw new Error("Invalid KVS WebSocket endpoint");

  const now = new Date();
  const dateTime = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:-]/g, "");
  const date = dateTime.slice(0, 8);
  const scope = `${date}/${signingRegion}/kinesisvideo/aws4_request`;
  const signedHeaders = "host";
  const canonical = {
    ...queryParams,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": dateTime,
    "X-Amz-Expires": "299",
    "X-Amz-SignedHeaders": signedHeaders,
  };
  if (credentials.sessionToken) canonical["X-Amz-Security-Token"] = credentials.sessionToken;

  const canonicalQuery = encodeQuery(canonical);
  const payloadHash = createHash("sha256").update("").digest("hex");
  const canonicalRequest = [
    "GET",
    url.pathname || "/",
    canonicalQuery,
    `host:${url.host}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateTime,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, date);
  const kRegion = hmac(kDate, signingRegion);
  const kService = hmac(kRegion, "kinesisvideo");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return `wss://${url.host}${url.pathname || "/"}?${encodeQuery({ ...canonical, "X-Amz-Signature": signature })}`;
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function encodeQuery(values) {
  return Object.keys(values)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(values[key])}`)
    .join("&");
}

function verifyRequest(headers, rawBody, secret) {
  const timestamp = headers["x-petcam-timestamp"];
  const signature = headers["x-petcam-signature"];
  if (!timestamp || !signature || !/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) {
    return false;
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 30) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}
