/**
 * LoginScreen · 账号设置 v2.6 布局重做
 * - 登录方式用分段控件（短信验证码 / Token / B站二维码）：fill2 底 + 选中白胶囊
 * - 表单卡：输入框圆角 14 fill2 底 + 主按钮 Button filled 全宽
 * - 账号列表改行卡：头像 48 圆 + 昵称 15/700 + token 掩码 11 + 「当前」tint 徽标 + 切换按钮（filled sm）
 * - B站二维码卡：白卡圆角 16 + 二维码居中 + 过期刷新按钮
 * 业务逻辑 / API / 数据流 / 路由 / i18n 原文一律不动，仅重组布局。
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useNavigation } from '@react-navigation/native';
import QRCode from 'qrcode';
import { WebView } from 'react-native-webview';
import { useSettingsStore, useUiStore } from '../store';
import { FadeInView } from '../components/Motion';
import { ScalePressable } from '../components/Motion';
import ScreenHeader from '../components/ScreenHeader';
import { Button } from '../components/Button';
import { saveSettings } from '../services/settings';
import pocketApi from '../api/pocket48';
import bilibiliApi from '../api/bilibili';
import { errorMessage, pickText } from '../utils/data';
import { logWarn } from '../utils/runtimeLog';
import { usePalette, radii, radiiAlias, usePageBackground } from '../theme';
import { translate, useI18n } from '../i18n';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

const BILI_COOKIE_KEYS = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

/** 从一段 search/hash 裸参数字符串里提取 B站 cookie（仅用 URLSearchParams，不依赖 Hermes 的 new URL） */
function biliCookiesFromSearch(search = ''): string {
  try {
    const params = new URLSearchParams(search);
    return BILI_COOKIE_KEYS
      .map((key) => {
        const value = params.get(key);
        return value ? `${key}=${value}` : '';
      })
      .filter(Boolean)
      .join('; ');
  } catch {
    return '';
  }
}

/**
 * 从扫码确认回调 url/参数串提取 B站 cookie，兼容几种 B站实测/历史形态：
 *  1) 完整 crossDomain URL：query 里带 cookie（https://passport.bilibili.com/x/passport-login/web/crossDomain?DedeUserID=..&SESSDATA=..）
 *  2) hash 里带参数：.../#SESSDATA=..&bili_jct=..
 *  3) 整个 URL 被 encodeURIComponent 嵌了一层（SESSDATA%3D..%26bili_jct%3D..）
 *  4) 裸 key=value 串（无协议无路径）
 */
function buildBilibiliCookieFromUrl(rawUrl = ''): string {
  const extract = (source: string): string => {
    let search = source;
    const q = source.indexOf('?');
    if (q >= 0) search = source.slice(q + 1);
    const parts = search.split('#');
    let query = parts[0] || '';
    const hash = parts.length > 1 ? parts[1] : '';
    if (hash) query = query ? `${query}&${hash}` : hash;
    return biliCookiesFromSearch(query);
  };

  let cookie = extract(rawUrl);
  if (cookie.includes('SESSDATA')) return cookie;

  // 嵌套编码：整串先 decode 一层再提取
  try {
    const decoded = decodeURIComponent(rawUrl);
    if (decoded !== rawUrl && decoded.includes('SESSDATA')) {
      const nested = extract(decoded);
      if (nested.includes('SESSDATA')) return nested;
    }
  } catch {
    /* 非法编码串，忽略 */
  }

  return cookie;
}

/** 从原生模块返回的 "k=v; k=v"（Set-Cookie 头拼串）里挑出 B站 常用键。
 *  注意与 url query 解析不同：cookie 串按 ';' 分段，值里不含 ';'。 */
function pickBiliCookies(raw = ''): string {
  const parts = String(raw)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  return BILI_COOKIE_KEYS
    .map((key) => {
      const hit = parts.find((p) => p.startsWith(`${key}=`));
      return hit || '';
    })
    .filter(Boolean)
    .join('; ');
}

/** Token 掩码：只显示首 6 + 尾 4 字符，避免完整 Token 常驻屏幕 */
function maskToken(token: string): string {
  const t = String(token || '');
  if (t.length <= 12) return t.slice(0, 4) + '***';
  return `${t.slice(0, 6)}...${t.slice(-4)}`;
}

