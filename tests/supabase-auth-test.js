const assert = require('assert');
const auth = require('../js/supabase-auth.js');

async function runTests() {
  console.log('=== TESTING MAIN PORTAL SUPABASE AUTH MODULE (P0 CONTAINMENT) ===\n');

  console.log('[1/4] Testing Containment: Direct client login must fail closed outside the trusted Main boundary...');
  const loginRes = await auth.login('250001', 'password123');
  assert.strictEqual(loginRes.status, 'legacy_boundary_disabled', 'Direct client login must fail closed outside the trusted Main boundary');
  console.log('  -> Direct login blocked; trusted Main boundary remains the only auth path.');

  console.log('\n[2/4] Testing Containment: Direct client verifyToken must fail closed outside the trusted Main boundary...');
  const verifyRes = await auth.verifyToken('token');
  assert.strictEqual(verifyRes.status, 'legacy_boundary_disabled');
  console.log('  -> Direct verifyToken blocked; trusted Main boundary remains the only auth path.');

  console.log('\n[3/4] Testing Containment: Direct client getAdminData must fail closed outside the trusted Main boundary...');
  const adminData = await auth.getAdminData();
  assert.strictEqual(adminData.status, 'legacy_boundary_disabled');
  console.log('  -> Direct getAdminData blocked; trusted Main boundary remains the only auth path.');

  console.log('\n[4/4] Testing Containment: Direct client changePassword must fail closed outside the trusted Main boundary...');
  const pwdRes = await auth.changePassword();
  assert.strictEqual(pwdRes.status, 'legacy_boundary_disabled');
  console.log('  -> Direct changePassword blocked; trusted Main boundary remains the only auth path.');

  console.log('\n🌟 MAIN PORTAL SUPABASE AUTH CONTAINMENT TESTS PASSED 100%! 🌟');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
