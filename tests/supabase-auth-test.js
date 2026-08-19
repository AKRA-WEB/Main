const assert = require('assert');
const auth = require('../js/supabase-auth.js');

async function runTests() {
  console.log('=== TESTING MAIN PORTAL SUPABASE AUTH MODULE ===\n');

  console.log('[1/3] Testing Login for Admin user (250001) with password123...');
  const loginRes = await auth.login('250001', 'password123');
  assert.strictEqual(loginRes.status, 'success', 'Login for 250001 must succeed');
  assert(loginRes.token, 'Must return session token');
  assert.strictEqual(loginRes.user.name, 'ADMIN USER', 'User name must match database');
  assert(loginRes.user.roles.includes('ADMIN'), 'User must have ADMIN role');
  console.log(`  -> Login success! User: ${loginRes.user.name}, Roles: ${loginRes.user.roles.join(', ')}`);
  console.log(`  -> Generated JWT Token (preview): ${loginRes.token.substring(0, 40)}...`);

  console.log('\n[2/3] Testing Login with incorrect password...');
  const failRes = await auth.login('250001', 'wrongpassword');
  assert.strictEqual(failRes.status, 'error');
  assert.strictEqual(failRes.message, 'รหัสผ่านไม่ถูกต้อง');
  console.log('  -> Rejected incorrect password as expected.');

  console.log('\n[3/3] Testing getAdminData...');
  const adminData = await auth.getAdminData();
  assert.strictEqual(adminData.status, 'success');
  assert(adminData.users['250001'], 'Must include 250001 in users map');
  assert(adminData.appConfig.length >= 8, 'Must return app configs');
  console.log(`  -> Fetched ${Object.keys(adminData.users).length} users, ${adminData.appConfig.length} apps, ${adminData.roleConfig.length} roles.`);

  console.log('\n🌟 MAIN PORTAL SUPABASE AUTH MODULE TESTS PASSED 100%! 🌟');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
