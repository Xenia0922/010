import React, { useCallback, useState } from 'react';
import { Image, ImageProps, Platform, StyleSheet, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

type NetworkImageProps = ImageProps & {
  /** 加载失败时是否显示回退占位（浅灰底 + 可选图标），默认开启（D4 修复：source.48.cn 偶发拒绝不再留白块） */
  fallback?: boolean;
  /** 回退占位图标（MaterialCommunityIcons 名）；不传则不显示图标只显示浅灰底 */
  fallbackIcon?: string;
};

/**
 * 网络图片封装。
 * - 统一淡入行为与安卓解码淡入时长；作为集中替换与未来升级到更优缓存组件的单一入口；
 * - D4：内置失败回退——`source.48.cn` 移动端偶发被拒时，显示浅灰底 + 可选图标，杜绝空白块/破图；
 *   外部 onError 仍会被调用（原有调用方逻辑不受影响）。
 */
export function NetworkImage({ fadeDuration, fallback = true, fallbackIcon, onError, style, ...rest }: NetworkImageProps) {
  const [errored, setErrored] = useState(false);
  const handleError = useCallback(
    (e: any) => {
      if (onError) onError(e);
      if (fallback) setErrored(true);
    },
    [fallback, onError],
  );
  // uri 变化时重置失败态（FlatList 复用实例时不串台）
  const uri = rest.source && typeof rest.source === 'object' && 'uri' in rest.source ? (rest.source as any).uri : undefined;
  React.useEffect(() => {
    setErrored(false);
  }, [uri]);

  if (errored) {
    return (
      <View style={[styles.fallbackBox, style as any]}>
        {fallbackIcon ? (
          <MaterialCommunityIcons name={fallbackIcon as any} size={20} color="rgba(128,128,128,0.4)" />
        ) : null}
      </View>
    );
  }
  return (
    <Image
      {...rest}
      style={style}
      fadeDuration={fadeDuration ?? (Platform.OS === 'android' ? 200 : 0)}
      onError={handleError}
    />
  );
}

const styles = StyleSheet.create({
  fallbackBox: {
    backgroundColor: 'rgba(128,128,128,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default NetworkImage;
