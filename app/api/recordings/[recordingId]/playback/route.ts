import { env } from "cloudflare:workers";
import {
  consumeRequestRateLimit,
  getAuthorizedRecordingSession,
} from "../../../../../db/petcam";
import { requestBrokerPlayback } from "../../../../kvs-broker";
import { createRecordingPlaybackProxy } from "../../../../recording-playback-proxy";
import { getRequestUserEmail } from "../../../../server-auth";

export const dynamic = "force-dynamic";

type PlaybackEnv = {
  KVS_BROKER_SECRET?: string;
  KVS_STREAM_ARN?: string;
};

const RECORDING_SEGMENT_MS = 60 * 60 * 1000;
const RECORDING_RETENTION_MS = 7 * 24 * RECORDING_SEGMENT_MS;
const HLS_PLAYBACK_BUFFER_SECONDS = 60 * 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  const userEmail = getRequestUserEmail(request);
  if (!userEmail) return noStore({ error: "ID 로그인이 필요합니다." }, 401);

  const { recordingId } = await context.params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      recordingId,
    )
  ) {
    return noStore({ error: "저장 영상을 찾을 수 없습니다." }, 404);
  }

  const payload = (await request.json().catch(() => null)) as {
    segment?: number;
  } | null;
  const segment = payload?.segment ?? 0;
  if (!Number.isSafeInteger(segment) || segment < 0) {
    return noStore({ error: "올바른 녹화 구간이 필요합니다." }, 400);
  }

  const runtime = env as unknown as PlaybackEnv;
  if (!runtime.KVS_STREAM_ARN) {
    return noStore({ error: "AWS 저장 재생 설정이 필요합니다." }, 503);
  }

  const recording = await getAuthorizedRecordingSession(userEmail, recordingId).catch(
    () => null,
  );
  if (!recording || recording.streamArn !== runtime.KVS_STREAM_ARN) {
    return noStore({ error: "저장 영상을 찾을 수 없습니다." }, 404);
  }
  if (!recording.endedAt) {
    return noStore({ error: "진행 중인 녹화는 실시간 화면에서 확인해 주세요." }, 409);
  }

  const recordingStart = Date.parse(recording.startedAt);
  const recordingEnd = Date.parse(recording.endedAt);
  if (
    !Number.isFinite(recordingStart) ||
    !Number.isFinite(recordingEnd) ||
    recordingEnd <= recordingStart
  ) {
    return noStore({ error: "아직 재생할 저장 영상이 없습니다." }, 409);
  }
  const maxSegment = Math.ceil(
    (recordingEnd - recordingStart) / RECORDING_SEGMENT_MS,
  ) - 1;
  if (segment > maxSegment) {
    return noStore({ error: "저장 영상을 찾을 수 없습니다." }, 404);
  }

  const requestedSegmentStart = recordingStart + segment * RECORDING_SEGMENT_MS;
  const segmentEnd = Math.min(
    recordingEnd,
    requestedSegmentStart + RECORDING_SEGMENT_MS,
  );
  const retentionCutoff = Date.now() - RECORDING_RETENTION_MS;
  if (segmentEnd <= retentionCutoff) {
    return noStore({ error: "보관 기간이 지난 녹화입니다." }, 404);
  }
  const segmentStart = Math.max(requestedSegmentStart, retentionCutoff);
  const segmentDurationSeconds = Math.ceil((segmentEnd - segmentStart) / 1000);
  const expiresSeconds = Math.min(
    43_200,
    Math.max(300, segmentDurationSeconds + HLS_PLAYBACK_BUFFER_SECONDS),
  );

  const canIssuePlayback = await consumeRequestRateLimit({
    userEmail,
    roomCode: recordingId,
    scope: "recording-playback",
    limit: 10,
  });
  if (!canIssuePlayback) return rateLimited();

  try {
    const playback = await requestBrokerPlayback({
      streamArn: recording.streamArn,
      startAt: new Date(segmentStart).toISOString(),
      endAt: new Date(segmentEnd).toISOString(),
      expiresSeconds,
    });
    const proxy = await createRecordingPlaybackProxy(
      {
        requestUrl: request.url,
        playbackUrl: playback.playbackUrl,
        recordingId,
        userEmail,
        expiresAt: playback.expiresAt,
      },
      runtime.KVS_BROKER_SECRET ?? "",
    );
    return noStore(
      { playbackUrl: proxy.playbackUrl, expiresAt: playback.expiresAt },
      200,
      { "set-cookie": proxy.setCookie },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "KVS_BROKER_404") {
      return noStore({ error: "해당 시간에 저장된 영상이 없습니다." }, 404);
    }
    return noStore({ error: "저장 영상 재생 주소를 발급하지 못했습니다." }, 503);
  }
}

function noStore(body: unknown, status: number, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return Response.json(body, {
    status,
    headers: responseHeaders,
  });
}

function rateLimited() {
  return Response.json(
    { error: "재생 요청이 너무 많습니다. 1분 뒤 다시 시도해 주세요." },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": "60",
      },
    },
  );
}
