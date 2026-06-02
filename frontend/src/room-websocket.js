import { clearRoomToken, readRoomToken } from "./storage.js";

export function createRoomSocket({ roomId, connDot, auth, onState }) {
  let ws = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;

  function wsUrl(token) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${location.host}/ws/${roomId}?token=${encodeURIComponent(token)}`;
  }

  function clearReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function connect() {
    const token = readRoomToken(roomId);
    if (!token) {
      auth.show("");
      return;
    }

    auth.hide();
    ws = new WebSocket(wsUrl(token));

    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      connDot.style.opacity = "0.35";
      navigator.permissions?.query({ name: "geolocation" }).then(result => {
        if (result.state === "granted") {
          navigator.geolocation.getCurrentPosition(
            pos => send({ type: "location", lat: pos.coords.latitude, lon: pos.coords.longitude }),
            () => {}
          );
        }
      }).catch(() => {});
    });

    ws.onmessage = event => {
      try {
        const payload = JSON.parse(event.data);
        if (payload?.data) onState(payload.data);
      } catch (err) {
        console.warn("ws message parse failed", err);
      }
    };

    ws.onclose = event => {
      connDot.style.opacity = "0";
      if (event.code === 1008) {
        clearRoomToken(roomId);
        auth.show("입장할 수 없습니다");
        return;
      }
      const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt++);
      clearReconnect();
      reconnectTimer = setTimeout(connect, delay);
    };

    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function reconnectNow() {
    reconnectAttempt = 0;
    connect();
  }

  return { connect, reconnectNow, send, clearReconnect };
}
