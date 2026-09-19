import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, useMotionValue, useTransform, animate, AnimatePresence } from 'motion/react';
import {
  Heart,
  X,
  Sparkles,
  SlidersHorizontal,
  RotateCcw,
  MapPin,
  IndianRupee,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  MessageCircleHeart,
  Info,
  ChevronLeft,
  ChevronRight,
  Home
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.js';
import { api } from '../services/api.js';
import { DiscoverProfile, DiscoverFilters, MatchItem, UserProfile } from '../types.js';
import { MatchReportModal } from '../components/MatchReportModal.js';
import { DiscoverFiltersModal } from '../components/DiscoverFiltersModal.js';

interface DiscoverPageProps {
  onOpenMatchChat: (matchId: string) => void;
  onOpenAuth: () => void;
}

// Derive default discovery filters from user profile choices
const getInitialFiltersFromProfile = (p: UserProfile | null | undefined): DiscoverFilters => {
  if (!p) return {};
  const def: DiscoverFilters = {};

  // 1. Gender preference (e.g. 'Women only' or 'Men only')
  if (p.flatmate_gender_preference && p.flatmate_gender_preference !== 'Any') {
    def.gender_preference = p.flatmate_gender_preference;
  }

  // 2. Locality (User's primary flat/search location)
  if (p.locality && p.locality !== 'All') {
    def.locality = p.locality;
  }

  // 3. Housing Goal Intent
  if (p.housing_intent?.has_house) {
    // If user has a flat, they are looking for a flatmate to fill a vacant room
    def.housing_intent = 'vacancy';
  } else if (p.housing_intent?.looking_for_vacancy && !p.housing_intent?.looking_to_co_search) {
    def.housing_intent = 'has_house';
  } else if (p.housing_intent?.looking_to_co_search && !p.housing_intent?.looking_for_vacancy) {
    def.housing_intent = 'co_search';
  }

  // 4. Rent budget
  if (p.housing_intent?.has_house && p.house_details?.rent_for_vacant_room) {
    def.max_rent = p.house_details.rent_for_vacant_room;
  } else {
    if (p.rent_min) def.min_rent = p.rent_min;
    if (p.rent_max) def.max_rent = p.rent_max;
  }

  // 5. Food preference
  if (p.food_preference && p.food_preference === 'Vegetarian' && !p.okay_with_nonveg_cooking) {
    def.food_preference = 'Vegetarian';
  }

  // 6. Non-negotiables / Dealbreakers
  if (p.non_negotiables && p.non_negotiables.length > 0) {
    def.non_negotiables = [...p.non_negotiables];
    for (const nn of p.non_negotiables) {
      const lower = nn.toLowerCase();
      if (lower.includes('no smoking') || lower.includes('non-smoking')) {
        def.smoking = 'No';
      }
      if (lower.includes('pure veg') || lower.includes('vegetarian kitchen')) {
        def.food_preference = 'Vegetarian';
      }
    }
  }

  return def;
};

export const DiscoverPage: React.FC<DiscoverPageProps> = ({ onOpenMatchChat, onOpenAuth }) => {
  const { user, profile } = useAuth();

  const [profilesList, setProfilesList] = useState<DiscoverProfile[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters State - Initialized with signup preferences
  const defaultFilters = useMemo(() => getInitialFiltersFromProfile(profile), [profile]);
  const [filters, setFilters] = useState<DiscoverFilters>(() => getInitialFiltersFromProfile(profile));
  const [hasInitializedFilters, setHasInitializedFilters] = useState(false);

  // Sync filters whenever profile first loads or changes
  useEffect(() => {
    if (profile && !hasInitializedFilters) {
      setFilters(getInitialFiltersFromProfile(profile));
      setHasInitializedFilters(true);
    }
  }, [profile, hasInitializedFilters]);

  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);

  // Count active filters
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.locality && filters.locality !== 'All') count++;
    if (filters.gender_preference && filters.gender_preference !== 'Any') count++;
    if (filters.housing_intent && filters.housing_intent !== 'All') count++;
    if (filters.min_rent) count++;
    if (filters.max_rent) count++;
    if (filters.food_preference && filters.food_preference !== 'Any') count++;
    if (filters.smoking && filters.smoking !== 'Any') count++;
    if (filters.drinking && filters.drinking !== 'Any') count++;
    if (filters.cleanliness && filters.cleanliness !== 'Any') count++;
    if (filters.sleep_schedule && filters.sleep_schedule !== 'Any') count++;
    if (filters.non_negotiables && filters.non_negotiables.length > 0) {
      count += filters.non_negotiables.length;
    }
    return count;
  }, [filters]);

  const removeFilter = (key: keyof DiscoverFilters) => {
    setFilters(prev => {
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
  };

  const removeNonNegotiable = (item: string) => {
    setFilters(prev => {
      const current = prev.non_negotiables || [];
      const updated = current.filter(nn => nn !== item);
      return {
        ...prev,
        non_negotiables: updated.length > 0 ? updated : undefined
      };
    });
  };

  // Modals
  const [newMatchModal, setNewMatchModal] = useState<MatchItem | null>(null);

  // Revisit Skipped Profiles Mode
  const [isReviewMode, setIsReviewMode] = useState(false);
  const [passedProfiles, setPassedProfiles] = useState<DiscoverProfile[]>([]);

  // Motion values for swipe gesture
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-260, 0, 260], [-18, 0, 18]);
  const likeOpacity = useTransform(x, [15, 80], [0, 1]);
  const likeScale = useTransform(x, [15, 80], [0.8, 1.08]);
  const passOpacity = useTransform(x, [-15, -80], [0, 1]);
  const passScale = useTransform(x, [-15, -80], [0.8, 1.08]);
  const greenGlowOpacity = useTransform(x, [10, 120], [0, 0.16]);
  const redGlowOpacity = useTransform(x, [-10, -120], [0, 0.16]);

  // Reactive depth transforms for stacked card beneath
  const nextCardScale = useTransform(x, [-160, 0, 160], [1, 0.95, 1]);
  const nextCardOpacity = useTransform(x, [-160, 0, 160], [0.9, 0.55, 0.9]);
  const nextCardY = useTransform(x, [-160, 0, 160], [0, 10, 0]);

  const [isSwiping, setIsSwiping] = useState(false);
  const [swipeDirection, setSwipeDirection] = useState<'left' | 'right' | null>(null);

  // Fetch Discover Profiles
  const fetchProfiles = useCallback(async (currentFilters: DiscoverFilters) => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.getDiscoverProfiles(currentFilters);
      setProfilesList(res.profiles);
      setCurrentIndex(0);
    } catch (err: any) {
      setError(err.message || 'Could not load profiles.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch Skipped Profiles
  const fetchPassedProfiles = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.getPassedProfiles();
      setPassedProfiles(res.profiles);
      setIsReviewMode(true);
      setCurrentIndex(0);
    } catch (err: any) {
      setError(err.message || 'Could not load passed profiles.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProfiles(filters);
  }, [fetchProfiles, filters]);

  // Periodic real-time synchronization every 5 seconds to sync with backend updates
  useEffect(() => {
    if (isReviewMode) return;

    const interval = setInterval(async () => {
      try {
        const res = await api.getDiscoverProfiles(filters);
        setProfilesList(prev => {
          if (prev.length === 0 && res.profiles.length > 0) {
            return res.profiles;
          }
          // If profile counts changed, update list
          if (res.profiles.length !== prev.length) {
            return res.profiles;
          }
          return prev;
        });
      } catch {
        // silent sync
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [filters, isReviewMode]);

  // Fluid Swipe Action Handler
  const triggerSwipe = async (action: 'like' | 'pass') => {
    if (isSwiping) return;
    if (!user) {
      onOpenAuth();
      return;
    }

    const activeProfile = isReviewMode ? passedProfiles[currentIndex] : profilesList[currentIndex];
    if (!activeProfile) return;

    setIsSwiping(true);
    setSwipeDirection(action === 'like' ? 'right' : 'left');

    // Haptic feedback for tactile confirmation on touch devices
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate?.(action === 'like' ? [20, 35, 20] : 20);
      } catch {
        // ignore if not allowed by browser permissions
      }
    }

    try {
      // Calculate responsive throw distance so card clears viewport
      const screenW = typeof window !== 'undefined' ? window.innerWidth : 600;
      const flyDistance = action === 'like' ? Math.max(screenW * 0.9, 600) : -Math.max(screenW * 0.9, 600);

      // Smooth programmatic acceleration off screen
      await animate(x, flyDistance, {
        duration: 0.22,
        ease: [0.32, 0.72, 0, 1]
      });

      const res = await api.swipe(activeProfile.user_id, action);

      if (res.is_match && res.match) {
        setNewMatchModal(res.match);
      }

      if (isReviewMode) {
        const updated = passedProfiles.filter((_, idx) => idx !== currentIndex);
        setPassedProfiles(updated);
        if (currentIndex >= updated.length) {
          setCurrentIndex(Math.max(0, updated.length - 1));
        }
      } else {
        const updated = profilesList.filter((_, idx) => idx !== currentIndex);
        setProfilesList(updated);
        if (currentIndex >= updated.length) {
          setCurrentIndex(Math.max(0, updated.length - 1));
        }
      }
    } catch {
      // fallback on error
    } finally {
      x.set(0);
      setSwipeDirection(null);
      setIsSwiping(false);
    }
  };

  const handleDragEnd = (_: any, info: any) => {
    if (isSwiping) return;
    const threshold = 70; // 70px horizontal travel threshold
    const velocityThreshold = 350; // flick gesture speed

    if (info.offset.x > threshold || info.velocity.x > velocityThreshold) {
      triggerSwipe('like');
    } else if (info.offset.x < -threshold || info.velocity.x < -velocityThreshold) {
      triggerSwipe('pass');
    } else {
      // Return card cleanly to center with spring damping
      animate(x, 0, {
        type: 'spring',
        stiffness: 450,
        damping: 30
      });
    }
  };

  const currentProfile = isReviewMode ? passedProfiles[currentIndex] : profilesList[currentIndex];
  const nextProfile = isReviewMode ? passedProfiles[currentIndex + 1] : profilesList[currentIndex + 1];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 md:pb-12">
      {/* Top Filter & Mode Bar */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          {isReviewMode ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setIsReviewMode(false);
                  fetchProfiles(filters);
                }}
                className="w-8 h-8 rounded-xl bg-white border border-[#E6E3DE] flex items-center justify-center text-[#2B2D42] hover:border-[#E07A5F] shrink-0"
                title="Back to Discover"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="min-w-0">
                <h2 className="font-display font-extrabold text-lg sm:text-2xl text-[#2B2D42] truncate">
                  Skipped Profiles
                </h2>
                <p className="text-[11px] sm:text-xs text-[#7A7D87] truncate">
                  {passedProfiles.length} flatmates previously passed
                </p>
              </div>
            </div>
          ) : (
            <div>
              <h2 className="font-display font-extrabold text-xl sm:text-2xl md:text-3xl text-[#2B2D42] tracking-tight">
                Discover Flatmates
              </h2>
              <p className="text-[11px] sm:text-xs text-[#7A7D87] truncate mt-0.5">
                Matches based on your signup preferences • Real-time compatibility
              </p>
            </div>
          )}
        </div>

        {/* Action Buttons: sleek, responsive, and prominent */}
        <div className="flex items-center gap-2 shrink-0">
          {!isReviewMode && user && (
            <button
              onClick={fetchPassedProfiles}
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-2 rounded-xl bg-white border border-[#E6E3DE] text-[#7A7D87] font-semibold text-xs hover:text-[#2B2D42] hover:border-[#E07A5F] transition-all min-h-[38px]"
              title="Review Passed Flatmates"
            >
              <RotateCcw className="w-3.5 h-3.5 text-[#7A7D87]" />
              <span className="hidden sm:inline">Skipped</span>
            </button>
          )}

          <button
            id="open-filters-btn"
            onClick={() => setIsFilterModalOpen(true)}
            className={`flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-xl font-bold text-xs shadow-xs hover:shadow-sm active:scale-95 transition-all min-h-[38px] ${
              activeFilterCount > 0
                ? 'bg-[#E07A5F] text-white hover:bg-[#D4694E] border border-[#E07A5F]'
                : 'bg-white text-[#2B2D42] border border-[#E6E3DE] hover:border-[#E07A5F]'
            }`}
          >
            <SlidersHorizontal className={`w-3.5 h-3.5 ${activeFilterCount > 0 ? 'text-white' : 'text-[#E07A5F]'}`} />
            <span>Filters</span>
            {activeFilterCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-black bg-white text-[#E07A5F] leading-none">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Active Filters Strip (Responsive horizontal scroll on mobile) */}
      {!isReviewMode && activeFilterCount > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-2.5 mb-4 text-xs scrollbar-none">
          <span className="text-[10px] font-bold text-[#7A7D87] uppercase tracking-wider shrink-0 mr-0.5">
            Filtered:
          </span>

          {filters.gender_preference && filters.gender_preference !== 'Any' && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#E07A5F]/40 text-[#E07A5F] font-semibold text-[11px] shrink-0 shadow-2xs">
              {filters.gender_preference}
              <button
                onClick={() => removeFilter('gender_preference')}
                className="hover:text-[#D64545] ml-0.5 p-0.5"
                title="Remove gender filter"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.locality && filters.locality !== 'All' && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#E6E3DE] text-[#2B2D42] text-[11px] font-medium shrink-0 shadow-2xs">
              📍 {filters.locality}
              <button
                onClick={() => removeFilter('locality')}
                className="text-[#7A7D87] hover:text-[#D64545] ml-0.5 p-0.5"
                title="Remove locality filter"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.housing_intent && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#E6E3DE] text-[#2B2D42] text-[11px] font-medium shrink-0 shadow-2xs">
              🏠 {filters.housing_intent === 'has_house' ? 'Has Flat' : filters.housing_intent === 'co_search' ? 'Co-Search' : 'Room Vacancy'}
              <button
                onClick={() => removeFilter('housing_intent')}
                className="text-[#7A7D87] hover:text-[#D64545] ml-0.5 p-0.5"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {(filters.min_rent || filters.max_rent) && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#E6E3DE] text-[#2B2D42] text-[11px] font-medium shrink-0 shadow-2xs">
              💰 {filters.min_rent ? `₹${filters.min_rent.toLocaleString()}` : '₹0'} - {filters.max_rent ? `₹${filters.max_rent.toLocaleString()}` : 'Any'}
              <button
                onClick={() => {
                  removeFilter('min_rent');
                  removeFilter('max_rent');
                }}
                className="text-[#7A7D87] hover:text-[#D64545] ml-0.5 p-0.5"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.food_preference && filters.food_preference !== 'Any' && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#E6E3DE] text-[#2B2D42] text-[11px] font-medium shrink-0 shadow-2xs">
              🥗 {filters.food_preference}
              <button
                onClick={() => removeFilter('food_preference')}
                className="text-[#7A7D87] hover:text-[#D64545] ml-0.5 p-0.5"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.smoking && filters.smoking !== 'Any' && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-[#E6E3DE] text-[#2B2D42] text-[11px] font-medium shrink-0 shadow-2xs">
              🚭 Smoking: {filters.smoking}
              <button
                onClick={() => removeFilter('smoking')}
                className="text-[#7A7D87] hover:text-[#D64545] ml-0.5 p-0.5"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {filters.non_negotiables?.map(nn => (
            <span
              key={nn}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#FAF8F4] border border-[#E07A5F]/50 text-[#E07A5F] text-[11px] font-semibold shrink-0 shadow-2xs"
            >
              🛡️ {nn}
              <button
                onClick={() => removeNonNegotiable(nn)}
                className="text-[#E07A5F] hover:text-[#D64545] ml-0.5 p-0.5"
                title={`Remove ${nn}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}

          <button
            onClick={() => setFilters({})}
            className="text-[11px] text-[#7A7D87] hover:text-[#D64545] underline font-semibold shrink-0 ml-1 whitespace-nowrap"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Progressive discovery context */}
      {!isReviewMode && currentProfile && currentProfile.discovery_tier && currentProfile.discovery_tier > 1 && (
        <div className="mb-4 rounded-2xl border border-[#E07A5F]/25 bg-[#FFF7F3] px-4 py-3 flex items-start gap-3">
          <div className="w-8 h-8 rounded-xl bg-[#E07A5F]/12 text-[#E07A5F] flex items-center justify-center shrink-0">
            <MapPin className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-extrabold text-[#2B2D42]">
              {currentProfile.discovery_tier === 2
                ? `More profiles in ${filters.locality || 'your selected area'}`
                : currentProfile.discovery_tier === 3
                  ? 'Showing profiles from the next nearby area'
                  : 'Showing more profiles from the wider area'}
            </p>
            <p className="text-[11px] text-[#7A7D87] mt-0.5 leading-relaxed">
              {currentProfile.discovery_tier === 2
                ? 'The exact combination of filters is exhausted in this area, so a few softer preferences are relaxed while keeping your core compatibility constraints.'
                : currentProfile.discovery_tier === 3
                  ? `Your requested area is exhausted. These profiles are from ${currentProfile.discovery_area || 'a nearby area'} and still match your selected preferences.`
                  : `Nearby matches are exhausted. These profiles are from ${currentProfile.discovery_area || 'the wider area'} so you can keep discovering while core compatibility constraints remain protected.`}
            </p>
          </div>
        </div>
      )}

      {/* Main Discover Layout */}
      {loading && profilesList.length === 0 && passedProfiles.length === 0 ? (
        <div className="min-h-[50vh] flex flex-col items-center justify-center text-center p-8">
          <div className="w-12 h-12 rounded-2xl bg-[#E07A5F]/15 text-[#E07A5F] flex items-center justify-center animate-pulse mb-3">
            <Sparkles className="w-6 h-6" />
          </div>
          <h3 className="font-display font-bold text-lg text-[#2B2D42]">Finding compatible flatmates...</h3>
          <p className="text-xs text-[#7A7D87] mt-1">Comparing habits, locations, and lifestyles in Bangalore</p>
        </div>
      ) : !currentProfile ? (
        <div className="min-h-[55vh] max-w-lg mx-auto bg-white rounded-3xl border border-[#E6E3DE] p-8 text-center flex flex-col items-center justify-center shadow-lg">
          <div className="w-16 h-16 rounded-2xl bg-[#FAF8F4] border border-[#E6E3DE] flex items-center justify-center text-[#E07A5F] mb-4">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <h3 className="font-display font-bold text-2xl text-[#2B2D42]">
            {isReviewMode ? 'No more passed profiles' : "You've seen all matches!"}
          </h3>
          <p className="text-xs text-[#7A7D87] mt-2 max-w-sm">
            {isReviewMode
              ? 'You have reviewed all previously skipped flatmates.'
              : 'New flatmates join daily. Try adjusting your locality or budget filters to see more people.'}
          </p>

          <div className="flex flex-wrap gap-3 mt-6">
            <button
              onClick={() => {
                setFilters({});
                setIsReviewMode(false);
                fetchProfiles({});
              }}
              className="px-5 py-2.5 rounded-xl bg-[#E07A5F] text-white font-bold text-xs hover:bg-[#D4694E] shadow-sm transition-all"
            >
              Reset Filters
            </button>
            {!isReviewMode && user && (
              <button
                onClick={fetchPassedProfiles}
                className="px-5 py-2.5 rounded-xl bg-white border border-[#E6E3DE] text-[#2B2D42] font-bold text-xs hover:bg-[#FAF8F4] transition-all"
              >
                Review Passed Profiles
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Main Profile Swipable Card Area (Left & Center) */}
          <div className="lg:col-span-8 relative">
            {/* Background stacked card for realistic depth */}
            {nextProfile && (
              <motion.div
                style={{
                  scale: nextCardScale,
                  opacity: nextCardOpacity,
                  y: nextCardY
                }}
                className="absolute inset-0 bg-white rounded-3xl border border-[#E6E3DE] shadow-md pointer-events-none overflow-hidden"
              >
                <div className="aspect-[4/3] sm:aspect-[16/10] bg-[#2B2D42]">
                  <img
                    src={nextProfile.main_photo || nextProfile.photos?.[0]?.url || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&auto=format&fit=crop&q=80'}
                    alt={nextProfile.name}
                    className="w-full h-full object-cover"
                  />
                </div>
              </motion.div>
            )}

            {/* Active Swipeable Card */}
            <motion.div
              key={currentProfile.user_id}
              style={{
                x,
                rotate,
                touchAction: 'pan-y'
              }}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.85}
              dragMomentum={false}
              whileDrag={{ scale: 1.012, cursor: 'grabbing' }}
              onDragEnd={handleDragEnd}
              className="bg-white rounded-3xl border border-[#E6E3DE] shadow-2xl overflow-hidden cursor-grab active:cursor-grabbing select-none relative z-10 touch-pan-y"
            >
              {/* Green Atmospheric Tint on Right Swipe */}
              <motion.div
                style={{ opacity: greenGlowOpacity }}
                className="absolute inset-0 bg-[#4F8A6D] pointer-events-none z-20 rounded-3xl transition-opacity"
              />

              {/* Red/Terracotta Atmospheric Tint on Left Swipe */}
              <motion.div
                style={{ opacity: redGlowOpacity }}
                className="absolute inset-0 bg-[#E07A5F] pointer-events-none z-20 rounded-3xl transition-opacity"
              />

              {/* Tinder-like LIKE Stamp (Right Swipe) */}
              <motion.div
                style={{ opacity: likeOpacity, scale: likeScale }}
                className="absolute top-6 left-6 z-30 pointer-events-none border-4 border-[#4F8A6D] text-[#4F8A6D] bg-white/95 backdrop-blur-md px-4 sm:px-6 py-2 rounded-2xl font-display font-black text-xl sm:text-2xl uppercase tracking-wider transform -rotate-12 shadow-2xl flex items-center gap-2"
              >
                <Heart className="w-6 h-6 fill-[#4F8A6D]" />
                <span>CONNECT</span>
              </motion.div>

              {/* Tinder-like NOPE Stamp (Left Swipe) */}
              <motion.div
                style={{ opacity: passOpacity, scale: passScale }}
                className="absolute top-6 right-6 z-30 pointer-events-none border-4 border-[#E07A5F] text-[#E07A5F] bg-white/95 backdrop-blur-md px-4 sm:px-6 py-2 rounded-2xl font-display font-black text-xl sm:text-2xl uppercase tracking-wider transform rotate-12 shadow-2xl flex items-center gap-2"
              >
                <X className="w-6 h-6 stroke-[3]" />
                <span>PASS</span>
              </motion.div>

              {/* Top Photo & Identity Section */}
              <div className="relative aspect-[4/3] sm:aspect-[16/10] bg-[#2B2D42] overflow-hidden">
                <img
                  src={currentProfile.main_photo || currentProfile.photos?.[0]?.url || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&auto=format&fit=crop&q=80'}
                  alt={currentProfile.name}
                  className="w-full h-full object-cover pointer-events-none"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

                {/* Verified Badge */}
                {currentProfile.is_verified && (
                  <div className="absolute top-4 left-4 bg-white/95 backdrop-blur-md text-[#2B2D42] px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-md">
                    <ShieldCheck className="w-4 h-4 text-[#4F8A6D]" />
                    <span>Verified Flatmate</span>
                  </div>
                )}

                {/* Housing badge on top right */}
                <div className="absolute top-4 right-4 bg-[#2B2D42]/90 backdrop-blur-md text-white px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-md">
                  {currentProfile.housing_intent?.has_house ? (
                    <>
                      <Home className="w-3.5 h-3.5 text-[#F2C078]" />
                      <span>Has Flat ({currentProfile.house_details?.bhk || 'Available'})</span>
                    </>
                  ) : (
                    <>
                      <MapPin className="w-3.5 h-3.5 text-[#F2C078]" />
                      <span>{currentProfile.locality}</span>
                    </>
                  )}
                </div>

                {/* Floating Bottom Card Details */}
                <div className="absolute bottom-4 left-4 right-4 text-white">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <h3 className="font-display font-black text-2xl sm:text-3xl tracking-tight flex items-center gap-2">
                        <span>{currentProfile.name}</span>
                        <span className="text-xl sm:text-2xl font-bold text-white/90">
                          {currentProfile.age}
                        </span>
                      </h3>
                      <div className="flex items-center gap-3 text-xs text-white/90 mt-1 font-medium">
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3.5 h-3.5 text-[#F2C078]" />
                          <span>{currentProfile.locality}, Bangalore</span>
                        </span>
                        <span>•</span>
                        <span className="flex items-center gap-1">
                          <IndianRupee className="w-3.5 h-3.5 text-[#F2C078]" />
                          <span>
                            {currentProfile.housing_intent?.has_house && currentProfile.house_details?.rent_for_vacant_room
                              ? `₹${currentProfile.house_details.rent_for_vacant_room.toLocaleString()} room rent`
                              : `₹${currentProfile.rent_min?.toLocaleString()} - ₹${currentProfile.rent_max?.toLocaleString()} / mo`}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Profile Content Details */}
              <div className="p-6 sm:p-8 space-y-6">
                {/* Bio */}
                {currentProfile.bio && (
                  <div>
                    <h4 className="label-caps text-[#7A7D87] mb-2">About</h4>
                    <p className="text-sm sm:text-base text-[#2B2D42] leading-relaxed font-medium">
                      "{currentProfile.bio}"
                    </p>
                  </div>
                )}

                {/* Housing Details (If person has house) */}
                {currentProfile.housing_intent?.has_house && currentProfile.house_details && (
                  <div className="bg-[#FAF8F4] border border-[#E6E3DE] rounded-3xl p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Home className="w-5 h-5 text-[#E07A5F]" />
                        <h4 className="font-display font-bold text-base text-[#2B2D42]">
                          Flat & Vacant Room Details
                        </h4>
                      </div>
                      <span className="text-xs font-extrabold px-2.5 py-1 rounded-lg bg-[#E07A5F]/15 text-[#E07A5F]">
                        {currentProfile.house_details.bhk}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
                      <div className="bg-white border border-[#E6E3DE] rounded-xl p-2.5">
                        <span className="text-[#7A7D87] block text-[10px] uppercase font-bold">Washroom</span>
                        <span className="font-bold text-[#2B2D42]">
                          {currentProfile.house_details.attached_washroom_in_vacant_room ? 'Attached Private' : 'Shared Washroom'}
                        </span>
                      </div>
                      <div className="bg-white border border-[#E6E3DE] rounded-xl p-2.5">
                        <span className="text-[#7A7D87] block text-[10px] uppercase font-bold">Balcony</span>
                        <span className="font-bold text-[#2B2D42]">
                          {currentProfile.house_details.balcony_type}
                        </span>
                      </div>
                      <div className="bg-white border border-[#E6E3DE] rounded-xl p-2.5 col-span-2 sm:col-span-1">
                        <span className="text-[#7A7D87] block text-[10px] uppercase font-bold">Deposit</span>
                        <span className="font-bold text-[#4F8A6D]">
                          ₹{currentProfile.house_details.deposit_amount?.toLocaleString() || 'Flexible'}
                        </span>
                      </div>
                    </div>

                    {/* Included Amenities */}
                    {currentProfile.house_details.vacant_room_amenities && currentProfile.house_details.vacant_room_amenities.length > 0 && (
                      <div>
                        <span className="text-[11px] font-bold text-[#7A7D87] block mb-1.5">Included Flat Amenities:</span>
                        <div className="flex flex-wrap gap-1.5">
                          {currentProfile.house_details.vacant_room_amenities.map(am => (
                            <span key={am} className="text-xs px-2.5 py-1 rounded-lg bg-white border border-[#E6E3DE] text-[#2B2D42] font-medium">
                              ✓ {am}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* House Photos */}
                    {currentProfile.house_details.house_photos && currentProfile.house_details.house_photos.length > 0 && (
                      <div>
                        <span className="text-[11px] font-bold text-[#7A7D87] block mb-2">Flat & Room Photos:</span>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                          {currentProfile.house_details.house_photos.map((hp, idx) => (
                            <div key={hp.id || idx} className="relative aspect-[4/3] rounded-2xl overflow-hidden border border-[#E6E3DE] bg-white group">
                              <img src={hp.url} alt={hp.caption || 'House Photo'} className="w-full h-full object-cover hover:scale-105 transition-transform pointer-events-none" />
                              {hp.caption && (
                                <div className="absolute bottom-1.5 left-1.5 right-1.5 bg-black/60 backdrop-blur-xs text-white text-[10px] font-bold px-2 py-0.5 rounded-md truncate">
                                  {hp.caption}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Housing Intent Badges */}
                <div>
                  <h4 className="label-caps text-[#7A7D87] mb-2">Housing Goal</h4>
                  <div className="flex flex-wrap gap-2">
                    {currentProfile.housing_intent?.has_house && (
                      <span className="px-3 py-1.5 rounded-xl bg-[#FAF8F4] border border-[#E6E3DE] text-xs font-bold text-[#2B2D42]">
                        🏠 Has a Flat (Looking for flatmate)
                      </span>
                    )}
                    {currentProfile.housing_intent?.looking_to_co_search && (
                      <span className="px-3 py-1.5 rounded-xl bg-[#FAF8F4] border border-[#E6E3DE] text-xs font-bold text-[#2B2D42]">
                        🤝 Looking to Co-Search Flat
                      </span>
                    )}
                    {currentProfile.housing_intent?.looking_for_vacancy && (
                      <span className="px-3 py-1.5 rounded-xl bg-[#FAF8F4] border border-[#E6E3DE] text-xs font-bold text-[#2B2D42]">
                        🔍 Seeking Vacancy
                      </span>
                    )}
                  </div>
                </div>

                {/* Lifestyle Habits Grid */}
                <div>
                  <h4 className="label-caps text-[#7A7D87] mb-2.5">Living Habits & Rhythm</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div className="bg-[#FAF8F4] border border-[#E6E3DE] rounded-xl p-3">
                      <span className="text-[10px] uppercase font-bold text-[#7A7D87] block">Food</span>
                      <span className="text-xs font-bold text-[#2B2D42] mt-0.5 block">{currentProfile.food_preference}</span>
                    </div>
                    <div className="bg-[#FAF8F4] border border-[#E6E3DE] rounded-xl p-3">
                      <span className="text-[10px] uppercase font-bold text-[#7A7D87] block">Cleanliness</span>
                      <span className="text-xs font-bold text-[#2B2D42] mt-0.5 block">{currentProfile.cleanliness} Standard</span>
                    </div>
                    <div className="bg-[#FAF8F4] border border-[#E6E3DE] rounded-xl p-3">
                      <span className="text-[10px] uppercase font-bold text-[#7A7D87] block">Sleep</span>
                      <span className="text-xs font-bold text-[#2B2D42] mt-0.5 block">{currentProfile.sleep_schedule}</span>
                    </div>
                    <div className="bg-[#FAF8F4] border border-[#E6E3DE] rounded-xl p-3">
                      <span className="text-[10px] uppercase font-bold text-[#7A7D87] block">Smoking</span>
                      <span className="text-xs font-bold text-[#2B2D42] mt-0.5 block">{currentProfile.smoking}</span>
                    </div>
                  </div>
                </div>

                {/* Non-Negotiables */}
                {currentProfile.non_negotiables && currentProfile.non_negotiables.length > 0 && (
                  <div>
                    <h4 className="label-caps text-[#7A7D87] mb-2">Non-Negotiables</h4>
                    <div className="flex flex-wrap gap-2">
                      {currentProfile.non_negotiables.map((nn, idx) => (
                        <span
                          key={idx}
                          className="px-3 py-1.5 rounded-xl bg-[#E07A5F]/10 border border-[#E07A5F]/30 text-xs font-bold text-[#E07A5F]"
                        >
                          ⚡ {nn}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Prompts */}
                {currentProfile.prompts && currentProfile.prompts.length > 0 && (
                  <div className="space-y-3">
                    {currentProfile.prompts.map((p, idx) => (
                      <div key={idx} className="bg-[#FAF8F4] border border-[#E6E3DE] rounded-2xl p-4">
                        <p className="text-xs font-bold text-[#7A7D87] uppercase tracking-wide">
                          {p.question}
                        </p>
                        <p className="text-sm font-semibold text-[#2B2D42] mt-1">
                          {p.answer}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Hobbies & Languages */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                  <div>
                    <h4 className="label-caps text-[#7A7D87] mb-2">Hobbies & Interests</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {currentProfile.hobbies?.map(h => (
                        <span key={h} className="px-2.5 py-1 rounded-lg bg-white border border-[#E6E3DE] text-xs font-medium text-[#2B2D42]">
                          {h}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h4 className="label-caps text-[#7A7D87] mb-2">Languages</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {currentProfile.languages?.map(l => (
                        <span key={l} className="px-2.5 py-1 rounded-lg bg-white border border-[#E6E3DE] text-xs font-medium text-[#2B2D42]">
                          {l}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Additional Photos */}
                {currentProfile.photos && currentProfile.photos.length > 1 && (
                  <div>
                    <h4 className="label-caps text-[#7A7D87] mb-2">Photo Gallery</h4>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {currentProfile.photos.slice(1).map((pic, idx) => (
                        <div key={idx} className="aspect-square rounded-2xl overflow-hidden border border-[#E6E3DE]">
                          <img src={pic.url} alt="Gallery" className="w-full h-full object-cover hover:scale-105 transition-transform pointer-events-none" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Mobile swipe gesture guide cue */}
              <div className="px-6 py-2.5 bg-[#FAF8F4] border-t border-[#E6E3DE] flex items-center justify-between text-[11px] font-bold select-none">
                <span className="flex items-center gap-1 text-[#E07A5F]">
                  <ChevronLeft className="w-3.5 h-3.5 animate-pulse" />
                  <span>Swipe Left to Pass</span>
                </span>
                <span className="hidden sm:inline text-[#7A7D87]/50 font-normal">or tap buttons</span>
                <span className="flex items-center gap-1 text-[#4F8A6D]">
                  <span>Swipe Right to Connect</span>
                  <ChevronRight className="w-3.5 h-3.5 animate-pulse" />
                </span>
              </div>

              {/* Bottom Action Bar (Swipe button triggers) */}
              <div className="p-4 sm:p-6 bg-white border-t border-[#E6E3DE] flex items-center justify-center gap-8 sm:gap-12">
                <button
                  id="swipe-pass-btn"
                  disabled={isSwiping}
                  onClick={() => triggerSwipe('pass')}
                  className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-white border-2 border-[#E6E3DE] hover:border-[#E07A5F] text-[#7A7D87] hover:text-[#E07A5F] flex items-center justify-center shadow-lg hover:scale-110 active:scale-90 disabled:opacity-50 transition-all cursor-pointer"
                  title="Swipe Left / Pass"
                >
                  <X className="w-8 h-8 sm:w-10 sm:h-10 stroke-[2.5]" />
                </button>

                <button
                  id="swipe-like-btn"
                  disabled={isSwiping}
                  onClick={() => triggerSwipe('like')}
                  className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-[#E07A5F] hover:bg-[#D4694E] text-white flex items-center justify-center shadow-xl hover:scale-110 active:scale-90 disabled:opacity-50 transition-all cursor-pointer"
                  title="Swipe Right / Connect"
                >
                  <Heart className="w-8 h-8 sm:w-10 sm:h-10 fill-white stroke-[2.5]" />
                </button>
              </div>
            </motion.div>
          </div>

          {/* Desktop Right Insights Panel */}
          <div className="hidden lg:block lg:col-span-4 space-y-6">
            {/* Compatibility Unlock Banner */}
            <div className="bg-white rounded-3xl border border-[#E6E3DE] p-6 shadow-sm">
              <div className="flex items-center gap-2 text-[#E07A5F] mb-3">
                <Sparkles className="w-5 h-5" />
                <span className="label-caps text-[#E07A5F]">Mutual Compatibility</span>
              </div>

              <h4 className="font-display font-bold text-lg text-[#2B2D42] mb-1.5">
                Detailed Match Report
              </h4>

              <p className="text-xs text-[#7A7D87] leading-relaxed mb-4">
                Swipe right on {currentProfile.name.split(' ')[0]} to connect. Once you both match, FlatMate+'s comprehensive compatibility breakdown will be unlocked in chat!
              </p>

              <div className="p-3.5 rounded-2xl bg-[#FAF8F4] border border-[#E6E3DE] flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-[#E07A5F]/15 text-[#E07A5F] flex items-center justify-center font-bold text-xs shrink-0">
                  🔒
                </div>
                <span className="text-xs font-semibold text-[#7A7D87]">
                  Unlocked upon mutual match
                </span>
              </div>
            </div>

            {/* Bangalore Safety & Tips */}
            <div className="bg-[#4F8A6D]/10 border border-[#4F8A6D]/20 rounded-3xl p-6 text-xs text-[#2B2D42]">
              <div className="flex items-center gap-2 font-bold text-[#4F8A6D] mb-2">
                <ShieldCheck className="w-5 h-5" />
                <span>FlatMate+ Trust Guarantee</span>
              </div>
              <p className="text-[#7A7D87] leading-relaxed">
                Profiles undergo photo authenticity, liveness peace-sign checks, and verification to keep Bangalore flatmate finding scam-free and safe.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* New Mutual Match Modal */}
      {newMatchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-sm w-full p-6 text-center border border-[#E6E3DE] shadow-2xl relative">
            <div className="w-16 h-16 rounded-full bg-[#E07A5F]/15 text-[#E07A5F] flex items-center justify-center mx-auto mb-3">
              <MessageCircleHeart className="w-8 h-8" />
            </div>

            <span className="label-caps text-[#E07A5F] block mb-1">It's a Match!</span>
            <h3 className="font-display font-black text-2xl text-[#2B2D42]">
              You and {newMatchModal.other_user?.name?.split(' ')[0]} connected!
            </h3>
            <p className="text-xs text-[#7A7D87] mt-1">
              You share a {newMatchModal.match_score}% lifestyle compatibility score.
            </p>

            <div className="flex items-center justify-center gap-4 my-6">
              <img
                src={profile?.main_photo || profile?.photos?.[0]?.url}
                alt="You"
                className="w-16 h-16 rounded-full object-cover border-2 border-[#E07A5F] shadow-md"
              />
              <div className="w-8 h-8 rounded-full bg-[#E07A5F] text-white flex items-center justify-center font-bold text-xs shadow-sm">
                ❤️
              </div>
              <img
                src={newMatchModal.other_user?.main_photo || newMatchModal.other_user?.photos?.[0]?.url}
                alt={newMatchModal.other_user?.name}
                className="w-16 h-16 rounded-full object-cover border-2 border-[#E07A5F] shadow-md"
              />
            </div>

            <div className="space-y-2">
              <button
                id="modal-start-chat-btn"
                onClick={() => {
                  const mId = newMatchModal.id;
                  setNewMatchModal(null);
                  onOpenMatchChat(mId);
                }}
                className="w-full py-3 rounded-2xl bg-[#E07A5F] text-white font-bold text-sm hover:bg-[#D4694E] shadow-sm transition-all"
              >
                Start Chatting
              </button>
              <button
                onClick={() => setNewMatchModal(null)}
                className="w-full py-2.5 rounded-2xl bg-white border border-[#E6E3DE] text-[#7A7D87] font-bold text-xs hover:bg-[#FAF8F4] transition-all"
              >
                Keep Swiping
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filter Modal */}
      {isFilterModalOpen && (
        <DiscoverFiltersModal
          isOpen={isFilterModalOpen}
          onClose={() => setIsFilterModalOpen(false)}
          filters={filters}
          defaultFilters={defaultFilters}
          onApplyFilters={newF => {
            setFilters(newF);
            setIsFilterModalOpen(false);
          }}
          onResetFilters={() => {
            setFilters({});
          }}
          onResetToDefaults={() => {
            setFilters({ ...defaultFilters });
          }}
        />
      )}
    </div>
  );
};
