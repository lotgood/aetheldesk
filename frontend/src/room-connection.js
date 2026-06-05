import { byId } from "./dom.js";
import { createRoomAuth } from "./room-auth.js";
import { createRoomSocket } from "./room-websocket.js";


export function createRoomConnection({ roomId, onState }) {
  let socket;
  const auth = createRoomAuth(roomId, () => socket.reconnectNow());
  socket = createRoomSocket({
    roomId,
    connDot: byId("conn-dot"),
    connStatus: byId("conn-status"),
    auth: {
      show(message) {
        socket?.clearReconnect();
        byId("conn-dot").style.opacity = "0";
        byId("conn-status").textContent = "방 PIN 확인이 필요합니다.";
        auth.show(message);
      },
      hide: auth.hide,
    },
    onState,
  });
  return socket;
}
