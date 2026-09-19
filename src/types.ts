export type Gender = 'Man' | 'Woman' | 'Non-binary' | 'Other';
export type GenderPreference = 'Any' | 'Men only' | 'Women only' | 'Same gender';

export type FoodPreference = 'Vegetarian' | 'Non-vegetarian' | 'Eggetarian' | 'Vegan';

export type SmokingLevel = 'No' | 'Occasionally' | 'Yes';
export type DrinkingLevel = 'No' | 'Occasionally' | 'Yes';
export type CleanlinessLevel = 'Strict' | 'Moderate' | 'Relaxed';
export type SleepSchedule = 'Early bird' | 'Flexible' | 'Night owl';
export type SocialLevel = 'Quiet' | 'Balanced' | 'Social';
export type GuestPolicy = 'Rarely' | 'Weekends only' | 'Anytime with notice' | 'Very open';
export type FamilyVisits = 'Rarely' | 'Occasionally' | 'Frequent';
export type PartyPolicy = 'Never at home' | 'Occasionally' | 'Love house parties';
export type PetPolicy = 'No pets' | 'Have pets' | 'Pet lover / Open to pets';
export type WorkSchedule = 'WFH' | 'Hybrid' | 'Office / In-person' | 'Flexible';

export type FurnishingType = 'Fully furnished' | 'Semi-furnished' | 'Unfurnished' | 'Flexible';
export type WashroomType = 'Must have' | 'Nice to have' | 'Flexible';

export interface UserHousingIntent {
  has_house: boolean; // "Have a flat (looking for a flatmate)"
  looking_for_vacancy: boolean; // "Looking for a vacant room in a flat"
  looking_to_co_search: boolean; // "Looking for a flatmate to co-search"
}

export type BHKType = '1 BHK' | '2 BHK' | '3 BHK' | '4+ BHK';
export type BalconyType = 'Attached to vacant room' | 'Common balcony' | 'Multiple balconies' | 'No balcony';

export interface HouseDetails {
  bhk: BHKType;
  total_washrooms: number;
  attached_washroom_in_vacant_room: boolean;
  balcony_type: BalconyType;
  vacant_room_amenities: string[]; // e.g. Bed & Mattress, Wardrobe, AC, Study Desk, Geyser, WiFi, etc.
  house_photos: PhotoItem[];
  rent_for_vacant_room?: number;
  deposit_amount?: number;
}

export interface PhotoItem {
  id: string;
  url: string;
  is_main: boolean;
  caption?: string;
  verified?: boolean;
}

export interface PromptItem {
  question: string;
  answer: string;
}

export interface UserProfile {
  id: string;
  user_id: string;
  name: string;
  date_of_birth: string;
  age: number;
  gender: Gender;
  flatmate_gender_preference: GenderPreference;
  
  // Location
  city: string;
  locality: string;
  preferred_localities: string[];
  
  // Housing Intent
  housing_intent: UserHousingIntent;
  house_details?: HouseDetails; // Compulsory when housing_intent.has_house is true
  
  // Budget
  rent_min: number;
  rent_max: number;
  
  // Food
  food_preference: FoodPreference;
  okay_with_nonveg_cooking: boolean; // Distinct from being non-veg!
  
  // Lifestyle
  smoking: SmokingLevel;
  drinking: DrinkingLevel;
  cleanliness: CleanlinessLevel;
  sleep_schedule: SleepSchedule;
  social_level: SocialLevel;
  guests: GuestPolicy;
  family_visits: FamilyVisits;
  parties: PartyPolicy;
  pets: PetPolicy;
  work_schedule: WorkSchedule;
  
  // Flat preferences
  attached_washroom: WashroomType;
  furnishing: FurnishingType;
  gated_society: boolean;
  
  // Hobbies & Languages
  hobbies: string[];
  languages: string[];
  
  // Non-negotiables (0 - 4 max)
  non_negotiables: string[];
  
  // Bio & Prompts
  bio: string;
  prompts: PromptItem[];
  
  // Photos
  photos: PhotoItem[];
  main_photo?: string;
  
  // Verification & Liveness
  is_verified: boolean;
  liveness_verified: boolean;
  live_verification_photo?: string; // Captured live photo with peace sign
  photo_similarity_score?: number; // Similarity percentage (0-100) between live peace sign & profile photo
  verification_status: 'unverified' | 'pending' | 'verified' | 'rejected';
  verification_note?: string;
  
  // Status
  onboarding_step: number; // 1 to 12 or 100 for completed
  is_profile_complete: boolean;
  discover_active: boolean;
  moved_in_status: 'none' | 'requested' | 'moved_in';
  moved_in_with_match_id?: string | null;
  
  created_at: string;
  updated_at: string;
}

export interface AuthUser {
  id: string;
  email: string;
  phone: string;
  phone_verified: boolean;
  email_verified: boolean;
  google_id?: string;
  profile?: UserProfile;
}

export interface MatchScoreCategory {
  category: string;
  score: number; // 0 - 100
  weight: number;
  label: string; // e.g. "Very similar standards", "Your budgets overlap well"
}

export interface MatchScoreResult {
  total_score: number; // 0 - 100
  categories: MatchScoreCategory[];
  highlights: string[];
  dealbreakers_met: boolean;
}

export interface DiscoverFilters {
  locality?: string;
  min_rent?: number;
  max_rent?: number;
  gender_preference?: string;
  housing_intent?: string; // 'all' | 'has_house' | 'co_search' | 'vacancy'
  food_preference?: string;
  smoking?: string;
  drinking?: string;
  cleanliness?: string;
  sleep_schedule?: string;
  pets?: string;
  social_level?: string;
  non_negotiables?: string[];
}

export interface DiscoverProfile extends UserProfile {
  match_score?: number;
  match_breakdown?: MatchScoreResult;
  distance_km?: number;
  discovery_tier?: number;
  discovery_tier_label?: string;
  relaxed_filter_level?: number;
  discovery_area?: string;
  area_distance_level?: number;
}

export interface MatchItem {
  id: string;
  user_ids: [string, string];
  other_user: UserProfile;
  match_score: number;
  match_breakdown: MatchScoreResult;
  last_message?: {
    content: string;
    sender_id: string;
    created_at: string;
    read: boolean;
  };
  unread_count: number;
  moving_in_requested_by: string[];
  status: 'active' | 'moved_in' | 'blocked';
  created_at: string;
  updated_at: string;
}

export interface MessageItem {
  id: string;
  match_id: string;
  sender_id: string;
  recipient_id: string;
  content: string;
  created_at: string;
  read: boolean;
}

export interface BlockRecord {
  id: string;
  blocker_id: string;
  blocked_id: string;
  blocked_user?: {
    name: string;
    photo?: string;
    locality: string;
  };
  reason?: string;
  created_at: string;
}

export interface UserSettings {
  new_message_banner: boolean;
  email_notifications: boolean;
  privacy_mode: boolean;
}
