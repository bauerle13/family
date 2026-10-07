// Fill these in during setup (see README). Everything here is safe to be public:
// the Supabase publishable key only works for logged-in household members,
// and the Teller application ID is meant to be used in the browser.
window.APP_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT-ID.supabase.co',
  supabaseKey: 'YOUR-SUPABASE-PUBLISHABLE-KEY',
  tellerAppId: 'app_YOUR_TELLER_APP_ID',
  tellerEnvironment: 'development',
  syncWorkflowUrl: 'https://github.com/YOUR-USERNAME/family-budget/actions/workflows/sync.yml',
};
