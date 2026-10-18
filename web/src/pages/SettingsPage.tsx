import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { loadAccountHint, saveAccountHint } from "../lib/storage";

export function SettingsPage() {
  const [cookie, setCookie] = useState("");
  const [status, setStatus] = useState<"loading" | "anonymous" | "configured" | "offline">(
    "loading"
  );
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const hint = loadAccountHint();

  useEffect(() => {
    api
      .health()
      .then((data) => setStatus(data.account === "configured" ? "configured" : "anonymous"))
      .catch(() => setStatus("offline"));
  }, []);

  async function save() {
    const value = cookie.trim();
    if (!value) {
      setMessage("请先粘贴 Cookie");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const result = await api.saveAccount(value);
      saveAccountHint(value.slice(0, 24));
      setStatus(result.account ? "configured" : "anonymous");
      setMessage("已保存到服务进程。重启服务后需要重新填写。");
      setCookie("");
    } catch (problem) {
      setMessage(problem instanceof Error ? problem.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    try {
      await api.saveAccount("");
      saveAccountHint("");
      setStatus("anonymous");
      setMessage("已清除账号 Cookie，播放回到公开预览。");
    } catch (problem) {
      setMessage(problem instanceof Error ? problem.message : "清除失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="section-head" style={{ marginTop: 8 }}>
        <h1 className="section-title" style={{ fontSize: 26 }}>
          设置
        </h1>
        <span className="section-sub">内容来源、播放能力与本地数据</span>
      </div>

      <div className="settings-grid">
        <section className="panel">
          <h2>账号 Cookie（可选）</h2>
          <p>
            浏览与搜索不需要登录。平台从 2026-10 起对匿名请求不再返回完整播放地址，
            因此公开预览通常只覆盖每部剧的前几集。填入你自己在红果 App / 网页端的
            Cookie 后，服务端会用你的登录态解析全部剧集。
          </p>
          <textarea
            value={cookie}
            onChange={(event) => setCookie(event.target.value)}
            placeholder="粘贴整段 Cookie，例如：install_id=...; ttreq=...; sessionid=..."
            spellCheck={false}
          />
          <div className="panel-actions">
            <button className="button primary" onClick={() => void save()} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
            <button className="button ghost" onClick={() => void clear()} disabled={saving}>
              清除
            </button>
            {hint && <span className="empty-hint">已保存的凭据以 {hint}… 开头</span>}
          </div>
          {message && (
            <div className="banner" style={{ marginTop: 14 }}>
              {message}
            </div>
          )}
          <p style={{ marginTop: 16, marginBottom: 0 }}>
            Cookie 只保存在服务进程内存中，不写入仓库、日志或前端存储；服务重启后需要重新填写。
            请只使用你自己的账号，不要分享或提交到代码仓库。
          </p>
        </section>

        <section className="panel">
          <h2>服务状态</h2>
          <div className="status-row">
            <span className={`status-dot${status === "offline" ? " off" : ""}`} />
            {status === "offline"
              ? "内容服务未连接"
              : status === "configured"
                ? "已配置账号，可解析完整剧集"
                : "匿名模式，播放公开预览"}
          </div>
          <div className="kv">
            <span>服务版本</span>
            <span>0.1.0</span>
          </div>
          <div className="kv">
            <span>浏览与搜索</span>
            <span>无需登录</span>
          </div>
          <div className="kv">
            <span>完整播放</span>
            <span>{status === "configured" ? "已开启" : "需 Cookie"}</span>
          </div>
          <div className="kv">
            <span>本地记录</span>
            <span>仅保存在浏览器</span>
          </div>
          <p style={{ marginTop: 16, marginBottom: 0 }}>
            本项目是非官方客户端，内容接口随平台变化可能失效；不提供下载，也不绕过平台的付费或登录限制。
          </p>
        </section>
      </div>
    </>
  );
}
