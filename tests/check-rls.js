const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '../../database/.env' });

const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const supabaseService = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkUsers() {
  console.log('Testing users query with Service Role Key...');
  const { data: sUsers, error: sErr } = await supabaseService.from('users').select('*');
  console.log(`Service Role: ${sUsers ? sUsers.length : 0} users`, sErr ? sErr.message : '');

  console.log('\nTesting users query with Anon Key...');
  const { data: aUsers, error: aErr } = await supabaseAnon.from('users').select('*');
  console.log(`Anon Key: ${aUsers ? aUsers.length : 0} users`, aErr ? aErr.message : '');
}

checkUsers();
