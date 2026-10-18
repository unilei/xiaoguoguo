# 派生与第三方声明

## 上游派生

本项目（小果果 / xiaoguoguo）是红果短剧的非官方 Web 客户端，按 GPL-3.0-only 派生：

| 上游 | 许可证 | 本项目使用的部分 |
| --- | --- | --- |
| [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV) | GPL-3.0 | 官网 `_ROUTER_DATA` 解析、内容服务适配层结构、域名与路由 |
| [pan8664716/HGTV](https://github.com/pan8664716/HGTV) | GPL-3.0 | 匿名设备注册协议、签名分支与请求头、播放接口候选路径、CENC 索引处理 |

HGTV 本身是 hongguoTV 的 fork；两者著作权归各自作者。

## 第三方源码

`server/src/vendor/hongguo.cjs` 是
[woshishiq1/drpys](https://github.com/woshishiq1/drpys/tree/22261adfa31435e3b3ef5a730b8a2a75bcaf1715)
中 `spider/js/红果果[短].js` 的未修改副本（GPL-3.0，2026-09-21 获取）。
原文件头与注释保留，仅文件名改为便于本地加载。许可证见 `LICENSE.drpys`。

## 内容与商标

「红果」「红果短剧」等名称与内容归其权利人所有。本项目与红果官方无关联，
不声称对内容拥有任何权利，也不提供下载或绕过平台限制的能力。
