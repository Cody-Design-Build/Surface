-- Sidebars, full-page views, record display and sharing.
--
-- 1. views.owner: a view belongs to the workspace (owner null) or to one member (their user id).
--    Personal views (the personal sidebar, or a personal table) are visible only to their owner.
--    Key uniqueness is per (workspace, owner).
-- 2. types.display: how a record of this type opens: 'document' (body first) or 'fields'
--    (properties first, body folded when empty).
-- 3. Invites: share a workspace by email with a role. Accepting adds a membership row.
-- 4. Members can be listed (with emails) by anyone in the workspace; admins change roles.

-- 1. personal views ------------------------------------------------------------
alter table public.views add column owner uuid references auth.users(id) on delete cascade;
alter table public.views drop constraint views_workspace_id_key_key;
create unique index views_ws_key_shared on public.views (workspace_id, key) where owner is null;
create unique index views_ws_key_owner on public.views (workspace_id, owner, key) where owner is not null;

drop policy views_read on public.views;
drop policy views_write on public.views;
create policy views_read on public.views for select to authenticated
  using (public.ws_can_read(workspace_id) and (owner is null or owner = auth.uid()));
-- Shared views: members write them; the shared sidebar: admins only. Personal views: their owner, whatever their role.
create policy views_insert on public.views for insert to authenticated
  with check (
    (owner is null and public.ws_can_write(workspace_id) and (key <> 'sidebar' or public.ws_can_admin(workspace_id)))
    or (owner = auth.uid() and public.ws_can_read(workspace_id))
  );
create policy views_update on public.views for update to authenticated
  using (
    (owner is null and public.ws_can_write(workspace_id) and (key <> 'sidebar' or public.ws_can_admin(workspace_id)))
    or (owner = auth.uid() and public.ws_can_read(workspace_id))
  )
  with check (
    (owner is null and public.ws_can_write(workspace_id) and (key <> 'sidebar' or public.ws_can_admin(workspace_id)))
    or (owner = auth.uid() and public.ws_can_read(workspace_id))
  );
create policy views_delete on public.views for delete to authenticated
  using (
    (owner is null and public.ws_can_write(workspace_id) and (key <> 'sidebar' or public.ws_can_admin(workspace_id)))
    or (owner = auth.uid() and public.ws_can_read(workspace_id))
  );

drop function public.save_view(text, text, text, jsonb, integer);
create or replace function public.save_view(
  p_workspace text, p_key text, p_name text, p_definition jsonb, p_base_rev integer default null, p_personal boolean default false
) returns public.views
language plpgsql security invoker set search_path = public as $$
declare
  cur public.views%rowtype;
  result public.views;
  who uuid := case when p_personal then auth.uid() else null end;
begin
  if p_personal and who is null then raise exception 'not signed in'; end if;
  select * into cur from public.views
   where workspace_id = p_workspace and key = p_key and owner is not distinct from who
   for update;
  if cur.id is null then
    insert into public.views (workspace_id, key, name, definition, owner)
      values (p_workspace, p_key, coalesce(p_name, p_key), p_definition, who)
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
revoke all on function public.save_view(text,text,text,jsonb,integer,boolean) from public, anon;
grant execute on function public.save_view(text,text,text,jsonb,integer,boolean) to authenticated;

-- 2. type display ----------------------------------------------------------------
alter table public.types add column display text not null default 'document'
  check (display in ('document', 'fields'));

-- 3. invites ---------------------------------------------------------------------
create table public.invites (
  id           text primary key default public.surface_id(),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  email        text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role         text not null default 'member' check (role in ('admin','member','viewer')),
  invited_by   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (workspace_id, email)
);
alter table public.invites enable row level security;
-- admins see and manage their workspace's invites; the invitee sees invites to their own email
create policy invites_admin on public.invites for all to authenticated
  using (public.ws_can_admin(workspace_id)) with check (public.ws_can_admin(workspace_id));
create policy invites_mine on public.invites for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

create or replace function surface_private.accept_invite_impl(p_invite text) returns public.members
language plpgsql security definer set search_path = public, surface_private as $$
declare
  inv public.invites%rowtype;
  m public.members%rowtype;
  me text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  select * into inv from public.invites where id = p_invite;
  if inv.id is null then raise exception 'invalid: no such invite'; end if;
  if lower(inv.email) <> me then raise exception 'invalid: this invite is for %', inv.email; end if;
  insert into public.members (workspace_id, user_id, role) values (inv.workspace_id, auth.uid(), inv.role)
    on conflict (workspace_id, user_id) do update set role = excluded.role
    returning * into m;
  delete from public.invites where id = inv.id;
  return m;
end $$;
revoke all on function surface_private.accept_invite_impl(text) from public, anon;
grant execute on function surface_private.accept_invite_impl(text) to authenticated;
create or replace function public.accept_invite(p_invite text) returns public.members
language sql volatile security invoker set search_path = public, surface_private as $$
  select * from surface_private.accept_invite_impl(p_invite)
$$;
revoke all on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated;

-- 4. members list with emails (auth.users isn't exposed to the API) ------------------
create or replace function surface_private.workspace_members_impl(p_workspace text)
returns table (user_id uuid, email text, role text, created_at timestamptz)
language sql stable security definer set search_path = public, surface_private as $$
  select m.user_id, u.email::text, m.role, m.created_at
    from public.members m join auth.users u on u.id = m.user_id
   where m.workspace_id = p_workspace and public.ws_can_read(p_workspace)
   order by m.created_at
$$;
revoke all on function surface_private.workspace_members_impl(text) from public, anon;
grant execute on function surface_private.workspace_members_impl(text) to authenticated;
create or replace function public.workspace_members(p_workspace text)
returns table (user_id uuid, email text, role text, created_at timestamptz)
language sql stable security invoker set search_path = public, surface_private as $$
  select * from surface_private.workspace_members_impl(p_workspace)
$$;
revoke all on function public.workspace_members(text) from public, anon;
grant execute on function public.workspace_members(text) to authenticated;
