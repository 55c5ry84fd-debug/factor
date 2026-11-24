-- Factor — database schema (part 1: identity & safety)
-- Run with: psql $SUPABASE_DB_URL -f src/db/schema.sql
-- Or paste into Supabase SQL Editor.
-- RLS is enabled on every table with NO policies → only service_role can access.

create extension if not exists "pgcrypto";

-- ═════════════════════════════════════════════════════════════
-- USERS
-- ═════════════════════════════════════════════════════════════
create table if not exists public.users (
  id                     uuid primary key default gen_random_uuid(),
  email                  text not null unique,
  phone                  text unique,
  name                   text not null check (char_length(name) between 1 and 40),
  username               text not null unique
                         check (username ~ '^[A-Za-z][A-Za-z0-9]{4,31}$'),
  age                    smallint check (age is null or age between 1 and 100),
  bio                    text check (bio is null or char_length(bio) <= 80),
  avatar_url             text,

  is_developer           boolean not null default false,
  is_moderator           boolean not null default false,
  is_verified_artist     boolean not null default false,
  verified_social_url    text,
  verified_at            timestamptz,
  verified_by            uuid references public.users(id) on delete set null,

  saved_name             text not null default 'Избранное'
                         check (char_length(saved_name) between 1 and 40),

  max_upload_mb          smallint not null default 20
                         check (max_upload_mb between 1 and 500),
  music_rejections       smallint not null default 0,
  music_cooldown_until   timestamptz,

  email_verified_at      timestamptz,
  last_seen_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);

