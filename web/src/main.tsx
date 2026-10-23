import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles/site.css';
import './styles/routes.css';
import './styles/app.css';
import { Shell } from './Shell';
import { HomePage } from './pages/HomePage';
import { CategoryPage } from './pages/CategoryPage';
import { RankPage } from './pages/RankPage';
import { DetailPage } from './pages/DetailPage';
import { WatchPage } from './pages/WatchPage';
import { SearchPage } from './pages/SearchPage';
import { PageEmpty } from './components/States';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/category" element={<Navigate to="/category/real-drama" replace />} />
          <Route path="/category/:type" element={<CategoryPage />} />
          <Route path="/category/:type/:sub" element={<CategoryPage />} />
          <Route path="/rank" element={<Navigate to="/rank/hot-drama" replace />} />
          <Route path="/rank/:key" element={<RankPage />} />
          <Route path="/detail/:id" element={<DetailPage />} />
          <Route path="/player/:id" element={<WatchPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route
            path="*"
            element={<PageEmpty title="页面不存在" hint="检查地址，或回到首页继续浏览。" />}
          />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
