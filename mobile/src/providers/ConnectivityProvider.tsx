import NetInfo from '@react-native-community/netinfo';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isOfflineState } from '../lib/connectivity';

type ConnectivityValue = {
  isOnline: boolean;
};

const ConnectivityContext = createContext<ConnectivityValue>({ isOnline: true });

function OfflineBanner() {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="w-full items-center justify-center bg-danger px-4 py-2"
      style={{ paddingTop: insets.top + 4 }}
    >
      <Text className="text-center font-sans-bold text-xs text-white">
        No internet connection. App functionality may be limited.
      </Text>
    </View>
  );
}

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setOffline(isOfflineState(state));
    });
    return unsubscribe;
  }, []);

  const value = useMemo(() => ({ isOnline: !offline }), [offline]);

  return (
    <ConnectivityContext.Provider value={value}>
      <View className="flex-1">
        {offline ? <OfflineBanner /> : null}
        <View className="flex-1">{children}</View>
      </View>
    </ConnectivityContext.Provider>
  );
}

export function useConnectivity(): ConnectivityValue {
  return useContext(ConnectivityContext);
}
