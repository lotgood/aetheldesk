from datetime import datetime
from zoneinfo import ZoneInfo

from backend.celestial import get_celestial_state


def test_night_arc_progress_is_server_authoritative_and_monotonic() -> None:
    seoul = ZoneInfo("Asia/Seoul")
    evening = get_celestial_state(datetime(2026, 8, 24, 20, 0, tzinfo=seoul))["night_arc_pct"]
    midnight = get_celestial_state(datetime(2026, 8, 25, 0, 0, tzinfo=seoul))["night_arc_pct"]
    predawn = get_celestial_state(datetime(2026, 8, 25, 5, 0, tzinfo=seoul))["night_arc_pct"]

    assert 0 <= evening < midnight < predawn <= 1


def test_hidden_daytime_moon_arc_returns_continuously_toward_sunset() -> None:
    seoul = ZoneInfo("Asia/Seoul")
    morning = get_celestial_state(datetime(2026, 8, 24, 7, 0, tzinfo=seoul))
    noon = get_celestial_state(datetime(2026, 8, 24, 12, 0, tzinfo=seoul))
    evening = get_celestial_state(datetime(2026, 8, 24, 18, 0, tzinfo=seoul))

    assert {morning["phase"], noon["phase"], evening["phase"]} == {"day"}
    for state in (morning, noon, evening):
        assert abs(state["night_arc_pct"] - (1 - state["arc_pct"])) <= 0.0001
    assert morning["night_arc_pct"] > noon["night_arc_pct"] > evening["night_arc_pct"]


def test_night_arc_uses_only_required_adjacent_event_at_high_latitude() -> None:
    # On the following date Astral can resolve sunrise but not the full sun()
    # mapping because nautical dusk does not occur. The night arc still has
    # all information it needs and must remain available.
    just_after_sunset = datetime(2026, 5, 8, 21, 11, 19, tzinfo=ZoneInfo("UTC"))

    state = get_celestial_state(just_after_sunset, lat=66.5, lon=0)

    assert state["phase"] == "night"
    assert 0 <= state["night_arc_pct"] < 0.01


def test_polar_day_and_night_hold_a_stable_apex_when_horizons_are_absent() -> None:
    utc = ZoneInfo("UTC")
    summer = get_celestial_state(datetime(2026, 6, 21, 12, 0, tzinfo=utc), lat=70, lon=0)
    winter = get_celestial_state(datetime(2026, 12, 21, 12, 0, tzinfo=utc), lat=70, lon=0)

    assert summer["phase"] == "day"
    assert winter["phase"] == "night"
    assert summer["arc_pct"] == winter["arc_pct"] == 0.5
    assert summer["night_arc_pct"] == winter["night_arc_pct"] == 0.5

    before_midnight = get_celestial_state(datetime(2026, 6, 21, 23, 59, 59, 999999, tzinfo=utc), lat=70, lon=0)
    after_midnight = get_celestial_state(datetime(2026, 6, 22, 0, 0, tzinfo=utc), lat=70, lon=0)
    assert before_midnight["arc_pct"] == after_midnight["arc_pct"] == 0.5
    assert before_midnight["night_arc_pct"] == after_midnight["night_arc_pct"] == 0.5


def test_polar_transition_days_join_the_held_apex_without_a_visible_jump() -> None:
    utc = ZoneInfo("UTC")
    boundaries = (
        (
            get_celestial_state(datetime(2026, 6, 30, 0, 15, 48, tzinfo=utc), lat=66, lon=0),
            get_celestial_state(datetime(2026, 6, 30, 0, 15, 51, tzinfo=utc), lat=66, lon=0),
        ),
        (
            get_celestial_state(datetime(2026, 12, 8, 12, 7, 15, tzinfo=utc), lat=68, lon=0),
            get_celestial_state(datetime(2026, 12, 8, 12, 7, 18, tzinfo=utc), lat=68, lon=0),
        ),
        (
            get_celestial_state(datetime(2026, 6, 13, 23, 59, 59, tzinfo=utc), lat=66, lon=0),
            get_celestial_state(datetime(2026, 6, 14, 0, 0, 0, tzinfo=utc), lat=66, lon=0),
        ),
    )

    for before, after in boundaries:
        assert abs(before["arc_pct"] - after["arc_pct"]) <= 0.001
        assert abs(before["night_arc_pct"] - after["night_arc_pct"]) <= 0.001
