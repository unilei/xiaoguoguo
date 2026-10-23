import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ASSETS, FOOTER_LINKS } from '../lib/site';

/** 原站导航项（含两级下拉）。 */
const NAV = [
  { text: '首页', to: '/', key: 'home' },
  {
    text: '分类',
    to: '/category/real-drama',
    key: 'category',
    dropdown: [
      { text: '真人剧', to: '/category/real-drama' },
      { text: '漫剧', to: '/category/comic-drama' },
      { text: 'AI剧', to: '/category/ai-drama' },
      { text: '漫画', to: '/category/comic' },
    ],
  },
  {
    text: '榜单',
    to: '/rank/hot-drama',
    key: 'rank',
    dropdown: [
      { text: '红果热播榜', to: '/rank/hot-drama' },
      { text: '真人剧热播榜', to: '/rank/hot-real-drama' },
      { text: 'AI剧热播榜', to: '/rank/hot-ai-drama' },
      { text: '漫剧热播榜', to: '/rank/hot-comic-drama' },
    ],
  },
];

/** 二维码：与原站一致的点阵，纯 SVG 绘制。 */
export function QrSvg() {
  return (
    <svg viewBox="0 0 54 54" aria-hidden="true">
      <title>红果短剧APP下载二维码</title>
      <rect x="0" y="0" width="54" height="54" fill="#fff" />
      <g fill="#131414">
        <rect x="3" y="3" width="16" height="16" />
        <rect x="6" y="6" width="10" height="10" fill="#fff" />
        <rect x="9" y="9" width="4" height="4" />
        <rect x="35" y="3" width="16" height="16" />
        <rect x="38" y="6" width="10" height="10" fill="#fff" />
        <rect x="41" y="9" width="4" height="4" />
        <rect x="3" y="35" width="16" height="16" />
        <rect x="6" y="38" width="10" height="10" fill="#fff" />
        <rect x="9" y="41" width="4" height="4" />
        <rect x="23" y="3" width="4" height="4" />
        <rect x="23" y="11" width="4" height="4" />
        <rect x="27" y="7" width="4" height="4" />
        <rect x="23" y="23" width="4" height="4" />
        <rect x="31" y="23" width="4" height="4" />
        <rect x="39" y="23" width="4" height="4" />
        <rect x="47" y="23" width="4" height="4" />
        <rect x="23" y="31" width="4" height="4" />
        <rect x="35" y="31" width="4" height="4" />
        <rect x="43" y="31" width="4" height="4" />
        <rect x="23" y="39" width="4" height="4" />
        <rect x="31" y="39" width="4" height="4" />
        <rect x="39" y="39" width="4" height="4" />
        <rect x="47" y="43" width="4" height="4" />
        <rect x="27" y="47" width="4" height="4" />
        <rect x="35" y="47" width="4" height="4" />
        <rect x="43" y="47" width="4" height="4" />
      </g>
    </svg>
  );
}

/** 登录 / 注册弹窗。 */
export function AuthModal({
  open,
  kind,
  onClose,
}: {
  open: boolean;
  kind: 'login' | 'register';
  onClose: () => void;
}) {
  const [hint, setHint] = useState('');
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      setHint('');
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );

  if (!open) return null;

  return (
    <div
      className="modal-mask show"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-dialog" role="dialog" aria-modal="true">
        <button className="modal-close" type="button" aria-label="关闭" onClick={onClose}>
          ×
        </button>
        <div className="modal-left">
          <h2 className="modal-title">{kind === 'register' ? '注册红果短剧' : '登录红果短剧'}</h2>
          <p className="modal-desc">登录后可同步观看记录、收藏与福利</p>
          <input className="modal-field" type="text" placeholder="请输入手机号" inputMode="numeric" />
          <input className="modal-field" type="text" placeholder="请输入验证码" />
          <button
            className="modal-submit"
            type="button"
            onClick={() => {
              setHint('演示环境，未接入真实登录');
              if (timer.current) window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => setHint(''), 1800);
            }}
          >
            {hint || '登录 / 注册'}
          </button>
        </div>
        <div className="modal-right">
          <div className="modal-qr">
            <QrSvg />
          </div>
          <p className="modal-qr-tip">
            扫码下载「红果短剧App」
            <br />
            <span>免费解锁海量短剧</span>
          </p>
        </div>
      </div>
    </div>
  );
}

