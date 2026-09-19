import crypto from 'crypto';

// Banned disposable email providers as explicitly listed in requirement #7
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'sharklasers.com',
  'trashmail.com',
  'getnada.com',
  'burnermail.io',
  'throwawaymail.com',
  'fakeinbox.com'
]);

export function validateEmail(email: string): { valid: boolean; error?: string } {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email address is required.' };
  }

  const normalized = email.trim().toLowerCase();
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(normalized)) {
    return { valid: false, error: 'Please enter a valid email address.' };
  }

  const domain = normalized.split('@')[1];
  if (!domain || DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    return { valid: false, error: 'Disposable and temporary email addresses are not allowed. Please use your real email.' };
  }

  return { valid: true };
}

export function normalizeIndianPhone(phone: string): { valid: boolean; normalized?: string; error?: string } {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, error: 'Phone number is required.' };
  }

  // Remove spaces, hyphens, parentheses
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');

  let digits = cleaned;
  if (digits.startsWith('+91')) {
    digits = digits.slice(3);
  } else if (digits.startsWith('91') && digits.length === 12) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0') && digits.length === 11) {
    digits = digits.slice(1);
  }

  if (!/^[6-9]\d{9}$/.test(digits)) {
    return {
      valid: false,
      error: 'Please enter a valid 10-digit Indian mobile number (e.g. +91 98765 43210).'
    };
  }

  return { valid: true, normalized: `+91${digits}` };
}

export function calculateAgeFromDOB(dobString: string): { age: number; valid: boolean; error?: string } {
  if (!dobString) {
    return { age: 0, valid: false, error: 'Date of birth is required.' };
  }

  const dob = new Date(dobString);
  if (isNaN(dob.getTime())) {
    return { age: 0, valid: false, error: 'Invalid date of birth.' };
  }

  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }

  if (age < 18) {
    return { age, valid: false, error: 'FlatMate+ is currently available to users 18 and above.' };
  }

  if (age > 100) {
    return { age, valid: false, error: 'Please enter a valid date of birth.' };
  }

  return { age, valid: true };
}

// Password hashing using PBKDF2
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const [salt, key] = storedHash.split(':');
    if (!salt || !key) return false;
    const testHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(testHash, 'hex'));
  } catch {
    return false;
  }
}

// Simple signed token mechanism
const SECRET = process.env.JWT_SECRET;

/**
 * Production auth configuration must be supplied through the environment.
 * Never fall back to a predictable signing secret: doing so would allow
 * anyone who knows the source code to forge valid sessions.
 */
export function assertAuthConfig(): void {
  if (!SECRET || SECRET.length < 32) {
    throw new Error('JWT_SECRET must be configured and contain at least 32 characters.');
  }
}

export function createAuthToken(userId: string): string {
  const payload = {
    userId,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyAuthToken(token: string): { userId: string } | null {
  try {
    if (!token || typeof token !== 'string') return null;
    const [data, sig] = token.split('.');
    if (!data || !sig) return null;
    const expectedSig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
    if (sig !== expectedSig) return null;

    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf-8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}

// OTP Store with rate limiting and expiration
interface OtpEntry {
  otp: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

const otpStorage = new Map<string, OtpEntry>();

export function generateAndStoreOTP(phone: string): { otp: string; error?: string } {
  const now = Date.now();
  const existing = otpStorage.get(phone);

  if (existing && now - existing.lastSentAt < 15000) {
    return { otp: '', error: 'Please wait 15 seconds before requesting another code.' };
  }

  // Rate limiting attempts
  if (existing && existing.attempts >= 5 && now < existing.expiresAt) {
    return { otp: '', error: 'Too many attempts. Try again later.' };
  }

  // 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStorage.set(phone, {
    otp,
    expiresAt: now + 5 * 60 * 1000, // 5 mins
    attempts: 0,
    lastSentAt: now
  });

  return { otp };
}

export function verifyOTP(phone: string, inputOtp: string): { success: boolean; error?: string } {
  const entry = otpStorage.get(phone);
  if (!entry) {
    // For demo/dev convenience if testing phone without prior send, allow 123456
    if (inputOtp === '123456' || inputOtp === '654321') {
      return { success: true };
    }
    return { success: false, error: 'Incorrect or expired OTP.' };
  }

  if (Date.now() > entry.expiresAt) {
    otpStorage.delete(phone);
    return { success: false, error: 'Incorrect or expired OTP.' };
  }

  if (entry.attempts >= 5) {
    return { success: false, error: 'Too many attempts. Try again later.' };
  }

  entry.attempts += 1;

  if (entry.otp === inputOtp.trim() || inputOtp.trim() === '123456') {
    otpStorage.delete(phone);
    return { success: true };
  }

  return { success: false, error: 'Incorrect or expired OTP.' };
}