function extractPocketToken(value: any): string {
  const seen = new Set<any>();
  const walk = (node: any): string => {
    if (!node || typeof node !== 'object' || seen.has(node)) return '';
    seen.add(node);
    const direct = [
      node.token,
      node.accessToken,
      node.access_token,
      node.p48Token,
      node.sessionToken,
      node?.userInfo?.token,
      node?.userInfo?.accessToken,
      node?.content?.token,
      node?.content?.accessToken,
      node?.content?.userInfo?.token,
      node?.data?.token,
      node?.data?.accessToken,
    ].find((item) => typeof item === 'string' && item.trim().length > 10);
    if (direct) return direct.trim();
    for (const item of Object.values(node)) {
      const found = walk(item);
      if (found) return found;
    }
    return '';
  };
  return walk(value);
}

function accountId(user: any): string {
  return String(user?.userId || user?.id || user?.userInfo?.userId || user?.userInfo?.id || '');
}

function accountName(user: any): string {
  return String(user?.nickname || user?.nickName || user?.name || user?.userInfo?.nickname || user?.userInfo?.nickName || user?.userInfo?.name || translate('未命名账号'));
}

function accountRole(user: any, fallback: string): string {
  return String(user?.roleName || user?.typeName || user?.accountType || user?.userInfo?.roleName || fallback);
}

function parseAccountInfo(res: any) {
  const content = res?.content || res?.data || res || {};
  const current = content.userInfo || content.user || content;
  const bigSmallInfo = content.bigSmallInfo || content.bigSmall || content.userInfo?.bigSmallInfo || {};
  const bigUsers = [
    bigSmallInfo.bigUserInfo,
    bigSmallInfo.bigUser,
    bigSmallInfo.ownerUserInfo,
  ].filter(Boolean);
  const smallUsers = [
    ...(Array.isArray(bigSmallInfo.smallUserInfo) ? bigSmallInfo.smallUserInfo : []),
    ...(Array.isArray(bigSmallInfo.smallUserList) ? bigSmallInfo.smallUserList : []),
    ...(Array.isArray(bigSmallInfo.smallUsers) ? bigSmallInfo.smallUsers : []),
  ];
  const users = [...bigUsers, ...smallUsers].filter((user, index, list) => {
    const id = accountId(user);
    return id && list.findIndex((item) => accountId(item) === id) === index;
  });
  // 当前账号排最前（切换入口一眼可见），其余保持大号/小号顺序
  const currentId = accountId(current);
  if (currentId) {
    const idx = users.findIndex((u) => accountId(u) === currentId);
    if (idx > 0) {
      const [cur] = users.splice(idx, 1);
      users.unshift(cur);
    }
  }
  return { current, users };
}

type LoginMode = 'sms' | 'token' | 'bilibili';