/** 页头。activeKey 决定高亮项。 */
export function Header({
  activeKey,
  onOpenAuth,
}: {
  activeKey?: string;
  onOpenAuth: (kind: 'login' | 'register') => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [keyword, setKeyword] = useState('');

  // 进入搜索页时把关键词回填到页头输入框
  useEffect(() => {
    if (location.pathname === '/search') {
      setKeyword(new URLSearchParams(location.search).get('q') || '');
    }
  }, [location.pathname, location.search]);

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const value = keyword.trim();
      // 空关键词不跳转，否则会落到空白结果页
      if (!value) return;
      navigate(`/search?q=${encodeURIComponent(value)}`);
    },
    [keyword, navigate]
  );

  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand-link" to="/" aria-label="红果短剧">
          <img className="brand-logo" src={ASSETS.brandLogo} alt="红果短剧logo" />
        </Link>
        <div className="header-links">
          {NAV.map((item) =>
            item.dropdown ? (
              <div className="dropdown-nav" key={item.key}>
                <Link
                  className={`nav-link${item.key === activeKey ? ' nav-link-active' : ''}`}
                  to={item.to}
                >
                  {item.text}
                </Link>
                <nav className="dropdown-menu">
                  {item.dropdown.map((sub) => (
                    <Link key={sub.to} to={sub.to}>
                      {sub.text}
                    </Link>
                  ))}
                </nav>
              </div>
            ) : (
              <Link
                className={`nav-link${item.key === activeKey ? ' nav-link-active' : ''}`}
                to={item.to}
                key={item.key}
              >
                {item.text}
              </Link>
            )
          )}
          <div className="download-entry">
            <div className="download-label">下载</div>
            <div className="guide-box">
              <div className="guide-card">
                <img className="guide-card-logo" src={ASSETS.brandLogo} alt="红果短剧" />
                <div className="scan-box">
                  <div className="scan-svg">
                    <QrSvg />
                  </div>
                  <span className="scan-logo">
                    <img src={ASSETS.brandLogo} alt="" />
                  </span>
                </div>
                <p className="guide-desc">
                  扫码下载安装「红果短剧App」
                  <br />
                  免费解锁海量短剧，边看剧边赚福利！
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="header-actions">
          <div className="search-box">
            <form className="search-form" role="search" onSubmit={submit}>
              <input
                className="search-input"
                type="search"
                placeholder="请输入"
                aria-label="搜索短剧"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
              <button className="search-submit" type="submit" aria-label="搜索">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="7" cy="7" r="5.2" stroke="currentColor" strokeWidth="1.4" />
                  <path
                    d="M11 11l3.2 3.2"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </form>
          </div>
          <button className="entry-btn" type="button" onClick={() => onOpenAuth('login')}>
            登录
          </button>
          <button
            className="entry-btn entry-register"
            type="button"
            onClick={() => onOpenAuth('register')}
          >
            注册
          </button>
        </div>
      </div>
    </header>
  );
}

/** 页脚：备案信息是固定文案。 */
export function Footer() {
  const link = (item: { text: string; link: string }, underline = false) => (
    <a
      href={item.link}
      className={underline ? 'underline' : undefined}
      target={item.link.startsWith('http') ? '_blank' : undefined}
      rel={item.link.startsWith('http') ? 'noopener noreferrer nofollow' : undefined}
    >
      {item.text}
    </a>
  );

  return (
    <div className="footer-page">
      <footer className="footer-container">
        <p className="footer-line">
          {FOOTER_LINKS.companyName}
          <span>&nbsp;|&nbsp;</span>
          {FOOTER_LINKS.addressLabel}
          {FOOTER_LINKS.address}
        </p>
        <p className="footer-line">
          {link(FOOTER_LINKS.icpRecord)}
          <span className="footer-sep">|</span>
          {link(FOOTER_LINKS.icpLicense)}
          <span className="footer-sep">|</span>
          {link(FOOTER_LINKS.webCultureLicense)}
          <span className="footer-sep">|</span>
          {link(FOOTER_LINKS.publicSecurityRecord)}
        </p>
        <p className="footer-line">
          {link(FOOTER_LINKS.businessLicense, true)}
          <span className="footer-sep">|</span>
          {link(FOOTER_LINKS.publicationLicense, true)}
          <span className="footer-sep">|</span>
          {link(FOOTER_LINKS.broadcastLicense, true)}
        </p>
        <p className="footer-line">
          {FOOTER_LINKS.reportNotice}
          <span className="footer-sep">|</span>
          {link(FOOTER_LINKS.reportEmail)}
        </p>
        <div className="footer-icon">
          <img src={ASSETS.footerLogo} alt="红果短剧logo" />
        </div>
      </footer>
    </div>
  );
}

/** 面包屑。 */
export function Breadcrumb({ items }: { items: { text: string; to?: string }[] }) {
  return (
    <nav className="breadcrumb" aria-label="面包屑">
      <ol>
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.text}-${index}`}>
              {item.to && !isLast ? (
                <Link to={item.to}>{item.text}</Link>
              ) : (
                <span className="current">{item.text}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
