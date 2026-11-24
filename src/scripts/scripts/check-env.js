import { config } from '../src/config.js';

function mask(value, keep = 4) {
  if (typeof value !== 'string') return String(value);
  if (value.length <= keep * 2) return '***';
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

const rows = [
  ['NODE_ENV', config.env],
  ['PORT', String(config.port)],
  ['APP_URL', config.appUrl],
  ['CORS_ORIGIN', config.corsOrigin.join(', ')],
  ['SUPABASE_URL', config.supabase.url],
  ['SUPABASE_ANON_KEY', mask(config.supabase.anonKey)],
  ['SUPABASE_SERVICE_ROLE_KEY', mask(config.supabase.serviceRoleKey)],
  ['SUPABASE_STORAGE_BUCKET', config.supabase.storageBucket],
  ['JWT_SECRET', mask(config.jwt.secret)],
  ['JWT_EXPIRES_IN', config.jwt.expiresIn],
  ['OTP_TTL_MINUTES', String(config.otp.ttlMinutes)],
  ['OTP_MAX_ATTEMPTS', String(config.otp.maxAttempts)],
  ['SMTP_HOST', config.smtp.host],
  ['SMTP_PORT', String(config.smtp.port)],
  ['SMTP_SECURE', String(config.smtp.secure)],
  ['SMTP_USER', config.smtp.user],
  ['SMTP_PASS', mask(config.smtp.pass)],
  ['MAIL_FROM', config.smtp.from],
  ['DEVELOPER_EMAILS', config.developerEmails.join(', ')],
  ['RL_MESSAGES_PER_MIN', String(config.rateLimit.messagesPerMin)],
  ['RL_AUTH_ATTEMPTS', String(config.rateLimit.authAttempts)],
  ['RL_AUTH_WINDOW_MIN', String(config.rateLimit.authWindowMin)],
  ['MAX_PHOTO_BYTES', String(config.limits.photoBytes)],
  ['MAX_VIDEO_BYTES', String(config.limits.videoBytes)],
  ['MAX_VOICE_BYTES', String(config.limits.voiceBytes)],
  ['MAX_MUSIC_BYTES', String(config.limits.musicBytes)],
  ['MAX_VIDEO_DURATION_SEC', String(config.limits.videoDurationSec)],
  ['BIO_MAX_CHARS', String(config.rules.bioMaxChars)],
  ['USERNAME_MIN', String(config.rules.usernameMin)],
  ['USERNAME_MAX', String(config.rules.usernameMax)],
  ['AGE_MIN', String(config.rules.ageMin)],
  ['AGE_MAX', String(config.rules.ageMax)],
  ['CHAT_HARD_DELETE_DAYS', String(config.rules.chatHardDeleteDays)],
  ['MESSAGE_DELETE_HOURS', String(config.rules.messageDeleteHours)],
  ['GROUP_MAX_MEMBERS', String(config.rules.groupMaxMembers)],
  ['MUSIC_COOLDOWN_1_H', String(config.musicCooldowns.firstHours)],
  ['MUSIC_COOLDOWN_2_H', String(config.musicCooldowns.secondHours)],
  ['MUSIC_COOLDOWN_3_H', String(config.musicCooldowns.thirdHours)],
];

const labelWidth = Math.max(...rows.map(([k]) => k.length)) + 2;

console.log('\n══════════════════════════════════════════════════════');
console.log('  Factor — environment check');
console.log('══════════════════════════════════════════════════════\n');

for (const [key, value] of rows) {
  console.log(`${key.padEnd(labelWidth)} ${value}`);
}

console.log('\n══════════════════════════════════════════════════════');
console.log('  ✓ all environment variables valid');
console.log('══════════════════════════════════════════════════════\n');
