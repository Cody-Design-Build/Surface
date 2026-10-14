-- Security hardening (Supabase advisor clean-up):
-- internal SECURITY DEFINER functions move to a private schema that the API doesn't expose,
-- and every function gets a fixed search_path.

create schema if not exists surface_private;
revoke all on schema surface_private from public, anon;
grant usage on schema surface_private to authenticated;

-- Membership lookup used by row-level security policies
alter function public.ws_role(text) set schema surface_private;
revoke all on function surface_private.ws_role(text) from public, anon;
grant execute on function surface_private.ws_role(text) to authenticated;

create or replace function public.ws_can_read(ws text) returns boolean
language sql stable set search_path = public, surface_private as $$ select surface_private.ws_role(ws) is not null $$;
create or replace function public.ws_can_write(ws text) returns boolean
language sql stable set search_path = public, surface_private as $$ select surface_private.ws_role(ws) in ('owner','admin','member') $$;
create or replace function public.ws_can_admin(ws text) returns boolean
language sql stable set search_path = public, surface_private as $$ select surface_private.ws_role(ws) in ('owner','admin') $$;

-- Policies that called ws_role directly
drop policy ws_update on public.workspaces;
drop policy ws_delete on public.workspaces;
create policy ws_update on public.workspaces for update to authenticated using (surface_private.ws_role(id) = 'owner');
create policy ws_delete on public.workspaces for delete to authenticated using (surface_private.ws_role(id) = 'owner');

-- Trigger and validation functions: not callable through the API at all
alter function public.validate_value(text, jsonb, jsonb) set schema surface_private;
alter function public.types_validate() set schema surface_private;
alter function public.records_validate() set schema surface_private;
alter function public.records_after() set schema surface_private;
alter function public.types_protect_builtin() set schema surface_private;
revoke all on function surface_private.validate_value(text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function surface_private.types_validate() from public, anon, authenticated;
revoke all on function surface_private.records_validate() from public, anon, authenticated;
revoke all on function surface_private.records_after() from public, anon, authenticated;
revoke all on function surface_private.types_protect_builtin() from public, anon, authenticated;

alter function surface_private.validate_value(text, jsonb, jsonb) set search_path = public, surface_private;
alter function surface_private.types_validate() set search_path = public, surface_private;
alter function surface_private.records_validate() set search_path = public, surface_private;
alter function surface_private.records_after() set search_path = public, surface_private;
alter function surface_private.types_protect_builtin() set search_path = public, surface_private;
alter function public.surface_id() set search_path = public;
alter function public.surface_field_id() set search_path = public;

-- create_workspace: the definer part is private; the API sees an invoker wrapper
alter function public.create_workspace(text) rename to create_workspace_impl;
alter function public.create_workspace_impl(text) set schema surface_private;
revoke all on function surface_private.create_workspace_impl(text) from public, anon;
grant execute on function surface_private.create_workspace_impl(text) to authenticated;
alter function surface_private.create_workspace_impl(text) set search_path = public, surface_private;

create or replace function public.create_workspace(p_name text) returns public.workspaces
language sql volatile security invoker set search_path = public, surface_private as $$
  select * from surface_private.create_workspace_impl(p_name)
$$;
revoke all on function public.create_workspace(text) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;

revoke all on function public.push_record(text,text,integer,text,text,jsonb,text,text) from public, anon;
grant execute on function public.push_record(text,text,integer,text,text,jsonb,text,text) to authenticated;
