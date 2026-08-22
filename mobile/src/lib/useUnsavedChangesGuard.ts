import { useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { Alert } from 'react-native';

/**
 * Blocks leaving a screen while `isDirty` is true and prompts to discard.
 * Call `allowLeave()` before a successful save navigates away so the prompt
 * is skipped. Intercepts header back, Android back, and modal swipe-down.
 */
export function useUnsavedChangesGuard(isDirty: boolean) {
  const navigation = useNavigation();
  const allowLeaveRef = useRef(false);
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const allowLeave = useCallback(() => {
    allowLeaveRef.current = true;
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      if (allowLeaveRef.current || !isDirtyRef.current) return;
      e.preventDefault();
      Alert.alert('Unsaved changes', 'You have unsaved changes. Discard them?', [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            allowLeaveRef.current = true;
            navigation.dispatch(e.data.action);
          },
        },
      ]);
    });
    return unsubscribe;
  }, [navigation]);

  return { allowLeave };
}
