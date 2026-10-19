-- 0006: links that survive renames, and aliases.
--
-- Pages store links to other records by id: [[id:<record id>]], optionally with a heading and a
-- label, [[id:<id>#Heading|label]]. Every surface renders them with the target's current name
-- (a vault writes [[Current Title]]), so a rename updates every link without rewriting anything.
-- Text that matches no record stays as typed ([[Some note]]) and is listed as unresolved.
--
-- records.aliases: other names a record answers to (Obsidian's `aliases`). Used to resolve what
-- someone typed; stored as a plain list.
--
-- public.links now also holds links from page text: field_id = 'body'.

alter table public.records add column if not exists aliases text[] not null default '{}';
alter table public.history add column if not exists aliases text[];

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
    if (new.title, new.fields, new.body, new.folder, new.type_id, new.deleted_at, new.parent_id, new.aliases)
       is not distinct from (old.title, old.fields, old.body, old.folder, old.type_id, old.deleted_at, old.parent_id, old.aliases) then
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
  target text;
begin
  op := case
    when tg_op = 'INSERT' then 'insert'
    when new.deleted_at is not null and old.deleted_at is null then 'delete'
    when new.deleted_at is null and old.deleted_at is not null then 'restore'
    else 'update' end;
  insert into public.history (workspace_id, record_id, rev, op, type_id, title, fields, body, folder, parent_id, aliases)
    values (new.workspace_id, new.id, new.rev, op, new.type_id, new.title, new.fields, new.body, new.folder, new.parent_id, new.aliases);

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
    -- links in the page text: [[id:<id>…]] (and embeds, ![[id:<id>…]])
    for target in select distinct m[1] from regexp_matches(new.body, '\[\[id:([0-9a-z]+)', 'g') m loop
      insert into public.links (workspace_id, source_id, field_id, target_id)
        select new.workspace_id, new.id, 'body', r.id from public.records r
         where r.id = target and r.workspace_id = new.workspace_id and r.id <> new.id
        on conflict do nothing;
    end loop;
  end if;
  return null;
end $$;
revoke all on function surface_private.records_validate() from public, anon, authenticated;
revoke all on function surface_private.records_after() from public, anon, authenticated;

-- push_record with aliases (null = keep, '{}' = clear)
drop function public.push_record(text,text,integer,text,text,jsonb,text,text,text);
create function public.push_record(
  p_workspace text,
  p_id        text,
  p_base_rev  integer,
  p_type      text,
  p_title     text,
  p_fields    jsonb,
  p_body      text,
  p_folder    text default null,
  p_parent    text default null,  -- null = keep, '' = clear, id = set
  p_aliases   text[] default null -- null = keep
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
    insert into public.records (id, workspace_id, type_id, title, fields, body, folder, parent_id, aliases)
      values (coalesce(p_id, public.surface_id()), p_workspace, t.id, p_title, stored,
              coalesce(p_body, ''), coalesce(p_folder, t.folder), new_parent, coalesce(p_aliases, '{}'))
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
         parent_id = case when p_parent is null then cur.parent_id else new_parent end,
         aliases = coalesce(p_aliases, cur.aliases)
   where id = p_id
   returning * into result;
  if result.id is null then
    select * into result from public.records where id = p_id;
  end if;
  return result;
end $$;
revoke all on function public.push_record(text,text,integer,text,text,jsonb,text,text,text,text[]) from public, anon;
grant execute on function public.push_record(text,text,integer,text,text,jsonb,text,text,text,text[]) to authenticated;
