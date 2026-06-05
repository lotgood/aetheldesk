# Task 9 UX Discovery Audit

Discovery only. This audit is grounded in `frontend/lobby.html`, `frontend/room.html`, `frontend/app.js`, `frontend/scenes.js`, the current e2e flows, and Playwright inspection against `http://127.0.0.1:8019`. No UI or behavior changes were made.

Evidence files:

- `.omo/evidence/task-9-ux-keyboard.md`
- `.omo/evidence/task-9-ux-mobile-motion.md`

Selectors explicitly covered: `#pin-input`, `#btn-start`, `#room-auth`, `#focus-btn`, `#time-slider`, `#music-bar`, `#exit-confirm`.

## Lobby Create

- Current DOM: `#pin-input` is a password input with placeholder `방 PIN`; `#btn-start` posts `POST /api/rooms` and creates a random room unless `#room-input` has a value.
- Playwright finding: desktop tab order starts `#pin-input` -> `#btn-start` -> `#code-toggle`, which supports the primary create path.
- Accessibility finding: `#pin-input` has no explicit `<label>` or `aria-label`; the placeholder is the only accessible name in the snapshot. `#lobby-error` is text-only and has no `aria-live`, so `입장할 수 없습니다` may not be announced.
- Copy finding: create action is Korean (`시작`) but the brand heading and PIN acronym remain English. This is acceptable for now, but Task 10 should decide whether PIN stays untranslated.
- Priority: Task 10 candidate. Add persistent labels or `aria-label`s for `#pin-input` and make `#lobby-error` polite live status without changing the storage/API contract.

## Lobby Join

- Current DOM: `#code-toggle` opens `#code-section`, focuses `#room-input` after 380 ms, and `#btn-join` calls join. Tests currently click `#btn-start` after filling `#room-input`, so the start button also acts as create-or-join depending on backend state.
- Playwright finding: before `#code-toggle` is opened, hidden `#room-input` and `#btn-join` are still in keyboard tab order even though `#code-section` has `max-height: 0`, `opacity: 0`, and `pointer-events: none`.
- Accessibility finding: the toggle does not expose `aria-expanded` or an `aria-controls` relationship to `#code-section`, so screen reader users do not get state feedback.
- Journey hypothesis: keyboard users can land on invisible join controls and think focus is lost. This is likely the highest-friction lobby issue.
- Priority: Task 10 candidate. When collapsed, remove `#room-input` and `#btn-join` from tab order or hide the region semantically; add expanded state to `#code-toggle`.

## Room Auth

- Current DOM: `#room-auth` is a hidden/flex overlay shown when `sessionStorage` has no `room_token:{ROOM_ID}` or the WebSocket closes with code `1008`; `#room-pin-input` and `#room-pin-submit` retry the join API.
- Playwright finding: with no token, focus lands in `#room-pin-input`, wrong PIN displays `입장할 수 없습니다`, and screenshot `task-9-room-auth.png` captured the overlay state.
- Accessibility finding: `#room-auth` is not a semantic modal (`role="dialog"`, `aria-modal="true"`, labelled title), and focus is not trapped. Tabbing moved from `#room-pin-submit` to the hidden off-screen `#yt-frame` and then to `body` instead of cycling inside the auth prompt.
- Error/status finding: `#room-auth-error` has no `aria-live`, so the wrong-PIN message may not be announced.
- Priority: Task 10 candidate. Make `#room-auth` a real modal dialog and keep focus within `#room-pin-input`/`#room-pin-submit` while visible.

## Connection Status

- Current DOM: `#conn-dot` is a visual-only dot whose opacity is changed on WebSocket open/close; `#clock` and `#date-label` are visible adjacent context.
- Playwright finding: computed `#conn-dot` opacity was non-zero after room connection, but it has no text alternative, `role`, `aria-label`, or live status.
- Journey hypothesis: users without visual access cannot tell whether the shared room is connected, reconnecting, or blocked by auth.
- Priority: Task 10 candidate. Add a visually hidden Korean status label or live region tied to WebSocket state. Keep the dot as decoration.

## Timer Controls

