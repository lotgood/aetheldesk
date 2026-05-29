# AethelDesk

> A quiet celestial productivity dashboard for a 5K Mac and iPad companion setup.

<p align="center">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-backend-009688?style=flat-square">
  <img alt="Vanilla JavaScript" src="https://img.shields.io/badge/Vanilla%20JS-frontend-f7df1e?style=flat-square">
  <img alt="No build step" src="https://img.shields.io/badge/no%20build%20step-static%20frontend-4b5563?style=flat-square">
</p>

AethelDesk is a minimal shared-room dashboard that blends a live celestial ambience with focus timing and synchronized lofi controls. Run it on your Mac, open the same room on your iPad, and use both screens as one calm workspace.

## What It Does

| Feature | Details |
|---|---|
| Celestial ambience | Backend calculates the sun state and broadcasts updates to connected clients. |
| Shared rooms | `/room/{room_id}` serves room-specific sessions from the same static frontend. |
| Focus mode | Starts a 50-minute Pomodoro timer with hidden YouTube playback. |
| Music sync | Play, pause, and skip controls broadcast to all connected clients. |
| Touch-friendly controls | Desktop controls auto-hide after idle; touch devices keep controls available. |

## Quick Start

Install dependencies and run the FastAPI server:

```bash
python -m pip install -r requirements-dev.txt
cd backend
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Open the dashboard from each device:

```text
http://<your-mac-ip>:8000
http://<your-mac-ip>:8000/room/<room-id>
```

Use the same room URL on your Mac and iPad to keep the experience synchronized.

## Controls

| Control | Behavior |
|---|---|
| Time slider | Drag to override sun position; double-click to return to real time. |
| Focus button | Toggles the Pomodoro timer and hidden music playback. |
| Music buttons | Play, pause, and skip are shared across connected clients. |
| Idle desktop UI | Controls fade after 3 seconds of mouse inactivity. |

## Configuration

| Setting | Location |
|---|---|
| Location latitude/longitude | `backend/celestial.py` |
| Default lofi YouTube video | `backend/main.py`, `state["music"]["video_id"]` |
| Skip playlist videos | `frontend/app.js`, `SKIP_IDS` |
| Pomodoro duration | `backend/main.py`, `state["pomodoro_duration"]` |

## Development

The app intentionally stays small:

- Static vanilla HTML, CSS, and JavaScript frontend
- FastAPI backend with in-memory process state
- No `package.json`
- No JavaScript build step

Project layout:

```text
aetheldesk/
|-- backend/
|   |-- celestial.py
|   `-- main.py
|-- frontend/
|   |-- app.js
|   |-- lobby.html
|   `-- room.html
|-- tests/
|   |-- test_backend_state.py
|   `-- test_frontend_static.py
|-- requirements.txt
`-- requirements-dev.txt
```

## Tests

Run the Python test suite from the project root:

```bash
python -m pytest
```

For a quick JavaScript syntax check:

```bash
node --check frontend/app.js
```
