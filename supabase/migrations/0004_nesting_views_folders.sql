-- Nesting, saved views and folder tools.
-- 1. records.parent_id: Notion-style pages in pages (one parent, any type, no cycles).
-- 2. views: saved view definitions (the Views tree is the view with key 'sidebar').
-- 3. rename_folder(): move every record under one folder to another, in one statement.
-- 4. push_record gains p_parent (null = keep, '' = clear, id = set).

-- 1. parent ------------------------------------------------------------------
alter table public.records add column parent_id text references public.records(id) on delete set null;
create index records_parent on public.records (parent_id) where parent_id is not null;
alter table public.history add column parent_id text;

-- 'parent' becomes a reserved field key
create or replace function surface_private.types_validate() returns trigger
language plpgsql security definer set search_path = public, surface_private as $$
declare
  f jsonb;
  res jsonb := '[]'::jsonb;
  keys text[] := '{}';
  ids  text[] := '{}';
  k text; kind text; fid text; tgt text; tgt_id text;
  reserved constant text[] := array['id','type','rev','title','folder','parent','created','updated','created_at','updated_at','body','tags'];
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

-- validation now covers parent_id, and parent changes count as changes
create or replace function surface_private.records_validate() returns trigger
language plpgsql security definer set search_path = public, surface_private as $$
declare
  t public.types%rowtype;
  def jsonb;
  k text;
  msg text;
  errors text[] := '{}';
  known text[];
  cyc boolean;
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

  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id) then
    if new.parent_id = new.id then
      errors := errors || 'parent: a record can''t be its own parent'::text;
    elsif not exists (select 1 from public.records
                      where id = new.parent_id and workspace_id = new.workspace_id and deleted_at is null) then
      errors := errors || format('parent: no record %s in this workspace', new.parent_id);
    else
      with recursive up(id, parent_id, depth) as (
        select id, parent_id, 1 from public.records where id = new.parent_id
        union all
        select r.id, r.parent_id, up.depth + 1 from public.records r join up on r.id = up.parent_id
        where up.depth < 100
      ) select exists (select 1 from up where id = new.id) into cyc;
      if cyc then errors := errors || 'parent: that would nest the record inside itself'::text; end if;
    end if;
  end if;

  if array_length(errors, 1) > 0 then
    raise exception 'invalid_record: %', array_to_string(errors, '; ');
  end if;

  if tg_op = 'UPDATE' then
    if (new.title, new.fields, new.body, new.folder, new.type_id, new.deleted_at, new.parent_id)
       is not distinct from (old.title, old.fields, old.body, old.folder, old.type_id, old.deleted_at, old.parent_id) then
      return null;
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

create or replace function surface_private.records_after() returns trigger
language plpgsql security definer set search_path = public, surface_private as $$
declare
  def jsonb; val jsonb; item jsonb;
  op text;
begin
  op := case
    when tg_op = 'INSERT' then 'insert'
    when new.deleted_at is not null and old.deleted_at is null then 'delete'
    when new.deleted_at is null and old.deleted_at is not null then 'restore'
    else 'update' end;
  insert into public.history (workspace_id, record_id, rev, op, type_id, title, fields, body, folder, parent_id)
    values (new.workspace_id, new.id, new.rev, op, new.type_id, new.title, new.fields, new.body, new.folder, new.parent_id);

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
revoke all on function surface_private.records_validate() from public, anon, authenticated;
revoke all on function surface_private.records_after() from public, anon, authenticated;
revoke all on function surface_private.types_validate() from public, anon, authenticated;

-- 2. views -------------------------------------------------------------------
create table public.views (
  id           text primary key default public.surface_id(),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  key          text not null check (key ~ '^[a-z0-9][a-z0-9_-]*$'),
  name         text not null,
  definition   jsonb not null default '{}'::jsonb check (jsonb_typeof(definition) = 'object'),
  rev          integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid(),
  unique (workspace_id, key)
);
alter table public.views enable row level security;
create policy views_read  on public.views for select to authenticated using (public.ws_can_read(workspace_id));
create policy views_write on public.views for all    to authenticated
  using (public.ws_can_write(workspace_id)) with check (public.ws_can_write(workspace_id));

