import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PerfFlatList } from '../components/PerfFlatList';
import { CenterSpinner } from '../components/Loaders';

import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import PlayerScreen, { buildPocketHeaders } from '../player';
import { RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import MemberPicker from '../components/MemberPicker';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import { Pill } from '../components/Pill';
import { Button } from '../components/Button';
import { ScalePressable } from '../components/Motion';
import { EmptyState, ErrorState } from '../components/StateViews';
import { LoginPrompt } from '../components/LoginPrompt';
import { RootStackParamList } from '../navigation/types';
import { useSettingsStore } from '../store';
import pocketApi from '../api/pocket48';
import { FadeInView } from '../components/Motion';
import { Member } from '../types';
import { errorMessage, normalizeUrl, pickText, unwrapList } from '../utils/data';
import { formatTimestamp , toMs } from '../utils/format';
import { parseDurationSeconds } from '../utils/duration';
import { usePalette, radii, radiiAlias } from '../theme';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useI18n } from '../i18n';

type FlipNavProp = StackNavigationProp<RootStackParamList, 'FlipScreen'>;
type FlipRouteProp = RouteProp<RootStackParamList, 'FlipScreen'>;
type PrivacyType = '1' | '2' | '3';

interface FlipPriceConfig {
  answerType: number;
  normalCost: number;
  privateCost: number;
  anonymityCost: number;
  raw: any;
}

const PRIVACY_OPTIONS: { value: PrivacyType; label: string }[] = [
  { value: '1', label: '公开' },
  { value: '2', label: '私密' },
  { value: '3', label: '匿名' },
];

function normalizeFlipList(res: any): any[] {
  return unwrapList(res, [
    'content.questions',
    'content.questionList',
    'content.list',
    'content.data',
    'data.questions',
    'data.questionList',
    'data.list',
    'questions',
    'list',
  ]);
}

function normalizePriceList(res: any): FlipPriceConfig[] {
  const list = unwrapList(res, [
    'content.customs',
    'content.answers',
    'content.answerList',
    'content.customAnswers',
    'content.questions',
    'content.list',
    'content.data',
    'data.customs',
    'data.answers',
    'data.list',
    'customs',
    'answers',
    'list',
  ]);

  const source = list.length ? list : res?.content?.customs ? [res.content.customs] : [];
  // ⚠️ 修复：customs 是「配置对象数组」时须原样保留；只有 customs 是「{type:{cfg}} 对象表」才展开 values。
  // 旧实现把对象拆成 数值数组(1,725,88...) → answerType 全丢 → filter 后恒空 → "未开通/不显示"。
  return source
    .flatMap((item: any) => {
      if (Array.isArray(item)) return item;
      const vals = Object.values(item);
      return vals.every((v) => v && typeof v === 'object') ? vals : [item];
    })
    .map((item: any) => {
      const fallbackCost = toNumber(item?.price ?? item?.cost ?? item?.normalCost);
      return {
        answerType: toNumber(item?.answerType ?? item?.questionType ?? item?.type),
        normalCost: toNumber(item?.normalCost ?? item?.publicCost ?? fallbackCost),
        privateCost: toNumber(item?.privateCost ?? item?.secretCost ?? fallbackCost),
        anonymityCost: toNumber(item?.anonymityCost ?? item?.anonymousCost ?? fallbackCost),
        raw: item,
      };
    })
    .filter((item) => [1, 2, 3].includes(item.answerType));
}

function toNumber(value: any): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function memberName(item: any, fallback = '成员'): string {
  return pickText(item, ['memberName', 'baseUserInfo.nickname', 'baseUserInfo.nickName', 'starName'], fallback);
}

function answerTypeLabel(type: any): string {
  if (Number(type) === 1) return '文字';
  if (Number(type) === 2) return '语音';
  if (Number(type) === 3) return '视频';
  return '未知';
}

function privacyLabel(type: any): string {
  if (Number(type) === 1) return '公开';
  if (Number(type) === 2) return '私密';
  if (Number(type) === 3) return '匿名';
  return '未知';
}

