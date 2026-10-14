-- Surface MVP: generic types engine.
-- Tables: workspaces, members, types, records, links, history.
-- Access rules are written once, on these tables; adding a type never needs new tables or rules.

-- ---------------------------------------------------------------------------
-- IDs: 7 base32 chars of Unix seconds + 5 random chars, lowercase Crockford.
-- ---------------------------------------------------------------------------
create or replace function public.surface_id() returns text
language plpgsql volatile as $$
declare
  alphabet constant text := '0123456789abcdefghjkmnpqrstvwxyz';
  t bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  res text := '';
begin
  for i in 1..7 loop
    res := substr(alphabet, (t % 32)::int + 1, 1) || res;
    t := t / 32;
  end loop;
  for i in 1..5 loop
    res := res || substr(alphabet, floor(random() * 32)::int + 1, 1);
  end loop;
  return res;
end $$;

create or replace function public.surface_field_id() returns text
language sql volatile as $$
  select 'f' || substr(md5(random()::text || clock_timestamp()::text), 1, 7)
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id          text primary key default public.surface_id(),
  name        text not null,
  created_by  uuid default auth.uid() references auth.users(id),
  created_at  timestamptz not null default now()
);

create table public.members (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner','admin','member','viewer')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.types (
  id           text primary key default public.surface_id(),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  key          text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  name         text not null,
  icon         text,
  folder       text,                      -- default folder for new records
  fields       jsonb not null default '[]'::jsonb,
  is_builtin   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, key)
);

create table public.records (
  id           text primary key default public.surface_id(),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  type_id      text not null references public.types(id) on delete restrict,
  title        text not null check (length(trim(title)) > 0),
  fields       jsonb not null default '{}'::jsonb,   -- keyed by permanent field id
  body         text not null default '',
  folder       text,
  rev          integer not null default 1,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid(),
  deleted_at   timestamptz
);
create index records_ws_type on public.records (workspace_id, type_id) where deleted_at is null;
create index records_fields on public.records using gin (fields);

create table public.links (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  source_id    text not null references public.records(id) on delete cascade,
  field_id     text not null,
  target_id    text not null references public.records(id) on delete cascade,
  primary key (source_id, field_id, target_id)
);
create index links_target on public.links (target_id);

create table public.history (
  id           bigint generated always as identity primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  record_id    text not null,
  rev          integer not null,
  op           text not null check (op in ('insert','update','delete','restore')),
  type_id      text,
  title        text,
  fields       jsonb,
  body         text,
  folder       text,
  changed_by   uuid default auth.uid(),
  changed_at   timestamptz not null default now()
);
create index history_record on public.history (record_id, rev);

