# AethelDesk

Minimal celestial productivity dashboard for remote use on a 5K Mac and iPad.

## Quick Start

```bash
python -m pip install -r requirements-dev.txt
cd backend
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Open `http://<your-mac-ip>:8000` on both Mac and iPad.
`/room/{room_id}` serves `frontend/room.html` for room-specific sessions.

## Tests

Run from the project root:

```bash
python -m pytest
```

## Development Notes

- The frontend is static vanilla HTML, CSS, and JavaScript.
- There is no `package.json` and no JavaScript build step.
- Backend state is kept in memory per process.

## Config

| What | Where |
|---|---|
| Location (lat/lon) | `backend/celestial.py` line 5 |
| Default lofi YouTube ID | `backend/main.py`, `state["music"]["video_id"]` |
| Skip playlist IDs | `frontend/app.js`, `SKIP_IDS` array |
| Pomodoro duration | `backend/main.py`, `state["pomodoro_duration"]` (seconds) |

## Controls

- **Time slider**: drag to override sun position; double-click to reset to real time
- **Focus button**: toggles 50-min Pomodoro + hidden YouTube playback
- **iPad music controls**: Play / Pause / Skip broadcast to all connected clients
- Controls auto-hide after 3s of mouse idle on desktop and stay visible on touch
