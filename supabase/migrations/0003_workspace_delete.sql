-- Deleting a workspace must remove its built-in type and all records.
-- 1. The built-in-type guard allows the delete when the workspace itself is gone (cascade).
-- 2. records.type_id uses NO ACTION (checked at the end of the statement) instead of RESTRICT,
--    so a cascading workspace delete can remove types and records in either order.

create or replace function surface_private.types_protect_builtin() returns trigger
language plpgsql set search_path = public, surface_private as $$
begin
  if old.is_builtin and exists (select 1 from public.workspaces where id = old.workspace_id) then
    raise exception 'invalid_type: "%" is built in and cannot be removed', old.key;
  end if;
  return old;
end $$;
revoke all on function surface_private.types_protect_builtin() from public, anon, authenticated;

alter table public.records drop constraint records_type_id_fkey;
alter table public.records add constraint records_type_id_fkey
  foreign key (type_id) references public.types(id) on delete no action;
