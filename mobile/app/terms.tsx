import { LegalScreenLayout } from '../src/features/auth/components/LegalScreenLayout';
import { TERMS_VERSION } from '../src/features/auth/schemas';
import { TermsCopy } from '../src/features/legal/copy';

export default function TermsScreen() {
  return (
    <LegalScreenLayout title="Terms of Service" version={TERMS_VERSION}>
      <TermsCopy />
    </LegalScreenLayout>
  );
}
