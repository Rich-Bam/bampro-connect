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

function getStarlinkGpsTimestamp(device: Record<string, unknown>) {
  const starlink = (device as { starlink_status?: Array<Record<string, unknown>> })
    ?.starlink_status?.[0];
  const gpsLocation = starlink?.gpsLocation as Record<string, unknown> | undefined;
  return pickLatestTimestamp(gpsLocation?.timestamp, gpsLocation?.time, gpsLocation?.ts);
}

function getSpeedKmh(device: Record<string, unknown>) {
  const starlink = (device as { starlink_status?: Array<Record<string, unknown>> })
    ?.starlink_status?.[0];
  const gpsLoc = starlink?.gpsLocation as Record<string, unknown> | undefined;

  const candidates = [
    device?.speed,
    device?.speed_kmh,
    device?.gps_speed,
    device?.gps?.speed,
    device?.gps?.speed_kmh,
    device?.gps?.speedKmh,
    device?.gpsLocation?.speed,
    gpsLoc?.speed,
    gpsLoc?.speed_kmh,
    gpsLoc?.speedKmh,
    starlink?.speed,
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Minimum segment duration (avoid noise from tiny deltas). */
const MIN_SEGMENT_AGE_MS = 3 * 1000; // 3 seconds
/** Maximum segment duration – longer gaps (e.g. offline) give misleading average speed. */
const MAX_SEGMENT_AGE_MS = 5 * 60 * 1000; // 5 minutes
/** For current position segment, allow longer gaps to show speed when site was closed. */
const MAX_CURRENT_SEGMENT_AGE_MS = 30 * 60 * 1000; // 30 minutes

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

    const groupId = typeof device?.group_id === "number" ? device.group_id : null;
    const fetchedAt = new Date().toISOString();

    // Fetch Peplink's own track (matches InControl map) when available
    let peplinkTrack: Array<{ lat: number; lng: number; recorded_at: string; sp?: number }> = [];
    const usePeplinkTrack = (Deno.env.get("USE_PEPLINK_TRACK") ?? "true").toLowerCase() !== "false";
    if (usePeplinkTrack && groupId != null) {
      const toIso = (d: Date) => d.toISOString().slice(0, 19);
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      // API requires start/end on same day; fetch today and yesterday
      const dayRanges: [string, string][] = [
        [toIso(startOfToday), toIso(now)],
      ];
      const startOfYesterday = new Date(startOfToday);
      startOfYesterday.setDate(startOfYesterday.getDate() - 1);
      const endOfYesterday = new Date(startOfToday.getTime() - 1);
      dayRanges.push([toIso(startOfYesterday), toIso(endOfYesterday)]);
      const allPoints: Array<{ lat: number; lng: number; recorded_at: string; sp?: number }> = [];
      for (const [startStr, endStr] of dayRanges) {
        const locUrl = `${API_BASE}/o/${ORG_ID}/g/${groupId}/d/${DEVICE_ID}/loc?start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(endStr)}&access_token=${accessToken}`;
        try {
          const locRes = await fetch(locUrl);
          if (locRes.ok) {
            const locParsed = await safeJson(locRes);
            if (locParsed.ok && Array.isArray(locParsed.json?.data)) {
              const points = locParsed.json.data as Array<{ lo?: number; la?: number; ts?: string; sp?: number }>;
              for (const p of points) {
                if (typeof p.la === "number" && typeof p.lo === "number" && p.ts) {
                  allPoints.push({
                    lat: p.la,
                    lng: p.lo,
                    recorded_at: String(p.ts),
                    sp: typeof p.sp === "number" ? p.sp : undefined,
                  });
                }
              }
            }
          }
        } catch {
          // Ignore this day
        }
      }
      peplinkTrack = allPoints.sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
    }

    // Device GPS (InControl – matches Peplink Mars; may be spoofed)
    const deviceLatRaw = device?.latitude;
    const deviceLngRaw = device?.longitude;
    const deviceLat =
      typeof deviceLatRaw === "number" && !Number.isNaN(deviceLatRaw) && deviceLatRaw >= -90 && deviceLatRaw <= 90
        ? deviceLatRaw
        : null;
    const deviceLng =
      typeof deviceLngRaw === "number" && !Number.isNaN(deviceLngRaw) && deviceLngRaw >= -180 && deviceLngRaw <= 180
        ? deviceLngRaw
        : null;
    const deviceLocationAvailable = deviceLat !== null && deviceLng !== null;
    const deviceLocationTimestamp = (() => {
      const ts = device?.location_timestamp;
      if (ts == null) return null;
      if (typeof ts === "number" && !Number.isNaN(ts)) {
        return new Date(ts * 1000).toISOString();
      }
      if (typeof ts === "string" && ts.trim() !== "") {
        const parsed = Date.parse(ts);
        return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
      }
      return null;
    })();

    // Starlink GPS (priority 1 – trusted)
    const starlinkStatus = device?.starlink_status?.[0];
    const gpsLocation = starlinkStatus?.gpsLocation as Record<string, unknown> | undefined;
    const gpsLla = gpsLocation?.lla as Record<string, unknown> | undefined;
    const starlinkLat = typeof gpsLla?.lat === "number" ? gpsLla.lat : null;
    const starlinkLng = typeof gpsLla?.lon === "number" ? gpsLla.lon : null;
    const starlinkLocationAvailable = starlinkLat !== null && starlinkLng !== null;
    const gpsReportedAt = getStarlinkGpsTimestamp(device);

    // Source selection: Starlink first, device GPS fallback (device may be spoofed)
    let lat: number | null;
    let lng: number | null;
    let updatedAt: string;
    let timeSource: string;
    let gpsSource: "starlink" | "device" | null = null;

    if (starlinkLocationAvailable) {
      lat = starlinkLat;
      lng = starlinkLng;
      updatedAt = gpsReportedAt ?? fetchedAt;
      timeSource = gpsReportedAt ? "starlink_gps" : "starlink_gps_no_time";
      gpsSource = "starlink";
    } else if (deviceLocationAvailable) {
      lat = deviceLat;
      lng = deviceLng;
      updatedAt = deviceLocationTimestamp ?? fetchedAt;
      timeSource = deviceLocationTimestamp ? "device_gps" : "device_gps_no_time";
      gpsSource = "device";
    } else {
      lat = null;
      lng = null;
      updatedAt = fetchedAt;
      timeSource = "fetched_at";
    }

    let locationFallback = false;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    let track: Array<{ lat: number; lng: number; recorded_at: string }> = [];

    if (supabaseUrl && serviceRoleKey) {
      const supabase = createClient(supabaseUrl, serviceRoleKey);

      const { data: lastPoint } = await supabase
        .from("gps_points")
        .select("lat,lng,recorded_at,time_source")
        .eq("device_id", DEVICE_ID)
        .order("recorded_at", { ascending: false })
        .limit(1);
      const fallback = lastPoint?.[0];

      if (lat !== null && lng !== null) {
        let recordedAt = updatedAt ?? fetchedAt;
        if (fallback?.recorded_at) {
          const lastTime = Date.parse(fallback.recorded_at);
          const nextTime = Date.parse(recordedAt);
          if (!Number.isNaN(lastTime) && !Number.isNaN(nextTime) && nextTime <= lastTime) {
            recordedAt = fetchedAt;
            const hasGpsTime = timeSource === "starlink_gps" || timeSource === "device_gps";
            timeSource = hasGpsTime ? timeSource.replace("_gps", "_gps_stale") : "fetched_at";
          }
        }
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
      } else if (fallback) {
        lat = fallback.lat;
        lng = fallback.lng;
        updatedAt = fallback.recorded_at;
        timeSource = "gps_points_fallback";
        locationFallback = true;
        // Derive gps_source from cached point's original source
        const src = typeof fallback.time_source === "string" ? fallback.time_source : "";
        gpsSource = src.startsWith("starlink") ? "starlink" : src.startsWith("device") ? "device" : null;
      }

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("gps_points")
        .select("lat,lng,recorded_at")
        .eq("device_id", DEVICE_ID)
        .gte("recorded_at", since)
        .order("recorded_at", { ascending: true });

      const dbTrack = (data ?? []).map((row) => ({
        lat: row.lat,
        lng: row.lng,
        recorded_at: row.recorded_at,
      }));

      // Use Peplink's track when available (matches InControl map); otherwise gps_points
      track = peplinkTrack.length > 0
        ? peplinkTrack.map((p) => ({ lat: p.lat, lng: p.lng, recorded_at: p.recorded_at }))
        : dbTrack;
    } else if (peplinkTrack.length > 0) {
      track = peplinkTrack.map((p) => ({ lat: p.lat, lng: p.lng, recorded_at: p.recorded_at }));
    }

    // Append current position to track so the blue line always connects to the marker
    if (lat !== null && lng !== null) {
      const lastTrack = track[track.length - 1];
      const isDifferent =
        !lastTrack ||
        Math.abs(lastTrack.lat - lat) > 1e-6 ||
        Math.abs(lastTrack.lng - lng) > 1e-6;
      if (isDifferent) {
        track = [...track, { lat, lng, recorded_at: fetchedAt }];
      }
    }

    let speedKmh = getSpeedKmh(device);
    let usedPeplinkSpeed = false;
    // Prefer Peplink's speed from their track when using it (matches InControl display)
    if (speedKmh == null && peplinkTrack.length > 0) {
      const lastPoint = peplinkTrack[peplinkTrack.length - 1];
      if (typeof lastPoint?.sp === "number" && lastPoint.sp >= 0) {
        speedKmh = lastPoint.sp; // Peplink returns km/h
        usedPeplinkSpeed = true;
      }
    }
    let computedSpeedKmh: number | null = null;
    let speedSource: "api" | "computed" | "computed_smoothed" | "peplink_track" | null = null;

    if (track.length >= 2 && lat !== null && lng !== null) {
      const fetchedAtMs = Date.parse(fetchedAt);
      const segmentSpeeds: number[] = [];
      let mostRecentSpeed: number | null = null;

      // Current segment: last DB point to live position (most responsive)
      // Use a longer max gap for current segment so speed updates when site was briefly closed
      if (!locationFallback && track.length >= 2) {
        const prev = track[track.length - 2]; // current position is at length-1 (appended above)
        const t1 = Date.parse(prev.recorded_at);
        const deltaMs = fetchedAtMs - t1;
        if (
          !Number.isNaN(t1) &&
          !Number.isNaN(fetchedAtMs) &&
          deltaMs >= MIN_SEGMENT_AGE_MS &&
          deltaMs <= MAX_CURRENT_SEGMENT_AGE_MS
        ) {
          const distanceKm = haversineKm(prev.lat, prev.lng, lat, lng);
          const hours = deltaMs / (1000 * 60 * 60);
          if (hours > 0) {
            mostRecentSpeed = distanceKm / hours;
          }
        }
      }

      // Historical segments with valid time deltas (last ~10 segments for fallback)
      const histStart = Math.max(0, track.length - 12);
      for (let i = histStart; i < track.length - 1; i++) {
        const a = track[i];
        const b = track[i + 1];
        const t1 = Date.parse(a.recorded_at);
        const t2 = Date.parse(b.recorded_at);
        const deltaMs = t2 - t1;
        if (
          !Number.isNaN(t1) &&
          !Number.isNaN(t2) &&
          deltaMs >= MIN_SEGMENT_AGE_MS &&
          deltaMs <= MAX_SEGMENT_AGE_MS
        ) {
          const distanceKm = haversineKm(a.lat, a.lng, b.lat, b.lng);
          const hours = deltaMs / (1000 * 60 * 60);
          if (hours > 0) {
            segmentSpeeds.push(distanceKm / hours);
          }
        }
      }

      if (mostRecentSpeed != null) {
        computedSpeedKmh = mostRecentSpeed;
        speedSource = "computed";
      } else if (segmentSpeeds.length >= 2) {
        computedSpeedKmh = median(segmentSpeeds);
        speedSource = "computed_smoothed";
      } else if (segmentSpeeds.length >= 1) {
        computedSpeedKmh = segmentSpeeds[segmentSpeeds.length - 1];
        speedSource = "computed";
      }
    }

    const useApiSpeed = speedKmh != null && (speedKmh > 0 || usedPeplinkSpeed);
    const effectiveSpeedKmh = useApiSpeed ? speedKmh : computedSpeedKmh;
    if (usedPeplinkSpeed) {
      speedSource = "peplink_track";
    } else if (speedKmh != null && speedKmh > 0) {
      speedSource = "api";
    }

    const interfaces = Array.isArray(device?.interfaces) ? device.interfaces : [];
    const wanStatus = interfaces.map((iface: Record<string, unknown>) => ({
      id: iface.id ?? null,
      name: iface.name ?? "WAN",
      status: iface.status ?? "Unknown",
      ip: iface.ip ?? null,
      type: iface.type ?? null,
    }));

    const locationAvailable = lat !== null && lng !== null;

    const response: Record<string, unknown> = {
      device_id: DEVICE_ID,
      device_name: device?.name ?? null,
      lat,
      lng,
      updated_at: updatedAt,
      time_source: timeSource,
      fetched_at: fetchedAt,
      location_available: locationAvailable,
      location_fallback: locationFallback,
      speed_kmh: effectiveSpeedKmh,
      speed_kn: effectiveSpeedKmh != null ? effectiveSpeedKmh / 1.852 : null,
      speed_source: speedSource,
      track,
      wan_status: wanStatus,
    };
    if (gpsSource != null) {
      response.gps_source = gpsSource;
    }
    return jsonResponse(response);
  } catch (error) {
    return jsonResponse({ error: "Unexpected error.", details: String(error) }, 500);
  }
});
