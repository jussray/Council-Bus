// Single Cloudflare Worker for all five Council-Bus seats.
// Each request explicitly names one seat. The caller must present that seat's
// own ROUTER_API_KEY_<SEAT> secret. A global key cannot grant cross-seat access.
// Provider API keys and model choices remain fixed server-side.
import { createSeatRouter, SEATS } from "./seat-router.js";

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

/** @param {{fetchImpl?: typeof fetch}} [options] */
export function createCouncilRouter(options = {}) {
  const perSeatRouter = createSeatRouter(options);
  return {
    /** @param {Request} request @param {Record<string, string | undefined>} env */
    async fetch(request, env = {}) {
      const { pathname } = new URL(request.url);
      if (pathname === "/health") {
        if (request.method !== "GET") {
          return json({ error: { message: "Method not allowed" } }, 405, { allow: "GET" });
        }
        // Do not reveal which providers have keys or working upstreams.
        return json({ ok: true, service: "council-router" });
      }
      if (pathname !== "/v1/chat/completions") {
        return json({ error: { message: "Not found" } }, 404);
      }
      if (request.method !== "POST") {
        return json({ error: { message: "Method not allowed" } }, 405, { allow: "POST" });
      }

      const seatName = request.headers.get("x-council-seat") ?? "";
      if (!Object.prototype.hasOwnProperty.call(SEATS, seatName)) {
        return json({ error: { message: "Unknown or missing Council seat" } }, 400);
      }

      const suffix = seatName.toUpperCase();
      return perSeatRouter.fetch(request, {
        ...env,
        SEAT: seatName,
        ROUTER_API_KEY: env["ROUTER_API_KEY_" + suffix],
        SEAT_MODEL: env["SEAT_MODEL_" + suffix],
      });
    },
  };
}

export default createCouncilRouter();
