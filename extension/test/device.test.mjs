// 设备注册实测：浏览器版实现（Node 里跑，API 是标准 Web 平台 API）
// 真实调上游注册接口，验证 device_id/installId 能拿到。
import { registerDevice } from "../lib/device.js";

console.log("注册中（真实请求上游）…");
try {
  const identity = await registerDevice();
  console.log("deviceId :", identity.deviceId);
  console.log("installId:", identity.installId);
  console.log("cookies  :", Object.keys(identity.cookies).join(", ") || "（无）");
  const ok =
    /^\d{10,}$/.test(identity.deviceId) &&
    /^\d{10,}$/.test(identity.installId) &&
    identity.deviceId !== "0";
  console.log(ok ? "\n✅ 设备注册成功" : "\n❌ 返回的 ID 异常");
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error("❌ 注册失败:", error.message);
  process.exit(1);
}
