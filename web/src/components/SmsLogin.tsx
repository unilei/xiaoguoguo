import { useEffect, useRef, useState } from "react";
import { AccountProfile, api, SessionExpiry } from "../lib/api";

/**
 * 手机号 + 验证码登录。
 *
 * 参数与流程照 HGTV v1.1.5.1 APK 的实际实现还原：
 * send_code 用 mobile="+86…"、passport_support_flow="captcha,verify"、type=24；
 * sms_login 回传 sms_code_key。
 */
export function SmsLogin({
  onLoggedIn,
}: {
  onLoggedIn: (profile: AccountProfile, expiry: SessionExpiry) => void;
}) {
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [smsCodeKey, setSmsCodeKey] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState<"none" | "send" | "login">("none");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    timer.current = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [cooldown]);

  async function send() {
    if (!/^1\d{10}$/.test(mobile.trim())) {
      setFailed(true);
      setMessage("手机号要 11 位、以 1 开头");
      return;
    }
    setBusy("send");
    setFailed(false);
    setMessage("");
    try {
      const data = await api.sendSms(mobile.trim());
      setSmsCodeKey(data.smsCodeKey);
      setCooldown(data.retryAfter || 60);
      setMessage(data.message);
    } catch (problem) {
      setFailed(true);
      setMessage(problem instanceof Error ? problem.message : "验证码发送失败");
    } finally {
      setBusy("none");
    }
  }

  async function login() {
    if (!/^\d{4,8}$/.test(code.trim())) {
      setFailed(true);
      setMessage("验证码是 4—8 位数字");
      return;
    }
    setBusy("login");
    setFailed(false);
    setMessage("");
    try {
      const data = await api.loginSms(mobile.trim(), code.trim(), smsCodeKey);
      onLoggedIn(data.profile, data.expiry);
      setMessage("登录成功");
    } catch (problem) {
      setFailed(true);
      setMessage(problem instanceof Error ? problem.message : "登录失败，请稍后重试");
    } finally {
      setBusy("none");
    }
  }

  return (
    <section className="panel">
      <h2>手机号登录</h2>
      <p>
        用红果账号的手机号收验证码即可登录，未注册的手机号会自动创建账号。
        验证码由红果短信发出，小果果不会保存它。
      </p>

      <div className="form-row">
        <label htmlFor="sms-mobile">手机号</label>
        <input
          id="sms-mobile"
          className="text-input"
          value={mobile}
          onChange={(event) => setMobile(event.target.value.replace(/\D/g, "").slice(0, 11))}
          placeholder="11 位手机号"
          inputMode="numeric"
          autoComplete="tel"
        />
      </div>

      <div className="form-row">
        <label htmlFor="sms-code">验证码</label>
        <div className="code-row">
          <input
            id="sms-code"
            className="text-input"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
            placeholder="4—8 位数字"
            inputMode="numeric"
            autoComplete="one-time-code"
          />
          <button
            className="button small"
            onClick={() => void send()}
            disabled={busy !== "none" || cooldown > 0}
          >
            {busy === "send" ? "发送中…" : cooldown > 0 ? `${cooldown}s 后重发` : "获取验证码"}
          </button>
        </div>
      </div>

      <div className="panel-actions">
        <button
          className="button primary"
          onClick={() => void login()}
          disabled={busy !== "none" || !mobile || !code}
        >
          {busy === "login" ? "正在登录…" : "登录"}
        </button>
      </div>

      {message && (
        <div
          className="banner"
          style={{
            marginTop: 14,
            ...(failed
              ? {
                  background: "rgba(255,107,107,.1)",
                  borderColor: "rgba(255,107,107,.24)",
                  color: "#ffb3b3",
                }
              : {}),
          }}
        >
          <span>
            {message}
            {failed && /人机验证|captcha/i.test(message) && (
              <>
                {" "}
                这两条路不受影响：下方「从手机 / 模拟器导入」，
                或「账号 Cookie」里手动粘贴。
              </>
            )}
          </span>
        </div>
      )}

      <p style={{ marginTop: 14, marginBottom: 0 }}>
        登录态只保存在服务进程内存里。若平台提示验证码已过期（只给 10 分钟），
        重新获取一次即可。手机号与验证码不会写入任何本地文件。
      </p>
    </section>
  );
}
