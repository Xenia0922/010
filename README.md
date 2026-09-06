<p align="center">
  <img src="assets/banner.svg" width="100%" alt="牙牙消息" />
</p>
<p align="center">
  <img src="assets/logo-rounded.png" width="96" alt="logo" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-ff6f91" alt="license" /></a>
  <a href="https://github.com/Xenia0922/yaya_msg_mobile/releases"><img src="https://img.shields.io/badge/release-v2.7.4-ff6f91" alt="release" /></a>
  <img src="https://img.shields.io/badge/platform-Android-3DDC84?logo=android" alt="Android" />
</p>

# 牙牙消息

口袋48 第三方移动客户端（React Native），基于 [yk1z/yaya_msg](https://github.com/yk1z/yaya_msg) 二次开发。

## 功能

- 房间消息 / 私信 / 翻牌
- 口袋直播与回放
- 公演主播（B站直播）
- 官方音乐库
- 翻牌统计、成员数据库、鸡腿充值

## 安装
从[下载页](https://010push.a23xyz.xyz/app/)下载

从[夸克网盘](https://pan.quark.cn/s/5b103245218a)下载

从 [Releases](https://github.com/Xenia0922/yaya_msg_mobile/releases) 下载：

- `yaya-msg-mobile-v2.7.4.apk`：通用包（全 ABI，体积最大）
- `yaya-msg-mobile-v2.7.4.x64.apk`：x86_64 模拟器专用
- `yaya-msg-mobile-v2.7.4.v8a.apk` / `-v7a.apk`：真机包（**推荐真机使用**，比通用包小约 40%）

模拟器请用 x64 包，否则无法启动。App 内「检查更新」始终提供通用包直链，真机如需最小体积请在 Release 页面按架构下载。

## 构建

```sh
npm install --legacy-peer-deps
node scripts/build-apk.js
```

## 兼容

鸿蒙 2/3/4 与 Android 8.0+（minSdk 26）。

## 已知问题



## 致谢

基于 [yk1z/yaya_msg](https://github.com/yk1z/yaya_msg) 二次开发，感谢原作者的开发与贡献。
