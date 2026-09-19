import { pool } from '../src/db/index.ts';
import { users, profiles, swipes, matches, messages, blocks, reports, settingsStore } from './db.js';

const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? new Date().toISOString());

export async function ensurePostgresSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,phone TEXT,name TEXT,phone_verified BOOLEAN NOT NULL DEFAULT FALSE,email_verified BOOLEAN NOT NULL DEFAULT FALSE,google_id TEXT,password_hash TEXT,auth_provider TEXT NOT NULL DEFAULT 'local',created_at TIMESTAMP NOT NULL DEFAULT NOW(),updated_at TIMESTAMP NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),name TEXT NOT NULL,age INTEGER NOT NULL,gender TEXT NOT NULL,dob TEXT,locality TEXT NOT NULL,city TEXT NOT NULL DEFAULT 'Bangalore',rent_min INTEGER NOT NULL,rent_max INTEGER NOT NULL,food_preference TEXT NOT NULL,cleanliness TEXT NOT NULL,sleep_schedule TEXT NOT NULL,smoking TEXT NOT NULL,drinking TEXT NOT NULL,pets_preference TEXT NOT NULL,guest_policy TEXT NOT NULL,occupation TEXT,bio TEXT,main_photo TEXT,photos JSONB NOT NULL DEFAULT '[]'::jsonb,is_verified BOOLEAN NOT NULL DEFAULT FALSE,peace_sign_verified BOOLEAN NOT NULL DEFAULT FALSE,non_negotiables JSONB NOT NULL DEFAULT '[]'::jsonb,hobbies JSONB NOT NULL DEFAULT '[]'::jsonb,languages JSONB NOT NULL DEFAULT '[]'::jsonb,prompts JSONB NOT NULL DEFAULT '[]'::jsonb,housing_intent JSONB NOT NULL DEFAULT '{}'::jsonb,house_details JSONB,profile_data JSONB,onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMP NOT NULL DEFAULT NOW(),updated_at TIMESTAMP NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS swipes (id TEXT PRIMARY KEY,swiper_id TEXT NOT NULL REFERENCES users(id),target_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY,user_ids JSONB NOT NULL,match_score INTEGER NOT NULL,match_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,status TEXT NOT NULL DEFAULT 'matched',moving_in_requested_by JSONB NOT NULL DEFAULT '[]'::jsonb,created_at TIMESTAMP NOT NULL DEFAULT NOW(),updated_at TIMESTAMP NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,match_id TEXT NOT NULL REFERENCES matches(id),sender_id TEXT NOT NULL REFERENCES users(id),recipient_id TEXT NOT NULL REFERENCES users(id),content TEXT NOT NULL,read BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMP NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY,blocker_id TEXT NOT NULL REFERENCES users(id),blocked_id TEXT NOT NULL REFERENCES users(id),blocked_user JSONB,reason TEXT,created_at TIMESTAMP NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY,reporter_id TEXT NOT NULL REFERENCES users(id),target_id TEXT NOT NULL REFERENCES users(id),reason TEXT NOT NULL,details TEXT,created_at TIMESTAMP NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY REFERENCES users(id),new_message_banner BOOLEAN NOT NULL DEFAULT TRUE,email_notifications BOOLEAN NOT NULL DEFAULT TRUE,privacy_mode BOOLEAN NOT NULL DEFAULT FALSE,updated_at TIMESTAMP NOT NULL DEFAULT NOW());
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_data JSONB;
    ALTER TABLE blocks ADD COLUMN IF NOT EXISTS blocked_user JSONB;
    ALTER TABLE blocks ADD COLUMN IF NOT EXISTS reason TEXT;
    CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);
    CREATE INDEX IF NOT EXISTS idx_profiles_onboarding_complete ON profiles(onboarding_complete);
    CREATE INDEX IF NOT EXISTS idx_profiles_city_locality ON profiles(city, locality);
    CREATE INDEX IF NOT EXISTS idx_swipes_swiper_target ON swipes(swiper_id, target_id);
    CREATE INDEX IF NOT EXISTS idx_swipes_target ON swipes(target_id);
    CREATE INDEX IF NOT EXISTS idx_messages_match_created ON messages(match_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient_read ON messages(recipient_id, read);
    CREATE INDEX IF NOT EXISTS idx_matches_user_ids ON matches USING GIN(user_ids);
  `);
}

export async function hydrateFromPostgres() {
  users.clear();
  profiles.clear();
  swipes.clear();
  matches.clear();
  messages.clear();
  blocks.clear();
  reports.clear();
  settingsStore.clear();

  const [u, p, s, m, mm, b, r, st] = await Promise.all([
    pool.query('SELECT * FROM users ORDER BY created_at'),
    pool.query('SELECT * FROM profiles ORDER BY created_at'),
    pool.query('SELECT * FROM swipes ORDER BY created_at'),
    pool.query('SELECT * FROM matches ORDER BY created_at'),
    pool.query('SELECT * FROM messages ORDER BY created_at'),
    pool.query('SELECT * FROM blocks ORDER BY created_at'),
    pool.query('SELECT * FROM reports ORDER BY created_at'),
    pool.query('SELECT * FROM user_settings')
  ]);

  for (const row of u.rows) users.set(row.id, {
    id: row.id,
    email: row.email,
    phone: row.phone || '',
    password_hash: row.password_hash || '',
    phone_verified: !!row.phone_verified,
    email_verified: !!row.email_verified,
    google_id: row.google_id || undefined,
    created_at: iso(row.created_at)
  });

  for (const row of p.rows) {
    const stored = row.profile_data && typeof row.profile_data === 'object' ? row.profile_data : {};
    profiles.set(row.user_id, {
      ...stored,
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      age: row.age,
      gender: row.gender,
      date_of_birth: stored.date_of_birth || row.dob || '2000-01-01',
      locality: row.locality,
      city: row.city,
      rent_min: row.rent_min,
      rent_max: row.rent_max,
      food_preference: row.food_preference,
      cleanliness: row.cleanliness,
      sleep_schedule: row.sleep_schedule,
      smoking: row.smoking,
      drinking: row.drinking,
      pets: row.pets_preference,
      guests: row.guest_policy,
      work_schedule: row.occupation || stored.work_schedule || '',
      bio: row.bio || '',
      main_photo: row.main_photo || stored.main_photo || '',
      photos: row.photos || [],
      is_verified: !!row.is_verified,
      liveness_verified: !!row.peace_sign_verified,
      non_negotiables: row.non_negotiables || [],
      hobbies: row.hobbies || [],
      languages: row.languages || [],
      prompts: row.prompts || [],
      housing_intent: row.housing_intent || {},
      house_details: row.house_details || undefined,
      is_profile_complete: !!row.onboarding_complete,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at)
    } as any);
  }

  for (const row of s.rows) swipes.set(row.id, { id: row.id, user_id: row.swiper_id, target_user_id: row.target_id, action: row.action, created_at: iso(row.created_at) });

  for (const row of m.rows) {
    const rawUserIds = Array.isArray(row.user_ids) ? row.user_ids.filter((id: unknown): id is string => typeof id === 'string') : [];
    if (rawUserIds.length !== 2) {
      console.warn(`Skipping invalid persisted match ${row.id}: expected exactly two user IDs.`);
      continue;
    }
    const userIds = rawUserIds as [string, string];
    const otherUser = profiles.get(userIds[1]) || profiles.get(userIds[0]);
    if (!otherUser) {
      console.warn(`Skipping persisted match ${row.id}: no profile found for either matched user.`);
      continue;
    }
    matches.set(row.id, {
      id: row.id,
      user_ids: userIds,
      other_user: otherUser,
      match_score: Number(row.match_score) || 0,
      match_breakdown: row.match_breakdown || { total_score: Number(row.match_score) || 0, categories: [], highlights: [], dealbreakers_met: true },
      unread_count: 0,
      status: row.status,
      moving_in_requested_by: row.moving_in_requested_by || [],
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at)
    });
  }

  for (const row of mm.rows) messages.set(row.id, { id: row.id, match_id: row.match_id, sender_id: row.sender_id, recipient_id: row.recipient_id, content: row.content, read: !!row.read, created_at: iso(row.created_at) });
  for (const row of b.rows) blocks.set(row.id, { id: row.id, blocker_id: row.blocker_id, blocked_id: row.blocked_id, blocked_user: row.blocked_user || undefined, reason: row.reason || undefined, created_at: iso(row.created_at) } as any);
  for (const row of r.rows) reports.set(row.id, { id: row.id, reporter_id: row.reporter_id, reported_id: row.target_id, reason: row.reason, details: row.details || '', created_at: iso(row.created_at) });
  for (const row of st.rows) settingsStore.set(row.user_id, { new_message_banner: !!row.new_message_banner, email_notifications: !!row.email_notifications, privacy_mode: !!row.privacy_mode });

  console.log(`PostgreSQL hydration complete: ${users.size} users, ${profiles.size} profiles, ${matches.size} matches, ${messages.size} messages.`);
}

/**
 * Persist the in-memory compatibility layer into PostgreSQL.
 * IMPORTANT: this function intentionally NEVER deletes rows from PostgreSQL.
 * PostgreSQL is the durable source of truth; a service restart hydrates Maps
 * from these rows before serving requests. This prevents an empty/stale
 * in-memory Map from accidentally erasing the database during a restart.
 */
export async function persistSnapshot() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const user of users.values()) await client.query(`
      INSERT INTO users (id,email,phone,name,phone_verified,email_verified,google_id,password_hash,auth_provider,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (id) DO UPDATE SET email=$2,phone=$3,name=$4,phone_verified=$5,email_verified=$6,google_id=$7,password_hash=$8,auth_provider=$9,updated_at=NOW()
    `, [user.id, user.email, user.phone || null, (user as any).name || null, !!user.phone_verified, !!(user as any).email_verified, (user as any).google_id || null, user.password_hash || null, (user as any).auth_provider || 'local', user.created_at || new Date().toISOString()]);

    for (const p of profiles.values()) if (users.has(p.user_id)) await client.query(`
      INSERT INTO profiles (id,user_id,name,age,gender,dob,locality,city,rent_min,rent_max,food_preference,cleanliness,sleep_schedule,smoking,drinking,pets_preference,guest_policy,occupation,bio,main_photo,photos,is_verified,peace_sign_verified,non_negotiables,hobbies,languages,prompts,housing_intent,house_details,profile_data,onboarding_complete,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
      ON CONFLICT (id) DO UPDATE SET user_id=$2,name=$3,age=$4,gender=$5,dob=$6,locality=$7,city=$8,rent_min=$9,rent_max=$10,food_preference=$11,cleanliness=$12,sleep_schedule=$13,smoking=$14,drinking=$15,pets_preference=$16,guest_policy=$17,occupation=$18,bio=$19,main_photo=$20,photos=$21,is_verified=$22,peace_sign_verified=$23,non_negotiables=$24,hobbies=$25,languages=$26,prompts=$27,housing_intent=$28,house_details=$29,profile_data=$30,onboarding_complete=$31,updated_at=$33
    `, [p.id, p.user_id, p.name, p.age, p.gender, p.date_of_birth || null, p.locality, p.city || 'Bangalore', p.rent_min, p.rent_max, p.food_preference, p.cleanliness, p.sleep_schedule, p.smoking, p.drinking, p.pets, p.guests, p.work_schedule || null, p.bio || null, p.main_photo || p.photos?.[0]?.url || null, p.photos || [], !!p.is_verified, !!p.liveness_verified, p.non_negotiables || [], p.hobbies || [], p.languages || [], p.prompts || [], p.housing_intent || {}, p.house_details || null, p, !!p.is_profile_complete, p.created_at || new Date().toISOString(), p.updated_at || new Date().toISOString()]);

    for (const s of swipes.values()) await client.query(`INSERT INTO swipes (id,swiper_id,target_id,action,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET action=$4`, [s.id, s.user_id, s.target_user_id, s.action, s.created_at]);
    for (const m of matches.values()) await client.query(`INSERT INTO matches (id,user_ids,match_score,match_breakdown,status,moving_in_requested_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET user_ids=$2,match_score=$3,match_breakdown=$4,status=$5,moving_in_requested_by=$6,updated_at=$8`, [m.id, m.user_ids, m.match_score, m.match_breakdown || {}, m.status || 'matched', m.moving_in_requested_by || [], m.created_at, m.updated_at]);
    for (const m of messages.values()) if (matches.has(m.match_id)) await client.query(`INSERT INTO messages (id,match_id,sender_id,recipient_id,content,read,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET content=$5,read=$6`, [m.id, m.match_id, m.sender_id, m.recipient_id, m.content, !!m.read, m.created_at]);
    for (const b of blocks.values()) await client.query(`INSERT INTO blocks (id,blocker_id,blocked_id,blocked_user,reason,created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET blocked_user=$4,reason=$5`, [b.id, b.blocker_id, b.blocked_id, (b as any).blocked_user || null, (b as any).reason || null, b.created_at]);
    for (const r of reports.values()) await client.query(`INSERT INTO reports (id,reporter_id,target_id,reason,details,created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET reason=$4,details=$5`, [r.id, r.reporter_id, r.reported_id, r.reason, r.details || null, r.created_at]);
    for (const [id, s] of settingsStore.entries()) await client.query(`INSERT INTO user_settings (user_id,new_message_banner,email_notifications,privacy_mode,updated_at) VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (user_id) DO UPDATE SET new_message_banner=$2,email_notifications=$3,privacy_mode=$4,updated_at=NOW()`, [id, s.new_message_banner ?? true, s.email_notifications ?? true, s.privacy_mode ?? false]);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function initializePostgresPersistence() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Configure Render PostgreSQL before starting FlatMate+.');

  await ensurePostgresSchema();

  const connectionInfo = await pool.query('SELECT current_database() AS database_name, current_schema() AS schema_name');
  console.log(`PostgreSQL durable storage connected: database=${connectionInfo.rows[0]?.database_name}, schema=${connectionInfo.rows[0]?.schema_name}`);

  await hydrateFromPostgres();

  let running = false;
  const syncLoop = async () => {
    if (running) return;
    running = true;
    try {
      await persistSnapshot();
    } catch (error) {
      console.error('PostgreSQL durable sync failed:', error);
    } finally {
      running = false;
    }
  };

  // Keep the durable store close to real time while the web service is awake.
  // Unlike the previous implementation, the loop never hydrates or deletes
  // database rows, so an idle-service restart cannot wipe persistent data.
  const timer = setInterval(syncLoop, 1000);
  timer.unref?.();

  console.log('PostgreSQL durable synchronization enabled (1s, non-destructive).');
}
