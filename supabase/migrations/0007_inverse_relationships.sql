-- 0007: editable inverse links, stored once on the forward field.
-- `inverse` is the permanent id of an ordinary link on `target`, pointing back
-- to this type. Inverses are always optional multi-links and never record values.
-- Local stores load this migration on their next database open. Cloud projects
-- must apply it before syncing inverse-bearing schemas (`surface cloud schema --since 7`).

alter table public.records add column relationship_rev bigint not null default 0;

-- A scalar conflict clock, not a second copy of relationships. Forward changes
-- touch inverse owners so their ordinary rev invalidates stale reverse editors.
create function surface_private.link_ids(val jsonb) returns text[]
language sql immutable security invoker set search_path = public as $$
  select case jsonb_typeof(val)
    when 'string' then array[val #>> '{}']
    when 'array' then array(select distinct item #>> '{}' from jsonb_array_elements(val) item
                            where jsonb_typeof(item) = 'string' order by 1)
    else '{}'::text[] end
$$;
revoke all on function surface_private.link_ids(jsonb) from public, anon;
grant execute on function surface_private.link_ids(jsonb) to authenticated;

create or replace function surface_private.types_validate() returns trigger
language plpgsql security definer set search_path = public, surface_private as $$
declare
  f jsonb;
  res jsonb := '[]'::jsonb;
  keys text[] := '{}';
  ids text[] := '{}';
  k text; kind text; fid text; tgt text; tgt_id text;
  source_def jsonb; source_fields jsonb; dependency record;
  reserved constant text[] := array['id','type','rev','title','folder','parent','created','updated','created_at','updated_at','body','tags'];
  kinds constant text[] := array['text','number','date','checkbox','select','multi_select','url','email','phone','link'];
  removed text[];
begin
  -- Serialize schema validation, including cross-type dependencies, per workspace.
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id, 7));
  if tg_op = 'UPDATE' and new.workspace_id <> old.workspace_id then
    raise exception 'invalid_type: a type cannot move to another workspace';
  end if;
  if jsonb_typeof(new.fields) is distinct from 'array' then
    raise exception 'invalid_type: fields must be a list';
  end if;
  for f in select * from jsonb_array_elements(new.fields) loop
    k := f->>'key';
    kind := coalesce(f->>'kind', 'text');
    if k is null or k !~ '^[a-z][a-z0-9_]*$' then
      raise exception 'invalid_field: key "%" must be lowercase letters, digits or _ and start with a letter', coalesce(k, '');
    end if;
    if k = any(reserved) then raise exception 'invalid_field: "%" is a reserved name', k; end if;
    if k = any(keys) then raise exception 'invalid_field: duplicate field "%"', k; end if;
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
      tgt_id := null;
      if tgt = new.key or tgt = new.id then tgt_id := new.id;
      else
        select id into tgt_id from public.types where workspace_id = new.workspace_id and (id = tgt or key = tgt);
      end if;
      if tgt_id is null then raise exception 'invalid_field: link field "%" targets unknown type "%"', k, tgt; end if;
      f := jsonb_set(f, '{target}', to_jsonb(tgt_id));
    end if;
    fid := coalesce(f->>'id', public.surface_field_id());
    if fid = any(ids) then raise exception 'invalid_field: duplicate field id "%"', fid; end if;
    f := jsonb_set(f, '{id}', to_jsonb(fid));
    f := jsonb_set(f, '{kind}', to_jsonb(kind));
    if not f ? 'name' then f := jsonb_set(f, '{name}', to_jsonb(initcap(replace(k, '_', ' ')))); end if;
    keys := keys || k;
    ids := ids || fid;
    res := res || jsonb_build_array(f);
  end loop;
  new.fields := res;
  new.updated_at := now();

  for f in select d from jsonb_array_elements(new.fields) d where d ? 'inverse' loop
    if f->>'kind' <> 'link' or f->'multiple' is distinct from 'true'::jsonb
       or coalesce((f->>'required')::boolean, false)
       or jsonb_typeof(f->'inverse') is distinct from 'string' or f->>'inverse' = ''
       or f->>'target' is null then
      raise exception 'invalid_field: inverse "%" must be an optional multiple link with a target and source field id', f->>'key';
    end if;
    if f->>'target' = new.id then source_fields := new.fields;
    else
      select fields into source_fields from public.types where id = f->>'target' and workspace_id = new.workspace_id;
    end if;
    source_def := null;
    select d into source_def from jsonb_array_elements(source_fields) d where d->>'id' = f->>'inverse';
    if source_def is null or source_def->>'kind' <> 'link' or source_def ? 'inverse'
       or source_def->>'target' is distinct from new.id then
      raise exception 'invalid_field: inverse "%" must reference a stored link back to this type in this workspace', f->>'key';
    end if;
    if exists (select 1 from public.records where type_id = new.id and fields ? (f->>'id')) then
      raise exception 'invalid_field: inverse "%" still has stored values; remove those values before making it computed', f->>'key';
    end if;
  end loop;

  -- A forward field cannot disappear or change meaning while an inverse uses it.
  for dependency in
    select t.id, d from public.types t, jsonb_array_elements(t.fields) d
     where t.workspace_id = new.workspace_id and t.id <> new.id
       and d ? 'inverse' and d->>'target' = new.id
  loop
    source_def := null;
    select d into source_def from jsonb_array_elements(new.fields) d where d->>'id' = dependency.d->>'inverse';
    if source_def is null or source_def->>'kind' <> 'link' or source_def ? 'inverse'
       or source_def->>'target' is distinct from dependency.id then
      raise exception 'invalid_field: stored link is still used by inverse "%"; remove the inverse first', dependency.d->>'key';
    end if;
  end loop;

  if tg_op = 'UPDATE' then
    select array_agg(o->>'id') into removed from jsonb_array_elements(old.fields) o where not (o->>'id') = any(ids);
    if removed is not null then
      update public.records set fields = fields - removed where type_id = new.id and fields ?| removed;
      delete from public.links where field_id = any(removed)
        and source_id in (select id from public.records where type_id = new.id);
    end if;
  end if;
  return new;
