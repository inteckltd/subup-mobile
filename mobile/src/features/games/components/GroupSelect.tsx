import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { FlatList, Modal, Pressable, Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';
import type { CreatableGroupModel } from '../types';

type GroupSelectProps = {
  groups: CreatableGroupModel[];
  value: string;
  onChange: (groupId: string) => void;
  disabled?: boolean;
};

/**
 * Bottom-sheet-style group dropdown — no picker/select library exists in
 * this repo, so this is a plain `Modal` + `FlatList`, styled to match the
 * Figma reference's gray-pill "Options" row (see get_design_context on
 * node 39:170). `disabled` covers the "arrived via a groupId param" case,
 * where the group is locked to whatever Group Details passed in.
 */
export function GroupSelect({ groups, value, onChange, disabled }: GroupSelectProps) {
  const [open, setOpen] = useState(false);
  const selected = groups.find((group) => group.id === value);

  return (
    <>
      <Pressable
        onPress={() => !disabled && groups.length > 0 && setOpen(true)}
        className={`w-full flex-row items-center justify-between rounded-xl bg-background px-4 py-3 ${disabled ? 'opacity-60' : ''}`}
      >
        <Text className={`flex-1 font-sans text-sm ${selected ? 'text-ink' : 'text-muted'}`} numberOfLines={1}>
          {selected ? selected.name : groups.length === 0 ? "You don't admin any groups yet" : 'Select a group'}
        </Text>
        {disabled ? null : <Ionicons name="chevron-down" size={16} color={colors.muted} />}
      </Pressable>

      <Modal visible={open} animationType="fade" transparent onRequestClose={() => setOpen(false)}>
        <Pressable className="flex-1 justify-end bg-ink/40" onPress={() => setOpen(false)}>
          <View className="max-h-[60%] rounded-t-3xl bg-white pb-8 pt-2">
            <View className="items-center py-2">
              <View className="h-1 w-10 rounded-full bg-border" />
            </View>
            <Text className="px-5 pb-2 pt-1 font-sans-bold text-[10px] uppercase tracking-wider text-muted">
              Select a group
            </Text>
            <FlatList
              data={groups}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => {
                    onChange(item.id);
                    setOpen(false);
                  }}
                  className="flex-row items-center justify-between px-5 py-3.5"
                >
                  <Text className="font-sans-bold text-sm text-ink">{item.name}</Text>
                  {item.id === value ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
