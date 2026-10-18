import { useEffect, useState } from "react";
import { AccountProfile, api, SessionExpiry } from "../lib/api";

/**
 * 从已登录的 Android 设备导出登录态。
 *
 * 这是上游 HGTV 实测唯一可行的登录路径：手机号验证码与平台扫码都走不通，
 * 官方 App 的登录态只存在于设备的 shared_prefs/cookieStore.xml 里。
 */
export function DeviceImport({
  onImported,
}: {
  onImported: (profile: AccountProfile, expiry: SessionExpiry) => void;
}) {
  const [devices, setDevices] = useState<string[]>([]);
  const [serial, setSerial] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "importing" | "done" | "error">(
    "idle"
  );
  const [message, setMessage] = useState("");
  const [expiry, setExpiry] = useState<SessionExpiry | null>(null);

  async function scan() {
    setState("loading");
    setMessage("");
    try {
      const data = await api.devices();
      setDevices(data.devices);
      if (!data.ok) {
        setState("error");
        setMessage(data.error || "adb 不可用");
        return;
      }
      if (!data.devices.length) {
        setState("error");
        setMessage("没有检测到 Android 设备。请启动模拟器，或先执行 adb connect <手机IP:端口>。");
        return;
      }
      setSerial(data.devices[0]);
      setState("idle");
    } catch (problem) {
      setState("error");
      setMessage(problem instanceof Error ? problem.message : "检测设备失败");
    }
  }

  async function run() {
    setState("importing");
    setMessage("");
    try {
      const data = await api.importFromDevice(serial);
      setState("done");
      setExpiry(data.expiry);
      setMessage(
        `已从 ${data.serial} 导入 ${data.fields} 个字段${
          data.expiry.known ? `，有效期至 ${data.expiry.expiresText}` : ""
        }。`
      );
      onImported(data.profile, data.expiry);
    } catch (problem) {
      setState("error");
      setMessage(problem instanceof Error ? problem.message : "导入失败");
    }
  }

  useEffect(() => {
    void scan();
  }, []);

  return (
    <section className="panel">
      <h2>从手机 / 模拟器导入（推荐）</h2>
      <p>
        红果没有网页登录，手机号验证码与平台扫码也走不通——上游项目实测过并写进了结论。
        唯一可行的是：在设备上用官方 App 登录，再把 App 的登录态取出来。
        小果果通过 adb 直接读 <code>cookieStore.xml</code>，不用你手动拼 Cookie。
      </p>

      <ol className="steps">
        <li>在 Android 模拟器（需 root）或已 root 的手机上安装红果 App，并完成登录。</li>
        <li>确认 <code>adb devices</code> 能看到设备；模拟器默认地址如 <code>127.0.0.1:16384</code>。</li>
        <li>点下面的「从设备导入」，小果果会读出登录态并验证。</li>
      </ol>

      <div className="panel-actions">
        <button
          className="button primary"
          onClick={() => void run()}
          disabled={state === "importing" || state === "loading" || !serial}
        >
          {state === "importing" ? "正在导入…" : "从设备导入"}
        </button>
        <button className="button ghost" onClick={() => void scan()} disabled={state === "importing"}>
          重新检测设备
        </button>
        {devices.length > 0 && (
          <select
            className="device-select"
            value={serial}
            onChange={(event) => setSerial(event.target.value)}
            aria-label="选择设备"
          >
            {devices.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        )}
        {state === "loading" && <span className="empty-hint">正在检测 adb 设备…</span>}
      </div>

      {message && (
        <div
          className="banner"
          style={{
            marginTop: 14,
            ...(state === "error"
              ? { background: "rgba(255,107,107,.1)", borderColor: "rgba(255,107,107,.24)", color: "#ffb3b3" }
              : {}),
          }}
        >
          {message}
        </div>
      )}

      {expiry?.known && (
        <div className="kv" style={{ marginTop: 10 }}>
          <span>会话有效期</span>
          <span>
            剩余 {expiry.remainingDays} 天（{expiry.expiresText}）
          </span>
        </div>
      )}

      <p style={{ marginTop: 14, marginBottom: 0 }}>
        平台不会自动续期：业务接口不返回新的 Cookie，也没有可用的刷新端点。
        到期后需要在设备上重新登录一次，再导入一次。
      </p>
    </section>
  );
}
