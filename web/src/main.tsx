import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./styles.css";
import { Footer, Header } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { SearchPage } from "./pages/SearchPage";
import { DetailPage } from "./pages/DetailPage";
import { WatchPage } from "./pages/WatchPage";
import { LibraryPage } from "./pages/LibraryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { EmptyState } from "./components/Poster";

function Shell() {
  return (
    <div className="app-shell">
      <Header />
      <main className="page">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/series/:id" element={<DetailPage />} />
          <Route path="/watch/:id/:episodeId" element={<WatchPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="*"
            element={<EmptyState title="页面不存在" hint="检查地址，或回到首页继续浏览。" />}
          />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  </StrictMode>
);
