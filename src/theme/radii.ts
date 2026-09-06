// 圆角：适中档（统一圆润升级），卡片 20 / 按钮 18 / sheet 22 / chip 胶囊
export const radii = {
  none: 0,
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  '2xl': 36,
  pill: 999, // capsule / fully rounded
  /** 底部弹层（sheet）顶部圆角 */
  sheet: 22,
} as const;

export type RadiusToken = keyof typeof radii;

/** 推荐组合：卡片 20（适中圆润）、按钮 18、输入 14、chip/avatar 胶囊 */
export const radiiAlias = {
  card: radii.lg,         // 20 —— 实心卡片（适中圆润, 不胖圆）
  cardCompact: radii.md,  // 14 —— 紧凑卡片
  button: 18,             // 18 —— 主按钮
  buttonSquare: radii.md, // 14 —— 方按钮
  input: radii.md,        // 14
  chip: radii.pill,       // 999
  avatar: radii.pill,     // 圆形
} as const;
