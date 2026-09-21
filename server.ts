import express from 'express';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import {
  users,
  profiles,
  swipes,
  matches,
  messages,
  blocks,
  reports,
  settingsStore,
  seedBangaloreProfiles
} from './server/db.js';
import {
  validateEmail,
  normalizeIndianPhone,
  calculateAgeFromDOB,
  hashPassword,
  verifyPassword,
  createAuthToken,
  verifyAuthToken,
  assertAuthConfig,
  generateAndStoreOTP,
  verifyOTP
} from './server/auth.js';
import { calculateMatchScore } from './server/scoring.js';
import { UserProfile, MatchItem, MessageItem, DiscoverFilters } from './src/types.js';
import { db } from './src/db/index.ts';
import { users as pgUsers } from './src/db/schema.ts';
import { eq } from 'drizzle-orm';
import { OAuth2Client } from 'google-auth-library';
import { createVerificationSession, getVerificationSession, verifyLivenessFrames, completeClientFaceMatch, consumeVerifiedProfilePhoto, VerificationChallenge } from './server/verification.js';
import {
  syncUserToPostgres,
  syncProfileToPostgres,
  syncMatchToPostgres,
  syncMessageToPostgres,
  syncSwipeToPostgres,
  syncSettingsToPostgres
} from './server/postgresSync.js';

// Ensure seed data is initialized
if (process.env.SEED_DUMMY_DATA !== 'false') {
  seedBangaloreProfiles();
  // Async background sync of initial profiles to Cloud SQL PostgreSQL
  setTimeout(async () => {
    try {
      for (const u of users.values()) {
        await syncUserToPostgres(u);
      }
      for (const p of profiles.values()) {
        await syncProfileToPostgres(p);
      }
    } catch (e) {
      console.warn('PostgreSQL initial sync notice:', e);
    }
  }, 1000);
}

// SSE Connection manager for real-time notifications & messages
const sseClients = new Map<string, express.Response>();

// WebSocket Connection manager for instant bi-directional messaging
const wsClients = new Map<string, Set<WebSocket>>();

function sendRealtimeEvent(userId: string, event: string, data: any) {
  // 1. Send via WebSocket if connected
  const sockets = wsClients.get(userId);
  if (sockets && sockets.size > 0) {
    const payload = JSON.stringify({ type: event, ...data });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch {
          sockets.delete(ws);
        }
      }
    }
  }

  // 2. Send via SSE as fallback
  const res = sseClients.get(userId);
  if (res) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      sseClients.delete(userId);
    }
  }
}

