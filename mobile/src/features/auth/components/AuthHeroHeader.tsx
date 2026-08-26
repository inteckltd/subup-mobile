import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Image, type ImageProps } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { BrandLogo } from '../../../theme/BrandLogo';

const defaultHeroImage = require('../../../../assets/images/auth-hero.jpg');

type AuthHeroHeaderProps = {
  showBack?: boolean;
  /** Overrides the default football-photo hero — used by Login/Sign up for a distinct background. */
  heroImage?: ImageProps['source'];
};

/** The 280px football-photo hero shared by every (auth) screen, with the SubUp mark + wordmark. */
export function AuthHeroHeader({ showBack, heroImage }: AuthHeroHeaderProps) {
  return (
    <View className="h-[280px] w-full overflow-hidden">
      <Image
        source={heroImage ?? defaultHeroImage}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        contentFit="cover"
      />
      <LinearGradient
        colors={['rgba(3,36,136,0.35)', 'rgba(255,255,255,0)', '#FFFFFF']}
        locations={[0, 0.5, 1]}
        className="absolute inset-0"
      />
      <View className="flex-1 items-center justify-center pb-20 pt-24">
        <BrandLogo height={44} variant="white" />
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
