from astral import LocationInfo
from astral.sun import sun, elevation
from datetime import datetime, timezone, timedelta

DEFAULT = LocationInfo("Chuncheon", "Korea", "Asia/Seoul", 37.8813, 127.7298)


def get_celestial_state(dt: datetime | None = None, lat: float | None = None, lon: float | None = None) -> dict:
    if dt is None:
        dt = datetime.now(timezone.utc)
    elif dt.tzinfo is None:
        # Naive input: assume UTC so timestamp() is deterministic across hosts.
        dt = dt.replace(tzinfo=timezone.utc)

    if lat is not None and lon is not None:
        loc = LocationInfo("Custom", "", "UTC", lat, lon)
        # Approximate local tz from longitude (15° per hour) — enough to keep
        # sunrise/sunset on the right calendar day for the sky animation.
        tz = timezone(timedelta(hours=round(lon / 15)))
    else:
        loc = DEFAULT
        tz = loc.tzinfo

    elev = elevation(loc.observer, dt)
    # Resolve the local calendar date so sunrise/sunset belong to the day the
    # observer is actually living through, not the UTC day.
    local_date = dt.astimezone(tz).date()
    s = sun(loc.observer, date=local_date, tzinfo=tz)

    sunrise_ts = s["sunrise"].timestamp()
    sunset_ts = s["sunset"].timestamp()
    arc_pct = max(0.0, min(1.0, (dt.timestamp() - sunrise_ts) / max(sunset_ts - sunrise_ts, 1)))

    if elev > 45:
        gradient = ["#82CFFF", "#5BADE8"]  # deep midday blue
    elif elev > 20:
        gradient = ["#B8DFFF", "#7ABFDC"]  # clear sky blue
    elif elev > 5:
        gradient = ["#FFD080", "#FFA040"]  # warm morning / afternoon
    elif elev > 0:
        gradient = ["#FFB347", "#FF6B35"]  # golden hour
    elif elev > -6:
        gradient = ["#2C1654", "#FF6B35"]  # civil twilight
    elif elev > -12:
        gradient = ["#1A0A2E", "#2C1654"]  # nautical twilight
    else:
        gradient = ["#0A0A14", "#1A0A2E"]  # night

    return {
        "elevation": round(elev, 2),
        "arc_pct": round(arc_pct, 4),
        "phase": "day" if elev > 0 else "night",
        "gradient": gradient,
        "iso": dt.isoformat(),
    }