- Current DOM: `#focus-btn` starts focus, duration buttons live inside `#dur-chips`, and active controls are `#btn-pause-timer`, `#btn-cancel-timer`, and `#btn-skip-break`.
- Playwright finding: in idle state, inactive timer controls are visually hidden/disabled with opacity and `pointer-events: none`, but they remain tabbable before the timer starts.
- Accessibility finding: duration buttons have no stable active state exposed. `updateDurChips()` toggles class `active`, while CSS reads `data-active="true"`, so selected duration is not visibly or semantically represented by the current DOM.
- Copy finding: `#focus-btn` says `Focus`; active controls say `정지`, `취소`, and break row text is English `break` / `skip`. This conflicts with the future Korean-primary direction.
- Priority: Task 10 candidate. Fix focusability of inactive timer controls, expose selected duration with `aria-pressed`, and convert timer copy to Korean-primary.

## Music Input

- Current DOM: `#music-bar` is hidden until a saved playlist exists or a track is added; `#btn-add-track` swaps `#action-bar` for `#track-row`; `#track-input` accepts a YouTube URL or video ID.
- Playwright finding: opening the track row focuses `#track-input`, Escape closes it, and `#music-bar` starts at `opacity: 0` with `pointer-events: none`.
- Accessibility finding: hidden `#music-bar` buttons (`#btn-pause`, `#btn-play`, `#btn-skip`) are still tabbable while `pointer-events: none`, creating invisible keyboard stops.
- Error finding: invalid track input only changes the border color; no text error or live region explains what failed.
- Priority: Task 10 candidate. Remove hidden music controls from tab order until visible and add an inline Korean validation message for invalid YouTube input.

## Time Slider

- Current DOM: `#time-slider` is a range input from `0` to `1439`; `#time-dial` has title `시간을 드래그하여 조절 (더블클릭으로 리셋)`; `#btn-reset-time` says `지금`.
- Playwright finding: keyboard ArrowRight changes `#time-slider`, but the input has no `aria-label`, no visible current time value, and no formatted `aria-valuetext`.
- Journey hypothesis: sighted mouse users can discover the control through the title; keyboard and screen reader users only hear a generic range with numeric minutes.
- Priority: Task 10 candidate. Label `#time-slider`, expose formatted time such as `10:55`, and keep double-click reset as a supplementary shortcut rather than the only discoverable reset cue.

## Scene Switching

- Current DOM: `#btn-scene` cycles `sky -> city -> beach -> forest`, updates button text such as `◈ 도시`, and persists `scene` in `localStorage`.
- Playwright finding: click changed button text to `◈ 도시`, `localStorage.scene` to `city`, and `body.dataset.scene` to `city`.
- Accessibility finding: there is no announcement that the scene changed and no menu/list semantics that tells users all possible scenes.
- Motion finding: city, beach, and forest canvas loops use `requestAnimationFrame` and continue under reduced-motion emulation.
- Priority: Task 10 candidate for state announcement and Korean copy. Later/out of scope: richer scene picker or preview UI.

## Geolocation

- Current DOM: `#btn-locate` calls `navigator.geolocation?.getCurrentPosition(...)`; on success it sends `{ type: "location" }`, and on failure it silently does nothing.
- Playwright finding: pressing `#btn-locate` produced no visible confirmation, pending state, denied-permission message, or status text in the page body.
- Journey hypothesis: users cannot tell whether location improved the celestial state, was denied, or is unsupported.
- Priority: Task 10 candidate. Add Korean status/error feedback and avoid prompting without explaining why location is being requested. Later/out of scope: saved location preferences.

## Exit Confirmation

- Current DOM: `#exit-confirm` appears only when the timer is active and `#btn-exit` is pressed; it contains `정말 나가시겠어요?`, `#btn-exit-yes`, and `#btn-exit-no`.
- Playwright finding: after starting focus with `#focus-btn`, pressing `#btn-exit` displayed `#exit-confirm`; screenshot `task-9-room-exit-confirm.png` captured the state.
- Accessibility finding: focus was not moved into `#exit-confirm` after it appeared, and the prompt is not a dialog/alertdialog. Keyboard users may remain on the now-hidden action bar or lose context.
- Priority: Task 10 candidate. Move focus to `#btn-exit-no` or the confirmation group, expose it as an alert/dialog, and return focus to `#btn-exit` if cancelled.

## Mobile Layouts

