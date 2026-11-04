import { Platform } from 'react-native';
import * as Tracking from 'expo-tracking-transparency';
import { Settings, AppEventsLogger } from 'react-native-fbsdk-next';

import { env } from './env';

let initialized = false;
let trackingEnabled = false;

export async function initializeMetaTracking() {
  if (initialized) return;
  
  if (!env.EXPO_PUBLIC_META_APP_ID || !env.EXPO_PUBLIC_META_CLIENT_TOKEN) {
    console.log('[Meta] Tracking not configured - missing app ID or client token');
    return;
  }

  initialized = true;

  if (Platform.OS === 'ios') {
    const { status } = await Tracking.requestTrackingPermissionsAsync();
    trackingEnabled = status === 'granted';
    Settings.setAdvertiserTrackingEnabled(trackingEnabled);
    
    if (trackingEnabled) {
      console.log('[Meta] iOS tracking permission granted');
    } else {
      console.log('[Meta] iOS tracking permission denied or restricted');
    }
  } else {
    trackingEnabled = true;
  }

  Settings.setAdvertiserIDCollectionEnabled(true);
  Settings.setAutoLogAppEventsEnabled(true);
  
  console.log('[Meta] SDK initialized');
}

export function logMetaEvent(eventName: string, parameters?: Record<string, string | number>) {
  if (!initialized || !trackingEnabled) {
    return;
  }

  try {
    if (parameters) {
      AppEventsLogger.logEvent(eventName, parameters);
    } else {
      AppEventsLogger.logEvent(eventName);
    }
    console.log('[Meta] Event logged:', eventName, parameters || '');
  } catch (error) {
    console.error('[Meta] Error logging event:', error);
  }
}

export function logMetaStandardEvent(
  eventName: string,
  valueToSum?: number,
  parameters?: Record<string, string | number>
) {
  if (!initialized || !trackingEnabled) {
    return;
  }

  try {
    if (valueToSum !== undefined && parameters !== undefined) {
      AppEventsLogger.logEvent(eventName, valueToSum, parameters);
      console.log('[Meta] Standard event logged:', eventName, valueToSum, parameters);
    } else if (valueToSum !== undefined) {
      AppEventsLogger.logEvent(eventName, valueToSum);
      console.log('[Meta] Standard event logged:', eventName, valueToSum);
    } else if (parameters !== undefined) {
      AppEventsLogger.logEvent(eventName, parameters);
      console.log('[Meta] Standard event logged:', eventName, parameters);
    } else {
      AppEventsLogger.logEvent(eventName);
      console.log('[Meta] Standard event logged:', eventName);
    }
  } catch (error) {
    console.error('[Meta] Error logging standard event:', error);
  }
}

export const MetaEvents = {
  COMPLETED_REGISTRATION: 'fb_mobile_complete_registration',
  GROUP_CREATED: 'GroupCreated',
  PLAYER_JOINED_GAME: 'PlayerJoinedGame',
  PURCHASED: 'fb_mobile_purchase',
  INITIATED_CHECKOUT: 'fb_mobile_initiated_checkout',
} as const;
