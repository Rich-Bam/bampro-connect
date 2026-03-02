const ORG_ID = "17vnF6";
const DEVICE_ID = 3;

const TOKEN_URL = "https://api.ic.peplink.com/api/oauth2/token";
const API_BASE = "https://api.ic.peplink.com/rest";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
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

function pickLatestTimestamp(...values: Array<unknown>) {
  const parsed = values
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((item) => !Number.isNaN(item.time));

  if (!parsed.length) {
    return null;
  }
  parsed.sort((a, b) => b.time - a.time);
  return parsed[0].value;
}

function getGpsTimestamp(device: Record<string, unknown>) {
  const gpsCandidates = [
    device?.gps_updated_at,
    device?.gps_update_time,
    device?.gps_time,
    device?.last_gps_time,
    device?.gps_last_updated,
    device?.gps_location_time,
  ];

  const starlink = (device as { starlink_status?: Array<Record<string, unknown>> })
    ?.starlink_status?.[0];
  const gpsLocation = starlink?.gpsLocation as Record<string, unknown> | undefined;
  const gpsLocationCandidates = gpsLocation
    ? [gpsLocation.timestamp, gpsLocation.time, gpsLocation.ts]
    : [];

  const interfaces = (device as { interfaces?: Array<Record<string, unknown>> })?.interfaces;
  const interfaceUpdates = Array.isArray(interfaces)
    ? interfaces.map((item: Record<string, unknown>) => item.updated_at)
    : [];

  return pickLatestTimestamp(
    ...gpsCandidates,
    ...gpsLocationCandidates,
    ...interfaceUpdates,
  );
}

function getSpeedKmh(device: Record<string, unknown>) {
  const candidates = [
    device?.speed,
    device?.speed_kmh,
    device?.gps_speed,
    device?.gps?.speed,
    device?.gps?.speed_kmh,
    device?.gps?.speedKmh,
    device?.gpsLocation?.speed,
  ];

  for (const value of candidates) {
    if (typeof value === "number" && !Number.isNaN(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * 6371 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
    const deviceUpdatedAt = pickLatestTimestamp(
      device?.last_ic2_online_time,
      device?.last_online,
      device?.fw_pending_group_time,
    );
    const updatedAt = gpsReportedAt ?? deviceUpdatedAt ?? fetchedAt;
    const timeSource = gpsReportedAt
      ? "gps_or_interface_updated_at"
      : deviceUpdatedAt
        ? "device_updated_at"
        : "fetched_at";

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    let track: Array<{ lat: number; lng: number; recorded_at: string }> = [];

    if (supabaseUrl && serviceRoleKey && locationAvailable) {
      const supabase = createClient(supabaseUrl, serviceRoleKey);
      const recordedAt = updatedAt ?? fetchedAt;

      await supabase.from("gps_points").upsert(
        {
          device_id: DEVICE_ID,
          device_name: device?.name ?? null,
          lat,
          lng,
          recorded_at: recordedAt,
          time_source: timeSource,
          fetched_at: fetchedAt,
        },
        { onConflict: "device_id,recorded_at" },
      );

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("gps_points")
        .select("lat,lng,recorded_at")
        .eq("device_id", DEVICE_ID)
        .gte("recorded_at", since)
        .order("recorded_at", { ascending: true });

      track = (data ?? []).map((row) => ({
        lat: row.lat,
        lng: row.lng,
        recorded_at: row.recorded_at,
      }));
    }

    const speedKmh = getSpeedKmh(device);
    let computedSpeedKmh: number | null = null;
    if (track.length >= 2) {
      const last = track[track.length - 1];
      const prev = track[track.length - 2];
      const t1 = Date.parse(prev.recorded_at);
      const t2 = Date.parse(last.recorded_at);
      if (!Number.isNaN(t1) && !Number.isNaN(t2) && t2 > t1) {
        const distanceKm = haversineKm(prev.lat, prev.lng, last.lat, last.lng);
        const hours = (t2 - t1) / (1000 * 60 * 60);
        if (hours > 0) {
          computedSpeedKmh = distanceKm / hours;
        }
      }
    }

    const interfaces = Array.isArray(device?.interfaces) ? device.interfaces : [];
    const wanStatus = interfaces.map((iface: Record<string, unknown>) => ({
      id: iface.id ?? null,
      name: iface.name ?? "WAN",
      status: iface.status ?? "Unknown",
      ip: iface.ip ?? null,
      type: iface.type ?? null,
    }));

    return jsonResponse({
      device_id: DEVICE_ID,
      device_name: device?.name ?? null,
      lat,
      lng,
      updated_at: updatedAt,
      time_source: timeSource,
      fetched_at: fetchedAt,
      location_available: locationAvailable,
      speed_kmh: speedKmh ?? computedSpeedKmh,
      speed_kn: speedKmh
        ? speedKmh / 1.852
        : computedSpeedKmh
          ? computedSpeedKmh / 1.852
          : null,
      track,
      wan_status: wanStatus,
    });
  } catch (error) {
    return jsonResponse({ error: "Unexpected error.", details: String(error) }, 500);
  }
});
