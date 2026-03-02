const ORG_ID = "17vnF6";
const DEVICE_ID = 3;

const TOKEN_URL = "https://api.ic.peplink.com/api/oauth2/token";
const API_BASE = "https://api.ic.peplink.com/rest";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}

async function safeJson(response: Response) {
  const text = await response.text();
  if (!text) {
    return { ok: false, error: "Empty response body.", text: "" };
  }
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: String(error), text };
  }
}

function getGpsTimestamp(device: Record<string, unknown>) {
  const candidates = [
    device?.gps_updated_at,
    device?.gps_update_time,
    device?.gps_time,
    device?.last_gps_time,
    device?.gps_last_updated,
    device?.gps_location_time,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  const gpsLocation = (device as { starlink_status?: Array<Record<string, unknown>> })
    ?.starlink_status?.[0]?.gpsLocation as Record<string, unknown> | undefined;
  if (gpsLocation) {
    const gpsCandidates = [gpsLocation.timestamp, gpsLocation.time, gpsLocation.ts];
    for (const value of gpsCandidates) {
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  }

  const clientId = Deno.env.get("PEPLINK_CLIENT_ID");
  const clientSecret = Deno.env.get("PEPLINK_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    return jsonResponse({ error: "Missing Peplink credentials." }, 500);
  }

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return jsonResponse({ error: "Token request failed.", details: text }, 502);
    }

    const tokenParsed = await safeJson(tokenRes);
    if (!tokenParsed.ok) {
      return jsonResponse(
        { error: "Token response was not valid JSON.", details: tokenParsed },
        502,
      );
    }
    const accessToken = tokenParsed.json?.access_token;
    if (!accessToken) {
      return jsonResponse({ error: "Token response missing access_token." }, 502);
    }

    const devicesRes = await fetch(
      `${API_BASE}/o/${ORG_ID}/d?has_status=true&access_token=${accessToken}`,
    );
    if (!devicesRes.ok) {
      const text = await devicesRes.text();
      return jsonResponse({ error: "Device request failed.", details: text }, 502);
    }

    const devicesParsed = await safeJson(devicesRes);
    if (!devicesParsed.ok) {
      return jsonResponse(
        { error: "Device response was not valid JSON.", details: devicesParsed },
        502,
      );
    }
    const devices = devicesParsed.json?.data ?? [];
    const device = devices.find((item: { id?: number }) => item?.id === DEVICE_ID);

    if (!device) {
      return jsonResponse({ error: "Device not found." }, 404);
    }

    const gpsLocation = device?.starlink_status?.[0]?.gpsLocation?.lla;
    const lat = typeof gpsLocation?.lat === "number" ? gpsLocation.lat : null;
    const lng = typeof gpsLocation?.lon === "number" ? gpsLocation.lon : null;
    const locationAvailable = lat !== null && lng !== null;
    const fetchedAt = new Date().toISOString();
    const gpsReportedAt = getGpsTimestamp(device);
    const deviceUpdatedAt = device?.last_ic2_online_time ?? device?.last_online ?? null;
    const updatedAt = gpsReportedAt ?? deviceUpdatedAt ?? fetchedAt;
    const timeSource = gpsReportedAt
      ? "gps_reported_at"
      : deviceUpdatedAt
        ? "device_updated_at"
        : "fetched_at";

    return jsonResponse({
      device_id: DEVICE_ID,
      device_name: device?.name ?? null,
      lat,
      lng,
      updated_at: updatedAt,
      time_source: timeSource,
      fetched_at: fetchedAt,
      location_available: locationAvailable,
    });
  } catch (error) {
    return jsonResponse({ error: "Unexpected error.", details: String(error) }, 500);
  }
});
