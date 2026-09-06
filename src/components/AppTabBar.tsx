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
        active && {
          backgroundColor:
            palette.name === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(255,111,145,0.18)',
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
    paddingHorizontal: 12,
  },
  bar: {
    flexDirection: 'row',
    borderRadius: 26,
    paddingVertical: 8,
    paddingHorizontal: 10,
    minHeight: 68,
    // 玻璃圆角裁剪：BlurView/tint/高光铺满后被裁进胶囊
    overflow: 'hidden',
    // 不设边框/高 elevation：任何 hairline 描边或 Android elevation 阴影
    // 都会在胶囊四周形成「一圈边框」观感（iOS 保留柔和投影）
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.08,
        shadowRadius: 12,
      },
      android: { elevation: 0 },
      default: null,
    }),
  },
  // 玻璃顶部受光细线（在胶囊内顶部 1px）
  glassHighlight: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 0,
    height: 1,
    borderRadius: 1,
  },
  // 玻璃底部暗边（1px 内阴影, 玻璃与下方内容的分界）
  glassShadowEdge: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 0,
    height: 1,
    borderRadius: 1,
  },
  cell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: 20,
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
