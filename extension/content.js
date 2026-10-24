// Content script：在官网详情页注入「解锁全部剧集」入口，
// 点击后弹出悬浮播放器，逐段从 background 拉解密数据用 MSE 播放。
//
// 官网页面本身把全集列表渲染在 SSR 数据里（匿名也返回 vid_list 全量），
// 只是播放被 accessible_episode_cnt 限制。我们读取页面的 _ROUTER_DATA
// 拿到全集 vid 列表，播放走自己的解密管线。

(function () {
  "use strict";
  console.log("[XGG] content script 已注入:", location.host, location.pathname);

  // ---------------------------------------------------------------- 工具

  function send(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response?.ok) reject(new Error(response?.error || "后台处理失败"));
        else resolve(response);
      });
    });
  }

  // ---------------------------------------------------------------- 数据

  function readSeriesData() {
    // 官网把 SSR 数据以 _ROUTER_DATA = {...} 的形式内联在 script 里
    // （不是带 id 的元素），从页面脚本里捞这个赋值
    const html = document.documentElement.innerHTML;
    const at = html.indexOf("_ROUTER_DATA");
    if (at < 0) return null;
    const eq = html.indexOf("=", at);
    if (eq < 0) return null;
    try {
      const dec = new JSONDecoder();
      const data = dec.parse(html.slice(eq + 1));
      return findSeries(dec, data);
    } catch {
      return null;
    }
  }

  // JSONDecoder：SSR 数据后面带 ;makeServerRenderCall 包裹，不能直接 JSON.parse
  class JSONDecoder {
    parse(text) {
      const clean = text.trim().replace(/^"/, "");
      // 用原生 parser 找到第一个完整 JSON 值
      let end = 0;
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = 0; i < clean.length; i += 1) {
        const ch = clean[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') inString = !inString;
        if (inString) continue;
        if (ch === "{" || ch === "[") depth += 1;
        else if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      this.rest = clean.slice(end);
      return JSON.parse(clean.slice(0, end));
    }
  }

  function findSeries(dec, node, depth = 0) {
    if (!node || depth > 6) return null;
    if (typeof node === "string") {
      if (!node.includes("vid_list")) return null;
      try {
        return findSeries(dec, JSON.parse(node), depth + 1);
      } catch {
        return null;
      }
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findSeries(dec, item, depth);
        if (found) return found;
      }
      return null;
    }
    if (typeof node !== "object") return null;
    if (Array.isArray(node.vid_list) && node.vid_list.length && node.series_name) return node;
    for (const value of Object.values(node)) {
      const found = findSeries(dec, value, depth + 1);
      if (found) return found;
    }
    return null;
  }

  // ---------------------------------------------------------------- UI

  let panel = null;

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "xgg-panel";
    panel.innerHTML = `
      <div class="xgg-panel-head">
        <span class="xgg-title">全集解锁</span>
        <span class="xgg-info"></span>
        <button class="xgg-close" title="关闭">×</button>
      </div>
      <div class="xgg-player">
        <video class="xgg-video" controls playsinline></video>
        <div class="xgg-hint">点击下方集数开始播放</div>
      </div>
      <div class="xgg-eps"></div>
    `;
    document.body.appendChild(panel);
    panel.querySelector(".xgg-close").addEventListener("click", () => {
      stopPlayback();
      panel.remove();
      panel = null;
    });
    return panel;
  }

  function injectButton() {
    if (document.getElementById("xgg-unlock-btn")) return;
    const btn = document.createElement("button");
    btn.id = "xgg-unlock-btn";
    btn.textContent = "🔓 解锁全部剧集";
    btn.addEventListener("click", openPanel);
    document.body.appendChild(btn);
  }

  // ---------------------------------------------------------------- 播放（MSE）

  let currentVid = null;
  let fetchAbort = null;

  function stopPlayback() {
    if (fetchAbort) fetchAbort.abort();
    fetchAbort = null;
    currentVid = null;
  }

  async function playEpisode(vid, epLabel, infoEl) {
    stopPlayback();
    currentVid = vid;
    const video = panel.querySelector(".xgg-video");
    const hint = panel.querySelector(".xgg-hint");
    hint.textContent = `正在解析第 ${epLabel} 集…`;
    infoEl.textContent = "";

    try {
      const meta = await send({ type: "play", vid });
      if (currentVid !== vid) return;
      hint.textContent = `第 ${epLabel} 集 · ${meta.quality} · ${meta.total} 字节，正在缓冲…`;

      // 简单起见：全量拉取 + 解密（短剧一集 2-8MB，可接受）
      const CHUNK = 1024 * 1024;
      const parts = [];
      let aborted = false;
      fetchAbort = new AbortController();
      for (let start = 0; start < meta.total && !aborted; start += CHUNK) {
        if (currentVid !== vid) return;
        const end = Math.min(start + CHUNK, meta.total) - 1;
        const res = await send({ type: "range", vid, start, end });
        parts.push(res.data);
        hint.textContent = `第 ${epLabel} 集 · 缓冲 ${Math.round(((start + CHUNK) / meta.total) * 100)}%`;
      }
      if (currentVid !== vid) return;

      const blob = new Blob(parts, { type: "video/mp4" });
      video.src = URL.createObjectURL(blob);
      hint.textContent = `第 ${epLabel} 集 · ${meta.quality}`;
      await video.play();
    } catch (error) {
      hint.textContent = `播放失败：${error.message}`;
    }
  }

  // ---------------------------------------------------------------- 入口

  function openPanel() {
    const series = readSeriesData();
    if (!series) {
      alert("没有在这页找到剧集数据（可能不是详情页）");
      return;
    }
    const el = ensurePanel();
    const info = el.querySelector(".xgg-info");
    info.textContent = `${series.series_name} · 共 ${series.vid_list.length} 集`;

    const epsBox = el.querySelector(".xgg-eps");
    epsBox.innerHTML = "";
    series.vid_list.forEach((vid, index) => {
      const btn = document.createElement("button");
      btn.className = "xgg-ep";
      btn.textContent = index + 1;
      btn.addEventListener("click", () => {
        epsBox.querySelectorAll(".xgg-ep").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        playEpisode(String(vid), index + 1, info);
      });
      epsBox.appendChild(btn);
    });
  }

  // 官网是 SPA：路由切换不会重载页面，轮询 URL 变化。
  // 详情页形态：/detail?series_id=xxx（www 与裸域都可能）
  function isDetailPage() {
    return /detail/i.test(location.pathname) || location.search.includes("series_id=");
  }

  function tick() {
    if (isDetailPage()) injectButton();
    else {
      // 离开详情页时移除按钮（面板独立保留，由用户手动关）
      document.getElementById("xgg-unlock-btn")?.remove();
    }
  }
  tick();
  setInterval(tick, 800);
})();
