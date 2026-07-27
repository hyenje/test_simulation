import { env } from "cloudflare:workers";
import {
  HomecamProvisioningConflict,
  provisionHomecamDevice,
} from "../../../../db/homecam-provisioning";
import { parseHomecamProvisioningInput } from "../../../../db/homecam-provisioning-input";
import { noStore } from "../../../api-response";
import {
  resolveDeviceKvsResources,
  type DeviceKvsEnvironment,
} from "../../../kvs-device-config";

export const dynamic = "force-dynamic";

type ProvisioningEnv = {
  DEVICE_PROVISIONING_SECRET?: string;
} & DeviceKvsEnvironment;

export async function POST(request: Request) {
  const runtime = env as unknown as ProvisioningEnv;
  const secret = runtime.DEVICE_PROVISIONING_SECRET;
  if (!secret || secret.length < 43) {
    return noStore({ error: "찾을 수 없습니다." }, 404);
  }
  if (!(await authorized(request, secret))) {
    return noStore({ error: "유효한 provisioning 인증이 필요합니다." }, 401);
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 8_192) {
    return noStore({ error: "provisioning 요청이 너무 큽니다." }, 413);
  }
  const body = await request.text();
  if (body.length > 8_192) {
    return noStore({ error: "provisioning 요청이 너무 큽니다." }, 413);
  }
  const payload = (() => {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  })();
  const parsed = parseHomecamProvisioningInput(payload);
  if (!parsed) {
    return noStore({ error: "provisioning 요청 형식을 확인해 주세요." }, 400);
  }

  try {
    const resources = resolveDeviceKvsResources(runtime, parsed.deviceId);
    if (
      !resources ||
      resources.source !== "mapping" ||
      !resources.p2pChannelArn
    ) {
      return noStore(
        { error: "장치의 AWS 리소스 매핑을 찾지 못했습니다." },
        503,
      );
    }
    const result = await provisionHomecamDevice({
      ...parsed,
      kvsChannelArn: resources.p2pChannelArn,
    });
    return noStore(
      {
        deviceId: result.deviceId,
        status: result.created ? "created" : "unchanged",
      },
      result.created ? 201 : 200,
    );
  } catch (error) {
    if (error instanceof HomecamProvisioningConflict) {
      return noStore(
        { error: "기존 장치 또는 자격 증명과 충돌합니다." },
        409,
      );
    }
    return noStore({ error: "장치를 등록하지 못했습니다." }, 500);
  }
}

async function authorized(request: Request, expected: string) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const received = header.slice("Bearer ".length);
  if (!received || received.length > 512) return false;
  const [left, right] = await Promise.all([
    sha256(received),
    sha256(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    ),
  );
}