function statusLabel(status: any): string {
  if (Number(status) === 1) return '等待回复中';
  if (Number(status) === 2) return '已翻牌';
  if (Number(status) === 3) return '已退款';
  return '等待回复中';
}

function questionText(item: any): string {
  return pickText(item, ['content', 'questionContent', 'question', 'questionText', 'text'], '');
}

function parseMedia(raw: string): { text: string; url: string; duration: number } {
  if (!raw) return { text: '', url: '', duration: 0 };
  if (/^https?:\/\//i.test(raw.trim())) return { text: '', url: normalizeUrl(raw), duration: 0 };
  try {
    const json = JSON.parse(raw);
    const url = normalizeUrl(pickText(json, ['url', 'mediaUrl', 'audioUrl', 'videoUrl']));
    const dur = parseDurationSeconds(json?.duration || json?.time || json?.second || json?.audioTime || json?.length || 0);
    return { url, text: pickText(json, ['text', 'content'], ''), duration: Number.isFinite(dur) ? Math.round(dur) : 0 };
  } catch {
    return { text: raw, url: '', duration: 0 };
  }
}

function parseAnswer(item: any, voiceLabel = '语音回复', videoLabel = '视频回复'): { text: string; url: string; duration: number } {
  const raw = pickText(item, ['answerContent', 'answer', 'answerText', 'replyContent']);
  if (!raw) return { text: '', url: '', duration: 0 };
  const m = parseMedia(raw);
  // For audio/video, set appropriate text labels
  if (Number(item.answerType) === 2 && !m.text) m.text = voiceLabel;
  if (Number(item.answerType) === 3 && !m.text) m.text = videoLabel;
  // Fallback to raw text if nothing else
  if (!m.text && !m.url) m.text = raw;
  else if (!m.text && m.url) m.text = m.url; // fallback: show URL if no text
  return m;
}

function answerMediaUrl(item: any): string { return parseAnswer(item).url; }
function answerText(item: any): string { return parseAnswer(item).text; }
function answerMediaDuration(item: any): number { return parseAnswer(item).duration; }

function priceFor(config: FlipPriceConfig | undefined, privacyType: PrivacyType): number {
  if (!config) return 0;
  if (privacyType === '2') return config.privateCost;
  if (privacyType === '3') return config.anonymityCost;
  return config.normalCost;
}

export default function FlipScreen() {
  const navigation = useNavigation<FlipNavProp>();
  const route = useRoute<FlipRouteProp>();
  const palette = usePalette();
  const { t } = useI18n();
  const mode = route.params?.mode || 'view';

  const [flips, setFlips] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [status, setStatus] = useState('');
  const pageRef = useRef(1);
  const loadingRef = useRef(false);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [prices, setPrices] = useState<FlipPriceConfig[]>([]);
  const [answerType, setAnswerType] = useState<number | null>(null);
  const [privacyType, setPrivacyType] = useState<PrivacyType>('1');
  const [cost, setCost] = useState('');
  const [content, setContent] = useState('');
  const [balance, setBalance] = useState('');
  const [playingAnswerUrl, setPlayingAnswerUrl] = useState('');

  const selectedPrice = useMemo(
    () => prices.find((item) => item.answerType === answerType),
    [answerType, prices],
  );
  const minCost = priceFor(selectedPrice, privacyType);

  const loadFlips = useCallback(async (nextPage = 1, replace = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setStatus('');
    try {
      const res = await pocketApi.getFlipList((nextPage - 1) * 100, 100);
      const list = normalizeFlipList(res);
      setFlips((prev) => (replace ? list : [...prev, ...list]));
      // G5: offset 分页恰好 100 条时下一页为空——空页即终止（否则 onEnd 无限空拉）
      setHasMore(list.length >= 100 && list.length > 0);
      if (list.length === 0 && replace) {
        setStatus('');
      } else if (replace) {
        setStatus(t('已加载 {count} 条翻牌记录', { count: list.length }));
      }
    } catch (error) {
      setStatus(t('加载翻牌记录失败：{err}', { err: errorMessage(error) }));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === 'view') {
      pageRef.current = 1;
      loadFlips(1, true);
    }
  }, [loadFlips, mode]);

  useEffect(() => {
    if (mode !== 'send') return;
    pocketApi.getUserMoney()
      .then((res) => {
        const money = res?.content?.moneyTotal ?? res?.data?.moneyTotal ?? res?.content?.money ?? res?.data?.money ?? '';
        if (money !== '') setBalance(String(money));
      })
      .catch(() => {});
  }, [mode]);

  useEffect(() => {
    if (!selectedPrice) {
      setCost('');
      return;
    }
    setCost(String(minCost || ''));
  }, [minCost, selectedPrice]);

  const selectMemberForPrice = async (member: Member) => {
    setSelectedMember(member);
    setPrices([]);
    setAnswerType(null);
    setPrivacyType('1');
    setCost('');
    setStatus('');
    if (!useSettingsStore.getState().settings.p48Token) {
      setStatus(t('未登录口袋账号，无法获取翻牌配置'));
      return;
    }
    try {
      const res = await pocketApi.getFlipPrices(member.id);
      const list = normalizePriceList(res);
      setPrices(list);
      setAnswerType(list[0]?.answerType ?? null);
      setStatus(list.length ? t('已加载 {count} 种回复形式', { count: list.length }) : t('该成员暂未开放翻牌'));
    } catch (error) {
      setStatus(t('加载翻牌配置失败：{err}', { err: errorMessage(error) }));
    }
  };

  const sendFlip = async () => {
    const finalCost = toNumber(cost);
    if (!selectedMember) {
      setStatus(t('请先选择成员'));
      return;
    }
    if (!answerType || !selectedPrice) {
      setStatus(t('请选择文字、语音或视频翻牌'));
      return;
    }
    if (!content.trim()) {
      setStatus(t('请输入翻牌内容'));
      return;
    }
    if (!minCost) {
      setStatus(t('{type}翻牌的{privacy}设置暂未开放', { type: t(answerTypeLabel(answerType)), privacy: t(privacyLabel(privacyType)) }));
      return;
    }
    if (finalCost < minCost) {
      setStatus(t('鸡腿数不能低于官方底价 {min}', { min: minCost }));
      setCost(String(minCost));
      return;
    }

    setLoading(true);
    setStatus(t('正在发送翻牌...'));
    try {
      await pocketApi.sendFlipQuestion({
        memberId: parseInt(selectedMember.id, 10),
        content: content.trim(),
        type: Number(privacyType),
        cost: finalCost,
        answerType,
      });
      setContent('');
      setStatus(t('发送成功，已提交到口袋翻牌'));
    } catch (error) {
      setStatus(t('发送翻牌失败：{err}', { err: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  };

  const pageStyle = styles.container;

  // 翻牌记录按提问月份分组（倒序）
  // 注意：必须在所有条件 return 之前调用（hooks 规则），否则 view↔send 切换时
  // 「Rendered fewer hooks than expected」崩溃，发送页打不开。
  const flipRows = useMemo(() => {
    const monthOf = (ts: number): string => {
      if (!ts) return t('未知时间');
      const d = new Date(toMs(ts));
      return t('{y}年{m}月', { y: d.getFullYear(), m: d.getMonth() + 1 });
    };
    const order: string[] = [];
    const map = new Map<string, any[]>();
    for (const f of flips) {
      const key = monthOf(Number(f.qtime || f.createTime || 0));
      if (!map.has(key)) { map.set(key, []); order.push(key); }
      map.get(key)!.push(f);
    }
    const flat: { type: 'header' | 'item'; key: string; title?: string; item?: any }[] = [];
    for (const k of order) {
      flat.push({ type: 'header', key: `h-${k}`, title: k });
      // key 兜底用「组内序号」而非 Math.random()：random 会在每次渲染/滚动时重算，
      // 导致项身份不稳定、触发整列重挂载与入场动画重放。
      map.get(k)!.forEach((it, idx) => flat.push({ type: 'item', key: `i-${String(it.questionId || it.id || 'x')}-${idx}`, item: it }));
    }
    return flat;
  }, [flips, t]);

  if (mode === 'send') {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={pageStyle}
      >
      <ScrollView style={pageStyle} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sendContainer}>
        <ScreenHeader title={t('发送翻牌')} />

        <FadeInView delay={60} duration={300}>
          {/* 成员选择行 */}
          <View style={[styles.sendGroup, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
            <View style={styles.groupRowTop}>
              <View style={[styles.groupIcon, { backgroundColor: palette.tintSoft }]}>
                <MaterialCommunityIcons name="account-heart-outline" size={18} color={palette.tint} />
              </View>
              <Text style={[styles.groupLabel, { color: palette.label }]}>{t('选择成员')}</Text>
            </View>
            <MemberPicker selectedMember={selectedMember} onSelect={selectMemberForPrice} />
          </View>

          {/* 回复形式 */}
          <View style={[styles.sendGroup, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
            <View style={styles.groupRowTop}>
              <View style={[styles.groupIcon, { backgroundColor: palette.tintSoft }]}>
                <MaterialCommunityIcons name="message-reply-outline" size={18} color={palette.tint} />
              </View>
              <Text style={[styles.groupLabel, { color: palette.label }]}>{t('回复形式')}</Text>
            </View>
            <View style={styles.optionRow}>
              {prices.map((item) => {
                const active = answerType === item.answerType;
                return (
                  <Pill
                    key={String(item.answerType)}
                    label={t('{type}翻牌', { type: t(answerTypeLabel(item.answerType)) })}
                    selected={active}
                    onPress={() => setAnswerType(item.answerType)}
                    style={styles.optionPill}
                  />
                );
              })}
            </View>
            {!prices.length ? <Text style={[styles.hint, { color: palette.labelTertiary }]}>{t('选择成员后显示可用的文字、语音、视频翻牌')}</Text> : null}
          </View>

          {/* 公开设置 */}
          <View style={[styles.sendGroup, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
            <View style={styles.groupRowTop}>
              <View style={[styles.groupIcon, { backgroundColor: palette.tintSoft }]}>
                <MaterialCommunityIcons name="eye-outline" size={18} color={palette.tint} />
              </View>
              <Text style={[styles.groupLabel, { color: palette.label }]}>{t('公开设置')}</Text>
            </View>
            <View style={styles.optionRow}>
              {PRIVACY_OPTIONS.map((item) => {
                const itemCost = priceFor(selectedPrice, item.value);
                const active = privacyType === item.value;
                const disabled = !!selectedPrice && itemCost <= 0;
                return (
                  <Pill
                    key={item.value}
                    label={`${t(item.label)}${selectedPrice ? ` ${itemCost || t('未开放')}` : ''}`}
                    selected={!disabled && active}
                    onPress={disabled ? undefined : () => setPrivacyType(item.value)}
                    style={[styles.optionPill, disabled && styles.optionDisabled]}
                  />
                );
              })}
            </View>
          </View>

          {/* 输入区 */}
          <View style={[styles.sendGroup, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
            <View style={styles.groupRowTop}>
              <View style={[styles.groupIcon, { backgroundColor: palette.tintSoft }]}>
                <MaterialCommunityIcons name="pencil-outline" size={18} color={palette.tint} />
              </View>
              <Text style={[styles.groupLabel, { color: palette.label }]}>{t('翻牌内容')}</Text>
            </View>
            <TextInput
              style={[styles.textArea, { backgroundColor: palette.fill2, color: palette.label }]}
              placeholder={t('输入你想提问的内容...')}
              placeholderTextColor={palette.labelTertiary}
              multiline
              value={content}
              onChangeText={setContent}
              maxLength={200}
              textAlignVertical="top"
            />
            <View style={styles.inputMetaRow}>
              <Text style={[styles.hint, { color: palette.labelTertiary }]}>{t('{len}/200', { len: content.length })}</Text>
              {balance ? <Text style={[styles.balanceText, { color: palette.labelSecondary }]}>{t('当前余额：{balance} 鸡腿', { balance })}</Text> : null}
            </View>
            {minCost ? (
              <View style={[styles.costRow, { backgroundColor: palette.tintSoft }]}>
                <Text style={[styles.costLabel, { color: palette.tint }]}>{t('鸡腿数')}</Text>
                <TextInput
                  style={[styles.costInput, { color: palette.label }]}
                  keyboardType="numeric"
                  value={cost}
                  onChangeText={setCost}
                  placeholder={minCost ? t('最低 {min}', { min: minCost }) : t('先选择翻牌配置')}
                  placeholderTextColor={palette.labelTertiary}
                />
                <ScalePressable style={styles.rechargeBtn} onPress={() => navigation.navigate('RechargeScreen')} activeOpacity={0.7} pressedScale={0.97}>
                  <MaterialCommunityIcons name="credit-card-outline" size={16} color={palette.tint} />
                  <Text style={[styles.rechargeText, { color: palette.tint }]}>{t('充值')}</Text>
                </ScalePressable>
              </View>
            ) : null}
            <Text style={[styles.costHint, { color: palette.labelTertiary }]}>{t('当前最低：{min} 鸡腿', { min: minCost || 0 })}</Text>
          </View>

          <View style={styles.sendFooter}>
            <Button title={t('发送翻牌')} variant="filled" size="lg" onPress={sendFlip} disabled={loading} loading={loading} fullWidth />
            {status ? <Text style={[styles.statusText, { color: /失败|错误/.test(status) ? palette.danger : palette.tint }]}>{status}</Text> : null}
          </View>
        </FadeInView>
      </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
      <View style={pageStyle}>
      <ScreenHeader title={t('翻牌记录')} right={
        <HeaderAction label={t('发送翻牌')} onPress={() => navigation.navigate('FlipScreen', { mode: 'send' })} />
      } />
      {status ? <Text style={[styles.statusText, { color: /失败|错误/.test(status) ? palette.danger : palette.tint }]}>{status}</Text> : null}
      {/失败|错误/.test(status) ? (
        <View style={styles.retryWrap}>
          <Button title={t('重试')} variant="filled" size="sm" onPress={() => loadFlips(1, true)} />
        </View>
      ) : null}
      <FadeInView delay={80} duration={300} style={{ flex: 1 }}>
        <PerfFlatList
          data={flipRows}
          keyExtractor={(row) => row.key}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          renderItem={({ item, index }) => {
            if (item.type === 'header') {
              return (
                <Text style={[styles.monthGroup, { color: palette.labelTertiary }]}>{item.title}</Text>
              );
            }
            const flip = item.item as any;
            const parsed = parseAnswer(flip, t('语音回复'), t('视频回复'));
            const answer = parsed.text;
            const answerUrl = parsed.url;
            const flipAnswerType = Number(flip.answerType);
            const ansDur = parsed.duration;
            const qTime = Number(flip.qtime || flip.createTime || 0);
            const aTime = Number(flip.answerTime || 0);
            const deadline = qTime ? qTime + 7 * 86400000 : 0;
            const remaining = deadline - Date.now();
            const remainingDays = Math.max(0, Math.floor(remaining / 86400000));
            const remainingHours = Math.max(0, Math.floor((remaining % 86400000) / 3600000));
            const remainingMinutes = Math.max(0, Math.floor((remaining % 3600000) / 60000));
            const remainingStr = aTime ? '' : (remaining > 0 ? t('剩{time}', { time: `${remainingDays > 0 ? t('{m}天', { m: remainingDays }) : ''}${remainingHours > 0 ? t('{m}小时', { m: remainingHours }) : ''}${t('{m}分', { m: remainingMinutes })}` }) : t('已过期'));
            const elapsed = aTime && qTime ? aTime - qTime : 0;
            const elapsedDays = Math.floor(elapsed / 86400000);
            const elapsedHours = Math.floor((elapsed % 86400000) / 3600000);
            const elapsedMinutes = Math.floor((elapsed % 3600000) / 60000);
            const elapsedStr = elapsed > 0 ? t('耗时 {time}', { time: `${elapsedDays > 0 ? t('{m}天', { m: elapsedDays }) : ''}${elapsedHours > 0 ? t('{m}小时', { m: elapsedHours }) : ''}${t('{m}分', { m: elapsedMinutes })}` }) : '';
            return (
              <FadeInView delay={index < 12 ? 60 + index * 25 : 0} distance={8}>
                <View style={[styles.card, { backgroundColor: palette.fill2 }]}>
                  <View style={styles.cardTop}>
                    <View style={styles.tagRow}>
                      <View style={[styles.typeTag, { backgroundColor: palette.tintSoft }]}>
                        <Text style={[styles.typeTagText, { color: palette.tint }]}>{t(answerTypeLabel(flip.answerType))}</Text>
                      </View>
                      <View style={[styles.privacyTag, { backgroundColor: palette.fill3 }]}>
                        <Text style={[styles.privacyTagText, { color: palette.labelSecondary }]}>{t(privacyLabel(flip.type))}</Text>
                      </View>
                      {/* 状态徽标 */}
                      {Number(flip.status) === 1 ? (
                        <View style={[styles.statusBadge, { backgroundColor: palette.tintSoft }]}>
                          <Text style={[styles.statusBadgeText, { color: palette.tint }]}>{t(statusLabel(flip.status))}</Text>
                        </View>
                      ) : Number(flip.status) === 2 ? (
                        <View style={[styles.statusBadge, { backgroundColor: 'rgba(52,199,89,0.14)' }]}>
                          <Text style={[styles.statusBadgeText, { color: palette.success }]}>{t(statusLabel(flip.status))}</Text>
                        </View>
                      ) : (
                        <View style={[styles.statusBadge, { backgroundColor: 'rgba(255,59,48,0.12)' }]}>
                          <Text style={[styles.statusBadgeText, { color: palette.danger }]}>{t(statusLabel(flip.status))}</Text>
                        </View>
                      )}
                    </View>
                    <Text style={[styles.cardDate, { color: palette.labelTertiary }]}>{formatTimestamp(flip.qtime || flip.createTime)}</Text>
                  </View>

                  <Text style={[styles.memberName, { color: palette.label }]}>{memberName(flip, t('成员'))}</Text>
                  <Text style={[styles.cardQ, { color: palette.label }]} numberOfLines={3}>{t('问：{text}', { text: questionText(flip) || t('未返回问题内容') })}</Text>

                  {answer ? (
                    <View style={styles.answerRow}>
                      <Text style={[styles.cardA, { color: palette.labelSecondary }]} numberOfLines={2}>{t('答：{text}', { text: answer })}</Text>
                      {answerUrl && (flipAnswerType === 2 || flipAnswerType === 3) ? (
                        <ScalePressable
                          style={[styles.answerBtn, { backgroundColor: palette.tintSoft }]}
                          onPress={() => setPlayingAnswerUrl((prev) => (prev === answerUrl ? '' : answerUrl))}
                          pressedScale={0.96}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                        >
                          <MaterialCommunityIcons name={playingAnswerUrl === answerUrl ? 'chevron-up' : 'play'} size={16} color={palette.tint} />
                        </ScalePressable>
                      ) : null}
                    </View>
                  ) : (
                    <Text style={[styles.cardPending, { color: palette.tint }]}>{t(statusLabel(flip.status))}</Text>
                  )}

                  {playingAnswerUrl === answerUrl && answerUrl ? (
                    <View style={styles.answerMediaCard}>
                      {/* 统一播放器（重写）：翻牌答案 → 内嵌 PlayerScreen */}
                      <PlayerScreen
                        inline
                        source={{
                          kind: flipAnswerType === 2 ? 'audio' : 'vod',
                          url: answerUrl,
                          headers: buildPocketHeaders(),
                        }}
                        meta={{ title: t('翻牌答案') }}
                        features={{ kernelSwitch: true, rate: true }}
                        persistent
                      />
                    </View>
                  ) : null}

                  <Text style={[styles.cardMeta, { color: palette.labelTertiary }]}>
                    {t('{cost} 鸡腿', { cost: flip.cost || 0 })}
                    {remainingStr ? ` · ${remainingStr}` : ''}
                    {elapsedStr ? ` · ${elapsedStr}` : ''}
                    {flip.answerTime ? ` · ${t('回复于 {time}', { time: formatTimestamp(flip.answerTime) })}` : ''}
                  </Text>
                </View>
              </FadeInView>
            );
          }}
          onEndReached={() => {
            if (loadingRef.current || !hasMore) return;
            const nextPage = pageRef.current + 1;
            pageRef.current = nextPage;
            loadFlips(nextPage);
          }}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={!useSettingsStore.getState().settings.p48Token ? <LoginPrompt hint={t('查看翻牌记录需要登录')} /> : /失败|错误/.test(status) ? <ErrorState title={t('加载失败')} hint={status} onAction={() => loadFlips(1, true)} /> : <EmptyState icon="card-text-outline" title={t('暂无翻牌记录')} hint={t('去发送翻牌查询历史记录')} />}
        />
      </FadeInView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  sendContainer: { paddingBottom: 48 },
  retryWrap: { alignItems: 'center', marginTop: 6 },
  // 发送表单分组
  sendGroup: { padding: 14, marginHorizontal: 16, marginVertical: 6, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  groupRowTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  groupIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  groupLabel: { fontSize: 15, fontWeight: '700' },
  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  optionPill: { marginBottom: 0 },
  optionDisabled: { opacity: 0.45 },
  textArea: {
    minHeight: 120,
    padding: 12,
    borderRadius: radiiAlias.input,
    fontSize: 14,
    lineHeight: 20,
  },
  inputMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  costRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    borderRadius: radiiAlias.input,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  costLabel: { fontSize: 13, fontWeight: '700', marginRight: 8 },
  costInput: { flex: 1, paddingVertical: 6, fontSize: 14 },
  costHint: { marginTop: 8, fontSize: 12 },
  rechargeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 10, paddingHorizontal: 12, minHeight: 40 },
  rechargeText: { fontSize: 13, fontWeight: '700' },
  hint: { marginTop: 8, fontSize: 12 },
  balanceText: { fontSize: 13, fontWeight: '600' },
  sendFooter: { marginTop: 16, marginHorizontal: 16 },
  statusText: { margin: 12, textAlign: 'center', fontSize: 13 },
  // 历史记录行卡
  card: {
    padding: 14,
    marginHorizontal: 16,
    marginVertical: 4,
    borderRadius: radiiAlias.card,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardDate: { fontSize: 11, fontWeight: '500' },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, flexWrap: 'wrap' },
  typeTag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radii.xs },
  typeTagText: { fontSize: 11, fontWeight: '700' },
  privacyTag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radii.xs },
  privacyTagText: { fontSize: 11, fontWeight: '700' },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radii.xs },
  statusBadgeText: { fontSize: 11, fontWeight: '700' },
  memberName: { fontSize: 13, fontWeight: '700', marginBottom: 6 },
  cardQ: { fontSize: 14, marginBottom: 8, lineHeight: 20 },
  cardA: { fontSize: 13, lineHeight: 19, flex: 1, marginRight: 10 },
  answerRow: { flexDirection: 'row', alignItems: 'center' },
  answerBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 2,
  },
  answerMediaCard: { marginTop: 8 },
  answerAudio: { height: 52, marginTop: 8, borderRadius: 12 },
  answerVideo: { height: 190, marginTop: 8, backgroundColor: '#000', borderRadius: 12 },
  cardPending: { fontSize: 13, fontWeight: '700' },
  cardMeta: { fontSize: 11, marginTop: 8 },
  monthGroup: { fontSize: 13, fontWeight: '700', marginTop: 12, marginBottom: 2, paddingHorizontal: 16 },
});
