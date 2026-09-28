-- Dashboard "Sender health" tiles show the sender's profile photo: add picture_url to each sender in outreach_dashboard().
-- Patches the live definition in place so nothing else in the function changes.
do $$
declare def text := pg_get_functiondef('public.outreach_dashboard(uuid)'::regprocedure);
begin
  if position('''picture_url''' in def) > 0 then return; end if;
  def := replace(def, $q$'display_name', s.display_name, 'provider', s.provider, 'status', s.status, 'status_reason'$q$,
                      $q$'display_name', s.display_name, 'picture_url', s.picture_url, 'provider', s.provider, 'status', s.status, 'status_reason'$q$);
  if position('''picture_url''' in def) = 0 then raise exception 'outreach_dashboard: sender object not found, patch not applied'; end if;
  execute def;
end $$;