end $$;

create function surface_private.types_inverse_delete() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  -- Workspace cascades remove both sides together, like the built-in type guard.
  if not exists (select 1 from public.workspaces where id = old.workspace_id) then return old; end if;
  perform pg_advisory_xact_lock(hashtextextended(old.workspace_id, 7));
  if exists (select 1 from public.types t, jsonb_array_elements(t.fields) d
              where t.workspace_id = old.workspace_id and t.id <> old.id
                and d ? 'inverse' and d->>'target' = old.id) then
    raise exception 'invalid_type: remove inverse fields targeting this type before deleting it';
  end if;
  return old;
end $$;
create trigger types_inverse_delete before delete on public.types
  for each row execute function surface_private.types_inverse_delete();

-- Keep aliases, parent validation and history behavior from 0006. Raw writes are
-- deliberately rejected when they try to persist an inverse, even as JSON null.
create or replace function surface_private.records_validate() returns trigger
language plpgsql security definer set search_path = public, surface_private as $$
declare
  t public.types%rowtype;
  def jsonb; k text; msg text;
  errors text[] := '{}'; known text[]; cyc boolean;
begin
  select * into t from public.types where id = new.type_id;
  if t.workspace_id <> new.workspace_id then raise exception 'invalid_record: type belongs to another workspace'; end if;
  if jsonb_typeof(new.fields) is distinct from 'object' then raise exception 'invalid_record: fields must be an object'; end if;
  select array_agg(d->>'id') into known from jsonb_array_elements(t.fields) d;
  if tg_op = 'UPDATE' and new.type_id <> old.type_id then
    new.fields := (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                     from jsonb_each(new.fields) where known is not null and key = any(known));
  end if;
  for k in select jsonb_object_keys(new.fields) loop
    if known is null or not k = any(known) then errors := errors || format('unknown field id %s', k); end if;
  end loop;
  for def in select * from jsonb_array_elements(t.fields) loop
    if def ? 'inverse' then
      if new.fields ? (def->>'id') then errors := errors || format('%s is computed and cannot be stored', def->>'key'); end if;
      continue;
    end if;
    if tg_op = 'INSERT' or new.type_id <> old.type_id
       or (new.fields -> (def->>'id')) is distinct from (old.fields -> (def->>'id')) then
      if def->>'kind' = 'link' and coalesce((def->>'required')::boolean, false)
         and new.fields -> (def->>'id') = '[]'::jsonb then msg := 'is required';
      else msg := validate_value(new.workspace_id, def, new.fields -> (def->>'id'));
      end if;
      if msg is not null then errors := errors || format('%s %s', def->>'key', msg); end if;
    end if;
  end loop;
  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id) then
    if new.parent_id = new.id then errors := errors || 'parent: a record can''t be its own parent'::text;
    elsif not exists (select 1 from public.records where id = new.parent_id and workspace_id = new.workspace_id and deleted_at is null) then
      errors := errors || format('parent: no record %s in this workspace', new.parent_id);
    else
      with recursive up(id, parent_id, depth) as (
        select id, parent_id, 1 from public.records where id = new.parent_id
        union all select r.id, r.parent_id, up.depth + 1 from public.records r join up on r.id = up.parent_id where up.depth < 100
      ) select exists (select 1 from up where id = new.id) into cyc;
      if cyc then errors := errors || 'parent: that would nest the record inside itself'::text; end if;
    end if;
  end if;
  if array_length(errors, 1) > 0 then raise exception 'invalid_record: %', array_to_string(errors, '; '); end if;
  if tg_op = 'UPDATE' then
    if (new.title, new.fields, new.body, new.folder, new.type_id, new.deleted_at, new.parent_id, new.aliases, new.relationship_rev)
       is not distinct from (old.title, old.fields, old.body, old.folder, old.type_id, old.deleted_at, old.parent_id, old.aliases, old.relationship_rev) then
      return null;
    end if;
    new.rev := old.rev + 1;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  else new.rev := 1;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- Invoker, not definer: reverse side effects obey the same RLS as source writes.
