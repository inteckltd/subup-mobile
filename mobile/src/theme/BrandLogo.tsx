import { Image } from 'expo-image';

const logo = require('../../assets/images/subup-logo.png');

/** Intrinsic size of `subup-logo.png` after the black field was knocked out. */
const LOGO_ASPECT = 991 / 212;

type BrandLogoProps = {
  height?: number;
};

/** Cyan lockup for navy/photo headers. */
export function BrandLogo({ height = 28 }: BrandLogoProps) {
  return (
    <Image
      source={logo}
      style={{ height, width: height * LOGO_ASPECT }}
      contentFit="contain"
      accessibilityLabel="SubUp"
    />
  );
}
