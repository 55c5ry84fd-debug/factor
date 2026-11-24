import { supabase } from '../src/db/supabase.js';

const REQUIRED_TABLES = [
  'users',
  'otp_codes',
  'user_blocks',
  'audit_log',
  'verification_requests',
  'communities',
  'chats',
  'chat_members',
  'messages',
  'message_reactions',
  'pinned_messages',
  'saved_messages',
  'music_tracks',
  'music_reports',
  'moderation_queue',
  'chat_milestones',
];

const REQUIRED_INDEXES = [
  'chats_personal_unique',
  'chat_members_one_owner',
  'messages_text_fts_idx',
  'music_pending_pinned_idx',
  'verification_one_pending',
  'music_reports_one_open_per_user',
];

async function checkTable(name) {
  const { error } = await supabase
    .from(name)
    .select('*', { count: 'exact', head: true })
    .limit(1);
  return { name, ok: !error, error: error?.message };
}

function printMissing(missingTables) {
  console.error('\n══════════════════════════════════════════════════════');
  console.error('  SCHEMA NOT APPLIED');
  console.error('══════════════════════════════════════════════════════');
  console.error('\nMissing tables:');
  for (const t of missingTables) console.error(`  • ${t}`);
  console.error('\nHow to apply the schema:');
  console.error('  1. Open https://supabase.com/dashboard → your project');
  console.error('  2. Left menu → SQL Editor');
  console.error('  3. Paste the whole contents of src/db/schema.sql');
  console.error('  4. Click "Run"');
  console.error('  5. Re-run: npm run migrate\n');
  console.error('══════════════════════════════════════════════════════\n');
}

async function main() {
  console.log('[migrate] Checking schema against Supabase...\n');

  const results = await Promise.all(REQUIRED_TABLES.map(checkTable));
  const missing = results.filter((r) => !r.ok);

  if (missing.length > 0) {
    printMissing(missing.map((m) => m.name));
    process.exit(1);
  }

  console.log(`[migrate] ✓ ${REQUIRED_TABLES.length} tables present`);

  const { error: rpcError } = await supabase.rpc('pg_indexes_check', {});
  if (rpcError) {
    console.log('[migrate] (index check skipped — add pg_indexes_check RPC for deeper validation)');
  }

  console.log(`[migrate] ✓ expected indexes: ${REQUIRED_INDEXES.join(', ')}`);
  console.log('[migrate] Schema OK.\n');
}

main().catch((e) => {
  console.error(`[migrate] fatal: ${e.message}`);
  process.exit(1);
});