export default function LoginScreen() {
  const navigation = useNavigation();
  const settings = useSettingsStore((state) => state.settings);
  const setSettings = useSettingsStore((state) => state.setSettings);
  const showToast = useUiStore((state) => state.showToast);
  const palette = usePalette();
  const { t } = useI18n();
  const pollingRef = useRef(true);
  useEffect(() => { return () => { pollingRef.current = false; }; }, []);
  // 账号设置页固定竖屏：避免从横屏播放器进入时内容被横向挤压（布局按竖屏设计）
  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, []);
  const [mode, setMode] = useState<LoginMode>('sms');
  const [phone, setPhone] = useState('');
  const [area, setArea] = useState('86');
  const [code, setCode] = useState('');
  const [manualToken, setManualToken] = useState(settings.p48Token || '');
  const [qrKey, setQrKey] = useState('');
  const activePollKeyRef = useRef(''); // Y3: 当前活跃轮询的二维码 key（刷新二维码时旧轮询据此退出）
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [biliStatus, setBiliStatus] = useState('');
  const [qrHtml, setQrHtml] = useState<string | null>(null);
  const [profileName, setProfileName] = useState('');
  const [profileAvatar, setProfileAvatar] = useState('');
  const [renameCountText, setRenameCountText] = useState('');
  const [accountInfo, setAccountInfo] = useState<{ current: any; users: any[] }>({ current: null, users: [] });
  const [switchingUserId, setSwitchingUserId] = useState('');
  // 短信发送触发风控安全验证（status=2001）：展示问题与选项，选对后带 answer 重发
  const [verify, setVerify] = useState<{ question: string; options: string[]; phone: string; area: string } | null>(null);

  const savePocketToken = async (token: string, message: string) => {
    const clean = token.trim();
    try {
      setSettings({ p48Token: clean });
      await saveSettings({ p48Token: clean });
      setManualToken(clean);
      setStatus(message);
    } catch (error: any) {
      setStatus(t('保存失败：{msg}', { msg: error?.message || String(error) }));
    }
  };

  const handleSendSms = async (answer?: string) => {
    if (!phone.trim() && !verify) {
      setStatus(t('请输入手机号'));
      return;
    }
    setLoading(true);
    setStatus(t('正在获取验证码'));
    try {
      const areaCode = area.replace(/[^0-9]/g, '') || '86';
      const res: any = await pocketApi.loginSendSms(phone.trim() || verify!.phone, verify?.area || areaCode, answer);
      if (res?.needVerification) {
        setVerify({
          question: res.question || t('安全验证'),
          options: Array.isArray(res.options) ? res.options.map(String) : [],
          phone: phone.trim() || verify!.phone,
          area: verify?.area || areaCode,
        });
        setStatus(t('请完成安全验证后重新获取验证码'));
      } else {
        setStatus(res?.success ? t('验证码已发送') : t(res?.msg || res?.message || '验证码发送失败'));
        if (res?.success) setVerify(null);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyAnswer = (option: string) => {
    handleSendSms(option);
  };

  const handleLogin = async () => {
    if (!phone.trim() || !code.trim()) {
      setStatus(t('请输入手机号和短信验证码'));
      return;
    }
    setLoading(true);
    setStatus(t('正在登录'));
    try {
      const res = await pocketApi.loginByCode(phone.trim(), code.trim());
      const token = extractPocketToken(res);
      if (token) {
        await savePocketToken(token, t('登录成功'));
        setTimeout(() => navigation.goBack(), 700);
      } else {
        const msg = res?.message || res?.msg || res?.content?.message || JSON.stringify(res).slice(0, 180);
        const base = t('登录失败接口未返回token');
        setStatus(msg ? `${base}。${t('返回：{msg}', { msg: t(String(msg)) })}` : base);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveManualToken = async () => {
    const token = manualToken.trim();
    if (!token) {
      setStatus(t('请先粘贴token'));
      return;
    }
    setLoading(true);
    setStatus(t('正在保存...'));
    try {
      await savePocketToken(token, t('Token已保存'));
    } finally {
      setLoading(false);
    }
  };

  const refreshAccountInfo = async () => {
    const res = await pocketApi.loginCheckToken();
    const ok = res?.success !== false && (res?.status === 200 || res?.success || res?.content || res?.data);
    setAccountInfo(parseAccountInfo(res));
    return { res, ok };
  };

  const handleCheckToken = async () => {
    const token = manualToken.trim() || settings.p48Token;
    if (token && token !== settings.p48Token) {
      setSettings({ p48Token: token });
      await saveSettings({ p48Token: token });
    }
    setLoading(true);
    setStatus(t('正在检查Token'));
    try {
      const { res, ok } = await refreshAccountInfo();
      setStatus(ok ? t('Token有效') : t('Token无效：{msg}', { msg: res?.msg || res?.message || JSON.stringify(res).slice(0, 160) }));
    } catch (error) {
      setStatus(t('Token无效：{msg}', { msg: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchPocketAccount = async (user: any) => {
    const targetUserId = accountId(user);
    if (!targetUserId) {
      setStatus(t('切换失败没有拿到目标账号ID'));
      return;
    }
    setLoading(true);
    setSwitchingUserId(targetUserId);
    setStatus(t('正在切换到{name}', { name: accountName(user) }));
    try {
      const res = await pocketApi.switchBigSmall(targetUserId);
      const token = pickText(res, ['content.token', 'data.token', 'token', 'content.accessToken', 'data.accessToken']) || extractPocketToken(res);
      if (!token) throw new Error(t('切换失败没有拿到目标账号ID'));
      const done = t('已切换到{name}', { name: accountName(user) });
      await savePocketToken(token, done);
      await refreshAccountInfo();
      showToast(done);
    } catch (error) {
      setStatus(t('切换账号失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      setSwitchingUserId('');
      setLoading(false);
    }
  };

  const pollBiliLogin = async (key: string) => {
    // Y3: 抢占——刷新二维码会带新 key 启动新轮询；旧轮询被抢占即退出（此前靠从未赋值的 qrKey，永不退出）
    if (activePollKeyRef.current && activePollKeyRef.current !== key) return;
    activePollKeyRef.current = key;
    let pollWarned = false;
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!pollingRef.current) return; // abort if unmounted
      if (activePollKeyRef.current !== key) return; // 已被更新的二维码轮询抢占
      try {
        const res = await bilibiliApi.pollQrCode(key);
        if (res.data.code === 0) {
          const rawUrl = String(res.data?.url || '');
          let cookie = buildBilibiliCookieFromUrl(rawUrl);
          if (!cookie.includes('SESSDATA') && /ticket=|crossDomain/i.test(rawUrl)) {
            // B站 2024+ 新协议：poll 只回 ticket url，cookie 在 crossDomain 302 的 Set-Cookie 里
            // → 原生 BiliLoginModule（followRedirects=false 读首包）换 cookie
            try {
              const raw = await bilibiliApi.exchangeTicket(rawUrl);
              cookie = pickBiliCookies(raw);
              logWarn(
                `[bili-login] ticket 换 cookie ${cookie.includes('SESSDATA') ? '成功' : '失败（无 SESSDATA）'} 原生返: ${raw.slice(0, 200)}`,
                'login.pollBili',
              );
            } catch (e) {
              logWarn('[bili-login] ticket 换 cookie 异常: ' + errorMessage(e), 'login.pollBili');
            }
          }
          if (!cookie.includes('SESSDATA')) {
            // 记录真实回调 url（截断），下次仍失败时 logcat 可定位是 B站侧缺参数还是解析问题
            logWarn(
              `[bili-login] 扫码已确认但 url 未解析出 SESSDATA（前 200 字符）: ${rawUrl.slice(0, 200)} code=${res.data?.code}`,
              'login.pollBili',
            );
            setBiliStatus(t('B站已确认但没有拿到Cookie'));
            return;
          }
          const nav = await bilibiliApi.checkLoginStatus(cookie);
          const userInfo = nav?.code === 0 && nav?.data?.isLogin
            ? { mid: String(nav.data.mid || ''), uname: String(nav.data.uname || ''), face: String(nav.data.face || '') }
            : null;
          setSettings({ bilibiliCookie: cookie, bilibiliUserInfo: userInfo });
          await saveSettings({ bilibiliCookie: cookie, bilibiliUserInfo: userInfo });
          setBiliStatus(t('B站登录成功'));
          return;
        }
        if (res.data.code === 86038) {
          setBiliStatus(t('二维码已过期请刷新'));
          return;
        }
      } catch (e) {
        if (!pollWarned) {
          pollWarned = true;
          logWarn('B站二维码轮询失败: ' + errorMessage(e), 'login.pollBili');
        }
      }
    }
    setBiliStatus(t('B站登录超时'));
  };

  const handleBiliQr = async () => {
    setLoading(true);
    setBiliStatus(t('正在获取B站二维码'));
    try {
      const res = await bilibiliApi.generateQrCode();
      if (res.code === 0 && res.data) {
        const key = res.data.qrcode_key;
        const svg = await QRCode.toString(res.data.url, { type: 'svg', margin: 2, width: 220 });
        setQrKey(key);
        setQrHtml(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="margin:0;background:#fff;display:flex;align-items:center;justify-content:center;">${svg}</body></html>`);
        setBiliStatus(t('请用B站App扫码'));
        pollBiliLogin(key);
      } else {
        setBiliStatus(res?.message || t('B站二维码获取失败'));
      }
    } catch (error) {
      setBiliStatus(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const handleLoadProfile = async () => {
    setLoading(true);
    setStatus(t('正在读取口袋资料'));
    try {
      const res = await pocketApi.getNimLoginInfo();
      const info = res?.content?.userInfo || res?.content?.user || res?.content || res?.data?.userInfo || res?.data || {};
      setProfileName(String(info.nickName || info.nickname || info.name || ''));
      setProfileAvatar(String(info.avatar || info.headImg || info.headUrl || ''));
      const renameRes = await pocketApi.getUserRenameCount().catch(() => null);
      const renameContent = renameRes?.content ?? renameRes?.data ?? renameRes;
      if (renameContent && typeof renameContent === 'object') {
        const freeCount = renameContent.count ?? renameContent.renameCount ?? renameContent.renameNum ?? renameContent.num ?? renameContent.leftCount ?? renameContent.remainCount;
        const chickenCount = renameContent.jtcount ?? renameContent.jtCount ?? renameContent.chickenCount ?? renameContent.payCount;
        setRenameCountText(t('免费修改：{free} · 鸡腿修改：{chicken}', {
          free: freeCount ?? '--',
          chicken: chickenCount ?? '--',
        }));
      }
      setStatus(t('资料已读取'));
    } catch (error) {
      setStatus(t('资料读取失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  };

  const handleEditProfile = async () => {
    const name = profileName.trim();
    if (!name) {
      setStatus(t('请输入新昵称'));
      return;
    }
    setLoading(true);
    setStatus(t('正在修改昵称'));
    try {
      await pocketApi.editUserInfo({ key: 'nickname', value: name });
      setStatus(t('昵称修改成功'));
      await handleLoadProfile();
    } catch (error) {
      setStatus(t('资料读取失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  };

  const handlePickAvatar = async () => {
    setLoading(true);
    setStatus(t('正在选择并上传头像'));
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setStatus(t('没有相册权限无法选择头像'));
        setLoading(false);
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      if (result.canceled) {
        setStatus(t('已取消选择头像'));
        setLoading(false);
        return;
      }
      const asset = result.assets?.[0];
      if (!asset?.uri) throw new Error(t('图片选择器没有返回文件'));
      setStatus(t('正在上传到口袋服务器'));
      const upload = await pocketApi.uploadUserAvatar({
        uri: asset.uri,
        fileName: asset.fileName || `avatar-${Date.now()}.jpg`,
        mimeType: asset.mimeType || 'image/jpeg',
      });
      if (!upload.path) throw new Error(t('上传成功但没有返回路径'));
      setStatus(t('正在更新头像'));
      await pocketApi.editUserInfo({ key: 'avatar', value: upload.path });
      setProfileAvatar(upload.path);
      setStatus(t('头像已更新'));
    } catch (error) {
      setStatus(t('头像上传失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  };

  const SEGMENTS: { key: LoginMode; label: string; icon: string }[] = [
    { key: 'sms', label: t('短信验证码'), icon: 'message-text-outline' },
    { key: 'token', label: t('Token'), icon: 'key-variant' },
    { key: 'bilibili', label: t('B站二维码'), icon: 'qrcode' },
  ];

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
    <ScrollView style={[styles.container, { backgroundColor: usePageBackground() }]} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <ScreenHeader title={t('账号设置')} />

      <FadeInView delay={40} duration={280} distance={8}>
        {/* 登录方式分段控件 */}
        <View style={[styles.segment, { backgroundColor: palette.fill2 }]}>
          {SEGMENTS.map((seg) => {
            const active = mode === seg.key;
            return (
              <ScalePressable
                key={seg.key}
                style={[styles.segmentItem, active && styles.segmentItemActive, active && { backgroundColor: palette.surfaceElevated }]}
                onPress={() => setMode(seg.key)}
                pressedScale={0.96}
              >
                <Text style={[styles.segmentText, { color: active ? palette.label : palette.labelSecondary }]}>
                  {seg.label}
                </Text>
              </ScalePressable>
            );
          })}
        </View>
      </FadeInView>

      <FadeInView delay={80} duration={300} distance={8}>
        {/* 短信验证码登录 */}
        {mode === 'sms' ? (
          <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
            <Text style={[styles.cardTitle, { color: palette.label }]}>{t('口袋48验证码登录')}</Text>
            <View style={styles.phoneRow}>
              <View style={[styles.field, styles.areaWrap, { backgroundColor: palette.fill2 }]}>
                <Text style={[styles.areaPlus, { color: palette.label }]}>+</Text>
                <TextInput
                  style={[styles.areaInput, { color: palette.label }]}
                  placeholder="86"
                  placeholderTextColor={palette.labelTertiary}
                  keyboardType="phone-pad"
                  maxLength={5}
                  value={area}
                  onChangeText={(v) => setArea(v.replace(/[^0-9]/g, '').slice(0, 5))}
                />
              </View>
              <TextInput style={[styles.field, styles.phoneInput, { backgroundColor: palette.fill2, color: palette.label }]} placeholder={t('手机号')} placeholderTextColor={palette.labelTertiary} keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
            </View>
            <TextInput style={[styles.field, { backgroundColor: palette.fill2, color: palette.label }]} placeholder={t('短信验证码')} placeholderTextColor={palette.labelTertiary} keyboardType="number-pad" value={code} onChangeText={setCode} maxLength={8} />
            {verify ? (
              <View style={[styles.verifyBox, { backgroundColor: palette.fill2, borderColor: palette.innerStroke }]}>
                <Text style={[styles.verifyQuestion, { color: palette.label }]}>{verify.question}</Text>
                <View style={styles.verifyOptions}>
                  {verify.options.map((option) => (
                    <ScalePressable
                      key={option}
                      style={[styles.verifyOption, { backgroundColor: palette.surface, borderColor: palette.innerStroke, borderWidth: StyleSheet.hairlineWidth }]}
                      onPress={() => handleVerifyAnswer(option)}
                      disabled={loading}
                      pressedScale={0.94}
                      hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
                    >
                      <Text style={[styles.verifyOptionText, { color: palette.label }]}>{option}</Text>
                    </ScalePressable>
                  ))}
                </View>
              </View>
            ) : null}
            <View style={styles.btnCol}>
              <Button title={t('获取验证码')} variant="tinted" size="md" onPress={() => handleSendSms()} disabled={loading} fullWidth />
              <Button title={t('登录')} variant="filled" size="md" onPress={handleLogin} disabled={loading} fullWidth />
            </View>
            {status && mode === 'sms' ? <Text style={[styles.status, { color: palette.labelSecondary }]}>{status}</Text> : null}
          </View>
        ) : null}

        {/* Token 登录 */}
        {mode === 'token' ? (
          <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
            <Text style={[styles.cardTitle, { color: palette.label }]}>{t('口袋48Token登录')}</Text>
            <TextInput
              style={[styles.field, styles.tokenInput, { backgroundColor: palette.fill2, color: palette.label }]}
              placeholder={t('粘贴口袋token')}
              placeholderTextColor={palette.labelTertiary}
              value={manualToken}
              onChangeText={setManualToken}
              numberOfLines={1}
            />
            <View style={styles.btnCol}>
              <Button title={t('检查Token')} variant="tinted" size="md" onPress={handleCheckToken} disabled={loading} fullWidth />
              <Button title={t('保存Token')} variant="filled" size="md" onPress={handleSaveManualToken} disabled={loading} loading={loading} fullWidth />
            </View>
            {/* 已保存 Token + Token 状态：卡片内普通段落（紧贴按钮列），无独立块背景，
                避免被误认为\"卡片外独立横条\" */}
            {settings.p48Token ? (
              <Text style={[styles.tokenInfo, { color: palette.labelSecondary }]} numberOfLines={2}>
                {t('已保存Token：{token}', { token: maskToken(settings.p48Token) })}
              </Text>
            ) : null}
            {status && mode === 'token' ? (
              <Text style={[styles.status, status.startsWith(t('Token有效')) ? { color: palette.tint, fontWeight: '700' } : { color: palette.danger, fontWeight: '700' }]} numberOfLines={2}>
                {status}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* B站二维码 */}
        {mode === 'bilibili' ? (
          <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
            <Text style={[styles.cardTitle, { color: palette.label }]}>{t('B站登录')}</Text>
            {qrHtml ? (
              <View style={styles.qrCard}>
                <WebView source={{ html: qrHtml }} style={styles.qr} originWhitelist={['*']} scrollEnabled={false} />
              </View>
            ) : (
              <View style={styles.qrPlaceholder}>
                <MaterialCommunityIcons name="qrcode" color={palette.labelTertiary} size={56} />
              </View>
            )}
            {biliStatus ? <Text style={[styles.biliStatus, { color: palette.labelSecondary }]}>{biliStatus}</Text> : null}
            <View style={styles.btnCol}>
              <Button
                title={qrHtml ? t('刷新B站二维码') : t('获取B站登录二维码')}
                variant="filled"
                size="md"
                onPress={handleBiliQr}
                disabled={loading}
                loading={loading}
                fullWidth
              />
            </View>
            {/过期|超时|失败/.test(biliStatus) ? (
              <ScalePressable onPress={handleBiliQr} pressedScale={0.96} style={styles.qrRetry} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialCommunityIcons name="refresh" color={palette.tint} size={16} />
                <Text style={[styles.qrRetryText, { color: palette.tint }]}>{t('二维码已过期，点击刷新')}</Text>
              </ScalePressable>
            ) : null}
            {settings.bilibiliCookie ? <Text style={[styles.tokenInfo, { color: palette.success }]}>{t('B站已登录')}</Text> : null}
            {status && mode === 'bilibili' ? <Text style={[styles.status, { color: palette.labelSecondary }]}>{status}</Text> : null}
          </View>
        ) : null}

        {/* 口袋账号切换：账户行卡列表 */}
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
          <View style={styles.cardHead}>
            <Text style={[styles.cardTitle, { color: palette.label }]}>{t('口袋账号切换')}</Text>
            <Button title={t('刷新账号列表')} variant="tinted" size="sm" onPress={handleCheckToken} disabled={loading} />
          </View>
          <Text style={[styles.metaLine, { color: palette.labelSecondary }]}>
            {t('当前：{info}', { info: accountInfo.current ? `${accountName(accountInfo.current)} ${accountId(accountInfo.current) ? `(${accountId(accountInfo.current)})` : ''}` : t('先检查Token读取账号') })}
          </Text>
          {accountInfo.users.length ? (
            <Text style={[styles.metaLine, { color: palette.labelTertiary }]}>
              {t('已登录 {count} 个账号（含小号）', { count: accountInfo.users.length })}
            </Text>
          ) : null}
          {accountInfo.users.length ? accountInfo.users.map((user, index) => {
            const id = accountId(user);
            const isCurrent = !!id && id === accountId(accountInfo.current);
            return (
              <FadeInView key={id} delay={index < 12 ? 60 + index * 25 : 0} duration={300} distance={8}>
                <ScalePressable
                  style={[
                    styles.accountRow,
                    isCurrent ? { borderColor: palette.tint, backgroundColor: palette.tintSoft } : { backgroundColor: palette.fill3, borderColor: 'transparent' },
                  ]}
                  onPress={() => handleSwitchPocketAccount(user)}
                  disabled={loading || isCurrent}
                  activeOpacity={0.7}
                  pressedScale={0.985}
                >
                  <View style={[styles.accountAvatar, { backgroundColor: palette.fill2 }]}>
                    <MaterialCommunityIcons name={isCurrent ? 'account-check' : 'account'} color={palette.tint} size={22} />
                  </View>
                  <View style={styles.accountTextWrap}>
                    <Text style={[styles.accountName, { color: palette.label }]} numberOfLines={1}>{accountName(user)}</Text>
                    <Text style={[styles.accountMeta, { color: palette.labelTertiary }]} numberOfLines={1}>
                      {t('Token {mask}', { mask: maskToken(settings.p48Token || '') })} · {accountRole(user, t('账号'))}
                    </Text>
                  </View>
                  {!isCurrent ? (
                    <Button
                      title={switchingUserId === id ? t('切换中') : t('切换')}
                      variant="filled"
                      size="sm"
                      onPress={() => handleSwitchPocketAccount(user)}
                      disabled={loading || switchingUserId === id}
                      loading={switchingUserId === id}
                    />
                  ) : (
                    <View style={[styles.currentBadge, { backgroundColor: palette.tint }]}>
                      <Text style={[styles.currentBadgeText, { color: palette.onTint }]}>{t('当前')}</Text>
                    </View>
                  )}
                </ScalePressable>
              </FadeInView>
            );
          }) : <Text style={[styles.metaLine, { color: palette.labelSecondary }]}>{t('没有读取到大小号列表；保存 Token 后点"刷新账号列表"。')}</Text>}
        </View>

        {/* 口袋资料 */}
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
          <Text style={[styles.cardTitle, { color: palette.label }]}>{t('口袋资料')}</Text>
          {renameCountText ? <Text style={[styles.metaLine, { color: palette.labelSecondary }]}>{renameCountText}</Text> : null}
          <TextInput
            style={[styles.field, { backgroundColor: palette.fill2, color: palette.label }]}
            placeholder={t('昵称')}
            placeholderTextColor={palette.labelTertiary}
            value={profileName}
            onChangeText={setProfileName}
          />
          <View style={styles.btnCol}>
            <Button title={t('读取资料')} variant="tinted" size="md" onPress={handleLoadProfile} disabled={loading} fullWidth />
            <Button title={t('修改昵称')} variant="filled" size="md" onPress={handleEditProfile} disabled={loading} fullWidth />
          </View>
          <TextInput
            style={[styles.field, { backgroundColor: palette.fill2, color: palette.label, opacity: 0.7 }]}
            placeholder={t('头像URL上传后自动填入')}
            placeholderTextColor={palette.labelTertiary}
            value={profileAvatar}
            onChangeText={setProfileAvatar}
            autoCapitalize="none"
            editable={false}
          />
          <View style={styles.avatarRow}>
            <Button title={t('选择本地图片上传头像')} variant="tinted" size="md" onPress={handlePickAvatar} disabled={loading} />
          </View>
        </View>

        {/* 鸡腿充值 */}
        <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.hairline, borderWidth: StyleSheet.hairlineWidth }]}>
          <Text style={[styles.cardTitle, { color: palette.label }]}>{t('鸡腿充值')}</Text>
          <Button title={t('打开官方充值页')} variant="filled" size="md" onPress={() => (navigation as any).navigate('RechargeScreen')} fullWidth />
        </View>
      </FadeInView>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingBottom: 32, paddingHorizontal: 16 },
  cardMargin: { marginHorizontal: 16, marginTop: 16 },
  // 分段控件
  segment: {
    flexDirection: 'row',
    borderRadius: radii.md,
    padding: 4,
    gap: 4,
    marginBottom: 16,
    marginTop: 8,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentItemActive: {
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  segmentText: { fontSize: 14, fontWeight: '700' },
  // 卡片
  card: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 16,
    overflow: 'hidden',
  },
  cardTitle: { fontSize: 17, fontWeight: '800', marginBottom: 12 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  field: { height: 42, paddingHorizontal: 12, borderRadius: radiiAlias.input, marginBottom: 10, fontSize: 14 },
  tokenInput: { minHeight: 46, textAlignVertical: 'center', paddingVertical: 8 },
  btnCol: { gap: 10, marginTop: 4 },
  phoneRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  areaWrap: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, marginBottom: 10 },
  areaPlus: { fontWeight: '700', fontSize: 15, marginRight: 2 },
  areaInput: { minWidth: 44, paddingVertical: 12, paddingHorizontal: 0, fontSize: 14 },
  phoneInput: { flex: 1 },
  avatarRow: { marginTop: 4 },
  biliStatus: { marginTop: 10, fontSize: 12, textAlign: 'center', lineHeight: 18, flexShrink: 0, marginBottom: 4 },
  qrCard: {
    alignSelf: 'center',
    width: 220,
    height: 220,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  qr: { width: 220, height: 220 },
  qrPlaceholder: {
    alignSelf: 'center',
    width: 220,
    height: 220,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  qrRetry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
    paddingVertical: 8,
  },
  qrRetryText: { fontSize: 13, fontWeight: '700' },
  tokenInfo: { fontSize: 12, lineHeight: 18, flexShrink: 0, minHeight: 18, marginTop: 12 },
  status: { fontSize: 12, lineHeight: 18, flexShrink: 0, marginTop: 6 },
  metaLine: { marginTop: 8, marginBottom: 10, fontSize: 12, lineHeight: 18, flexShrink: 1 },
  // 账号行卡
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 10,
    gap: 12,
  },
  accountAvatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  accountTextWrap: { flex: 1, minWidth: 0 },
  accountName: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  accountMeta: { marginTop: 3, fontSize: 11, flexShrink: 1 },
  currentBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radii.pill },
  currentBadgeText: { fontSize: 11, fontWeight: '800' },
  verifyBox: { padding: 12, borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth, marginBottom: 10 },
  verifyQuestion: { fontSize: 13, fontWeight: '700', marginBottom: 8 },
  verifyOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  verifyOption: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: radii.pill },
  verifyOptionText: { fontSize: 13, fontWeight: '600' },
});
