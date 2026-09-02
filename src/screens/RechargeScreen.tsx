import React, { useState, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import pocketApi from '../api/pocket48';
import { errorMessage } from '../utils/data';
import ScreenHeader from '../components/ScreenHeader';
import { HeaderAction } from '../components/HeaderAction';
import { GlassCard } from '../components/GlassCard';
import { CenterSpinner } from '../components/Loaders';
import { ErrorState } from '../components/StateViews';
import { FadeInView } from '../components/Motion';
import { usePalette, radii } from '../theme';
import { useI18n } from '../i18n';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

const RECHARGE_URL = 'https://live.48.cn/Recharge/';

export default function RechargeScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const [balance, setBalance] = useState('');
  const [status, setStatus] = useState(t('暂无数据'));
  const [webError, setWebError] = useState('');
  const [loading, setLoading] = useState(false);
  const webViewRef = useRef<WebView>(null);

  // React 18+ 卸载后 setState 为 no-op（无告警），请求继续执行无害；保留简单调用
  useEffect(() => { refreshBalance(); }, []);

  const refreshBalance = async () => {
    if (loading) return;
    setLoading(true);
    setStatus(t('正在刷新余额...'));
    try {
      const res = await pocketApi.getUserMoney();
      const money = res?.content?.moneyTotal ?? res?.data?.moneyTotal ?? res?.content?.money ?? res?.data?.money ?? '';
      setBalance(String(money));
      setStatus(money !== '' ? t('余额已刷新') : t('接口未返回余额'));
    } catch (error) {
      setStatus(t('余额刷新失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  };

  const reloadWeb = () => {
    setWebError('');
    webViewRef.current?.reload();
  };

  return (
    <View style={styles.container}>
      <ScreenHeader title={t('鸡腿充值')} right={
        <HeaderAction label={t('刷新')} onPress={refreshBalance} loading={loading} />
      } />

      {/* 余额卡：GlassCard strong + 28/800 金额 + 刷新 */}
      <FadeInView delay={60} duration={300}>
        <GlassCard strong style={styles.balanceWrap}>
          <View style={[styles.balanceIcon, { backgroundColor: palette.tintSoft }]}>
            <MaterialCommunityIcons name="credit-card-edit-outline" size={22} color={palette.tint} />
          </View>
          <View style={styles.balanceInfo}>
            <Text style={[styles.balanceLabel, { color: palette.labelSecondary }]}>{t('当前余额')}</Text>
            <Text style={[styles.balanceValue, { color: palette.label }]}>
              {balance !== '' ? t('{balance} 鸡腿', { balance }) : t('暂无数据')}
            </Text>
            <View style={styles.statusLine}>
              <Text style={[styles.statusText, { color: palette.labelSecondary }]} numberOfLines={1}>{status}</Text>
              {loading ? <ActivityIndicator color={palette.tint} size="small" style={styles.loading} /> : null}
            </View>
          </View>
          <HeaderAction label={t('刷新')} onPress={refreshBalance} loading={loading} />
        </GlassCard>
      </FadeInView>

      {/* WebView 容器卡：圆角 16 溢出隐藏 + hairline 边框 */}
      <View style={[styles.webCard, { borderColor: palette.hairline, overflow: 'hidden' }]}>
        <WebView
          ref={webViewRef}
          source={{ uri: RECHARGE_URL }}
          style={styles.web}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          mixedContentMode="always"
          startInLoadingState
          userAgent="Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 PocketFans201807"
          renderLoading={() => (
            <View style={styles.webLoading}>
              <CenterSpinner text={t('正在打开官方充值页...')} />
            </View>
          )}
          onError={(event) => setWebError(t('充值页加载失败：{msg}', { msg: String(event.nativeEvent.description).slice(0, 160) }))}
        />
        {webError ? (
          <View style={[styles.webErrorWrap, { backgroundColor: palette.background }]}>
            <ErrorState
              icon="web-off"
              title={t('充值页加载失败')}
              hint={webError}
              onAction={reloadWeb}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  balanceWrap: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
  },
  balanceIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  balanceInfo: { flex: 1, marginLeft: 12, minWidth: 0 },
  balanceLabel: { fontSize: 12, fontWeight: '600' },
  balanceValue: { fontSize: 28, fontWeight: '800', marginTop: 2 },
  statusLine: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  statusText: { fontSize: 11, flex: 1 },
  loading: { marginLeft: 8 },
  webCard: {
    flex: 1,
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  web: { flex: 1, backgroundColor: '#FFFFFF' },
  webLoading: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  webErrorWrap: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    padding: 32,
  },
});
