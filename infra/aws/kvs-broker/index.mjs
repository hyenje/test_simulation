import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  GetDataEndpointCommand,
  GetSignalingChannelEndpointCommand,
  KinesisVideoClient,
} from "@aws-sdk/client-kinesis-video";
import {
  GetHLSStreamingSessionURLCommand,
  KinesisVideoArchivedMediaClient,
} from "@aws-sdk/client-kinesis-video-archived-media";
import {
  GetIceServerConfigCommand,
  KinesisVideoSignalingClient,
} from "@aws-sdk/client-kinesis-video-signaling";
import {
  JoinStorageSessionAsViewerCommand,
  JoinStorageSessionCommand,
  KinesisVideoWebRTCStorageClient,
} from "@aws-sdk/client-kinesis-video-webrtc-storage";

const region = process.env.AWS_REGION;
const channelArn = process.env.KVS_CHANNEL_ARN;
const allowedStreamArn = process.env.KVS_STREAM_ARN;
const sharedSecret = process.env.BROKER_SHARED_SECRET;
const kinesisVideo = new KinesisVideoClient({ region });
const clientIdPattern = /^(?!AWS_)[A-Za-z0-9_-]{1,128}$/;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const maxHlsPlaybackRangeMs = 60 * 60 * 1000;

export async function handler(event) {
  if (event.requestContext?.http?.method !== "POST") {
    return response(405, { error: "Method not allowed" });
  }
  if (!region || !channelArn || !sharedSecret) {
    return response(503, { error: "Broker is not configured" });
  }

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
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return response(400, { error: "Invalid request" });
  }

  const action = payload.action ?? "SESSION";
  if (!["SESSION", "JOIN_STORAGE", "HLS_PLAYBACK"].includes(action)) {
    return response(400, { error: "Invalid action" });
  }

  if (action === "HLS_PLAYBACK") {
    const input = validateHlsPlaybackInput(payload);
    if (!input) return response(400, { error: "Invalid HLS playback request" });
    if (!allowedStreamArn) {
      return response(503, { error: "HLS playback is not configured" });
    }
    if (input.streamArn !== allowedStreamArn) {
      return response(403, { error: "Stream is not allowed" });
    }

    try {
      return response(200, await createHlsPlayback(input));
    } catch (error) {
      console.error(
        "KVS HLS playback failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      if (error instanceof Error && error.name === "ResourceNotFoundException") {
        return response(404, { error: "No media was found for the requested range" });
      }
      return response(502, { error: "HLS playback could not be created" });
    }
  }

  const participant = validateParticipant(payload, payload.action !== undefined);
  if (!participant) return response(400, { error: "Invalid participant" });

  if (action === "JOIN_STORAGE") {
    try {
      await joinStorageSession(participant.role, participant.clientId);
      return response(200, { joined: true, role: participant.role, channelArn });
    } catch (error) {
      console.error(
        "KVS storage join failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      return response(502, { error: "KVS storage session could not be joined" });
    }
  }

  try {
    const session = await createSignalingSession(participant.role, participant.clientId);
    return response(200, session);
  } catch (error) {
    console.error(
      "KVS broker request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return response(502, { error: "KVS session could not be created" });
  }
}

async function createSignalingSession(role, clientId) {
  const endpoints = await getChannelEndpoints(role, ["WSS", "HTTPS"]);
  if (!endpoints.WSS || !endpoints.HTTPS) throw new Error("Missing KVS endpoint");

  const signaling = new KinesisVideoSignalingClient({
    region,
    endpoint: endpoints.HTTPS,
  });
  const iceResult = await signaling.send(
    new GetIceServerConfigCommand({ ChannelARN: channelArn }),
  );
  const iceServers = [
    { urls: "stun:stun.kinesisvideo." + region + ".amazonaws.com:443" },
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

  return {
    role,
    region,
    channelArn,
    channelEndpoint: endpoints.WSS,
    signedWssUrl,
    iceServers,
    expiresAt: new Date(Date.now() + 299_000).toISOString(),
  };
}

async function joinStorageSession(role, clientId) {
  const endpoints = await getChannelEndpoints(role, ["WEBRTC"]);
  if (!endpoints.WEBRTC) throw new Error("Missing KVS WebRTC endpoint");

  const storage = new KinesisVideoWebRTCStorageClient({
    region,
    endpoint: endpoints.WEBRTC,
  });
  if (role === "MASTER") {
    await storage.send(new JoinStorageSessionCommand({ channelArn }));
  } else {
    await storage.send(
      new JoinStorageSessionAsViewerCommand({ channelArn, clientId }),
    );
  }
}

async function createHlsPlayback({ streamArn, startAt, endAt, expiresSeconds }) {
  const endpointResult = await kinesisVideo.send(
    new GetDataEndpointCommand({
      APIName: "GET_HLS_STREAMING_SESSION_URL",
      StreamARN: streamArn,
    }),
  );
  if (!endpointResult.DataEndpoint) {
    throw new Error("Missing KVS archived media endpoint");
  }

  const endpoint = new URL(endpointResult.DataEndpoint);
  if (endpoint.protocol !== "https:" || endpoint.search || endpoint.hash) {
    throw new Error("Invalid KVS archived media endpoint");
  }

  const archivedMedia = new KinesisVideoArchivedMediaClient({
    region,
    endpoint: endpointResult.DataEndpoint,
  });
  const expiresAt = new Date(Date.now() + expiresSeconds * 1000).toISOString();
  const playback = await archivedMedia.send(
    new GetHLSStreamingSessionURLCommand({
      StreamARN: streamArn,
      PlaybackMode: "ON_DEMAND",
      HLSFragmentSelector: {
        FragmentSelectorType: "SERVER_TIMESTAMP",
        TimestampRange: {
          StartTimestamp: new Date(startAt),
          EndTimestamp: new Date(endAt),
        },
      },
      ContainerFormat: "FRAGMENTED_MP4",
      Expires: expiresSeconds,
      MaxMediaPlaylistFragmentResults: 5000,
    }),
  );
  if (!playback.HLSStreamingSessionURL) {
    throw new Error("Missing HLS playback URL");
  }

  return {
    playbackUrl: playback.HLSStreamingSessionURL,
    expiresAt,
    streamArn,
  };
}

async function getChannelEndpoints(role, protocols) {
  const endpointResult = await kinesisVideo.send(
    new GetSignalingChannelEndpointCommand({
      ChannelARN: channelArn,
      SingleMasterChannelEndpointConfiguration: {
        Protocols: protocols,
        Role: role,
      },
    }),
  );
  return Object.fromEntries(
    (endpointResult.ResourceEndpointList ?? [])
      .filter((entry) => entry.Protocol && entry.ResourceEndpoint)
      .map((entry) => [entry.Protocol, entry.ResourceEndpoint]),
  );
}

function validateParticipant(payload, strict) {
  if (strict && !hasOnlyKeys(payload, ["action", "role", "clientId"])) return null;
  const role = payload.role;
  if (!["MASTER", "VIEWER"].includes(role)) return null;

  if (role === "MASTER") {
    if (strict && Object.hasOwn(payload, "clientId")) return null;
    return { role, clientId: undefined };
  }

  if (typeof payload.clientId !== "string") return null;
  const clientId = payload.clientId.trim();
  if ((strict && clientId !== payload.clientId) || !clientIdPattern.test(clientId)) {
    return null;
  }
  return { role, clientId };
}

function validateHlsPlaybackInput(payload) {
  if (
    !hasOnlyKeys(payload, [
      "action",
      "streamArn",
      "startAt",
      "endAt",
      "expiresSeconds",
    ])
  ) {
    return null;
  }
  if (
    typeof payload.streamArn !== "string" ||
    typeof payload.startAt !== "string" ||
    typeof payload.endAt !== "string" ||
    !Number.isInteger(payload.expiresSeconds) ||
    payload.expiresSeconds < 300 ||
    payload.expiresSeconds > 43_200 ||
    !isCanonicalTimestamp(payload.startAt) ||
    !isCanonicalTimestamp(payload.endAt)
  ) {
    return null;
  }

  const start = Date.parse(payload.startAt);
  const end = Date.parse(payload.endAt);
  if (end <= start || end - start > maxHlsPlaybackRangeMs) return null;
  return {
    streamArn: payload.streamArn,
    startAt: payload.startAt,
    endAt: payload.endAt,
    expiresSeconds: payload.expiresSeconds,
  };
}

function isCanonicalTimestamp(value) {
  if (!isoTimestampPattern.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
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