create index if not exists users_username_idx on public.users (lower(username));
create index if not exists users_email_idx    on public.users (lower(email));
create index if not exists users_active_idx   on public.users (id) where deleted_at is null;
create index if not exists users_deleted_idx  on public.users (deleted_at) where deleted_at is not null;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════
-- OTP CODES (email passwordless)
-- ═════════════════════════════════════════════════════════════
create table if not exists public.otp_codes (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  code_hash    text not null,
  purpose      text not null default 'login'
               check (purpose in ('login', 'login_or_register', 'phone_verify')),
  attempts     smallint not null default 0,
  max_attempts smallint not null default 5,
  ip           inet,
  user_agent   text,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists otp_email_active_idx
  on public.otp_codes (lower(email), created_at desc)
  where consumed_at is null;
create index if not exists otp_expires_idx on public.otp_codes (expires_at);

-- ═════════════════════════════════════════════════════════════
-- USER BLOCKS  (user1 blocks user2)
-- ═════════════════════════════════════════════════════════════
create table if not exists public.user_blocks (
  blocker_id  uuid not null references public.users(id) on delete cascade,
  blocked_id  uuid not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id);

-- ═════════════════════════════════════════════════════════════
-- AUDIT LOG  (owner decisions stand above moderator decisions)
-- ═════════════════════════════════════════════════════════════
create table if not exists public.audit_log (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid references public.users(id) on delete set null,
  actor_email   text,
  actor_role    text not null check (actor_role in ('owner', 'moderator', 'system', 'user')),
  action        text not null,
  target_type   text not null,
  target_id     uuid,
  payload       jsonb not null default '{}'::jsonb,
  undone_at     timestamptz,
  undone_by     uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists audit_actor_idx   on public.audit_log (actor_id, created_at desc);
create index if not exists audit_target_idx  on public.audit_log (target_type, target_id, created_at desc);
create index if not exists audit_created_idx on public.audit_log (created_at desc);

-- ═════════════════════════════════════════════════════════════
-- ARTIST VERIFICATION REQUESTS
-- ═════════════════════════════════════════════════════════════
create table if not exists public.verification_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  social_url   text not null check (char_length(social_url) between 5 and 500),
  subscriber_count integer check (subscriber_count is null or subscriber_count >= 0),
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected')),
  reviewed_by  uuid references public.users(id) on delete set null,
  review_note  text,
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz
);

create index if not exists verification_pending_idx
  on public.verification_requests (created_at)
  where status = 'pending';
create index if not exists verification_user_idx
  on public.verification_requests (user_id, created_at desc);

-- one open request per user
create unique index if not exists verification_one_pending
  on public.verification_requests (user_id)
  where status = 'pending';

-- ═════════════════════════════════════════════════════════════
-- RLS: deny all by default; service_role bypasses.
-- ═════════════════════════════════════════════════════════════
alter table public.users                 enable row level security;
alter table public.otp_codes             enable row level security;
alter table public.user_blocks           enable row level security;
alter table public.audit_log             enable row level security;
alter table public.verification_requests enable row level security;

revoke all on public.users                 from anon, authenticated;
revoke all on public.otp_codes             from anon, authenticated;
revoke all on public.user_blocks           from anon, authenticated;
revoke all on public.audit_log             from anon, authenticated;
revoke all on public.verification_requests from anon, authenticated;
-- Factor — database schema (part 2: chats, messages, music, moderation)
-- Must run AFTER part 1 (depends on public.users).

-- ═════════════════════════════════════════════════════════════
-- COMMUNITIES  (umbrella for groups & channels)
-- ═════════════════════════════════════════════════════════════
create table if not exists public.communities (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.users(id) on delete restrict,
  name          text not null check (char_length(name) between 1 and 80),
  slug          text unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  description   text check (description is null or char_length(description) <= 500),
  avatar_url    text,
  visibility    text not null default 'public'
                check (visibility in ('public', 'private')),
  frozen_at     timestamptz,
  frozen_reason text,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists communities_owner_idx on public.communities (owner_id);
create index if not exists communities_slug_idx  on public.communities (slug) where deleted_at is null;

-- ═════════════════════════════════════════════════════════════
-- CHATS  (personal | group | channel)
-- ═════════════════════════════════════════════════════════════
create table if not exists public.chats (
  id                 uuid primary key default gen_random_uuid(),
  type               text not null check (type in ('personal', 'group', 'channel')),
  community_id       uuid references public.communities(id) on delete set null,
  owner_id           uuid references public.users(id) on delete set null,

  -- personal chats: store ordered pair to guarantee uniqueness
  user_a_id          uuid references public.users(id) on delete cascade,
  user_b_id          uuid references public.users(id) on delete cascade,

  name               text check (name is null or char_length(name) between 1 and 120),
  description        text check (description is null or char_length(description) <= 500),
  avatar_url         text,

  visibility         text not null default 'private'
                     check (visibility in ('public', 'private')),
  slug               text unique check (slug is null or slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  invite_token       text unique,

  allow_comments     boolean not null default false,
  created_at         timestamptz not null default now(),
  frozen_at          timestamptz,
  frozen_reason      text,

  -- "delete for both" — only allowed within CHAT_HARD_DELETE_DAYS of creation
  hard_deleted_at    timestamptz,
  hard_deleted_by    uuid references public.users(id) on delete set null,

  constraint chats_personal_pair check (
    (type = 'personal' and user_a_id is not null and user_b_id is not null
     and user_a_id < user_b_id and community_id is null and owner_id is null)
    or
    (type <> 'personal' and user_a_id is null and user_b_id is null)
  ),
  constraint chats_group_must_have_owner check (
    (type in ('group', 'channel') and owner_id is not null)
    or type = 'personal'
  )
);

create unique index if not exists chats_personal_unique
  on public.chats (user_a_id, user_b_id)
  where type = 'personal' and hard_deleted_at is null;

create index if not exists chats_owner_idx     on public.chats (owner_id) where owner_id is not null;
create index if not exists chats_community_idx on public.chats (community_id) where community_id is not null;
create index if not exists chats_slug_idx      on public.chats (slug) where slug is not null;

-- ═════════════════════════════════════════════════════════════
-- CHAT MEMBERS  (roles, per-admin permissions, soft leave)
-- ═════════════════════════════════════════════════════════════
create table if not exists public.chat_members (
  chat_id      uuid not null references public.chats(id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  role         text not null default 'member'
               check (role in ('owner', 'admin', 'member')),
  permissions  jsonb not null default '{}'::jsonb,
  -- permissions keys: delete_messages, ban_members, edit_chat_info,
  -- pin_messages, unpin_messages, open_comments, approve_joins
  banned_at    timestamptz,
  banned_by    uuid references public.users(id) on delete set null,
  deleted_at   timestamptz,           -- "delete for me" / left chat
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (chat_id, user_id)
);

create index if not exists chat_members_user_idx on public.chat_members (user_id) where deleted_at is null;
create index if not exists chat_members_active_idx on public.chat_members (chat_id) where deleted_at is null and banned_at is null;
create index if not exists chat_members_admin_old_idx
  on public.chat_members (chat_id, joined_at)
  where role = 'admin' and deleted_at is null;

-- enforce single owner per group/channel
create unique index if not exists chat_members_one_owner
  on public.chat_members (chat_id)
  where role = 'owner';

-- enforce GROUP_MAX_MEMBERS via trigger (count not hard-coded in DDL)
create or replace function public.check_chat_capacity()
returns trigger language plpgsql as $$
declare
  chat_type text;
  member_count int;
  limit_val int := 100; -- keep in sync with GROUP_MAX_MEMBERS env; adjusted via migration if changed
begin
  select type into chat_type from public.chats where id = new.chat_id;
  if chat_type <> 'group' then
    return new;
  end if;
  select count(*) into member_count
    from public.chat_members
    where chat_id = new.chat_id and deleted_at is null and banned_at is null;
  if member_count >= limit_val then
    raise exception 'GROUP_FULL' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_members_capacity on public.chat_members;
create trigger chat_members_capacity
  before insert on public.chat_members
  for each row execute function public.check_chat_capacity();

-- ═════════════════════════════════════════════════════════════
-- MESSAGES
-- ═════════════════════════════════════════════════════════════
create table if not exists public.messages (
  id            uuid primary key default gen_random_uuid(),
  chat_id       uuid not null references public.chats(id) on delete cascade,
  sender_id     uuid references public.users(id) on delete set null,

  type          text not null default 'text'
                check (type in ('text', 'photo', 'video', 'voice', 'music', 'system')),
  text          text check (text is null or char_length(text) <= 4000),

  media_url     text,
  media_meta    jsonb not null default '{}'::jsonb,
  -- media_meta: { mime, size, duration_sec, width, height, storage_path }

  reply_to_id   uuid references public.messages(id) on delete set null,
  track_id      uuid,  -- FK added after music_tracks table is created

  deleted_at    timestamptz,           -- author deleted within 72h; placeholder shown
  deleted_by    uuid references public.users(id) on delete set null,
  edited_at     timestamptz,
  created_at    timestamptz not null default now(),

  constraint messages_has_content check (
    type = 'system'
    or text is not null
    or media_url is not null
    or track_id is not null
  )
);

create index if not exists messages_chat_created_idx
  on public.messages (chat_id, created_at desc);
create index if not exists messages_sender_idx
  on public.messages (sender_id, created_at desc) where sender_id is not null;
create index if not exists messages_active_idx
  on public.messages (chat_id, created_at desc) where deleted_at is null;

-- full-text search on message text
create index if not exists messages_text_fts_idx
  on public.messages using gin (to_tsvector('russian', coalesce(text, '')));

-- ═════════════════════════════════════════════════════════════
-- MESSAGE REACTIONS
-- ═════════════════════════════════════════════════════════════
create table if not exists public.message_reactions (
  message_id  uuid not null references public.messages(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  emoji       text not null check (char_length(emoji) between 1 and 16),
  created_at  timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create index if not exists reactions_message_idx on public.message_reactions (message_id);

-- ═════════════════════════════════════════════════════════════
-- PINNED MESSAGES  (no hard cap, paginated in UI)
-- ═════════════════════════════════════════════════════════════
create table if not exists public.pinned_messages (
  chat_id     uuid not null references public.chats(id) on delete cascade,
  message_id  uuid not null references public.messages(id) on delete cascade,
  pinned_by   uuid references public.users(id) on delete set null,
  pinned_at   timestamptz not null default now(),
  primary key (chat_id, message_id)
);

create index if not exists pinned_chat_idx on public.pinned_messages (chat_id, pinned_at desc);

-- ═════════════════════════════════════════════════════════════
-- SAVED MESSAGES  (personal capsule / "Избранное")
-- ═════════════════════════════════════════════════════════════
create table if not exists public.saved_messages (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  source_message_id uuid references public.messages(id) on delete set null,
  payload      jsonb not null,   -- frozen copy of the message at save time
  note         text check (note is null or char_length(note) <= 500),
  tags         text[] not null default '{}',
  created_at   timestamptz not null default now()
);

create index if not exists saved_user_idx on public.saved_messages (user_id, created_at desc);
create index if not exists saved_tags_idx on public.saved_messages using gin (tags);

-- ═════════════════════════════════════════════════════════════
-- MUSIC TRACKS
-- ═════════════════════════════════════════════════════════════
create table if not exists public.music_tracks (
  id                uuid primary key default gen_random_uuid(),
  uploader_id       uuid not null references public.users(id) on delete cascade,
  title             text not null check (char_length(title) between 1 and 150),
  artist            text not null check (char_length(artist) between 1 and 150),
  cover_url         text,
  duration_sec      int check (duration_sec is null or duration_sec between 1 and 3600),
  genre             text check (genre is null or char_length(genre) <= 60),
  media_url         text not null,
  media_meta        jsonb not null default '{}'::jsonb,
  rights_confirmed_at timestamptz not null,
  rights_confirmed_ip inet,

  status            text not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected', 'removed')),
  rejection_reason  text,
  reviewed_by       uuid references public.users(id) on delete set null,
  reviewed_at       timestamptz,

  play_count        bigint not null default 0,
  is_pinned_in_queue boolean not null default false,
  frozen_at         timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists music_status_created_idx on public.music_tracks (status, created_at desc);
create index if not exists music_uploader_idx       on public.music_tracks (uploader_id, created_at desc);
create index if not exists music_approved_idx
  on public.music_tracks (created_at desc)
  where status = 'approved';
create index if not exists music_pending_pinned_idx
  on public.music_tracks (is_pinned_in_queue desc, created_at asc)
  where status = 'pending';

-- now link messages.track_id → music_tracks.id
alter table public.messages
  drop constraint if exists messages_track_fk;
alter table public.messages
  add constraint messages_track_fk
  foreign key (track_id) references public.music_tracks(id) on delete set null;

-- ═════════════════════════════════════════════════════════════
-- MUSIC REPORTS  (user complaints about a track — separate queue)
-- ═════════════════════════════════════════════════════════════
create table if not exists public.music_reports (
  id           uuid primary key default gen_random_uuid(),
  track_id     uuid not null references public.music_tracks(id) on delete cascade,
  reporter_id  uuid references public.users(id) on delete set null,
  reason       text not null check (char_length(reason) between 3 and 500),
  status       text not null default 'open'
               check (status in ('open', 'resolved_keep', 'resolved_remove')),
  reviewed_by  uuid references public.users(id) on delete set null,
  review_note  text,
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz
);

create index if not exists music_reports_open_idx on public.music_reports (created_at) where status = 'open';
create index if not exists music_reports_track_idx on public.music_reports (track_id, created_at desc);

-- one open report per user per track
create unique index if not exists music_reports_one_open_per_user
  on public.music_reports (track_id, reporter_id)
  where status = 'open';

-- ═════════════════════════════════════════════════════════════
-- UNIFIED MODERATION QUEUE
--   kinds: music_submission | music_report | verification | milestone | user_report
-- ═════════════════════════════════════════════════════════════
create table if not exists public.moderation_queue (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in (
                 'music_submission',
                 'music_report',
                 'verification',
                 'milestone',
                 'user_report'
               )),
  ref_table    text not null,
  ref_id       uuid not null,
  priority     smallint not null default 0,   -- higher = sooner
  status       text not null default 'pending'
               check (status in ('pending', 'claimed', 'done', 'dismissed')),
  claimed_by   uuid references public.users(id) on delete set null,
  claimed_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists mq_pending_idx
  on public.moderation_queue (priority desc, created_at asc)
  where status in ('pending', 'claimed');
create index if not exists mq_kind_status_idx
  on public.moderation_queue (kind, status, created_at desc);

drop trigger if exists mq_set_updated_at on public.moderation_queue;
create trigger mq_set_updated_at
  before update on public.moderation_queue
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════
-- SUBSCRIBER MILESTONE TRACKING (every 1000 members)
-- ═════════════════════════════════════════════════════════════
create table if not exists public.chat_milestones (
  chat_id       uuid not null references public.chats(id) on delete cascade,
  milestone     int not null check (milestone > 0 and milestone % 1000 = 0),
  reached_at    timestamptz not null default now(),
  primary key (chat_id, milestone)
);

-- triggers: create queue entries for milestones and music submissions
create or replace function public.on_chat_member_added()
returns trigger language plpgsql as $$
declare
  cnt int;
  ms int;
begin
  if new.deleted_at is null and new.banned_at is null then
    select count(*) into cnt from public.chat_members
      where chat_id = new.chat_id and deleted_at is null and banned_at is null;
    if cnt > 0 and cnt % 1000 = 0 then
      ms := cnt;
      insert into public.chat_milestones (chat_id, milestone)
        values (new.chat_id, ms)
        on conflict do nothing;
      if found then
        insert into public.moderation_queue (kind, ref_table, ref_id, priority)
          values ('milestone', 'chat_milestones', new.chat_id, 5);
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists chat_members_milestone on public.chat_members;
create trigger chat_members_milestone
  after insert on public.chat_members
  for each row execute function public.on_chat_member_added();

create or replace function public.on_music_submitted()
returns trigger language plpgsql as $$
declare
  pr smallint := 0;
  verified boolean;
begin
  if new.status = 'pending' then
    select is_verified_artist into verified from public.users where id = new.uploader_id;
    if coalesce(verified, false) then
      pr := 10;
      new.is_pinned_in_queue := true;
    end if;
    insert into public.moderation_queue (kind, ref_table, ref_id, priority)
      values ('music_submission', 'music_tracks', new.id, pr);
  end if;
  return new;
end;
$$;

drop trigger if exists music_tracks_queue on public.music_tracks;
create trigger music_tracks_queue
  after insert on public.music_tracks
  for each row execute function public.on_music_submitted();

-- ═════════════════════════════════════════════════════════════
-- RLS: deny all by default; service_role bypasses.
-- ═════════════════════════════════════════════════════════════
alter table public.communities          enable row level security;
alter table public.chats                enable row level security;
alter table public.chat_members         enable row level security;
alter table public.messages             enable row level security;
alter table public.message_reactions    enable row level security;
alter table public.pinned_messages      enable row level security;
alter table public.saved_messages       enable row level security;
alter table public.music_tracks         enable row level security;
alter table public.music_reports        enable row level security;
alter table public.moderation_queue     enable row level security;
alter table public.chat_milestones      enable row level security;

revoke all on public.communities          from anon, authenticated;
revoke all on public.chats                from anon, authenticated;
revoke all on public.chat_members         from anon, authenticated;
revoke all on public.messages             from anon, authenticated;
revoke all on public.message_reactions    from anon, authenticated;
revoke all on public.pinned_messages      from anon, authenticated;
revoke all on public.saved_messages       from anon, authenticated;
revoke all on public.music_tracks         from anon, authenticated;
revoke all on public.music_reports        from anon, authenticated;
revoke all on public.moderation_queue     from anon, authenticated;
revoke all on public.chat_milestones      from anon, authenticated;