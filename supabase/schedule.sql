-- Automatic bank sync every 3 hours.
-- Run this AFTER the "plaid" Edge Function is deployed (README Part 4).
-- Replace the two placeholder values first.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://YOUR-PROJECT-ID.supabase.co', 'project_url');
select vault.create_secret('PASTE-THE-SAME-CRON_SECRET-YOU-SET-ON-THE-FUNCTION', 'cron_secret');

select cron.schedule(
  'plaid-sync',
  '17 */3 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/plaid',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{"action":"sync"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