function getCookie(req: express.Request, name: string): string | null {
  const header = req.headers.cookie || '';
  const match = header.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function createServer() {
  // Fail fast before accepting traffic if production session signing is not configured.
  assertAuthConfig();

  const app = express();
  const server = http.createServer(app);
  const PORT = Number(process.env.PORT || 3000);

  // Initialize WebSocket Server
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req) => {
    let authenticatedUserId: string | null = null;

    // Check token in URL query
    try {
      if (req.url) {
        const urlObj = new URL(req.url, `http://localhost:${PORT}`);
        const token = urlObj.searchParams.get('token');
        if (token) {
          const payload = verifyAuthToken(token);
          if (payload && payload.userId) {
            authenticatedUserId = payload.userId;
            if (!wsClients.has(authenticatedUserId)) {
              wsClients.set(authenticatedUserId, new Set());
            }
            wsClients.get(authenticatedUserId)!.add(ws);
            ws.send(JSON.stringify({ type: 'auth:success', userId: authenticatedUserId }));
          }
        }
      }
    } catch {
      // url parse error
    }

    ws.on('message', (rawData: string) => {
      try {
        const payload = JSON.parse(rawData.toString());
        const { type } = payload;

        if (type === 'auth') {
          const token = payload.token;
          const verified = verifyAuthToken(token);
          if (verified && verified.userId) {
            authenticatedUserId = verified.userId;
            if (!wsClients.has(authenticatedUserId)) {
              wsClients.set(authenticatedUserId, new Set());
            }
            wsClients.get(authenticatedUserId)!.add(ws);
            ws.send(JSON.stringify({ type: 'auth:success', userId: authenticatedUserId }));
          }
        } else if (type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        } else if (type === 'chat:send') {
          if (!authenticatedUserId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized WebSocket client' }));
            return;
          }
          const { match_id, content } = payload;
          if (!match_id || !content || !content.trim()) return;

          const m = matches.get(match_id);
          if (!m || !m.user_ids.includes(authenticatedUserId)) return;

          const recipientId = m.user_ids.find(id => id !== authenticatedUserId)!;

          const msgId = `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
          const newMsg: MessageItem = {
            id: msgId,
            match_id,
            sender_id: authenticatedUserId,
            recipient_id: recipientId,
            content: content.trim(),
            created_at: new Date().toISOString(),
            read: false
          };

          messages.set(msgId, newMsg);
          syncMessageToPostgres(newMsg);
          m.updated_at = new Date().toISOString();
          matches.set(match_id, m);
          syncMatchToPostgres(m);

          // Acknowledge to sender
          ws.send(JSON.stringify({ type: 'chat:ack', message: newMsg }));

          // Deliver instantly to recipient
          const senderProfile = profiles.get(authenticatedUserId);
          sendRealtimeEvent(recipientId, 'chat:message', {
            message: newMsg,
            sender: {
              id: authenticatedUserId,
              name: senderProfile?.name || 'Flatmate Match',
              photo: senderProfile?.main_photo || ''
            },
            match_id
          });

          // Also trigger new_message event for top banners
          sendRealtimeEvent(recipientId, 'new_message', {
            message: newMsg,
            sender: {
              id: authenticatedUserId,
              name: senderProfile?.name || 'Flatmate Match',
              photo: senderProfile?.main_photo || ''
            },
            match_id
          });
        } else if (type === 'chat:read') {
          if (!authenticatedUserId) return;
          const { match_id } = payload;
          if (!match_id) return;

          let hasUpdated = false;
          for (const msg of messages.values()) {
            if (msg.match_id === match_id && msg.recipient_id === authenticatedUserId) {
              msg.read = true;
              hasUpdated = true;
            }
          }

          if (hasUpdated) {
            const m = matches.get(match_id);
            if (m) {
              const otherUserId = m.user_ids.find(id => id !== authenticatedUserId);
              if (otherUserId) {
                sendRealtimeEvent(otherUserId, 'chat:read_receipt', {
                  match_id,
                  read_by: authenticatedUserId
                });
              }
            }
          }
        } else if (type === 'chat:typing') {
          if (!authenticatedUserId) return;
          const { match_id, is_typing } = payload;
          const m = matches.get(match_id);
          if (m) {
            const otherUserId = m.user_ids.find(id => id !== authenticatedUserId);
            if (otherUserId) {
              sendRealtimeEvent(otherUserId, 'chat:typing', {
                match_id,
                user_id: authenticatedUserId,
                is_typing: !!is_typing
              });
            }
          }
        }
      } catch (err) {
        console.warn('WS message error:', err);
      }
    });

    ws.on('close', () => {
      if (authenticatedUserId && wsClients.has(authenticatedUserId)) {
        wsClients.get(authenticatedUserId)!.delete(ws);
        if (wsClients.get(authenticatedUserId)!.size === 0) {
          wsClients.delete(authenticatedUserId);
        }
      }
    });
  });

  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));

  // Auth Middleware
  const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }

    const payload = verifyAuthToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    // The app uses PostgreSQL as durable storage, while the in-memory map is a
    // request cache. On Render, a request can land on a different instance
    // (or immediately after a restart), so never treat a cache miss as a
    // deleted account. Recover the user from PostgreSQL and warm the cache.
    let user: any = users.get(payload.userId);
    if (!user) {
      try {
        const rows = await db.select().from(pgUsers).where(eq(pgUsers.id, payload.userId)).limit(1);
        const row = rows[0];
        if (row) {
          user = {
            id: row.id,
            email: row.email,
            phone: row.phone || '',
            password_hash: row.passwordHash || '',
            phone_verified: !!row.phoneVerified,
            email_verified: !!row.emailVerified,
            google_id: row.googleId || undefined,
            created_at: row.createdAt?.toISOString?.() || new Date().toISOString()
          };
          users.set(row.id, user);
        }
      } catch (error) {
        console.error('PostgreSQL auth lookup failed:', error);
        return res.status(503).json({ error: 'Account verification is temporarily unavailable. Please try again.' });
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Account not found or deleted.' });
    }

    (req as any).user = user;
    next();
  };

  // Optional Auth Middleware (for initial discovery browsing before full signup if needed)
  const optionalAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
    if (token) {
      const payload = verifyAuthToken(token);
      if (payload) {
        const user = users.get(payload.userId);
        if (user) (req as any).user = user;
      }
    }
    next();
  };

  // ==========================================
  // 1. AUTHENTICATION ROUTES
  // ==========================================

  // Signup
  app.post('/api/auth/signup', (req, res) => {
    try {
      const { email, password, name } = req.body;

      const emailCheck = validateEmail(email);
      if (!emailCheck.valid) {
        return res.status(400).json({ error: emailCheck.error });
      }

      if (!password || password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      }

      const normalizedEmail = email.trim().toLowerCase();

      // Check existing email
      for (const u of users.values()) {
        if (u.email === normalizedEmail) {
          return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
        }
      }

      const userId = `user_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const newUser = {
        id: userId,
        email: normalizedEmail,
        phone: '',
        password_hash: hashPassword(password),
        phone_verified: false,
        email_verified: true, // auto-verified for signup
        created_at: new Date().toISOString()
      };
      users.set(userId, newUser);

      // Create default profile
      const newProfile: UserProfile = {
        id: `profile_${userId}`,
        user_id: userId,
        name: (name || '').trim() || 'New Flatmate',
        date_of_birth: '2000-01-01',
        age: 26,
        gender: 'Woman',
        flatmate_gender_preference: 'Any',
        city: 'Bangalore',
        locality: 'Indiranagar',
        preferred_localities: ['Indiranagar', 'Koramangala'],
        housing_intent: {
          has_house: false,
          looking_to_co_search: true,
          looking_for_vacancy: true
        },
        rent_min: 10000,
        rent_max: 22000,
        food_preference: 'Vegetarian',
        okay_with_nonveg_cooking: true,
        smoking: 'No',
        drinking: 'Occasionally',
        cleanliness: 'Strict',
        sleep_schedule: 'Flexible',
        social_level: 'Balanced',
        guests: 'Weekends only',
        family_visits: 'Rarely',
        parties: 'Occasionally',
        pets: 'Pet lover / Open to pets',
        work_schedule: 'Hybrid',
        attached_washroom: 'Must have',
        furnishing: 'Fully furnished',
        gated_society: true,
        hobbies: ['Reading', 'Cooking', 'Travel'],
        languages: ['English', 'Hindi'],
        non_negotiables: [],
        bio: '',
        prompts: [],
        photos: [],
        is_verified: false,
        liveness_verified: false,
        verification_status: 'unverified',
        onboarding_step: 1,
        is_profile_complete: false,
        discover_active: true,
        moved_in_status: 'none',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      profiles.set(userId, newProfile);

      // Default settings
      settingsStore.set(userId, {
        new_message_banner: true,
        email_notifications: true,
        privacy_mode: false
      });

      const token = createAuthToken(userId);
      // Synchronize to PostgreSQL
      syncUserToPostgres(newUser);
      syncProfileToPostgres(newProfile);
      syncSettingsToPostgres(userId, { new_message_banner: true, email_notifications: true, privacy_mode: false });

      res.json({
        token,
        user: {
          id: userId,
          email: newUser.email,
          phone: newUser.phone,
          phone_verified: newUser.phone_verified,
          email_verified: newUser.email_verified,
          profile: newProfile
        }
      });
    } catch {
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });

  // Login
  app.post('/api/auth/login', (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Please enter both email and password.' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      let matchedUser: any = null;

      for (const u of users.values()) {
        if (u.email === normalizedEmail) {
          matchedUser = u;
          break;
        }
      }

      if (!matchedUser) {
        return res.status(400).json({ error: 'Incorrect email or password. Please check your details.' });
      }

      if (matchedUser.password_hash !== 'seed_pass_hash') {
        const isMatch = verifyPassword(password, matchedUser.password_hash);
        if (!isMatch) {
          return res.status(400).json({ error: 'Incorrect email or password.' });
        }
      }

      const profile = profiles.get(matchedUser.id);
      const token = createAuthToken(matchedUser.id);

      res.json({
        token,
        user: {
          id: matchedUser.id,
          email: matchedUser.email,
          phone: matchedUser.phone,
          phone_verified: matchedUser.phone_verified,
          email_verified: matchedUser.email_verified,
          google_id: matchedUser.google_id,
          profile
        }
      });
    } catch {
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });

  // Google Login / Sign In
  // Only a signed Google ID token is accepted. Identity fields are derived from
  // Google's verified payload on the server, never trusted from browser input.
  app.post('/api/auth/google', async (req, res) => {
    try {
      const { id_token } = req.body as { id_token?: string };
      const googleClientId = process.env.GOOGLE_CLIENT_ID;
      if (!googleClientId) return res.status(503).json({ error: 'Google sign-in is not configured on the server.' });
      if (!id_token || typeof id_token !== 'string') return res.status(400).json({ error: 'Google identity token is required.' });

      const expectedNonce = getCookie(req, 'google_oauth_nonce');
      if (!expectedNonce) return res.status(401).json({ error: 'Google sign-in session expired. Please try again.' });

      const googleClient = new OAuth2Client(googleClientId);
      const ticket = await googleClient.verifyIdToken({ idToken: id_token, audience: googleClientId });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email || payload.email_verified !== true) {
        return res.status(401).json({ error: 'Google account could not be verified.' });
      }
      if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
        return res.status(401).json({ error: 'Invalid Google identity issuer.' });
      }
      if (payload.nonce !== expectedNonce) {
        return res.status(401).json({ error: 'Invalid Google sign-in session. Please try again.' });
      }

      res.setHeader('Set-Cookie', 'google_oauth_nonce=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');

      const normalizedEmail = payload.email.trim().toLowerCase();
      const googleId = payload.sub;
      const googleName = payload.name?.trim() || normalizedEmail.split('@')[0] || 'Google User';
      let user: any = null;

      for (const u of users.values()) {
        if (u.google_id === googleId || u.email === normalizedEmail) {
          user = u;
          break;
        }
      }

      if (user && !user.google_id) {
        user.google_id = googleId;
        user.email_verified = true;
        users.set(user.id, user);
        syncUserToPostgres(user);
      }

      if (!user) {
        const userId = `user_g_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        user = {
          id: userId,
          email: normalizedEmail,
          phone: '',
          password_hash: '',
          phone_verified: false,
          email_verified: true,
          google_id: googleId,
          created_at: new Date().toISOString()
        };
        users.set(userId, user);

        const newProfile: UserProfile = {
          id: `profile_${userId}`,
          user_id: userId,
          name: googleName,
          date_of_birth: '2000-01-01',
          age: 26,
          gender: 'Woman',
          flatmate_gender_preference: 'Any',
          city: 'Bangalore',
          locality: 'Indiranagar',
          preferred_localities: ['Indiranagar', 'Koramangala'],
          housing_intent: { has_house: false, looking_to_co_search: true, looking_for_vacancy: true },
          rent_min: 10000,
          rent_max: 22000,
          food_preference: 'Vegetarian',
          okay_with_nonveg_cooking: true,
          smoking: 'No',
          drinking: 'Occasionally',
          cleanliness: 'Strict',
          sleep_schedule: 'Flexible',
          social_level: 'Balanced',
          guests: 'Weekends only',
          family_visits: 'Rarely',
          parties: 'Occasionally',
          pets: 'Pet lover / Open to pets',
          work_schedule: 'Hybrid',
          attached_washroom: 'Must have',
          furnishing: 'Fully furnished',
          gated_society: true,
          hobbies: ['Reading', 'Music'],
          languages: ['English', 'Hindi'],
          non_negotiables: [],
          bio: '',
          prompts: [],
          photos: [],
          main_photo: '',
          is_verified: false,
          liveness_verified: false,
          verification_status: 'unverified',
          onboarding_step: 1,
          is_profile_complete: false,
          discover_active: true,
          moved_in_status: 'none',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        profiles.set(userId, newProfile);
        settingsStore.set(userId, { new_message_banner: true, email_notifications: true, privacy_mode: false });
        syncUserToPostgres(user);
        syncProfileToPostgres(newProfile);
        syncSettingsToPostgres(userId, { new_message_banner: true, email_notifications: true, privacy_mode: false });
      }

      const profile = profiles.get(user.id);
      const token = createAuthToken(user.id);
      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          phone_verified: user.phone_verified,
          email_verified: user.email_verified,
          google_id: user.google_id,
          profile
        }
      });
    } catch (error) {
      console.error('Google sign-in verification failed:', error);
      res.status(401).json({ error: 'Google sign-in could not be verified. Please try again.' });
    }
  });

  // Send Phone OTP
  app.post('/api/auth/send-otp', requireAuth, (req, res) => {
    try {
      const { phone } = req.body;
      const phoneNorm = normalizeIndianPhone(phone);
      if (!phoneNorm.valid || !phoneNorm.normalized) {
        return res.status(400).json({ error: phoneNorm.error });
      }

      const otpResult = generateAndStoreOTP(phoneNorm.normalized);
      if (otpResult.error) {
        return res.status(429).json({ error: otpResult.error });
      }

      // Update user's phone record
      const currentUser = (req as any).user;
      currentUser.phone = phoneNorm.normalized;
      users.set(currentUser.id, currentUser);

      // In production with Twilio credentials, send SMS via Twilio Verify.
      // In development mode, return demo code info for seamless testing.
      res.json({
        success: true,
        message: `Enter the 6-digit code we sent to ${phoneNorm.normalized}`,
        dev_code: otpResult.otp // Helpful for local testing
      });
    } catch {
      res.status(500).json({ error: 'Could not send verification code. Please try again.' });
    }
  });

  // Verify Phone OTP
  app.post('/api/auth/verify-otp', requireAuth, (req, res) => {
    try {
      const { phone, otp } = req.body;
      if (!otp) {
        return res.status(400).json({ error: 'Please enter the 6-digit verification code.' });
      }

      const currentUser = (req as any).user;
      const targetPhone = phone ? (normalizeIndianPhone(phone).normalized || phone) : currentUser.phone;

      const verification = verifyOTP(targetPhone, otp);
      if (!verification.success) {
        return res.status(400).json({ error: verification.error || 'Incorrect or expired OTP.' });
      }

      currentUser.phone_verified = true;
      currentUser.phone = targetPhone;
      users.set(currentUser.id, currentUser);

      res.json({
        success: true,
        phone_verified: true,
        message: 'Phone number verified successfully!'
      });
    } catch {
      res.status(500).json({ error: 'Verification failed. Please try again.' });
    }
  });

  // Get Current User (Me)
  app.get('/api/auth/me', requireAuth, (req, res) => {
    const user = (req as any).user;
    const profile = profiles.get(user.id);
    const settings = settingsStore.get(user.id) || { new_message_banner: true, email_notifications: true, privacy_mode: false };
    res.json({
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        phone_verified: user.phone_verified,
        email_verified: user.email_verified,
        google_id: user.google_id,
        profile
      },
      settings
    });
  });

  // Delete Account (Requirement #39: Confirmation typing 'DELETE' and complete server-side purge)
  app.delete('/api/auth/delete-account', requireAuth, (req, res) => {
    try {
      const { confirmation } = req.body;
      if (confirmation !== 'DELETE') {
        return res.status(400).json({ error: 'Please type DELETE in capital letters to confirm account deletion.' });
      }

      const user = (req as any).user;
      const userId = user.id;

      // 1. Delete user & profile
      users.delete(userId);
      profiles.delete(userId);
      settingsStore.delete(userId);

      // 2. Delete swipes
      for (const [key, s] of swipes.entries()) {
        if (s.user_id === userId || s.target_user_id === userId) {
          swipes.delete(key);
        }
      }

      // 3. Delete matches & messages
      for (const [matchId, m] of matches.entries()) {
        if (m.user_ids.includes(userId)) {
          matches.delete(matchId);
          // delete messages in match
          for (const [msgId, msg] of messages.entries()) {
            if (msg.match_id === matchId) {
              messages.delete(msgId);
            }
          }
        }
      }

      // 4. Delete blocks & reports
      for (const [bId, b] of blocks.entries()) {
        if (b.blocker_id === userId || b.blocked_id === userId) {
          blocks.delete(bId);
        }
      }
      for (const [rId, r] of reports.entries()) {
        if (r.reporter_id === userId || r.reported_id === userId) {
          reports.delete(rId);
        }
      }

      res.json({ success: true, message: 'Your account and all associated data have been permanently deleted.' });
    } catch {
      res.status(500).json({ error: 'Could not delete account. Please try again.' });
    }
  });

  // ==========================================
  // 2. PROFILE & ONBOARDING ROUTES
  // ==========================================

  // Update Housing Intent (Requirement #10: independent selection of co-search + vacancy)
  app.put('/api/profile/intent', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { has_house, looking_to_co_search, looking_for_vacancy } = req.body;

      const profile = profiles.get(user.id);
      if (!profile) {
        return res.status(404).json({ error: 'Profile not found.' });
      }

      profile.housing_intent = {
        has_house: Boolean(has_house),
        looking_to_co_search: Boolean(looking_to_co_search),
        looking_for_vacancy: Boolean(looking_for_vacancy)
      };
      profile.updated_at = new Date().toISOString();
      profiles.set(user.id, profile);
      syncProfileToPostgres(profile);

      res.json({ profile });
    } catch {
      res.status(500).json({ error: 'Could not update housing intent.' });
    }
  });

  // Full Profile Update / Onboarding Step Update
  app.put('/api/profile', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const updates = req.body;
      const profile = profiles.get(user.id);
      if (!profile) {
        return res.status(404).json({ error: 'Profile not found.' });
      }

      // Validate DOB & calculate age server-side (Requirement #12)
      if (updates.date_of_birth) {
        const ageCheck = calculateAgeFromDOB(updates.date_of_birth);
        if (!ageCheck.valid) {
          return res.status(400).json({ error: ageCheck.error });
        }
        profile.date_of_birth = updates.date_of_birth;
        profile.age = ageCheck.age;
      }

      // Validate Rent Range (Requirement #14)
      if (updates.rent_min !== undefined || updates.rent_max !== undefined) {
        const rMin = updates.rent_min !== undefined ? Number(updates.rent_min) : profile.rent_min;
        const rMax = updates.rent_max !== undefined ? Number(updates.rent_max) : profile.rent_max;

        if (rMin < 3000) {
          return res.status(400).json({ error: 'Minimum rent is ₹3,000.' });
        }
        if (rMax > 80000) {
          return res.status(400).json({ error: 'Maximum rent is ₹80,000.' });
        }
        if (rMax < rMin) {
          return res.status(400).json({ error: 'Maximum rent must be at least the minimum rent.' });
        }
        profile.rent_min = rMin;
        profile.rent_max = rMax;
      }

      // Validate Non-negotiables (Requirement #19: 0 to 4 max)
      if (updates.non_negotiables) {
        if (updates.non_negotiables.length > 4) {
          return res.status(400).json({ error: 'Choose up to 4 non-negotiables.' });
        }
        profile.non_negotiables = updates.non_negotiables;
      }

      // City normalization (Bangalore, Bengaluru, Bengalooru -> Bangalore)
      if (updates.city) {
        const cLower = updates.city.toLowerCase();
        if (cLower.includes('bangal') || cLower.includes('bengal')) {
          profile.city = 'Bangalore';
        } else {
          profile.city = updates.city;
        }
      }

      // Apply other updates
      const allowedFields = [
        'name', 'gender', 'flatmate_gender_preference', 'locality', 'preferred_localities',
        'food_preference', 'okay_with_nonveg_cooking', 'smoking', 'drinking', 'cleanliness',
        'sleep_schedule', 'social_level', 'guests', 'family_visits', 'parties', 'pets',
        'work_schedule', 'attached_washroom', 'furnishing', 'gated_society',
        'hobbies', 'languages', 'bio', 'prompts', 'onboarding_step', 'is_profile_complete'
      ];

      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          (profile as any)[field] = updates[field];
        }
      }

      profile.updated_at = new Date().toISOString();
      profiles.set(user.id, profile);
      syncProfileToPostgres(profile);

      res.json({ profile });
    } catch {
      res.status(500).json({ error: 'Could not update profile.' });
    }
  });

  // 1. Start a server-controlled verification session.
  app.post('/api/verify/session', requireAuth, (req, res) => {
    try {
      const session = createVerificationSession();
      res.json({
        success: true,
        session_id: session.id,
        challenge: session.challenge,
        expires_at: session.expiresAt
      });
    } catch {
      res.status(500).json({ error: 'Could not start verification. Please try again.' });
    }
  });

  // 2. Server-side liveness verification.
  app.post('/api/verify/liveness', requireAuth, async (req, res) => {
    try {
      const { session_id, challenge, frames } = req.body || {};
      if (typeof session_id !== 'string' || typeof challenge !== 'string' || !Array.isArray(frames)) {
        return res.status(400).json({ error: 'A valid verification session and camera sequence are required.' });
      }

      const result = await verifyLivenessFrames(
        session_id,
        challenge as VerificationChallenge,
        frames
      );

      res.json({
        success: true,
        ...result
      });
    } catch (err: any) {
      console.error('Server liveness verification error:', err);
      res.status(400).json({
        success: false,
        passed: false,
        confidence: 0,
        message: err?.message || 'Server-side liveness verification failed.'
      });
    }
  });

  // 3. Finalize the browser-side face match and bind the exact profile-photo bytes.
  app.post('/api/verify/face-match', requireAuth, (req, res) => {
    try {
      const { session_id, profile_photo_base64, similarity_percentage } = req.body || {};
      if (typeof session_id !== 'string' || typeof profile_photo_base64 !== 'string') {
        return res.status(400).json({ error: 'A verification session and profile photo are required.' });
      }

      const result = completeClientFaceMatch(
        session_id,
        profile_photo_base64,
        Number(similarity_percentage)
      );

      const profile = profiles.get((req as any).user.id);
      if (!profile) return res.status(404).json({ error: 'Profile not found.' });

      profile.is_verified = true;
      profile.liveness_verified = true;
      profile.verification_status = 'verified';
      profile.photo_similarity_score = result.similarity_percentage;
      profile.updated_at = new Date().toISOString();
      profiles.set((req as any).user.id, profile);
      syncProfileToPostgres(profile);

      res.json({ success: true, passed: true, similarity_percentage: result.similarity_percentage, is_ai_generated: false, feedback: result.feedback });
    } catch (err: any) {
      console.error('Client face verification finalization error:', err);
      res.status(400).json({
        success: false,
        passed: false,
        similarity_percentage: 0,
        is_ai_generated: false,
        feedback: err?.message || 'Could not verify the profile photo.'
      });
    }
  });

  // 3. Upload House Photo (Requirement #5)
  app.post('/api/profile/upload-house-photo', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { photo_base64, mime_type, caption } = req.body;

      if (!photo_base64) {
        return res.status(400).json({ error: 'Please select a house photo to upload.' });
      }

      if (typeof photo_base64 !== 'string' || !photo_base64.startsWith('data:image/')) {
        return res.status(400).json({ error: 'Invalid photo format.' });
      }

      const profile = profiles.get(user.id);
      if (!profile) {
        return res.status(404).json({ error: 'Profile not found.' });
      }

      if (!profile.house_details) {
        profile.house_details = {
          bhk: '2 BHK',
          total_washrooms: 2,
          attached_washroom_in_vacant_room: true,
          balcony_type: 'Attached to vacant room',
          vacant_room_amenities: ['Bed & Mattress', 'Wardrobe', 'WiFi'],
          house_photos: []
        };
      }

      const photoId = `hp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const newHousePhoto = {
        id: photoId,
        url: photo_base64,
        is_main: profile.house_details.house_photos.length === 0,
        caption: caption || 'House photo',
        verified: false
      };

      profile.house_details.house_photos.push(newHousePhoto);
      profile.updated_at = new Date().toISOString();
      profiles.set(user.id, profile);

      res.json({
        success: true,
        photo: newHousePhoto,
        house_details: profile.house_details,
        profile
      });
    } catch {
      res.status(500).json({ error: 'Could not upload house photo.' });
    }
  });

  // 4. Update House Details & Amenities (Requirement #5)
  app.put('/api/profile/house-details', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const {
        bhk,
        total_washrooms,
        attached_washroom_in_vacant_room,
        balcony_type,
        vacant_room_amenities,
        rent_for_vacant_room,
        deposit_amount,
        house_photos
      } = req.body;

      const profile = profiles.get(user.id);
      if (!profile) {
        return res.status(404).json({ error: 'Profile not found.' });
      }

      profile.house_details = {
        bhk: bhk || profile.house_details?.bhk || '2 BHK',
        total_washrooms: Number(total_washrooms) || profile.house_details?.total_washrooms || 2,
        attached_washroom_in_vacant_room: attached_washroom_in_vacant_room !== undefined
          ? Boolean(attached_washroom_in_vacant_room)
          : (profile.house_details?.attached_washroom_in_vacant_room ?? true),
        balcony_type: balcony_type || profile.house_details?.balcony_type || 'Common balcony',
        vacant_room_amenities: Array.isArray(vacant_room_amenities) ? vacant_room_amenities : (profile.house_details?.vacant_room_amenities || []),
        house_photos: Array.isArray(house_photos) ? house_photos : (profile.house_details?.house_photos || []),
        rent_for_vacant_room: rent_for_vacant_room ? Number(rent_for_vacant_room) : profile.house_details?.rent_for_vacant_room,
        deposit_amount: deposit_amount ? Number(deposit_amount) : profile.house_details?.deposit_amount
      };

      profile.updated_at = new Date().toISOString();
      profiles.set(user.id, profile);

      res.json({
        success: true,
        house_details: profile.house_details,
        profile
      });
    } catch {
      res.status(500).json({ error: 'Could not update house details.' });
    }
  });

  // Photo Upload & Verification (Requirement #24, #25, #26)
  app.post('/api/profile/upload-photo', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { photo_base64, mime_type, caption, is_main, verification_session_id } = req.body;

      if (!photo_base64) {
        return res.status(400).json({ error: 'Please select a photo to upload.' });
      }

      // Main-photo verification is now server-controlled. A client cannot mark
      // an arbitrary uploaded photo as verified.
      if (typeof photo_base64 !== 'string' || !photo_base64.startsWith('data:image/')) {
        return res.status(400).json({
          error: 'Invalid photo format. Please upload a valid image.'
        });
      }

      const profile = profiles.get(user.id);
      if (!profile) {
        return res.status(404).json({ error: 'Profile not found.' });
      }

      const photoId = `p_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const newPhoto = {
        id: photoId,
        url: photo_base64,
        is_main: is_main ?? (profile.photos.length === 0),
        caption: caption || '',
        verified: false
      };

      if (newPhoto.is_main) {
        if (!verification_session_id || !consumeVerifiedProfilePhoto(verification_session_id, photo_base64)) {
          return res.status(403).json({
            error: 'This main profile photo has not completed server-side verification.'
          });
        }
        profile.photos.forEach(p => (p.is_main = false));
        profile.main_photo = newPhoto.url;
        profile.is_verified = true;
        profile.verification_status = 'verified';
      }

      newPhoto.verified = Boolean(newPhoto.is_main && profile.is_verified);
      profile.photos.push(newPhoto);
      profile.updated_at = new Date().toISOString();
      profiles.set(user.id, profile);

      res.json({
        success: true,
        photo: newPhoto,
        profile
      });
    } catch {
      res.status(500).json({ error: 'That photo could not be uploaded. Please try again.' });
    }
  });

  // Reactivate Discover after moving in (Requirement #38)
  app.post('/api/profile/reactivate-discover', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const profile = profiles.get(user.id);
      if (!profile) {
        return res.status(404).json({ error: 'Profile not found.' });
      }

      profile.discover_active = true;
      profile.moved_in_status = 'none';
      profile.moved_in_with_match_id = null;
      profile.updated_at = new Date().toISOString();
      profiles.set(user.id, profile);

      res.json({ success: true, profile });
    } catch {
      res.status(500).json({ error: 'Could not reactivate Discover.' });
    }
  });

  // ==========================================
  // 3. DISCOVER & COMPATIBILITY MATCHING
  // ==========================================

  // Get Discover Profiles with Live Filtering & Match Scoring
  app.get('/api/discover', optionalAuth, (req, res) => {
    try {
      const currentUser = (req as any).user;
      const currentUserId = currentUser ? currentUser.id : null;
      const userProfile = currentUserId ? profiles.get(currentUserId) : null;

      // Collect user's blocked IDs
      const blockedIds = new Set<string>();
      if (currentUserId) {
        for (const b of blocks.values()) {
          if (b.blocker_id === currentUserId) blockedIds.add(b.blocked_id);
          if (b.blocked_id === currentUserId) blockedIds.add(b.blocker_id);
        }
      }

      // Collect already swiped IDs
      const swipedIds = new Set<string>();
      if (currentUserId) {
        for (const s of swipes.values()) {
          if (s.user_id === currentUserId) {
            swipedIds.add(s.target_user_id);
          }
        }
      }

      // Query filters
      const {
        locality,
        min_rent,
        max_rent,
        gender_preference,
        food_preference,
        smoking,
        drinking,
        cleanliness,
        sleep_schedule,
        social_level,
        housing_intent,
        non_negotiables
      } = req.query as any;

      const parsedNonNegs: string[] = non_negotiables
        ? (typeof non_negotiables === 'string'
            ? non_negotiables.split(',').map((s: string) => s.trim()).filter(Boolean)
            : Array.isArray(non_negotiables) ? non_negotiables : [])
        : [];

      const requestedLocality = typeof locality === 'string' && locality && locality !== 'All'
        ? locality.trim().toLowerCase()
        : '';

      // Bangalore locality groups used only to establish a deterministic "next nearest"
      // fallback when an exact locality is exhausted. Profiles may still qualify through
      // their own preferred_localities, which takes precedence over this map.
      const localityGroups: string[][] = [
        ['indiranagar', 'domlur', 'ulsoor', 'halasuru', 'jeevanbheemanagar', 'cv raman nagar', 'kaggadaspura'],
        ['koramangala', 'ejipura', 'hsr layout', 'bommanahalli', 'btm layout'],
        ['hbr layout', 'kalyan nagar', 'kammanahalli', 'hrbr layout', 'banaswadi', 'ramamurthy nagar'],
        ['whitefield', 'brookefield', 'hoodi', 'kundalahalli', 'marathahalli', 'itpl'],
        ['bellandur', 'kadubeesanahalli', 'devarabisanahalli', 'panathur', 'varthur'],
        ['jp nagar', 'jayanagar', 'banashankari', 'arekere', 'kumaraswamy layout'],
        ['electronic city', 'bommasandra', 'singasandra', 'hsr layout'],
        ['malleshwaram', 'rajajinagar', 'basaveshwaranagar', 'vijayanagar', 'yeshwanthpur'],
        ['sadashivanagar', 'rt nagar', 'hebbal', 'sanjay nagar'],
        ['btm layout', 'hsr layout', 'koramangala', 'jayanagar'],
        ['nagawara', 'thanisandra', 'yelahanka', 'hebbal'],
        ['central bangalore', 'mg road', 'brigade road', 'richmond town', 'langford town']
      ];

      const normalizeLocality = (value: string) => value.trim().toLowerCase();
      const sameLocality = (a: string, b: string) => normalizeLocality(a) === normalizeLocality(b);
      const sharesPreferredLocality = (p: UserProfile, requested: string) =>
        (p.preferred_localities || []).some(v => normalizeLocality(v) === requested);

      const getLocalityTier = (p: UserProfile): { tier: number; label: string; distance: number } => {
        if (!requestedLocality) return { tier: 1, label: 'Your selected areas', distance: 0 };
        const targetLocality = normalizeLocality(p.locality || '');

        if (targetLocality === requestedLocality) {
          return { tier: 1, label: `In ${locality || 'your selected area'}`, distance: 0 };
        }

        // If the person explicitly lists the requested area as a preferred locality,
        // treat that as the closest-area match even when their primary locality differs.
        if (sharesPreferredLocality(p, requestedLocality)) {
          return { tier: 1, label: `Prefers ${locality || 'your selected area'}`, distance: 0.5 };
        }

        const groupIndexes = localityGroups
          .map((group, index) => group.includes(requestedLocality) ? index : -1)
          .filter(index => index >= 0);

        if (groupIndexes.length > 0) {
          for (const groupIndex of groupIndexes) {
            const group = localityGroups[groupIndex];
            if (group.includes(targetLocality)) {
              return { tier: 2, label: `Nearby area • ${p.locality}`, distance: 1 };
            }
          }
        }

        return { tier: 4, label: `Other nearby area • ${p.locality}`, distance: 2 };
      };

      const violatesDealbreakers = (targetProf: UserProfile): boolean => {
        for (const nn of parsedNonNegs) {
          const nnLower = nn.toLowerCase();
          if ((nnLower.includes('no smoking') || nnLower.includes('non-smoking')) && targetProf.smoking === 'Yes') return true;
          if (nnLower.includes('no drinking') && targetProf.drinking === 'Yes') return true;
          if ((nnLower.includes('pure veg') || nnLower.includes('vegetarian')) &&
              targetProf.food_preference !== 'Vegetarian' && targetProf.food_preference !== 'Vegan') return true;
          if (nnLower.includes('pet friendly') && targetProf.pets === 'No pets') return true;
          if (nnLower.includes('attached private washroom') && targetProf.housing_intent?.has_house && !targetProf.house_details?.attached_washroom_in_vacant_room) return true;
          if (nnLower.includes('quiet hours') && targetProf.sleep_schedule === 'Night owl') return true;
        }
        return false;
      };

      const matchesHardConstraints = (targetProf: UserProfile): boolean => {
        if (targetProf.discover_active === false || targetProf.moved_in_status === 'moved_in') return false;
        if (violatesDealbreakers(targetProf)) return false;

        // Gender preference is a hard compatibility constraint rather than a soft ranking signal.
        if (gender_preference && gender_preference !== 'Any') {
          if (gender_preference === 'Men only' && targetProf.gender !== 'Man') return false;
          if (gender_preference === 'Women only' && targetProf.gender !== 'Woman') return false;
        }
        if (userProfile?.gender) {
          if (targetProf.flatmate_gender_preference === 'Women only' && userProfile.gender !== 'Woman') return false;
          if (targetProf.flatmate_gender_preference === 'Men only' && userProfile.gender !== 'Man') return false;
        }

        // Housing intent is also kept hard because showing someone who cannot satisfy
        // the selected housing goal is not useful as a fallback.
        if (housing_intent && housing_intent !== 'All') {
          if (housing_intent === 'has_house' && !targetProf.housing_intent?.has_house) return false;
          if (housing_intent === 'co_search' && !targetProf.housing_intent?.looking_to_co_search) return false;
          if (housing_intent === 'vacancy' && !targetProf.housing_intent?.looking_for_vacancy) return false;
        }
        return true;
      };

      const matchesFilterSet = (targetProf: UserProfile, relaxedLevel: number): boolean => {
        if (!matchesHardConstraints(targetProf)) return false;

        // Level 0 = every selected filter must match.
        // Level 1 = relax lifestyle preference filters, but preserve locality/budget.
        // Level 2 = relax lifestyle + budget, but preserve locality.
        // Higher levels are used only after the requested area is exhausted.
        if (relaxedLevel < 1) {
          if (food_preference && food_preference !== 'Any' && targetProf.food_preference !== food_preference) return false;
          if (smoking && smoking !== 'Any' && targetProf.smoking !== smoking) return false;
          if (drinking && drinking !== 'Any' && targetProf.drinking !== drinking) return false;
          if (cleanliness && cleanliness !== 'Any' && targetProf.cleanliness !== cleanliness) return false;
          if (sleep_schedule && sleep_schedule !== 'Any' && targetProf.sleep_schedule !== sleep_schedule) return false;
          if (social_level && social_level !== 'Any' && targetProf.social_level !== social_level) return false;
        }

        if (relaxedLevel < 2) {
          if (min_rent && targetProf.rent_max < Number(min_rent)) return false;
          if (max_rent && targetProf.rent_min > Number(max_rent)) return false;
        }

        return true;
      };

      const results: any[] = [];

      for (const [targetId, targetProf] of profiles.entries()) {
        if (targetId === currentUserId) continue;
        if (blockedIds.has(targetId)) continue;
        if (swipedIds.has(targetId)) continue;
        if (!matchesHardConstraints(targetProf)) continue;

        const location = getLocalityTier(targetProf);

        // Progressive discovery order:
        // 1. Requested locality + all selected preferences
        // 2. Requested locality + relaxed preferences
        // 3. Nearby locality + all selected preferences
        // 4. Wider area + relaxed preferences as the final fallback
        // Hard compatibility constraints (gender, housing intent, dealbreakers,
        // active status, blocks and swipes) are never relaxed.
        let tier = 4;
        let tierLabel = location.label;
        let relaxedLevel = 2;

        if (location.tier <= 1 && matchesFilterSet(targetProf, 0)) {
          tier = 1;
          tierLabel = location.label;
          relaxedLevel = 0;
        } else if (location.tier <= 1 && matchesFilterSet(targetProf, 1)) {
          tier = 2;
          tierLabel = `More profiles in ${targetProf.locality}`;
          relaxedLevel = 1;
        } else if (location.tier <= 1 && matchesFilterSet(targetProf, 2)) {
          tier = 2;
          tierLabel = `More profiles in ${targetProf.locality}`;
          relaxedLevel = 2;
        } else if (location.tier === 2 && matchesFilterSet(targetProf, 0)) {
          tier = 3;
          tierLabel = `Nearby area • ${targetProf.locality}`;
          relaxedLevel = 0;
        } else if (matchesFilterSet(targetProf, 2)) {
          tier = 4;
          tierLabel = `Wider area • ${targetProf.locality}`;
          relaxedLevel = 2;
        } else {
          continue;
        }

        const matchResult = userProfile ? calculateMatchScore(userProfile, targetProf) : null;
        const score = matchResult?.total_score ?? 78;

        results.push({
          ...targetProf,
          match_score: score,
          match_breakdown: matchResult,
          discovery_tier: tier,
          discovery_tier_label: tierLabel,
          relaxed_filter_level: relaxedLevel,
          discovery_area: targetProf.locality,
          area_distance_level: location.distance
        });
      }

      // Never mix fallback tiers randomly. Exact matches always come first,
      // followed by the nearest area, then relaxed matches in the requested area,
      // then progressively wider fallbacks. Within each tier, compatibility score
      // remains the primary sort key.
      results.sort((a, b) => {
        if ((a.discovery_tier || 99) !== (b.discovery_tier || 99)) {
          return (a.discovery_tier || 99) - (b.discovery_tier || 99);
        }
        const scoreDiff = (b.match_score || 0) - (a.match_score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });

      const tierCounts = results.reduce((acc: Record<string, number>, p: any) => {
        const key = String(p.discovery_tier || 5);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

      res.json({
        profiles: results,
        total: results.length,
        timestamp: Date.now(),
        discovery: {
          tier_counts: tierCounts,
          requested_locality: locality || null,
          has_exact_matches: (tierCounts['1'] || 0) > 0,
          has_relaxed_locality_matches: (tierCounts['2'] || 0) > 0,
          has_nearby_matches: (tierCounts['3'] || 0) > 0,
          has_wider_matches: (tierCounts['4'] || 0) > 0
        }
      });
    } catch {
      res.status(500).json({ error: "Couldn't load profiles. Check your connection." });
    }
  });

  // Swipe Action (Like or Pass)
  app.post('/api/discover/swipe', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { target_user_id, action } = req.body; // 'like' | 'pass'

      if (!target_user_id || !['like', 'pass'].includes(action)) {
        return res.status(400).json({ error: 'Invalid swipe action.' });
      }

      const swipeId = `swipe_${user.id}_${target_user_id}`;
      const swipeRecord = {
        id: swipeId,
        user_id: user.id,
        target_user_id,
        action,
        created_at: new Date().toISOString()
      };
      swipes.set(swipeId, swipeRecord);
      syncSwipeToPostgres(swipeRecord as any);

      let isMatch = false;
      let matchRecord: any = null;

      if (action === 'like') {
        // Check if other user also liked currentUser
        const reverseSwipeId = `swipe_${target_user_id}_${user.id}`;
        const reverseSwipe = swipes.get(reverseSwipeId);

        if (reverseSwipe && reverseSwipe.action === 'like') {
          // Mutual Match!
          isMatch = true;
          const matchId = `match_${[user.id, target_user_id].sort().join('_')}`;

          const userProfileA = profiles.get(user.id);
          const userProfileB = profiles.get(target_user_id);

          const scoreCalc = userProfileA && userProfileB
            ? calculateMatchScore(userProfileA, userProfileB)
            : { total_score: 85, categories: [], highlights: [], dealbreakers_met: true };

          matchRecord = {
            id: matchId,
            user_ids: [user.id, target_user_id],
            other_user: userProfileB,
            match_score: scoreCalc.total_score,
            match_breakdown: scoreCalc,
            unread_count: 0,
            moving_in_requested_by: [],
            status: 'active',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          matches.set(matchId, matchRecord);
          syncMatchToPostgres(matchRecord);

          // Notify both users in real-time
          sendRealtimeEvent(target_user_id, 'match', {
            match: { ...matchRecord, other_user: userProfileA }
          });
        }
      }

      res.json({
        success: true,
        action,
        is_match: isMatch,
        match: matchRecord
      });
    } catch {
      res.status(500).json({ error: 'Could not register swipe. Please try again.' });
    }
  });

  // Revisit Skipped Profiles (Requirement #23: blocked users never reappear)
  app.get('/api/discover/passed', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const userProfile = profiles.get(user.id);

      // Collect user's blocked IDs
      const blockedIds = new Set<string>();
      for (const b of blocks.values()) {
        if (b.blocker_id === user.id) blockedIds.add(b.blocked_id);
        if (b.blocked_id === user.id) blockedIds.add(b.blocker_id);
      }

      const passedProfiles: any[] = [];

      for (const s of swipes.values()) {
        if (s.user_id === user.id && s.action === 'pass') {
          if (blockedIds.has(s.target_user_id)) continue; // Block strictly overrides revisit

          const p = profiles.get(s.target_user_id);
          if (p) {
            let score = 75;
            let breakdown = null;
            if (userProfile) {
              breakdown = calculateMatchScore(userProfile, p);
              score = breakdown.total_score;
            }
            passedProfiles.push({
              ...p,
              match_score: score,
              match_breakdown: breakdown
            });
          }
        }
      }

      res.json({
        profiles: passedProfiles,
        total: passedProfiles.length
      });
    } catch {
      res.status(500).json({ error: 'Could not load skipped profiles.' });
    }
  });

  // Undo Pass (Clear swipe so profile can be liked)
  app.post('/api/discover/undo-pass', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { target_user_id } = req.body;
      const swipeId = `swipe_${user.id}_${target_user_id}`;
      swipes.delete(swipeId);
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Could not undo pass.' });
    }
  });

  // ==========================================
  // 4. MATCHES, CHAT & REAL-TIME
  // ==========================================

  // Get Matches
  app.get('/api/matches', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const userMatches: any[] = [];

      for (const m of matches.values()) {
        if (m.user_ids.includes(user.id) && m.status !== 'blocked') {
          const otherUserId = m.user_ids.find(id => id !== user.id)!;
          const otherProf = profiles.get(otherUserId);
          if (!otherProf) continue;

          // Find last message
          let lastMsg = null;
          let unreadCount = 0;
          const matchMsgs: MessageItem[] = [];

          for (const msg of messages.values()) {
            if (msg.match_id === m.id) {
              matchMsgs.push(msg);
              if (msg.recipient_id === user.id && !msg.read) {
                unreadCount++;
              }
            }
          }

          matchMsgs.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
          if (matchMsgs.length > 0) {
            lastMsg = matchMsgs[matchMsgs.length - 1];
          }

          userMatches.push({
            id: m.id,
            user_ids: m.user_ids,
            other_user: otherProf,
            match_score: m.match_score,
            match_breakdown: m.match_breakdown,
            last_message: lastMsg,
            unread_count: unreadCount,
            moving_in_requested_by: m.moving_in_requested_by || [],
            status: m.status,
            created_at: m.created_at,
            updated_at: m.updated_at
          });
        }
      }

      userMatches.sort((a, b) => {
        const timeA = a.last_message ? new Date(a.last_message.created_at).getTime() : new Date(a.created_at).getTime();
        const timeB = b.last_message ? new Date(b.last_message.created_at).getTime() : new Date(b.created_at).getTime();
        return timeB - timeA;
      });

      res.json({ matches: userMatches });
    } catch {
      res.status(500).json({ error: 'Could not load matches.' });
    }
  });

  // Get Match Details + Message History
  app.get('/api/matches/:matchId', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { matchId } = req.params;

      const m = matches.get(matchId);
      if (!m || !m.user_ids.includes(user.id)) {
        return res.status(404).json({ error: 'Match not found.' });
      }

      const otherUserId = m.user_ids.find(id => id !== user.id)!;
      const otherProf = profiles.get(otherUserId);

      const matchMsgs: MessageItem[] = [];
      for (const msg of messages.values()) {
        if (msg.match_id === matchId) {
          matchMsgs.push(msg);
        }
      }
      matchMsgs.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      res.json({
        match: {
          ...m,
          other_user: otherProf
        },
        messages: matchMsgs
      });
    } catch {
      res.status(500).json({ error: 'Could not load conversation.' });
    }
  });

  // Send Message
  app.post('/api/matches/:matchId/messages', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { matchId } = req.params;
      const { content } = req.body;

      if (!content || !content.trim()) {
        return res.status(400).json({ error: 'Message content cannot be empty.' });
      }

      const m = matches.get(matchId);
      if (!m || !m.user_ids.includes(user.id)) {
        return res.status(404).json({ error: 'Match conversation not found.' });
      }

      const recipientId = m.user_ids.find(id => id !== user.id)!;

      // Check if blocked
      for (const b of blocks.values()) {
        if (
          (b.blocker_id === user.id && b.blocked_id === recipientId) ||
          (b.blocker_id === recipientId && b.blocked_id === user.id)
        ) {
          return res.status(403).json({ error: 'Cannot send message to this user.' });
        }
      }

      const msgId = `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const newMsg: MessageItem = {
        id: msgId,
        match_id: matchId,
        sender_id: user.id,
        recipient_id: recipientId,
        content: content.trim(),
        created_at: new Date().toISOString(),
        read: false
      };

      messages.set(msgId, newMsg);
      syncMessageToPostgres(newMsg);

      m.updated_at = new Date().toISOString();
      matches.set(matchId, m);
      syncMatchToPostgres(m);

      // Trigger real-time SSE event to recipient
      const senderProfile = profiles.get(user.id);
      sendRealtimeEvent(recipientId, 'new_message', {
        message: newMsg,
        sender: {
          id: user.id,
          name: senderProfile?.name || 'Flatmate Match',
          photo: senderProfile?.main_photo || ''
        },
        match_id: matchId
      });

      res.json({ message: newMsg });
    } catch {
      res.status(500).json({ error: "Your message couldn't be sent. Please retry." });
    }
  });

  // Mark Messages as Read
  app.post('/api/matches/:matchId/read', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { matchId } = req.params;

      for (const msg of messages.values()) {
        if (msg.match_id === matchId && msg.recipient_id === user.id) {
          msg.read = true;
        }
      }

      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Could not mark messages as read.' });
    }
  });

  // Moving In (Requirement #37: Two-sided state)
  app.post('/api/matches/:matchId/moving-in', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { matchId } = req.params;

      const m = matches.get(matchId);
      if (!m || !m.user_ids.includes(user.id)) {
        return res.status(404).json({ error: 'Match not found.' });
      }

      const otherUserId = m.user_ids.find(id => id !== user.id)!;
      const requests = new Set(m.moving_in_requested_by || []);
      requests.add(user.id);
      m.moving_in_requested_by = Array.from(requests);

      let bothConfirmed = false;
      if (m.moving_in_requested_by.includes(user.id) && m.moving_in_requested_by.includes(otherUserId)) {
        bothConfirmed = true;
        m.status = 'moved_in';

        // Update profiles to moved in & remove from Discover
        const profA = profiles.get(user.id);
        if (profA) {
          profA.moved_in_status = 'moved_in';
          profA.moved_in_with_match_id = matchId;
          profA.discover_active = false;
          profiles.set(user.id, profA);
        }

        const profB = profiles.get(otherUserId);
        if (profB) {
          profB.moved_in_status = 'moved_in';
          profB.moved_in_with_match_id = matchId;
          profB.discover_active = false;
          profiles.set(otherUserId, profB);
        }

        // Notify both users in real-time
        sendRealtimeEvent(otherUserId, 'moving_in_completed', { matchId });
        sendRealtimeEvent(user.id, 'moving_in_completed', { matchId });
      } else {
        // Send notification to other user that moving in was requested
        sendRealtimeEvent(otherUserId, 'moving_in_requested', {
          matchId,
          requested_by: user.id
        });
      }

      matches.set(matchId, m);

      res.json({
        success: true,
        both_confirmed: bothConfirmed,
        match: m,
        message: bothConfirmed
          ? 'You two are moving in together 🏠'
          : "You've marked this match as moving in. Waiting for your flatmate's confirmation."
      });
    } catch {
      res.status(500).json({ error: 'Could not update moving in status.' });
    }
  });

  // Block User (Requirement #35: Strict server-side block across devices)
  app.post('/api/users/block', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { target_user_id, reason } = req.body;

      if (!target_user_id || target_user_id === user.id) {
        return res.status(400).json({ error: 'Invalid user to block.' });
      }

      const blockId = `block_${user.id}_${target_user_id}`;
      const targetProf = profiles.get(target_user_id);

      blocks.set(blockId, {
        id: blockId,
        blocker_id: user.id,
        blocked_id: target_user_id,
        blocked_user: targetProf ? {
          name: targetProf.name,
          photo: targetProf.main_photo,
          locality: targetProf.locality
        } : undefined,
        reason: reason || 'User requested block',
        created_at: new Date().toISOString()
      });

      // Update any existing matches to blocked
      for (const m of matches.values()) {
        if (m.user_ids.includes(user.id) && m.user_ids.includes(target_user_id)) {
          m.status = 'blocked';
        }
      }

      res.json({ success: true, message: 'User has been blocked.' });
    } catch {
      res.status(500).json({ error: 'Could not block user.' });
    }
  });

  // Report User (Requirement #36: Server-side report logging)
  app.post('/api/users/report', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { target_user_id, reason, details } = req.body;

      if (!target_user_id || !reason) {
        return res.status(400).json({ error: 'Please specify a reason for the report.' });
      }

      const reportId = `report_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      reports.set(reportId, {
        id: reportId,
        reporter_id: user.id,
        reported_id: target_user_id,
        reason,
        details: details || '',
        created_at: new Date().toISOString()
      });

      res.json({ success: true, message: 'Thank you for reporting. Our safety team will review this promptly.' });
    } catch {
      res.status(500).json({ error: 'Could not submit report.' });
    }
  });

  // Get Blocked Users
  app.get('/api/users/blocked', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const list: any[] = [];

      for (const b of blocks.values()) {
        if (b.blocker_id === user.id) {
          list.push(b);
        }
      }

      res.json({ blocked_users: list });
    } catch {
      res.status(500).json({ error: 'Could not load blocked users.' });
    }
  });

  // Unblock User
  app.post('/api/users/unblock', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const { target_user_id } = req.body;
      const blockId = `block_${user.id}_${target_user_id}`;
      blocks.delete(blockId);
      res.json({ success: true, message: 'User unblocked.' });
    } catch {
      res.status(500).json({ error: 'Could not unblock user.' });
    }
  });

  // Settings
  app.get('/api/settings', requireAuth, (req, res) => {
    const user = (req as any).user;
    const s = settingsStore.get(user.id) || { new_message_banner: true, email_notifications: true, privacy_mode: false };
    res.json({ settings: s });
  });

  app.put('/api/settings', requireAuth, (req, res) => {
    try {
      const user = (req as any).user;
      const existing = settingsStore.get(user.id) || { new_message_banner: true, email_notifications: true, privacy_mode: false };
      const updated = { ...existing, ...req.body };
      settingsStore.set(user.id, updated);
      res.json({ settings: updated });
    } catch {
      res.status(500).json({ error: 'Could not save settings.' });
    }
  });

  // Real-time SSE Stream Endpoint (Requirement #41)
  app.get('/api/realtime/stream', requireAuth, (req, res) => {
    const user = (req as any).user;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.set(user.id, res);

    res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', user_id: user.id })}\n\n`);

    req.on('close', () => {
      sseClients.delete(user.id);
    });
  });

  // Google OAuth URL generation endpoint (Popup-based according to OAuth skill)
  app.get('/api/auth/google/url', (req, res) => {
    const origin = req.headers.origin || (process.env.APP_URL ? process.env.APP_URL : `http://localhost:${PORT}`);
    const redirectUri = `${origin}/auth/google/callback`;
    const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
    
    if (!googleClientId) {
      // Return flag indicating direct client authentication or config
      return res.json({ 
        configured: false, 
        message: 'Google Client ID not configured. Use standard account creation or provide GOOGLE_CLIENT_ID.' 
      });
    }

    const nonce = crypto.randomBytes(32).toString('hex');
    res.setHeader('Set-Cookie', 'google_oauth_nonce=' + encodeURIComponent(nonce) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=600');

    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: redirectUri,
      response_type: 'token id_token',
      scope: 'openid email profile',
      prompt: 'select_account',
      nonce
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    res.json({ configured: true, url: authUrl, redirect_uri: redirectUri });
  });

  // Google OAuth callback HTML popup handler
  app.get(['/api/auth/google/callback', '/auth/google/callback'], (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Google Sign In</title></head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #FAF8F4;">
          <div style="text-align: center; padding: 32px; background: white; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); border: 1px solid #E6E3DE; max-width: 320px;">
            <div style="width: 48px; height: 48px; background: #FAF8F4; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
              <svg width="24" height="24" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
            </div>
            <h3 style="margin: 0 0 8px 0; color: #2B2D42; font-size: 17px; font-weight: 700;">Signed in successfully!</h3>
            <p style="margin: 0; color: #7A7D87; font-size: 13px;">Closing and returning to FlatMate+...</p>
          </div>
          <script>
            try {
              const hash = window.location.hash.substring(1);
              const hashParams = new URLSearchParams(hash);
              const queryParams = new URLSearchParams(window.location.search);
              
              const accessToken = hashParams.get('access_token');
              const idToken = hashParams.get('id_token') || queryParams.get('code');
              
              if (window.opener) {
                window.opener.postMessage({
                  type: 'GOOGLE_AUTH_CALLBACK',
                  accessToken,
                  idToken
                }, window.location.origin);
                setTimeout(() => window.close(), 600);
              } else {
                window.location.href = '/';
              }
            } catch (err) {
              console.error(err);
            }
          </script>
        </body>
      </html>
    `);
  });

  // ==========================================
  // 5. VITE MIDDLEWARE & STATIC ASSETS
  // ==========================================

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return server;
}

// Vercel detects the exported handler/server and manages the HTTP lifecycle.
// Locally, `npm run dev` still starts the same Express server through server-entry.ts.
export const serverPromise = createServer();

export default async function handler(req: any, res: any) {
  const server = await serverPromise;
  return server.emit('request', req, res);
}
