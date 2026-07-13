import { env } from "cloudflare:workers";

const USER_EMAIL_HEADER = "oai-authenticated-user-email";

type PetcamAuthEnv = {
  PETCAM_BROADCASTER_EMAILS?: string;
  PETCAM_DEV_USER_EMAIL?: string;
};

export function getRequestUserEmail(request: Request): string | null {
  const authenticatedEmail = request.headers.get(USER_EMAIL_HEADER)?.trim().toLowerCase();
  if (authenticatedEmail) return authenticatedEmail;

  const hostname = new URL(request.url).hostname;
  const localEmail = (env as unknown as PetcamAuthEnv).PETCAM_DEV_USER_EMAIL?.trim().toLowerCase();
  if (localEmail && (hostname === "localhost" || hostname === "127.0.0.1")) {
    return localEmail;
  }

  return null;
}

export function canBroadcastForConfiguredAccount(userEmail: string) {
  const configured = (env as unknown as PetcamAuthEnv).PETCAM_BROADCASTER_EMAILS ?? "";
  return configured
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
    .includes(userEmail.trim().toLowerCase());
}
