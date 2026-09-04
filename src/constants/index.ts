import { GiftItem } from '../types';

export const API_BASE = 'https://pocketapi.48.cn';

export const BILIBILI_API = 'https://api.bilibili.com';

// 成员数据权威源：数据发布于 data.gnz.hk（GNZ48 团站数据库镜像）。
// 进入软件由 AppNavigator 调用 ensureMemberData() 无条件同步最新。
export const MEMBERS_URL = 'https://data.gnz.hk/members.json';

export const APP_VERSION = '2.7.3';

// 成员数据原始仓库（yk1z 的牙牙消息电脑版），数据由其维护并发布。
export const MEMBER_DATA_SOURCE_URL = 'https://github.com/yk1z/yaya_msg';

export const BILIBILI_LIVE_CONFIG_URL = 'https://yaya-data.pages.dev/bilibili-live.json';

export const LYRICS_INDEX_URL = 'https://yaya-data.pages.dev/lyrics-index.json';

export const LYRICS_BASE_URL = 'https://yaya-data.pages.dev/lyrics';

export const NOTICE_URL = 'https://yaya-data.pages.dev/notice.json';

export const YK1Z_URL = 'https://yaya-data.pages.dev/yk1z.json';

export const USER_AGENT = 'PocketFans201807/7.0.41 (iPhone; iOS 17.0; Scale/3.00)';

export const USER_AGET_IPAD = 'PocketFans201807/7.0.41 (iPad; iOS 17.0; Scale/2.00)';

export const POCKET_GIFT_DATA: GiftItem[] = [
  { id: '1', name: '荧光棒', cost: 5 },
  { id: '2', name: '荧光棒x2', cost: 10 },
  { id: '3', name: '樱花', cost: 30 },
  { id: '4', name: '樱花x2', cost: 60 },
  { id: '5', name: '玫瑰花', cost: 100 },
  { id: '6', name: '玫瑰花x2', cost: 200 },
  { id: '7', name: '皇冠', cost: 500 },
  { id: '8', name: '皇冠x2', cost: 1000 },
  { id: '9', name: '星梦石', cost: 50 },
  { id: '10', name: '星梦石x2', cost: 100 },
  { id: '11', name: '爱心', cost: 20 },
  { id: '12', name: '鸡腿', cost: 10 },
  { id: '13', name: '火箭', cost: 1500 },
  { id: '14', name: '城堡', cost: 3000 },
  { id: '15', name: '彩虹', cost: 200 },
  { id: '16', name: '钻石', cost: 1000 },
  { id: '17', name: '戒环', cost: 600 },
  { id: '18', name: '比心', cost: 80 },
  { id: '19', name: '蜜桃', cost: 120 },
  { id: '20', name: '流星', cost: 300 },
  { id: '21', name: '锦鲤', cost: 400 },
  { id: '22', name: '独角兽', cost: 800 },
  { id: '23', name: '丘比特', cost: 600 },
  { id: '24', name: '章鱼烧', cost: 40 },
  { id: '25', name: '奶茶', cost: 30 },
  { id: '26', name: '冰淇淋', cost: 20 },
  { id: '27', name: '小fufu', cost: 999 },
  { id: '28', name: '铁锅炖大鹅', cost: 300 },
  { id: '29', name: '火锅', cost: 200 },
  { id: '30', name: '奖杯', cost: 9999 },
  { id: '31', name: '冲鸭', cost: 100 },
  { id: '32', name: '守护', cost: 300 },
  { id: '33', name: '巧克力', cost: 30 },
  { id: '34', name: '柠檬', cost: 40 },
  { id: '35', name: '向日葵', cost: 70 },
  { id: '36', name: '星辰', cost: 500 },
  { id: '37', name: '月光', cost: 600 },
  { id: '38', name: '游轮', cost: 5000 },
  { id: '39', name: '飞机', cost: 999 },
  { id: '40', name: '烟花', cost: 200 },
  { id: '41', name: '星星', cost: 50 },
  { id: '42', name: '雪糕', cost: 19999 },
];

export const TEAM_COLORS: Record<string, string> = {
  'TEAM SII': '#0095D5',
  'TEAM NII': '#9B26B6',
  'TEAM HII': '#FF7F00',
  'TEAM X': '#4CAF50',
  'TEAM G': '#4CAF50',
  'TEAM NIII': '#FDD835',
  'TEAM Z': '#E91E63',
  'TEAM B': '#E91E63',
  'TEAM E': '#00BCD4',
  'TEAM J': '#FF5722',
  'TEAM C': '#9C27B0',
  'TEAM K': '#FF9800',
  CII: '#9C27B0',
  '预备生': '#757575',
};

export const GROUP_NAMES = ['SNH48', 'GNZ48', 'BEJ48', 'CKG48', 'CGT48', 'IDFT'];

export const MESSAGE_TYPES = {
  TEXT: ['TEXT'],
  AUDIO: ['AUDIO'],
  IMAGE: ['IMAGE'],
  VIDEO: ['VIDEO'],
  REPLY: ['REPLY', 'GIFTREPLY'],
  LIVE: ['LIVEPUSH', 'SHARE_LIVE'],
  GIFT: ['GIFT_TEXT'],
  FLIPCARD: ['FLIPCARD'],
};
