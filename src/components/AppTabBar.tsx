/**
 * AppTabBar · iOS 26 Liquid Glass 底栏
 *  - 玻璃感悬浮胶囊（半透明 + 1px 内描边）
 *  - 5 个 tab：图标 + label，label 常驻显示
 *  - active 项：玻璃 tint 胶囊 + accent 字 + 图标 spring 弹跳
 *  - Spring 按压反馈
 *  - 安全留白底部 inset
 *
 * 注：受 React Navigation 限制，render tabBar 由 Tab.Navigator 的 `tabBar` prop 调用此组件。
 *     此组件自管事件 onTabPress(index)、当前 activeIndex。
 */
import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { usePalette, motion } from '../theme';
import { typography } from '../theme/typography';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

export interface TabBarItem {
  key: string;
  label: string;
  icon: (props: { color: string; size: number }) => React.ReactNode;
}

export interface AppTabBarProps {
  items: TabBarItem[];
  activeKey: string;
  onSelect: (key: string) => void;
}

function TabCell({
  item,
  active,
  onSelect,
}: {
  item: TabBarItem;
  active: boolean;
  onSelect: () => void;
}) {
  const palette = usePalette();
  const pop = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    pop.stopAnimation();
    if (active) {
      pop.setValue(0.92);
      const animation = Animated.spring(pop, { toValue: 1, ...motion.spring.bouncy, useNativeDriver: true });
      animation.start();
      return () => animation.stop();
    } else {
      pop.setValue(1);
    }
  }, [active, pop]);

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      hitSlop={6}
      onPress={onSelect}
      style={({ pressed }) => [
        styles.cell,
        // iOS 26 选中态：中性玻璃灰底 + accent 文字图标（不再粉，克制）
        active && {
          backgroundColor:
            palette.name === 'dark' ? 'rgba(120,120,128,0.30)' : 'rgba(120,120,128,0.16)',
        },
        active && pressed && { transform: [{ scale: 0.96 }] },
        pressed && !active && { transform: [{ scale: 0.97 }] },
      ]}
    >
      <Animated.View style={[styles.cellIcon, { transform: [{ scale: pop }] }]}>
        {item.icon({ color: active ? palette.tint : palette.labelSecondary, size: 23 })}
      </Animated.View>
      <Text
        style={[
          typography.caption2,
          {
            color: active ? palette.tint : palette.labelSecondary,
            fontWeight: active ? '700' : '600',
            marginTop: 3,
          },
        ]}
      >
        {item.label}
      </Text>
    </Pressable>
  );
}

export function AppTabBar({ items, activeKey, onSelect }: AppTabBarProps) {
  const palette = usePalette();
  const isDark = palette.name === 'dark';
  // 苹果式磨砂玻璃：真模糊(Android 12+ RenderEffect, expo-blur) + 半透 tint + 顶部细高光
  // 背景图/滚动内容透到胶囊下方被模糊；无内容时柔化的主题色 + 高光依然有玻璃观感
  return (
    <View
      pointerEvents="box-none"
      style={[styles.outer, { paddingBottom: 16 }]}
    >
      <View
        style={[
          styles.bar,
          {
            // 玻璃底色（更实不透）：液态玻璃感但不高透；保留 12% 让 blur 仍显磨砂
            backgroundColor: isDark ? 'rgba(30,31,36,0.86)' : 'rgba(245,246,250,0.88)',
            borderColor: palette.innerStroke,
          },
        ]}
      >
        {/* 磨砂层：Android 12+ 真模糊；iOS 系统毛玻璃 */}
        <BlurView
          style={StyleSheet.absoluteFill}
          tint={isDark ? 'dark' : 'light'}
          intensity={isDark ? 62 : 82}
        />
        {/* tint 色相层：保证可读；浅色几乎透, 深色轻提亮 */}
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: isDark
                ? 'rgba(255,255,255,0.06)'
                : 'rgba(255,255,255,0.12)',
            },
          ]}
        />
        {/* 顶部细高光：玻璃受光边沿（iOS Liquid Glass） */}
        <View
          pointerEvents="none"
          style={[
            styles.glassHighlight,
            {
              backgroundColor: isDark
                ? 'rgba(255,255,255,0.20)'
                : 'rgba(255,255,255,0.85)',
            },
          ]}
        />
        {/* 底部细暗边：玻璃下方投影边缘，液态质感 */}
        <View
          pointerEvents="none"
          style={[
            styles.glassShadowEdge,
            {
              backgroundColor: isDark
                ? 'rgba(0,0,0,0.32)'
                : 'rgba(0,0,0,0.10)',
            },
          ]}
        />
        {items.map((item) => {
          const active = item.key === activeKey;
          return (
            <TabCell
              key={item.key}
              item={item}
              active={active}
              onSelect={() => onSelect(item.key)}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    // 居中略加余量：上一版 paddingHorizontal 12 让胶囊贴边感觉偏左
    paddingHorizontal: 16,
  },
  bar: {
    flexDirection: 'row',
    // 长度自适应内容而非撑满屏宽：定宽 cell → 胶囊收短居中(缩「长度」)
    borderRadius: 28,
    paddingVertical: 6,
    paddingHorizontal: 8,
    minHeight: 64,
    overflow: 'hidden',
    // 连续柔和悬浮投影（iOS+Android 双端都圆角, 圆角32 跟随 outline）
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.10,
        shadowRadius: 16,
      },
      android: { elevation: 8 },
      default: null,
    }),
  },
  // 玻璃顶部受光细线（在胶囊内顶部 1px, inset 跟随圆角）
  glassHighlight: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: 0,
    height: 1,
    borderRadius: 1,
  },
  // 玻璃底部暗边（1px 内阴影, 玻璃与下方内容的分界, inset 跟随圆角）
  glassShadowEdge: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 0,
    height: 1,
    borderRadius: 1,
  },
  cell: {
    // 取消 flex:1 → 改固定宽, 胶囊随内容收短(用户反馈: 缩的是「长度」)
    width: 76,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    paddingHorizontal: 4,
    // 完全 pill（半径=一半高）：选中时圆形指示感 iOS 26
    borderRadius: 28,
  },
  cellIcon: { alignItems: 'center', justifyContent: 'center' },
});

// 辅助：复用项目里的 MaterialCommunityIcons
export function MCI(name: string) {
  return ({ color, size }: { color: string; size: number }) => (
    <MaterialCommunityIcons name={name} color={color} size={size} />
  );
}

export { motion };