- Current DOM/CSS: portrait breakpoint applies at `orientation: portrait` and `max-width: 600px`; landscape compact applies at `orientation: landscape` and `max-height: 480px`.
- Playwright portrait finding: at `390x844`, lobby and room had no body overflow; `#action-bar` fit inside the viewport, but `#time-dial` and `#controls` occupy the same bottom band (`#time-dial` y `737`, `#controls` y `727`) and can visually compete.
- Playwright landscape finding: at `844x390`, room had no body overflow; controls moved to bottom-right and `#time-dial` stayed bottom-left, matching the compact CSS intent.
- Touch finding: Playwright viewport resizing alone did not emulate touch, so desktop auto-hide behavior still applied unless mouse movement revealed controls. Real touch-device behavior depends on `navigator.maxTouchPoints > 1`.
- Priority: Task 10 candidate. Verify on a real or emulated touch context and increase vertical separation between `#time-dial` and `#controls` in portrait if screenshots show overlap on iPad/phone sizes.

## Reduced Motion

- Playwright finding: `matchMedia('(prefers-reduced-motion: reduce)').matches` was true under emulation, but CSS animations remained active: `#conn-dot` used `conn-pulse`, `#focus-btn::after` used `focus-breathe`, `.sun-corona`/`.sun-bloom`/`.moon-halo` used `orb-breathe`, and entry elements still used `fade-rise`.
- Canvas finding: lobby sky, clouds, stars, room clouds, and scene canvases continue to update via `requestAnimationFrame`; scene switching also keeps transition durations such as `1.5s` on canvases.
- Accessibility risk: motion-sensitive users cannot opt out of continuous orbit, pulse, cloud, scene, and crossfade motion.
- Priority: Task 10 candidate. Add a `prefers-reduced-motion: reduce` CSS/JS path that disables decorative CSS animations, shortens transitions, and freezes or reduces canvas loops while preserving core room sync.

## Korean Copy

- Current mixed copy: `AethelDesk`, `PIN`, `Focus`, `Room PIN`, `YouTube URL`, `break`, and `skip` remain English; core actions such as `시작`, `입장`, `정지`, `취소`, `재생`, `다음`, `위치`, and `나가기` are Korean.
- Glossary proposal for Task 10:

| Current | Korean-primary candidate | Notes |
|---|---|---|
| Focus | 집중 시작 | Button on `#focus-btn`; could shorten to `집중` if space is tight. |
| Room PIN | 방 PIN | Keep PIN acronym if project treats it as a product/security term. |
| PIN | PIN | Use consistently after first mention. |
| break | 휴식 | Timer break row. |
| skip | 건너뛰기 | Use for break skip; music can remain `다음`. |
| YouTube URL 또는 영상 ID | YouTube URL 또는 영상 ID | Already understandable; Task 10 can decide whether `영상 링크 또는 ID` is warmer. |
| ◈ 하늘 / 도시 / 해변 / 숲 | Same | Scene labels are already Korean-primary. |

- Priority: Task 10 candidate. Make interactive/state copy Korean-primary while keeping brand and technical acronyms stable.

## Accessibility Audit

- Labels: `#pin-input`, `#room-pin-input`, `#time-slider`, and `#track-input` rely on placeholders/title text rather than explicit labels.
- Live regions: `#lobby-error`, `#room-auth-error`, connection state, geolocation outcome, scene changes, timer start/pause/cancel, and invalid track input do not expose live announcements.
- Focus management: collapsed lobby join controls, inactive timer controls, hidden `#music-bar`, and off-screen `#yt-frame` are reachable by Tab when they should not be.
- Modal behavior: `#room-auth` and `#exit-confirm` are visual overlays/prompts without dialog semantics or focus trapping/return.
- Motion preference: reduced-motion emulation does not change the decorative CSS/canvas motion profile.

## Korean Language Consistency Glossary

Use this as the starting Task 10 copy contract:

| Concept | Preferred Korean | Selector/context |
|---|---|---|
| Create/start from lobby | 시작 | `#btn-start` |
| Join room | 입장 | `#btn-join`, `#room-pin-submit` |
| Room PIN | 방 PIN | `#pin-input`, `#room-auth` |
| Focus session | 집중 | `#focus-btn`, timer status |
| Pause | 정지 or 일시정지 | `#btn-pause-timer`, `#btn-pause`; choose one consistently. |
| Resume | 재개 | Timer paused state. |
| Cancel | 취소 | Timer, track, exit prompts. |
| Break | 휴식 | Break row. |
| Skip break | 건너뛰기 | `#btn-skip-break` |
| Music next | 다음 | `#btn-skip` |
| Location | 위치 | `#btn-locate` plus status message. |
| Exit | 나가기 | `#btn-exit`, `#exit-confirm` |

