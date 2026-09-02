/**
 * CommunityScreen · Area48 社区（2.6.5 新增）
 *
 * 能力边界（严格对齐 API）：
 *  - 推荐 / 最新 双 Tab 帖子流（getArea48Recommend / getArea48Newest，nextId 游标分页）
 *  - 帖子卡片 → 详情页（getArea48PostDetails）
 *  - 发帖弹层（createArea48Post + getPocketMaskWords 屏蔽词校验）
 *  - feed 中的 BANNER / HOTTOPIC 条目依赖 topic 系列接口（移动端 API 层未提供），按能力边界跳过不渲染
 *  - 社区接口需登录（token），未登录时给出「去登录」引导态
 *
 * 分页复用共享 usePaginator（同步 ref 锁 + runId 丢弃过期响应 + postId 去重合并）。
 *
 * 布局（layout-spec-v2 §7 分段 / §9 FAB）：
 *  - 推荐 / 最新 用 fill2 底容器 + 选中白胶囊的分段控件；
 *  - 右下角发布 FAB（tint 圆 56 + plus 白字 + sm 阴影，ScalePressable 0.94）；
 *  - 发帖底部 sheet（radii.sheet 顶角 + handle + 输入 + 话题行 + 发布按钮）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import ScreenHeader from '../components/ScreenHeader';
import { PerfFlatList } from '../components/PerfFlatList';
import { FadeInView, ScalePressable } from '../components/Motion';
import ZoomImageModal from '../components/ZoomImageModal';
import CommunityPostCard from '../components/CommunityPostCard';
import { CenterSpinner } from '../components/Loaders';
import { EmptyState, ErrorState } from '../components/StateViews';
import { Button } from '../components/Button';
import { Skeleton } from '../components/Skeleton';
import { usePalette, radii, radiiAlias, makeShadows } from '../theme';
import { useSafeAreaInsets } from '../hooks/useSafeAreaInsets';
import { useI18n } from '../i18n';
import { usePaginator } from '../hooks/usePaginator';
import { useSettingsStore, useUiStore } from '../store';
import pocketApi from '../api/pocket48';
import { errorMessage } from '../utils/data';
import { checkMaskWords, CommunityPost, normalizeCommunityPost } from '../utils/community';

type FeedMode = 'recommend' | 'newest';

/** feed 条目归一化：兼容 content.list（type+data 结构）与 content.postsInfo（直接帖子数组） */
function normalizeFeedList(content: any): CommunityPost[] {
  const rawList = Array.isArray(content?.list)
    ? content.list
    : Array.isArray(content?.postsInfo)
      ? content.postsInfo.map((p: any) => ({ type: 'POSTS', data: p }))
      : Array.isArray(content?.data)
        ? content.data.map((p: any) => ({ type: 'POSTS', data: p }))
        : [];
  return rawList
    .map((item: any) => normalizeCommunityPost(item))
    .filter((p: CommunityPost | null): p is CommunityPost => Boolean(p));
}

