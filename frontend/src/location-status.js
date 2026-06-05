import { byId } from "./dom.js";


export function bindLocationStatus({ send }) {
  byId("btn-locate").addEventListener("click", () => {
    const status = byId("room-status");
    if (!navigator.geolocation) {
      status.textContent = "이 브라우저에서는 위치 권한을 사용할 수 없습니다.";
      return;
    }
    status.textContent = "현재 위치를 사용해 하늘 시간을 맞춥니다. 권한 요청을 확인해 주세요.";
    navigator.geolocation.getCurrentPosition(
      pos => {
        send({ type: "location", lat: pos.coords.latitude, lon: pos.coords.longitude });
        status.textContent = "현재 위치를 반영해 방의 하늘을 맞췄습니다.";
      },
      () => { status.textContent = "위치 권한이 허용되지 않아 현재 위치를 반영하지 못했습니다."; }
    );
  });
}
