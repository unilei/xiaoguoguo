import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AuthModal, Footer, Header } from './components/Layout';

/**
 * 原站按 UA 判定 PC / 移动布局，不看视口宽度。
 * 实测：桌面 UA 在 768/900/1100 全部走 PC 布局；移动 UA 在任何宽度走 M 布局。
 */
function detectMobile(): boolean {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(
    navigator.userAgent
  );
}

/** 原站 setRootPixel：39 * min(innerWidth, clientWidth) / 390，上限 64。 */
function setRootPixel() {
  const doc = document.documentElement;
  const width = Math.min(window.innerWidth, doc.clientWidth || window.innerWidth);
  const size = Math.min((39 * width) / 390, 64);
  doc.style.fontSize = `${size}px`;
}

function activeKeyFor(pathname: string): string | undefined {
  if (pathname === '/') return 'home';
  if (pathname.startsWith('/category')) return 'category';
  if (pathname.startsWith('/rank')) return 'rank';
  return undefined;
}

/**
 * 复刻站靠 body 上的类名区分布局：
 *   - body.route-page → 子路由页（分类/榜单/详情/播放/搜索）
 *   - body.player-body → 播放页整屏
 *   - 无类名 → 首页（移动端切到 mobile-shell）
 * React 里在路由变化时同步这些类名，CSS 就能原样复用。
 */
function bodyClassFor(pathname: string): string {
  if (pathname === '/') return 'home-page';
  if (pathname.startsWith('/player')) return 'route-page player-body page-player';
  if (pathname.startsWith('/category')) return 'route-page page-category';
  if (pathname.startsWith('/rank')) return 'route-page page-rank';
  if (pathname.startsWith('/detail')) return 'route-page page-detail';
  if (pathname.startsWith('/search')) return 'route-page page-search';
  return 'route-page';
}

export function Shell() {
  const location = useLocation();
  const [auth, setAuth] = useState<{ open: boolean; kind: 'login' | 'register' }>({
    open: false,
    kind: 'login',
  });
  const [isMobile] = useState(detectMobile);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add(isMobile ? 'is-mobile' : 'is-desktop');
    root.classList.remove(isMobile ? 'is-desktop' : 'is-mobile');
    setRootPixel();
    const onResize = () => setRootPixel();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isMobile]);

  useEffect(() => {
    document.body.className = bodyClassFor(location.pathname);
  }, [location.pathname]);

  // 切页面回到顶部（播放页是整屏，不需要）
  useEffect(() => {
    if (!location.pathname.startsWith('/player')) window.scrollTo(0, 0);
  }, [location.pathname]);

  // 详情页的「下载」按钮需要唤起登录弹窗
  useEffect(() => {
    const open = () => setAuth({ open: true, kind: 'login' });
    window.addEventListener('hg:open-auth', open);
    return () => window.removeEventListener('hg:open-auth', open);
  }, []);

  const isPlayer = location.pathname.startsWith('/player');

  return (
    <>
      <div className="pc-shell">
        <Header
          activeKey={activeKeyFor(location.pathname)}
          onOpenAuth={(kind) => setAuth({ open: true, kind })}
        />
        <Outlet />
        {!isPlayer && <Footer />}
      </div>
      <AuthModal
        open={auth.open}
        kind={auth.kind}
        onClose={() => setAuth((prev) => ({ ...prev, open: false }))}
      />
    </>
  );
}
