import type { NetInfoState } from '@react-native-community/netinfo';

/** True when we are sure the device is offline. `isInternetReachable === null` is treated as online so the banner does not flash on launch. */
export function isOfflineState(state: NetInfoState): boolean {
  if (state.isConnected === false) return true;
  if (state.isInternetReachable === false) return true;
  return false;
}
