-- Покер планирование (Supabase) — схема базы
-- Выполните ТОЛЬКО ОДИН РАЗ в Supabase Dashboard → SQL Editor → New query → Run.
-- Скрипт идемпотентен: повторный запуск не сломает.

-- Три таблицы: комната (status/timer/result) и две дочерние (участники, голоса).
-- Состояние живёт на сервере, поэтому переживает отключение любого — включая ведущего.

create table if not exists public.rooms (
  id text primary key,
  status text not null default 'idle',
  timer jsonb,
  result jsonb,
  created_at bigint not null
);

create table if not exists public.participants (
  room_id text not null references public.rooms(id) on delete cascade,
  uid text not null,
  name text not null,
  role text not null default 'participant',
  joined_at bigint not null,
  primary key (room_id, uid)
);

create table if not exists public.votes (
  room_id text not null references public.rooms(id) on delete cascade,
  uid text not null,
  name text not null,
  value text not null,
  primary key (room_id, uid)
);

-- RLS намеренно отключён: данные «открытые» (как были открытые правила Firebase).
-- Анонимный ключ Supabase по дизайну публичный — он не секрет.

-- Realtime: нужны полные записи в событиях удаления (uid), чтобы клиент умел
-- подчищать локальное состояние, поэтому replica identity full.
alter table public.participants replica identity full;
alter table public.votes replica identity full;
alter table public.rooms replica identity full;

-- Включаем realtime для таблиц (идемпотентно).
do $$
declare t text;
begin
  foreach t in array array['rooms', 'participants', 'votes'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- RPC выхода: удаляем себя из участников; если участников не осталось —
-- атомарно удаляем комнату и её голоса (каскадом).
create or replace function public.leave_room(room_id text, uid text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.participants
  where participants.room_id = leave_room.room_id
    and participants.uid = leave_room.uid;

  if not exists (
    select 1 from public.participants
    where participants.room_id = leave_room.room_id
  ) then
    delete from public.rooms where rooms.id = leave_room.room_id;
  end if;
end;
$$;

-- Клиент (anonymized role) уже имеет права на эти действия: функции и таблицы
-- доступны публично, т.к. RLS выключен и обычные GRANT по умолчанию выданы.