import { LegalScreenLayout } from '../src/features/auth/components/LegalScreenLayout';
import { PRIVACY_VERSION } from '../src/features/auth/schemas';
import { PrivacyCopy } from '../src/features/legal/copy';

export default function PrivacyScreen() {
  return (
    <LegalScreenLayout title="Privacy Policy" version={PRIVACY_VERSION}>
      <PrivacyCopy />
    </LegalScreenLayout>
  );
}
