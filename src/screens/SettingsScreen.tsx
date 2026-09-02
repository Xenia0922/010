/**
 * SettingsScreen · 设置 v2.6 布局重做
 * - 全页 inset 分组：每个 Section 圆角 16 卡片，Section 内行式条目（28 圆角图标底 + 标题 15/600 + 右侧 chevron/状态文字）
 * - 关于区 hero 卡（logo 52 圆角 16 + 名称 + 版本 chip + 红点）
 * - 成员数据统计 2 列卡
 * - 区块入场 FadeInView 错峰
 * 业务逻辑 / API / 数据流 / 路由 / i18n 原文一律不动，仅重组布局。
 */
import React, { useEffect, useState } from 'react';
import { toMs } from '../utils/format';
import {
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { CompositeNavigationProp, useNavigation } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { StackNavigationProp } from '@react-navigation/stack';
import { Image } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { RootStackParamList, TabParamList } from '../navigation/types';
import { useSettingsStore, useUiStore, useMemberStore, useUpdateStore } from '../store';
import { saveSettings } from '../services/settings';
import ScreenHeader from '../components/ScreenHeader';
import { Button } from '../components/Button';
import { FadeInView, ScalePressable } from '../components/Motion';
import RuntimeLogViewer from '../components/RuntimeLogViewer';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { APP_VERSION } from '../constants';
import { getMemberDataMeta, MemberDataMeta } from '../services/memberData';
import { usePalette, radii, radiiAlias, usePageBackground } from '../theme';
import { typography } from '../theme/typography';
import { useI18n, LANGUAGE_OPTIONS } from '../i18n';

type SettingsNavProp = CompositeNavigationProp<
  BottomTabNavigationProp<TabParamList, 'Settings'>,
  StackNavigationProp<RootStackParamList>
>;

function Section({ title, children, delay = 0 }: { title: string; children: React.ReactNode; delay?: number }) {
  const palette = usePalette();
  return (
    <FadeInView delay={delay} duration={300}>
      {title ? (
        <Text style={[styles.sectionTitle, { color: palette.label }]}>{title}</Text>
      ) : null}
      <View
        style={[
          styles.section,
          {
            backgroundColor: palette.surface,
            borderColor: palette.hairline,
            borderRadius: radiiAlias.card,
          },
        ]}
      >
        {children}
      </View>
    </FadeInView>
  );
}

/** Section 内行式条目：28 圆角图标底 + 标题 15/600 + 右侧 chevron/状态文字 */
function Row({
  icon,
  title,
  value,
  onPress,
  danger,
  withChevron = true,
}: {
  icon: string;
  title: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
  withChevron?: boolean;
}) {
  const palette = usePalette();
  return (
    <ScalePressable
      style={styles.row}
      onPress={onPress}
      pressedScale={0.98}
      activeOpacity={0.9}
      disabled={!onPress}
    >
      <View style={[styles.rowIcon, { backgroundColor: danger ? 'rgba(255,59,48,0.12)' : palette.tintSoft }]}>
        <MaterialCommunityIcons name={icon} color={danger ? palette.danger : palette.tint} size={16} />
      </View>
      <Text style={[styles.rowTitle, { color: danger ? palette.danger : palette.label }]} numberOfLines={1}>{title}</Text>
      {value ? (
        <Text style={[styles.rowValue, { color: palette.labelTertiary }]} numberOfLines={1}>{value}</Text>
      ) : null}
      {withChevron ? (
        <MaterialCommunityIcons name="chevron-right" color={palette.labelTertiary} size={20} />
      ) : null}
    </ScalePressable>
  );
}

function ChipRow<T>({ options, value, onChange }: { options: { label: string; value: T }[]; value: T; onChange: (value: T) => void }) {
  const palette = usePalette();
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <TouchableOpacity
            key={String(opt.value)}
            style={[
              styles.chip,
              { backgroundColor: active ? palette.tint : palette.fill2 },
            ]}
            onPress={() => onChange(opt.value)}
            activeOpacity={0.85}
          >
            <Text style={[styles.chipText, { color: active ? palette.onTint : palette.labelSecondary }]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(toMs(ts));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SettingsScreen() {
  const navigation = useNavigation<SettingsNavProp>();
  const palette = usePalette();
  const settings = useSettingsStore((state) => state.settings);
  const setSettings = useSettingsStore((state) => state.setSettings);
  const showToast = useUiStore((state) => state.showToast);
  const memberCount = useMemberStore((state) => state.members.length);
  const { t } = useI18n();
  const hasUpdate = useUpdateStore((s) => s.hasUpdate);
  const [meta, setMeta] = useState<MemberDataMeta | null>(null);
  const [logVisible, setLogVisible] = useState(false);

  useEffect(() => {
    getMemberDataMeta().then(setMeta).catch(() => {});
  }, []);

  const backgroundValue = settings.customBackgroundFile?.trim() || '';
  const backgroundInfo = (() => {
    if (!backgroundValue) return t('未设置');
    if (backgroundValue.startsWith('data:')) return t('本地图片已保存，约 {size}KB', { size: Math.round(backgroundValue.length / 1024) });
    return backgroundValue.length > 60 ? `${backgroundValue.slice(0, 60)}...` : backgroundValue;
  })();

  const THEME_OPTIONS = [
    { label: t('跟随系统'), value: 'system' },
    { label: t('浅色'), value: 'light' },
    { label: t('深色'), value: 'dark' },
  ];

  const update = async (key: string, value: any, extra: any = {}) => {
    const patch = { [key]: value, ...extra };
    setSettings(patch);
    try {
      await saveSettings(patch);
      showToast(t('设置已保存'));
    } catch (error: any) {
      showToast(t('保存失败：{msg}', { msg: error?.message || String(error) }));
    }
  };

  const pickBg = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert(t('需要相册权限')); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8, base64: true } as any);
      if (result.canceled) return;
      const base64 = result.assets?.[0]?.base64;
      if (!base64) { Alert.alert(t('未获取到图片数据')); return; }
      const mime = result.assets?.[0]?.mimeType || 'image/jpeg';
      await update('customBackgroundFile', `data:${mime};base64,${base64}`, { customBackgroundUpdatedAt: Date.now() });
    } catch (error: any) {
      Alert.alert(t('背景图失败'), error?.message || String(error));
    }
  };

  const checkVersion = () => {
    const { hasUpdate: up, latestUrl } = useUpdateStore.getState();
    if (up && latestUrl) {
      Linking.openURL(latestUrl).catch(() => {});
    } else {
      // force=true：绕过 24h 限流立即请求（否则冷启静默检查后 24h 内手动检查会直接跳过）；
      // 检查不到更新（含网络失败，视为无更新）统一提示「已是最新版本」
      useUpdateStore.getState().checkUpdate(true).then((has) => {
        const next = useUpdateStore.getState();
        if (has && next.hasUpdate && next.latestUrl) Linking.openURL(next.latestUrl).catch(() => {});
        else showToast(t('已是最新版本'));
      }).catch(() => showToast(t('已是最新版本')));
    }
  };

  return (
    <>
      <View style={[styles.container, { backgroundColor: usePageBackground() }]}>
        <ScreenHeader title={t('设置')} hideBack />
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* 关于 hero 卡 */}
        <Section title="" delay={60}>
          <View style={styles.aboutHero}>
            <View style={[styles.aboutLogoWrap, { backgroundColor: palette.fill3 }]}>
              <Image source={require('../../assets/logo.jpg')} style={styles.aboutLogoImg} />
            </View>
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={[styles.aboutName, { color: palette.label }]}>{t('牙牙消息')}</Text>
              <Text style={[styles.aboutSub, { color: palette.labelSecondary }]} numberOfLines={1}>{t('Yaya Message · 口袋48 第三方客户端')}</Text>
            </View>
            <View style={styles.verChipWrap}>
              <TouchableOpacity
                style={[styles.verChip, { backgroundColor: palette.tintSoft }]}
                onPress={checkVersion}
                activeOpacity={0.85}
              >
                <Text style={[styles.verChipText, { color: palette.tint }]}>v{APP_VERSION}</Text>
              </TouchableOpacity>
              {hasUpdate ? <View style={[styles.verDot, { backgroundColor: palette.danger, borderColor: palette.surface }]} /> : null}
            </View>
          </View>
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
          <Row
            icon="github"
            title={t('本项目仓库')}
            value="Xenia0922/yaya_msg_mobile"
            onPress={() => Linking.openURL('https://github.com/Xenia0922/yaya_msg_mobile').catch(() => {})}
          />
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
          <Row
            icon="download-circle"
            title={t('下载页')}
            value="010push.a23xyz.xyz/app"
            onPress={() => Linking.openURL('https://010push.a23xyz.xyz/app/').catch(() => {})}
          />
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
          <Row
            icon="book-open-page-variant"
            title={t('开源协议')}
            value={t('GPL-3.0 · 本地缓存')}
            onPress={() => { showToast(t('基于 GPL-3.0 协议开源，仅供学习交流')); }}
          />
        </Section>

        {/* 账号 */}
        <Section title={t('账号')} delay={100}>
          <Row
            icon="account-key"
            title={t('进入账号管理')}
            value={t('登录 / 切换 / 修改资料')}
            onPress={() => navigation.navigate('LoginScreen')}
          />
        </Section>

        {/* 外观 */}
        <Section title={t('外观')} delay={140}>
          <View style={styles.innerPad}>
            <Text style={[styles.rowLabel, { color: palette.labelSecondary }]}>{t('主题')}</Text>
            <ChipRow options={THEME_OPTIONS} value={settings.theme} onChange={(v) => update('theme', v)} />
          </View>
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
          <Row
            icon="image"
            title={t('背景图')}
            value={backgroundInfo}
            onPress={pickBg}
          />
          {backgroundValue ? (
            <>
              <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
              <Row
                icon="restore"
                title={t('恢复默认背景')}
                danger
                withChevron={false}
                onPress={() => {
                  Alert.alert(t('恢复默认背景'), t('将移除当前背景图，确定？'), [
                    { text: t('取消'), style: 'cancel' },
                    { text: t('恢复默认'), style: 'destructive', onPress: () => update('customBackgroundFile', '', { customBackgroundUpdatedAt: Date.now() }) },
                  ]);
                }}
              />
            </>
          ) : null}
        </Section>

        {/* 语言 */}
        <Section title={t('语言')} delay={180}>
          <View style={styles.innerPad}>
            <ChipRow options={LANGUAGE_OPTIONS.map((o) => ({ ...o, label: o.value === 'system' ? t(o.label) : o.label }))} value={settings.language || 'system'} onChange={(v) => update('language', v)} />
          </View>
        </Section>

        {/* 自动签到 */}
        <Section title={t('自动签到')} delay={220}>
          <View style={styles.innerPad}>
            <ChipRow options={[{ label: t('关闭'), value: false as any }, { label: t('开启'), value: true as any }]} value={settings.yaya_auto_checkin_enabled} onChange={(v) => update('yaya_auto_checkin_enabled', v)} />
            {settings.yaya_auto_checkin_enabled ? (
              <Text style={[styles.rowLabel, { color: palette.labelSecondary, marginTop: 10 }]}>
                {t('上次签到：{date}', { date: settings.yaya_auto_checkin_last_date || t('尚未执行') })}
              </Text>
            ) : null}
          </View>
        </Section>

        {/* 工具 */}
        <Section title={t('工具')} delay={260}>
          <Row
            icon="download"
            title={t('下载管理')}
            onPress={() => navigation.navigate('DownloadScreen')}
          />
          <View style={[styles.divider, { backgroundColor: palette.innerStroke }]} />
          <Row
            icon="text-box-search-outline"
            title={t('运行日志')}
            onPress={() => setLogVisible(true)}
          />
        </Section>

        {/* 成员数据 */}
        <Section title={t('成员数据')} delay={300}>
          <View style={styles.memberStatRow}>
            <View style={[styles.memberStatCard, { backgroundColor: palette.fill3 }]}>
              <Text style={[styles.memberStatNum, { color: palette.label }]}>{memberCount}</Text>
              <Text style={[styles.memberStatLabel, { color: palette.labelSecondary }]}>{t('位成员')}</Text>
            </View>
            <View style={[styles.memberStatCard, { backgroundColor: palette.fill3 }]}>
              <Text style={[styles.memberStatNum, { color: palette.label }]}>{meta ? formatTime(meta.savedAt) : t('尚未同步')}</Text>
              <Text style={[styles.memberStatLabel, { color: palette.labelSecondary }]}>{t('最近更新')}</Text>
            </View>
          </View>
          <View style={[styles.autoSyncRow, { backgroundColor: palette.tintSoft }]}>
            <MaterialCommunityIcons name="sync" size={16} color={palette.tint} />
            <Text style={[styles.autoSyncText, { color: palette.labelSecondary }]}>{t('进入软件时自动同步成员数据')}</Text>
          </View>
          <Text style={[styles.note, { color: palette.labelTertiary }]}>
            {t('成员数据共 {count} 位，数据来源于 yk1z 数据库（yk1z/yaya_msg），进入软件时自动同步最新。', { count: memberCount })}
          </Text>
        </Section>

        <Text style={[styles.footer, { color: palette.labelTertiary }]}>{t('Version {v}', { v: APP_VERSION })}</Text>
        </ScrollView>
      </View>
      <RuntimeLogViewer visible={logVisible} onClose={() => setLogVisible(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingBottom: 112, paddingHorizontal: 16 },
  sectionTitle: { fontSize: 14, fontWeight: '700', marginTop: 20, marginBottom: 8, paddingHorizontal: 4 },
  section: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  innerPad: { padding: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  rowTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600' },
  rowValue: { flexShrink: 1, fontSize: 12, marginRight: 6, maxWidth: '48%', textAlign: 'right' },
  rowLabel: { fontSize: 12, lineHeight: 18, marginBottom: 6 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 54 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radiiAlias.button },
  chipText: { fontSize: 13, fontWeight: '700' },
  // 关于 hero
  aboutHero: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  aboutLogoWrap: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  aboutLogoImg: { width: 52, height: 52, borderRadius: 16 },
  aboutName: { fontSize: 20, fontWeight: '800' },
  aboutSub: { fontSize: 12, marginTop: 4 },
  verChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radiiAlias.button },
  verChipWrap: { alignItems: 'flex-end' },
  verDot: { position: 'absolute', top: -2, right: -2, width: 9, height: 9, borderRadius: 5, borderWidth: 1.5 },
  verChipText: { fontSize: 12, fontWeight: '800' },
  // 成员数据
  memberStatRow: { flexDirection: 'row', gap: 10, padding: 14 },
  memberStatCard: {
    flex: 1,
    padding: 16,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  memberStatNum: { fontSize: 18, fontWeight: '900', textAlign: 'center' },
  memberStatLabel: { fontSize: 11, marginTop: 4 },
  autoSyncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 14,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radiiAlias.card,
  },
  autoSyncText: { fontSize: 12, marginLeft: 8, fontWeight: '600' },
  note: { marginHorizontal: 14, marginTop: 10, fontSize: 11, lineHeight: 16 },
  footer: { textAlign: 'center', fontSize: 12, marginTop: 24 },
});
