import { useEffect, useState } from "react";
import { AccountProfile, api } from "../lib/api";
import { loadAccountHint, saveAccountHint } from "../lib/storage";
import { QrImport } from "../components/QrImport";

export function SettingsPage() {
  const [cookie, setCookie] = useState("");
  const [status, setStatus] = useState<"loading" | "anonymous" | "configured" | "offline">(
    "loading"
  );
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const hint = loadAccountHint();

  useEffect(() => {
    api
      .health()
      .then((data) => setStatus(data.account === "configured" ? "configured" : "anonymous"))
      .catch(() => setStatus("offline"));
  }, []);

  function markConfigured(value: AccountProfile) {
    setStatus("configured");
    setProfile(value);
  }

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
      if (result.account) {
        markConfigured(result.profile || { nickname: "已登录", avatar: "", displayId: "" });
        setMessage("Cookie 验证通过，完整播放已解锁。");
        setCookie("");
      } else {
        setStatus("anonymous");
        setMessage("已清除账号 Cookie。");
      }
    } catch (problem) {
      setStatus("anonymous");
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
      setProfile(null);
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
        <QrImport onImported={markConfigured} />

        <section className="panel">
          <h2>账号 Cookie（可选）</h2>
          <p>
            浏览与搜索不需要登录。平台从 2026-10 起对匿名请求不再返回完整播放地址，
            因此公开预览通常只覆盖每部剧的前几集。
          </p>
          <div className="banner" style={{ marginBottom: 14 }}>
            <span>
              <strong>红果没有网页登录。</strong>
              官网没有登录入口，登录态只存在于 App 里。要解锁完整播放，需要从已登录的
              红果 App 导出 Cookie（手机抓包，或取出 App 的 cookieStore.xml）。
              本项目不提供账号密码登录，也不会绕过平台限制。
            </span>
          </div>
          <textarea
            value={cookie}
            onChange={(event) => setCookie(event.target.value)}
            placeholder="粘贴整段 Cookie，例如：sessionid=...; sid_tt=...; uid_tt=..."
            spellCheck={false}
          />
          <div className="panel-actions">
            <button className="button primary" onClick={() => void save()} disabled={saving}>
              {saving ? "验证中…" : "验证并保存"}
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
                ? profile?.nickname
                  ? `已登录：${profile.nickname}`
                  : "已配置账号，可解析完整剧集"
                : "匿名模式，播放公开预览"}
          </div>
          {profile?.displayId && (
            <div className="kv">
              <span>红果号</span>
              <span>{profile.displayId}</span>
            </div>
          )}
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
