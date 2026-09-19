import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { AuthUser, UserProfile, UserSettings, MatchItem, MessageItem } from '../types.js';
import { api, getStoredToken, clearStoredToken } from '../services/api.js';
import { wsService } from '../services/websocket.js';

interface BannerNotification {
  id: string;
  senderName: string;
  senderPhoto?: string;
  content: string;
  matchId: string;
}

interface AuthContextType {
  user: AuthUser | null;
  profile: UserProfile | null;
  settings: UserSettings;
  loading: boolean;
  activeBanner: BannerNotification | null;
  unreadTotal: number;
  login: (email: string, pass: string) => Promise<void>;
  signup: (email: string, pass: string, name?: string) => Promise<void>;
  googleLogin: (idToken: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  updateProfileState: (updated: UserProfile) => void;
  updateSettingsState: (updated: Partial<UserSettings>) => Promise<void>;
  dismissBanner: () => void;
  setUnreadTotal: React.Dispatch<React.SetStateAction<number>>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [settings, setSettings] = useState<UserSettings>({
    new_message_banner: true,
    email_notifications: true,
    privacy_mode: false
  });
  const [loading, setLoading] = useState(true);
  const [activeBanner, setActiveBanner] = useState<BannerNotification | null>(null);
  const [unreadTotal, setUnreadTotal] = useState(0);

  const refreshUser = useCallback(async () => {
    const token = getStoredToken();
    if (!token) {
      setUser(null);
      setProfile(null);
      setLoading(false);
      return;
    }

    try {
      const res = await api.getMe();
      setUser(res.user);
      setProfile(res.user.profile || null);
      if (res.settings) setSettings(res.settings);
    } catch {
      clearStoredToken();
      setUser(null);
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  // Real-time WebSocket + SSE stream for instant delivery, message banners & sync
  useEffect(() => {
    if (!user) {
      wsService.disconnect();
      return;
    }

    // Connect WebSocket
    wsService.connect();

    const handleIncomingMessage = (data: any) => {
      const msg = data.message;
      const sender = data.sender;
      const matchId = data.match_id;

      if (!msg) return;

      // Increment unread count
      setUnreadTotal(prev => prev + 1);

      // Trigger new message banner if enabled in settings
      if (settings.new_message_banner && sender && sender.id !== user.id) {
        setActiveBanner({
          id: msg.id,
          senderName: sender.name || 'Flatmate Match',
          senderPhoto: sender.photo || sender.main_photo,
          content: msg.content,
          matchId: matchId || msg.match_id
        });
      }
    };

    const handleNewMatch = () => {
      setUnreadTotal(prev => prev + 1);
    };

    const unsubMsg = wsService.on('chat:message', handleIncomingMessage);
    const unsubNewMsg = wsService.on('new_message', handleIncomingMessage);
    const unsubMatch = wsService.on('match', handleNewMatch);

    // Also connect fallback SSE stream
    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource('/api/realtime/stream');
      eventSource.addEventListener('new_message', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          handleIncomingMessage(data);
        } catch {
          // ignore
        }
      });
      eventSource.addEventListener('match', handleNewMatch);
    } catch {
      // SSE not available
    }

    return () => {
      unsubMsg();
      unsubNewMsg();
      unsubMatch();
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [user, settings.new_message_banner]);

  const login = async (email: string, pass: string) => {
    const res = await api.login({ email, password: pass });
    setUser(res.user);
    setProfile(res.user.profile || null);
    wsService.connect();
  };

  const signup = async (email: string, pass: string, name?: string) => {
    const res = await api.signup({ email, password: pass, name });
    setUser(res.user);
    setProfile(res.user.profile || null);
    wsService.connect();
  };

  const googleLogin = async (idToken: string) => {
    const res = await api.googleAuth({ id_token: idToken });
    setUser(res.user);
    setProfile(res.user.profile || null);
    wsService.connect();
  };

  const logout = () => {
    wsService.disconnect();
    clearStoredToken();
    setUser(null);
    setProfile(null);
  };

  const updateProfileState = (updated: UserProfile) => {
    setProfile(updated);
    if (user) {
      setUser({ ...user, profile: updated });
    }
  };

  const updateSettingsState = async (updated: Partial<UserSettings>) => {
    const res = await api.updateSettings(updated);
    setSettings(res.settings);
  };

  const dismissBanner = () => {
    setActiveBanner(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        settings,
        loading,
        activeBanner,
        unreadTotal,
        login,
        signup,
        googleLogin,
        logout,
        refreshUser,
        updateProfileState,
        updateSettingsState,
        dismissBanner,
        setUnreadTotal
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
