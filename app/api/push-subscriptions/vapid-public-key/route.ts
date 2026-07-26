import { env } from "cloudflare:workers";
import { noStore } from "../../../api-response";
import { getRequestUserEmail } from "../../../server-auth";

export const dynamic = "force-dynamic";

type PushPublicEnv = {
  PUSH_VAPID_PUBLIC_KEY?: string;
};

export async function GET(request: Request) {
  if (!getRequestUserEmail(request)) {
    return noStore({ error: "로그인이 필요합니다." }, 401);
  }
  const publicKey = (env as unknown as PushPublicEnv).PUSH_VAPID_PUBLIC_KEY?.trim();
  if (!publicKey || !/^[A-Za-z0-9_-]{80,100}$/.test(publicKey)) {
    return noStore({ error: "Web Push 공개키가 설정되지 않았습니다." }, 503);
  }
  return noStore({ publicKey }, 200);
}
