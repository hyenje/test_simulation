import { env } from "cloudflare:workers";
import { createLiveSession, endLiveSession } from "../../../db/petcam";
import {
  canBroadcastForConfiguredAccount,
  getRequestUserEmail,
} from "../../server-auth";

export const dynamic = "force-dynamic";

type SessionEnv = {
  KVS_CHANNEL_ARN?: string;
  PETCAM_BROADCASTER_EMAILS?: string;
  PETCAM_DEVICE_ID?: string;
  PETCAM_SHARE_SECRET?: string;
};

export async function POST(request: Request) {
  const ownerEmail = getRequestUserEmail(request);
  if (!ownerEmail) return noStore({ error: "로그인이 필요합니다." }, 401);

  const runtime = env as unknown as SessionEnv;
  const channelArn = runtime.KVS_CHANNEL_ARN;
  if (!channelArn) return noStore({ error: "AWS 채널 설정이 필요합니다." }, 503);
  if (!runtime.PETCAM_SHARE_SECRET) {
    return noStore({ error: "시청 비밀번호 보안 설정이 필요합니다." }, 503);
  }
  if (!runtime.PETCAM_BROADCASTER_EMAILS?.trim()) {
    return noStore({ error: "영상 공개 ID 설정이 필요합니다." }, 503);
  }
  const canBroadcast = canBroadcastForConfiguredAccount(ownerEmail);
  if (!canBroadcast) {
    return noStore({ error: "이 ID에는 영상 공개 권한이 없습니다." }, 403);
  }

  try {
    const session = await createLiveSession({
      ownerEmail,
      deviceId: runtime.PETCAM_DEVICE_ID ?? "laptop-camera-01",
      displayName: "노트북 카메라 01",
      channelArn,
      shareSecret: runtime.PETCAM_SHARE_SECRET,
    });
    return noStore({ session }, 201);
  } catch (error) {
    if (error instanceof Error && error.message === "DEVICE_FORBIDDEN") {
      return noStore({ error: "이 카메라를 사용할 권한이 없습니다." }, 403);
    }
    return noStore({ error: "스트리밍 세션을 만들지 못했습니다." }, 500);
  }
}

export async function DELETE(request: Request) {
  const ownerEmail = getRequestUserEmail(request);
  if (!ownerEmail) return noStore({ error: "로그인이 필요합니다." }, 401);

  const payload = (await request.json().catch(() => null)) as { roomCode?: string } | null;
  const roomCode = payload?.roomCode?.trim().toUpperCase() ?? "";
  if (!/^[A-Z2-9]{6}$/.test(roomCode)) {
    return noStore({ error: "올바른 세션 코드가 필요합니다." }, 400);
  }

  const ended = await endLiveSession(ownerEmail, roomCode);
  return noStore({ ended }, 200);
}

function noStore(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
