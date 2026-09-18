import React, { useState, useEffect } from 'react';
import {
  X,
  Sparkles,
  Mail,
  Lock,
  Phone,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  ArrowLeft
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.js';
import { api } from '../services/api.js';

function decodeGoogleIdToken(idToken: string): { email?: string; name?: string; sub?: string } | null {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialMode?: 'login' | 'signup';
  onSuccess?: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  initialMode = 'signup',
  onSuccess
}) => {
  const { login, signup, googleLogin, refreshUser } = useAuth();

  const [mode, setMode] = useState<'login' | 'signup'>(initialMode);
  const [step, setStep] = useState<'credentials' | 'otp' | 'google_input'>('credentials');

  // Form State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');

  // Direct Google Email input fallback if OAuth popup is blocked
  const [googleEmail, setGoogleEmail] = useState('');
  const [googleFullName, setGoogleFullName] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [otpSentMsg, setOtpSentMsg] = useState<string | null>(null);

  // Listen for Google OAuth popup callbacks
  useEffect(() => {
    const handleOAuthMessage = async (event: MessageEvent) => {
      // Accept callbacks only from the same origin as the app.
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'GOOGLE_AUTH_CALLBACK') {
        setLoading(true);
        try {
          const { idToken } = event.data;
          const googleProfile = idToken ? decodeGoogleIdToken(idToken) : null;
          const resolvedEmail = googleProfile?.email || googleEmail || '';
          const resolvedName = googleProfile?.name || googleFullName || resolvedEmail.split('@')[0] || 'Google User';
          const resolvedGoogleId = googleProfile?.sub || undefined;
          if (!resolvedEmail) {
            throw new Error('Google did not return an email address. Please try again.');
          }

          // Populate the onboarding name from the Google account profile.
          setName(resolvedName);
          setGoogleEmail(resolvedEmail);
          setGoogleFullName(resolvedName);

          await googleLogin(
            resolvedEmail,
            resolvedName,
            resolvedGoogleId
          );
          onSuccess?.();
          onClose();
        } catch (err: any) {
          setError(err.message || 'Google authentication failed.');
        } finally {
          setLoading(false);
        }
      }
    };

    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [googleEmail, googleFullName, googleLogin, onSuccess, onClose]);

  if (!isOpen) return null;

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === 'signup') {
        await signup(email, password, name);
      } else {
        await login(email, password);
      }

      // If user provided phone or during signup, move to phone verification step
      if (phone.trim() && mode === 'signup') {
        const otpRes = await api.sendOtp(phone);
        if (otpRes.dev_code) setDevCode(otpRes.dev_code);
        setOtpSentMsg(otpRes.message);
        setStep('otp');
        setLoading(false);
        return;
      }

      onSuccess?.();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please check your details.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await api.verifyOtp(phone, otp);
      await refreshUser();
      onSuccess?.();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Incorrect or expired OTP. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Google OAuth Flow
  const handleStartGoogleOAuth = async () => {
    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/auth/google/url');
      const data = await response.json();

      if (data.configured && data.url) {
        // Open OAuth Provider's popup directly
        const authWindow = window.open(
          data.url,
          'google_oauth_popup',
          'width=500,height=600,menubar=no,toolbar=no'
        );

        if (!authWindow) {
          // If popup is blocked, switch to Google email verification form
          setStep('google_input');
        }
      } else {
        // Direct Google Sign In modal
        setStep('google_input');
      }
    } catch {
      setStep('google_input');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleDirectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!googleEmail.trim()) {
      setError('Please enter your Google account email.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const gName = googleFullName.trim() || googleEmail.split('@')[0];
      await googleLogin(
        googleEmail.trim().toLowerCase(),
        gName,
        `gid_${googleEmail.replace(/[^a-zA-Z0-9]/g, '_')}`
      );
      onSuccess?.();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Google sign-in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in overflow-y-auto">
      <div className="bg-white rounded-3xl w-full max-w-md overflow-hidden shadow-2xl border border-[#E6E3DE] p-5 sm:p-8 relative my-auto min-w-0">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-5 right-5 w-8 h-8 rounded-full bg-[#FAF8F4] flex items-center justify-center text-[#7A7D87] hover:text-[#2B2D42] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        {/* ========================================================= */}
        {/* STEP: CREDENTIALS (LOGIN / SIGNUP) */}
        {/* ========================================================= */}
        {step === 'credentials' && (
          <div>
            <div className="text-center mb-6">
              <div className="w-12 h-12 rounded-2xl bg-[#E07A5F]/15 text-[#E07A5F] flex items-center justify-center mx-auto mb-3">
                <Sparkles className="w-6 h-6" />
              </div>
              <h3 className="font-display font-extrabold text-2xl text-[#2B2D42]">
                {mode === 'signup' ? 'Join FlatMate+' : 'Welcome Back'}
              </h3>
              <p className="text-xs text-[#7A7D87] mt-1">
                {mode === 'signup'
                  ? 'Find verified flatmates who match your lifestyle.'
                  : 'Log in to continue finding your kind of people.'}
              </p>
            </div>

            {/* Google Sign In Button */}
            <button
              id="google-signin-btn"
              type="button"
              onClick={handleStartGoogleOAuth}
              disabled={loading}
              className="w-full py-3 px-4 rounded-2xl border border-[#E6E3DE] bg-white hover:bg-[#FAF8F4] text-[#2B2D42] font-bold text-sm flex items-center justify-center gap-3 shadow-sm transition-all mb-4 min-h-[46px]"
            >
              <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.66v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.15z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.35 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.17 0 9.99 0 12s.45 3.83 1.25 5.42l4.03-3.15z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.35 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
                />
              </svg>
              <span>Continue with Google</span>
            </button>

            <div className="flex items-center my-4">
              <div className="flex-1 border-t border-[#E6E3DE]" />
              <span className="px-3 text-[11px] font-bold tracking-wider text-[#7A7D87] uppercase">or with email</span>
              <div className="flex-1 border-t border-[#E6E3DE]" />
            </div>

            {/* Email/Password Form */}
            <form onSubmit={handleCredentialsSubmit} className="space-y-3.5">
              {mode === 'signup' && (
                <div>
                  <label className="label-caps text-[#7A7D87] block mb-1">Your Full Name</label>
                  <input
                    id="signup-name-input"
                    type="text"
                    required
                    placeholder="e.g. Pooja Verma"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-[#E6E3DE] text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/40"
                  />
                </div>
              )}

              <div>
                <label className="label-caps text-[#7A7D87] block mb-1">Email Address</label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-[#7A7D87] absolute left-3.5 top-3.5" />
                  <input
                    id="auth-email-input"
                    type="email"
                    required
                    placeholder="your.email@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#E6E3DE] text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/40"
                  />
                </div>
              </div>

              {mode === 'signup' && (
                <div>
                  <label className="label-caps text-[#7A7D87] block mb-1">Mobile Number (India)</label>
                  <div className="relative">
                    <Phone className="w-4 h-4 text-[#7A7D87] absolute left-3.5 top-3.5" />
                    <input
                      id="signup-phone-input"
                      type="tel"
                      placeholder="+91 98765 43210"
                      value={phone}
                      onChange={e => setPhone(e.target.value)}
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#E6E3DE] text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/40"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="label-caps text-[#7A7D87] block mb-1">Password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-[#7A7D87] absolute left-3.5 top-3.5" />
                  <input
                    id="auth-password-input"
                    type="password"
                    required
                    minLength={6}
                    placeholder="At least 6 characters"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#E6E3DE] text-sm focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/40"
                  />
                </div>
              </div>

              {error && (
                <div className="bg-[#D64545]/10 border border-[#D64545]/20 rounded-xl p-3 flex items-start gap-2 text-xs text-[#D64545]">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <p className="font-semibold">{error}</p>
                </div>
              )}

              <button
                id="submit-auth-btn"
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-2xl bg-[#E07A5F] text-white font-bold text-sm hover:bg-[#D4694E] shadow-sm flex items-center justify-center gap-2 min-h-[46px] disabled:opacity-50 mt-2 transition-all"
              >
                <span>{loading ? 'Please wait...' : mode === 'signup' ? 'Create Account' : 'Log In'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <div className="text-center mt-5 pt-4 border-t border-[#E6E3DE] text-xs text-[#7A7D87]">
              {mode === 'signup' ? (
                <p>
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => { setMode('login'); setError(null); }}
                    className="font-bold text-[#E07A5F] hover:underline"
                  >
                    Log In
                  </button>
                </p>
              ) : (
                <p>
                  New to FlatMate+?{' '}
                  <button
                    type="button"
                    onClick={() => { setMode('signup'); setError(null); }}
                    className="font-bold text-[#E07A5F] hover:underline"
                  >
                    Create Account
                  </button>
                </p>
              )}
            </div>
          </div>
        )}

        {/* ========================================================= */}
        {/* STEP: DIRECT GOOGLE ACCOUNT INPUT */}
        {/* ========================================================= */}
        {step === 'google_input' && (
          <div className="space-y-4 animate-in fade-in">
            <div className="text-center pb-2 border-b border-[#E6E3DE]">
              <div className="flex items-center justify-center gap-2 mb-2">
                <svg className="w-6 h-6" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.66v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.15z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.35 24 12 24z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.17 0 9.99 0 12s.45 3.83 1.25 5.42l4.03-3.15z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.35 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
                  />
                </svg>
                <span className="font-display font-bold text-lg text-[#2B2D42]">Google Sign In</span>
              </div>
              <h4 className="font-bold text-base text-[#2B2D42]">Sign in with your Google account</h4>
              <p className="text-xs text-[#7A7D87] mt-0.5">
                Enter your Google account details to link or log in
              </p>
            </div>

            <form onSubmit={handleGoogleDirectSubmit} className="space-y-3.5">
              <div>
                <label className="label-caps text-[#7A7D87] block mb-1">Google Email Address</label>
                <input
                  id="google-account-email-input"
                  type="email"
                  required
                  placeholder="your.google.account@gmail.com"
                  value={googleEmail}
                  onChange={e => setGoogleEmail(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#E6E3DE] text-sm focus:outline-none focus:ring-2 focus:ring-[#4285F4]/40"
                />
              </div>

              <div>
                <label className="label-caps text-[#7A7D87] block mb-1">Your Full Name</label>
                <input
                  id="google-account-name-input"
                  type="text"
                  placeholder="Your Name"
                  value={googleFullName}
                  onChange={e => setGoogleFullName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-[#E6E3DE] text-sm focus:outline-none focus:ring-2 focus:ring-[#4285F4]/40"
                />
              </div>

              {error && (
                <div className="bg-[#D64545]/10 border border-[#D64545]/20 rounded-xl p-3 text-xs text-[#D64545] font-semibold text-center">
                  {error}
                </div>
              )}

              <button
                id="submit-google-direct-btn"
                type="submit"
                disabled={loading || !googleEmail.trim()}
                className="w-full py-3 rounded-2xl bg-[#4285F4] hover:bg-[#3367D6] text-white font-bold text-sm shadow-sm flex items-center justify-center gap-2 min-h-[46px] disabled:opacity-50 transition-all"
              >
                <span>{loading ? 'Signing In...' : 'Continue with Google Account'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <div className="pt-3 border-t border-[#E6E3DE] flex items-center justify-between text-xs text-[#7A7D87]">
              <button
                type="button"
                onClick={() => setStep('credentials')}
                className="flex items-center gap-1 font-bold text-[#7A7D87] hover:text-[#2B2D42]"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to options</span>
              </button>
            </div>
          </div>
        )}

        {/* ========================================================= */}
        {/* STEP: PHONE OTP VERIFICATION */}
        {/* ========================================================= */}
        {step === 'otp' && (
          <div>
            <div className="text-center mb-6">
              <div className="w-12 h-12 rounded-2xl bg-[#4F8A6D]/15 text-[#4F8A6D] flex items-center justify-center mx-auto mb-3">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <h3 className="font-display font-extrabold text-2xl text-[#2B2D42]">
                Verify Your Number
              </h3>
              <p className="text-xs text-[#7A7D87] mt-1">
                Enter the 6-digit code we sent you.
              </p>
            </div>

            {otpSentMsg && (
              <div className="bg-[#4F8A6D]/10 border border-[#4F8A6D]/20 rounded-xl p-3 text-xs text-[#4F8A6D] font-medium text-center mb-4">
                {otpSentMsg}
              </div>
            )}

            {devCode && (
              <div className="bg-[#FAF8F4] border border-[#E6E3DE] rounded-xl p-3 text-center mb-4">
                <span className="label-caps text-[#7A7D87] block text-[10px]">Verification Code (Dev / Demo)</span>
                <span className="font-mono font-bold text-lg text-[#E07A5F] tracking-widest">{devCode}</span>
              </div>
            )}

            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div>
                <label className="label-caps text-[#7A7D87] block mb-2 text-center">6-Digit Code</label>
                <input
                  id="otp-input"
                  type="text"
                  maxLength={6}
                  required
                  placeholder="• • • • • •"
                  value={otp}
                  onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                  className="w-full text-center text-2xl tracking-[0.4em] font-mono py-3 rounded-xl border border-[#E6E3DE] focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/40 font-bold"
                />
              </div>

              {error && (
                <div className="bg-[#D64545]/10 border border-[#D64545]/20 rounded-xl p-3 text-xs text-[#D64545] font-semibold text-center">
                  {error}
                </div>
              )}

              <button
                id="verify-otp-btn"
                type="submit"
                disabled={loading || otp.length < 6}
                className="w-full py-3 rounded-2xl bg-[#E07A5F] text-white font-bold text-sm hover:bg-[#D4694E] shadow-sm flex items-center justify-center gap-2 min-h-[46px] disabled:opacity-50"
              >
                <span>{loading ? 'Verifying...' : 'Verify & Continue'}</span>
                <CheckCircle2 className="w-4 h-4" />
              </button>

              <div className="flex justify-between items-center text-xs text-[#7A7D87] pt-2">
                <button
                  type="button"
                  onClick={async () => {
                    setError(null);
                    try {
                      const res = await api.sendOtp(phone);
                      if (res.dev_code) setDevCode(res.dev_code);
                    } catch (e: any) {
                      setError(e.message || 'Could not resend code.');
                    }
                  }}
                  className="font-bold text-[#E07A5F] hover:underline"
                >
                  Resend Code
                </button>
                <button
                  type="button"
                  onClick={() => setStep('credentials')}
                  className="text-[#7A7D87] hover:underline"
                >
                  Change phone
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};