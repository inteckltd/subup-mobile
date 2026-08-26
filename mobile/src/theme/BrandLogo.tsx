import { Image } from 'expo-image';

const logos = {
  cyan: require('../../assets/images/subup-logo.png'),
  white: require('../../assets/images/subup-logo-white.png'),
} as const;

const ASPECT = {
  cyan: 991 / 212,
  white: 1500 / 438,
} as const;

type BrandLogoProps = {
  height?: number;
  /** Cyan lockup for navy headers; white lockup for photo heroes. */
  variant?: keyof typeof logos;
};

export function BrandLogo({ height = 28, variant = 'cyan' }: BrandLogoProps) {
  return (
    <Image
      source={logos[variant]}
      style={{ height, width: height * ASPECT[variant] }}
      contentFit="contain"
      accessibilityLabel="SubUp"
    />
  );
}