-- Only membership changes touch owners; unrelated edits and recursive clock-only
-- updates do nothing. Deleted sources disappear and restored sources reappear.
create function surface_private.records_inverse_touch() returns trigger
language plpgsql security invoker set search_path = public, surface_private as $$
declare
  before_row public.records%rowtype; after_row public.records%rowtype;
  owner record; before_ids text[]; after_ids text[]; changed text[];
  ws text;
begin
  if tg_op = 'UPDATE' and (new.fields, new.type_id, new.deleted_at, new.workspace_id)
     is not distinct from (old.fields, old.type_id, old.deleted_at, old.workspace_id) then
    return null;
  end if;
  if tg_op <> 'INSERT' then before_row := old; end if;
  if tg_op <> 'DELETE' then after_row := new; end if;
  ws := coalesce(after_row.workspace_id, before_row.workspace_id);
  if not exists (select 1 from public.workspaces where id = ws) then return null; end if;
  for owner in
    select distinct t.id as type_id, d->>'target' as source_type, d->>'inverse' as field_id
      from public.types t, jsonb_array_elements(t.fields) d
     where t.workspace_id = ws and d ? 'inverse'
       and (d->>'target' = before_row.type_id or d->>'target' = after_row.type_id)
  loop
    before_ids := '{}'; after_ids := '{}';
    if before_row.deleted_at is null and before_row.type_id = owner.source_type then
      before_ids := surface_private.link_ids(before_row.fields -> owner.field_id);
    end if;
    if after_row.deleted_at is null and after_row.type_id = owner.source_type then
      after_ids := surface_private.link_ids(after_row.fields -> owner.field_id);
    end if;
    if before_ids = after_ids then continue; end if;
    select array_agg(id order by id) into changed from (
      (select unnest(before_ids) as id except select unnest(after_ids))
      union (select unnest(after_ids) as id except select unnest(before_ids))
    ) delta;
    if changed is not null then
      -- Row locks serialize a reverse replacement against changes to its sources.
      perform id from public.records where workspace_id = ws and type_id = owner.type_id and id = any(changed) order by id for update;
      update public.records set relationship_rev = relationship_rev + 1
       where workspace_id = ws and type_id = owner.type_id and id = any(changed);
    end if;
  end loop;
  return null;
