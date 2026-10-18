// 手机端导入页：服务端直出 HTML，不依赖前端构建产物，也不引用任何外部资源。
const esc = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);

function page({ title, body, token }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0d0b10">
<title>${esc(title)} · 小果果</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0d0b10;color:#f7f3ef;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:560px;margin:0 auto;padding:28px 18px 48px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;margin-bottom:22px}
  .mark{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(140deg,#ff7a59,#ff9f43 55%,#ffcf6b);color:#2a1208;font-weight:900}
  h1{font-size:21px;margin:0 0 10px}
  p{color:#a29aab;font-size:14px;margin:0 0 16px}
  ol{color:#a29aab;font-size:13px;padding-left:20px;margin:0 0 20px}
  li{margin-bottom:8px}
  textarea{width:100%;min-height:150px;padding:13px;border-radius:12px;background:#1c1821;border:1px solid #2e2836;color:#f7f3ef;font:12px/1.6 ui-monospace,Menlo,monospace;resize:vertical;outline:none}
  textarea:focus{border-color:#ff7a59;box-shadow:0 0 0 3px rgba(255,122,89,.14)}
  button{width:100%;margin-top:14px;min-height:48px;border:none;border-radius:999px;background:linear-gradient(140deg,#ff7a59,#ff5c35);color:#2a1208;font-weight:800;font-size:15px}
  button:disabled{opacity:.5}
  .note{margin-top:16px;padding:13px 15px;border-radius:12px;background:rgba(255,122,89,.1);border:1px solid rgba(255,122,89,.22);color:#ffc4b3;font-size:13px}
  .ok{color:#57d9a3}
  .err{color:#ff6b6b}
  .card{padding:18px;border-radius:16px;background:#16131a;border:1px solid #2e2836;margin-bottom:18px}
  .kv{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:13px}
  .kv:last-child{border:0}
  .kv span:first-child{color:#726a7d}
  a{color:#ff9f7f}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="mark">果</span>小果果</div>
  ${body}
</div>
${token ? `<script>
const form=document.getElementById("f"),box=document.getElementById("c"),btn=document.getElementById("b"),msg=document.getElementById("m");
form.addEventListener("submit",async(e)=>{
  e.preventDefault();
  const value=box.value.trim();
  if(!value){msg.className="note err";msg.textContent="请先粘贴 Cookie";return;}
  btn.disabled=true;btn.textContent="正在验证…";msg.className="note";msg.textContent="";
  try{
    const r=await fetch("/import/${esc(token)}",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cookie:value})});
    const d=await r.json();
    if(d.ok){
      msg.className="note ok";
      msg.textContent="导入成功："+(d.profile?.nickname||"已登录")+"。可以回到小果果继续观看了。";
      box.value="";btn.style.display="none";
    }else{
      msg.className="note err";msg.textContent=d.reason||"导入失败";
      btn.disabled=false;btn.textContent="验证并导入";
    }
  }catch(err){
    msg.className="note err";msg.textContent="连接失败，请确认电脑上的小果果服务还在运行";
    btn.disabled=false;btn.textContent="验证并导入";
  }
});
</script>` : ""}
</body>
</html>`;
}

export function importPage(token) {
  return page({
    title: "导入账号 Cookie",
    token,
    body: `
<h1>导入账号 Cookie</h1>
<p>红果没有网页登录，登录态只存在于 App 里。小果果不提供账号密码登录，需要你从已登录的红果 App 导出 Cookie。</p>
<div class="card">
  <ol>
    <li>手机安装抓包工具（mitmproxy / Charles / Stream），信任它的证书。</li>
    <li>打开红果 App 随便浏览一下，在抓包记录里找到 <code>api5-normal-*.fqnovel.com</code> 的请求。</li>
    <li>复制请求头里的整段 <code>Cookie</code>（含 <code>sessionid</code>、<code>sid_tt</code>、<code>uid_tt</code> 等），粘贴到下面。</li>
  </ol>
</div>
<form id="f">
  <textarea id="c" placeholder="粘贴整段 Cookie，例如：sessionid=...; sid_tt=...; uid_tt=..." spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
  <button id="b" type="submit">验证并导入</button>
  <div id="m" class="note" style="display:none"></div>
</form>
<div class="note">
  这是把手机上的 Cookie <strong>传到电脑</strong>，不是登录。这份 Cookie 会保存在你电脑上的小果果服务进程内存里，
  只用于替你请求播放地址；不会写入仓库或日志，服务重启后需要重新导入。二维码 5 分钟内有效，且只能用一次。
</div>`,
  });
}

export function resultPage({ ok, message, profile }) {
  return page({
    title: ok ? "导入成功" : "导入失败",
    body: ok
      ? `<h1 class="ok">导入成功</h1>
<p>已识别账号：<strong>${esc(profile?.nickname || "已登录")}</strong>${profile?.displayId ? `（红果号 ${esc(profile.displayId)}）` : ""}</p>
<div class="card">
  <div class="kv"><span>状态</span><span class="ok">完整播放已解锁</span></div>
  <div class="kv"><span>有效期</span><span>以平台 Cookie 为准</span></div>
</div>
<p>现在可以关闭这个页面，回到小果果继续观看。</p>`
      : `<h1 class="err">导入失败</h1>
<p>${esc(message || "Cookie 无效或已过期")}</p>
<div class="note">请确认复制的是完整 Cookie（至少包含 <code>sessionid</code>），并且账号仍处于登录状态。回到电脑上重新生成二维码再试一次。</div>`,
  });
}

export function expiredPage() {
  return page({
    title: "二维码已失效",
    body: `<h1>二维码已失效</h1>
<p>这个二维码已经过期或使用过了。请回到小果果的「设置」页，重新生成一个。</p>`,
  });
}
