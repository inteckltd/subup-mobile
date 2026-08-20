import type { ImageProps } from 'expo-image';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';

import { AuthHeroHeader } from './AuthHeroHeader';

type AuthScreenLayoutProps = {
  title: string;
  /** The part of the title rendered in the brand-green accent colour, e.g. "Squad." in "Join the Squad." */
  titleAccent?: string;
  subtitle: React.ReactNode;
  showBack?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Overrides the default football-photo hero — used by Login/Sign up for a distinct background. */
  heroImage?: ImageProps['source'];
};

/**
 * Shared shell for every (auth) screen: the football-photo hero, the white
 * card with rounded top corners that overlaps it, and a keyboard-avoiding
 * scroll view for the form content. Mirrors the Figma reference structure.
 */
export function AuthScreenLayout({
  title,
  titleAccent,
  subtitle,
  showBack,
  children,
  footer,
  heroImage,
}: AuthScreenLayoutProps) {
  return (
    <View className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
      >
        <ScrollView
          className="flex-1"
          contentContainerClassName="grow"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <AuthHeroHeader showBack={showBack} heroImage={heroImage} />
          <View className="-mt-10 flex-1 rounded-t-card bg-white px-6 pb-8 pt-10">
            <View className="mb-6 gap-1">
              <Text className="font-sans-extrabold text-3xl tracking-tight text-ink">
                {title}
                {titleAccent ? <Text className="font-sans-extrabold text-primary">{titleAccent}</Text> : null}
              </Text>
              <Text className="font-sans text-base text-muted">{subtitle}</Text>
            </View>
            <View className="gap-6">{children}</View>
            {footer ? <View className="mt-8">{footer}</View> : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