export default function CommunityScreen() {
  const navigation = useNavigation<any>();
  const palette = usePalette();
  const shadows = makeShadows(palette.name === 'dark');
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const token = useSettingsStore((s) => s.settings.p48Token);
  const showToast = useUiStore((s) => s.showToast);

  const [mode, setMode] = useState<FeedMode>('recommend');
  const [error, setError] = useState('');
  const [zoomUrl, setZoomUrl] = useState('');
  const [composeVisible, setComposeVisible] = useState(false);
  const composeBusyRef = useRef(false);

  const fetchPage = useCallback(
    async (cursor: number) => {
      if (!token) {
        setError(t('社区需要登录，请先在账号设置登录口袋48'));
        return { items: [] as CommunityPost[], nextCursor: cursor, hasMore: false };
      }
      setError('');
      try {
        const res = mode === 'recommend'
          ? await pocketApi.getArea48Recommend(cursor)
          : await pocketApi.getArea48Newest(cursor);
        const content = res?.content || res?.data || {};
        const items = normalizeFeedList(content);
        const nextId = Number(content?.nextId || content?.next || 0);
        return { items, nextCursor: nextId, hasMore: nextId > 0 && items.length > 0 };
      } catch (e: any) {
        setError(errorMessage(e));
        return { items: [] as CommunityPost[], nextCursor: cursor, hasMore: false };
      }
    },
    [mode, token, t],
  );

  const mergePosts = useCallback((prev: CommunityPost[], next: CommunityPost[]) => {
    const seen = new Set(prev.map((p) => p.postId));
    return [...prev, ...next.filter((p) => !seen.has(p.postId))];
  }, []);

  const pag = usePaginator<CommunityPost>({ fetchPage, initialCursor: 0, merge: mergePosts });
  const { items, loading, hasMore, refresh, loadMore, loadingRef } = pag;

  // 切换 Tab 时重置到第一页
  useEffect(() => {
    refresh();
  }, [mode, refresh]);

  const openCompose = useCallback(() => {
    if (!token) {
      showToast(t('社区需要登录，请先在账号设置登录口袋48'));
      navigation.navigate('LoginScreen');
      return;
    }
    setComposeVisible(true);
  }, [navigation, showToast, t, token]);

  const openDetail = useCallback((post: CommunityPost) => {
    navigation.navigate('CommunityPostDetailScreen', { postId: post.postId, title: post.title });
  }, [navigation]);

  const handleModePress = useCallback((next: FeedMode) => {
    if (next !== mode) setMode(next);
  }, [mode]);

  const listEmpty = useMemo(() => {
    if (loading) {
      return (
        <View style={styles.skeletonWrap}>
          {Array.from({ length: 3 }).map((_, i) => (
            <View key={i} style={[styles.skeletonCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
              <View style={[styles.skeletonHead, { alignItems: 'center' }]}>
                <Skeleton width={34} height={34} radius={17} />
                <View style={{ marginLeft: 9, flex: 1 }}>
                  <Skeleton width="35%" height={12} />
                  <Skeleton width="22%" height={9} style={{ marginTop: 7 }} />
                </View>
              </View>
              <Skeleton width="95%" height={13} style={{ marginTop: 13 }} />
              <Skeleton width="70%" height={13} style={{ marginTop: 8 }} />
              <View style={{ flexDirection: 'row', gap: 4, marginTop: 13 }}>
                {[0, 1, 2].map((j) => <Skeleton key={j} width="31%" height={78} radius={10} />)}
              </View>
            </View>
          ))}
        </View>
      );
    }
    if (!token) {
      return (
        <EmptyState
          icon="account-lock-outline"
          title={t('社区需要登录')}
          hint={t('社区动态、评论、发帖都需要口袋账号；登录后即可浏览')}
          actionLabel={t('去登录')}
          onAction={() => navigation.navigate('LoginScreen')}
        />
      );
    }
    if (error) return <ErrorState title={t('加载失败')} hint={error} onAction={() => refresh()} />;
    return <EmptyState icon="forum-outline" title={t('暂无社区动态')} hint={t('下拉刷新或稍后再来看看')} />;
  }, [error, loading, navigation, palette, refresh, t, token]);

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('社区')} />

      {/* 推荐 / 最新 分段控件：fill2 底容器 + 选中白胶囊 */}
      <View style={[styles.tabs, { backgroundColor: palette.fill2 }]}>
        {(['recommend', 'newest'] as FeedMode[]).map((m) => {
          const active = mode === m;
          return (
            <ScalePressable
              key={m}
              onPress={() => handleModePress(m)}
              pressedScale={0.96}
              style={[styles.tab, active && { backgroundColor: palette.surface, ...shadows.sm }]}
              activeOpacity={0.85}
            >
              <Text style={[styles.tabText, { color: active ? palette.label : palette.labelSecondary, fontWeight: active ? '700' : '600' }]}>
                {m === 'recommend' ? t('推荐') : t('最新')}
              </Text>
            </ScalePressable>
          );
        })}
      </View>

      <PerfFlatList
        data={items}
        keyExtractor={(item) => item.postId}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 88 }]}
        initialNumToRender={10}
        onEndReached={() => { if (hasMore && !loadingRef.current) loadMore(); }}
        onEndReachedThreshold={0.35}
        renderItem={({ item, index }) => (
          <FadeInView delay={index < 12 ? 60 + index * 25 : 0} duration={260}>
            <CommunityPostCard
              post={item}
              onPress={() => openDetail(item)}
              onImagePress={setZoomUrl}
            />
          </FadeInView>
        )}
        ListFooterComponent={
          items.length ? (
            <Text style={[styles.footer, { color: palette.labelSecondary }]}>
              {loading ? '' : hasMore ? t('上滑继续加载') : t('没有更多了')}
            </Text>
          ) : null
        }
        ListEmptyComponent={listEmpty}
      />

      {/* 右下角发布 FAB */}
      <ScalePressable
        onPress={openCompose}
        pressedScale={0.94}
        activeOpacity={0.85}
        style={[styles.fab, { backgroundColor: palette.tint, bottom: insets.bottom + 12, ...shadows.sm }]}
        accessibilityRole="button"
        accessibilityLabel={t('发布')}
      >
        <MaterialCommunityIcons name="plus" size={28} color={palette.onTint} />
      </ScalePressable>

      <ZoomImageModal url={zoomUrl} onClose={() => setZoomUrl('')} />
      <ComposeModal
        visible={composeVisible}
        busyRef={composeBusyRef}
        onClose={() => setComposeVisible(false)}
        onPosted={() => {
          // R8: 发帖后切「最新」并刷新——若已在 newest 手动刷（effect 不触发）；
          // 否则只 setMode，由 mode effect 触发 reset 刷新（避免 recommend 请求占住 loadingRef 后
          // refresh() 被 usePaginator 重入保护静默丢弃 → 最新 tab 展示推荐数据）
          setComposeVisible(false);
          if (mode === 'newest') {
            refresh();
          } else {
            setMode('newest');
          }
        }}
      />
    </View>
  );
}

