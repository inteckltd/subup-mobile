import { Modal, Pressable, View } from 'react-native';

import { colors } from '../../../theme/tokens';
import { Avatar } from './Avatar';

type AvatarLightboxProps = {
  visible: boolean;
  uri?: string | null;
  name?: string | null;
  onClose: () => void;
};

/** Fullscreen avatar preview — tap outside or the image to close. */
export function AvatarLightbox({ visible, uri, name, onClose }: AvatarLightboxProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/80" onPress={onClose}>
        <View pointerEvents="none">
          <Avatar uri={uri} name={name} size={240} ringColor={colors.white} ringWidth={4} />
        </View>
      </Pressable>
    </Modal>
  );
}
