import { useEffect } from 'react';
import { Animated, Easing } from 'react-native';

// 模块级单例：跨组件卸载/重挂持久存在，使唱片旋转有「记忆」——
// 离开详情页再回来时从当前角度无缝续转，而非重头(0°)。
// 仅当 trackId 真正变化（切歌）时才归零；重进页面（trackId 不变）不重置。
//
// ⚠️ 不再用 Animated.loop（12s 一圈循环边界 1→0 偶发跳帧/停顿导致转动不连贯），
// 改用「持续累加 + interpolate 0-360°」无边界：value 一直单调 +1，旋转映射永远平滑。
export const vinylSpin = new Animated.Value(0);

let spinAnim: Animated.CompositeAnimation | null = null;
let spinningTrackId: string | null = null;
// 下一圈目标：持续累加 +1（0→1, 1→2, 2→3 ...）；每次 startLoop 同步 next+1，
// 保证暂停后再恢复从 next+1 续转（interp 0-1 周期性视觉无差）。
let next = 1;

function startLoop() {
  if (spinAnim) return;
  // 不要 stopAnimation 让当前值定格即可；下一段 timing 从当前值向 next 推进。
  const tick = Animated.timing(vinylSpin, {
    toValue: next,
    duration: 12000,
    easing: Easing.linear,
    useNativeDriver: true,
  });
  next += 1;
  spinAnim = tick;
  tick.start(({ finished }) => {
    spinAnim = null;
    if (finished) startLoop(); // 持续推进下一段（next 已 ++）
  });
}

function stopLoop() {
  if (spinAnim) {
    spinAnim.stop();
    spinAnim = null;
  }
  // 不重置 next：恢复播放时从上次累加点继续旋转（视觉无差）
}

export function useVinylSpin(trackId: string | undefined, isPlaying: boolean): Animated.Value {
  // 切歌：归零并从顶部起转（保留语义；重进详情页时 trackId 不变故不归零）
  useEffect(() => {
    if (trackId && trackId !== spinningTrackId) {
      vinylSpin.setValue(0);
      spinningTrackId = trackId;
      next = 1; // 切歌重置累加目标
    }
  }, [trackId]);

  // 播放：驱动旋转；暂停：冻结在当前角度。
  // 注意：不在此卸载 loop——否则切到详情页/返回时 loop 被停掉，记忆就断了。
  // loop 由全局唯一的单例持有，只要任一订阅者(isPlaying)在，它就转。
  useEffect(() => {
    if (isPlaying) startLoop();
    else stopLoop();
  }, [isPlaying]);

  return vinylSpin;
}
