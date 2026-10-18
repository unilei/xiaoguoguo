import { Library, Progress, Series } from "./api";

const LIBRARY_KEY = "xiaoguoguo.library.v1";
const SEARCH_KEY = "xiaoguoguo.searches.v1";
const ACCOUNT_KEY = "xiaoguoguo.account.v1";

const emptyLibrary = (): Library => ({ favorites: [], progress: {} });

export function loadLibrary(): Library {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return emptyLibrary();
    const data = JSON.parse(raw);
    if (Array.isArray(data.favorites) && data.progress && typeof data.progress === "object")
      return data as Library;
  } catch {
    // 本地数据损坏时回到空库，不影响浏览。
  }
  return emptyLibrary();
}

let pending = Promise.resolve();

// 串行写入：避免较慢的旧进度覆盖新进度。
export function saveLibrary(library: Library): Promise<void> {
  const value = JSON.stringify(library);
  pending = pending
    .catch(() => undefined)
    .then(() => {
      localStorage.setItem(LIBRARY_KEY, value);
    });
  return pending;
}

export function loadSearches(): string[] {
  try {
    const data = JSON.parse(localStorage.getItem(SEARCH_KEY) || "[]");
    return Array.isArray(data) ? data.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function pushSearch(keyword: string): string[] {
  const next = [keyword, ...loadSearches().filter((item) => item !== keyword)].slice(0, 10);
  localStorage.setItem(SEARCH_KEY, JSON.stringify(next));
  return next;
}

export function clearSearches(): void {
  localStorage.removeItem(SEARCH_KEY);
}

export function loadAccountHint(): string {
  try {
    return localStorage.getItem(ACCOUNT_KEY) || "";
  } catch {
    return "";
  }
}

export function saveAccountHint(value: string): void {
  if (value) localStorage.setItem(ACCOUNT_KEY, value);
  else localStorage.removeItem(ACCOUNT_KEY);
}

export function progressKey(series: Series): string {
  return series.id;
}

export function updateProgress(
  library: Library,
  series: Series,
  episodeId: string,
  episodeNumber: number,
  position: number,
  duration: number
): Library {
  const completed = duration > 0 && position / duration > 0.95;
  const progress: Progress = {
    series,
    episodeId,
    episodeNumber,
    position: completed ? 0 : position,
    duration,
    completed,
    updatedAt: Date.now(),
  };
  return {
    ...library,
    progress: { ...library.progress, [progressKey(series)]: progress },
  };
}

export function toggleFavorite(library: Library, series: Series): Library {
  const exists = library.favorites.some((item) => item.id === series.id);
  return {
    ...library,
    favorites: exists
      ? library.favorites.filter((item) => item.id !== series.id)
      : [series, ...library.favorites].slice(0, 200),
  };
}

export function isFavorite(library: Library, id: string): boolean {
  return library.favorites.some((item) => item.id === id);
}
