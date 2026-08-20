import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Modal, Platform, Pressable, Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';
import { IosWheelPicker } from './IosWheelPicker';

type DateTimeFieldProps = {
  label: string;
  mode: 'date' | 'time';
  value: Date;
  onChange: (next: Date) => void;
  minimumDate?: Date;
  formatValue: (value: Date) => string;
};

/**
 * Tappable date/time row. iOS opens a full-width bottom-sheet `Modal` (same
 * pattern as `GroupSelect`) containing `IosWheelPicker` — a set of
 * independent wheel columns, not `@react-native-community/datetimepicker`'s
 * `spinner` display, whose native `UIDatePicker` cannot be stretched past
 * its own hardcoded ~280pt width (see `IosWheelPicker`'s doc comment).
 * Android keeps `@react-native-community/datetimepicker`'s native dialog
 * (`display="default"`), which is already a full-width OS overlay
 * unaffected by that bug.
 */
export function DateTimeField({ label, mode, value, onChange, minimumDate, formatValue }: DateTimeFieldProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  const openPicker = () => {
    setDraft(value);
    setOpen(true);
  };

  const handleAndroidChange = (event: DateTimePickerEvent, selected?: Date) => {
    setOpen(false);
    if (event.type !== 'dismissed' && selected) onChange(selected);
  };

  const confirm = () => {
    onChange(draft);
    setOpen(false);
  };

  return (
    <View className="flex-1 gap-1.5">
      <Text className="font-sans-bold text-xs text-muted">{label}</Text>
      <Pressable
        onPress={openPicker}
        className="w-full flex-row items-center justify-between rounded-xl bg-background px-4 py-3"
      >
        <Text className="font-sans text-sm text-ink" numberOfLines={1}>
          {formatValue(value)}
        </Text>
        <Ionicons name={mode === 'date' ? 'calendar-outline' : 'time-outline'} size={16} color={colors.muted} />
      </Pressable>

      {Platform.OS === 'android' && open ? (
        <DateTimePicker value={value} mode={mode} display="default" minimumDate={minimumDate} onChange={handleAndroidChange} />
      ) : null}

      {Platform.OS === 'ios' ? (
        <Modal visible={open} animationType="fade" transparent onRequestClose={() => setOpen(false)}>
          <Pressable className="flex-1 justify-end bg-ink/40" onPress={() => setOpen(false)}>
            {/*
              A no-op `onPress` here (rather than a plain `View`) makes this card its own
              touch responder, so taps/scrolls on the wheel columns below — a native
              `@react-native-picker/picker` view, which doesn't negotiate React Native's
              touch responder the way a JS `Pressable` does — stop here instead of
              bubbling up and triggering the backdrop's dismiss-on-tap above.
            */}
            <Pressable onPress={() => {}} className="w-full rounded-t-3xl bg-white pb-8 pt-2">
              <View className="items-center py-2">
                <View className="h-1 w-10 rounded-full bg-border" />
              </View>
              <Text className="px-5 pb-1 pt-1 text-center font-sans-bold text-[10px] uppercase tracking-wider text-muted">
                {label}
              </Text>
              {/* Only mounted while open, so its internal wheel state re-derives from the fresh `draft` each time the sheet opens. */}
              {open ? (
                <IosWheelPicker mode={mode} value={draft} minimumDate={minimumDate} onChange={setDraft} />
              ) : null}
              <View className="px-5 pt-3">
                <Pressable onPress={confirm} className="items-center rounded-xl bg-primary py-3.5">
                  <Text className="font-sans-bold text-sm text-white">Done</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  );
}
