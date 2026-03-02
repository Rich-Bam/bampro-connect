from __future__ import annotations

from typing import Any, Dict, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

ORG_ID = "17vnF6"
DEVICE_ID = 3

TOKEN_URL = "https://api.ic.peplink.com/api/oauth2/token"
API_BASE = "https://api.ic.peplink.com/rest"

MASKED_FIELDS = {
    "sn",
    "lan_mac",
    "wtp_ip",
    "ddns_name",
    "site_id",
    "imei",
    "iccid",
    "imsi",
    "meid_hex",
    "meid_dec",
    "esn",
}

app = FastAPI(title="Peplink GPS API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PeplinkAuthError(RuntimeError):
    pass


class PeplinkApiError(RuntimeError):
    pass


def _get_env(name: str) -> str:
    import os

    value = os.getenv(name)
    if not value:
        raise PeplinkAuthError(f"Missing environment variable: {name}")
    return value


def _mask_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _mask_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_mask_value(item) for item in value]
    return value


def _mask_device_fields(device: Dict[str, Any]) -> Dict[str, Any]:
    sanitized: Dict[str, Any] = {}
    for key, value in device.items():
        if key in MASKED_FIELDS:
            sanitized[key] = "***"
            continue
        sanitized[key] = _mask_value(value)
    return sanitized


async def _fetch_access_token(client: httpx.AsyncClient) -> str:
    payload = {
        "client_id": _get_env("PEPLINK_CLIENT_ID"),
        "client_secret": _get_env("PEPLINK_CLIENT_SECRET"),
        "grant_type": "client_credentials",
    }
    response = await client.post(TOKEN_URL, data=payload)
    if response.status_code != 200:
        raise PeplinkApiError(
            f"Token request failed ({response.status_code}): {response.text}"
        )
    data = response.json()
    token = data.get("access_token")
    if not token:
        raise PeplinkApiError("Token response missing access_token.")
    return token


async def _fetch_devices(client: httpx.AsyncClient, access_token: str) -> Dict[str, Any]:
    response = await client.get(
        f"{API_BASE}/o/{ORG_ID}/d",
        params={"has_status": "true", "access_token": access_token},
    )
    if response.status_code != 200:
        raise PeplinkApiError(
            f"Device request failed ({response.status_code}): {response.text}"
        )
    return response.json()


def _extract_location(device: Dict[str, Any]) -> tuple[Optional[float], Optional[float]]:
    candidates = [
        ("latitude", "longitude"),
        ("lat", "lng"),
        ("lat", "lon"),
    ]
    for lat_key, lng_key in candidates:
        if lat_key in device and lng_key in device:
            return _coerce_float(device.get(lat_key)), _coerce_float(device.get(lng_key))

    gps = device.get("gps")
    if isinstance(gps, dict):
        return _coerce_float(gps.get("lat")), _coerce_float(gps.get("lng"))

    starlink_status = device.get("starlink_status")
    if isinstance(starlink_status, list) and starlink_status:
        entry = starlink_status[0]
        if isinstance(entry, dict):
            gps_location = entry.get("gpsLocation")
            if isinstance(gps_location, dict):
                lla = gps_location.get("lla")
                if isinstance(lla, dict):
                    return _coerce_float(lla.get("lat")), _coerce_float(lla.get("lon"))

    return None, None


def _coerce_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


async def _get_device_payload() -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=20) as client:
        token = await _fetch_access_token(client)
        payload = await _fetch_devices(client, token)

    devices = payload.get("data") or []
    device = next((item for item in devices if item.get("id") == DEVICE_ID), None)
    if not device:
        raise PeplinkApiError("Device not found in organization.")
    return device


@app.get("/api/peplink/location")
async def get_location() -> Dict[str, Any]:
    try:
        device = await _get_device_payload()
    except PeplinkAuthError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except PeplinkApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    lat, lng = _extract_location(device)
    location_available = lat is not None and lng is not None

    return {
        "device_id": DEVICE_ID,
        "device_name": device.get("name"),
        "lat": lat,
        "lng": lng,
        "updated_at": device.get("last_ic2_online_time") or device.get("last_online"),
        "location_available": location_available,
    }


@app.get("/api/peplink/raw")
async def get_raw_device() -> Dict[str, Any]:
    try:
        device = await _get_device_payload()
    except PeplinkAuthError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except PeplinkApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return _mask_device_fields(device)