-- save_view: create or update a view with a revision check ('conflict:' like push_record)
create or replace function public.save_view(
  p_workspace text, p_key text, p_name text, p_definition jsonb, p_base_rev integer default null
) returns public.views
language plpgsql security invoker set search_path = public as $$
declare
  cur public.views%rowtype;
  result public.views;
begin
  select * into cur from public.views where workspace_id = p_workspace and key = p_key for update;
  if cur.id is null then
    insert into public.views (workspace_id, key, name, definition)
      values (p_workspace, p_key, coalesce(p_name, p_key), p_definition)
      returning * into result;
    return result;
  end if;
  if p_base_rev is not null and cur.rev <> p_base_rev then
    raise exception 'conflict: view % changed since rev % (now rev %)', p_key, p_base_rev, cur.rev;
  end if;
  if cur.definition = p_definition and cur.name = coalesce(p_name, cur.name) then
    return cur;
  end if;
  update public.views
     set definition = p_definition, name = coalesce(p_name, cur.name),
         rev = cur.rev + 1, updated_at = now(), updated_by = auth.uid()
   where id = cur.id
   returning * into result;
  return result;
end $$;
revoke all on function public.save_view(text,text,text,jsonb,integer) from public, anon;
grant execute on function public.save_view(text,text,text,jsonb,integer) to authenticated;

-- 3. rename_folder -------------------------------------------------------------
create or replace function public.rename_folder(p_workspace text, p_old text, p_new text)
returns integer
language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  p_old := trim(both '/' from p_old);
  p_new := trim(both '/' from coalesce(p_new, ''));
  if p_old = '' then raise exception 'invalid_folder: give the folder to rename'; end if;
  update public.records
     set folder = case when folder = p_old then p_new
                       else ltrim(p_new || '/' || substr(folder, length(p_old) + 2), '/') end
   where workspace_id = p_workspace and deleted_at is null
     and (folder = p_old or folder like p_old || '/%');
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.rename_folder(text,text,text) from public, anon;
grant execute on function public.rename_folder(text,text,text) to authenticated;

-- 4. push_record with p_parent ---------------------------------------------------
drop function public.push_record(text,text,integer,text,text,jsonb,text,text);
create function public.push_record(
  p_workspace text,
  p_id        text,
  p_base_rev  integer,
  p_type      text,
  p_title     text,
  p_fields    jsonb,
  p_body      text,
  p_folder    text default null,
  p_parent    text default null   -- null = keep, '' = clear, id = set
) returns public.records
language plpgsql security invoker set search_path = public as $$
declare
  t public.types%rowtype;
  cur public.records%rowtype;
  stored jsonb := '{}'::jsonb;
  k text; def jsonb; unknown text[] := '{}';
  result public.records;
  new_parent text := nullif(p_parent, '');
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

  if p_id is not null then
    select * into cur from public.records where id = p_id and workspace_id = p_workspace for update;
  end if;

  if cur.id is null then
    insert into public.records (id, workspace_id, type_id, title, fields, body, folder, parent_id)
      values (coalesce(p_id, public.surface_id()), p_workspace, t.id, p_title, stored,
              coalesce(p_body, ''), coalesce(p_folder, t.folder), new_parent)
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
         folder = coalesce(p_folder, cur.folder),
         parent_id = case when p_parent is null then cur.parent_id else new_parent end
   where id = p_id
   returning * into result;
  if result.id is null then
    select * into result from public.records where id = p_id;
  end if;
  return result;
end $$;
revoke all on function public.push_record(text,text,integer,text,text,jsonb,text,text,text) from public, anon;
grant execute on function public.push_record(text,text,integer,text,text,jsonb,text,text,text) to authenticated;
