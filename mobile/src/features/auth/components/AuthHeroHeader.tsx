import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Image, type ImageProps } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

const defaultHeroImage = require('../../../../assets/images/auth-hero.jpg');

type AuthHeroHeaderProps = {
  showBack?: boolean;
  /** Overrides the default football-photo hero — used by Login/Sign up for a distinct background. */
  heroImage?: ImageProps['source'];
};

/** The 280px football-photo hero shared by every (auth) screen, with the PitchIn mark + wordmark. */
export function AuthHeroHeader({ showBack, heroImage }: AuthHeroHeaderProps) {
  return (
    <View className="h-[280px] w-full overflow-hidden">
      <Image
        source={heroImage ?? defaultHeroImage}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        contentFit="cover"
      />
      <LinearGradient
        colors={['rgba(10,28,21,0.2)', 'rgba(255,255,255,0)', '#FFFFFF']}
        locations={[0, 0.5, 1]}
        className="absolute inset-0"
      />
      <View className="flex-1 items-center justify-center gap-3 pb-20 pt-24">
        <View className="h-14 w-14 -rotate-3 items-center justify-center rounded-2xl bg-accent shadow-lg">
          <Ionicons name="people" size={26} color="#0B6E4F" />
        </View>
        <Text className="font-sans-extrabold text-3xl tracking-tight text-white">PitchIn</Text>
      </View>
      {showBack ? (
        <Pressable
          onPress={() => router.back()}
          className="absolute left-6 top-12 h-10 w-10 items-center justify-center overflow-hidden rounded-xl"
        >
          <BlurView
            intensity={30}
            tint="light"
            className="absolute inset-0 items-center justify-center border border-white/30"
          >
            <Ionicons name="arrow-back" size={18} color="#FFFFFF" />
          </BlurView>
        </Pressable>
      ) : null}
    </View>
  );
}
