import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Pressable, Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';

type CoverImagePickerProps = {
  uri?: string;
  onChange: (uri: string | undefined) => void;
};

/** Tappable placeholder/preview for a group's optional cover photo, backed by expo-image-picker. */
export function CoverImagePicker({ uri, onChange }: CoverImagePickerProps) {
  const pickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photo access needed', 'Allow SubUp to access your photos to set a cover image.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.7,
    });

    if (!result.canceled && result.assets[0]) {
      onChange(result.assets[0].uri);
    }
  };

  if (uri) {
    return (
      <Pressable onPress={pickImage} className="w-full overflow-hidden rounded-2xl">
        <Image source={{ uri }} style={{ width: '100%', height: 128 }} contentFit="cover" />
        <View className="absolute right-2 top-2 flex-row items-center gap-1 rounded-full bg-ink/60 px-3 py-1.5">
          <Ionicons name="camera-outline" size={12} color={colors.white} />
          <Text className="font-sans-bold text-[11px] text-white">Change</Text>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable onPress={pickImage} className="h-32 w-full items-center justify-center gap-2 rounded-2xl bg-background">
      <Ionicons name="camera-outline" size={22} color={colors.muted} />
      <Text className="font-sans-bold text-xs text-muted">Add cover photo (optional)</Text>
    </Pressable>
  );
}
