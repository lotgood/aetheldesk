# FRONTEND KNOWLEDGE BASE

## OVERVIEW

The browser app is Vite + vanilla ES modules: `lobby.html`/`lobby.js` create or join rooms, and `room.html`/`app.js` orchestrate tokenized room sync, controls, scenes, and music.

## STRUCTURE

```text
lobby.html, lobby.js      # lobby PIN create/join flow and sky animation
room.html, app.js         # room UI shell plus tiny room-app bootstrap
scenes.js                 # scene controller and scene persistence
styles/                   # local Vite-served CSS and font fallback stacks
src/dom.js                # DOM, focus trap, hidden-interaction helpers
src/storage.js            # session/local storage contract
src/room-auth.js          # room PIN dialog and join retry
src/room-websocket.js     # tokenized WebSocket and reconnect behavior
src/room-controller.js    # room feature composition root
src/room-connection.js    # room auth + WebSocket composition
src/room-state.js         # backend snapshot application boundary
src/room-renderer.js      # render coordinator for room state
src/timer-view.js         # timer DOM/title/live-region rendering
src/timer-controls.js     # timer controls, slider, time override payloads
src/music-youtube.js      # YouTube iframe API and playlist controls
src/lobby-sky.js          # lobby canvas animation
src/scenes/               # city, beach, forest scene renderers
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Build/dev wiring | `../vite.config.js`, `../package.json` | Vite root is `frontend`; `/api` and `/ws` proxy to backend port `8000`. |
| Create/join lobby | `lobby.js`, `lobby.html` | Sends PIN only in POST body; stores token before navigation. |
| Room auth retry | `src/room-auth.js` | Dialog/focus semantics and generic Korean auth failure copy. |
| Room WebSocket | `src/room-websocket.js` | `/ws/${ROOM_ID}?token=...`; clear token on `1008`, reconnect otherwise. |
| Storage | `src/storage.js` | `sessionStorage` room tokens; `localStorage` playlist and scene only. |
| Accessibility helpers | `src/dom.js` | Reuse focus trap and hidden-interaction helpers. |
| UI state rendering | `src/room-renderer.js`, `src/celestial-renderer.js`, `src/timer-view.js`, `src/timer-controls.js` | ARIA state, title updates, live regions, timer payloads. |
| Music | `src/music-youtube.js` | YouTube iframe must remain hidden from keyboard/a11y tree. |
| Scenes | `scenes.js`, `src/scenes/*` | Scene button state, persistence, reduced-motion canvas behavior. |

## CONVENTIONS

- Keep stack as vanilla ES modules. No React, Vue, Svelte, TypeScript, or Webpack without separate approval.
- DOM ids in the HTML are coupled to JS modules and static tests; rename only with coordinated source and test updates.
- UI copy is Korean-primary for controls, validation, live regions, and status. Keep `AethelDesk`, `PIN`, YouTube terms, API fields, route names, and storage keys stable.
- Room tokens use `sessionStorage` key `room_token:{ROOM_ID}` where `ROOM_ID` is uppercase.
- `localStorage` ownership is limited to `playlist` and `scene`.
- Runtime styling and fonts are local under `styles/`; do not add external CSS/font origins. The YouTube iframe API is the only allowed runtime external script origin.
- Preserve `prefers-reduced-motion` handling in canvas/CSS paths.
- Keep the YouTube iframe and replacement iframe `aria-hidden`, `tabindex="-1"`, and `inert`.
- Frontend behavior is tested by Python source assertions plus Playwright, not by a JS unit runner.

## ANTI-PATTERNS (THIS PROJECT)

- Do not place PINs or tokens in URLs, `localStorage`, inline scripts, logs, or visible DOM.
- Do not add hidden tabbable controls; collapsed/hidden UI must be removed from tab order.
- Do not remove labels, live regions, dialog roles, focus traps, or reduced-motion behavior as "cosmetic."
- Do not store duration in dead `sessionStorage` keys; timer state comes from backend snapshots and UI controls.
- Do not commit `frontend/dist/`; it is generated output.

## VERIFY

```bash
npm run build
uv run pytest tests/test_frontend_static.py -q
uv run pytest tests/e2e -m e2e --browser chromium -q
```
