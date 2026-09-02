import { NavigatorScreenParams } from '@react-navigation/native';

export type RootStackParamList = {
  Main: NavigatorScreenParams<TabParamList>;
  MessagesScreen: undefined;
  LoginScreen: undefined;
  RechargeScreen: undefined;
  FetchScreen: undefined;
  FlipScreen: { mode?: 'view' | 'send' } | undefined;
  ProfileScreen: undefined;
  PhotosScreen: undefined;
  RoomAlbumScreen: undefined;
  RoomRadioScreen: { member?: any; initialMode?: 'big' | 'small'; streamUrl?: string } | undefined;
  OpenLiveScreen: undefined;
  OnMicScreen: undefined;
  PrivateMessagesScreen: { targetUserId?: string; targetName?: string } | undefined;
  BilibiliLiveScreen: { roomId?: string; roomName?: string } | undefined;
  VideoLibraryScreen: undefined;
  MusicLibraryScreen: undefined;
  AudioProgramsScreen: undefined;
  AnalysisScreen: undefined;
  DownloadScreen: undefined;
  DatabaseScreen: undefined;
  TripScreen: undefined;
  MeleeRankScreen: undefined;
  MemberDynamicScreen: undefined;
  MemberWeiboScreen: undefined;
  InvoiceScreen: undefined;
  CommunityScreen: undefined;
  CommunityPostDetailScreen: { postId: string; title?: string };
};

export type TabParamList = {
  Home: undefined;
  Media: { mode?: 'live' | 'vod'; playLiveId?: string; playTitle?: string; playCover?: string; playUrl?: string; playNonce?: number; fromRoom?: boolean; playPosition?: number } | undefined;
  Rooms: undefined;
  Settings: undefined;
};
