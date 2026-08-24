import { Text } from 'react-native';

function Para({ children }: { children: string }) {
  return <Text className="font-sans text-base text-ink">{children}</Text>;
}

export function TermsCopy() {
  return (
    <>
      <Para>
        These Terms of Service (“Terms”) apply when you use PitchIn, the mobile app operated by Inteck for organising
        private recreational sports groups in the United Kingdom.
      </Para>
      <Para>
        You must be able to enter a contract under UK law. There is no age gate in this version of the app. You are
        responsible for the accuracy of the information you provide, including your UK mobile number, and for keeping
        your login details secure.
      </Para>
      <Para>
        PitchIn is for organising private groups, scheduling games, joining or leaving a lobby, recording scores, voting
        for Man of the Match, and viewing history and ratings. Groups are invite-only. You agree to treat other players
        with respect and not to misuse invites, notifications, or SMS.
      </Para>
      <Para>
        Paid games are joined with Apple Pay, Google Pay, or card via Stripe. You pay the pitch cost the organiser set
        plus a PitchIn service fee shown before you confirm. The organiser (the group treasurer) receives the pitch
        amount through Stripe Connect; PitchIn retains the service fee. There is no cash or waived entry. If you leave
        before the lock window, card payments are refunded in full (pitch plus PitchIn fee). After the lock window you
        cannot leave a confirmed spot. If a game is cancelled before kickoff, paid players are refunded in full. After
        kickoff the game cannot be cancelled and payments are not refunded. The treasurer is paid the pitch total after
        the game starts; that usually reaches their bank in around two business days. PitchIn retains the service fee
        when you pay.
      </Para>
      <Para>
        We may suspend or delete accounts that abuse the service (for example spam invites, impersonation, or attempts
        to access other people’s data). You can delete your account in Settings. We may update these Terms; if we change
        the version stored in the app you will be asked to accept again before continuing.
      </Para>
      <Para>
        PitchIn is provided as-is. We do not guarantee that every game will go ahead, that scores or ratings are
        complete, or that the service will be uninterrupted. To the extent permitted by UK law we are not liable for
        lost games, payment processor outages, or indirect loss.
      </Para>
      <Text className="font-sans text-base text-muted">
        This draft will be reviewed by a solicitor before public App Store / Play Store launch. Hosted web copies of
        these Terms will be published at that point.
      </Text>
    </>
  );
}

export function PrivacyCopy() {
  return (
    <>
      <Para>
        PitchIn (“we”) is the controller of personal data you provide in the app. Contact: the support email listed on
        our store listings (or in Settings once published).
      </Para>
      <Para>
        We process: your name, UK mobile number (your login), optional email, optional profile photo, group and game
        activity, scores, votes, ratings, push tokens, and device diagnostics if you enable error reporting. Legal
        bases: contract (to run your account and groups) and legitimate interests (security, abuse prevention, product
        reliability).
      </Para>
      <Para>
        Data is stored with Supabase (Postgres, Auth, Storage) with a UK/EU region target. Password-reset and group
        invite texts are sent by Twilio. Push notifications use Expo. Crash and error reports may be sent to Sentry if
        configured. Card and payout payments are processed by Stripe (including Stripe Connect for organiser payouts).
        We do not sell your data. We do not store full card or bank account numbers.
      </Para>
      <Para>
        Group members can see your name, photo, and rating — not your mobile or email — through the app. Group admins
        enter a mobile number to invite you. You can delete your account in Settings; we remove memberships, upcoming
        spots, tokens, and your login. Past game history may show “Deleted user”.
      </Para>
      <Para>
        You have UK GDPR rights: access, rectification, erasure, restriction, objection, and portability, and the right
        to complain to the ICO. We keep account data while your account exists and for a short period afterwards as
        needed for security and legal claims.
      </Para>
      <Text className="font-sans text-base text-muted">
        This draft will be reviewed by a solicitor before public launch. A hosted Privacy Policy URL is required for
        App Store and Play Console.
      </Text>
    </>
  );
}
