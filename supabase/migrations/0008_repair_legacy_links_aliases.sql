-- Repair databases that installed 0007 over 0001–0005 without first applying 0006.
-- Do not replay 0006: its validator and push_record would remove inverse support.
do $$
begin
  if to_regprocedure('public.surface_schema_version()') is null
     or to_regprocedure('surface_private.records_inverse_touch()') is null
     or to_regprocedure('public.push_record(text,text,integer,text,text,jsonb,text,text,text,text[])') is null then
    raise exception '0008 requires 0007_inverse_relationships.sql; apply 0007 first';
  end if;
  if public.surface_schema_version() < 7 then
    raise exception '0008 requires inverse relationship capability 7';
  end if;
end $$;

alter table public.records add column if not exists aliases text[] not null default '{}';
alter table public.history add column if not exists aliases text[];

-- Restore the 0006 history/body-link trigger without replacing the 0007 validator.
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
    for target in select distinct m[1] from regexp_matches(new.body, '\[\[id:([0-9a-z]+)', 'g') m loop
      insert into public.links (workspace_id, source_id, field_id, target_id)
        select new.workspace_id, new.id, 'body', r.id from public.records r
         where r.id = target and r.workspace_id = new.workspace_id and r.id <> new.id
        on conflict do nothing;
    end loop;
  end if;
  return null;
end $$;
revoke all on function surface_private.records_after() from public, anon, authenticated;

drop function if exists public.push_record(text,text,integer,text,text,jsonb,text,text,text);
create or replace function public.surface_schema_version() returns integer
language sql immutable security invoker set search_path = public as $$ select 8 $$;
revoke all on function public.surface_schema_version() from public, anon;
grant execute on function public.surface_schema_version() to authenticated;
