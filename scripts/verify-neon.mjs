import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

// Load backend .env directly
dotenv.config({ path: path.resolve(process.cwd(), 'apps/backend/.env') });

console.log('[Neon Verification] Testing Neon PostgreSQL Integration End-to-End...');
console.log('[Neon Verification] DATABASE_URL host:', process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL.replace('postgresql://', 'http://')).host : 'NONE');

const prisma = new PrismaClient();

async function run() {
  const startTime = Date.now();
  try {
    // 1. Connection and Version Query
    console.log('[1/4] Executing SELECT version()...');
    const versionResult = await prisma.$queryRaw`
      SELECT version(), current_database(), current_user;
    `;
    console.log('[1/4] Connected to database:', versionResult[0].current_database);
    console.log('[1/4] User:', versionResult[0].current_user);
    console.log('[1/4] PostgreSQL Version:', versionResult[0].version.split(' ')[0], versionResult[0].version.split(' ')[1]);

    // 2. Verify all migration tables exist
    console.log('[2/4] Verifying applied schema tables in public schema...');
    const tables = await prisma.$queryRaw`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
    `;
    const tableNames = tables.map(t => t.tablename);
    console.log('[2/4] Tables found (' + tableNames.length + '):', tableNames.join(', '));

    const requiredTables = [
      '_prisma_migrations',
      'users',
      'auth_sessions',
      'conversations',
      'messages',
      'pairing_codes',
      'rooms',
      'room_members',
      'conversation_requests',
      'attachments',
      'devices',
      'user_settings'
    ];

    const missing = requiredTables.filter(t => !tableNames.includes(t));
    if (missing.length > 0) {
      throw new Error('Missing expected tables: ' + missing.join(', '));
    }
    console.log('[2/4] All required application tables verified successfully!');

    // 3. Test Prisma ORM query & CRUD
    console.log('[3/4] Testing Prisma ORM query operation (User count)...');
    const userCount = await prisma.user.count();
    console.log('[3/4] Current user count in database:', userCount);

    // 4. Test Prisma Transaction Execution
    console.log('[4/4] Testing transaction execution through Neon connection pooler...');
    const txResult = await prisma.$transaction(async (tx) => {
      const ping = await tx.$queryRaw`SELECT 42 as ping;`;
      return ping[0].ping;
    });
    if (txResult !== 42) {
      throw new Error('Transaction test returned unexpected result: ' + txResult);
    }
    console.log('[4/4] Transaction test passed (ping result: ' + txResult + ')');

    const totalDuration = Date.now() - startTime;
    console.log('\n========================================');
    console.log('✅ NEON POSTGRESQL VERIFICATION SUCCESSFUL');
    console.log('Total roundtrip execution time: ' + totalDuration + 'ms');
    console.log('Database endpoint: ' + (process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL.replace('postgresql://', 'http://')).host : ''));
    console.log('PostgreSQL Version: ' + versionResult[0].version.split(' ')[0] + ' ' + versionResult[0].version.split(' ')[1]);
    console.log('========================================\n');
  } catch (err) {
    console.error('❌ Neon Verification Failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

run();
