import { Text, View } from 'react-native';

import { PrimaryButton } from '../../auth/components/PrimaryButton';

type GameLobbyActionsProps = {
  showSameAgain: boolean;
  onSameAgain: () => void;
  onSharePlayers: () => void;
  shareBusy?: boolean;
  shareDisabled?: boolean;
  message?: string | null;
};

/** Big labelled actions on the game lobby. One primary job stays in the footer. */
export function GameLobbyActions({
  showSameAgain,
  onSameAgain,
  onSharePlayers,
  shareBusy,
  shareDisabled,
  message,
}: GameLobbyActionsProps) {
  return (
    <View className="w-full gap-3">
      {showSameAgain ? (
        <PrimaryButton
          label="Same again next week"
          variant="outline"
          icon="arrow-redo-outline"
          onPress={onSameAgain}
        />
      ) : null}
      <PrimaryButton
        label="Share who's playing"
        variant="outline"
        icon="share-outline"
        loading={shareBusy}
        disabled={shareDisabled}
        onPress={onSharePlayers}
      />
      {message ? <Text className="font-sans-medium text-sm text-danger">{message}</Text> : null}
    </View>
  );
}