end $$;
create trigger records_inverse_touch after insert or update or delete on public.records
  for each row execute function surface_private.records_inverse_touch();

create or replace function public.push_record(
  p_workspace text, p_id text, p_base_rev integer, p_type text,
  p_title text, p_fields jsonb, p_body text, p_folder text default null,
  p_parent text default null, p_aliases text[] default null
) returns public.records
language plpgsql security invoker set search_path = public, surface_private as $$
declare
  t public.types%rowtype; cur public.records%rowtype; result public.records;
  stored jsonb := '{}'::jsonb; inverses jsonb := '{}'::jsonb;
  k text; def jsonb; source_def jsonb; val jsonb; item jsonb;
  unknown text[] := '{}'; desired text[]; existing text[]; replacement text[];
  source public.records%rowtype; new_parent text := nullif(p_parent, '');
begin
  if not coalesce(public.ws_can_write(p_workspace), false) then
    raise exception 'permission denied: this workspace is not writable';
  end if;
  -- Shared locks permit concurrent record writes but keep relationship schemas
  -- stable until every canonical source update in this RPC has completed.
  perform pg_advisory_xact_lock_shared(hashtextextended(p_workspace, 7));
  if p_fields is not null and jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_record: fields must be an object';
  end if;
  select * into t from public.types where workspace_id = p_workspace and (key = p_type or id = p_type);
  if t.id is null then raise exception 'invalid_record: unknown type "%"', p_type; end if;
  for k in select jsonb_object_keys(coalesce(p_fields, '{}'::jsonb)) loop
    def := null;
    select d into def from jsonb_array_elements(t.fields) d where d->>'key' = k;
    if def is null then unknown := unknown || k;
    elsif def ? 'inverse' then
      val := p_fields->k;
      if val = 'null'::jsonb then val := '[]'::jsonb;
      elsif jsonb_typeof(val) = 'string' then val := jsonb_build_array(val);
      elsif jsonb_typeof(val) <> 'array' then raise exception 'invalid_record: % must be a record id or a list of ids', k;
      end if;
      for item in select * from jsonb_array_elements(val) loop
        if jsonb_typeof(item) <> 'string' or not exists (
          select 1 from public.records where id = item #>> '{}' and workspace_id = p_workspace
            and type_id = def->>'target' and deleted_at is null
        ) then raise exception 'invalid_record: % links to a missing record or the wrong type', k;
        end if;
      end loop;
      inverses := inverses || jsonb_build_object(def->>'id', to_jsonb(surface_private.link_ids(val)));
    elsif p_fields->k <> 'null'::jsonb then stored := stored || jsonb_build_object(def->>'id', p_fields->k);
    end if;
  end loop;
  if array_length(unknown, 1) > 0 then
    raise exception 'invalid_record: % has no field(s): %', t.key, array_to_string(unknown, ', ');
  end if;
  if p_id is not null then
    select * into cur from public.records where id = p_id and workspace_id = p_workspace for update;
  end if;
  if cur.id is not null then
    if cur.deleted_at is not null then
      raise exception 'deleted: % was deleted (rev %); restore it with `surface restore`', p_id, cur.rev;
    end if;
    if inverses <> '{}'::jsonb and p_base_rev is null then
      raise exception 'conflict: inverse edits require the current base revision for %', p_id;
    end if;
    if p_base_rev is not null and cur.rev <> p_base_rev then
      raise exception 'conflict: % changed since rev % (now rev %)', p_id, p_base_rev, cur.rev;
    end if;
    update public.records
       set type_id = t.id, title = p_title, fields = stored, body = coalesce(p_body, ''),
           folder = coalesce(p_folder, cur.folder),
           parent_id = case when p_parent is null then cur.parent_id else new_parent end,
           aliases = coalesce(p_aliases, cur.aliases)
     where id = p_id returning * into result;
    if result.id is null then select * into result from public.records where id = p_id; end if;
  else
    insert into public.records (id, workspace_id, type_id, title, fields, body, folder, parent_id, aliases)
      values (coalesce(p_id, public.surface_id()), p_workspace, t.id, p_title, stored,
              coalesce(p_body, ''), coalesce(p_folder, t.folder), new_parent, coalesce(p_aliases, '{}'))
      returning * into result;
  end if;

  for def in select d from jsonb_array_elements(t.fields) d where inverses ? (d->>'id') loop
    desired := surface_private.link_ids(inverses -> (def->>'id'));
    select d into source_def from public.types st, jsonb_array_elements(st.fields) d
     where st.id = def->>'target' and st.workspace_id = p_workspace and d->>'id' = def->>'inverse';
    if source_def is null or source_def ? 'inverse' or source_def->>'kind' <> 'link'
       or source_def->>'target' is distinct from t.id then
      raise exception 'invalid_field: inverse % no longer references a stored link back to this type', def->>'key';
    end if;
    for source in
      select * from public.records r where r.workspace_id = p_workspace and r.type_id = def->>'target' and r.deleted_at is null
       and (r.id = any(desired) or result.id = any(surface_private.link_ids(r.fields -> (def->>'inverse'))))
       order by r.id for update
    loop
      existing := surface_private.link_ids(source.fields -> (def->>'inverse'));
      if source.id = any(desired) then
        if result.id = any(existing) then continue; end if;
        if coalesce((source_def->>'multiple')::boolean, false) then replacement := existing || result.id;
        else replacement := array[result.id];
        end if;
      else
        replacement := array_remove(existing, result.id);
      end if;
      if cardinality(replacement) = 0 then
        update public.records set fields = fields - (def->>'inverse') where id = source.id;
      elsif coalesce((source_def->>'multiple')::boolean, false) then
        update public.records set fields = jsonb_set(fields, array[def->>'inverse'], to_jsonb(replacement)) where id = source.id;
      else
        update public.records set fields = jsonb_set(fields, array[def->>'inverse'], to_jsonb(replacement[1])) where id = source.id;
      end if;
    end loop;
  end loop;
  -- Source triggers may have advanced this target's revision several times.
  select * into result from public.records where id = result.id;
  return result;
end $$;

-- A cheap, authenticated capability probe; old hubs must fail closed rather than
-- accepting inverse metadata as an ordinary persisted link field.
create function public.surface_schema_version() returns integer
language sql immutable security invoker set search_path = public as $$ select 7 $$;
revoke all on function public.surface_schema_version() from public, anon;
grant execute on function public.surface_schema_version() to authenticated;
revoke all on function surface_private.types_validate() from public, anon, authenticated;
revoke all on function surface_private.types_inverse_delete() from public, anon, authenticated;
revoke all on function surface_private.records_validate() from public, anon, authenticated;
revoke all on function surface_private.records_inverse_touch() from public, anon, authenticated;
revoke all on function public.push_record(text,text,integer,text,text,jsonb,text,text,text,text[]) from public, anon;
grant execute on function public.push_record(text,text,integer,text,text,jsonb,text,text,text,text[]) to authenticated;
