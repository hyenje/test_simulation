import { getAuthorizedSession } from "../../../../db/petcam";
import { requestBrokerSession, type KvsRole } from "../../../kvs-broker";
import { getRequestUserEmail } from "../../../server-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const userEmail = getRequestUserEmail(request);
  if (!userEmail) return noStore({ error: "로그인이 필요합니다." }, 401);

  const payload = (await request.json().catch(() => null)) as {
    roomCode?: string;
    role?: string;
    clientId?: string;
  } | null;
  const roomCode = payload?.roomCode?.trim().toUpperCase() ?? "";
  const role = payload?.role as KvsRole | undefined;
  const clientId = payload?.clientId?.trim();

  if (!/^[A-Z2-9]{6}$/.test(roomCode) || !role || !["MASTER", "VIEWER"].includes(role)) {
    return noStore({ error: "세션 코드와 역할을 확인해 주세요." }, 400);
  }
  if (
    role === "VIEWER" &&
    (!clientId || !/^(?!AWS_)[A-Za-z0-9_-]{1,128}$/.test(clientId))
  ) {
    return noStore({ error: "올바른 시청자 ID가 필요합니다." }, 400);
  }

  const session = await getAuthorizedSession(userEmail, roomCode);
  if (!session) return noStore({ error: "세션이 없거나 접근 권한이 없습니다." }, 403);

  try {
    const broker = await requestBrokerSession({ role, clientId });
    if (broker.channelArn !== session.channelArn) {
      return noStore({ error: "AWS 채널 설정이 일치하지 않습니다." }, 503);
    }
    return noStore({ ...broker, roomCode, clientId: role === "VIEWER" ? clientId : null }, 200);
  } catch {
    return noStore({ error: "AWS 실시간 연결 정보를 발급하지 못했습니다." }, 503);
  }
}

function noStore(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
