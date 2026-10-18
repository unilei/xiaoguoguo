# vendor

`hongguo.cjs` 原样取自 [N3urda/hongguoTV](https://github.com/N3urda/hongguoTV)
的 `server/vendor/hongguo.cjs`（固定提交，见上游 `server/vendor/NOTICE.md`），
作者 `woshishiq1/drpys`，GPL-3.0。本项目只把它当作可信的、固定版本的协议实现，
通过 `provider.mjs` 的 vm 沙箱加载，不做任何修改。

上游文件提供：官网 SSR 解析、App 搜索签名（x-gorgon / x-ladon / x-argus /
x-helios / x-medusa）、spade URL 解密、CENC 内容密钥派生与分段解密。

许可证见同目录 `LICENSE.drpys`。
