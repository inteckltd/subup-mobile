export type Profile = {
  id: string;
  full_name: string;
  mobile: string | null;
  mobile_verified_at: string | null;
  email: string | null;
  avatar_url: string | null;
  terms_accepted_at: string | null;
  terms_version: string | null;
  privacy_version: string | null;
  global_mmr: number;
  games_played: number;
  motm_count: number;
  reliability_score: number | null;
  created_at: string;
  updated_at: string;
};