-- ---------------------------------------------------------------------------
-- Membership helpers (security definer so policies don't recurse)
-- ---------------------------------------------------------------------------
create or replace function public.ws_role(ws text) returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where workspace_id = ws and user_id = auth.uid()
$$;

create or replace function public.ws_can_read(ws text) returns boolean
language sql stable as $$ select public.ws_role(ws) is not null $$;

create or replace function public.ws_can_write(ws text) returns boolean
language sql stable as $$ select public.ws_role(ws) in ('owner','admin','member') $$;

create or replace function public.ws_can_admin(ws text) returns boolean
language sql stable as $$ select public.ws_role(ws) in ('owner','admin') $$;

-- ---------------------------------------------------------------------------
-- Type validation: field definitions
-- ---------------------------------------------------------------------------
create or replace function public.types_validate() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  f jsonb;
  res jsonb := '[]'::jsonb;
  keys text[] := '{}';
  ids  text[] := '{}';
  k text; kind text; fid text; tgt text; tgt_id text;
  reserved constant text[] := array['id','type','rev','title','folder','created','updated','created_at','updated_at','body','tags'];
  kinds constant text[] := array['text','number','date','checkbox','select','multi_select','url','email','phone','link'];
  removed text[];
begin
  if jsonb_typeof(new.fields) <> 'array' then
    raise exception 'invalid_type: fields must be a list';
  end if;
  for f in select * from jsonb_array_elements(new.fields) loop
    k := f->>'key';
    kind := coalesce(f->>'kind', 'text');
    if k is null or k !~ '^[a-z][a-z0-9_]*$' then
      raise exception 'invalid_field: key "%" must be lowercase letters, digits or _ and start with a letter', coalesce(k, '');
    end if;
    if k = any(reserved) then
      raise exception 'invalid_field: "%" is a reserved name', k;
    end if;
    if k = any(keys) then
      raise exception 'invalid_field: duplicate field "%"', k;
    end if;
    if not kind = any(kinds) then
      raise exception 'invalid_field: "%" has unknown kind "%" (use one of %)', k, kind, array_to_string(kinds, ', ');
    end if;
    if kind in ('select','multi_select') then
      if jsonb_typeof(f->'options') is distinct from 'array' or jsonb_array_length(f->'options') = 0 then
        raise exception 'invalid_field: "%" (%) needs a list of options', k, kind;
      end if;
    end if;
    if kind = 'link' and f ? 'target' and f->>'target' is not null then
      tgt := f->>'target';
      select id into tgt_id from public.types
        where workspace_id = new.workspace_id and (id = tgt or key = tgt);
      if tgt_id is null and tgt = new.key then tgt_id := new.id; end if;
      if tgt_id is null then
        raise exception 'invalid_field: link field "%" targets unknown type "%"', k, tgt;
      end if;
      f := jsonb_set(f, '{target}', to_jsonb(tgt_id));
    end if;
    fid := coalesce(f->>'id', public.surface_field_id());
    if fid = any(ids) then
      raise exception 'invalid_field: duplicate field id "%"', fid;
    end if;
    f := jsonb_set(f, '{id}', to_jsonb(fid));
    f := jsonb_set(f, '{kind}', to_jsonb(kind));
    if not f ? 'name' then f := jsonb_set(f, '{name}', to_jsonb(initcap(replace(k, '_', ' ')))); end if;
    keys := keys || k;
    ids := ids || fid;
    res := res || jsonb_build_array(f);
  end loop;
  new.fields := res;
  new.updated_at := now();

  -- Removing a field removes its values from every record of this type.
  if tg_op = 'UPDATE' then
    select array_agg(o->>'id') into removed
      from jsonb_array_elements(old.fields) o
      where not (o->>'id') = any(ids);
    if removed is not null then
      update public.records set fields = fields - removed
        where type_id = new.id and fields ?| removed;
      delete from public.links where field_id = any(removed)
        and source_id in (select id from public.records where type_id = new.id);
    end if;
  end if;
  return new;
end $$;

create trigger types_validate before insert or update on public.types
  for each row execute function public.types_validate();

create or replace function public.types_protect_builtin() returns trigger
language plpgsql as $$
begin
  if old.is_builtin then
    raise exception 'invalid_type: "%" is built in and cannot be removed', old.key;
  end if;
  return old;
end $$;

create trigger types_protect_builtin before delete on public.types
  for each row execute function public.types_protect_builtin();

-- ---------------------------------------------------------------------------
-- Record validation (only changed values are checked, so stale values left
-- behind by a type change never block unrelated edits; `surface check` flags them)
-- ---------------------------------------------------------------------------
create or replace function public.validate_value(ws text, def jsonb, val jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  kind text := def->>'kind';
  item jsonb;
  tgt text := def->>'target';
  n int;
begin
  if val is null or val = 'null'::jsonb then
    if coalesce((def->>'required')::boolean, false) then return 'is required'; end if;
    return null;
  end if;
  case kind
    when 'text', 'url', 'email', 'phone' then
      if jsonb_typeof(val) <> 'string' then return 'must be text'; end if;
      if kind = 'email' and val #>> '{}' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return 'must be an email address'; end if;
      if kind = 'url' and val #>> '{}' !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://' then return 'must be a URL (https://…)'; end if;
    when 'number' then
      if jsonb_typeof(val) <> 'number' then return 'must be a number'; end if;
    when 'checkbox' then
      if jsonb_typeof(val) <> 'boolean' then return 'must be true or false'; end if;
    when 'date' then
      if jsonb_typeof(val) <> 'string' or val #>> '{}' !~ '^\d{4}-\d{2}-\d{2}$' then return 'must be a date (YYYY-MM-DD)'; end if;
      begin perform (val #>> '{}')::date; exception when others then return 'is not a real date'; end;
    when 'select' then
      if jsonb_typeof(val) <> 'string' or not (def->'options') ? (val #>> '{}') then
        return 'must be one of: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(def->'options') x);
      end if;
    when 'multi_select' then
      if jsonb_typeof(val) <> 'array' then return 'must be a list'; end if;
      for item in select * from jsonb_array_elements(val) loop
        if jsonb_typeof(item) <> 'string' or not (def->'options') ? (item #>> '{}') then
          return 'values must be from: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(def->'options') x);
        end if;
      end loop;
    when 'link' then
      if jsonb_typeof(val) = 'string' then val := jsonb_build_array(val);
      elsif jsonb_typeof(val) <> 'array' then return 'must be a record id or a list of ids'; end if;
      if not coalesce((def->>'multiple')::boolean, false) and jsonb_array_length(val) > 1 then
        return 'takes one link (field is not multiple)';
      end if;
      for item in select * from jsonb_array_elements(val) loop
        select count(*) into n from public.records r
          where r.id = item #>> '{}' and r.workspace_id = ws and r.deleted_at is null
            and (tgt is null or r.type_id = tgt);
        if n = 0 then return 'links to a missing record or the wrong type: ' || (item #>> '{}'); end if;
      end loop;
    else
      return 'has unknown kind ' || coalesce(kind, '?');
  end case;
  return null;
end $$;

create or replace function public.records_validate() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  t public.types%rowtype;
  def jsonb;
  k text;
  msg text;
  errors text[] := '{}';
  known text[];
begin
  select * into t from public.types where id = new.type_id;
  if t.workspace_id <> new.workspace_id then
    raise exception 'invalid_record: type belongs to another workspace';
  end if;
  if jsonb_typeof(new.fields) <> 'object' then
    raise exception 'invalid_record: fields must be an object';
  end if;
  select array_agg(d->>'id') into known from jsonb_array_elements(t.fields) d;
  if tg_op = 'UPDATE' and new.type_id <> old.type_id then
    -- type changed: drop values the new type doesn't have
    new.fields := (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                     from jsonb_each(new.fields) where known is not null and key = any(known));
  end if;
  for k in select jsonb_object_keys(new.fields) loop
    if known is null or not k = any(known) then
      errors := errors || format('unknown field id %s', k);
    end if;
  end loop;
  for def in select * from jsonb_array_elements(t.fields) loop
    if tg_op = 'INSERT' or new.type_id <> old.type_id
       or (new.fields -> (def->>'id')) is distinct from (old.fields -> (def->>'id')) then
      msg := validate_value(new.workspace_id, def, new.fields -> (def->>'id'));
      if msg is not null then errors := errors || format('%s %s', def->>'key', msg); end if;
    end if;
  end loop;
  if array_length(errors, 1) > 0 then
    raise exception 'invalid_record: %', array_to_string(errors, '; ');
  end if;

  if tg_op = 'UPDATE' then
    if (new.title, new.fields, new.body, new.folder, new.type_id, new.deleted_at)
       is not distinct from (old.title, old.fields, old.body, old.folder, old.type_id, old.deleted_at) then
      return null;  -- nothing changed: skip the write, keep rev
    end if;
    new.rev := old.rev + 1;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  else
    new.rev := 1;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

create trigger records_validate before insert or update on public.records
  for each row execute function public.records_validate();

-- History + links, maintained by the database so every client gets them.
create or replace function public.records_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  def jsonb; val jsonb; item jsonb;
  op text;
begin
  op := case
    when tg_op = 'INSERT' then 'insert'
    when new.deleted_at is not null and old.deleted_at is null then 'delete'
    when new.deleted_at is null and old.deleted_at is not null then 'restore'
    else 'update' end;
  insert into public.history (workspace_id, record_id, rev, op, type_id, title, fields, body, folder)
    values (new.workspace_id, new.id, new.rev, op, new.type_id, new.title, new.fields, new.body, new.folder);

  delete from public.links where source_id = new.id;
  if new.deleted_at is null then
    for def in select d from public.types t, jsonb_array_elements(t.fields) d
               where t.id = new.type_id and d->>'kind' = 'link' loop
      val := new.fields -> (def->>'id');
      if val is null or val = 'null'::jsonb then continue; end if;
      if jsonb_typeof(val) = 'string' then val := jsonb_build_array(val); end if;
      for item in select * from jsonb_array_elements(val) loop
        insert into public.links (workspace_id, source_id, field_id, target_id)
          values (new.workspace_id, new.id, def->>'id', item #>> '{}')
          on conflict do nothing;
      end loop;
    end loop;
  end if;
  return null;
end $$;

create trigger records_after after insert or update on public.records
  for each row execute function public.records_after();

-- ---------------------------------------------------------------------------
-- New workspaces: owner membership + the built-in "page" type
-- ---------------------------------------------------------------------------
create or replace function public.create_workspace(p_name text) returns public.workspaces
language plpgsql security definer set search_path = public as $$
declare ws public.workspaces;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  insert into public.workspaces (name, created_by) values (p_name, auth.uid()) returning * into ws;
  insert into public.members (workspace_id, user_id, role) values (ws.id, auth.uid(), 'owner');
  insert into public.types (workspace_id, key, name, folder, is_builtin)
    values (ws.id, 'page', 'Page', 'Pages', true);
  return ws;
end $$;

-- ---------------------------------------------------------------------------
-- push_record: the one write path used by `surface push`, `new` and `set`.
-- Fields arrive keyed by field KEY; stored by permanent field ID.
-- Rejects with 'conflict:' when the record changed since base_rev.
-- ---------------------------------------------------------------------------
create or replace function public.push_record(
  p_workspace text,
  p_id        text,
  p_base_rev  integer,
  p_type      text,
  p_title     text,
  p_fields    jsonb,
  p_body      text,
  p_folder    text default null
) returns public.records
language plpgsql security invoker set search_path = public as $$
declare
  t public.types%rowtype;
  cur public.records%rowtype;
  stored jsonb := '{}'::jsonb;
  k text; def jsonb; unknown text[] := '{}';
  result public.records;
begin
  select * into t from public.types where workspace_id = p_workspace and (key = p_type or id = p_type);
  if t.id is null then raise exception 'invalid_record: unknown type "%"', p_type; end if;

  for k in select jsonb_object_keys(coalesce(p_fields, '{}'::jsonb)) loop
    def := null;
    select d into def from jsonb_array_elements(t.fields) d where d->>'key' = k;
    if def is null then unknown := unknown || k;
    elsif p_fields->k <> 'null'::jsonb then stored := stored || jsonb_build_object(def->>'id', p_fields->k);
    end if;
  end loop;
  if array_length(unknown, 1) > 0 then
    raise exception 'invalid_record: % has no field(s): %', t.key, array_to_string(unknown, ', ');
  end if;

  if p_id is null then
    insert into public.records (workspace_id, type_id, title, fields, body, folder)
      values (p_workspace, t.id, p_title, stored, coalesce(p_body, ''), coalesce(p_folder, t.folder))
      returning * into result;
    return result;
  end if;

  select * into cur from public.records where id = p_id and workspace_id = p_workspace for update;
  if cur.id is null then
    -- a file carrying an id that isn't in the database yet (e.g. imported): create with that id
    insert into public.records (id, workspace_id, type_id, title, fields, body, folder)
      values (p_id, p_workspace, t.id, p_title, stored, coalesce(p_body, ''), coalesce(p_folder, t.folder))
      returning * into result;
    return result;
  end if;
  if cur.deleted_at is not null then
    raise exception 'deleted: % was deleted (rev %); restore it with `surface restore`', p_id, cur.rev;
  end if;
  if p_base_rev is not null and cur.rev <> p_base_rev then
    raise exception 'conflict: % changed since rev % (now rev %)', p_id, p_base_rev, cur.rev;
  end if;
  update public.records
     set type_id = t.id, title = p_title, fields = stored, body = coalesce(p_body, ''),
         folder = coalesce(p_folder, cur.folder)
   where id = p_id
   returning * into result;
  if result.id is null then  -- no change
    select * into result from public.records where id = p_id;
  end if;
  return result;
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security: written once, for every type
-- ---------------------------------------------------------------------------
alter table public.workspaces enable row level security;
alter table public.members    enable row level security;
alter table public.types      enable row level security;
alter table public.records    enable row level security;
alter table public.links      enable row level security;
alter table public.history    enable row level security;

create policy ws_read   on public.workspaces for select to authenticated using (public.ws_can_read(id));
create policy ws_update on public.workspaces for update to authenticated using (public.ws_role(id) = 'owner');
create policy ws_delete on public.workspaces for delete to authenticated using (public.ws_role(id) = 'owner');

create policy mem_read  on public.members for select to authenticated using (public.ws_can_read(workspace_id));
create policy mem_write on public.members for all    to authenticated
  using (public.ws_can_admin(workspace_id)) with check (public.ws_can_admin(workspace_id));

create policy types_read  on public.types for select to authenticated using (public.ws_can_read(workspace_id));
create policy types_write on public.types for all    to authenticated
  using (public.ws_can_admin(workspace_id)) with check (public.ws_can_admin(workspace_id));

create policy rec_read  on public.records for select to authenticated using (public.ws_can_read(workspace_id));
create policy rec_write on public.records for all    to authenticated
  using (public.ws_can_write(workspace_id)) with check (public.ws_can_write(workspace_id));

create policy links_read on public.links   for select to authenticated using (public.ws_can_read(workspace_id));
create policy hist_read  on public.history for select to authenticated using (public.ws_can_read(workspace_id));

revoke all on function public.create_workspace(text) from anon;
revoke all on function public.push_record(text,text,integer,text,text,jsonb,text,text) from anon;
