const assert = require('assert');
const auth = require('../js/supabase-auth.js');

async function runTests() {
  console.log('=== TESTING MAIN PORTAL SUPABASE AUTH MODULE (P0 CONTAINMENT) ===\n');

  console.log('[1/4] Testing Containment: Direct client login must fall back to secure backend...');
  const loginRes = await auth.login('250001', 'password123');
  assert.strictEqual(loginRes.status, 'fallback_to_gas', 'Direct client login must return fallback_to_gas');
  console.log('  -> Direct login blocked, falling back to secure GAS backend as required.');

  console.log('\n[2/4] Testing Containment: Direct client verifyToken must fall back to secure backend...');
  const verifyRes = await auth.verifyToken('token');
  assert.strictEqual(verifyRes.status, 'fallback_to_gas');
  console.log('  -> Direct verifyToken blocked, falling back to secure GAS backend as required.');

  console.log('\n[3/4] Testing Containment: Direct client getAdminData must fall back to secure backend...');
  const adminData = await auth.getAdminData();
  assert.strictEqual(adminData.status, 'fallback_to_gas');
  console.log('  -> Direct getAdminData blocked, falling back to secure GAS backend as required.');

  console.log('\n[4/4] Testing Containment: Direct client changePassword must fall back to secure backend...');
  const pwdRes = await auth.changePassword();
  assert.strictEqual(pwdRes.status, 'fallback_to_gas');
  console.log('  -> Direct changePassword blocked, falling back to secure GAS backend as required.');

  console.log('\n🌟 MAIN PORTAL SUPABASE AUTH CONTAINMENT TESTS PASSED 100%! 🌟');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
