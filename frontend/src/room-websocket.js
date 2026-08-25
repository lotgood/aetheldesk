import { clearRoomToken, readRoomToken } from "./storage.js";

export function createRoomSocket({ roomId, connDot, connStatus, connCopy, auth, onState }) {
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
      connStatus.textContent = "방 PIN 확인이 필요합니다.";
      if (connCopy) connCopy.textContent = "PIN 필요";
      auth.show("");
      return;
    }

    auth.hide();
    connStatus.textContent = "방 연결을 시도하고 있습니다.";
    if (connCopy) connCopy.textContent = "연결 중";
    ws = new WebSocket(wsUrl(token));

    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      connDot.style.opacity = "0.35";
      connStatus.textContent = "방이 연결되었습니다. 함께 동기화 중입니다.";
      if (connCopy) connCopy.textContent = "연결됨";
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
        connStatus.textContent = "방 PIN 확인이 필요합니다.";
        if (connCopy) connCopy.textContent = "PIN 필요";
        auth.show("입장할 수 없습니다");
        return;
      }
      const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt++);
      connStatus.textContent = "방 연결이 끊겨 다시 연결하고 있습니다.";
      if (connCopy) connCopy.textContent = "재연결 중";
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