## User Journey Problem Hypotheses

- Keyboard-first lobby user: after `#code-toggle` is closed, Tab moves to invisible `#room-input`/`#btn-join`, creating a perceived trap before the page wraps.
- Returning room user with expired token: `#room-auth` appears and focuses the PIN field, but Tab leaves the prompt and wrong-PIN feedback is not announced.
- Focus-session user: after `#focus-btn`, hidden idle controls and active timer controls are not consistently represented in the accessibility tree, making pause/cancel state hard to discover.
- Music user: invalid track input provides only a red border, so users may not understand accepted YouTube URL/video ID formats.
- Motion-sensitive user: reduced-motion preference is ignored by both CSS animations and canvas loops.

## Prioritized Fixes For Task 10

1. P0 Task 10 candidate: remove invisible controls from the tab order across collapsed lobby join, inactive timer rows, hidden `#music-bar`, `#track-row`, `#exit-confirm`, and `#yt-frame`.
2. P0 Task 10 candidate: make `#room-auth` and `#exit-confirm` semantic dialogs with focus management, escape/cancel behavior, and live error text.
3. P1 Task 10 candidate: add explicit labels and live status regions for `#pin-input`, `#room-pin-input`, `#time-slider`, lobby/auth errors, connection state, geolocation, scene changes, and track validation.
4. P1 Task 10 candidate: implement reduced-motion handling for decorative CSS animations, transitions, and canvas loops.
5. P1 Task 10 candidate: convert mixed interactive copy to Korean-primary using the glossary above.
6. P2 later/out of scope: replace one-button scene cycling with a richer scene picker.
7. P2 later/out of scope: add saved geolocation preferences or manual location entry.


## Task 10 Implementation Handoff

Task 10 implemented the highest priority findings from this audit while preserving the Vite + vanilla ES module boundaries, room PIN/token contracts, WebSocket semantics, and storage keys.

- Korean-primary copy is now the expected UI policy for interactive controls, validation errors, live regions, and status text. Keep `AethelDesk`, `PIN`, YouTube terms, API fields, and storage keys stable.
- Accessibility fixes include explicit labels, live regions, auth and exit dialog semantics, focus trap and restore behavior, hidden-control tab handling, invalid track feedback, and connection, scene, timer, and location status announcements.
- Reduced-motion handling now disables or reduces decorative CSS animation, transitions, and canvas loops while preserving core room sync.
- The YouTube iframe API may replace the static frame at runtime, so the live iframe must stay `aria-hidden`, `tabindex="-1"`, and `inert` after construction and readiness.
- Evidence for the implementation is recorded in `.omo/evidence/task-10-a11y-keyboard.txt`, `.omo/evidence/task-10-a11y-errors.txt`, and `.omo/evidence/task-10-a11y-youtube.txt`.
- Later UX work should not add a full i18n toggle, scene picker redesign, saved geolocation preferences, or new frontend frameworks unless separately approved.

## Task 15 UX Hardening Handoff

Task 15 closed the remaining mobile, touch, reduced-motion, and scene discoverability findings without changing the product model or adding a new frontend framework.

- Mobile portrait layouts at `390x844` and `768x1024` now keep `#time-dial`, `#controls`, and `#center-cluster` separated, with screenshots in `.omo/evidence/task-15-mobile-portrait.png` and `.omo/evidence/task-15-mobile-tablet.png`.
- Touch emulation keeps room controls reachable without relying on mouse movement; desktop-only auto-hide still applies only when the browser does not report touch input.
- Reduced-motion emulation disables decorative CSS animation and leaves scene canvas output stable while room WebSocket sync continues. Evidence is recorded in `.omo/evidence/task-15-reduced-motion.txt`.
- The scene control exposes available scenes and the current selected scene through `aria-describedby="scene-options"` and continues to announce changes through `#room-status`.
- Evidence for the full browser pass is recorded in `.omo/evidence/task-15-mobile-touch.txt` and `.omo/evidence/task-15-e2e-full.txt`.
