-- Phone is a database-enforced type: E.164 numbers with separate labels/extensions.
-- Existing values are not rewritten here: the record trigger checks changed values,
-- so unrelated edits remain possible while legacy values are reviewed and normalized.
create or replace function surface_private.validate_value(ws text, def jsonb, val jsonb) returns text
language plpgsql stable security definer set search_path = public, surface_private as $$
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
    when 'text', 'url', 'email' then
      if jsonb_typeof(val) <> 'string' then return 'must be text'; end if;
      if kind = 'email' and val #>> '{}' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return 'must be an email address'; end if;
      if kind = 'url' and val #>> '{}' !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://' then return 'must be a URL (https://…)'; end if;
    when 'phone' then
      if jsonb_typeof(val) <> 'array' then
        return 'must be canonical phone entries: [{"number":"+14155550123"}]; use Surface to normalize formatted input';
      end if;
      if jsonb_array_length(val) not between 1 and 20 then return 'needs 1–20 phone entries (use null to clear)'; end if;
      for item in select * from jsonb_array_elements(val) loop
        if jsonb_typeof(item) <> 'object' then return 'each phone entry must be an object'; end if;
        if exists (select 1 from jsonb_object_keys(item) k where k not in ('number', 'label', 'extension')) then
          return 'phone entries accept only number, label and extension';
        end if;
        if jsonb_typeof(item->'number') is distinct from 'string'
           or item->>'number' !~ '^\+[1-9][0-9]{6,14}$' then
          return 'phone numbers must use E.164: +, country code and digits only (7–15 digits)';
        end if;
        if left(item->>'number', 2) = '+1' and item->>'number' !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' then
          return 'US/Canadian phone numbers need a valid 3-digit area code and 7-digit number';
        end if;
        if item ? 'label' and (jsonb_typeof(item->'label') is distinct from 'string'
           or item->>'label' !~ '^[a-z][a-z0-9 _-]{0,39}$'
           or item->>'label' <> trim(item->>'label')) then
          return 'phone labels must be lowercase, start with a letter, and use at most 40 letters, digits, spaces, - or _';
        end if;
        if item ? 'extension' and (jsonb_typeof(item->'extension') is distinct from 'string'
           or item->>'extension' !~ '^[0-9]{1,10}$') then
          return 'phone extensions must be 1–10 digits, stored separately as text';
        end if;
      end loop;
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

revoke all on function surface_private.validate_value(text,jsonb,jsonb) from public, anon, authenticated;

create or replace function public.surface_schema_version() returns integer
language sql immutable security invoker set search_path = public as $$ select 9 $$;
revoke all on function public.surface_schema_version() from public, anon;
grant execute on function public.surface_schema_version() to authenticated;
