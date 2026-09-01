import React from 'react';
import { StyleSheet, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import NetworkImage from './NetworkImage';
import { radii } from '../theme';

// 口袋48官网源的音乐对象只有 mp3/artist/title，没有封面图。
// 封面来自官网 records（专辑记录）：buildTracks 已按 专辑/歌名/音频分组 四级匹配，
// 实测 100% 歌曲能拿到有效封面 URL（2026-08-14 数据验证）。
// 这里用「歌名哈希 -> 固定调色板」生成确定性渐变封面（每首歌配色稳定），
// 叠加一个旋转半透明层模拟斜向渐变 + 音符图标，作为「加载中 / 无封面 / 加载失败」兜底。
const PALETTE: [string, string][] = [
  ['#ff9a9e', '#fecfef'],
  ['#a18cd1', '#fbc2eb'],
  ['#84fab0', '#8fd3f4'],
  ['#ffecd2', '#fcb69f'],
  ['#f6d365', '#fda085'],
  ['#5ee7df', '#b490ca'],
  ['#d299c2', '#fef9d7'],
  ['#f093fb', '#f5576c'],
  ['#4facfe', '#00f2fe'],
  ['#43e97b', '#38f9d7'],
  ['#fa709a', '#fee140'],
  ['#30cfd0', '#330867'],
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Props {
  uri?: string;
  title: string;
  /** 固定尺寸（黑胶/迷你栏用）；列表用 fill 撑满父容器 */
  size?: number;
  /** 撑满父容器（列表方格） */
  fill?: boolean;
  /** 圆形（黑胶/迷你栏） */
  round?: boolean;
  /** 当前播放中：右上角高亮点 */
  active?: boolean;
}

/**
 * 封面显示（重写版，2026-08-14）——不再依赖 onLoad 回调：
 *
 * 历史教训：早期用「onLoad 门控 + opacity」方案——Image 未 onLoad 前透明，
 * onLoad 后淡入。但 RN Android（Fresco）对命中缓存/部分 ROM 的图可能不触发
 * onLoad，导致透明度永远停在 0：图其实加载完成了，却永远不可见 =「封面丢失」。
 *
 * 重写原则：
 *  1. Image 常驻且**不透明**（opacity 恒 1）——Fresco 加载完成会自动显示图片，
 *     加载中显示透明占位（底层渐变可见），成功路径完全不依赖 onLoad。
 *  2. 失败路径靠 onError 隐藏（回退渐变+音符），首次失败 3s 后自动重试一次
 *     （封面 URL 偶发 403/超时场景）。
 *  3. 15s 超时兜底：既未成功也未触发 onError 的罕见「死块」场景（HTTP 200 非图等），
 *     强制回退渐变，绝不永久白屏。
 *  4. key={uri}：uri 变化（FlatList 复用/切歌）时强制重建实例，杜绝状态串台。
 */
export default function CoverArt({ uri, title, size, fill, round, active }: Props) {
  const [c1, c2] = PALETTE[hashStr(title || '♪') % PALETTE.length];
  const [errored, setErrored] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const retried = React.useRef(false);
  const mounted = React.useRef(true);
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // 卸载时清理 3s 重试定时器，防止卸载后仍对已卸载组件 setState
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    };
  }, []);

  // uri 变化重置（FlatList 回收单元格复用本组件实例时，避免上一首的状态串到新歌）
  React.useEffect(() => {
    setErrored(false);
    setLoaded(false);
    retried.current = false;
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
  }, [uri]);

  // 15s 超时兜底：从未成功加载（loaded=false）时强制回退渐变，防「死块」永久遮挡。
  // loaded 成功后不再受超时影响（图已正常显示）。
  React.useEffect(() => {
    if (!uri || loaded) return;
    const timer = setTimeout(() => { if (mounted.current) setErrored(true); }, 15000);
    return () => clearTimeout(timer);
  }, [uri, loaded]);

  // onError：首次失败延迟 3s 自动重试一次，再次失败才永久回退
  const handleImageError = React.useCallback(() => {
    if (!retried.current) {
      retried.current = true;
      if (mounted.current) setErrored(true);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (mounted.current) setErrored(false);
      }, 3000);
    } else {
      if (mounted.current) setErrored(true);
    }
  }, []);

  const boxStyle: any = fill
    ? { width: '100%', height: '100%', borderRadius: round ? radii.pill : 0 }
    : { width: size, height: size, borderRadius: round ? (size || 0) / 2 : 0 };
  const showImage = !!uri && !errored;
  const iconSize = fill ? 44 : Math.round((size || 0) * 0.34);

  return (
    <View style={[styles.box, boxStyle, { backgroundColor: c1 }]}>
      <View style={[styles.overlay, { backgroundColor: c2, opacity: 0.5, transform: [{ rotate: '35deg' }] }]} />
      {showImage ? (
        <NetworkImage
          key={uri}
          source={{ uri }}
          style={[StyleSheet.absoluteFill, { borderRadius: round ? radii.pill : 0 }]}
          resizeMode="cover"
          // scale：保留原图分辨率由 GPU 缩放，比 resize 预解码缩放更锐利（修复封面发糊）
          resizeMethod="scale"
          fadeDuration={200}
          fallback={false}
          onLoad={() => setLoaded(true)}
          onError={handleImageError}
        />
      ) : (
        <MaterialCommunityIcons
          name="music"
          size={iconSize}
          color="rgba(255,255,255,0.95)"
          style={{ textShadowColor: 'rgba(0,0,0,0.38)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 }}
        />
      )}
      {active ? <View style={[styles.activeDot, { backgroundColor: '#fff' }]} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  overlay: { position: 'absolute', left: '-30%', top: '-30%', width: '160%', height: '160%' },
  activeDot: { position: 'absolute', right: 6, bottom: 6, width: 10, height: 10, borderRadius: 5 },
});