/**
 * 发帖弹层（底部滑出）
 * 表单：标题（选填）/ 话题（选填）/ 正文（必填，≤2000 字）
 * 提交流程：正文非空校验 → 屏蔽词校验（命中则 Alert 列出）→ createArea48Post → 成功后回调
 */
function ComposeModal({
  visible,
  busyRef,
  onClose,
  onPosted,
}: {
  visible: boolean;
  busyRef: React.MutableRefObject<boolean>;
  onClose: () => void;
  onPosted: () => void;
}) {
  const palette = usePalette();
  const { t } = useI18n();
  const showToast = useUiStore((s) => s.showToast);
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const topicRef = React.useRef<TextInput>(null);

  // 关闭时清空草稿
  useEffect(() => {
    if (!visible) {
      setTitle('');
      setTopic('');
      setContent('');
      setSending(false);
    }
  }, [visible]);

  const submit = useCallback(async () => {
    const body = content.trim();
    if (!body) {
      showToast(t('请输入正文内容'));
      return;
    }
    if (busyRef.current || sending) return;
    busyRef.current = true;
    setSending(true);
    try {
      // 屏蔽词校验：标题 + 正文 + 话题 一起检查
      const hits = await checkMaskWords(`${title}\n${topic}\n${body}`);
      if (hits.length) {
        Alert.alert(t('包含屏蔽词'), `${t('请修改后再发布')}\n\n${hits.slice(0, 20).join('、')}`);
        return;
      }
      await pocketApi.createArea48Post({
        title: title.trim(),
        content: body,
        topicArray: topic.trim(),
      });
      showToast(t('发布成功'));
      onPosted();
    } catch (e: any) {
      showToast(t('发布失败：{error}', { error: errorMessage(e) }));
    } finally {
      busyRef.current = false;
      setSending(false);
    }
  }, [busyRef, content, onPosted, sending, showToast, t, title, topic]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.modalRoot}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
      >
        <TouchableOpacity style={styles.modalMask} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: palette.surfaceGlassStrong }]}>
          <View style={[styles.sheetHandle, { backgroundColor: palette.fill3 }]} />
          <View style={styles.sheetHead}>
            <Text style={[styles.sheetTitle, { color: palette.label }]}>{t('发布动态')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} activeOpacity={0.7}>
              <MaterialCommunityIcons name="close" size={22} color={palette.labelSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView
            style={styles.sheetScroll}
            contentContainerStyle={styles.sheetScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <TextInput
              style={[styles.input, { backgroundColor: palette.fill2, color: palette.label }]}
              placeholder={t('标题（选填）')}
              placeholderTextColor={palette.labelTertiary}
              value={title}
              onChangeText={setTitle}
              maxLength={80}
              returnKeyType="next"
              onSubmitEditing={() => topicRef.current?.focus()}
            />
            <TextInput
              ref={topicRef}
              style={[styles.input, { backgroundColor: palette.fill2, color: palette.label }]}
              placeholder={t('话题（选填，如：#今日公演#）')}
              placeholderTextColor={palette.labelTertiary}
              value={topic}
              onChangeText={setTopic}
              maxLength={40}
              returnKeyType="done"
            />
            <TextInput
              style={[styles.contentInput, { backgroundColor: palette.fill2, color: palette.label }]}
              placeholder={t('分享新鲜事…')}
              placeholderTextColor={palette.labelTertiary}
              value={content}
              onChangeText={setContent}
              multiline
              maxLength={2000}
              textAlignVertical="top"
            />
            <View style={styles.sheetFoot}>
              <Text style={[styles.counter, { color: palette.labelTertiary }]}>{content.length}/2000</Text>
              <Button
                title={sending ? t('发布中…') : t('发布')}
                onPress={submit}
                disabled={sending}
                loading={sending}
                variant="filled"
                size="sm"
                style={styles.submitBtn}
              />
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  list: { padding: 8 },
  footer: { textAlign: 'center', fontSize: 12, paddingVertical: 12 },
  tabs: {
    flexDirection: 'row',
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: radii.md,
    padding: 3,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: radii.sm,
  },
  tabText: { fontSize: 14, lineHeight: 18 },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 12,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    padding: 16,
    paddingBottom: 28,
    maxHeight: '92%',
  },
  sheetScroll: { flexShrink: 1 },
  sheetScrollContent: { paddingBottom: 4 },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 12 },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sheetTitle: { fontSize: 17, fontWeight: '800' },
  input: {
    borderRadius: radiiAlias.input,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 10,
  },
  contentInput: {
    borderRadius: radiiAlias.input,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    minHeight: 140,
    marginBottom: 10,
  },
  sheetFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  counter: { fontSize: 12 },
  submitBtn: {
    paddingHorizontal: 28,
  },
  skeletonWrap: { padding: 8 },
  skeletonCard: { borderRadius: 16, padding: 14, marginVertical: 4, borderWidth: StyleSheet.hairlineWidth },
  skeletonHead: { flexDirection: 'row' },
});
