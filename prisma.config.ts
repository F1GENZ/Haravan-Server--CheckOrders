import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma CLI (migrate, db execute) must use a session/direct connection;
// the runtime pooler URL is only a fallback for single-instance setups.
const url = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: url ?? '' },
});
