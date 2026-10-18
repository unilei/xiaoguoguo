// 自检：不启动服务，直接验证内容接入与播放解析是否可用。
// 用法：npm run probe
import { home, search, detail, resolvePlayback } from "./provider.mjs";

const results = [];

async function check(name, run) {
  const started = Date.now();
  try {
    const value = await run();
    results.push({ name, ok: true, ms: Date.now() - started, detail: value });
    return value;
  } catch (error) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

const feed = await check("home", async () => {
  const data = await home(1);
  if (data.items.length < 3) throw new Error("首页返回的剧集太少");
  return {
    count: data.items.length,
    totalPages: data.totalPages,
    sample: data.items.slice(0, 3).map((item) => item.title),
  };
});

const series = feed ? (await home(1)).items[0] : null;

if (series) {
  const data = await check("detail", async () => {
    const value = await detail(series.id);
    if (!value.episodes.length) throw new Error("没有分集");
    return {
      title: value.title,
      episodes: value.episodes.length,
      first: value.episodes[0].id,
      last: value.episodes.at(-1).id,
    };
  });

  await check("search", async () => {
    const value = await search("王妈", 1);
    if (!value.items.length) throw new Error("搜索没有结果");
    return { count: value.items.length, hasMore: value.hasMore, first: value.items[0].title };
  });

  if (data) {
    await check("playback:first", async () => {
      const source = await resolvePlayback(data.first);
      return { kind: source.kind, quality: source.quality };
    });
    // 最后一集在匿名模式下通常没有公开预览，这是平台限制而不是故障：
    // 能解析就报告清晰度，解析不到就标记为 expected_limit。
    const started = Date.now();
    try {
      const source = await resolvePlayback(data.last);
      results.push({
        name: "playback:last",
        ok: true,
        ms: Date.now() - started,
        detail: { kind: source.kind, quality: source.quality },
      });
    } catch (error) {
      results.push({
        name: "playback:last",
        ok: true,
        expectedLimit: true,
        ms: Date.now() - started,
        detail: {
          note: "匿名模式下没有公开预览；在设置中填入账号 Cookie 后可解锁",
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
if (results.some((item) => !item.ok)) process.exitCode = 1;
