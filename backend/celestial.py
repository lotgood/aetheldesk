from datetime import datetime, time, timedelta, timezone
from typing import Callable

from astral import LocationInfo
from astral.sun import elevation, sunrise, sunset

DEFAULT = LocationInfo("Chuncheon", "Korea", "Asia/Seoul", 37.8813, 127.7298)


def _optional_event(event: Callable[..., datetime], *args, **kwargs) -> datetime | None:
    try:
        return event(*args, **kwargs)
    except ValueError:
        # Sunrise or sunset is legitimately absent during polar day/night.
        return None


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
    local_dt = dt.astimezone(tz)
    local_date = local_dt.date()
    current_sunrise = _optional_event(sunrise, loc.observer, date=local_date, tzinfo=tz)
    current_sunset = _optional_event(sunset, loc.observer, date=local_date, tzinfo=tz)
    sunrise_ts = current_sunrise.timestamp() if current_sunrise is not None else None
    sunset_ts = current_sunset.timestamp() if current_sunset is not None else None
    now_ts = dt.timestamp()

    def span_fraction(start: float, end: float) -> float:
        return max(0.0, min(1.0, (now_ts - start) / max(end - start, 1)))

    if sunrise_ts is not None and sunset_ts is not None:
        arc_pct = span_fraction(sunrise_ts, sunset_ts)
    elif sunrise_ts is not None:
        # The first midnight-sun date has a sunrise but no sunset. Travel from
        # the left horizon to the apex by local midnight, where the following
        # no-horizon dates hold steady.
        next_midnight = datetime.combine(local_date + timedelta(days=1), time.min, tzinfo=tz).timestamp()
        arc_pct = span_fraction(sunrise_ts, next_midnight) * 0.5
    elif sunset_ts is not None:
        # Symmetric defensive case for calendars/locations where a lone
        # sunset is reported at the end of a continuous polar day.
        midnight = datetime.combine(local_date, time.min, tzinfo=tz).timestamp()
        arc_pct = 0.5 + span_fraction(midnight, sunset_ts) * 0.5
    else:
        # The neutral apex avoids a midnight endpoint wrap while a polar sun
        # or moon remains continuously visible.
        arc_pct = 0.5

    # The moon animation is deliberately illustrative rather than an
    # ephemeris, but its progress still has to be authoritative for everyone
    # in a shared room. Compute sunset -> next sunrise on the server instead
    # of asking each browser to reinterpret the ISO value in its own timezone.
    night_arc_pct = 0.5
    if sunrise_ts is not None and now_ts < sunrise_ts:
        # Ask Astral only for the adjacent event we need. At high latitudes a
        # day's dawn/dusk may be undefined even while its sunrise/sunset is
        # valid; computing the full `sun()` mapping would then fail the room.
        previous_sunset = _optional_event(sunset, loc.observer, date=local_date - timedelta(days=1), tzinfo=tz)
        if previous_sunset is not None:
            night_start = previous_sunset.timestamp()
            night_arc_pct = (now_ts - night_start) / max(sunrise_ts - night_start, 1)
        else:
            night_arc_pct = 0.5
    elif sunset_ts is not None and now_ts > sunset_ts:
        night_start = sunset_ts
        following_sunrise = _optional_event(sunrise, loc.observer, date=local_date + timedelta(days=1), tzinfo=tz)
        if following_sunrise is not None:
            night_arc_pct = (now_ts - night_start) / max(following_sunrise.timestamp() - night_start, 1)
        else:
            night_arc_pct = 0.5
    elif sunrise_ts is not None and sunset_ts is not None:
        # Keep the illustrative moon path continuous across both horizons. It
        # finishes at 1.0 at sunrise, travels back across the hidden daytime
        # hemisphere, and reaches 0.0 at sunset ready for the next night arc.
        # Holding a fixed 0.5 during daylight made a still-half-visible moon
        # fly from the sunrise horizon to the apex on the first daytime tick.
        previous_sunset = _optional_event(sunset, loc.observer, date=local_date - timedelta(days=1), tzinfo=tz)
        following_sunrise = _optional_event(sunrise, loc.observer, date=local_date + timedelta(days=1), tzinfo=tz)
        if previous_sunset is None and following_sunrise is not None:
            # First day after polar night: meet the held apex at sunrise, then
            # return to the setting horizon over the visible day.
            night_arc_pct = 0.5 * (1.0 - arc_pct)
        elif previous_sunset is not None and following_sunrise is None:
            # Last day before polar night: approach the held apex at sunset.
            night_arc_pct = 1.0 - 0.5 * arc_pct
        elif previous_sunset is None and following_sunrise is None:
            night_arc_pct = 0.5
        else:
            night_arc_pct = 1.0 - arc_pct
    elif sunrise_ts is not None:
        # Lone sunrise into polar day: 1.0 at the horizon, 0.5 at midnight.
        night_arc_pct = 1.0 - arc_pct
    elif sunset_ts is not None:
        # Lone sunset out of polar day: 0.5 at midnight, 0.0 at the horizon.
        night_arc_pct = 1.0 - arc_pct
    else:
        night_arc_pct = 0.5
    night_arc_pct = max(0.0, min(1.0, night_arc_pct))

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
        "night_arc_pct": round(night_arc_pct, 4),
        "phase": "day" if elev > 0 else "night",
        "gradient": gradient,
        "iso": dt.isoformat(),
    }
