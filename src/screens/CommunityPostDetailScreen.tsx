/**
 * CommunityPostDetailScreen · 社区帖子详情（2.6.5 新增）
 *
 * 数据来源：
 *  - getArea48PostDetails —— 帖子全文 + 作者信息（ListHeader）
 *  - getArea48Comments —— 评论列表（commentList + commentUserList，next 游标分页）
 *  - addArea48Comment —— 发表评论（成功后把返回的 comment + commentUser 置顶插入）
 *  - getPocketMaskWords —— 发言前屏蔽词校验
 *
 * 能力边界：删除评论接口（delete-area48-comment）未在移动端 API 层提供，本页不设计删除操作。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import ScreenHeader from '../components/ScreenHeader';
import { PerfFlatList } from '../components/PerfFlatList';
import { FadeInView, ScalePressable } from '../components/Motion';
import CommunityPostCard from '../components/CommunityPostCard';
import ZoomImageModal from '../components/ZoomImageModal';
import { CenterSpinner } from '../components/Loaders';
import { EmptyState, ErrorState } from '../components/StateViews';
import { Skeleton } from '../components/Skeleton';
import { usePalette } from '../theme';
import { useI18n } from '../i18n';
import { useSettingsStore, useUiStore } from '../store';
import pocketApi from '../api/pocket48';
import { errorMessage } from '../utils/data';
import { formatTimestamp } from '../utils/format';
import {
  checkMaskWords,
  CommunityComment,
  CommunityPost,
  normalizeCommunityComments,
  normalizeCommunityPost,
} from '../utils/community';

interface CommentUser {
  userId?: string;
  avatar?: string;
  nickname?: string;
  realNickName?: string;
  nickName?: string;
  name?: string;
}

export default function CommunityPostDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { postId } = route.params as { postId: string };
  const palette = usePalette();
  const { t } = useI18n();
  const token = useSettingsStore((s) => s.settings.p48Token);
  const showToast = useUiStore((s) => s.showToast);

  // —— 帖子详情 ——
  const [post, setPost] = useState<CommunityPost | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState('');
  const [zoomUrl, setZoomUrl] = useState('');

  // —— 评论 ——
  const [comments, setComments] = useState<CommunityComment[]>([]);
  const [commentsNext, setCommentsNext] = useState(0);
  const [commentsHasMore, setCommentsHasMore] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const commentsRef = useRef({ loading: false, runId: 0 });
  const listRef = useRef<any>(null);

  const loadDetail = useCallback(async () => {
    setDetailLoading(true);
    setDetailError('');
    try {
      const res = await pocketApi.getArea48PostDetails(postId);
      const content = res?.content || {};
      const normalized = normalizeCommunityPost(content);
      // Y24: 解析失败不能三态全空白（此前无错误/空态 → 头部整块空白）
      if (!normalized) { setDetailError(t('帖子解析失败')); setPost(null); return; }
      setPost(normalized);
    } catch (e: any) {
      setDetailError(errorMessage(e));
    } finally {
      setDetailLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // —— 评论分页（同步锁 + runId，防 onEndReached 连发 / 快速重进竞态）——
  const loadComments = useCallback(
    async (reset: boolean) => {
      const ref = commentsRef.current;
      if (ref.loading) return;
      ref.loading = true;
      const runId = ++ref.runId;
      setCommentsLoading(true);
      if (reset) setCommentsError('');
      try {
        const res = await pocketApi.getArea48Comments(postId, reset ? 0 : commentsNext);
        if (runId !== ref.runId) return; // 过期响应丢弃
        const content = res?.content || {};
        const { comments: fetched, next } = normalizeCommunityComments(content);
        setComments((prev) => {
          if (reset) return fetched;
          const seen = new Set(prev.map((c) => c.commentId));
          return [...prev, ...fetched.filter((c) => !seen.has(c.commentId))];
        });
        setCommentsNext(next);
        setCommentsHasMore(next > 0 && fetched.length > 0);
      } catch (e: any) {
        if (runId !== ref.runId) return;
        if (reset) setCommentsError(errorMessage(e));
        else showToast(t('加载更多评论失败'));
      } finally {
        if (runId === ref.runId) {
          ref.loading = false;
          setCommentsLoading(false);
        }
      }
    },
    [commentsNext, postId, showToast, t],
  );

  useEffect(() => {
    loadComments(true);
    // 进入页面只加载一次评论
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  // —— 发表评论 ——
  const sendComment = useCallback(async () => {
    const text = input.trim();
    if (!text) {
      showToast(t('请输入评论内容'));
      return;
    }
    if (!token) {
      showToast(t('社区需要登录，请先在账号设置登录口袋48'));
      navigation.navigate('LoginScreen');
      return;
    }
    if (sending) return;
    setSending(true);
    try {
      const hits = await checkMaskWords(text);
      if (hits.length) {
        Alert.alert(t('包含屏蔽词'), `${t('请修改后再发送')}\n\n${hits.slice(0, 20).join('、')}`);
        return;
      }
      const res = await pocketApi.addArea48Comment(postId, text);
      const content = res?.content || {};
      const newComment = content.comment || {};
      const newUser = content.commentUser || ({} as CommentUser);
      const uid = String(newComment.userId || newUser.userId || '');
      const time = Number(newComment.ctime || newComment.createAt || newComment.time || Date.now());
      const item: CommunityComment = {
        commentId: String(newComment.commentId || `c-${Date.now()}`),
        userId: uid,
        name: String(newUser.nickname || newUser.realNickName || newUser.nickName || newUser.name || '我'),
        avatar: String(newUser.avatar || newUser.headImg || ''),
        text: String(newComment.msg || newComment.comment || text),
        time: Number.isFinite(time) ? (time > 0 && time < 10000000000 ? time * 1000 : time) : Date.now(),
      };
      setComments((prev) => [item, ...prev.filter((c) => c.commentId !== item.commentId)]);
      setInput('');
      Keyboard.dismiss();
      // 新评论置顶插入后，若列表已有内容则定位回顶部，让用户看到刚发的评论
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
      });
      showToast(t('评论已发送'));
    } catch (e: any) {
      showToast(errorMessage(e));
    } finally {
      setSending(false);
    }
  }, [input, navigation, postId, sending, showToast, t, token]);

  const renderComment = ({ item, index }: { item: CommunityComment; index: number }) => (
    <FadeInView delay={index < 12 ? 60 + index * 25 : 0} duration={360}>
      <View style={styles.commentRow}>
        {item.avatar ? (
          <Image source={{ uri: item.avatar }} style={[styles.commentAvatar, { backgroundColor: palette.fill3 }]} />
        ) : (
          <View style={[styles.commentAvatar, { backgroundColor: palette.fill3, alignItems: 'center', justifyContent: 'center' }]}>
            <MaterialCommunityIcons name="account" size={16} color={palette.labelTertiary} />
          </View>
        )}
        <View style={styles.commentBody}>
          <View style={styles.commentHead}>
            <Text style={[styles.commentName, { color: palette.label }]} numberOfLines={1}>{item.name}</Text>
            {item.time > 0 ? (
              <Text style={[styles.commentTime, { color: palette.labelTertiary }]}>{formatTimestamp(item.time)}</Text>
            ) : null}
          </View>
          <Text style={[styles.commentText, { color: palette.label }]}>{item.text}</Text>
          <View style={[styles.commentHairline, { backgroundColor: palette.hairline }]} />
        </View>
      </View>
    </FadeInView>
  );

  const listHeader = (
    <View>
      {detailLoading ? (
        <View style={[styles.skeletonCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          <View style={[styles.skeletonHead, { alignItems: 'center' }]}>
            <Skeleton width={34} height={34} radius={17} />
            <View style={{ marginLeft: 9, flex: 1 }}>
              <Skeleton width="35%" height={12} />
              <Skeleton width="22%" height={9} style={{ marginTop: 7 }} />
            </View>
          </View>
          <Skeleton width="96%" height={15} style={{ marginTop: 13 }} />
          <Skeleton width="100%" height={15} style={{ marginTop: 8 }} />
          <Skeleton width="88%" height={15} style={{ marginTop: 8 }} />
          <Skeleton width="70%" height={15} style={{ marginTop: 8 }} />
          <View style={{ flexDirection: 'row', gap: 4, marginTop: 13 }}>
            {[0, 1, 2].map((j) => <Skeleton key={j} width="31%" height={86} radius={10} />)}
          </View>
        </View>
      ) : detailError ? (
        <ErrorState title={t('加载失败')} hint={detailError} onAction={() => loadDetail()} />
      ) : post ? (
        <>
          <CommunityPostCard post={post} textLines={0} onImagePress={setZoomUrl} />
          <View style={styles.commentsSection}>
            <View style={styles.commentsHeadRow}>
              <MaterialCommunityIcons name="comment-text-outline" size={15} color={palette.tint} />
              <Text style={[styles.commentsHead, { color: palette.label }]}>
                {t('评论')}{post.commentCount > 0 ? ` · ${post.commentCount}` : ''}
              </Text>
            </View>
            {commentsError ? (
              <ErrorState title={t('评论加载失败')} hint={commentsError} onAction={() => loadComments(true)} />
            ) : comments.length === 0 ? (
              <EmptyState icon="comment-outline" title={t('暂无评论，来抢沙发～')} />
            ) : null}
          </View>
        </>
      ) : null}
    </View>
  );

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('帖子详情')} onBack={() => navigation.goBack()} />
      <PerfFlatList
        ref={listRef}
        data={comments}
        keyExtractor={(item) => item.commentId}
        contentContainerStyle={styles.list}
        initialNumToRender={10}
        onEndReached={() => {
          if (commentsHasMore) loadComments(false);
        }}
        onEndReachedThreshold={0.35}
        ListHeaderComponent={listHeader}
        renderItem={renderComment}
        ListFooterComponent={
          comments.length ? (
            commentsHasMore ? (
              <ScalePressable onPress={() => loadComments(false)} style={styles.loadMoreBtn}>
                <Text style={[styles.loadMore, { color: palette.tint }]}>{t('查看更多评论')}</Text>
              </ScalePressable>
            ) : (
              <Text style={[styles.loadMore, { color: palette.labelTertiary }]}>{t('没有更多了')}</Text>
            )
          ) : null
        }
      />

      {/* 底部评论输入条 */}
      {/* Y34: Android 键盘遮挡评论输入条 → height */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={[styles.composeBar, { backgroundColor: palette.surfaceGlassStrong, borderTopColor: palette.hairline }]}>
          <TextInput
            style={[styles.composeInput, { backgroundColor: palette.fill2, color: palette.label }]}
            placeholder={t('写评论…')}
            placeholderTextColor={palette.labelTertiary}
            value={input}
            onChangeText={setInput}
            maxLength={500}
            multiline
          />
          <ScalePressable
            disabled={sending || !input.trim()}
            onPress={sendComment}
            pressedScale={0.9}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            style={[
              styles.sendBtn,
              { backgroundColor: sending || !input.trim() ? palette.fill3 : palette.tint },
            ]}
          >
            <MaterialCommunityIcons name="send" size={16} color={sending || !input.trim() ? palette.labelTertiary : palette.onTint} />
          </ScalePressable>
        </View>
      </KeyboardAvoidingView>

      <ZoomImageModal url={zoomUrl} onClose={() => setZoomUrl('')} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  list: { paddingBottom: 24 },
  commentsSection: { paddingHorizontal: 12, marginTop: 4 },
  commentsHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  commentsHead: { fontSize: 15, fontWeight: '800' },
  commentRow: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 12 },
  commentAvatar: { width: 36, height: 36, borderRadius: 18, marginRight: 10, overflow: 'hidden' },
  commentBody: { flex: 1, minWidth: 0 },
  commentHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 },
  commentName: { flex: 1, fontSize: 13, fontWeight: '600', marginRight: 8 },
  commentTime: { fontSize: 10 },
  commentText: { fontSize: 14, lineHeight: 20 },
  commentHairline: { height: StyleSheet.hairlineWidth, marginTop: 12 },
  loadMore: { textAlign: 'center', fontSize: 13, fontWeight: '700', paddingVertical: 14 },
  loadMoreBtn: { alignSelf: 'stretch', alignItems: 'center' },
  composeBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composeInput: {
    flex: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 14,
    maxHeight: 96,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skeletonCard: {
    borderRadius: 16,
    padding: 14,
    marginHorizontal: 8,
    marginVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  skeletonHead: { flexDirection: 'row' },
});
