/**
 * The one place the Pi talks to Cloudflare on the service channel.
 *
 * Both loops use it: the pull (events in, estimates out, requests drained) and the pool orchestrator
 * (passages out). Keeping the secret handling in one function is the difference between one place to
 * rotate it and three.
 */
import { loadEnv } from "../env";

export interface ServiceConfig {
  url: string;
  secret: string;
}

export function serviceConfig(): ServiceConfig {
  const env = loadEnv();
  const url = env.FLOWWING_IDENTITY_URL;
  const secret = env.FLOWWING_IDENTITY_SECRET;
  if (!url || !secret) {
    throw new Error("FLOWWING_IDENTITY_URL and FLOWWING_IDENTITY_SECRET must be set: the Pi calls Cloudflare");
  }
  return { url: url.replace(/\/$/, ""), secret };
}

export async function callService<T>(
  config: ServiceConfig,
  pathName: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${config.url}/api/service${pathName}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Flowwing-Service": config.secret,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`${pathName}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}
