import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.js';
import { Navbar } from './components/Navbar.js';
import { FlatMateLogo } from './components/FlatMateLogo.js';
import { NewMessageBanner } from './components/NewMessageBanner.js';
import { LandingPage } from './pages/LandingPage.js';
import { OnboardingFlow } from './pages/OnboardingFlow.js';
import { DiscoverPage } from './pages/DiscoverPage.js';
import { MatchesPage } from './pages/MatchesPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { AuthModal } from './pages/AuthModal.js';
import { Walkthrough } from './components/Walkthrough.js';

const MainApp: React.FC = () => {
  const { user, profile, loading } = useAuth();
  const [activeTab, setActiveTab] = useState<'discover' | 'matches' | 'profile' | 'settings'>('discover');
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('signup');
  const [previewGuestMode, setPreviewGuestMode] = useState(false);
  const [showWalkthrough, setShowWalkthrough] = useState(false);

  React.useEffect(() => {
    if (user && profile?.is_profile_complete) {
      setShowWalkthrough(window.localStorage.getItem('flatmate_walkthrough_pending') === '1');
    } else {
      setShowWalkthrough(false);
    }
  }, [user, profile?.is_profile_complete]);

  const completeWalkthrough = () => {
    window.localStorage.removeItem('flatmate_walkthrough_pending');
    setShowWalkthrough(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FAF8F4] flex flex-col items-center justify-center p-4">
        <FlatMateLogo size={76} />
        <p className="font-display font-black text-2xl text-[#2B2D42] mt-4">FLATMATE<span className="text-[#E07A5F]">+</span></p>
        <p className="text-xs text-[#7A7D87] mt-1">Live with people who get you.</p>
      </div>
    );
  }

  if (!user && !previewGuestMode) {
    return <LandingPage onExploreDemo={() => setPreviewGuestMode(true)} />;
  }

  if (user && profile && !profile.is_profile_complete) {
    return <OnboardingFlow onFinish={() => setActiveTab('discover')} />;
  }

  return (
    <div className="min-h-screen bg-[#FAF8F4] text-[#2B2D42] flex flex-col selection:bg-[#E07A5F]/20 selection:text-[#E07A5F]">
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onOpenAuth={() => { setAuthMode('signup'); setIsAuthOpen(true); }}
      />
      <NewMessageBanner onOpenMatch={matchId => { setActiveMatchId(matchId); setActiveTab('matches'); }} />
      <main className="flex-1">
        {activeTab === 'discover' && (
          <DiscoverPage
            onOpenMatchChat={matchId => { setActiveMatchId(matchId); setActiveTab('matches'); }}
            onOpenAuth={() => { setAuthMode('signup'); setIsAuthOpen(true); }}
          />
        )}
        {activeTab === 'matches' && <MatchesPage selectedMatchId={activeMatchId} onSelectMatchId={setActiveMatchId} />}
        {activeTab === 'profile' && <ProfilePage />}
        {activeTab === 'settings' && <SettingsPage />}
      </main>
      {showWalkthrough && <Walkthrough onComplete={completeWalkthrough} />}\n      {isAuthOpen && (
        <AuthModal
          isOpen={isAuthOpen}
          initialMode={authMode}
          onClose={() => setIsAuthOpen(false)}
          onSuccess={() => { setIsAuthOpen(false); setPreviewGuestMode(false); }}
        />
      )}
    </div>
  );
};

export default function App() {
  return <AuthProvider><MainApp /></AuthProvider>;
}
