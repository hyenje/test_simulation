import { getRequestUserEmail } from "../../../server-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return Response.json(
    { authenticated: Boolean(getRequestUserEmail(request)) },
    { headers: { "cache-control": "no-store" } },
  );
}
