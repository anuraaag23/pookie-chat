// THE FIX (found during the real-environment boot audit): nothing in this
// codebase ever loaded a .env file into process.env before this. Every
// config value this app needs (config/env.ts's requireEnv/requireStrongSecret)
// reads directly from process.env with no fallback and throws if missing —
// by design, for security-critical secrets — but with no loader, that meant
// the app would throw "Missing required environment variable: DATABASE_URL"
// on every single real boot, even with a perfectly correct .env file sitting
// right next to it, because nothing ever read that file. @nestjs/config is a
// listed dependency but is never actually imported anywhere in this codebase
// (this project uses its own APP_CONFIG/env.ts instead — see config.module.ts),
// so it provided no protection here despite being present in package.json.
//
// Must be the first import, before 'reflect-metadata' and before AppModule:
// ES module imports are hoisted, but hoisting preserves declaration order
// among the imports themselves, so this side effect (populating process.env)
// runs before AppModule — and everything it transitively imports — is
// evaluated. config.module.ts's loadConfig() is only invoked later, lazily,
// via Nest's DI (a useFactory, resolved during NestFactory.create below), so
// this ordering is actually sufficient — it doesn't need to run before the
// import statement even earlier, just before bootstrap() executes.
//
// No explicit path: default dotenv behavior reads .env from process.cwd().
// This app is always started with apps/backend/ as the working directory —
// `nest start`/`node dist/main.js` run directly from within apps/backend/,
// and even `npm run dev:backend --workspace=apps/backend` from the repo
// root still sets the *script's* cwd to apps/backend/ (that's what
// --workspace does) — so the expected file is apps/backend/.env, matching
// where README.md's quickstart now says to put it and where Prisma's own
// CLI also looks (see apps/backend/.env.example's own header comment for
// the full reasoning on why this isn't the repo root).
import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());

  // Locked to the one known web origin — this backend has no public,
  // browsable API surface by design.
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  app.enableCors({
    origin: webOrigin,
    credentials: true,
  });

  // Strips and rejects any request field not explicitly declared on a DTO —
  // the first line of defense against a client sending more than we asked
  // for (see docs/01-THREAT-MODEL.md, "malicious client").
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Pookie Chat backend listening on :${port}`);
}

bootstrap();
