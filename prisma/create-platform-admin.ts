import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

// Usage: PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_NAME=... PLATFORM_ADMIN_PASSWORD=... npm run platform:create-admin
const MIN_PASSWORD_LENGTH = 12;

async function main() {
  const email = process.env.PLATFORM_ADMIN_EMAIL?.toLowerCase();
  const name = process.env.PLATFORM_ADMIN_NAME ?? 'Platform admin';
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD (min ${MIN_PASSWORD_LENGTH} chars) are required`);
  }

  const prisma = new PrismaClient();
  try {
    const admin = await prisma.platformAdmin.upsert({
      where: { email },
      update: { name, password: await bcrypt.hash(password, 12), active: true },
      create: { email, name, password: await bcrypt.hash(password, 12) },
    });
    console.log(`Platform admin ready: ${admin.email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
