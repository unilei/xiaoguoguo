import { useEffect, useRef, useState } from "react";
import { AccountProfile, api } from "../lib/api";

type QrSession = {
  token: string;
  url: string;
  expiresAt: number;
  sameDevice: boolean;
  qr: string;
};

export function QrImport({
  onImported,
}: {
  onImported: (profile: AccountProfile) => void;
}) {
  const [session, setSession] = useState<QrSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [done, setDone] = useState<AccountProfile | null>(null);
  const pollRef = useRef<number | null>(null);

  async function create() {
    setBusy(true);
    setError("");
    setDone(null);
    try {
      const data = await api.createQr();
      setSession(data);
      setRemaining(Math.max(0, Math.round((data.expiresAt - Date.now()) / 1000)));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "二维码生成失败");
    } finally {
      setBusy(false);
    }
  }

  // 二维码有效期倒计时，同时轮询会话状态：手机提交成功后这里自动感知。
  useEffect(() => {
    if (!session) return;
    const tick = window.setInterval(() => {
      const left = Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setSession(null);
    }, 1000);
    const poll = window.setInterval(async () => {
      try {
        const status = await api.qrStatus(session.token);
        if (!status.valid) {
          // 会话消失：要么手机已经提交成功，要么过期。用健康接口区分。
          const health = await api.health();
          if (health.account === "configured") {
            window.clearInterval(poll);
            setSession(null);
            setDone({ nickname: "已登录", avatar: "", displayId: "" });
            onImported({ nickname: "已登录", avatar: "", displayId: "" });
          }
        }
      } catch {
        // 网络抖动忽略，下一轮再试。
      }
    }, 2000);
    pollRef.current = poll;
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
      pollRef.current = null;
    };
  }, [session, onImported]);

  return (
    <section className="panel">
      <h2>扫码导入 Cookie</h2>
      <p>
        用手机扫描二维码，在手机上粘贴你已登录红果的 Cookie，电脑端会自动接收并验证。
        二维码 5 分钟内有效，且只能用一次。
      </p>

      {!session && !done && (
        <button className="button primary" onClick={() => void create()} disabled={busy}>
          {busy ? "正在生成…" : "生成二维码"}
        </button>
      )}

      {session && (
        <div className="qr-box">
          <img className="qr-image" src={session.qr} alt="扫码导入 Cookie 的二维码" />
          <div className="qr-side">
            <div className="qr-url">{session.url}</div>
            <div className="qr-hint">
              {session.sameDevice
                ? "服务只监听本机，手机可能无法访问。请用 HOST=0.0.0.0 重启服务，或用下方手动粘贴。"
                : "手机与电脑需在同一网络。扫码后在手机上粘贴 Cookie。"}
            </div>
            <div className="qr-count">剩余 {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</div>
            <button className="button small ghost" onClick={() => void create()} disabled={busy}>
              换一个
            </button>
          </div>
        </div>
      )}

      {done && (
        <div className="banner" style={{ marginTop: 14 }}>
          手机端导入成功，完整播放已解锁。若状态仍显示匿名，刷新本页即可。
        </div>
      )}

      {error && (
        <div className="banner" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}
    </section>
  );
}
