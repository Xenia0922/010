<p align="center">
  <img src="assets/banner.svg" width="100%" alt="牙牙消息" />
</p>
<p align="center">
  <img src="assets/logo-rounded.png" width="96" alt="logo" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-ff6f91" alt="license" /></a>
  <a href="https://github.com/Xenia0922/yaya_msg_mobile/releases"><img src="https://img.shields.io/badge/release-v2.7.3-2b75db5" alt="release" /></a>
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

- `yaya-msg-mobile-v2.7.3.apk`：通用包（全 ABI，体积最大）
- `yaya-msg-mobile-v2.7.3.x64.apk`：x86_64 模拟器专用
- `yaya-msg-mobile-v2.7.3.v8a.apk` / `-v7a.apk`：真机包（**推荐真机使用**，比通用包小约 40%）

模拟器请用 x64 包，否则无法启动。App 内「检查更新」始终提供通用包直链，真机如需最小体积请在 Release 页面按架构下载。

## 构建

```sh
npm install --legacy-peer-deps
node scripts/build-apk.js
```

## 兼容

鸿蒙 2/3/4 与 Android 8.0+（minSdk 26）。

## 已知问题

- **直播小窗播放用不了**：部分直播（RTMP 流）切入应用内小窗后无法正常播放，App 内会引导直接全屏观看（录播 / 回放小窗不受影响）。
- 直播断流/网络抖动时原生播放器自动重试 5 次，仍失败会在播放器内提示并可切换网页播放器。
- 房间消息进入房间后每 15 秒自动刷新（前后台切换自动启停）；成员直播状态与最新消息每 30 秒轮询。
- 上麦功能：支持查看/收听成员上麦状态（房间语音），暂不支持自己上麦发言。
- 房间语音或视频时长显示可能不准确（受官方接口字段变化影响）。
公演直播左上角LIVE字样是原生播放器导致，可在播放器右上角功能页面切换至网页播放器可解决该问题


## 致谢

基于 [yk1z/yaya_msg](https://github.com/yk1z/yaya_msg) 二次开发，感谢原作者的开发与贡献。
