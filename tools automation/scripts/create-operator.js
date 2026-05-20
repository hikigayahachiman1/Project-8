const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

async function main() {
  const [usernameArg, passwordArg, displayNameArg, roleArg] = process.argv.slice(2);
  const username = String(usernameArg || '').trim().toLowerCase();
  const password = String(passwordArg || '');
  const displayName = String(displayNameArg || '').trim();
  const role = String(roleArg || '').trim().toLowerCase();
  const validRoles = new Set(['operator', 'audit', 'admin']);

  if (!username || !password || !displayName || !validRoles.has(role)) {
    console.error('Usage: node scripts/create-operator.js username password "Display Name" role');
    console.error('Role harus salah satu: operator, audit, admin');
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib tersedia di environment.');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false }
  });

  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('operators')
    .upsert({
      username,
      display_name: displayName,
      password_hash: passwordHash,
      role,
      is_active: true,
      updated_at: now
    }, {
      onConflict: 'username'
    });

  if (error) {
    console.error('Gagal membuat operator:', error.message);
    process.exit(1);
  }

  console.log(`Operator created/updated: ${username} ${role}`);
}

main().catch(error => {
  console.error('Gagal membuat operator:', error.message);
  process.exit(1);
});
