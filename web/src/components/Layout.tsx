import { FormEvent, useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";

export function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [value, setValue] = useState(params.get("q") || "");

  useEffect(() => {
    if (location.pathname === "/search") setValue(params.get("q") || "");
  }, [location.pathname, params]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const keyword = value.trim();
    if (!keyword) return;
    if (location.pathname === "/search" && params.get("q") === keyword) return;
    navigate(`/search?q=${encodeURIComponent(keyword)}`);
  }

  return (
    <header className="header">
      <Link className="brand" to="/">
        <span className="brand-mark" aria-hidden="true">
          果
        </span>
        小果果
      </Link>
      <nav className="nav" aria-label="主导航">
        <NavLink
          to="/"
          end
          className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
        >
          发现
        </NavLink>
        <NavLink
          to="/search"
          className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
        >
          搜索
        </NavLink>
        <NavLink
          to="/library"
          className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
        >
          我的
        </NavLink>
        <NavLink
          to="/settings"
          className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
        >
          设置
        </NavLink>
      </nav>
      <div className="header-spacer" />
      <form className="search-form" onSubmit={submit} role="search">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit(event);
          }}
          placeholder="搜剧名，例如：王妈"
          aria-label="搜索剧名"
          enterKeyHint="search"
        />
        <button className="search-submit" type="submit">
          搜索
        </button>
      </form>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      小果果是红果短剧的非官方 Web 客户端，与红果官方无关联；内容接口为非官方实现，平台变化可能导致部分功能失效。
      <br />
      浏览与搜索可匿名使用；播放来自平台公开预览（每部剧前几集 360P），完整剧集需在
      <Link to="/settings"> 设置 </Link>
      中填入自己的账号 Cookie。本项目按 GPL-3.0 开源，派生自
      <a href="https://github.com/N3urda/hongguoTV" target="_blank" rel="noreferrer">
        {" "}
        N3urda/hongguoTV{" "}
      </a>
      与
      <a href="https://github.com/pan8664716/HGTV" target="_blank" rel="noreferrer">
        {" "}
        pan8664716/HGTV{" "}
      </a>
      。
    </footer>
  );
}
